// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Statistics over a data-encoded frame.
 *
 * `datasetProbe` answers "what is the number *here*". This answers the
 * questions that need more than one texel: what is the distribution
 * over a region, where is the maximum, what does the field look like
 * along a line, how does it vary with latitude. See
 * `docs/DATA_ANALYSIS_PLAN.md` §A2.
 *
 * Everything here is pure — a `LumaSnapshot` in, numbers out — so the
 * arithmetic that is easiest to get subtly wrong and hardest to notice
 * is testable without a GL context, exactly as `datasetProbe`'s UV
 * mapping is.
 *
 * Three things this module is careful about, each of which produces a
 * plausible-looking wrong answer if skipped:
 *
 *  1. **Area weighting.** Equirectangular rows are not equal-area. The
 *     shipped RRFS rows span 5°N–85°N, where a texel at the top covers
 *     about a ninth of the area of one at the bottom, so an unweighted
 *     mean over that box inflates the Arctic by an order of magnitude
 *     against Mexico. Every aggregate here weights by true spherical
 *     cell area.
 *  2. **No-data exclusion.** `isTransparentLuma` marks absent data.
 *     Counting it as `vmin` would drag every mean toward the bottom of
 *     the scale in exact proportion to how much of the frame is empty —
 *     which for a smoke field is most of it.
 *  3. **Honest resolution.** There are 256 source values and nothing
 *     more. The histogram's bins *are* those values, so it is exact
 *     rather than a binning choice, and percentiles read off it are
 *     exact to within one luma step.
 */

import type { DatasetOverlayOptions } from '../types'
import { isTransparentLuma, lumaToValue, type ColorScale } from '../types/color-scale'
import { latLonToTexelUv, lonSpanDegrees, texelUvToLatLon } from './datasetProbe'
import type { LumaSnapshot } from './glLumaSampler'

/** Mean Earth radius, km — the sphere the rest of the app already
 *  assumes (MapLibre's globe, the VR sphere, the bbox maths). */
const EARTH_RADIUS_KM = 6371.0088

/** The number of distinct values a luma-encoded frame can carry. */
export const LUMA_LEVELS = 256

/** A half-open rectangle of texel indices: `[x0, x1) × [y0, y1)`. */
export interface TexelWindow {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Geographic bounds in the same shape `DatasetOverlayOptions` uses. */
export interface LatLonBounds {
  n: number
  s: number
  w: number
  e: number
}

/**
 * The distribution of one frame over one window.
 *
 * Both a weighted and an unweighted tally are kept. The weighted one
 * answers "how much of the *world* is at this value" and is what every
 * statistic derives from; the unweighted one answers "how many texels
 * did we look at" and is what coverage and sample-count claims must be
 * made from. Reporting a weighted count as a sample size would overstate
 * the evidence near the equator and understate it near the poles.
 */
export interface LumaHistogram {
  /** Spherical cell area, km², of the data-carrying texels at each of
   *  the 256 luma codes. Absent-data codes contribute nothing. */
  weights: Float64Array
  /** Texel counts at each luma code, including absent-data codes. */
  counts: Uint32Array
  /** Summed area of data-carrying texels, km². */
  totalWeight: number
  /** Texels carrying data. */
  dataCount: number
  /** Texels examined, data or not. */
  examined: number
}

export interface RegionStats {
  /** Texels carrying data. */
  count: number
  /** Texels examined, including absent ones. */
  examined: number
  /** `count / examined`, or 0 when nothing was examined. */
  coverage: number
  /** Area of the data-carrying texels, km². */
  areaKm2: number
  min: number
  max: number
  /** Area-weighted. */
  mean: number
  /** Area-weighted, exact to within one luma step. */
  median: number
  p10: number
  p90: number
  /** Area-weighted population standard deviation. */
  stdDev: number
  units?: string
}

export interface TransectSample {
  lat: number
  lon: number
  /** Great-circle distance from the transect's start, km. */
  distanceKm: number
  /** Null where the point falls outside the dataset or on absent data,
   *  so a chart can break the line rather than draw through a gap. */
  value: number | null
}

/** The pair of points a transect runs between. */
export interface TransectEndpoints {
  from: { lat: number; lon: number }
  to: { lat: number; lon: number }
}

export interface ZonalSample {
  /** Latitude at the centre of the image row. */
  lat: number
  /** Area-weighted mean across the row, or null when the whole row is
   *  absent data. Within one row every texel has the same area, so the
   *  weighting is a no-op here — it is stated for the reader who
   *  wonders whether it was forgotten. */
  mean: number | null
  /** Texels in the row carrying data. */
  count: number
}

export interface ExtremumResult {
  lat: number
  lon: number
  value: number
  /** Texel index, for callers that want to re-read or draw it. */
  x: number
  y: number
  /** How many texels in the window share this exact value.
   *
   *  Rarely one. These fields clip at the top of their scale, so "the
   *  maximum" is usually a plateau rather than a point, and the
   *  question "where is it worst" then has many equally correct
   *  answers. A caller that reports one of them as *the* place has to
   *  know that. */
  tieCount: number
  /** Spherical area of those texels, km². */
  tieAreaKm2: number
  /** True when the reported point is the middle of the largest patch
   *  sharing the extreme value, rather than a lone extremum. */
  plateau: boolean
  /** How many separate patches share it. Two fires burning equally
   *  hard in different provinces is a different answer from one broad
   *  smear, and the count is the cheapest way to tell them apart. */
  patchCount: number
}

// --- geometry --------------------------------------------------------

/**
 * The spherical area, km², of a single texel in each image row.
 *
 * Exact rather than the `cos(lat)` approximation: a band between two
 * latitudes has area `R² · Δλ · (sin φ₁ − sin φ₀)`, which is cheap and
 * correct, where `cos(lat) · Δφ · Δλ` is a first-order approximation
 * that degrades exactly where the weighting matters most.
 *
 * Row order follows the snapshot's, so index 0 is the image's top row —
 * which is the *south* edge for a Y-flipped dataset. The absolute value
 * below is what makes the function indifferent to that.
 */
export function rowAreasKm2(
  width: number,
  height: number,
  options?: DatasetOverlayOptions,
): Float64Array {
  const areas = new Float64Array(height)
  if (width <= 0 || height <= 0) return areas

  // Longitude per texel from the dataset's own span, not by
  // differencing two `texelUvToLatLon` samples. Differencing looks
  // tidier and is wrong at the case that matters: u = 0 and u = 1 land
  // on the same meridian once wrapped, so a one-column frame
  // differences to zero and every area collapses silently.
  const dLambda = (lonSpanDegrees(options) / width) * (Math.PI / 180)

  const r2 = EARTH_RADIUS_KM * EARTH_RADIUS_KM
  for (let y = 0; y < height; y++) {
    const top = texelUvToLatLon({ u: 0.5, v: y / height }, options).lat
    const bottom = texelUvToLatLon({ u: 0.5, v: (y + 1) / height }, options).lat
    const band = Math.abs(
      Math.sin(top * (Math.PI / 180)) - Math.sin(bottom * (Math.PI / 180)))
    areas[y] = r2 * dLambda * band
  }
  return areas
}

/** The whole frame as a window. */
export function fullWindow(snapshot: LumaSnapshot): TexelWindow {
  return { x0: 0, y0: 0, x1: snapshot.width, y1: snapshot.height }
}

/**
 * The texel window covering a geographic box, clamped to the frame.
 *
 * Returns null when the box misses the dataset entirely. Corners are
 * mapped through the *forward* direction implied by `texelUvToLatLon`'s
 * inverse — i.e. by walking the frame — rather than by inverting the
 * bbox arithmetic a second time, so there is exactly one place where the
 * V convention lives.
 *
 * The window is a bounding rectangle in texel space, so for a box that
 * crosses the dataset's own longitude seam it degrades to the full
 * width rather than wrapping. That is the conservative direction: it
 * examines more texels than asked, never fewer, and `containsLatLon`
 * filtering is left to callers that need exactness.
 */
export function windowForBounds(
  snapshot: LumaSnapshot,
  bounds: LatLonBounds,
  options?: DatasetOverlayOptions,
): TexelWindow | null {
  const { width, height } = snapshot
  if (width <= 0 || height <= 0) return null

  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity

  // Latitude is monotonic in v, so scanning the rows is enough to bound
  // the vertical extent exactly.
  for (let y = 0; y < height; y++) {
    const lat = texelUvToLatLon({ u: 0.5, v: (y + 0.5) / height }, options).lat
    if (lat <= bounds.n && lat >= bounds.s) {
      if (y < y0) y0 = y
      if (y + 1 > y1) y1 = y + 1
    }
  }
  if (y0 === Infinity) return null

  const crosses = bounds.w > bounds.e
  for (let x = 0; x < width; x++) {
    const lon = texelUvToLatLon({ u: (x + 0.5) / width, v: 0.5 }, options).lon
    const inside = crosses
      ? lon >= bounds.w || lon <= bounds.e
      : lon >= bounds.w && lon <= bounds.e
    if (inside) {
      if (x < x0) x0 = x
      if (x + 1 > x1) x1 = x + 1
    }
  }
  if (x0 === Infinity) return null

  return { x0, y0, x1, y1 }
}

// --- the histogram, and everything derived from it -------------------

/**
 * Tally one window of one frame into 256 area-weighted bins.
 *
 * This is the only function that walks the pixels. Every statistic
 * below reads the histogram instead, which keeps the expensive pass
 * single and makes each statistic trivially checkable against a
 * hand-computed tally.
 */
export function buildHistogram(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  options?: DatasetOverlayOptions,
  window?: TexelWindow,
): LumaHistogram {
  const { data, width, height } = snapshot
  const win = window ?? fullWindow(snapshot)
  const x0 = Math.max(0, Math.floor(win.x0))
  const y0 = Math.max(0, Math.floor(win.y0))
  const x1 = Math.min(width, Math.ceil(win.x1))
  const y1 = Math.min(height, Math.ceil(win.y1))

  const weights = new Float64Array(LUMA_LEVELS)
  const counts = new Uint32Array(LUMA_LEVELS)
  let totalWeight = 0
  let dataCount = 0
  let examined = 0

  if (x1 <= x0 || y1 <= y0) {
    return { weights, counts, totalWeight, dataCount, examined }
  }

  const areas = rowAreasKm2(width, height, options)
  // Absent-data codes are a contiguous band at the bottom of the range,
  // so the threshold is resolved once rather than per texel.
  const firstDataCode = firstDataLuma(scale)

  for (let y = y0; y < y1; y++) {
    const area = areas[y]
    const row = y * width
    for (let x = x0; x < x1; x++) {
      const luma = data[row + x]
      counts[luma]++
      examined++
      if (luma < firstDataCode) continue
      weights[luma] += area
      totalWeight += area
      dataCount++
    }
  }

  return { weights, counts, totalWeight, dataCount, examined }
}

/**
 * The lowest luma code that carries data.
 *
 * Derived from the scale rather than hard-coded so the A0 `dataMinLuma`
 * field, when it lands, has exactly one place to change. Today it is
 * whatever `isTransparentLuma` says, resolved by scanning the 256 codes
 * once — cheaper than calling it per texel, and it keeps this module
 * from re-deriving the transparency rule and drifting from the shader.
 */
function firstDataLuma(scale: ColorScale): number {
  for (let luma = 0; luma < LUMA_LEVELS; luma++) {
    if (!isTransparentLuma(luma, scale)) return luma
  }
  return LUMA_LEVELS
}

/** The area-weighted value at a cumulative-weight fraction, exact to
 *  within one luma step. Returns NaN for an empty histogram. */
export function weightedQuantile(
  hist: LumaHistogram,
  scale: ColorScale,
  fraction: number,
): number {
  if (hist.totalWeight <= 0) return NaN
  const target = hist.totalWeight * Math.min(1, Math.max(0, fraction))
  let seen = 0
  for (let luma = 0; luma < LUMA_LEVELS; luma++) {
    // Empty bins are skipped rather than compared. At fraction 0 the
    // target is 0, which every leading empty bin satisfies — so a
    // naive walk returns `vmin` for the minimum of a field whose
    // lowest value is nowhere near it.
    if (hist.weights[luma] <= 0) continue
    seen += hist.weights[luma]
    if (seen >= target) return lumaToValue(luma, scale)
  }
  return lumaToValue(LUMA_LEVELS - 1, scale)
}

/**
 * Summarise a window.
 *
 * Returns null when the window carries no data at all, rather than a
 * bundle of NaNs — "nothing here" is a real answer and callers should
 * render it as one.
 */
export function summarize(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  options?: DatasetOverlayOptions,
  window?: TexelWindow,
): RegionStats | null {
  const hist = buildHistogram(snapshot, scale, options, window)
  if (hist.dataCount === 0 || hist.totalWeight <= 0) return null

  let min = NaN
  let max = NaN
  let sum = 0
  let sumSq = 0
  for (let luma = 0; luma < LUMA_LEVELS; luma++) {
    const w = hist.weights[luma]
    if (w <= 0) continue
    const value = lumaToValue(luma, scale)
    if (Number.isNaN(min)) min = value
    max = value
    sum += w * value
    sumSq += w * value * value
  }
  const mean = sum / hist.totalWeight
  // Population variance about the weighted mean. Clamped at zero
  // because the two-pass identity can go slightly negative on a
  // near-constant field once floating point is involved.
  const variance = Math.max(0, sumSq / hist.totalWeight - mean * mean)

  return {
    count: hist.dataCount,
    examined: hist.examined,
    coverage: hist.examined > 0 ? hist.dataCount / hist.examined : 0,
    areaKm2: hist.totalWeight,
    min,
    max,
    mean,
    median: weightedQuantile(hist, scale, 0.5),
    p10: weightedQuantile(hist, scale, 0.1),
    p90: weightedQuantile(hist, scale, 0.9),
    stdDev: Math.sqrt(variance),
    units: scale.units,
  }
}

/**
 * The area, km², of texels at or above a physical threshold.
 *
 * The question a newsroom asks — "how much of the country is above the
 * unhealthy line" — and the one number here that survives the encoder's
 * noise well, because a threshold misclassifies only the texels within
 * about one luma step of it rather than biasing every texel.
 */
export function areaAboveKm2(
  hist: LumaHistogram,
  scale: ColorScale,
  threshold: number,
): number {
  let area = 0
  for (let luma = 0; luma < LUMA_LEVELS; luma++) {
    const w = hist.weights[luma]
    if (w > 0 && lumaToValue(luma, scale) >= threshold) area += w
  }
  return area
}

// --- locating things -------------------------------------------------

/**
 * Where the highest (or lowest) value sits.
 *
 * Ties go to the first texel encountered in row-major order, which is
 * arbitrary but stable — a field with a large flat maximum would
 * otherwise return a different point on every call and look like drift.
 *
 * Worth remembering at the call site: the extremum is the most
 * noise-sensitive statistic available. The compression residual is
 * around one luma code, so the *location* of a maximum on a smooth
 * field is much less certain than its value.
 */
export function findExtremum(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  kind: 'max' | 'min' = 'max',
  options?: DatasetOverlayOptions,
  window?: TexelWindow,
): ExtremumResult | null {
  const { data, width, height } = snapshot
  const win = window ?? fullWindow(snapshot)
  const x0 = Math.max(0, Math.floor(win.x0))
  const y0 = Math.max(0, Math.floor(win.y0))
  const x1 = Math.min(width, Math.ceil(win.x1))
  const y1 = Math.min(height, Math.ceil(win.y1))
  if (x1 <= x0 || y1 <= y0) return null

  const firstDataCode = firstDataLuma(scale)
  let best = -1
  for (let y = y0; y < y1; y++) {
    const row = y * width
    for (let x = x0; x < x1; x++) {
      const luma = data[row + x]
      if (luma < firstDataCode) continue
      if (best < 0 || (kind === 'max' ? luma > best : luma < best)) best = luma
    }
  }
  if (best < 0) return null

  // Which texels actually hold that value.
  //
  // The old code kept the first one the row-major scan met and called
  // it the answer, which is only defensible when the extremum is
  // unique. It is usually not: these fields clip at the top of their
  // scale, so `best` is typically shared by a whole plateau and the
  // "first" member is simply its northernmost, then westernmost corner
  // — an artefact of loop order, reported as a place, flown to, and
  // pinned. Live, that put the marker on the edge of a smoke bank
  // rather than in it, and the answer read as though that specific
  // spot were meaningfully the worst.
  const members: number[] = []
  const mask = new Uint8Array(width * height)
  for (let y = y0; y < y1; y++) {
    const row = y * width
    for (let x = x0; x < x1; x++) {
      if (data[row + x] === best) { mask[row + x] = 1; members.push(row + x) }
    }
  }

  // Largest 4-connected patch, by flood fill over the members only.
  // Iterative rather than recursive: a saturated frame can hold a
  // plateau tens of thousands of texels wide.
  let bestPatch: number[] = []
  let patchCount = 0
  const seen = new Uint8Array(width * height)
  for (const start of members) {
    if (seen[start]) continue
    patchCount++
    const patch: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      patch.push(i)
      const x = i % width
      const y = (i - x) / width
      if (x > x0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1) }
      if (x < x1 - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1) }
      if (y > y0 && mask[i - width] && !seen[i - width]) { seen[i - width] = 1; stack.push(i - width) }
      if (y < y1 - 1 && mask[i + width] && !seen[i + width]) { seen[i + width] = 1; stack.push(i + width) }
    }
    if (patch.length > bestPatch.length) bestPatch = patch
  }

  // The centroid of the largest patch, snapped to whichever of its
  // texels is nearest. Snapped rather than used raw because a
  // crescent-shaped patch has a centroid outside itself, and a
  // reported location must be somewhere the value actually occurs.
  let sx = 0
  let sy = 0
  for (const i of bestPatch) { const x = i % width; sx += x; sy += (i - x) / width }
  const cx = sx / bestPatch.length
  const cy = sy / bestPatch.length
  let bx = bestPatch[0] % width
  let by = (bestPatch[0] - bx) / width
  let nearest = Infinity
  for (const i of bestPatch) {
    const x = i % width
    const y = (i - x) / width
    const d = (x - cx) ** 2 + (y - cy) ** 2
    if (d < nearest) { nearest = d; bx = x; by = y }
  }

  const areas = rowAreasKm2(width, height, options)
  let tieAreaKm2 = 0
  for (const i of members) tieAreaKm2 += areas[(i - (i % width)) / width]

  const { lat, lon } = texelUvToLatLon(
    { u: (bx + 0.5) / width, v: (by + 0.5) / height }, options)
  return {
    lat,
    lon,
    value: lumaToValue(best, scale),
    x: bx,
    y: by,
    tieCount: members.length,
    tieAreaKm2,
    plateau: members.length > 1,
    patchCount,
  }
}

// --- lines and profiles ----------------------------------------------

/**
 * Sample the field along the great circle between two points.
 *
 * Great-circle rather than a straight line in lat/lon, because the two
 * diverge sharply at the latitudes these datasets cover — a "straight"
 * transect across northern Canada would not follow the path the user
 * drew on the globe. Interpolation is spherical (slerp on unit
 * vectors), so the samples are evenly spaced in true distance.
 *
 * Points outside the dataset and points on absent data both come back
 * with a null value rather than being dropped, so the caller can break
 * the line at a gap instead of silently closing it.
 */
/**
 * How many samples a transect between two points deserves.
 *
 * One per grid cell crossed, because that is all the information the
 * frame holds. Asking for more does not refine the profile — it
 * interpolates the same texels into a smoother-looking curve and draws
 * structure the grid never measured, which is the same mistake the
 * histogram made by drawing one bar per luma code (see
 * `analyzeCharts.renderHistogram`). Asking for fewer throws away
 * measurements that are there.
 *
 * Cell size is taken at the transect's mean latitude: on an
 * equirectangular grid a cell's east-west extent shrinks with
 * `cos(lat)`, so a transect across northern Canada crosses far more
 * cells than its length in km would suggest at the equator.
 *
 * Clamped to `[2, 512]`. Two because a line needs endpoints; 512
 * because beyond that the samples are narrower than a chart pixel and
 * the cost stops buying anything.
 */
export const MAX_TRANSECT_SAMPLES = 512

export function transectSampleCount(
  snapshot: LumaSnapshot,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  options?: DatasetOverlayOptions,
): number {
  const { width, height } = snapshot
  if (width < 1 || height < 1) return 2

  const bbox = options?.boundingBox
  const latSpan = bbox ? Math.abs(bbox.n - bbox.s) : 180
  const kmPerDegree = (Math.PI / 180) * EARTH_RADIUS_KM
  const cellNsKm = (latSpan / height) * kmPerDegree
  const meanLat = (from.lat + to.lat) / 2
  const cellEwKm =
    (lonSpanDegrees(options) / width) * kmPerDegree * Math.cos((meanLat * Math.PI) / 180)

  // The smaller of the two, so the sampling resolves the finer axis
  // rather than averaging the two and under-sampling one of them. Near
  // the pole `cellEwKm` collapses toward zero, which would ask for an
  // unbounded count — the clamp is what stops that, and it is a real
  // case on these 85°N datasets, not a theoretical one.
  const cellKm = Math.min(cellNsKm, cellEwKm)
  if (!(cellKm > 0)) return MAX_TRANSECT_SAMPLES

  const km = greatCircleKm(from, to)
  return Math.max(2, Math.min(MAX_TRANSECT_SAMPLES, Math.round(km / cellKm) + 1))
}

/**
 * Angle subtended at the Earth's centre by two points, radians.
 *
 * Two identical points round to a dot product a hair under 1, whose
 * acos is ~2e-8 rad — 13 cm of phantom separation. Collapsed so a
 * zero-length transect reports zero rather than nearly zero.
 */
function centralAngle(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const a = toUnitVector(from.lat, from.lon)
  const b = toUnitVector(to.lat, to.lon)
  const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z))
  return 1 - dot < 1e-12 ? 0 : Math.acos(dot)
}

/** Great-circle distance between two points, km. */
export function greatCircleKm(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  return centralAngle(from, to) * EARTH_RADIUS_KM
}

export function sampleTransect(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  samples: number,
  options?: DatasetOverlayOptions,
): TransectSample[] {
  const n = Math.max(2, Math.floor(samples))
  const totalKm = greatCircleKm(from, to)
  const firstDataCode = firstDataLuma(scale)
  return greatCirclePath(from, to, n).map((p, i) => ({
    lat: p.lat,
    lon: p.lon,
    distanceKm: totalKm * (i / (n - 1)),
    value: readValueAt(snapshot, scale, p.lat, p.lon, firstDataCode, options),
  }))
}

/**
 * The outline of a lat/lon box, densified for drawing on a globe.
 *
 * A bbox's edges are parallels and meridians, **not** great circles:
 * the top edge of "Alabama" follows constant latitude, where the
 * shortest path between its corners would bow poleward. So this
 * interpolates in lat/lon space — which is exactly the curve the box
 * means — and emits enough vertices that the renderer's own
 * straight-in-projected-space segments stay under a pixel. That is the
 * opposite choice from `greatCirclePath`, deliberately, because the two
 * are answering different questions.
 *
 * Longitudes are emitted **unwrapped**, so an antimeridian-crossing box
 * runs past 180 rather than jumping to -180 mid-edge. That is the
 * convention `catalogMapUI` already relies on — MapLibre reads wrapped
 * polygon coordinates natively, and a ring that jumps at the seam would
 * be drawn as its own complement. The eastward span is the same one
 * `lonSpanDegrees` measures, so the ring encloses the box the
 * statistics used.
 */
export function boundsRing(
  bounds: LatLonBounds,
  perEdge = 32,
): { lat: number; lon: number }[] {
  const n = Math.max(2, Math.floor(perEdge))
  const { n: north, s: south, w, e } = bounds
  const span = w <= e ? e - w : 360 - w + e
  const lonAt = (f: number): number => w + f * span
  const ring: { lat: number; lon: number }[] = []
  // South edge west→east, east edge south→north, north edge east→west,
  // west edge north→south. Each edge omits its final vertex, which the
  // next edge contributes, and the ring closes on the first.
  for (let i = 0; i < n; i++) ring.push({ lat: south, lon: lonAt(i / n) })
  for (let i = 0; i < n; i++) ring.push({ lat: south + ((north - south) * i) / n, lon: lonAt(1) })
  for (let i = 0; i < n; i++) ring.push({ lat: north, lon: lonAt(1 - i / n) })
  for (let i = 0; i < n; i++) ring.push({ lat: north - ((north - south) * i) / n, lon: lonAt(0) })
  ring.push({ ...ring[0] })
  return ring
}

/**
 * `points` evenly-spaced positions along the great circle from `from` to
 * `to`, endpoints included.
 *
 * Shared with the map so the line drawn on the globe follows exactly the
 * path the samples were taken along. Drawing a two-vertex LineString
 * instead would render a straight line in projected space, which is not
 * the same curve — and a viewer comparing chart against globe has to be
 * looking at one path, not two.
 */
export function greatCirclePath(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  points: number,
): { lat: number; lon: number }[] {
  const n = Math.max(2, Math.floor(points))
  const a = toUnitVector(from.lat, from.lon)
  const b = toUnitVector(to.lat, to.lon)
  const omega = centralAngle(from, to)
  const sinOmega = Math.sin(omega)

  const out: { lat: number; lon: number }[] = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    // Antipodal or coincident endpoints make the slerp denominator
    // vanish; a linear blend is the right limit for coincident points
    // and an arbitrary-but-stable one for antipodal, where no great
    // circle is uniquely defined anyway.
    const p = sinOmega < 1e-9
      ? { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
      : blend(a, b, Math.sin((1 - t) * omega) / sinOmega, Math.sin(t * omega) / sinOmega)
    out.push(fromUnitVector(p))
  }
  return out
}

export interface TransectSummary {
  lengthKm: number
  /** Samples taken, including the ones that found no data. */
  samples: number
  withData: number
  min: number
  max: number
  /** Unweighted, and correctly so — see the note below. */
  mean: number
}

/**
 * Summarise a sampled transect.
 *
 * **The mean here is unweighted, unlike every other mean in this
 * module.** That is not an oversight: the samples are evenly spaced in
 * true distance along a great circle, so each already represents an
 * equal length of line. Area weighting answers "how much of the world
 * is at this value", which is the right question for a region and the
 * wrong one for a line — a transect has no area.
 *
 * Null where the line found no data at all, so the caller shows the
 * empty state rather than a row of dashes.
 */
export function summarizeTransect(
  samples: readonly TransectSample[],
): TransectSummary | null {
  if (samples.length === 0) return null
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let withData = 0
  for (const s of samples) {
    if (s.value == null) continue
    if (s.value < min) min = s.value
    if (s.value > max) max = s.value
    sum += s.value
    withData++
  }
  if (withData === 0) return null
  return {
    lengthKm: samples[samples.length - 1].distanceKm,
    samples: samples.length,
    withData,
    min,
    max,
    mean: sum / withData,
  }
}

/**
 * The area-weighted mean of every image row.
 *
 * A zonal-mean profile: the shape of the field against latitude, with
 * longitude integrated out. One of the densest summaries available for
 * a global or wide-regional field, and a single pass over the frame.
 *
 * `window` scopes it the same way it scopes `summarize` and
 * `buildHistogram`, and for the same reason: a profile shown under a
 * region's statistics has to describe that region. Rows outside the
 * window are dropped entirely rather than returned empty — a profile
 * covering a box should not be padded to pole-to-pole with nulls, which
 * would draw the box as a sliver of a mostly-blank axis.
 */
export function zonalMeans(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  options?: DatasetOverlayOptions,
  window?: TexelWindow,
): ZonalSample[] {
  const { data, width, height } = snapshot
  const win = window ?? fullWindow(snapshot)
  const x0 = Math.max(0, Math.floor(win.x0))
  const y0 = Math.max(0, Math.floor(win.y0))
  const x1 = Math.min(width, Math.ceil(win.x1))
  const y1 = Math.min(height, Math.ceil(win.y1))

  const out: ZonalSample[] = []
  if (x1 <= x0 || y1 <= y0) return out

  const firstDataCode = firstDataLuma(scale)
  for (let y = y0; y < y1; y++) {
    const row = y * width
    let sum = 0
    let count = 0
    for (let x = x0; x < x1; x++) {
      const luma = data[row + x]
      if (luma < firstDataCode) continue
      sum += lumaToValue(luma, scale)
      count++
    }
    out.push({
      // Keyed to the full frame height, not the window's. Latitude is a
      // property of where the row sits in the image; scoping the view
      // must not relabel it.
      lat: texelUvToLatLon({ u: 0.5, v: (y + 0.5) / height }, options).lat,
      mean: count > 0 ? sum / count : null,
      count,
    })
  }
  return out
}

// --- internals -------------------------------------------------------

/** One texel read, shared by the transect sampler. Returns null outside
 *  the dataset or on absent data — the two cases a chart draws the same
 *  way and a statistic must never conflate with a low value. */
function readValueAt(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  lat: number,
  lon: number,
  firstDataCode: number,
  options?: DatasetOverlayOptions,
): number | null {
  const uv = latLonToTexelUv(lat, lon, options)
  if (!uv) return null
  const x = Math.min(snapshot.width - 1, Math.max(0, Math.floor(uv.u * snapshot.width)))
  const y = Math.min(snapshot.height - 1, Math.max(0, Math.floor(uv.v * snapshot.height)))
  const luma = snapshot.data[y * snapshot.width + x]
  return luma < firstDataCode ? null : lumaToValue(luma, scale)
}

function toUnitVector(lat: number, lon: number): { x: number; y: number; z: number } {
  const phi = lat * (Math.PI / 180)
  const lambda = lon * (Math.PI / 180)
  const cosPhi = Math.cos(phi)
  return { x: cosPhi * Math.cos(lambda), y: cosPhi * Math.sin(lambda), z: Math.sin(phi) }
}

function fromUnitVector(p: { x: number; y: number; z: number }): { lat: number; lon: number } {
  const len = Math.hypot(p.x, p.y, p.z) || 1
  return {
    lat: Math.asin(p.z / len) * (180 / Math.PI),
    lon: Math.atan2(p.y, p.x) * (180 / Math.PI),
  }
}

function blend(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  wa: number,
  wb: number,
): { x: number; y: number; z: number } {
  return { x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb, z: a.z * wa + b.z * wb }
}
