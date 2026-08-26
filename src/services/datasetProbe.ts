// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Reading the value under the cursor on a data-encoded dataset.
 *
 * The globe already knows the lat/lon the pointer is over. This turns
 * that into a texel, reads one pixel of the current frame, and maps
 * its luma back to a physical value through the dataset's sidecar.
 * See `docs/DATA_ENCODED_VIDEO_PLAN.md` §Part 4.
 *
 * Everything except `sampleLumaAt` is pure, so the UV mapping — the
 * part most likely to be wrong, and least likely to look wrong — is
 * unit-testable without a GL context.
 */

import type { DatasetOverlayOptions } from '../types'
import { isTransparentLuma, lumaToValue, type ColorScale } from '../types/color-scale'
import { t } from '../i18n'
import { formatNumber } from '../i18n/format'

/** Normalised texture coordinates, origin at the image's top-left. */
export interface TexelUv {
  u: number
  v: number
}

/**
 * lat/lon → texture UV, mirroring the GLSL in the dataset shaders.
 *
 * Returns `null` when the point falls outside a regional dataset's
 * bounding box — the shader `discard`s there, and reporting a value
 * for a fragment that was never drawn would be worse than reporting
 * nothing.
 *
 * **The V axis is image-space here**, matching `earthTileLayer`'s
 * `v = (n - lat) / (n - s)` and full-globe `v = vUV.y`, i.e. v == 0
 * is the image's TOP row. The THREE renderers use the opposite
 * convention on the sphere (`photorealEarth.ts:584-588`) and flip on
 * the way in; callers reading a *texture* — which is what the
 * readout does — want this one. Getting the sign wrong mirrors the
 * data across the equator, which has happened twice in this
 * codebase.
 */
export function latLonToTexelUv(
  lat: number,
  lon: number,
  options?: DatasetOverlayOptions,
): TexelUv | null {
  const bbox = options?.boundingBox
  const flipY = options?.isFlippedInY === true

  if (bbox && !isGlobalBbox(bbox)) {
    const { n, s, w, e } = bbox
    if (lat > n || lat < s) return null
    let u: number
    if (w <= e) {
      if (lon < w || lon > e) return null
      u = (lon - w) / (e - w)
    } else {
      // Antimeridian-crossing box: inside if east of w OR west of e.
      const span = 360 - w + e
      if (lon >= w) u = (lon - w) / span
      else if (lon <= e) u = (lon + 360 - w) / span
      else return null
    }
    let v = (n - lat) / (n - s)
    if (flipY) v = 1 - v
    return { u, v }
  }

  const lonOrigin = typeof options?.lonOrigin === 'number' && Number.isFinite(options.lonOrigin)
    ? options.lonOrigin
    : 0
  // fract() in GLSL; JS `%` keeps the sign of the dividend, so add 1
  // before taking the remainder again.
  const raw = (lon - lonOrigin) / 360 + 0.5
  const u = ((raw % 1) + 1) % 1
  const vTop = (90 - lat) / 180
  return { u, v: flipY ? 1 - vTop : vTop }
}

/**
 * Texture UV → lat/lon: the exact inverse of {@link latLonToTexelUv}.
 *
 * Needed by anything that starts from a texel rather than from a
 * pointer — area weighting (which needs the latitude of each image
 * row), extremum location, and contour extraction all read the grid
 * and have to say *where* a value is.
 *
 * **V is image-space here too**, matching the forward direction: `v == 0`
 * is the image's TOP row and therefore the NORTH edge. The forward
 * function's docstring records that an inverted V has shipped twice in
 * this codebase; an inverted *inverse* is the same bug wearing a
 * different hat, and it would place every computed statistic in the
 * wrong hemisphere while leaving the globe looking correct. The
 * round-trip is pinned by tests in both directions.
 *
 * Longitude comes back normalised to [-180, 180). The antimeridian maps
 * to -180 rather than +180, which is the same point; callers comparing
 * against a bbox edge should not test for equality there.
 *
 * Unlike the forward direction this never returns null: every UV in the
 * unit square is inside the dataset by construction. UVs outside it are
 * extrapolated rather than rejected, because the only callers are grid
 * walks that cannot produce one.
 */
export function texelUvToLatLon(
  uv: TexelUv,
  options?: DatasetOverlayOptions,
): { lat: number; lon: number } {
  const bbox = options?.boundingBox
  const flipY = options?.isFlippedInY === true
  // Undo the flip first so the rest of the maths works in the same
  // top-down space the forward function computes in.
  const vTop = flipY ? 1 - uv.v : uv.v

  if (bbox && !isGlobalBbox(bbox)) {
    const { n, s, w, e } = bbox
    const lat = n - vTop * (n - s)
    // Antimeridian-crossing box: the forward direction measures U
    // across `360 - w + e`, so the inverse walks the same span east
    // from `w` and wraps.
    const span = w <= e ? e - w : 360 - w + e
    return { lat, lon: normaliseLon(w + uv.u * span) }
  }

  const lonOrigin = typeof options?.lonOrigin === 'number' && Number.isFinite(options.lonOrigin)
    ? options.lonOrigin
    : 0
  return {
    lat: 90 - vTop * 180,
    lon: normaliseLon(lonOrigin + (uv.u - 0.5) * 360),
  }
}

/** Wrap into [-180, 180). JS `%` keeps the dividend's sign, so this
 *  adds a full turn before the second remainder — the same guard
 *  `latLonToTexelUv` applies to its `fract()`. */
function normaliseLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

/**
 * Degrees of longitude the texture spans: the bbox width, or 360 for a
 * full-globe dataset.
 *
 * Exported because area weighting needs the width of one texel in
 * longitude, and deriving it by differencing two `texelUvToLatLon`
 * samples fails at exactly the case that matters — u = 0 and u = 1 are
 * the *same* meridian after wrapping, so a one-column frame differences
 * to zero and every cell area collapses. The span belongs to the same
 * bbox arithmetic the mapping already owns, so it lives here rather
 * than being re-derived by each caller.
 */
export function lonSpanDegrees(options?: DatasetOverlayOptions): number {
  const bbox = options?.boundingBox
  if (!bbox || isGlobalBbox(bbox)) return 360
  return bbox.w <= bbox.e ? bbox.e - bbox.w : 360 - bbox.w + bbox.e
}

/**
 * Sphere-geometry UV → lat/lon, for the VR globe.
 *
 * THREE populates `uv` on every raycast hit for free, and it is the
 * *mesh-local* texture coordinate — so it already accounts for however
 * far the user has spun the globe, and no inverse-quaternion step is
 * needed to recover the Earth-fixed point. That is why this is the
 * cheaper route into the readout than re-deriving from a world-space
 * ray.
 *
 * **The V convention here is THREE's, not the 2D globe's.**
 * `SphereGeometry` puts `uv.y == 1` at the north pole, the opposite of
 * `earthTileLayer`'s own sphere, which is why the two shaders carry
 * mirrored latitude expressions (`photorealEarth.ts:584-588`). Copying
 * the 2D form here mirrors the data across the equator — a failure
 * that has shipped twice in this codebase and looks entirely plausible
 * on screen. Latitude is therefore derived as `(v - 0.5) * 180` and
 * handed straight to `latLonToTexelUv`, which owns the conversion back
 * into image space, so the sign lives in exactly one place per
 * direction.
 */
export function sphereUvToLatLon(uv: { x: number; y: number }): { lat: number; lon: number } {
  return { lat: (uv.y - 0.5) * 180, lon: (uv.x - 0.5) * 360 }
}

/** A source the probe can read one texel out of. */
export type ProbeSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement

function sourceSize(source: ProbeSource): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight }
  }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight }
  }
  return { width: source.width, height: source.height }
}

/**
 * Reads the luma (0-255) at a normalised UV, or null when there is
 * nothing to read.
 *
 * This is a seam, not an implementation. The shipped one is
 * `createGlLumaSampler` in `glLumaSampler.ts`, which reads through
 * WebGL because a 1×1 `drawImage` into a 2D canvas — the obvious
 * approach, and what this originally did — returns transformed values
 * on iOS Safari. See that module for the measurements.
 *
 * Whatever implements it must copy **one texel, not a frame**: a
 * full-frame read at 4096×2048 is 32 MB per pointer event, which on a
 * `mousemove` stream is not a slow path but a broken one.
 */
export type LumaSampler = (source: ProbeSource, uv: TexelUv) => number | null

/** Clamp a normalised UV onto the source's texel grid centres.
 *  Exported for tests; the GL sampler filters NEAREST so it does not
 *  need this, but the maths is worth pinning independently. */
export function uvToTexel(
  source: ProbeSource,
  uv: TexelUv,
): { sx: number; sy: number } | null {
  const { width, height } = sourceSize(source)
  return uvToTexelInSize(width, height, uv)
}

/** `uvToTexel` against a bare size rather than a DOM source, for
 *  callers holding a decoded frame instead of the element it came from
 *  (`docentAnalysisTools`, which reads a `LumaSnapshot`). Same clamp,
 *  one implementation — a second copy of this arithmetic is exactly the
 *  kind of thing that drifts a half-texel and is never noticed. */
export function uvToTexelInSize(
  width: number,
  height: number,
  uv: TexelUv,
): { sx: number; sy: number } | null {
  if (!width || !height) return null
  return {
    sx: Math.min(width - 1, Math.max(0, Math.floor(uv.u * width))),
    sy: Math.min(height - 1, Math.max(0, Math.floor(uv.v * height))),
  }
}

export interface ProbeReading {
  /** The physical value, in `units`. */
  value: number
  units?: string
  /** True when the sample falls in the palette's no-data band, so the
   *  caller should say "no data" rather than print a number that
   *  happens to sit at the bottom of the range. */
  noData: boolean
  /** One luma step in physical units — the finest difference this
   *  transport can carry. Present so the formatter can stop short of
   *  printing digits the data does not have. */
  quantisationStep?: number
}

/**
 * The full pointer → value path. Returns `null` when there is nothing
 * meaningful to report: not a data-encoded dataset, outside its bbox,
 * or no frame decoded yet.
 */
export function probeDatasetValue(
  lat: number,
  lon: number,
  source: ProbeSource,
  sample: LumaSampler,
  options: DatasetOverlayOptions | undefined,
): ProbeReading | null {
  const scale: ColorScale | undefined = options?.colorScale
  if (!scale) return null
  const uv = latLonToTexelUv(lat, lon, options)
  if (!uv) return null
  const luma = sample(source, uv)
  if (luma === null) return null
  return {
    value: lumaToValue(luma, scale),
    units: scale.units,
    noData: isTransparentLuma(luma, scale),
    quantisationStep: (scale.vmax - scale.vmin) / 255,
  }
}

/**
 * Render a reading for display, shared by the 2D lat/lon strip and the
 * in-VR HUD so the two never disagree about the same pixel.
 *
 * Significant digits rather than fixed decimals, because the same code
 * formats a smoke column in mg m-2 and a temperature in K, and a fixed
 * precision is wrong for at least one of them. A sample in the
 * palette's no-data band says so rather than printing a number that
 * happens to sit at the bottom of the range.
 */
/**
 * How many decimals this transport can actually justify.
 *
 * Three significant figures is the house convention, and for most
 * values it is also honest. It stops being honest when the third digit
 * is finer than one luma step: the live column-loading row has a step
 * of about 1.96e-6, so `0.0000700` claims resolution to 1e-7 on data
 * quantised fifty times more coarsely. The trailing digit is not a
 * measurement, it is an artefact of the divide.
 *
 * So the step sets a floor: round to the decimal place of the step's
 * leading digit, then let three significant figures cap it from the
 * other side. Trailing zeros are dropped, because a zero the data
 * cannot support reads exactly like one it can.
 */
function decimalsForStep(step: number): number | null {
  if (!Number.isFinite(step) || step <= 0) return null
  return Math.max(0, -Math.floor(Math.log10(step)))
}

export function formatProbeReading(reading: ProbeReading): string {
  if (reading.noData) return t('probe.noData')
  const decimals = reading.quantisationStep != null ? decimalsForStep(reading.quantisationStep) : null
  const shown = decimals != null
    ? Number(reading.value.toFixed(decimals))
    : reading.value
  const value = formatNumber(shown, { maximumSignificantDigits: 3 })
  return reading.units
    ? t('probe.value', { value, units: reading.units })
    : t('probe.valueNoUnits', { value })
}

/** `wireToDataset` defaults every catalog row's bbox to worldwide, so
 *  a global dataset arrives carrying a box rather than no box. Treat
 *  that as the full-globe path — otherwise the bbox branch would
 *  re-derive the same UVs by a longer route and, at the poles, clip
 *  a row it should not. */
function isGlobalBbox(b: { n: number; s: number; w: number; e: number }): boolean {
  return b.n >= 90 && b.s <= -90 && b.w <= -180 && b.e >= 180
}
