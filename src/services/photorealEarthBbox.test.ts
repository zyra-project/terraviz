// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Regional-dataset placement on the THREE-based globe.
 *
 * `photorealEarth`'s overlay shader clips a regional dataset to its
 * `boundingBox`. The maths was copied from the 2D globe
 * (`earthTileLayer.ts`), but the two run on spheres with OPPOSITE
 * texture-coordinate conventions:
 *
 *   earthTileLayer  builds its own sphere: `v = y / hSegs` with
 *                   `lat = pi/2 - v*pi`, so v == 0 at the north pole.
 *   THREE           SphereGeometry puts uv.y == 1 at the north pole.
 *
 * Copying `lat = (0.5 - v) * 180` across inverted latitude, so a
 * regional dataset rendered into the mirrored hemisphere — the RRFS
 * smoke box (21..53N) appeared over the South Pacific in generated
 * thumbnails.
 *
 * These tests pin the convention rather than the pixels: the sphere's
 * actual UVs come from THREE, and the shader's own source is parsed
 * for the two expressions that depend on them. A GL render would be
 * stronger, but needs a browser; the fix was verified that way in a
 * WebGL2 context before landing (probing lat +37 / -37 / +52 / +22
 * against a two-row texture), and this guards the reasoning behind it.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'

const srcFile = (name: string) => resolve(process.cwd(), 'src/services', name)

/** Source with `//` comments stripped.
 *
 * The assertions below look for GLSL assignments, and this file's own
 * fix adds a comment *describing* the old expression — so matching raw
 * source would let a future comment quoting either form flip a result
 * without any code changing. */
const codeOf = (name: string) =>
  readFileSync(srcFile(name), 'utf-8').replace(/\/\/[^\n]*/g, '')

const SHADER_SRC = codeOf('photorealEarth.ts')

/** Anchored to the assignment, tolerant of spacing. */
const latAssign = (expr: string) =>
  new RegExp(`float\\s+lat\\s*=\\s*${expr}\\s*;`)
const LAT_THREE = latAssign(String.raw`\(\s*vMapUv\.y\s*-\s*0\.5\s*\)\s*\*\s*180\.0`)
const LAT_INVERTED = latAssign(String.raw`\(\s*0\.5\s*-\s*vMapUv\.y\s*\)\s*\*\s*180\.0`)
const BV_CORRECT = /float\s+bv\s*=\s*\(\s*lat\s*-\s*bs\s*\)\s*\/\s*max\(/
const BV_INVERTED = /float\s+bv\s*=\s*\(\s*bn\s*-\s*lat\s*\)\s*\/\s*max\(/

describe('THREE sphere UV convention', () => {
  it('puts uv.y == 1 at the north pole, unlike the 2D globe', () => {
    const geo = new THREE.SphereGeometry(1, 8, 6)
    const pos = geo.attributes.position
    const uv = geo.attributes.uv

    // Pick the extreme vertices rather than threshold-and-first-hit,
    // so a change in tessellation or a hair of float drift cannot
    // change which vertex is examined.
    let north = 0
    let south = 0
    for (let i = 1; i < pos.count; i++) {
      if (pos.getY(i) > pos.getY(north)) north = i
      if (pos.getY(i) < pos.getY(south)) south = i
    }

    // Loose comparison on purpose: what is under test is the
    // convention (1 at the north, 0 at the south), not the exact
    // float a given Three.js release happens to emit.
    expect(uv.getY(north)).toBeCloseTo(1, 5)
    expect(uv.getY(south)).toBeCloseTo(0, 5)
  })

  it('derives latitude with the sign that convention requires', () => {
    const geo = new THREE.SphereGeometry(1, 8, 6)
    const pos = geo.attributes.position
    const uv = geo.attributes.uv

    // The expression the shader uses, applied to real sphere UVs.
    const latFromUv = (v: number) => (v - 0.5) * 180

    for (let i = 0; i < pos.count; i++) {
      const expected = (Math.asin(Math.max(-1, Math.min(1, pos.getY(i)))) * 180) / Math.PI
      expect(latFromUv(uv.getY(i))).toBeCloseTo(expected, 4)
    }
  })
})

describe('photorealEarth bbox shader', () => {
  it('derives lat as (vMapUv.y - 0.5), not the 2D globe’s inverse', () => {
    expect(SHADER_SRC).toMatch(LAT_THREE)
    expect(SHADER_SRC).not.toMatch(LAT_INVERTED)
  })

  it('maps the box’s north edge to the image’s top row', () => {
    // THREE uploads with flipY, so v == 1 is the image's TOP row.
    // bv must therefore be 1 at lat == bn.
    expect(SHADER_SRC).toMatch(BV_CORRECT)
    expect(SHADER_SRC).not.toMatch(BV_INVERTED)

    const bv = (lat: number, bn: number, bs: number) => (lat - bs) / (bn - bs)
    expect(bv(53, 53, 21)).toBe(1) // north edge -> top row
    expect(bv(21, 53, 21)).toBe(0) // south edge -> bottom row
  })

  it('leaves the 2D globe’s own derivation alone', () => {
    // earthTileLayer builds a sphere with v == 0 at the north pole, so
    // its inverse form is correct there. Changing one must not be
    // taken as licence to "fix" the other.
    const twoD = codeOf('earthTileLayer.ts')
    expect(twoD).toMatch(
      /float\s+lat\s*=\s*\(\s*0\.5\s*-\s*vUV\.y\s*\)\s*\*\s*180\.0\s*;/,
    )
  })
})

describe('data-encoded palette is confined to the dataset texture', () => {
  // The base map and the dataset share one material here, unlike the 2D
  // globe where the dataset is a separate program that discards outside
  // the box. So `sampledDiffuseColor` holds the BASE MAP outside a
  // regional bbox, and feeding its red channel to the value palette
  // paints the Earth with the colour ramp: white terrain (Greenland,
  // ice, bright desert) reads as r ~= 1.0 and lands on the top of the
  // scale — the hottest colour, over land that carries no data at all.
  //
  // Shipped in the data-encoded video work and caught on the first
  // regional dataset viewed through the publisher's globe-thumbnail
  // generator.

  it('gates the palette lookup on having sampled the dataset', () => {
    // The flag must exist and start true, so the full-globe path (which
    // never touches it) still colours.
    expect(SHADER_SRC).toMatch(/bool\s+sampledDataset\s*=\s*true\s*;/)
    // ...and be cleared exactly where the base map is substituted.
    expect(SHADER_SRC).toMatch(
      /sampledDiffuseColor\s*=\s*texture2D\(\s*uOverlayBaseMap\s*,\s*vMapUv\s*\)\s*;\s*sampledDataset\s*=\s*false\s*;/,
    )
    // The palette branch must require it. Without the conjunct the
    // base map's red channel is treated as a measurement.
    expect(SHADER_SRC).toMatch(
      /if\s*\(\s*uOverlayDataEncoded\s*==\s*1\s*&&\s*sampledDataset\s*\)/,
    )
    expect(SHADER_SRC).not.toMatch(/if\s*\(\s*uOverlayDataEncoded\s*==\s*1\s*\)/)
  })

  it('still reads the palette from the dataset sample, not the base map', () => {
    // The lookup itself is unchanged: .r of the dataset texel indexes
    // the 256x1 LUT. This pins the thing the gate protects.
    expect(SHADER_SRC).toMatch(
      /texture2D\(\s*uOverlayColorLut\s*,\s*vec2\(\s*sampledDiffuseColor\.r\s*,\s*0\.5\s*\)\s*\)/,
    )
  })

  it('leaves the 2D globe alone — it never had this bug', () => {
    // earthTileLayer runs the dataset as its own program and discards
    // outside the box, so the base map can never reach the LUT there.
    // No gate is needed and none should be added.
    const twoD = codeOf('earthTileLayer.ts')
    expect(twoD).toMatch(/if\s*\(\s*uDataEncoded\s*\)/)
    expect(twoD).not.toMatch(/sampledDataset/)
  })
})
