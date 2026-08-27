// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Display transforms over a data-encoded palette.
 *
 * A data-encoded dataset carries the *numbers*, so how it is coloured is
 * a viewing decision rather than a property of the file. That is the
 * claim `docs/DATA_ENCODED_VIDEO_PLAN.md` makes when it says these
 * datasets are "repalettable without re-encoding"; this module is what
 * exercises it. See `docs/DATA_ANALYSIS_PLAN.md` §A1.
 *
 * Three transforms, all expressible as *a different 256×1 LUT*, so they
 * cost one texture upload, work on video in motion at full frame rate,
 * and read back no pixels:
 *
 *   - **palette** — swap the colour ramp (a colourblind-safe one on
 *     demand, for any dataset, with no publisher action)
 *   - **stretch** — spread the ramp across a sub-range of the data, so
 *     structure in a skewed field becomes visible
 *   - **threshold** — hide values outside a band, so "only the part
 *     above the unhealthy line" is a slider rather than a re-render
 *
 * **The invariant this module exists to protect: a display transform
 * never changes a reported value.** `lumaToValue` stays the single
 * source of truth for what a number *is*; everything here only decides
 * what it *looks like*. A stretched globe still probes to the same
 * physical value, and every statistic in `datasetStats` is computed
 * from luma and the scale, never from the display LUT. Breaking that
 * would produce a globe whose colours and whose readout disagree —
 * the exact failure the GL probe was written to prevent.
 */

import {
  COLOR_SCALE_LUT_SIZE,
  buildColorScaleLut,
  isTransparentLuma,
  lumaToValue,
  type ColorScale,
  type ColorScaleStop,
} from '../types/color-scale'

/** Palette identifiers. `source` is the dataset's own ramp — the
 *  default, and the only one the publisher chose. */
export const PALETTE_IDS = ['source', 'viridis', 'magma', 'turbo', 'grayscale'] as const

export type PaletteId = (typeof PALETTE_IDS)[number]

export interface ColorScaleDisplay {
  palette: PaletteId
  /** The normalised sub-range of the data the ramp spans. `lo` maps to
   *  the ramp's first colour, `hi` to its last; outside is clamped. */
  stretch: { lo: number; hi: number }
  /** Physical values outside this band are hidden. `null` means no
   *  bound on that side. */
  threshold: { min: number | null; max: number | null }
}

export const DEFAULT_DISPLAY: ColorScaleDisplay = {
  palette: 'source',
  stretch: { lo: 0, hi: 1 },
  threshold: { min: null, max: null },
}

/** Whether a display is the identity, so callers can skip the rebuild
 *  and offer a reset control only when there is something to reset. */
export function isDefaultDisplay(d: ColorScaleDisplay): boolean {
  return d.palette === 'source'
    && d.stretch.lo === 0 && d.stretch.hi === 1
    && d.threshold.min === null && d.threshold.max === null
}

// --- the ramps -------------------------------------------------------
//
// Control points rather than 256 entries apiece: `buildColorScaleLut`
// already interpolates linearly between stops, and a dozen points
// reproduce these ramps closely enough that the difference is invisible
// at any size a colorbar is drawn. Alpha is 255 throughout and is never
// used — see `buildDisplayLut`, which always takes alpha from the
// dataset's own palette.

const RAMPS: Record<Exclude<PaletteId, 'source'>, [number, [number, number, number]][]> = {
  viridis: [
    [0.0, [68, 1, 84]], [0.1, [72, 40, 120]], [0.2, [62, 74, 137]],
    [0.3, [49, 104, 142]], [0.4, [38, 130, 142]], [0.5, [31, 158, 137]],
    [0.6, [53, 183, 121]], [0.7, [109, 205, 89]], [0.8, [180, 222, 44]],
    [0.9, [194, 223, 35]], [1.0, [253, 231, 37]],
  ],
  magma: [
    [0.0, [0, 0, 4]], [0.125, [28, 16, 68]], [0.25, [79, 18, 123]],
    [0.375, [129, 37, 129]], [0.5, [181, 54, 122]], [0.625, [229, 80, 100]],
    [0.75, [251, 135, 97]], [0.875, [254, 194, 135]], [1.0, [252, 253, 191]],
  ],
  turbo: [
    [0.0, [48, 18, 59]], [0.1, [70, 107, 227]], [0.2, [54, 168, 253]],
    [0.3, [26, 217, 218]], [0.4, [63, 246, 163]], [0.5, [128, 253, 105]],
    [0.6, [188, 230, 66]], [0.7, [238, 182, 50]], [0.8, [254, 120, 32]],
    [0.9, [232, 58, 13]], [1.0, [122, 4, 3]],
  ],
  grayscale: [
    [0.0, [0, 0, 0]], [1.0, [255, 255, 255]],
  ],
}

function rampStops(id: Exclude<PaletteId, 'source'>): ColorScaleStop[] {
  return RAMPS[id].map(([t, [r, g, b]]) => ({ t, rgba: [r, g, b, 255] as [number, number, number, number] }))
}

// --- the transform ---------------------------------------------------

const LAST = COLOR_SCALE_LUT_SIZE - 1

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Build the LUT the shaders should sample for a given display.
 *
 * Composed out of `buildColorScaleLut` rather than reimplementing the
 * interpolation, so the palette maths lives in exactly one place and
 * the shared contract in `types/color-scale.ts` stays free of display
 * concerns (it is imported by Workers code, which has no display).
 *
 * **Alpha always comes from the dataset's own palette, never from the
 * chosen ramp.** The published ramps fade in from fully transparent
 * across their low end, and that fade is what lets these datasets read
 * as data over a real base map instead of as a coloured disc. A palette
 * swap that took alpha from viridis — opaque throughout — would turn
 * the whole bounding box into a solid rectangle, which reads as a bug
 * even though every colour in it is correct.
 */
export function buildDisplayLut(scale: ColorScale, display: ColorScaleDisplay): Uint8Array {
  // The source LUT is always built: it supplies the alpha profile even
  // when the RGB comes from somewhere else.
  const source = buildColorScaleLut(scale)
  const rgb = display.palette === 'source'
    ? source
    : buildColorScaleLut({ ...scale, stops: rampStops(display.palette) })

  const lo = clamp01(Math.min(display.stretch.lo, display.stretch.hi))
  const hi = clamp01(Math.max(display.stretch.lo, display.stretch.hi))
  // A zero-width stretch has no meaningful ramp; fall back to identity
  // rather than dividing by zero and painting the whole globe one
  // colour, which looks like a rendering failure rather than a setting.
  const span = hi - lo
  const stretched = span > 1e-6

  const out = new Uint8Array(COLOR_SCALE_LUT_SIZE * 4)
  for (let i = 0; i < COLOR_SCALE_LUT_SIZE; i++) {
    const t = i / LAST
    const o = i * 4
    const s = stretched ? clamp01((t - lo) / span) : t
    const src = Math.round(s * LAST) * 4

    // RGB is written even where the texel ends up fully transparent.
    // The shaders sample this LUT with LINEAR filtering, so a run of
    // zeroed RGB next to real colour bleeds a dark fringe along the
    // edge of the nodata band — which is why `buildColorScaleLut`
    // zeroes only alpha, and why skipping the write here is a visible
    // bug rather than a shortcut.
    out[o] = rgb[src]
    out[o + 1] = rgb[src + 1]
    out[o + 2] = rgb[src + 2]
    out[o + 3] = source[src + 3]

    // Absent data is a property of the data, not of the display, so
    // this is tested against the original code under every transform —
    // the alpha copied above came from the *stretched* position and has
    // already lost track of the band.
    //
    // Asking the shared contract rather than re-deriving the test is
    // load-bearing: a sidecar may declare the band as `dataMinLuma`
    // with no `transparentRange` (the parser only requires the two to
    // agree when both are present), and a re-derived
    // `transparentRange` test would then paint the reserved codes as
    // data under any stretch anchored near the low end — which is the
    // common case here, since these fields put most of their data
    // there. Being the `if`, it also keeps the band away from
    // `lumaToValue`, whose contract is that a code below the band
    // means nothing.
    if (isTransparentLuma(i, scale)) out[o + 3] = 0
    else if (outsideThreshold(lumaToValue(i, scale), display.threshold)) out[o + 3] = 0
  }
  return out
}

function outsideThreshold(
  value: number,
  threshold: { min: number | null; max: number | null },
): boolean {
  if (threshold.min !== null && value < threshold.min) return true
  if (threshold.max !== null && value > threshold.max) return true
  return false
}

// --- the colorbar ----------------------------------------------------

export interface ColorbarTick {
  /** Position along the bar, 0 at the low end. */
  position: number
  /** Physical value at that position. */
  value: number
}

/**
 * The physical value at a position along the bar.
 *
 * The bar spans whatever the stretch maps, so under a stretch it
 * reports the sub-range in view rather than the dataset's full extent.
 * A colorbar that kept showing the full range while the globe showed a
 * tenth of it would be a lie told in the most authoritative-looking
 * place on screen.
 */
export function valueAtPosition(
  scale: ColorScale,
  display: ColorScaleDisplay,
  position: number,
): number {
  const lo = clamp01(Math.min(display.stretch.lo, display.stretch.hi))
  const hi = clamp01(Math.max(display.stretch.lo, display.stretch.hi))
  const t = hi - lo > 1e-6 ? lo + clamp01(position) * (hi - lo) : clamp01(position)
  return lumaToValue(t * LAST, scale)
}

/** The normalised position of a physical value, for turning a
 *  user-entered threshold back into a handle on the bar. Values outside
 *  the displayed range come back clamped. */
export function positionOfValue(
  scale: ColorScale,
  display: ColorScaleDisplay,
  value: number,
): number {
  const lo = valueAtPosition(scale, display, 0)
  const hi = valueAtPosition(scale, display, 1)
  return hi === lo ? 0 : clamp01((value - lo) / (hi - lo))
}

/**
 * The luma at a position along a control, placed by the data's own
 * distribution rather than by the palette's nominal range.
 *
 * These fields are extremely skewed. Measured on a published RRFS smoke
 * frame: 88% of the frame is absent data, and of what remains, **half
 * lies below 8% of a linear slider's travel** while the top 75% of that
 * travel changes the picture by under 3%. A linear threshold control is
 * therefore almost entirely dead — which reads as "the setting does
 * nothing" rather than as "there is nothing up there to hide".
 *
 * `weights` is the 256-bin area-weighted tally from
 * `datasetStats.buildHistogram`. Given one, position `p` returns the
 * luma below which `p` of the data lies — so half travel really does
 * mean half the data, for any field, with no tuned exponent. Given
 * `null` (no frame readable, no WebGL2) this falls back to the linear
 * mapping, which is wrong in the same way as before but never worse.
 */
export function lumaAtDataQuantile(
  weights: Float64Array | null | undefined,
  position: number,
): number {
  const p = clamp01(position)
  if (!weights) return p * LAST
  let total = 0
  for (let i = 0; i < weights.length; i++) total += weights[i]
  if (total <= 0) return p * LAST
  const target = total * p
  let seen = 0
  for (let luma = 0; luma < weights.length; luma++) {
    if (weights[luma] <= 0) continue
    seen += weights[luma]
    if (seen >= target) return luma
  }
  return LAST
}

/**
 * The inverse: where a luma sits along the control.
 *
 * Used to place a handle for a threshold that already exists, so
 * re-opening the controls does not move the setting the user chose.
 */
export function dataQuantileOfLuma(
  weights: Float64Array | null | undefined,
  luma: number,
): number {
  if (!weights) return clamp01(luma / LAST)
  let total = 0
  for (let i = 0; i < weights.length; i++) total += weights[i]
  if (total <= 0) return clamp01(luma / LAST)
  let seen = 0
  for (let i = 0; i <= Math.min(LAST, Math.round(luma)); i++) seen += weights[i]
  return clamp01(seen / total)
}

/**
 * The fraction of the data a threshold band keeps, in [0, 1].
 *
 * Surfaced next to the threshold readout because "only 0.00028 and
 * below" is not, on its own, a statement anyone can act on: on this
 * data it keeps 99.8% of the field, and a control that appears to do
 * nothing is indistinguishable from one that is broken.
 */
export function fractionKept(
  weights: Float64Array | null | undefined,
  scale: ColorScale,
  threshold: { min: number | null; max: number | null },
): number | null {
  if (!weights) return null
  let total = 0
  let kept = 0
  for (let luma = 0; luma < weights.length; luma++) {
    const w = weights[luma]
    if (w <= 0) continue
    total += w
    if (!outsideThreshold(lumaToValue(luma, scale), threshold)) kept += w
  }
  return total > 0 ? kept / total : null
}

/**
 * Tick marks at round numbers rather than at even fractions.
 *
 * The live smoke scale runs 0 to 5×10⁻⁴ kg m⁻²; five even divisions of
 * that are 0.0001, 0.0002 … which read fine, but a stretched sub-range
 * like 3.7×10⁻⁵ to 2.4×10⁻⁴ divided evenly produces five numbers nobody
 * can compare at a glance. Snapping to a 1/2/5 × 10ⁿ step is what makes
 * a colorbar scannable.
 *
 * Returns between roughly `target - 1` and `target + 1` ticks; the count
 * is a request, not a guarantee, because round numbers do not divide a
 * range evenly on demand.
 */
export function colorbarTicks(
  scale: ColorScale,
  display: ColorScaleDisplay,
  target = 5,
): ColorbarTick[] {
  const lo = valueAtPosition(scale, display, 0)
  const hi = valueAtPosition(scale, display, 1)
  const min = Math.min(lo, hi)
  const max = Math.max(lo, hi)
  const step = niceStep(max - min, Math.max(2, target))
  if (!Number.isFinite(step) || step <= 0) return []

  const ticks: ColorbarTick[] = []
  const first = Math.ceil(min / step) * step
  // Guard the loop independently of the arithmetic: a pathological
  // range should return nothing rather than hang the frame.
  for (let v = first, n = 0; v <= max + step * 1e-9 && n < 64; v += step, n++) {
    // Re-derive from the multiple rather than accumulating, so a long
    // run does not drift off the round numbers this function exists to
    // produce.
    // `Math.ceil` of a fraction in (−1, 0) returns *negative* zero, which
    // survives the multiplication and renders as "-0" through
    // `toFixed` — the one formatter that keeps the sign. Normalise it,
    // or a bar whose range straddles zero labels its own origin "-0".
    const raw = Math.round(v / step) * step
    const value = Object.is(raw, -0) ? 0 : raw
    ticks.push({ position: (value - lo) / (hi - lo), value })
  }
  return ticks
}

/**
 * The 1/2/5 × 10ⁿ step closest to dividing `range` into `count`.
 *
 * Closest in the geometric sense, which is what the thresholds are: √2,
 * √10 and √50 are the midpoints of 1→2, 2→5 and 5→10 on a log scale, so
 * a rough step snaps to whichever candidate it is nearer to as a
 * *ratio*.
 *
 * The previous form took the first candidate at or above the rough
 * step, which only ever rounded up — and 2→5 is a factor of 2.5, so
 * overshooting there halves the count. A dBZ field spanning −35..78
 * asked for five and got two: rough 23.3 snapped to 50 instead of 20.
 * Visible twice over, because this feeds both the colorbar's labels and
 * the Analyze panel's contour levels, and two isolines across a whole
 * field is not a contour plot.
 */
function niceStep(range: number, count: number): number {
  if (!(range > 0)) return NaN
  const rough = range / count
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalised = rough / magnitude
  const snapped =
    normalised >= Math.sqrt(50) ? 10
      : normalised >= Math.sqrt(10) ? 5
        : normalised >= Math.SQRT2 ? 2
          : 1
  return snapped * magnitude
}

/**
 * CSS gradient stops for drawing the bar in the DOM.
 *
 * Sampled from the same LUT the shader receives, so the bar and the
 * globe cannot disagree about a colour — including about where the
 * threshold hides values, which shows up as a transparent band in the
 * bar and reads exactly right.
 */
export function displayGradientStops(
  scale: ColorScale,
  display: ColorScaleDisplay,
  samples = 32,
): { position: number; rgba: [number, number, number, number] }[] {
  const lut = buildDisplayLut(scale, display)
  const lo = clamp01(Math.min(display.stretch.lo, display.stretch.hi))
  const hi = clamp01(Math.max(display.stretch.lo, display.stretch.hi))
  const span = hi - lo > 1e-6 ? hi - lo : 1
  const base = hi - lo > 1e-6 ? lo : 0

  const out: { position: number; rgba: [number, number, number, number] }[] = []
  for (let i = 0; i < samples; i++) {
    const position = i / (samples - 1)
    // Read the LUT at the data position this part of the bar shows,
    // not at the bar position — under a stretch those differ, and
    // sampling the wrong one draws a bar that does not match the globe.
    const idx = Math.round(clamp01(base + position * span) * LAST) * 4
    out.push({ position, rgba: [lut[idx], lut[idx + 1], lut[idx + 2], lut[idx + 3]] })
  }
  return out
}

/**
 * The colour a display LUT gives to one physical value, as CSS.
 *
 * Used to paint each contour isoline in the colour the globe is already
 * using at that level, so a line and the surface it sits on cannot
 * disagree — the same discipline `displayGradientStops` follows for the
 * bar.
 *
 * Finds the luma code by scanning `lumaToValue` rather than inverting
 * it. An inverse would be a second copy of a mapping that has to agree
 * with the first one forever, and A0 is in flight to change that mapping
 * — see `datasetContours` for the same reasoning at greater length. 256
 * steps for a handful of levels is not worth a correctness risk.
 *
 * Returns `null` for a value the ramp hides, where a line would be drawn
 * in a colour the globe is not showing anywhere.
 */
export function displayColorAtValue(
  lut: Uint8Array,
  scale: ColorScale,
  value: number,
): string | null {
  if (!Number.isFinite(value)) return null
  let best = 0
  let bestDelta = Infinity
  for (let luma = 0; luma < COLOR_SCALE_LUT_SIZE; luma++) {
    const delta = Math.abs(lumaToValue(luma, scale) - value)
    if (delta < bestDelta) {
      bestDelta = delta
      best = luma
    }
  }
  const o = best * 4
  const alpha = lut[o + 3]
  if (alpha === 0) return null
  return `rgb(${lut[o]}, ${lut[o + 1]}, ${lut[o + 2]})`
}
