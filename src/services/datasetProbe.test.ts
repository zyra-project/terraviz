// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the data-encoded hover probe.
 *
 * The UV mapping carries the bug that has already shipped twice in
 * this codebase — an inverted V, which mirrors the data across the
 * equator and still looks like a plausible globe. So these check the
 * poles and the hemispheres explicitly rather than only round-tripping
 * a midpoint, which an inverted mapping would pass.
 */
import { describe, expect, it } from 'vitest'
import {
  formatProbeReading,
  latLonToTexelUv,
  lonSpanDegrees,
  sphereUvToLatLon,
  texelUvToLatLon,
  probeDatasetValue,
  uvToTexel,
  type LumaSampler,
  type TexelUv,
  type ProbeSource,
} from './datasetProbe'
import type { ColorScale, DatasetOverlayOptions } from '../types'

const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 255, 255, 255] },
  ],
  vmin: 0,
  vmax: 100,
  units: 'mg m-2',
  transparentRange: 12 / 256,
}

describe('latLonToTexelUv — full globe', () => {
  it('puts the north pole at the top of the image, not the bottom', () => {
    // v == 0 is the image's TOP row. An inverted mapping is the
    // failure this test exists for.
    expect(latLonToTexelUv(90, 0)?.v).toBeCloseTo(0, 6)
    expect(latLonToTexelUv(-90, 0)?.v).toBeCloseTo(1, 6)
    expect(latLonToTexelUv(0, 0)?.v).toBeCloseTo(0.5, 6)
  })

  it('maps the northern hemisphere above the equator', () => {
    const north = latLonToTexelUv(45, 0)
    const south = latLonToTexelUv(-45, 0)
    expect(north?.v).toBeLessThan(0.5)
    expect(south?.v).toBeGreaterThan(0.5)
  })

  it('centres longitude 0 at u = 0.5 and wraps at the dateline', () => {
    expect(latLonToTexelUv(0, 0)?.u).toBeCloseTo(0.5, 6)
    expect(latLonToTexelUv(0, -180)?.u).toBeCloseTo(0, 6)
    expect(latLonToTexelUv(0, 180)?.u).toBeCloseTo(0, 6)
  })

  it('shifts U by lonOrigin, wrapping like GLSL fract()', () => {
    // A dateline-centred dataset: lon 180 becomes the middle.
    const opts: DatasetOverlayOptions = { lonOrigin: 180 }
    expect(latLonToTexelUv(0, 180, opts)?.u).toBeCloseTo(0.5, 6)
    expect(latLonToTexelUv(0, 0, opts)?.u).toBeCloseTo(0, 6)
    // A negative intermediate must wrap forward like GLSL fract(),
    // not clamp and not stay negative. lon -90 sits 270 degrees east
    // of the dateline centre, so it lands on the texture's right
    // half: raw = -0.25, fract(-0.25) = 0.75.
    const u = latLonToTexelUv(0, -90, opts)?.u
    expect(u).toBeGreaterThanOrEqual(0)
    expect(u).toBeLessThan(1)
    expect(u).toBeCloseTo(0.75, 6)
    // …and the eastward direction is the mirror of it.
    expect(latLonToTexelUv(0, 90, opts)?.u).toBeCloseTo(0.25, 6)
  })

  it('honours isFlippedInY', () => {
    expect(latLonToTexelUv(90, 0, { isFlippedInY: true })?.v).toBeCloseTo(1, 6)
  })

  it('treats a worldwide bbox as the full-globe path', () => {
    // wireToDataset defaults every catalog row to this box.
    const global: DatasetOverlayOptions = {
      boundingBox: { n: 90, s: -90, w: -180, e: 180 },
    }
    expect(latLonToTexelUv(90, 0, global)?.v).toBeCloseTo(0, 6)
    expect(latLonToTexelUv(0, 0, global)?.u).toBeCloseTo(0.5, 6)
  })
})

describe('latLonToTexelUv — regional bbox', () => {
  // The RRFS smoke box, the dataset that motivated this work.
  const opts: DatasetOverlayOptions = { boundingBox: { n: 53, s: 21, w: -134, e: -60 } }

  it('maps the box corners to the texture corners', () => {
    expect(latLonToTexelUv(53, -134, opts)).toEqual({ u: 0, v: 0 })
    const se = latLonToTexelUv(21, -60, opts)
    expect(se?.u).toBeCloseTo(1, 6)
    expect(se?.v).toBeCloseTo(1, 6)
  })

  it('keeps north at the top inside the box', () => {
    const north = latLonToTexelUv(50, -100, opts)!
    const south = latLonToTexelUv(25, -100, opts)!
    expect(north.v).toBeLessThan(south.v)
  })

  it('returns null outside the box, matching the shader discard', () => {
    expect(latLonToTexelUv(60, -100, opts)).toBeNull() // north of n
    expect(latLonToTexelUv(10, -100, opts)).toBeNull() // south of s
    expect(latLonToTexelUv(37, 20, opts)).toBeNull() // east of e
  })

  it('handles an antimeridian-crossing box', () => {
    const pacific: DatasetOverlayOptions = { boundingBox: { n: 20, s: -20, w: 170, e: -170 } }
    expect(latLonToTexelUv(0, 170, pacific)?.u).toBeCloseTo(0, 6)
    expect(latLonToTexelUv(0, 180, pacific)?.u).toBeCloseTo(0.5, 6)
    expect(latLonToTexelUv(0, -170, pacific)?.u).toBeCloseTo(1, 6)
    expect(latLonToTexelUv(0, 0, pacific)).toBeNull()
  })
})

/** A sampler that reports a fixed luma, recording the UVs it was asked
 *  for so the lat/lon → texel mapping can be asserted through the whole
 *  path rather than only against the pure helper. */
function fakeSampler(luma: number, seen: TexelUv[] = []): LumaSampler {
  return (_source, uv) => {
    seen.push(uv)
    return luma
  }
}

const fakeVideo = (w = 4096, h = 2048): ProbeSource =>
  Object.assign(Object.create(HTMLVideoElement.prototype) as HTMLVideoElement, {
    videoWidth: w,
    videoHeight: h,
  })

describe('uvToTexel', () => {
  it('indexes the texel from the UV', () => {
    expect(uvToTexel(fakeVideo(4096, 2048), { u: 0.25, v: 0.75 })).toEqual({ sx: 1024, sy: 1536 })
  })

  it('clamps at the far edge rather than indexing out of bounds', () => {
    expect(uvToTexel(fakeVideo(100, 50), { u: 1, v: 1 })).toEqual({ sx: 99, sy: 49 })
  })

  it('returns null before a frame has decoded', () => {
    expect(uvToTexel(fakeVideo(0, 0), { u: 0.5, v: 0.5 })).toBeNull()
  })
})

describe('probeDatasetValue', () => {
  it('reports the physical value with units', () => {
    const sample = fakeSampler(255)
    const r = probeDatasetValue(0, 0, fakeVideo(), sample, { colorScale: SCALE })
    expect(r?.value).toBeCloseTo(100, 6)
    expect(r?.units).toBe('mg m-2')
    expect(r?.noData).toBe(false)
  })

  it('flags the no-data band instead of reporting a number near vmin', () => {
    const sample = fakeSampler(3) // 3/255 < 12/256
    expect(probeDatasetValue(0, 0, fakeVideo(), sample, { colorScale: SCALE })?.noData).toBe(true)
  })

  it('returns null for a dataset that is not data-encoded', () => {
    // The backwards-compatibility guarantee for the readout: a
    // picture dataset reports nothing rather than a made-up number.
    const sample = fakeSampler(200)
    expect(probeDatasetValue(0, 0, fakeVideo(), sample, undefined)).toBeNull()
    expect(probeDatasetValue(0, 0, fakeVideo(), sample, { lonOrigin: 0 })).toBeNull()
  })

  it('returns null outside a regional dataset', () => {
    const sample = fakeSampler(200)
    const opts: DatasetOverlayOptions = {
      colorScale: SCALE,
      boundingBox: { n: 53, s: 21, w: -134, e: -60 },
    }
    expect(probeDatasetValue(0, 0, fakeVideo(), sample, opts)).toBeNull()
    expect(probeDatasetValue(37, -100, fakeVideo(), sample, opts)).not.toBeNull()
  })
})

describe('sphereUvToLatLon — the VR globe', () => {
  it('reads uv.y == 1 as the north pole, opposite the 2D convention', () => {
    // THREE's SphereGeometry puts uv.y == 1 at +Y. Copying the 2D
    // globe's form here mirrors the data across the equator — the
    // failure that has shipped twice in this codebase.
    expect(sphereUvToLatLon({ x: 0.5, y: 1 }).lat).toBeCloseTo(90, 6)
    expect(sphereUvToLatLon({ x: 0.5, y: 0 }).lat).toBeCloseTo(-90, 6)
    expect(sphereUvToLatLon({ x: 0.5, y: 0.5 }).lat).toBeCloseTo(0, 6)
  })

  it('is the inverse of the 2D mapping, not a copy of it', () => {
    // Round-tripping through latLonToTexelUv must land back where it
    // started. If both used the same sign the pair would be
    // self-consistently wrong, so assert the hemisphere explicitly
    // too: a northern sphere uv maps to the image's TOP half.
    const { lat, lon } = sphereUvToLatLon({ x: 0.75, y: 0.75 })
    expect(lat).toBeCloseTo(45, 6)
    const texel = latLonToTexelUv(lat, lon)
    expect(texel?.v).toBeCloseTo(0.25, 6) // north → top of the image
    expect(texel?.u).toBeCloseTo(0.75, 6)
  })

  it('maps longitude with 0.5 at the prime meridian', () => {
    expect(sphereUvToLatLon({ x: 0.5, y: 0.5 }).lon).toBeCloseTo(0, 6)
    expect(sphereUvToLatLon({ x: 0, y: 0.5 }).lon).toBeCloseTo(-180, 6)
    expect(sphereUvToLatLon({ x: 1, y: 0.5 }).lon).toBeCloseTo(180, 6)
  })

  it('round-trips back through the texel map, with V inverted', () => {
    // V inverts because the two conventions are opposites — that is
    // the whole point of having a separate function per renderer.
    for (const uv of [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.6 },
      { x: 0.9, y: 0.1 },
      { x: 0.5, y: 0.5 },
    ]) {
      const { lat, lon } = sphereUvToLatLon(uv)
      const texel = latLonToTexelUv(lat, lon)!
      expect(texel.u).toBeCloseTo(uv.x, 5)
      expect(texel.v).toBeCloseTo(1 - uv.y, 5)
    }
  })

  it('wraps the dateline seam rather than round-tripping it', () => {
    // uv.x == 1 is lon 180, which the texel map wraps to u == 0 —
    // the same column as uv.x == 0. Both are the seam, so the round
    // trip above deliberately excludes it rather than asserting an
    // identity that does not hold on a repeating texture.
    const east = sphereUvToLatLon({ x: 1, y: 0.5 })
    expect(east.lon).toBeCloseTo(180, 6)
    expect(latLonToTexelUv(east.lat, east.lon)?.u).toBeCloseTo(0, 6)
  })
})

describe('texelUvToLatLon — the inverse', () => {
  // An inverted inverse is the same bug as an inverted forward map
  // wearing a different hat: it places every computed statistic in the
  // wrong hemisphere while leaving the globe looking correct. So the
  // poles are pinned explicitly, in both directions, before anything
  // round-trips.
  it('puts the image top at the north pole on a full globe', () => {
    expect(texelUvToLatLon({ u: 0.5, v: 0 }).lat).toBeCloseTo(90, 6)
    expect(texelUvToLatLon({ u: 0.5, v: 1 }).lat).toBeCloseTo(-90, 6)
    expect(texelUvToLatLon({ u: 0.5, v: 0.5 }).lat).toBeCloseTo(0, 6)
  })

  it('puts the image top at the box north edge on a regional dataset', () => {
    const opts: DatasetOverlayOptions = { boundingBox: { n: 85, s: 5, w: -175, e: -20 } }
    expect(texelUvToLatLon({ u: 0, v: 0 }, opts).lat).toBeCloseTo(85, 6)
    expect(texelUvToLatLon({ u: 0, v: 1 }, opts).lat).toBeCloseTo(5, 6)
    expect(texelUvToLatLon({ u: 0, v: 0 }, opts).lon).toBeCloseTo(-175, 6)
    expect(texelUvToLatLon({ u: 1, v: 0 }, opts).lon).toBeCloseTo(-20, 6)
  })

  it('honours the Y flip, mirroring latitude about the box centre', () => {
    const opts: DatasetOverlayOptions = {
      boundingBox: { n: 85, s: 5, w: -175, e: -20 },
      isFlippedInY: true,
    }
    expect(texelUvToLatLon({ u: 0, v: 0 }, opts).lat).toBeCloseTo(5, 6)
    expect(texelUvToLatLon({ u: 0, v: 1 }, opts).lat).toBeCloseTo(85, 6)
  })

  it('round-trips against latLonToTexelUv on a full globe', () => {
    for (const [lat, lon] of [
      [0, 0], [45, 90], [-45, -90], [80, 179], [-80, -179], [10, -1], [-10, 1],
    ] as const) {
      const uv = latLonToTexelUv(lat, lon)!
      const back = texelUvToLatLon(uv)
      expect(back.lat).toBeCloseTo(lat, 9)
      expect(back.lon).toBeCloseTo(lon, 9)
    }
  })

  it('round-trips on a regional dataset, flipped and not', () => {
    const box = { n: 85, s: 5, w: -175, e: -20 }
    for (const isFlippedInY of [false, true]) {
      const opts: DatasetOverlayOptions = { boundingBox: box, isFlippedInY }
      for (const [lat, lon] of [[85, -175], [5, -20], [45, -100], [70, -30]] as const) {
        const uv = latLonToTexelUv(lat, lon, opts)!
        const back = texelUvToLatLon(uv, opts)
        expect(back.lat).toBeCloseTo(lat, 9)
        expect(back.lon).toBeCloseTo(lon, 9)
      }
    }
  })

  it('round-trips across an antimeridian-crossing box', () => {
    // w > e: the box runs east from 150 through 180 to -150.
    const opts: DatasetOverlayOptions = { boundingBox: { n: 60, s: -60, w: 150, e: -150 } }
    for (const [lat, lon] of [[0, 150], [0, 179], [0, -179], [0, -150], [30, 170]] as const) {
      const uv = latLonToTexelUv(lat, lon, opts)!
      const back = texelUvToLatLon(uv, opts)
      expect(back.lat).toBeCloseTo(lat, 9)
      expect(back.lon).toBeCloseTo(lon, 9)
    }
  })

  it('round-trips a shifted lonOrigin', () => {
    const opts: DatasetOverlayOptions = { lonOrigin: 180 }
    for (const [lat, lon] of [[0, 180], [0, 0], [0, -90], [0, 90], [45, 120]] as const) {
      const uv = latLonToTexelUv(lat, lon, opts)!
      const back = texelUvToLatLon(uv, opts)
      expect(back.lat).toBeCloseTo(lat, 9)
      // lon 180 and -180 are the same meridian; the inverse normalises
      // to the -180 end of the range.
      const delta = Math.abs(((back.lon - lon + 540) % 360) - 180)
      expect(delta).toBeCloseTo(0, 9)
    }
  })

  it('normalises longitude into [-180, 180)', () => {
    // A dateline-centred dataset's right edge is lon 360 before wrapping.
    const opts: DatasetOverlayOptions = { lonOrigin: 180 }
    const lon = texelUvToLatLon({ u: 1, v: 0.5 }, opts).lon
    expect(lon).toBeGreaterThanOrEqual(-180)
    expect(lon).toBeLessThan(180)
  })
})

describe('lonSpanDegrees', () => {
  it('is a full turn for a global dataset, with or without a defaulted box', () => {
    expect(lonSpanDegrees()).toBe(360)
    expect(lonSpanDegrees({ boundingBox: { n: 90, s: -90, w: -180, e: 180 } })).toBe(360)
  })

  it('is the box width for a regional dataset', () => {
    expect(lonSpanDegrees({ boundingBox: { n: 85, s: 5, w: -175, e: -20 } })).toBe(155)
  })

  it('measures eastward through the antimeridian, not the long way round', () => {
    // w=150, e=-150 is a 60-degree box spanning the dateline, not a
    // 300-degree one spanning everything else. Reading it the other way
    // is exactly the bug the wrap arithmetic exists to prevent, so the
    // name says which of the two answers is correct.
    expect(lonSpanDegrees({ boundingBox: { n: 60, s: -60, w: 150, e: -150 } })).toBe(60)
  })
})

describe('a reading does not print digits the transport cannot carry', () => {
  // The live column-loading row spans 0 to 5e-4 over 256 codes, so one
  // luma step is about 1.96e-6. Three significant figures on a value of
  // 7e-5 renders "0.0000700" — resolution to 1e-7, on data quantised
  // fifty times more coarsely. The trailing digit is an artefact of the
  // divide, not a measurement, and it sits in the corner of the screen
  // next to a globe that looks authoritative.
  const STEP = 5e-4 / 255

  it('drops a digit finer than one luma step', () => {
    // 3 significant figures would render 0.0000734 — a final digit at
    // 1e-7 on a field quantised at ~2e-6.
    const shown = formatProbeReading({ value: 7.34e-5, units: 'kg m-2', noData: false, quantisationStep: STEP })
    expect(shown).toContain('0.000073')
    expect(shown).not.toContain('0.0000734')
  })

  it('keeps every digit the step does support', () => {
    // A coarse scale: 0..255 over 256 codes is a step of 1, so integers
    // are exactly what it can resolve.
    const shown = formatProbeReading({ value: 137, units: 'mg m-2', noData: false, quantisationStep: 1 })
    expect(shown).toContain('137')
  })

  it('still caps at three significant figures for a fine scale', () => {
    // A step far below the third digit must not license a fourth.
    const shown = formatProbeReading({ value: 1.23456, units: 'K', noData: false, quantisationStep: 1e-9 })
    expect(shown).toContain('1.23')
    expect(shown).not.toContain('1.2345')
  })

  it('falls back to the old behaviour when no step is known', () => {
    // Readings built before the field existed still format, at the
    // unbounded three significant figures.
    const shown = formatProbeReading({ value: 7.34e-5, units: 'kg m-2', noData: false })
    expect(shown).toContain('0.0000734')
  })

  it('says no data regardless of the step', () => {
    expect(formatProbeReading({ value: 0, noData: true, quantisationStep: STEP })).toBeTruthy()
  })
})
