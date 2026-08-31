// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the data-encoded statistics reducers.
 *
 * Two failure modes drive most of what is asserted here, because both
 * produce numbers that look entirely reasonable:
 *
 *   1. An unweighted mean. On the shipped RRFS bbox (5°N–85°N) the
 *      top row's texels cover about a ninth the area of the bottom
 *      row's, so an unweighted mean is wrong by a large factor and
 *      still lands inside the value range. The fields below are built
 *      so the weighted and unweighted answers differ, and the expected
 *      value is computed from the geometry rather than copied from a
 *      previous run.
 *   2. Counting absent data as `vmin`. A smoke field is mostly empty,
 *      so this drags every mean toward the bottom of the scale in
 *      proportion to how empty it is — which reads as "not much smoke
 *      today" rather than as a bug.
 */
import { describe, expect, it } from 'vitest'
import {
  LUMA_LEVELS,
  areaAboveKm2,
  buildHistogram,
  findExtremum,
  fullWindow,
  rowAreasKm2,
  boundsRing,
  greatCircleKm,
  greatCirclePath,
  MAX_TRANSECT_SAMPLES,
  sampleTransect,
  summarize,
  summarizeTransect,
  transectSampleCount,
  weightedQuantile,
  windowForBounds,
  zonalMeans,
} from './datasetStats'
import { latLonToTexelUv, uvToTexelInSize } from './datasetProbe'
import type { LumaSnapshot } from './glLumaSampler'
import type { ColorScale, DatasetOverlayOptions } from '../types'

/** vmin 0 / vmax 255 makes luma and value numerically equal, so an
 *  expected value can be read straight off the fixture. The transparent
 *  band is the shipped 12/256. */
const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 255, 255, 255] },
  ],
  vmin: 0,
  vmax: 255,
  units: 'mg m-2',
  transparentRange: 12 / 256,
}

/** The bbox the three live RRFS rows carry. */
const RRFS: DatasetOverlayOptions = { boundingBox: { n: 85, s: 5, w: -175, e: -20 } }

function snap(width: number, height: number, fill: (x: number, y: number) => number): LumaSnapshot {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y)
  }
  return { data, width, height }
}

describe('rowAreasKm2', () => {
  it('shrinks toward the pole, and by the amount the geometry says', () => {
    // A global frame, two rows: 90..0 and 0..-90. Each hemisphere is
    // half the sphere, so with one column each row is half the sphere's
    // area — the two are equal, which is the degenerate case. Use four
    // rows so the bands actually differ.
    const areas = rowAreasKm2(1, 4)
    // Bands are 90..45, 45..0, 0..-45, -45..-90. sin(90)-sin(45) is
    // much smaller than sin(45)-sin(0), so the polar band is smaller.
    // Compared as ratios throughout: these are ~1e8 km², where an
    // absolute toBeCloseTo tolerance is meaningless.
    expect(areas[0]).toBeLessThan(areas[1])
    expect(areas[2] / areas[1]).toBeCloseTo(1, 12) // symmetric about the equator
    expect(areas[3] / areas[0]).toBeCloseTo(1, 12)
    expect(areas[1] / areas[0])
      .toBeCloseTo(Math.sin(Math.PI / 4) / (1 - Math.sin(Math.PI / 4)), 9)
  })

  it('sums to the surface of the sphere for a global frame', () => {
    const areas = rowAreasKm2(8, 16)
    let total = 0
    for (let y = 0; y < 16; y++) total += areas[y] * 8 // 8 columns per row
    expect(total / (4 * Math.PI * 6371.0088 ** 2)).toBeCloseTo(1, 12)
  })

  it('is indifferent to a Y flip', () => {
    const plain = rowAreasKm2(4, 8, RRFS)
    const flipped = rowAreasKm2(4, 8, { ...RRFS, isFlippedInY: true })
    // Same set of bands, reversed — area is a magnitude, not a signed
    // difference, which is the whole reason for the abs().
    for (let y = 0; y < 8; y++) expect(flipped[y] / plain[7 - y]).toBeCloseTo(1, 12)
  })

  it('covers only the bbox for a regional dataset', () => {
    const areas = rowAreasKm2(10, 10, RRFS)
    let total = 0
    for (let y = 0; y < 10; y++) total += areas[y] * 10
    // R² · Δλ · (sin 85° − sin 5°) for the 155° of longitude the box spans.
    const expected = 6371.0088 ** 2
      * (155 * Math.PI / 180)
      * (Math.sin(85 * Math.PI / 180) - Math.sin(5 * Math.PI / 180))
    expect(total / expected).toBeCloseTo(1, 12)
  })
})

describe('buildHistogram', () => {
  it('excludes the transparent band from the weights but not the count', () => {
    // Half the frame absent (luma 0), half at luma 200.
    const s = snap(4, 4, (_x, y) => (y < 2 ? 0 : 200))
    const hist = buildHistogram(s, SCALE, RRFS)
    expect(hist.examined).toBe(16)
    expect(hist.dataCount).toBe(8)
    expect(hist.counts[0]).toBe(8)
    expect(hist.weights[0]).toBe(0)
    expect(hist.weights[200]).toBeGreaterThan(0)
  })

  it('treats the top of the transparent band as absent and the next code as data', () => {
    // transparentRange 12/256 → luma 11 is absent, luma 12 is data.
    const absent = buildHistogram(snap(1, 1, () => 11), SCALE, RRFS)
    expect(absent.dataCount).toBe(0)
    const present = buildHistogram(snap(1, 1, () => 12), SCALE, RRFS)
    expect(present.dataCount).toBe(1)
  })

  it('honours a texel window and clamps it to the frame', () => {
    const s = snap(4, 4, (x) => (x === 0 ? 100 : 200))
    const hist = buildHistogram(s, SCALE, RRFS, { x0: 0, y0: 0, x1: 1, y1: 4 })
    expect(hist.dataCount).toBe(4)
    expect(hist.counts[100]).toBe(4)
    expect(hist.counts[200]).toBe(0)

    const clamped = buildHistogram(s, SCALE, RRFS, { x0: -5, y0: -5, x1: 99, y1: 99 })
    expect(clamped.examined).toBe(16)
  })

  it('returns an empty tally for a degenerate window', () => {
    const hist = buildHistogram(snap(4, 4, () => 200), SCALE, RRFS, { x0: 2, y0: 2, x1: 2, y1: 4 })
    expect(hist.examined).toBe(0)
    expect(hist.totalWeight).toBe(0)
  })
})

describe('summarize — area weighting', () => {
  it('differs from the unweighted mean, in the direction the geometry demands', () => {
    // Top half (toward 85°N, small texels) hot; bottom half (toward
    // 5°N, large texels) cool. The unweighted mean is the midpoint;
    // the weighted mean must sit closer to the cool value.
    const s = snap(2, 2, (_x, y) => (y === 0 ? 200 : 100))
    const stats = summarize(s, SCALE, RRFS)!
    expect(stats).not.toBeNull()

    const unweighted = 150
    expect(stats.mean).toBeLessThan(unweighted)

    // Compute the expectation from the same geometry, independently of
    // the implementation's loop.
    const areas = rowAreasKm2(2, 2, RRFS)
    const expected = (areas[0] * 2 * 200 + areas[1] * 2 * 100) / (areas[0] * 2 + areas[1] * 2)
    expect(stats.mean).toBeCloseTo(expected, 6)
  })

  it('is the plain mean when every texel has the same area', () => {
    // A one-row frame: no latitude variation, so weighting is inert and
    // the weighted mean must equal the arithmetic one.
    const s = snap(4, 1, (x) => [100, 140, 180, 220][x])
    const stats = summarize(s, SCALE, RRFS)!
    expect(stats.mean).toBeCloseTo(160, 6)
  })

  it('ignores absent data rather than counting it as vmin', () => {
    // Three quarters absent. Counting absent as 0 would give 50.
    const s = snap(2, 2, (x, y) => (x === 0 && y === 0 ? 200 : 0))
    const stats = summarize(s, SCALE, RRFS)!
    expect(stats.mean).toBeCloseTo(200, 6)
    expect(stats.count).toBe(1)
    expect(stats.examined).toBe(4)
    expect(stats.coverage).toBeCloseTo(0.25, 6)
  })

  it('returns null when nothing in the window carries data', () => {
    expect(summarize(snap(4, 4, () => 0), SCALE, RRFS)).toBeNull()
  })

  it('reports min, max and a zero spread on a constant field', () => {
    const stats = summarize(snap(3, 3, () => 128), SCALE, RRFS)!
    expect(stats.min).toBeCloseTo(128, 6)
    expect(stats.max).toBeCloseTo(128, 6)
    expect(stats.stdDev).toBeCloseTo(0, 6)
    expect(stats.median).toBeCloseTo(128, 6)
    expect(stats.units).toBe('mg m-2')
  })

  it('carries the scale through to physical units', () => {
    // The live smoke scale: 0 → 5e-4 kg m-2 across 256 codes.
    const smoke: ColorScale = { ...SCALE, vmin: 0, vmax: 0.0005, units: 'kg m-2' }
    const stats = summarize(snap(1, 1, () => 255), smoke, RRFS)!
    expect(stats.max).toBeCloseTo(0.0005, 12)
    expect(stats.units).toBe('kg m-2')
  })
})

describe('weightedQuantile', () => {
  it('splits a two-valued field at the weighted midpoint', () => {
    // One row, so weights are equal: half at 100, half at 200.
    const hist = buildHistogram(snap(4, 1, (x) => (x < 2 ? 100 : 200)), SCALE, RRFS)
    expect(weightedQuantile(hist, SCALE, 0.25)).toBeCloseTo(100, 6)
    expect(weightedQuantile(hist, SCALE, 0.75)).toBeCloseTo(200, 6)
  })

  it('clamps out-of-range fractions instead of returning NaN', () => {
    const hist = buildHistogram(snap(2, 1, () => 150), SCALE, RRFS)
    expect(weightedQuantile(hist, SCALE, -1)).toBeCloseTo(150, 6)
    expect(weightedQuantile(hist, SCALE, 2)).toBeCloseTo(150, 6)
  })

  it('is NaN for an empty histogram', () => {
    const hist = buildHistogram(snap(2, 2, () => 0), SCALE, RRFS)
    expect(weightedQuantile(hist, SCALE, 0.5)).toBeNaN()
  })
})

describe('areaAboveKm2', () => {
  it('counts only the texels at or above the threshold', () => {
    const s = snap(4, 1, (x) => (x < 2 ? 100 : 200))
    const hist = buildHistogram(s, SCALE, RRFS)
    const all = areaAboveKm2(hist, SCALE, 0)
    const high = areaAboveKm2(hist, SCALE, 150)
    expect(high).toBeCloseTo(all / 2, 6)
    expect(areaAboveKm2(hist, SCALE, 1000)).toBe(0)
  })

  it('is inclusive at the threshold', () => {
    const hist = buildHistogram(snap(1, 1, () => 200), SCALE, RRFS)
    expect(areaAboveKm2(hist, SCALE, 200)).toBeGreaterThan(0)
  })
})

describe('findExtremum', () => {
  it('locates the maximum and reports where it is', () => {
    const s = snap(4, 4, (x, y) => (x === 3 && y === 0 ? 250 : 100))
    const hit = findExtremum(s, SCALE, 'max', RRFS)!
    expect(hit.value).toBeCloseTo(250, 6)
    expect(hit.x).toBe(3)
    expect(hit.y).toBe(0)
    // y == 0 is the image's top row, which for an unflipped regional
    // dataset is the NORTH edge. Getting this backwards is the failure
    // the probe's docstring says has shipped twice.
    //
    // The reported point is the texel's CENTRE, so on a 4-row frame
    // over 85..5 it is 85 - (0.5/4)*80 = 75, not 85. Asserting the
    // edge instead would be asserting an off-by-half-a-texel bug.
    expect(hit.lat).toBeCloseTo(75, 6)
    // Likewise in longitude: -175 + (3.5/4)*155 = -39.375.
    expect(hit.lon).toBeCloseTo(-39.375, 6)
  })

  it('mirrors the latitude when the dataset is Y-flipped', () => {
    const s = snap(4, 4, (x, y) => (x === 3 && y === 0 ? 250 : 100))
    const hit = findExtremum(s, SCALE, 'max', { ...RRFS, isFlippedInY: true })!
    // Mirrored about the box's mid-latitude: 85 - (3.5/4)*80 = 15.
    expect(hit.lat).toBeCloseTo(15, 6)
  })

  it('finds the minimum among data, never among absent texels', () => {
    const s = snap(4, 4, (x, y) => (x === 0 && y === 0 ? 0 : 100))
    const hit = findExtremum(s, SCALE, 'min', RRFS)!
    // luma 0 is absent, so the minimum is 100 and not 0.
    expect(hit.value).toBeCloseTo(100, 6)
  })

  it('returns null when the window holds no data', () => {
    expect(findExtremum(snap(4, 4, () => 0), SCALE, 'max', RRFS)).toBeNull()
  })

  it('reports the middle of a plateau, not its corner', () => {
    // This used to return [0,0] — the first texel a row-major scan
    // met — and call it "where it is worst". That is the plateau's
    // north-west corner, an artefact of loop order presented as a
    // place, and live it put the pin on the edge of a smoke bank
    // rather than in it. These fields clip at the top of their scale,
    // so a tie is the normal case, not an edge case.
    const s = snap(4, 4, () => 200)
    const a = findExtremum(s, SCALE, 'max', RRFS)!
    expect(a.plateau).toBe(true)
    expect(a.tieCount).toBe(16)
    expect(a.patchCount).toBe(1)
    // Interior, not the corner.
    expect(a.x).toBeGreaterThan(0)
    expect(a.y).toBeGreaterThan(0)
    expect(a.x).toBeLessThan(3)
    expect(a.y).toBeLessThan(3)
  })

  it('is deterministic', () => {
    const s = snap(4, 4, () => 200)
    const a = findExtremum(s, SCALE, 'max', RRFS)!
    const b = findExtremum(s, SCALE, 'max', RRFS)!
    expect([b.x, b.y]).toEqual([a.x, a.y])
  })

  it('says a lone maximum is not a plateau', () => {
    const s = snap(8, 8, (x, y) => (x === 5 && y === 2 ? 250 : 100))
    const r = findExtremum(s, SCALE, 'max', RRFS)!
    expect(r.plateau).toBe(false)
    expect(r.tieCount).toBe(1)
    expect(r.patchCount).toBe(1)
    expect([r.x, r.y]).toEqual([5, 2])
  })

  it('picks the largest patch when the ceiling is hit in several places', () => {
    // Two fires at the same ceiling: one texel in the north-west, a
    // 3x3 block in the south-east. Row-major order would have reported
    // the lone north-west texel purely because it is scanned first.
    const s = snap(12, 12, (x, y) => {
      if (x === 1 && y === 1) return 250
      if (x >= 7 && x <= 9 && y >= 7 && y <= 9) return 250
      return 80
    })
    const r = findExtremum(s, SCALE, 'max', RRFS)!
    expect(r.patchCount).toBe(2)
    expect(r.tieCount).toBe(10)
    // The middle of the 3x3 block.
    expect([r.x, r.y]).toEqual([8, 8])
  })

  it('reports a point that actually holds the value, even for a crescent', () => {
    // A ring's centroid falls in its hole, which is not a place where
    // the maximum occurs. The report snaps to a real member.
    const s = snap(9, 9, (x, y) => {
      const ring = (x >= 3 && x <= 5 && y >= 3 && y <= 5) && !(x === 4 && y === 4)
      return ring ? 250 : 90
    })
    const r = findExtremum(s, SCALE, 'max', RRFS)!
    expect(s.data[r.y * 9 + r.x]).toBe(250)
    expect([r.x, r.y]).not.toEqual([4, 4])
  })

  it('measures how much of the world sits at the ceiling', () => {
    const s = snap(4, 4, () => 200)
    const r = findExtremum(s, SCALE, 'max', RRFS)!
    const areas = rowAreasKm2(4, 4, RRFS)
    let expected = 0
    for (let y = 0; y < 4; y++) expected += areas[y] * 4
    expect(r.tieAreaKm2).toBeCloseTo(expected, 6)
  })
})

describe('windowForBounds', () => {
  it('selects the northern half of a regional frame', () => {
    const s = snap(10, 10, () => 200)
    // The box spans 85..45, the top half of the dataset's 85..5.
    const win = windowForBounds(s, { n: 85, s: 45, w: -175, e: -20 }, RRFS)!
    expect(win.y0).toBe(0)
    expect(win.y1).toBe(5)
    expect(win.x0).toBe(0)
    expect(win.x1).toBe(10)
  })

  it('returns null when the box misses the dataset', () => {
    const s = snap(10, 10, () => 200)
    expect(windowForBounds(s, { n: -20, s: -40, w: -175, e: -20 }, RRFS)).toBeNull()
  })

  it('narrows the longitude range too', () => {
    const s = snap(10, 10, () => 200)
    const win = windowForBounds(s, { n: 85, s: 5, w: -175, e: -100 }, RRFS)!
    expect(win.x0).toBe(0)
    expect(win.x1).toBeLessThan(10)
  })
})

describe('sampleTransect', () => {
  it('walks from start to finish with monotonic distance', () => {
    const s = snap(8, 8, () => 200)
    const line = sampleTransect(s, SCALE, { lat: 60, lon: -150 }, { lat: 20, lon: -50 }, 9, RRFS)
    expect(line).toHaveLength(9)
    expect(line[0].distanceKm).toBeCloseTo(0, 6)
    for (let i = 1; i < line.length; i++) {
      expect(line[i].distanceKm).toBeGreaterThan(line[i - 1].distanceKm)
    }
    expect(line[0].lat).toBeCloseTo(60, 4)
    expect(line[0].lon).toBeCloseTo(-150, 4)
    expect(line[8].lat).toBeCloseTo(20, 4)
    expect(line[8].lon).toBeCloseTo(-50, 4)
  })

  it('spaces samples evenly in true distance', () => {
    const s = snap(8, 8, () => 200)
    const line = sampleTransect(s, SCALE, { lat: 80, lon: -170 }, { lat: 10, lon: -30 }, 5, RRFS)
    const step = line[1].distanceKm
    for (let i = 1; i < line.length; i++) {
      expect(line[i].distanceKm - line[i - 1].distanceKm).toBeCloseTo(step, 6)
    }
  })

  it('follows a great circle, not a straight line in lat/lon', () => {
    const s = snap(8, 8, () => 200)
    // Two points at the same latitude: the great circle between them
    // bulges poleward, so the midpoint must sit north of 70.
    const line = sampleTransect(s, SCALE, { lat: 70, lon: -170 }, { lat: 70, lon: -30 }, 3, RRFS)
    expect(line[1].lat).toBeGreaterThan(70.5)
  })

  it('reports null where the line leaves the dataset or crosses absent data', () => {
    const empty = snap(8, 8, () => 0)
    const line = sampleTransect(empty, SCALE, { lat: 60, lon: -150 }, { lat: 20, lon: -50 }, 5, RRFS)
    expect(line.every((p) => p.value === null)).toBe(true)

    const s = snap(8, 8, () => 200)
    // Start well south of the 5°N bottom edge.
    const outside = sampleTransect(s, SCALE, { lat: -60, lon: -150 }, { lat: -50, lon: -50 }, 4, RRFS)
    expect(outside.every((p) => p.value === null)).toBe(true)
  })

  it('survives coincident endpoints', () => {
    const s = snap(8, 8, () => 200)
    const line = sampleTransect(s, SCALE, { lat: 40, lon: -100 }, { lat: 40, lon: -100 }, 4, RRFS)
    expect(line).toHaveLength(4)
    expect(line.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))).toBe(true)
    expect(line[3].distanceKm).toBeCloseTo(0, 6)
  })

  it('always returns at least two samples', () => {
    const s = snap(8, 8, () => 200)
    expect(sampleTransect(s, SCALE, { lat: 40, lon: -100 }, { lat: 30, lon: -90 }, 0, RRFS))
      .toHaveLength(2)
  })
})

describe('transectSampleCount', () => {
  it('asks for about one sample per grid cell crossed', () => {
    // 160 columns across the RRFS box's 155° of longitude, 80 rows over
    // its 80° of latitude. A one-degree line at the equator-ward edge
    // therefore crosses roughly one cell.
    const s = snap(160, 80, () => 200)
    const n = transectSampleCount(s, { lat: 5, lon: -100 }, { lat: 5, lon: -80 }, RRFS)
    // 20° of longitude at 5°N ≈ 20 cells of ~0.97° each.
    expect(n).toBeGreaterThan(15)
    expect(n).toBeLessThan(30)
  })

  it('asks for more on a line across a finer grid', () => {
    const coarse = transectSampleCount(
      snap(80, 40, () => 200), { lat: 30, lon: -120 }, { lat: 30, lon: -60 }, RRFS)
    const fine = transectSampleCount(
      snap(320, 160, () => 200), { lat: 30, lon: -120 }, { lat: 30, lon: -60 }, RRFS)
    expect(fine).toBeGreaterThan(coarse * 3)
  })

  it('never asks for fewer than two or more than the cap', () => {
    const s = snap(4000, 2000, () => 200)
    expect(transectSampleCount(s, { lat: 40, lon: -100 }, { lat: 40, lon: -100 }, RRFS)).toBe(2)
    // A line the width of the domain on a 4000-wide grid would want
    // thousands of samples; the cap is what stops it.
    expect(transectSampleCount(s, { lat: 40, lon: -175 }, { lat: 40, lon: -20 }, RRFS))
      .toBe(MAX_TRANSECT_SAMPLES)
  })

  it('accounts for cells narrowing toward the pole', () => {
    const s = snap(160, 80, () => 200)
    // The same 20° of longitude spans far fewer km at 80°N than at 5°N,
    // but crosses the same number of grid columns — so the count must
    // not fall with cos(lat) the way the distance does.
    const low = transectSampleCount(s, { lat: 5, lon: -100 }, { lat: 5, lon: -80 }, RRFS)
    const high = transectSampleCount(s, { lat: 80, lon: -100 }, { lat: 80, lon: -80 }, RRFS)
    expect(high).toBeGreaterThan(low * 0.7)
  })
})

describe('greatCirclePath', () => {
  it('is the path sampleTransect walks', () => {
    const from = { lat: 60, lon: -150 }
    const to = { lat: 20, lon: -50 }
    const path = greatCirclePath(from, to, 7)
    const line = sampleTransect(snap(8, 8, () => 200), SCALE, from, to, 7, RRFS)
    expect(path).toHaveLength(7)
    for (let i = 0; i < path.length; i++) {
      expect(path[i].lat).toBeCloseTo(line[i].lat, 9)
      expect(path[i].lon).toBeCloseTo(line[i].lon, 9)
    }
  })

  it('bulges poleward between two points at the same latitude', () => {
    const path = greatCirclePath({ lat: 70, lon: -170 }, { lat: 70, lon: -30 }, 3)
    expect(path[1].lat).toBeGreaterThan(70.5)
  })
})

describe('boundsRing', () => {
  const BOX = { n: 35, s: 30, w: -88, e: -84 }

  it('closes, and never leaves the box', () => {
    const ring = boundsRing(BOX, 8)
    expect(ring[0]).toEqual(ring[ring.length - 1])
    for (const p of ring) {
      expect(p.lat).toBeGreaterThanOrEqual(30)
      expect(p.lat).toBeLessThanOrEqual(35)
      expect(p.lon).toBeGreaterThanOrEqual(-88)
      expect(p.lon).toBeLessThanOrEqual(-84)
    }
  })

  it('visits all four corners', () => {
    const ring = boundsRing(BOX, 8)
    const has = (lat: number, lon: number) =>
      ring.some((p) => Math.abs(p.lat - lat) < 1e-9 && Math.abs(p.lon - lon) < 1e-9)
    expect(has(30, -88)).toBe(true)
    expect(has(30, -84)).toBe(true)
    expect(has(35, -84)).toBe(true)
    expect(has(35, -88)).toBe(true)
  })

  it('follows parallels, not great circles', () => {
    // The whole point of not reusing greatCirclePath: the top edge of a
    // box is constant latitude. A great circle between the same corners
    // would bow poleward, which is a different box.
    const wide = boundsRing({ n: 70, s: 60, w: -170, e: -30 }, 16)
    const onTop = wide.filter((p) => Math.abs(p.lat - 70) < 1e-9)
    expect(onTop.length).toBeGreaterThan(10)
    for (const p of onTop) expect(p.lat).toBeCloseTo(70, 9)
  })

  it('walks an antimeridian box eastward, unwrapped', () => {
    // 150E → -150E is 60 degrees east across the seam. Emitting -180
    // mid-edge would make MapLibre draw the 300-degree complement.
    const ring = boundsRing({ n: 10, s: -10, w: 150, e: -150 }, 8)
    const lons = ring.map((p) => p.lon)
    expect(Math.min(...lons)).toBeCloseTo(150, 9)
    expect(Math.max(...lons)).toBeCloseTo(210, 9)
    expect(lons.some((l) => l < 0)).toBe(false)
  })

  it('emits enough vertices to read as a curve, and at least a rectangle', () => {
    expect(boundsRing(BOX, 32)).toHaveLength(4 * 32 + 1)
    expect(boundsRing(BOX, 0)).toHaveLength(4 * 2 + 1)
  })
})

describe('greatCircleKm', () => {
  it('measures a quarter of the way round for pole to equator', () => {
    const km = greatCircleKm({ lat: 90, lon: 0 }, { lat: 0, lon: 0 })
    expect(km / (2 * Math.PI * 6371.0088)).toBeCloseTo(0.25, 6)
  })

  it('reports exactly zero for coincident points', () => {
    expect(greatCircleKm({ lat: 12.5, lon: -73.25 }, { lat: 12.5, lon: -73.25 })).toBe(0)
  })
})

describe('summarizeTransect', () => {
  it('means the samples unweighted, because a line has no area', () => {
    const s = snap(8, 8, (_x, y) => 100 + y * 10)
    const line = sampleTransect(s, SCALE, { lat: 80, lon: -100 }, { lat: 10, lon: -100 }, 9, RRFS)
    const summary = summarizeTransect(line)!
    const values = line.map((p) => p.value).filter((v): v is number => v !== null)
    expect(summary.withData).toBe(values.length)
    expect(summary.mean).toBeCloseTo(values.reduce((a, b) => a + b, 0) / values.length, 9)
    expect(summary.min).toBe(Math.min(...values))
    expect(summary.max).toBe(Math.max(...values))
    expect(summary.lengthKm).toBeCloseTo(line[line.length - 1].distanceKm, 9)
    expect(summary.samples).toBe(9)
  })

  it('ignores the gaps rather than counting them as zero', () => {
    // Half the frame absent: a mean that counted the holes would fall
    // below every value actually present.
    const s = snap(8, 8, (_x, y) => (y < 4 ? 0 : 200))
    const line = sampleTransect(s, SCALE, { lat: 80, lon: -100 }, { lat: 10, lon: -100 }, 9, RRFS)
    const summary = summarizeTransect(line)!
    expect(summary.withData).toBeLessThan(summary.samples)
    expect(summary.mean).toBe(200)
    expect(summary.min).toBe(200)
  })

  it('is null when the line crosses nothing, and when there are no samples', () => {
    const empty = snap(8, 8, () => 0)
    const line = sampleTransect(empty, SCALE, { lat: 60, lon: -150 }, { lat: 20, lon: -50 }, 5, RRFS)
    expect(summarizeTransect(line)).toBeNull()
    expect(summarizeTransect([])).toBeNull()
  })
})

describe('zonalMeans', () => {
  it('returns one row per image row, north first for an unflipped frame', () => {
    const s = snap(4, 4, (_x, y) => 100 + y * 20)
    const rows = zonalMeans(s, SCALE, RRFS)
    expect(rows).toHaveLength(4)
    expect(rows[0].lat).toBeGreaterThan(rows[3].lat)
    expect(rows[0].mean).toBeCloseTo(100, 6)
    expect(rows[3].mean).toBeCloseTo(160, 6)
    expect(rows[0].count).toBe(4)
  })

  it('reports null for a row that is entirely absent', () => {
    const s = snap(4, 2, (_x, y) => (y === 0 ? 0 : 200))
    const rows = zonalMeans(s, SCALE, RRFS)
    expect(rows[0].mean).toBeNull()
    expect(rows[0].count).toBe(0)
    expect(rows[1].mean).toBeCloseTo(200, 6)
  })

  it('restricts to the window on both axes', () => {
    // Value depends on x alone, so a column-restricted mean is a
    // different number rather than the same one — an x window that was
    // ignored would still produce 130 here.
    const s = snap(4, 4, (x) => 100 + x * 20)
    const rows = zonalMeans(s, SCALE, RRFS, { x0: 0, y0: 1, x1: 2, y1: 3 })
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.count).toBe(2)
      expect(r.mean).toBeCloseTo(110, 6)
    }
    expect(zonalMeans(s, SCALE, RRFS)[0].mean).toBeCloseTo(130, 6)
  })

  it('keys latitude to the frame, not to the window', () => {
    // A scoped profile must not relabel its rows. Row 2 of the frame is
    // at one latitude whether or not the window starts above it —
    // otherwise narrowing the region would slide the whole profile.
    const s = snap(4, 4, (_x, y) => 100 + y * 20)
    const full = zonalMeans(s, SCALE, RRFS)
    const windowed = zonalMeans(s, SCALE, RRFS, { x0: 0, y0: 2, x1: 4, y1: 4 })
    expect(windowed).toHaveLength(2)
    expect(windowed[0].lat).toBeCloseTo(full[2].lat, 12)
    expect(windowed[1].lat).toBeCloseTo(full[3].lat, 12)
  })

  it('returns nothing for an empty window rather than a frame of nulls', () => {
    const s = snap(4, 4, () => 200)
    expect(zonalMeans(s, SCALE, RRFS, { x0: 2, y0: 2, x1: 2, y1: 4 })).toEqual([])
  })
})

describe('fullWindow', () => {
  it('spans the whole frame', () => {
    expect(fullWindow(snap(7, 3, () => 0))).toEqual({ x0: 0, y0: 0, x1: 7, y1: 3 })
  })
})

describe('LUMA_LEVELS', () => {
  it('is the number of values the transport can carry', () => {
    // Guards the histogram's claim to be exact rather than binned.
    expect(LUMA_LEVELS).toBe(256)
  })
})

describe('a reported location survives the trip back through the probe', () => {
  // The seam nothing covered. `findExtremum` picks a texel and converts
  // it to lat/lon; the hover readout takes a lat/lon and converts it to
  // a texel. Both directions had tests. The *composition* did not, and
  // the composition is what the user exercises: Orbit names a place,
  // they point at that place, and the two must agree about which texel
  // that is.
  //
  // Reported live: an extremum whose coordinates read "No data" when
  // probed by hand. The value was real; the place named for it was not
  // verifiable from inside the answer.
  const cases: Array<[string, DatasetOverlayOptions]> = [
    ['the live RRFS bbox', RRFS],
    ['a global frame', {}],
    ['a southern box', { boundingBox: { n: -10, s: -55, w: -80, e: -35 } }],
    ['a box crossing the antimeridian', { boundingBox: { n: 60, s: 20, w: 150, e: -150 } }],
    ['a flipped frame', { ...RRFS, isFlippedInY: true }],
  ]

  for (const [name, options] of cases) {
    it(`round-trips on ${name}`, () => {
      const width = 128
      const height = 64
      // One plume, off-centre in both axes so a flip or a transpose
      // cannot pass by symmetry.
      const px = 31
      const py = 12
      const s = snap(width, height, (x, y) =>
        (Math.abs(x - px) <= 2 && Math.abs(y - py) <= 2 ? 200 : 100))

      const hit = findExtremum(s, SCALE, 'max', options)!
      expect(hit.x).toBe(px)
      expect(hit.y).toBe(py)

      const uv = latLonToTexelUv(hit.lat, hit.lon, options)
      expect(uv).not.toBeNull()
      const back = uvToTexelInSize(width, height, uv!)!
      expect(back.sx).toBe(hit.x)
      expect(back.sy).toBe(hit.y)
      // And the value found there is the value reported, which is the
      // claim the user is actually checking when they point at it.
      expect(s.data[back.sy * width + back.sx]).toBe(200)
    })
  }

  it('round-trips after the coordinates are rounded for display', () => {
    // Three decimals is about a thousandth of a texel on these grids,
    // so rounding must never move the answer to a neighbouring cell.
    // `round3` once did exactly that by rounding to three *significant*
    // figures instead.
    const width = 4096
    const height = 2048
    const px = 2731
    const py = 907
    const s = snap(8, 8, () => 100)
    const data = new Uint8Array(width * height).fill(100)
    data[py * width + px] = 240
    const big: LumaSnapshot = { data, width, height }
    void s

    const hit = findExtremum(big, SCALE, 'max', RRFS)!
    const rounded = { lat: Math.round(hit.lat * 1000) / 1000, lon: Math.round(hit.lon * 1000) / 1000 }
    const uv = latLonToTexelUv(rounded.lat, rounded.lon, RRFS)!
    const back = uvToTexelInSize(width, height, uv)!
    expect(back.sx).toBe(px)
    expect(back.sy).toBe(py)
  })
})
