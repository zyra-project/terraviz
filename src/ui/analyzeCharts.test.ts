// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the Analyze panel's chart pieces.
 *
 * The one behaviour worth pinning here is the histogram's bar width.
 * The data path ships untagged (`cli/lib/ffmpeg-hls.ts`), so luma is
 * contracted to the limited range on encode and expanded back on
 * decode; the two cancel in value but leave roughly every seventh code
 * unreachable. Drawn one bar per code that lattice reads as a comb.
 * These tests assert the aggregation actually removes it, and that
 * doing so does not lose or move any weight.
 */
import { describe, expect, it } from 'vitest'
import {
  HISTOGRAM_BARS,
  HISTOGRAM_BUCKET,
  histogramBucketValueWidth,
  renderHistogram,
  renderTransectChart,
  renderZonalChart,
  transectValueSpan,
  zonalValueSpan,
} from './analyzeCharts'
import {
  LUMA_LEVELS,
  type LumaHistogram,
  type TransectSample,
  type ZonalSample,
} from '../services/datasetStats'
import { DEFAULT_DISPLAY } from '../services/colorScaleDisplay'
import type { ColorScale } from '../types'

const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [255, 255, 229, 0] },
    { t: 1, rgba: [102, 37, 6, 255] },
  ],
  vmin: 0,
  vmax: 5.1,
  units: 'mg m-2',
  transparentRange: 12 / 256,
}

function histogram(weights: number[]): LumaHistogram {
  const w = Float64Array.from(weights)
  const total = weights.reduce((a, b) => a + b, 0)
  return {
    weights: w,
    counts: new Uint32Array(LUMA_LEVELS),
    totalWeight: total,
    dataCount: 0,
    examined: LUMA_LEVELS,
  }
}

/** A smooth decay, the shape these skewed fields actually have. */
function smoothField(): number[] {
  return Array.from({ length: LUMA_LEVELS }, (_, i) =>
    i < 12 ? 0 : 1_000_000 * Math.exp(-(i - 12) / 40),
  )
}

/**
 * The same field after the limited-range round trip: contract to
 * 16..235, expand back. Weight lands on the reachable codes only.
 */
function throughTransport(source: number[]): number[] {
  const out = new Array<number>(LUMA_LEVELS).fill(0)
  for (let i = 0; i < LUMA_LEVELS; i++) {
    const contracted = Math.round((i * 219) / 255 + 16)
    const expanded = Math.max(0, Math.min(255, Math.round(((contracted - 16) * 255) / 219)))
    out[expanded] += source[i]
  }
  return out
}

/** Heights indexed by bar, so an empty bar reads as 0 rather than
 *  shifting its neighbours along. */
function barHeights(svg: SVGSVGElement): number[] {
  const h = new Array<number>(HISTOGRAM_BARS).fill(0)
  for (const r of svg.querySelectorAll('rect')) {
    h[Number(r.getAttribute('x')) / HISTOGRAM_BUCKET] = Number(r.getAttribute('height'))
  }
  return h
}

/**
 * Mean bar-to-bar ripple: how far each bar sits from the mean of its
 * neighbours, relative to that mean. This is what the eye reads as a
 * comb. The *mean* rather than the worst, because the worst bar is
 * always the leading edge next to the nodata band — real structure, and
 * present losslessly too.
 */
function meanRipple(h: number[]): number {
  let sum = 0
  let n = 0
  for (let i = 1; i < h.length - 1; i++) {
    const local = (h[i - 1] + h[i + 1]) / 2
    if (local <= 0) continue
    sum += Math.abs(h[i] - local) / local
    n++
  }
  return n ? sum / n : 0
}

/** What the chart would look like drawn one bar per luma code. */
function unbucketedHeights(weights: number[]): number[] {
  const peak = Math.max(...weights)
  return weights.map((w) => (Math.sqrt(w) / Math.sqrt(peak)) * 64)
}

describe('renderHistogram', () => {
  it('draws one bar per bucket of luma codes, spanning the full axis', () => {
    const svg = renderHistogram(histogram(smoothField()), SCALE, DEFAULT_DISPLAY)
    const rects = [...svg.querySelectorAll('rect')]
    expect(rects.length).toBeLessThanOrEqual(HISTOGRAM_BARS)
    for (const r of rects) {
      expect(Number(r.getAttribute('width'))).toBe(HISTOGRAM_BUCKET)
      expect(Number(r.getAttribute('x')) % HISTOGRAM_BUCKET).toBe(0)
    }
    const last = rects[rects.length - 1]
    expect(Number(last.getAttribute('x')) + HISTOGRAM_BUCKET).toBeLessThanOrEqual(LUMA_LEVELS)
  })

  it('reads the same through the transport as it does losslessly', () => {
    const source = smoothField()
    const lossless = barHeights(renderHistogram(histogram(source), SCALE, DEFAULT_DISPLAY))
    const transported = barHeights(
      renderHistogram(histogram(throughTransport(source)), SCALE, DEFAULT_DISPLAY),
    )
    // The round trip moves a sample by at most one code, so a bar wider
    // than that keeps nearly all of the redistribution internal.
    let sum = 0
    let n = 0
    for (let i = 0; i < lossless.length; i++) {
      if (lossless[i] < 1) continue
      sum += Math.abs(transported[i] - lossless[i]) / lossless[i]
      n++
    }
    expect(n).toBeGreaterThan(20)
    expect(sum / n).toBeLessThan(0.06)
  })

  it('does not draw the transport lattice as a comb', () => {
    const transported = throughTransport(smoothField())
    const drawn = meanRipple(
      barHeights(renderHistogram(histogram(transported), SCALE, DEFAULT_DISPLAY)),
    )
    const oneBarPerCode = meanRipple(unbucketedHeights(transported))
    // Measured on a real published frame: 0.66 at one code per bar
    // against 0.10 at this bucket width. This synthetic field lands in
    // the same place (0.57 → 0.10), so the ratio is the assertion and
    // the absolute value is a guard against the ratio being met by a
    // chart that is merely noisy at both widths.
    expect(oneBarPerCode / drawn).toBeGreaterThan(4)
    expect(drawn).toBeLessThan(0.15)
  })

  it('empties the chart rather than dividing by zero when nothing carries data', () => {
    const svg = renderHistogram(histogram(new Array(LUMA_LEVELS).fill(0)), SCALE, DEFAULT_DISPLAY)
    expect(svg.querySelectorAll('rect')).toHaveLength(0)
  })
})

describe('renderTransectChart', () => {
  const line = (values: (number | null)[]): TransectSample[] =>
    values.map((value, i) => ({
      lat: 40,
      lon: -120 + i,
      distanceKm: i * 100,
      value,
    }))

  it('breaks the profile at a gap instead of drawing through it', () => {
    const svg = renderTransectChart(line([1, 2, null, 4, 5]), SCALE, DEFAULT_DISPLAY)
    // Four adjacent pairs, but the two touching the gap must not be
    // stroked — a profile drawn straight across a hole is a measurement
    // claim nobody made.
    expect(svg.querySelectorAll('line')).toHaveLength(2)
    // Same for the colour strip: one cell per sample that has data.
    expect(svg.querySelectorAll('rect')).toHaveLength(4)
  })

  it('scales the profile to its own range, not to the palette range', () => {
    // Values occupy a thousandth of the scale. Drawn against [vmin,
    // vmax] every point would land within a hair of the baseline.
    const svg = renderTransectChart(
      line([0.001, 0.002, 0.003, 0.004]), SCALE, DEFAULT_DISPLAY)
    const ys = [...svg.querySelectorAll('line')].flatMap((l) => [
      Number(l.getAttribute('y1')),
      Number(l.getAttribute('y2')),
    ])
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(40)
  })

  it('draws nothing rather than dividing by zero on an empty or absent line', () => {
    expect(renderTransectChart([], SCALE, DEFAULT_DISPLAY).querySelectorAll('*')).toHaveLength(0)
    expect(
      renderTransectChart(line([null, null, null]), SCALE, DEFAULT_DISPLAY)
        .querySelectorAll('line'),
    ).toHaveLength(0)
  })

  it('keeps a flat line on screen instead of collapsing it', () => {
    const svg = renderTransectChart(line([2, 2, 2, 2]), SCALE, DEFAULT_DISPLAY)
    const ys = [...svg.querySelectorAll('line')].map((l) => Number(l.getAttribute('y1')))
    expect(ys).toHaveLength(3)
    for (const y of ys) {
      expect(y).toBeGreaterThan(0)
      expect(y).toBeLessThan(62)
    }
  })
})

describe('renderZonalChart', () => {
  /** North to south, as `zonalMeans` returns them. */
  const profile = (means: (number | null)[]): ZonalSample[] =>
    means.map((mean, i) => ({
      lat: 60 - i * 10,
      mean,
      count: mean == null ? 0 : 100,
    }))

  it('runs latitude down the vertical axis, north at the top', () => {
    // The whole reason this chart is not the transect chart. The
    // northernmost sample must sit above the southernmost, so the
    // profile lines up with the globe beside it.
    const svg = renderZonalChart(profile([1, 2, 3, 4]), SCALE, DEFAULT_DISPLAY)
    const segs = [...svg.querySelectorAll('line')]
    expect(segs).toHaveLength(3)
    const firstY = Number(segs[0].getAttribute('y1'))
    const lastY = Number(segs[segs.length - 1].getAttribute('y2'))
    expect(firstY).toBeLessThan(lastY)
  })

  it('places a row by its latitude rather than by its index', () => {
    // A profile whose rows are unevenly spaced in latitude — which a
    // scoped window produces — must not be drawn as though they were
    // even, or the shape is stretched where the data is not.
    const uneven: ZonalSample[] = [
      { lat: 60, mean: 1, count: 10 },
      { lat: 50, mean: 2, count: 10 },
      { lat: 0, mean: 3, count: 10 },
    ]
    const svg = renderZonalChart(uneven, SCALE, DEFAULT_DISPLAY)
    const segs = [...svg.querySelectorAll('line')]
    const drop1 = Number(segs[0].getAttribute('y2')) - Number(segs[0].getAttribute('y1'))
    const drop2 = Number(segs[1].getAttribute('y2')) - Number(segs[1].getAttribute('y1'))
    // 10° then 50°, so the second segment must span far more height.
    expect(drop2).toBeGreaterThan(drop1 * 4)
  })

  it('keeps north at the top for a south-up dataset', () => {
    // `isFlippedInY` is publisher-settable, and for such a dataset
    // `zonalMeans` returns row 0 at the *south* edge. Deriving the
    // extremes from the first and last samples makes the span negative,
    // the sign cancels in the division, and the profile draws in array
    // order — upside down, on exactly the datasets whose orientation is
    // already the unusual one.
    const southUp: ZonalSample[] = [
      { lat: -60, mean: 1, count: 10 },
      { lat: -20, mean: 2, count: 10 },
      { lat: 20, mean: 3, count: 10 },
      { lat: 60, mean: 4, count: 10 },
    ]
    const svg = renderZonalChart(southUp, SCALE, DEFAULT_DISPLAY)
    const segs = [...svg.querySelectorAll('line')]
    expect(segs).toHaveLength(3)
    // First sample is the southernmost, so it must sit at the BOTTOM.
    expect(Number(segs[0].getAttribute('y1'))).toBeGreaterThan(
      Number(segs[segs.length - 1].getAttribute('y2')),
    )
  })

  it('spaces the colour strip by latitude, not by sample index', () => {
    // The strip and the profile must agree about where a row is. A
    // constant cell height derived from the sample count is the
    // index-spaced answer beside a latitude-spaced line, and they
    // diverge wherever the rows are uneven.
    const uneven: ZonalSample[] = [
      { lat: 60, mean: 1, count: 10 },
      { lat: 50, mean: 2, count: 10 },
      { lat: 0, mean: 3, count: 10 },
    ]
    const svg = renderZonalChart(uneven, SCALE, DEFAULT_DISPLAY)
    const cells = [...svg.querySelectorAll('rect')]
    expect(cells).toHaveLength(3)
    const h = cells.map(c => Number(c.getAttribute('height')))
    // The 50°→0° gap is five times the 60°→50° one, so the cell covering
    // it must be far taller. Constant heights would make these equal.
    expect(h[2]).toBeGreaterThan(h[0] * 3)
    // And they must tile without overlapping: each cell starts where the
    // previous one ended.
    const y = cells.map(c => Number(c.getAttribute('y')))
    for (let i = 1; i < cells.length; i++) {
      expect(y[i]).toBeCloseTo(y[i - 1] + h[i - 1], 3)
    }
  })

  it('breaks at a latitude band with no data', () => {
    const svg = renderZonalChart(profile([1, 2, null, 4, 5]), SCALE, DEFAULT_DISPLAY)
    expect(svg.querySelectorAll('line')).toHaveLength(2)
    expect(svg.querySelectorAll('rect')).toHaveLength(4)
  })

  it('scales to the profile own range, not to the palette range', () => {
    // Averaging a row flattens extremes, so a zonal mean occupies a
    // sliver of [vmin, vmax]. Drawn against the full scale it would be a
    // straight line against the axis.
    const svg = renderZonalChart(profile([0.001, 0.002, 0.003, 0.004]), SCALE, DEFAULT_DISPLAY)
    const xs = [...svg.querySelectorAll('line')].flatMap((l) => [
      Number(l.getAttribute('x1')),
      Number(l.getAttribute('x2')),
    ])
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(150)
  })

  it('draws nothing rather than dividing by zero on an empty or absent profile', () => {
    expect(renderZonalChart([], SCALE, DEFAULT_DISPLAY).querySelectorAll('*')).toHaveLength(0)
    expect(
      renderZonalChart(profile([null, null, null]), SCALE, DEFAULT_DISPLAY)
        .querySelectorAll('line'),
    ).toHaveLength(0)
  })

  it('keeps a flat profile on screen instead of collapsing it', () => {
    const svg = renderZonalChart(profile([2, 2, 2, 2]), SCALE, DEFAULT_DISPLAY)
    const xs = [...svg.querySelectorAll('line')].map((l) => Number(l.getAttribute('x1')))
    expect(xs).toHaveLength(3)
    for (const x of xs) expect(x).toBeGreaterThan(0)
  })
})

describe('zonalValueSpan', () => {
  it('is null when no latitude band has data', () => {
    expect(zonalValueSpan([])).toBeNull()
    expect(zonalValueSpan([{ lat: 0, mean: null, count: 0 }])).toBeNull()
  })

  it('pads a flat profile so it has a range to draw against', () => {
    const span = zonalValueSpan([
      { lat: 10, mean: 4, count: 1 },
      { lat: 0, mean: 4, count: 1 },
    ])
    expect(span).not.toBeNull()
    expect(span!.lo).toBeLessThan(4)
    expect(span!.hi).toBeGreaterThan(4)
  })
})

describe('transectValueSpan', () => {
  it('is null when nothing on the line has data', () => {
    expect(transectValueSpan([])).toBeNull()
    expect(
      transectValueSpan([{ lat: 0, lon: 0, distanceKm: 0, value: null }]),
    ).toBeNull()
  })

  it('pads a flat line so the range is usable as a divisor', () => {
    const span = transectValueSpan([
      { lat: 0, lon: 0, distanceKm: 0, value: 5 },
      { lat: 0, lon: 1, distanceKm: 1, value: 5 },
    ])!
    expect(span.hi).toBeGreaterThan(span.lo)
    expect((span.lo + span.hi) / 2).toBeCloseTo(5, 9)
  })

  it('pads a flat line at zero, where a proportional pad would not', () => {
    const span = transectValueSpan([
      { lat: 0, lon: 0, distanceKm: 0, value: 0 },
      { lat: 0, lon: 1, distanceKm: 1, value: 0 },
    ])!
    expect(span.hi).toBeGreaterThan(span.lo)
  })
})

describe('histogramBucketValueWidth', () => {
  it('reports a bar as its bucket of luma steps, in the scale units', () => {
    expect(histogramBucketValueWidth(SCALE)).toBeCloseTo((5.1 / 255) * HISTOGRAM_BUCKET, 12)
  })

  it('is positive for an inverted scale', () => {
    expect(histogramBucketValueWidth({ ...SCALE, vmin: 5.1, vmax: 0 })).toBeGreaterThan(0)
  })
})
