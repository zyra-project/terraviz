// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the isoline extractor.
 *
 * Two of these matter more than the rest, because both failures produce
 * a contour that looks entirely plausible on a globe:
 *
 *   1. Tracing the edge of the no-data region. A smoke field is mostly
 *      absent, and if absent texels are read as low values the isoline
 *      wraps the data's own footprint in a smooth, confident, completely
 *      fictional curve. That is `datasetStats`' "counting absent as
 *      vmin" mistake wearing different clothes.
 *   2. Crossing the antimeridian. A polyline stepping from +179 to −179
 *      is geometrically fine and draws as a stripe across the entire
 *      globe.
 *
 * The rest pin the marching-squares mechanics: that a crossing lands
 * where linear interpolation says, that neighbouring cells share their
 * crossings rather than each emitting a disconnected stub, and that the
 * ambiguous saddle resolves the same way twice.
 */
import { describe, expect, it } from 'vitest'
import {
  CONTOUR_TARGET_EDGE,
  MAX_CONTOUR_LEVELS,
  chooseStride,
  contourSetToGeoJson,
  contoursToGeoJson,
  extractContourSet,
  extractContours,
  splitAtSeam,
  type ContourPoint,
} from './datasetContours'
import type { LumaSnapshot } from './glLumaSampler'
import { isTransparentLuma, lumaToValue } from '../types/color-scale'
import type { ColorScale, DatasetOverlayOptions } from '../types'

/** vmin 0 / vmax 255, so luma and value are numerically equal and an
 *  expected threshold can be read straight off the fixture. */
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

/** A scale with no absent band at all, for the cases where absence is
 *  not what is under test. */
const DENSE: ColorScale = { ...SCALE, transparentRange: undefined }

/** A whole-globe frame keeps texel→lat/lon simple: u maps linearly to
 *  −180..180 and v to 90..−90. */
const GLOBAL: DatasetOverlayOptions = { boundingBox: { n: 90, s: -90, w: -180, e: 180 } }

function snap(width: number, height: number, fill: (x: number, y: number) => number): LumaSnapshot {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y)
  }
  return { data, width, height }
}

/** Total vertices across every returned line. */
function vertexCount(lines: ContourPoint[][]): number {
  return lines.reduce((n, l) => n + l.length, 0)
}

describe('extractContours', () => {
  it('returns nothing when the field is entirely on one side', () => {
    const high = snap(8, 8, () => 200)
    expect(extractContours(high, DENSE, 100, GLOBAL)).toEqual([])
    const low = snap(8, 8, () => 20)
    expect(extractContours(low, DENSE, 100, GLOBAL)).toEqual([])
  })

  it('returns nothing for a frame too small to hold a cell', () => {
    expect(extractContours(snap(1, 8, () => 200), DENSE, 100, GLOBAL)).toEqual([])
    expect(extractContours(snap(8, 1, () => 200), DENSE, 100, GLOBAL)).toEqual([])
  })

  it('ignores a non-finite threshold rather than emitting garbage', () => {
    const ramp = snap(8, 8, x => x * 32)
    expect(extractContours(ramp, DENSE, Number.NaN, GLOBAL)).toEqual([])
    expect(extractContours(ramp, DENSE, Number.POSITIVE_INFINITY, GLOBAL)).toEqual([])
  })

  it('puts the crossing where linear interpolation says, not on a texel centre', () => {
    // Two columns: 0 and 100. A threshold of 25 sits a quarter of the way
    // across, so the isoline should be at x = 0.25 in centre space — not
    // snapped to either centre.
    const frame = snap(2, 4, x => (x === 0 ? 0 : 100))
    const lines = extractContours(frame, DENSE, 25, GLOBAL)
    expect(lines).toHaveLength(1)
    // Width 2 → centres at u = 0.25 and 0.75, i.e. lon −90 and +90. A
    // quarter of the way between them is lon −45.
    for (const p of lines[0]) expect(p.lon).toBeCloseTo(-45, 6)
  })

  it('joins crossings across neighbouring cells into one line', () => {
    // A vertical step in an 8-tall frame: every row crosses at the same
    // place, and the result must be a single connected line rather than
    // seven two-point stubs.
    const frame = snap(4, 8, x => (x < 2 ? 0 : 200))
    const lines = extractContours(frame, DENSE, 100, GLOBAL)
    expect(lines).toHaveLength(1)
    expect(lines[0].length).toBeGreaterThan(2)
    // 8 rows of texels → 7 rows of cells, and each cell links the
    // crossing on its top edge to the one on its bottom edge. Those
    // edges are shared, so 7 cells chain 8 distinct vertices — the
    // off-by-one is the point: 7 would mean an end had been dropped.
    expect(lines[0]).toHaveLength(8)
  })

  it('closes a loop around an interior blob', () => {
    // A high square in the middle of a low field. The isoline encircles
    // it, so it comes back as a closed ring: first point repeated last.
    const frame = snap(9, 9, (x, y) => (x >= 3 && x <= 5 && y >= 3 && y <= 5 ? 200 : 0))
    const lines = extractContours(frame, DENSE, 100, GLOBAL)
    expect(lines).toHaveLength(1)
    const ring = lines[0]
    expect(ring.length).toBeGreaterThan(4)
    expect(ring[0].lat).toBeCloseTo(ring[ring.length - 1].lat, 12)
    expect(ring[0].lon).toBeCloseTo(ring[ring.length - 1].lon, 12)
  })

  it('does not trace the boundary of the no-data region', () => {
    // The whole left half is absent (luma below the 12/256 band), the
    // right half is uniformly high. There is no real crossing anywhere:
    // every cell either touches absent data or is entirely above.
    // Counting absent as vmin would draw a crisp line straight down the
    // middle, which is the bug this asserts against.
    const frame = snap(8, 8, x => (x < 4 ? 0 : 200))
    expect(extractContours(frame, SCALE, 100, GLOBAL)).toEqual([])

    // The same frame under a scale with no absent band *does* produce
    // the line — proving the fixture would otherwise contour, so the
    // assertion above is about absence and not about the geometry.
    expect(extractContours(frame, DENSE, 100, GLOBAL).length).toBeGreaterThan(0)
  })

  it('contours the data-carrying part of a frame that also has absent texels', () => {
    // Absent on the far left, a real gradient on the right. The isoline
    // should exist, and every vertex should sit in the data region
    // rather than at the absent boundary.
    const frame = snap(10, 6, x => (x < 2 ? 0 : 20 + (x - 2) * 30))
    const lines = extractContours(frame, SCALE, 100, GLOBAL)
    expect(lines.length).toBeGreaterThan(0)
    // Absent columns are x < 2; cells touching them are skipped, so no
    // vertex can sit west of the x = 2 centre. Width 10 → centre 2 is at
    // u = 0.25, lon −90.
    for (const line of lines) {
      for (const p of line) expect(p.lon).toBeGreaterThan(-90)
    }
  })

  it('resolves the saddle the same way on every call', () => {
    // Two high corners on one diagonal, two low on the other — the
    // ambiguous case. Whatever it decides, it must decide it stably, or
    // a redraw flickers between two different pictures of one frame.
    const frame = snap(2, 2, (x, y) => ((x + y) % 2 === 0 ? 200 : 0))
    const a = extractContours(frame, DENSE, 100, GLOBAL)
    const b = extractContours(frame, DENSE, 100, GLOBAL)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('honours a window and contours only inside it', () => {
    const frame = snap(16, 8, x => x * 16)
    const full = extractContours(frame, DENSE, 128, GLOBAL)
    const windowed = extractContours(frame, DENSE, 128, GLOBAL, {
      x0: 0, y0: 0, x1: 4, y1: 8,
    })
    expect(full.length).toBeGreaterThan(0)
    // The threshold is crossed at x = 8, outside the window entirely.
    expect(windowed).toEqual([])
  })

  it('excludes the outer half-texel rather than extrapolating past it', () => {
    // 8 columns of centres → 7 cells, so a monotonic ramp can produce at
    // most 7 crossing rows and none outside the centre lattice.
    const frame = snap(8, 8, x => x * 32)
    const lines = extractContours(frame, DENSE, 16, GLOBAL)
    // Threshold 16 falls between column 0 (0) and column 1 (32).
    expect(lines).toHaveLength(1)
    // Width 8 → centres span u = 1/16 .. 15/16, i.e. lon −168.75..168.75.
    for (const p of lines[0]) {
      expect(p.lon).toBeGreaterThanOrEqual(-168.75)
      expect(p.lon).toBeLessThanOrEqual(168.75)
    }
  })
})

describe('a band declared as dataMinLuma', () => {
  /** The same band as `SCALE`, spelled the other way the sidecar
   *  contract allows. Deliberately *not* the same scale: declaring the
   *  band re-anchors the value mapping onto the data codes, so this
   *  fixture loses `SCALE`'s luma-equals-value convenience and levels
   *  have to be named through `lumaToValue`. Absence is what is under
   *  test here, not the arithmetic. */
  const BANDED: ColorScale = { ...SCALE, transparentRange: undefined, dataMinLuma: 12 }

  it('refuses the no-data region however the band is spelled', () => {
    // Same fixture and same assertion as the `transparentRange` case
    // above. `buildCodeTable` settles absence through
    // `isTransparentLuma` rather than reading either field, so this
    // holds without the extractor knowing the field exists — which is
    // precisely why it is worth pinning. Nothing else in this file would
    // notice if that stopped being true, and the equivalent gap in
    // `buildDisplayLut` hid a real bug until the two were crossed.
    const frame = snap(8, 8, x => (x < 4 ? 0 : 200))
    expect(extractContours(frame, BANDED, lumaToValue(100, BANDED), GLOBAL)).toEqual([])
    // The same frame under no band does contour, so the assertion above
    // is about absence rather than about the geometry.
    expect(extractContours(frame, DENSE, 100, GLOBAL).length).toBeGreaterThan(0)
  })

  it('still contours the data-carrying part of a banded frame', () => {
    const frame = snap(10, 6, x => (x < 2 ? 0 : 20 + (x - 2) * 30))
    const lines = extractContours(frame, BANDED, lumaToValue(100, BANDED), GLOBAL)
    expect(lines.length).toBeGreaterThan(0)
    // Absent columns are x < 2, so no vertex can sit west of the x = 2
    // centre — lon −90 at width 10.
    for (const line of lines) {
      for (const p of line) expect(p.lon).toBeGreaterThan(-90)
    }
  })

  it('puts vmin at the first data code rather than at luma 0', () => {
    // The re-anchoring, as a number a reader can check. Under the band,
    // luma 12 *is* `vmin`. Under `transparentRange` — which hides
    // without re-anchoring — the same code still reads above it. Two
    // genuinely different claims, which is why the contract keeps both
    // fields rather than deriving one from the other.
    expect(lumaToValue(12, BANDED)).toBe(SCALE.vmin)
    expect(lumaToValue(12, SCALE)).toBeGreaterThan(SCALE.vmin)
    // The top of the range is the one place they must agree.
    expect(lumaToValue(255, BANDED)).toBe(lumaToValue(255, SCALE))
  })
})

describe('splitAtSeam', () => {
  it('cuts a line that jumps the antimeridian', () => {
    const points: ContourPoint[] = [
      { lat: 10, lon: 178 },
      { lat: 11, lon: 179 },
      { lat: 12, lon: -179 },
      { lat: 13, lon: -178 },
    ]
    const parts = splitAtSeam(points)
    expect(parts).toHaveLength(2)
    expect(parts[0].map(p => p.lon)).toEqual([178, 179])
    expect(parts[1].map(p => p.lon)).toEqual([-179, -178])
  })

  it('leaves an ordinary line alone', () => {
    const points: ContourPoint[] = [
      { lat: 0, lon: -10 },
      { lat: 1, lon: 0 },
      { lat: 2, lon: 10 },
    ]
    expect(splitAtSeam(points)).toEqual([points])
  })

  it('drops a fragment too short to draw', () => {
    // A single point stranded on the far side of the seam is not a line.
    const parts = splitAtSeam([
      { lat: 0, lon: 179 },
      { lat: 0, lon: -179 },
    ])
    expect(parts).toEqual([])
  })

  it('handles a degenerate input', () => {
    expect(splitAtSeam([])).toEqual([])
    expect(splitAtSeam([{ lat: 0, lon: 0 }])).toEqual([[{ lat: 0, lon: 0 }]])
  })
})

describe('contoursToGeoJson', () => {
  it('emits lon/lat order, which is the one GeoJSON wants', () => {
    const feature = contoursToGeoJson([[{ lat: 10, lon: -20 }, { lat: 11, lon: -21 }]])
    expect(feature.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [[[-20, 10], [-21, 11]]],
    })
  })

  it('survives an empty extraction', () => {
    const feature = contoursToGeoJson([])
    expect((feature.geometry as GeoJSON.MultiLineString).coordinates).toEqual([])
  })
})

describe('the contract with areaAboveKm2', () => {
  it('agrees about which side of the threshold a texel is on', () => {
    // The isoline and the area readout must use the same comparison, or
    // the panel says "1,000 km² above 100" while drawing the line
    // somewhere else. Both are `value >= threshold`; this pins that a
    // field entirely at the threshold counts as above and produces no
    // contour, which is the boundary case where a `>` would disagree.
    const exact = snap(8, 8, () => 100)
    expect(extractContours(exact, DENSE, 100, GLOBAL)).toEqual([])
    // And one code below the threshold produces no line either — there
    // is no crossing, not merely a line in a different place.
    const below = snap(8, 8, () => 99)
    expect(extractContours(below, DENSE, 100, GLOBAL)).toEqual([])
  })
})

describe('vertex budget', () => {
  it('does not emit more vertices than the cell lattice can hold', () => {
    // A sanity bound: every cell contributes at most two crossings, so a
    // noisy field cannot blow the source up without bound. This is the
    // cheap guard against handing MapLibre a million-vertex feature.
    const noisy = snap(32, 32, (x, y) => ((x * 7 + y * 13) % 2 === 0 ? 200 : 0))
    const lines = extractContours(noisy, DENSE, 100, GLOBAL)
    const cells = 31 * 31
    expect(vertexCount(lines)).toBeLessThanOrEqual(cells * 2 + lines.length)
  })
})

/**
 * The multi-level path.
 *
 * The load-bearing test is the equivalence one: walking the cells once
 * and testing every level inside that walk has to produce exactly what
 * N separate walks would. That optimisation exists because the shipped
 * frames are ~8.4M texels and per-level passes would stall visibly, and
 * an optimisation that quietly changes the geometry is worse than the
 * stall it avoided.
 */
describe('extractContourSet', () => {
  const RAMP = snap(24, 16, x => x * 10)

  it('agrees exactly with one separate pass per level', () => {
    const levels = [30, 60, 90, 150, 210]
    const set = extractContourSet(RAMP, DENSE, levels, GLOBAL)
    expect(set.map(l => l.value)).toEqual(levels)
    for (const level of set) {
      expect(level.lines).toEqual(extractContours(RAMP, DENSE, level.value, GLOBAL))
    }
  })

  it('sorts and de-duplicates the levels it was handed', () => {
    const set = extractContourSet(RAMP, DENSE, [90, 30, 90, 60, 30], GLOBAL)
    expect(set.map(l => l.value)).toEqual([30, 60, 90])
  })

  it('drops non-finite levels but keeps the rest', () => {
    const set = extractContourSet(RAMP, DENSE, [Number.NaN, 60, Number.POSITIVE_INFINITY], GLOBAL)
    expect(set.map(l => l.value)).toEqual([60])
  })

  it('keeps a level that traced nothing, rather than dropping it', () => {
    // 5000 is far above the ramp's top. The caller needs to tell "this
    // level is outside the data" from "this level was never asked for" —
    // a legend entry that should be greyed versus one that is absent.
    const set = extractContourSet(RAMP, DENSE, [60, 5000], GLOBAL)
    expect(set).toHaveLength(2)
    expect(set[1].value).toBe(5000)
    expect(set[1].lines).toEqual([])
    expect(set[0].lines.length).toBeGreaterThan(0)
  })

  it('caps the level count', () => {
    const many = Array.from({ length: MAX_CONTOUR_LEVELS + 20 }, (_, i) => i + 1)
    expect(extractContourSet(RAMP, DENSE, many, GLOBAL)).toHaveLength(MAX_CONTOUR_LEVELS)
  })

  it('returns empty levels rather than nothing for a frame too small to hold a cell', () => {
    const set = extractContourSet(snap(1, 8, () => 100), DENSE, [50, 100], GLOBAL)
    expect(set.map(l => l.value)).toEqual([50, 100])
    expect(set.every(l => l.lines.length === 0)).toBe(true)
  })

  it('returns nothing at all when asked for no levels', () => {
    expect(extractContourSet(RAMP, DENSE, [], GLOBAL)).toEqual([])
  })

  it('still refuses to trace the no-data boundary at any level', () => {
    // Left half absent, right half a real ramp. No level may produce a
    // line at the absent boundary — the failure mode this whole module
    // is built around, now checked across a set rather than one level.
    const frame = snap(12, 8, x => (x < 4 ? 0 : 20 + (x - 4) * 25))
    const set = extractContourSet(frame, SCALE, [40, 80, 120, 160], GLOBAL)
    // Cells touching the absent columns are skipped, so no vertex can
    // sit west of the x = 4 centre. Width 12 → centre 4 is u = 0.375,
    // lon −45.
    for (const level of set) {
      for (const line of level.lines) {
        for (const p of line) expect(p.lon).toBeGreaterThan(-45)
      }
    }
    expect(set.some(l => l.lines.length > 0)).toBe(true)
  })
})

describe('the fast cell test', () => {
  /**
   * The cell walk settles two questions from the raw luma codes rather
   * than the mapped values: whether any corner is absent (from the
   * lowest code alone) and what the cell's value range is (from its
   * code range). Both shortcuts hold only while absence is a contiguous
   * band at the bottom and values rise with the code, so `buildCodeTable`
   * verifies that and sends anything else down the general path.
   *
   * An inverted scale is the case where it does not hold, and it is also
   * the only one where the two paths can be compared directly: with
   * vmin and vmax swapped, value = 255 − luma, so the isoline at level L
   * falls on exactly the texels the upright scale puts at 255 − L. Same
   * crossings, same interpolation, opposite code path.
   *
   * (The contiguity half of the guard is not reachable through either
   * sidecar form today — both express absence as "below a cutoff". It
   * is there so that a future `isTransparentLuma` with a hole in it
   * fails safe into the general path instead of silently letting absent
   * texels into the contours.)
   */
  const DESCENDING: ColorScale = { ...DENSE, vmin: 255, vmax: 0 }

  // Sines on both axes, so the field has genuine saddles rather than one
  // monotone ramp. The saddle is the case where the two paths could
  // disagree and still return perfectly plausible lines.
  const field = snap(24, 16, (x, y) =>
    Math.round(128 + 100 * Math.sin((x / 24) * Math.PI * 2) * Math.cos((y / 16) * Math.PI * 2)))

  /** Every vertex, order-independent: the two paths may walk the graph
   *  from different ends, but they must touch the same points. */
  const fingerprint = (lines: ContourPoint[][]): string[] =>
    lines.flat().map(p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).sort()

  it('agrees with the general path on the same crossings', () => {
    // 180.5 rather than 180 on purpose: every texel here is an integer,
    // and a level sitting exactly on one would be counted as "above" by
    // both scales instead of by one, which is the single input where
    // the mirrored levels are not complementary.
    const fast = extractContours(field, DENSE, 180.5, GLOBAL)
    const general = extractContours(field, DESCENDING, 255 - 180.5, GLOBAL)

    expect(fast.length).toBeGreaterThan(0)
    expect(vertexCount(general)).toBe(vertexCount(fast))
    expect(fingerprint(general)).toEqual(fingerprint(fast))
  })

  it('still refuses to trace the no-data boundary on the general path', () => {
    // The same fixture as the fast-path version above: left half absent,
    // right half uniformly high. Falling back must not cost the rule
    // the whole module exists to enforce.
    const frame = snap(8, 8, x => (x < 4 ? 0 : 200))
    const sparse: ColorScale = { ...SCALE, vmin: 255, vmax: 0 }
    expect(extractContours(frame, sparse, 100, GLOBAL)).toEqual([])

    // …and the same frame with no absent band does produce the line, so
    // the assertion above is about absence rather than about a descending
    // scale finding nothing.
    expect(extractContours(frame, DESCENDING, 100, GLOBAL).length).toBeGreaterThan(0)
  })
})

describe('chooseStride', () => {
  it('leaves a frame at or under the target alone', () => {
    expect(chooseStride(CONTOUR_TARGET_EDGE, CONTOUR_TARGET_EDGE / 2)).toBe(1)
    expect(chooseStride(64, 32)).toBe(1)
  })

  it('picks the smallest exact divisor that gets under the target', () => {
    // The shipped frame sizes, which is the case that matters.
    expect(chooseStride(7200, 3600)).toBe(4)
    expect(chooseStride(4096, 2048)).toBe(2)
    expect(chooseStride(8192, 4096)).toBe(4)
  })

  it('refuses a stride that would not divide both dimensions exactly', () => {
    // A prime above the target has no divisor but itself, and walking a
    // frame down to one texel is not decimation. An uneven stride would
    // leave a partial column and stretch every contour eastward, so the
    // only safe answer is to walk it whole.
    const prime = 4099
    expect(chooseStride(prime, prime)).toBe(1)
  })

  it('gives up rather than reaching for an ever-coarser stride', () => {
    // 6144 is 2^11 x 3 and 3125 is 5^5, so nothing in the searched range
    // divides both. Walking at full resolution is slow; quartering the
    // frame again to suit the arithmetic would be wrong, and wrong in a
    // way that never shows up as an error.
    expect(chooseStride(6144, 3125)).toBe(1)
  })
})

describe('decimation', () => {
  /** Big enough to trip decimation, with a plain radial blob whose
   *  contour position is known independently of resolution. */
  function blob(width: number, height: number): LumaSnapshot {
    const cx = width / 2
    const cy = height / 2
    const r = Math.min(width, height) / 4
    return snap(width, height, (x, y) => {
      const d = Math.hypot(x - cx, y - cy) / r
      return d >= 1 ? 20 : 20 + Math.round((1 - d) * 200)
    })
  }

  it('puts the contour in the same place as an undecimated walk', () => {
    // The failure this guards is a *shifted* contour, which no amount of
    // looking at a globe would catch: decimation drops the frame to a
    // quarter, and if the texel→lat/lon mapping does not follow, every
    // line lands plausibly but wrongly.
    const big = blob(4096, 2048)
    expect(chooseStride(big.width, big.height)).toBeGreaterThan(1)
    const decimated = extractContours(big, DENSE, 120, GLOBAL)

    // The same field sampled at the size decimation would produce, run
    // through a walk that does no decimation of its own.
    const small = blob(2048, 1024)
    expect(chooseStride(small.width, small.height)).toBe(1)
    const direct = extractContours(small, DENSE, 120, GLOBAL)

    expect(decimated.length).toBeGreaterThan(0)
    expect(direct.length).toBeGreaterThan(0)
    // Compare extents rather than vertices: box-averaging is not
    // point-sampling, so the two rings are close but not identical.
    const spread = (lines: ContourPoint[][]): { lat: number, lon: number } => {
      const lats = lines.flat().map(p => p.lat)
      const lons = lines.flat().map(p => p.lon)
      return {
        lat: Math.max(...lats) - Math.min(...lats),
        lon: Math.max(...lons) - Math.min(...lons),
      }
    }
    const a = spread(decimated)
    const b = spread(direct)
    expect(a.lat).toBeCloseTo(b.lat, 0)
    expect(a.lon).toBeCloseTo(b.lon, 0)
    // And centred in the same place, not merely the same size.
    const centre = (lines: ContourPoint[][]): number =>
      lines.flat().reduce((s, p) => s + p.lon, 0) / lines.flat().length
    expect(centre(decimated)).toBeCloseTo(centre(direct), 0)
  })

  it('excludes absent texels from the average rather than averaging them in', () => {
    // Rule 1 in decimation's clothing. A box of three present texels and
    // one absent must report the mean of the three; folding the absent
    // one in as a zero manufactures a gradient down the edge of every
    // echo — smooth, plausible, and not in the data.
    //
    // The boundary sits at an *odd* column on purpose, so it falls
    // inside a box rather than between two. A boundary on a box edge
    // never mixes present and absent in the same average and the bug
    // would sail straight through — which is exactly what an earlier
    // version of this test did.
    const width = 4096
    const height = 2048
    const frame = snap(width, height, x => (x < width / 2 + 1 ? 200 : 0))
    // A level below the plateau: the only way to cross it is if some
    // texel came back lower than 200, which only averaging-in can do.
    const lines = extractContours(frame, SCALE, 150, GLOBAL)
    expect(lines).toEqual([])
  })

  it('keeps a mostly-absent box absent instead of reporting its minority', () => {
    // The left half is solid 50 — present, and below the level. The
    // right half has one present texel per 2x2 box and is otherwise
    // absent, so every box there is a quarter full.
    //
    // The left half is load-bearing. A frame that is *only* speckle
    // cannot detect this bug: promote every quarter-full box to 200 and
    // the field comes out uniformly high, which traces exactly as
    // nothing as a uniformly absent one does. Against a present
    // neighbour below the level, a promotion puts a crossing at the seam.
    const width = 4096
    const height = 2048
    const frame = snap(width, height, (x, y) =>
      (x < width / 2 ? 50 : (x % 2 === 0 && y % 2 === 0 ? 200 : 0)))
    expect(extractContours(frame, SCALE, 100, GLOBAL)).toEqual([])
  })

  it('does not let data outside the window into an edge box', () => {
    // A window edge rarely lands on a box boundary. If the box
    // straddling it averages the texels the caller excluded, values from
    // outside the picked region move an isoline inside it — and the
    // statistics beside it, which reduce exactly the window, would
    // disagree with the drawn line for no visible reason.
    //
    // Everything inside the window is 50, everything outside is 250, and
    // the edge is odd so the boundary box straddles it.
    const width = 4096
    const height = 2048
    const edge = 1001
    const frame = snap(width, height, x => (x < edge ? 50 : 250))
    const lines = extractContours(frame, DENSE, 100, GLOBAL,
      { x0: 0, y0: 0, x1: edge, y1: height })
    expect(lines).toEqual([])
  })

  it('scales the window with the stride', () => {
    // A window is in the caller's coordinates. Applied unscaled to a
    // decimated frame it would address the wrong region entirely.
    //
    // The blob sits in the *right* half deliberately. Put it on the left
    // and neither assertion discriminates: an unscaled right-half window
    // clamps to an empty range and an unscaled left-half window clamps
    // to the whole frame, so both agree with the correct answer by
    // accident. On the right, both disagree.
    const width = 4096
    const height = 2048
    const frame = snap(width, height, (x, y) => {
      const d = Math.hypot(x - (7 * width) / 8, y - height / 2) / (height / 8)
      return d >= 1 ? 20 : 20 + Math.round((1 - d) * 200)
    })
    const right = extractContours(frame, DENSE, 120, GLOBAL,
      { x0: width / 2, y0: 0, x1: width, y1: height })
    expect(right.length).toBeGreaterThan(0)
    const left = extractContours(frame, DENSE, 120, GLOBAL,
      { x0: 0, y0: 0, x1: width / 2, y1: height })
    expect(left).toEqual([])
  })

  it('rests on absence being a low band, which the sidecar guarantees', () => {
    // `downsample` decides presence with `code >= absentBelow`, which is
    // only sound if every absent code sits below every present one.
    //
    // That holds for *every* expressible scale, because
    // `isTransparentLuma` is "below a cutoff" in both its forms —
    // `luma < dataMinLuma` and `luma / 255 < transparentRange`. So the
    // `absentIsLowBand` guard in `extractContourSet` cannot currently
    // fire, and an earlier version of this test that tried to trigger it
    // was really constructing a scale with no absent codes at all and
    // asserting nothing.
    //
    // Pinned rather than trusted: the day a sentinel in the middle of
    // the range means "no data", decimation would average across the gap
    // and invent values that were never measured. This is the test that
    // should fail first, and it names the file to go and look at.
    const scales: ColorScale[] = [
      SCALE,
      DENSE,
      { ...SCALE, dataMinLuma: 40 },
      { ...SCALE, transparentRange: 0.5 },
    ]
    for (const scale of scales) {
      let seenPresent = false
      for (let luma = 0; luma < 256; luma++) {
        if (isTransparentLuma(luma, scale)) {
          expect(seenPresent, `luma ${luma} is absent above a present code`).toBe(false)
        } else {
          seenPresent = true
        }
      }
    }
  })
})

describe('the minimum-ring filter', () => {
  it('drops a ring far smaller than the stroke that would draw it', () => {
    // Four texels square, so it survives decimation as a 2x2 block and
    // the *filter* is what removes it. A single texel would be averaged
    // away by the downsample and the test would pass with the filter
    // disabled — it did, before this comment existed.
    const frame = snap(4096, 2048, (x, y) =>
      (x >= 1000 && x < 1004 && y >= 500 && y < 504 ? 250 : 20))
    expect(extractContours(frame, DENSE, 120, GLOBAL)).toEqual([])
  })

  it('keeps a long thin filament, which a perimeter rule would not', () => {
    // Two texels tall and most of the frame wide. Small in area, small
    // in one axis, and a real feature — the case that makes the rule
    // "extent in the longer axis" rather than "enough points".
    const frame = snap(4096, 2048, (x, y) =>
      (y >= 500 && y < 502 && x > 100 && x < 3900 ? 250 : 20))
    const lines = extractContours(frame, DENSE, 120, GLOBAL)
    expect(lines.length).toBeGreaterThan(0)
    expect(vertexCount(lines)).toBeGreaterThan(0)
  })

  it('leaves small frames alone, where a fixed point count would empty them', () => {
    // The threshold is a fraction of the frame, so an 8x8 fixture keeps
    // the tiny rings that are its entire content. A point-count rule
    // tuned for 7200x3600 would silently delete every test above.
    const frame = snap(8, 8, (x, y) => (x >= 3 && x <= 4 && y >= 3 && y <= 4 ? 200 : 20))
    expect(extractContours(frame, DENSE, 100, GLOBAL).length).toBeGreaterThan(0)
  })
})

describe('contourSetToGeoJson', () => {
  it('carries value and colour per level so the map can paint each line', () => {
    const fc = contourSetToGeoJson([
      { value: 10, color: '#112233', lines: [[{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]] },
      { value: 20, color: '#445566', lines: [[{ lat: 5, lon: 6 }, { lat: 7, lon: 8 }]] },
    ])
    expect(fc.features).toHaveLength(2)
    expect(fc.features[0].properties).toEqual({ value: 10, color: '#112233' })
    expect(fc.features[1].geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [[[6, 5], [8, 7]]],
    })
  })

  it('omits a level that traced nothing', () => {
    // An empty MultiLineString is a feature MapLibre carries and can
    // never draw.
    const fc = contourSetToGeoJson([
      { value: 10, lines: [] },
      { value: 20, lines: [[{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }]] },
    ])
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0].properties?.value).toBe(20)
  })

  it('falls back to a visible colour when the caller set none', () => {
    const fc = contourSetToGeoJson([
      { value: 1, lines: [[{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }]] },
    ])
    expect(fc.features[0].properties?.color).toBe('#ffd166')
  })
})
