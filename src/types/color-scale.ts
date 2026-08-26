// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The data-encoded video sidecar — the palette and scale that turn a
 * grayscale frame back into colour and numbers at display time.
 *
 * Shared by the publisher API (`functions/`), the SPA renderers
 * (`src/services/`), and the publisher portal, so the shape is defined
 * once here rather than three times. See
 * `docs/DATA_ENCODED_VIDEO_PLAN.md`.
 *
 * A data-encoded dataset ships frames whose luma *is* the normalised
 * value: black is `vmin` (and no data), white is `vmax`. Nothing in
 * the frame says what that means, so the row carries this alongside —
 * the palette to colour it with, the range to scale it by, and the
 * units to report it in.
 *
 * Everything here is pure and dependency-free: it is imported by
 * Workers code, by browser code, and by tests.
 */

/** The only encoding defined so far. A dataset whose `renderEncoding`
 *  is absent is a picture and takes every path it takes today. */
export const RENDER_ENCODING_DATA_LUMA = 'data-luma'

export type RenderEncoding = typeof RENDER_ENCODING_DATA_LUMA

/** Width of the LUT the shaders sample. 256 because the source is an
 *  8-bit luma channel — a wider LUT cannot express more. */
export const COLOR_SCALE_LUT_SIZE = 256

/** Length cap on the stored JSON. Generous next to `probing_info`'s
 *  4096 because a palette can legitimately carry a stop per code
 *  value, and ~256 stops serialise to roughly 10 KB. */
export const COLOR_SCALE_MAX_CHARS = 16_384

/** One palette stop. `t` is the normalised position in [0,1]; `rgba`
 *  is 0-255 per channel, alpha included, because the palettes zyra
 *  reads (`--cmap-file`) carry their own transparency. */
export interface ColorScaleStop {
  t: number
  rgba: [number, number, number, number]
}

export interface ColorScale {
  /** Ascending by `t`, at least two entries. */
  stops: ColorScaleStop[]
  /** Physical value at luma 0. */
  vmin: number
  /** Physical value at luma 255. */
  vmax: number
  /** Unit label for the readout, e.g. `mg m-2`. */
  units?: string
  /**
   * Normalised width at the bottom of the range that is forced fully
   * transparent. The published smoke pipeline uses 12/256 ≈ 0.047:
   * values that low are indistinguishable from "nothing measured here"
   * and drawing them produces a haze over the whole globe.
   */
  transparentRange?: number
  /**
   * Lowest luma code that carries data. Codes below it are the
   * reserved no-data band — the frame has nothing to report there, and
   * neither the palette nor the readout may treat them as a value.
   *
   * Absent means 0, which is what every dataset published before this
   * field existed already meant. `lumaToValue` and `buildColorScaleLut`
   * both reduce to their previous expressions when it is 0, so
   * backwards compatibility is a property of the arithmetic rather
   * than of a branch that could be got wrong.
   *
   * This differs from `transparentRange` in kind, not just in units:
   * `transparentRange` hides a band that *is* data but is too faint to
   * be worth drawing, while this one declares a band that is not data
   * at all. When both are set they must agree about where data starts
   * — `parseColorScale` refuses the sidecar otherwise.
   */
  dataMinLuma?: number
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function parseStop(raw: unknown): ColorScaleStop | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { t, rgba } = raw as { t?: unknown; rgba?: unknown }
  if (!isFiniteNumber(t) || t < 0 || t > 1) return null
  if (!Array.isArray(rgba) || rgba.length !== 4) return null
  const channels: number[] = []
  for (const c of rgba) {
    if (!isFiniteNumber(c) || c < 0 || c > 255) return null
    channels.push(c)
  }
  return { t, rgba: [channels[0], channels[1], channels[2], channels[3]] }
}

/**
 * Parse an untrusted sidecar into a `ColorScale`, or `null`.
 *
 * Fail-closed on purpose: a malformed sidecar returns `null`, the
 * caller treats the dataset as a picture, and the viewer sees raw
 * grayscale rather than confidently-wrong colours over a plausible
 * palette. Accepts either a JSON string (how D1 stores it) or an
 * already-parsed object (how the wire delivers it).
 */
export function parseColorScale(input: unknown): ColorScale | null {
  let raw: unknown = input
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { stops, vmin, vmax, units, transparentRange, dataMinLuma } = raw as Record<string, unknown>
  if (!Array.isArray(stops) || stops.length < 2) return null
  if (!isFiniteNumber(vmin) || !isFiniteNumber(vmax) || vmin === vmax) return null

  const parsed: ColorScaleStop[] = []
  for (const s of stops) {
    const stop = parseStop(s)
    if (!stop) return null
    parsed.push(stop)
  }
  // Sort rather than reject: stop order is a serialisation detail and
  // an out-of-order palette is still fully determined.
  parsed.sort((a, b) => a.t - b.t)

  const scale: ColorScale = { stops: parsed, vmin, vmax }
  if (typeof units === 'string' && units.trim() !== '') scale.units = units
  if (isFiniteNumber(transparentRange) && transparentRange > 0 && transparentRange < 1) {
    scale.transparentRange = transparentRange
  }

  // Rejected rather than ignored, which is the opposite of how
  // `transparentRange` above is treated, and deliberately so: a dropped
  // `transparentRange` costs some haze at the bottom of the ramp, while
  // a dropped `dataMinLuma` silently shifts the value of *every* texel
  // in the frame by the width of the band. A sidecar that meant to
  // declare one and got it wrong must not publish numbers as if it had
  // never tried.
  if (dataMinLuma !== undefined && dataMinLuma !== null) {
    if (!isFiniteNumber(dataMinLuma)) return null
    // 254 rather than 255: at 255 the band swallows every code but one,
    // and `lumaToValue`'s `255 - lo` denominator goes to zero. A scale
    // with a single data code is degenerate on both counts.
    if (!Number.isInteger(dataMinLuma) || dataMinLuma < 0 || dataMinLuma > 254) return null
    scale.dataMinLuma = dataMinLuma
  }

  // Both present: they have to describe the same boundary.
  // `transparentRange` hides a code when `luma / 255 < transparentRange`,
  // so the first code it leaves visible is `ceil(transparentRange * 255)`.
  // If that is not where the data starts, the sidecar is making two
  // different claims about one band — either colouring texels the
  // readout calls absent, or reporting numbers for texels the globe
  // draws as empty. Both are the confidently-wrong failure this whole
  // contract exists to avoid, so refuse instead of picking a winner.
  if (scale.dataMinLuma !== undefined && scale.transparentRange !== undefined) {
    if (Math.ceil(scale.transparentRange * 255) !== scale.dataMinLuma) return null
  }
  return scale
}

/**
 * Expand a `ColorScale` into the RGBA LUT the shaders sample —
 * `COLOR_SCALE_LUT_SIZE` texels, 4 bytes each, indexed by luma.
 *
 * Interpolation is linear between adjacent stops, in straight
 * (non-premultiplied) 8-bit space, which is what the shader's
 * `mix(base, palette, alpha)` expects.
 */
export function buildColorScaleLut(scale: ColorScale): Uint8Array {
  const lut = new Uint8Array(COLOR_SCALE_LUT_SIZE * 4)
  const { stops } = scale
  // Below `transparentRange` nothing was measured; force alpha to 0
  // rather than trusting the palette's own low end, which frequently
  // ramps up from a small but non-zero alpha.
  const cutoff = scale.transparentRange ?? 0
  const lo = scale.dataMinLuma ?? 0
  const top = COLOR_SCALE_LUT_SIZE - 1
  let si = 0
  for (let i = 0; i < COLOR_SCALE_LUT_SIZE; i++) {
    // The palette spans the DATA band, not the whole code range, so a
    // code's colour and the value `lumaToValue` reports for it come out
    // of the same mapping. Skipping this would leave the colorbar's
    // labels offset from its colours by the width of the band — the
    // reserved codes would take the palette's low end while the first
    // code carrying `vmin` took something above it. With `lo` at 0 this
    // is `i / 255`, the expression it has always been.
    const t = i <= lo ? 0 : (i - lo) / (top - lo)
    while (si < stops.length - 2 && stops[si + 1].t < t) si++
    const a = stops[si]
    const b = stops[si + 1] ?? a
    const span = b.t - a.t
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0
    const o = i * 4
    for (let c = 0; c < 4; c++) {
      lut[o + c] = Math.round(a.rgba[c] + (b.rgba[c] - a.rgba[c]) * f)
    }
    // Both tests are in code space. They select the same codes whenever
    // both fields are set, since `parseColorScale` rejects sidecars
    // where they disagree, so each can act alone without the other
    // needing to know.
    if (i < lo || i / top < cutoff) lut[o + 3] = 0
  }
  return lut
}

/**
 * Recover the physical value from a sampled luma code (0-255).
 *
 * The inverse of what zyra's writer does: it normalised against
 * `vmin`/`vmax` and never autoscaled per frame, precisely so this
 * mapping is the same for every frame in the dataset.
 *
 * `dataMinLuma` shifts the bottom of the mapping to the first code that
 * carries data, so `vmin` lands there rather than at 0. Absent, it is 0
 * and the expression reduces exactly to the one this has always been.
 *
 * Only meaningful for a code the frame actually measured: below
 * `dataMinLuma` the result runs off the bottom of the range and means
 * nothing. It is deliberately left un-clamped, because clamping would
 * return `vmin` — a number indistinguishable from a real reading at the
 * bottom of the scale. Ask `isTransparentLuma` first.
 */
export function lumaToValue(luma: number, scale: ColorScale): number {
  const lo = scale.dataMinLuma ?? 0
  return scale.vmin + ((luma - lo) / (255 - lo)) * (scale.vmax - scale.vmin)
}

/** Whether a sampled luma falls in the region the palette declares to
 *  be "nothing measured here". `dataMinLuma` wins when set: it is the
 *  stronger claim of the two, and the parser has already established
 *  that a `transparentRange` alongside it agrees. */
export function isTransparentLuma(luma: number, scale: ColorScale): boolean {
  if (scale.dataMinLuma !== undefined) return luma < scale.dataMinLuma
  const cutoff = scale.transparentRange ?? 0
  return luma / 255 < cutoff
}
