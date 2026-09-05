// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's overlay sampling and layer composition.
 *
 * The load-bearing one is the agreement with `datasetProbe`: this
 * module mirrors GLSL that has shipped a mirrored-hemisphere bug twice
 * (a US bbox over the South Pacific, and an inverted V), and
 * `datasetProbe.latLonToTexelUv` is the canonical TS mirror of that
 * same shader. Asserting they agree is what makes the duplicate safe.
 */

import { describe, it, expect } from 'vitest'
import { latLonToTexelUv } from '../services/datasetProbe'
import type { DatasetOverlayOptions } from '../types'
import {
  MAX_OUTPUT_LAYERS,
  overlaySampleUv,
  overlayUniformNames,
  buildOutputFragmentShader,
  OVERLAY_SAMPLE_GLSL,
} from './layerStack'

const CONUS: DatasetOverlayOptions = { boundingBox: { n: 50, s: 24, w: -125, e: -66 } }
const DATELINE: DatasetOverlayOptions = { boundingBox: { n: 60, s: -60, w: 150, e: -150 } }

describe('agreement with datasetProbe', () => {
  // datasetProbe uses IMAGE-space V (v = 0 is the top row); this module
  // uses SHADER space (v = 1 is the top row, because THREE uploads with
  // flipY). So the two agree on U exactly and on V after one flip.
  const cases: Array<[string, DatasetOverlayOptions | undefined, number, number]> = [
    ['global, no options', undefined, 0, 0],
    ['global, mid-latitude', undefined, 37.7, -122.4],
    ['global, antimeridian', undefined, 0, 179.9],
    ['global, poles', undefined, 89.9, 45],
    ['lonOrigin 180', { lonOrigin: 180 }, 12, -30],
    ['lonOrigin with flip', { lonOrigin: 90, isFlippedInY: true }, -45, 100],
    ['CONUS bbox', CONUS, 39, -100],
    ['CONUS bbox corner', CONUS, 50, -125],
    ['CONUS bbox flipped', { ...CONUS, isFlippedInY: true }, 30, -80],
    ['dateline-crossing bbox, east side', DATELINE, 10, 170],
    ['dateline-crossing bbox, west side', DATELINE, -10, -170],
  ]

  for (const [name, overlay, lat, lon] of cases) {
    it(`matches on ${name}`, () => {
      const mine = overlaySampleUv(lat, lon, overlay)
      const theirs = latLonToTexelUv(lat, lon, overlay)
      expect(mine).not.toBeNull()
      expect(theirs).not.toBeNull()
      expect(mine!.u).toBeCloseTo(theirs!.u, 10)
      // The one documented difference, and only this one.
      expect(mine!.v).toBeCloseTo(1 - theirs!.v, 10)
    })
  }

  it('rejects the same out-of-bbox points datasetProbe rejects', () => {
    // Outside CONUS in latitude, in longitude, and in both.
    for (const [lat, lon] of [[10, -100], [39, 20], [-40, 100]]) {
      expect(overlaySampleUv(lat, lon, CONUS)).toBeNull()
      expect(latLonToTexelUv(lat, lon, CONUS)).toBeNull()
    }
  })

  it('treats a whole-globe bbox as no bbox, as datasetProbe does', () => {
    // Clipping to a box that clips nothing costs a branch and loses the
    // lonOrigin shift.
    const global: DatasetOverlayOptions = {
      boundingBox: { n: 90, s: -90, w: -180, e: 180 },
      lonOrigin: 180,
    }
    const mine = overlaySampleUv(0, 0, global)
    const theirs = latLonToTexelUv(0, 0, global)
    expect(mine!.u).toBeCloseTo(theirs!.u, 10)
    expect(mine!.u).toBeCloseTo(0, 10) // the lonOrigin shift survived
  })
})

describe('shader-space V orientation', () => {
  it('puts north at v = 1, the opposite of image space', () => {
    // The sign that has shipped wrong twice. If this flips, every
    // dataset renders mirrored across the equator while still looking
    // like a plausible globe.
    expect(overlaySampleUv(90, 0)!.v).toBeCloseTo(1, 10)
    expect(overlaySampleUv(-90, 0)!.v).toBeCloseTo(0, 10)
  })

  it('puts a bbox north edge at v = 1', () => {
    expect(overlaySampleUv(50, -100, CONUS)!.v).toBeCloseTo(1, 10)
    expect(overlaySampleUv(24, -100, CONUS)!.v).toBeCloseTo(0, 10)
  })

  it('inverts both when isFlippedInY is set', () => {
    expect(overlaySampleUv(90, 0, { isFlippedInY: true })!.v).toBeCloseTo(0, 10)
    expect(overlaySampleUv(50, -100, { ...CONUS, isFlippedInY: true })!.v).toBeCloseTo(0, 10)
  })
})

describe('buildOutputFragmentShader', () => {
  it('returns the bare equirect pass for zero layers', () => {
    const src = buildOutputFragmentShader(0)
    expect(src).not.toContain('sampleOverlayLayer')
    expect(src).toContain('gl_FragColor = texture2D(uSphereTexture, sphereUv);')
  })

  it('declares the helper before main(), as GLSL ES 1.00 requires', () => {
    // There are no forward declarations in GLSL ES 1.00. Getting this
    // backwards type-checks fine and fails only on a GPU — which is
    // nowhere this repo's tests run, so it is asserted here instead.
    const src = buildOutputFragmentShader(2)
    const helper = src.indexOf('vec4 sampleOverlayLayer(')
    const main = src.indexOf('void main() {')
    expect(helper).toBeGreaterThan(-1)
    expect(main).toBeGreaterThan(-1)
    expect(helper).toBeLessThan(main)
  })

  it('declares every uniform each slot composites with', () => {
    const src = buildOutputFragmentShader(3)
    for (let slot = 0; slot < 3; slot++) {
      for (const name of Object.values(overlayUniformNames(slot))) {
        expect(src).toContain(`${name}`)
      }
    }
  })

  it('does not declare slots it was not asked for', () => {
    const src = buildOutputFragmentShader(1)
    expect(src).toContain(overlayUniformNames(0).map)
    expect(src).not.toContain(overlayUniformNames(1).map)
  })

  it('caps at MAX_OUTPUT_LAYERS rather than exhausting texture units', () => {
    // WebGL guarantees only 8 fragment texture units, and each layer
    // wants two (map + palette LUT).
    const src = buildOutputFragmentShader(99)
    expect(src).toContain(overlayUniformNames(MAX_OUTPUT_LAYERS - 1).map)
    expect(src).not.toContain(overlayUniformNames(MAX_OUTPUT_LAYERS).map)
  })

  it('composites in array order, so array order is z-order', () => {
    const src = buildOutputFragmentShader(3)
    const positions = [0, 1, 2].map(s => src.indexOf(`sampleOverlayLayer(${overlayUniformNames(s).map}`))
    expect(positions[0]).toBeLessThan(positions[1])
    expect(positions[1]).toBeLessThan(positions[2])
  })

  it('keeps the ray-march equirectRtt tests cover byte-identical', () => {
    // The composition only replaces the shader's final write. If it
    // started rewriting the projection, equirectRtt's own tests would
    // no longer be testing what ships.
    const src = buildOutputFragmentShader(2)
    expect(src).toContain('float t = -b + sqrt(b * b - c);')
    expect(src).toContain('vec3 hit = uCameraOffset + t * dir;')
  })

  it('throws loudly if the equirect tail it splices onto changes', () => {
    // A silent no-op replace would ship a shader that renders the base
    // texture and ignores every layer.
    expect(OVERLAY_SAMPLE_GLSL).toContain('vec4 sampleOverlayLayer(')
    expect(() => buildOutputFragmentShader(1)).not.toThrow()
  })
})

describe('data-encoded handling', () => {
  it('looks values up in the palette LUT rather than colouring directly', () => {
    expect(OVERLAY_SAMPLE_GLSL).toContain('texture2D(lut, vec2(texel.r, 0.5))')
  })

  it('applies no contrast or saturation to a measurement', () => {
    // Those knobs exist to make the Earth read well; on a data-encoded
    // layer they would silently rewrite every reported value, so the
    // sphere would disagree with the control window's readout.
    expect(OVERLAY_SAMPLE_GLSL).not.toContain('uContrast')
    expect(OVERLAY_SAMPLE_GLSL).not.toContain('uSaturation')
  })

  it('returns zero alpha outside a bbox so the layer contributes nothing', () => {
    expect(OVERLAY_SAMPLE_GLSL).toContain('return vec4(0.0);')
  })
})
