// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Chart pieces for the Analyze panel.
 *
 * Hand-rolled SVG, following the precedent in
 * `src/ui/publisher/analytics-charts.ts` rather than importing it: that
 * module is publisher-portal-scoped and its bar series is a categorical
 * chart with a Y-axis gutter, where this is a 256-bin distribution
 * whose bars are coloured by their own value. Sharing the file would
 * couple the public SPA bundle to the portal's chrome for one helper.
 *
 * See `docs/DATA_ANALYSIS_PLAN.md` §A3.
 */

import {
  LUMA_LEVELS,
  type LumaHistogram,
  type TransectSample,
  type ZonalSample,
} from '../services/datasetStats'
import { buildDisplayLut, type ColorScaleDisplay } from '../services/colorScaleDisplay'
import type { ColorScale } from '../types/color-scale'
import { t } from '../i18n'
import { formatNumber } from '../i18n/format'

/** Matches `formatProbeReading` and the colorbar — the measured error
 *  budget is ~0.4% of full scale, so a fourth digit is encoder noise
 *  presented as precision. */
const SIGNIFICANT_DIGITS = 3

const VIEWBOX_W = 256
const VIEWBOX_H = 64

/**
 * How many luma codes each bar covers.
 *
 * Four, because the transport moves a sample by at most one code (see
 * `renderHistogram`), so a four-code bar keeps that redistribution
 * inside the bar. Measured on a real published frame, bar-to-bar ripple
 * falls from 0.66 at one code per bar to 0.10 at four, against 0.066 for
 * the same field read losslessly — i.e. what is left is the field's own
 * raggedness, not the lattice.
 */
export const HISTOGRAM_BUCKET = 4

/** Bars drawn. 64 at the shipped bucket width. */
export const HISTOGRAM_BARS = LUMA_LEVELS / HISTOGRAM_BUCKET

/** The value width of one bar, for the caption beside the chart. */
export function histogramBucketValueWidth(scale: ColorScale): number {
  return (Math.abs(scale.vmax - scale.vmin) / (LUMA_LEVELS - 1)) * HISTOGRAM_BUCKET
}

export function formatStatValue(value: number, units?: string): string {
  if (!Number.isFinite(value)) return t('analyze.stat.none')
  const text = formatNumber(value, { maximumSignificantDigits: SIGNIFICANT_DIGITS })
  return units ? t('probe.value', { value: text, units }) : text
}

/**
 * The distribution, each bar painted the colour the globe paints those
 * values.
 *
 * The model behind this chart is still the exact 256-bin one — the bins
 * *are* the source codes, and that is what the statistics and the CSV
 * export are computed from. The chart aggregates
 * `HISTOGRAM_BUCKET` codes per bar, and that is a display decision with
 * a specific cause.
 *
 * **The transport cannot deliver 256 populated codes.** `ffmpeg-hls.ts`
 * ships the data path untagged, so the encoder contracts luma to the
 * limited range (16..235, 219 levels) and both decoders expand it back;
 * the two cancel in *value* but not in *occupancy*. Measured on a real
 * published frame: the source PNG leaves 1 code of 244 empty, and the
 * same field through that round trip leaves 35 — about 34 codes emptied,
 * spaced roughly every 7. Drawn one bar per code that reads as a comb,
 * and it is the lattice of the transport rather than anything in the
 * data. The round trip moves any given sample by at most one code, so
 * aggregating a few codes per bar recovers the true shape almost
 * exactly; see `HISTOGRAM_BUCKET` for the measurements behind the width.
 *
 * A bar is therefore ~1.6% of full scale, against a measured error
 * budget of ~0.4% — coarser than the noise floor, finer than anything a
 * reader would draw a conclusion from, and the per-value precision is
 * stated separately beside the statistics.
 *
 * Colouring each bar from the same LUT the shader samples is what makes
 * the chart legible without a legend: the shape and the globe are
 * visibly the same field.
 *
 * Bars are square-rooted before scaling. These fields are extremely
 * skewed — most of a smoke frame sits within a few codes of the bottom
 * — and a linear height scale renders every interesting bin as a
 * sub-pixel sliver next to one full-height spike. The axis is therefore
 * deliberately not labelled with counts: it shows shape, not magnitude,
 * and the numbers that matter are in the stat tiles beside it.
 */
export function renderHistogram(
  hist: LumaHistogram,
  scale: ColorScale,
  display: ColorScaleDisplay,
): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${VIEWBOX_W} ${VIEWBOX_H}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', 'analyze-histogram')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', t('analyze.histogram.aria'))

  const lut = buildDisplayLut(scale, display)
  const bars = new Float64Array(HISTOGRAM_BARS)
  for (let i = 0; i < LUMA_LEVELS; i++) {
    bars[Math.floor(i / HISTOGRAM_BUCKET)] += hist.weights[i]
  }
  let peak = 0
  for (let i = 0; i < HISTOGRAM_BARS; i++) {
    if (bars[i] > peak) peak = bars[i]
  }
  if (peak <= 0) return svg

  const root = Math.sqrt(peak)
  // Colour comes from the middle of the bar's code range, so a bar
  // reads as the colour the globe paints the values it covers rather
  // than as the colour of its lowest edge.
  const centre = (HISTOGRAM_BUCKET - 1) / 2
  for (let i = 0; i < HISTOGRAM_BARS; i++) {
    const w = bars[i]
    if (w <= 0) continue
    const h = (Math.sqrt(w) / root) * VIEWBOX_H
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bar.setAttribute('x', String(i * HISTOGRAM_BUCKET))
    bar.setAttribute('y', String(VIEWBOX_H - h))
    bar.setAttribute('width', String(HISTOGRAM_BUCKET))
    bar.setAttribute('height', String(h))
    const o = Math.round(i * HISTOGRAM_BUCKET + centre) * 4
    // Alpha is deliberately dropped: a bar the globe draws faintly is
    // still a real part of the distribution, and fading it here would
    // hide exactly the low-value bins these fields live in.
    bar.setAttribute('fill', `rgb(${lut[o]}, ${lut[o + 1]}, ${lut[o + 2]})`)
    svg.appendChild(bar)
  }
  return svg
}

const TRANSECT_W = 256
const TRANSECT_H = 72
/** Height of the colour strip along the bottom, in viewBox units. */
const RIBBON_H = 8
/** Gap between the profile and the strip. */
const RIBBON_GAP = 2
const PLOT_H = TRANSECT_H - RIBBON_H - RIBBON_GAP

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * The field along a line: value against distance.
 *
 * **Deliberately not an area chart.** The vertical axis is scaled to
 * this transect's own range rather than to `[vmin, vmax]` — these
 * fields are skewed enough that a full-range axis flattens every
 * profile into a line along the bottom — and filling under a curve
 * whose baseline is not zero draws an area that encodes nothing. So the
 * profile is a stroke, and the caption says the axis is relative.
 *
 * Two coloured elements, both from the same display LUT the shader
 * samples. The profile is stroked per segment, so its colour and its
 * height say the same thing twice, which is what makes it readable
 * against the globe. Below it runs a strip of the same colours without
 * the height — a one-dimensional slice of what the transect crosses,
 * which is the thing a viewer can compare directly against the line
 * they drew.
 *
 * Gaps stay gaps. `sampleTransect` returns null where the line leaves
 * the dataset or crosses absent data, and both the stroke and the strip
 * break there rather than interpolating across — a profile drawn
 * straight through a hole is a measurement claim nobody made.
 */
export function renderTransectChart(
  samples: readonly TransectSample[],
  scale: ColorScale,
  display: ColorScaleDisplay,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${TRANSECT_W} ${TRANSECT_H}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', 'analyze-transect')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', t('analyze.transect.aria'))
  if (samples.length < 2) return svg

  const span = transectValueSpan(samples)
  if (!span) return svg

  const lut = buildDisplayLut(scale, display)
  const total = samples[samples.length - 1].distanceKm
  const xAt = (i: number): number =>
    total > 0 ? (samples[i].distanceKm / total) * TRANSECT_W : (i / (samples.length - 1)) * TRANSECT_W
  const yAt = (v: number): number => PLOT_H - ((v - span.lo) / (span.hi - span.lo)) * PLOT_H
  const colourAt = (v: number): string => {
    const o = lumaIndexFor(v, scale) * 4
    // Alpha dropped, as in the histogram: a value the globe draws
    // faintly is still on the line, and fading it here would read as
    // the gap that a genuinely absent sample gets.
    return `rgb(${lut[o]}, ${lut[o + 1]}, ${lut[o + 2]})`
  }

  const strip = document.createElementNS(SVG_NS, 'g')
  strip.setAttribute('class', 'analyze-transect-strip')
  // The cells abut exactly, so anti-aliasing puts a pale seam between
  // every pair and the strip reads as striped rather than continuous —
  // at 512 samples in a 256-unit viewBox that is a lot of seams.
  // Snapping their edges is the same intent as the histogram's
  // `image-rendering: pixelated`: this is a picture of the line, not a
  // set of shapes.
  strip.setAttribute('shape-rendering', 'crispEdges')
  const half = TRANSECT_W / (samples.length - 1) / 2
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i].value
    if (v == null) continue
    const x = xAt(i)
    const x0 = Math.max(0, x - half)
    const x1 = Math.min(TRANSECT_W, x + half)
    const cell = document.createElementNS(SVG_NS, 'rect')
    cell.setAttribute('x', x0.toFixed(3))
    cell.setAttribute('y', String(TRANSECT_H - RIBBON_H))
    cell.setAttribute('width', Math.max(0, x1 - x0).toFixed(3))
    cell.setAttribute('height', String(RIBBON_H))
    cell.setAttribute('fill', colourAt(v))
    strip.appendChild(cell)
  }
  svg.appendChild(strip)

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].value
    const b = samples[i].value
    if (a == null || b == null) continue
    const seg = document.createElementNS(SVG_NS, 'line')
    seg.setAttribute('x1', xAt(i - 1).toFixed(3))
    seg.setAttribute('y1', yAt(a).toFixed(3))
    seg.setAttribute('x2', xAt(i).toFixed(3))
    seg.setAttribute('y2', yAt(b).toFixed(3))
    seg.setAttribute('stroke', colourAt((a + b) / 2))
    seg.setAttribute('stroke-width', '2')
    seg.setAttribute('vector-effect', 'non-scaling-stroke')
    seg.setAttribute('stroke-linecap', 'round')
    svg.appendChild(seg)
  }
  return svg
}

const ZONAL_W = 256
const ZONAL_H = 148
/** Gutter on the value axis, so the strip and the profile sit side by
 *  side rather than the strip underneath as in the transect. */
const ZONAL_STRIP_W = 8
const ZONAL_PLOT_W = ZONAL_W - ZONAL_STRIP_W - RIBBON_GAP

/**
 * The zonal-mean profile: the field's shape against latitude.
 *
 * **Latitude runs down the vertical axis**, which is the one real
 * difference from `renderTransectChart` and is not a stylistic choice.
 * Latitude is spatially vertical, so a profile drawn this way lines up
 * with the globe beside it — a bulge at 60°N sits where 60°N is. Laid
 * out the other way it would be a chart the reader has to mentally
 * rotate before it means anything, which for the one summary whose
 * whole subject is *latitude* defeats the point.
 *
 * Scaled to the profile's own value range rather than the dataset's, as
 * the transect is. Averaging a row flattens extremes hard — a zonal mean
 * of a smoke field occupies a small fraction of the full scale — so
 * drawing it against `vmin..vmax` would render every real field as a
 * straight line hugging the axis.
 *
 * Gaps stay gaps, for the reason they do everywhere else here: a row
 * with no data is `mean: null`, and both the stroke and the strip break
 * rather than interpolating a value across latitudes nothing was
 * measured at.
 *
 * Not filled, same as the transect. The baseline is the profile's own
 * minimum rather than zero, so an area under the curve would shade a
 * quantity that is not a quantity.
 */
export function renderZonalChart(
  samples: readonly ZonalSample[],
  scale: ColorScale,
  display: ColorScaleDisplay,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${ZONAL_W} ${ZONAL_H}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', 'analyze-zonal')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', t('analyze.zonal.aria'))
  if (samples.length < 2) return svg

  const span = zonalValueSpan(samples)
  if (!span) return svg

  const lut = buildDisplayLut(scale, display)
  // Latitude descends the axis — north at the top, as on the globe and
  // on every map the reader has seen.
  //
  // The extremes come from *every* sample rather than from the first and
  // last. Taking the ends looks equivalent, because `zonalMeans` returns
  // image-row order, but a Y-flipped dataset (`isFlippedInY`, which the
  // publisher form exposes) has row 0 at the south edge. Ends-based
  // extremes make `latSpan` negative there, the sign cancels in the
  // division, and the profile draws in array order — which is to say
  // upside down, on exactly the datasets whose orientation is the
  // unusual one.
  let north = -Infinity
  let south = Infinity
  for (const s of samples) {
    if (s.lat > north) north = s.lat
    if (s.lat < south) south = s.lat
  }
  const latSpan = north - south
  const yAt = (i: number): number =>
    latSpan > 0
      ? ((north - samples[i].lat) / latSpan) * ZONAL_H
      : (i / (samples.length - 1)) * ZONAL_H
  const xAt = (v: number): number =>
    ZONAL_STRIP_W + RIBBON_GAP + ((v - span.lo) / (span.hi - span.lo)) * ZONAL_PLOT_W
  const colourAt = (v: number): string => {
    const o = lumaIndexFor(v, scale) * 4
    return `rgb(${lut[o]}, ${lut[o + 1]}, ${lut[o + 2]})`
  }

  const strip = document.createElementNS(SVG_NS, 'g')
  strip.setAttribute('class', 'analyze-zonal-strip')
  strip.setAttribute('shape-rendering', 'crispEdges')
  // Each cell runs from the midpoint to the row above it to the midpoint
  // to the row below, so the strip is positioned by latitude exactly as
  // the profile is. A constant height derived from the sample *count*
  // would be the index-spaced answer next to a latitude-spaced line —
  // the two disagreeing wherever the rows are not evenly spaced, which
  // is the case this chart already goes out of its way to draw
  // correctly. The ends extend by half their one neighbouring gap.
  const ys = samples.map((_, i) => yAt(i))
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i].mean
    if (v == null) continue
    const y = ys[i]
    const before = i > 0 ? (ys[i - 1] + y) / 2 : y - Math.abs(ys[1] - ys[0]) / 2
    const after = i < ys.length - 1
      ? (y + ys[i + 1]) / 2
      : y + Math.abs(ys[i] - ys[i - 1]) / 2
    const y0 = Math.max(0, Math.min(before, after))
    const y1 = Math.min(ZONAL_H, Math.max(before, after))
    const cell = document.createElementNS(SVG_NS, 'rect')
    cell.setAttribute('x', '0')
    cell.setAttribute('y', y0.toFixed(3))
    cell.setAttribute('width', String(ZONAL_STRIP_W))
    cell.setAttribute('height', Math.max(0, y1 - y0).toFixed(3))
    cell.setAttribute('fill', colourAt(v))
    strip.appendChild(cell)
  }
  svg.appendChild(strip)

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].mean
    const b = samples[i].mean
    if (a == null || b == null) continue
    const seg = document.createElementNS(SVG_NS, 'line')
    seg.setAttribute('x1', xAt(a).toFixed(3))
    seg.setAttribute('y1', yAt(i - 1).toFixed(3))
    seg.setAttribute('x2', xAt(b).toFixed(3))
    seg.setAttribute('y2', yAt(i).toFixed(3))
    seg.setAttribute('stroke', colourAt((a + b) / 2))
    seg.setAttribute('stroke-width', '2')
    seg.setAttribute('vector-effect', 'non-scaling-stroke')
    seg.setAttribute('stroke-linecap', 'round')
    svg.appendChild(seg)
  }
  return svg
}

/** The value range the zonal profile is drawn against. Same flat-field
 *  guard as `transectValueSpan`, which a single-row window hits. */
export function zonalValueSpan(
  samples: readonly ZonalSample[],
): { lo: number; hi: number } | null {
  let lo = Infinity
  let hi = -Infinity
  for (const s of samples) {
    if (s.mean == null) continue
    if (s.mean < lo) lo = s.mean
    if (s.mean > hi) hi = s.mean
  }
  if (!Number.isFinite(lo)) return null
  if (hi === lo) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.5 : 1
    return { lo: lo - pad, hi: hi + pad }
  }
  return { lo, hi }
}

/**
 * The vertical range the profile is drawn against.
 *
 * A flat transect — every sample the same value, which happens on a
 * short line inside one texel — has no range to scale to. Give it a
 * band so the line lands mid-height instead of dividing by zero.
 */
export function transectValueSpan(
  samples: readonly TransectSample[],
): { lo: number; hi: number } | null {
  let lo = Infinity
  let hi = -Infinity
  for (const s of samples) {
    if (s.value == null) continue
    if (s.value < lo) lo = s.value
    if (s.value > hi) hi = s.value
  }
  if (!Number.isFinite(lo)) return null
  if (hi === lo) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.5 : 1
    return { lo: lo - pad, hi: hi + pad }
  }
  return { lo, hi }
}

/** Which LUT entry the globe would sample for this value. Inverse of
 *  `lumaToValue`, clamped, so a value at either end of the scale still
 *  lands inside the table. */
function lumaIndexFor(value: number, scale: ColorScale): number {
  const range = scale.vmax - scale.vmin
  const t = range === 0 ? 0 : (value - scale.vmin) / range
  return Math.max(0, Math.min(LUMA_LEVELS - 1, Math.round(t * (LUMA_LEVELS - 1))))
}

/** A labelled number. Mirrors the portal's `renderStatTile` shape so the
 *  two surfaces read alike, without importing across the boundary. */
export function renderStatTile(label: string, value: string): HTMLElement {
  const tile = document.createElement('div')
  tile.className = 'analyze-stat'
  const l = document.createElement('span')
  l.className = 'analyze-stat-label'
  l.textContent = label
  const v = document.createElement('span')
  v.className = 'analyze-stat-value'
  v.textContent = value
  tile.append(l, v)
  return tile
}
