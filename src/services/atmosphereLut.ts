/**
 * Transmittance Look-Up Table (LUT) for atmospheric scattering.
 *
 * Computes the article's transmittance LUT on the CPU as an RGBA8
 * byte array, sized 256×64. Each pixel stores the per-channel
 * transmittance `exp(-tau)` of sunlight passing through the
 * atmosphere from a point at altitude `h` along a ray whose vertical
 * angle is `mu`. Indexed by:
 *
 *   - x ∈ [0, width)  → `mu = mix(-1, 1, x / (W-1))`
 *     -1 = looking straight down toward the planet centre (occluded),
 *     +1 = looking straight up to space (no atmosphere left).
 *   - y ∈ [0, height) → `altitude = mix(0, ATMOSPHERE_HEIGHT, y/(H-1))`
 *     0 = sea level, H-1 = top of atmosphere.
 *
 * Computed once per session and uploaded to a texture in each
 * renderer's GL context — replaces the 5- or 8-sample inner
 * light-march from Tier 2 with a single texture lookup. The article
 * (Hillaire / Heckel) does the equivalent on the GPU; doing it on
 * the CPU is ~10× slower but avoids threading a renderer reference
 * through `createPhotorealEarth()` and the MapLibre CustomLayer
 * lifecycle. Once-only init cost is in the tens of ms; tested below.
 *
 * Pure JS — no DOM, no WebGL — so it's testable and the same code
 * powers both the Three.js and MapLibre uploads.
 */

import {
  RAYLEIGH_BETA,
  MIE_BETA_EXT,
  OZONE_BETA_ABS,
  RAYLEIGH_SCALE_HEIGHT_KM,
  MIE_SCALE_HEIGHT_KM,
  OZONE_CENTER_HEIGHT_KM,
  OZONE_WIDTH_KM,
  PLANET_RADIUS_KM,
  ATMOSPHERE_HEIGHT_KM,
} from './atmosphereConstants'

/** LUT width — `mu` axis sample count. 256 is the article's value. */
export const TRANSMITTANCE_LUT_WIDTH = 256
/** LUT height — altitude axis sample count. 64 is the article's value. */
export const TRANSMITTANCE_LUT_HEIGHT = 64

/**
 * Steps used when integrating each LUT pixel's transmittance.
 * Higher = more accurate LUT, but only computed once. 40 matches
 * common production implementations; the article uses ~30.
 */
const LUT_INTEGRATION_STEPS = 40

export interface AtmosphereLutData {
  readonly width: number
  readonly height: number
  /** RGBA8 pixels — transmittance per channel, alpha = 255. */
  readonly pixels: Uint8Array
}

/**
 * Module-scope memo of the compute output, keyed by `${width}x${height}`.
 * `createPhotorealEarth()` runs on every Orbit scale-preset change
 * (the photoreal stack rebuilds rather than mutating geometries), so
 * without the memo we'd re-integrate the LUT every preset swap.
 * The cached `pixels` is a `Uint8Array` view; consumers wrap it in
 * their own `DataTexture` / `gl.texImage2D` upload, so per-renderer
 * GPU state is still isolated.
 */
const lutCache = new Map<string, AtmosphereLutData>()

function rayleighDensity(h: number): number {
  return Math.exp(-Math.max(h, 0) / RAYLEIGH_SCALE_HEIGHT_KM)
}
function mieDensity(h: number): number {
  return Math.exp(-Math.max(h, 0) / MIE_SCALE_HEIGHT_KM)
}
function ozoneDensity(h: number): number {
  return Math.max(0, 1 - Math.abs(h - OZONE_CENTER_HEIGHT_KM) / OZONE_WIDTH_KM)
}

/**
 * Compute the transmittance LUT pixels. Returned `pixels` is laid
 * out row-major, with row 0 at altitude 0 (sea level) and the last
 * row at altitude `ATMOSPHERE_HEIGHT_KM`. Column 0 corresponds to
 * `mu = -1` (light coming up from below the horizon, planet-
 * occluded), column W-1 to `mu = +1` (light from straight overhead).
 *
 * Default size is 256×64. Override for finer or coarser LUTs.
 */
export function computeTransmittanceLut(
  width: number = TRANSMITTANCE_LUT_WIDTH,
  height: number = TRANSMITTANCE_LUT_HEIGHT,
): AtmosphereLutData {
  // The compute uses `x / (width - 1)` and `y / (height - 1)` to map
  // pixel indices onto mu / altitude; a 1×N or N×1 LUT divides by
  // zero. 2 is the minimum that lets bilinear filtering produce
  // anything meaningful anyway.
  if (width < 2 || height < 2) {
    throw new Error(
      `[atmosphereLut] width and height must each be >= 2 (got ${width}x${height})`,
    )
  }
  const cacheKey = `${width}x${height}`
  const cached = lutCache.get(cacheKey)
  if (cached) return cached

  const pixels = new Uint8Array(width * height * 4)
  const atmRadius = PLANET_RADIUS_KM + ATMOSPHERE_HEIGHT_KM
  const atmRadiusSq = atmRadius * atmRadius
  const planetRadiusSq = PLANET_RADIUS_KM * PLANET_RADIUS_KM

  for (let y = 0; y < height; y++) {
    const altitude = (y / (height - 1)) * ATMOSPHERE_HEIGHT_KM
    const radius = PLANET_RADIUS_KM + altitude
    // The LUT origin is (0, radius, 0). Any rotation about the up
    // axis would give the same integrated transmittance, so we just
    // sweep `mu` along the (X, Y) plane.

    for (let x = 0; x < width; x++) {
      const mu = (x / (width - 1)) * 2 - 1
      const sinTheta = Math.sqrt(Math.max(0, 1 - mu * mu))
      // rayDir = (sinTheta, mu, 0). origin · rayDir = radius·mu.
      const b = radius * mu

      // Ground-occlusion check: does the ray hit the planet sphere?
      // `planetNear >= 0` (not strictly >) is intentional — at sea
      // level (radius = PLANET_RADIUS), a straight-down ray gives
      // planetNear exactly 0 because the origin sits on the
      // surface. The ray still enters the planet immediately and
      // should be blocked.
      const discPlanet = b * b - (radius * radius - planetRadiusSq)
      const planetNear = discPlanet >= 0 ? -b - Math.sqrt(discPlanet) : -1

      const pi = (y * width + x) * 4
      if (planetNear >= 0) {
        // Light path occluded by the planet — zero transmittance.
        pixels[pi] = 0
        pixels[pi + 1] = 0
        pixels[pi + 2] = 0
        pixels[pi + 3] = 255
        continue
      }

      // Ray-atmosphere far intersection.
      const discAtm = b * b - (radius * radius - atmRadiusSq)
      const rayLen = discAtm >= 0 ? -b + Math.sqrt(discAtm) : 0
      if (rayLen <= 0) {
        // Origin is at or above the atmosphere and ray goes outward —
        // no atmosphere to integrate. Full transmittance.
        pixels[pi] = 255
        pixels[pi + 1] = 255
        pixels[pi + 2] = 255
        pixels[pi + 3] = 255
        continue
      }

      const stepSize = rayLen / LUT_INTEGRATION_STEPS
      let odR = 0
      let odM = 0
      let odO = 0
      for (let i = 0; i < LUT_INTEGRATION_STEPS; i++) {
        const t = (i + 0.5) * stepSize
        // Sample position = (sinTheta·t, radius + mu·t, 0).
        const sx = sinTheta * t
        const sy = radius + mu * t
        const sampleR = Math.sqrt(sx * sx + sy * sy)
        const h = sampleR - PLANET_RADIUS_KM
        if (h < 0 || h > ATMOSPHERE_HEIGHT_KM) continue
        odR += rayleighDensity(h) * stepSize
        odM += mieDensity(h) * stepSize
        odO += ozoneDensity(h) * stepSize
      }

      const tauR = RAYLEIGH_BETA[0] * odR + MIE_BETA_EXT[0] * odM + OZONE_BETA_ABS[0] * odO
      const tauG = RAYLEIGH_BETA[1] * odR + MIE_BETA_EXT[1] * odM + OZONE_BETA_ABS[1] * odO
      const tauB = RAYLEIGH_BETA[2] * odR + MIE_BETA_EXT[2] * odM + OZONE_BETA_ABS[2] * odO

      // Clamp to [0, 1] then scale to [0, 255]. Beer's law gives
      // exp(-tau) ∈ (0, 1], so the floor of 0 only matters for the
      // exp() of catastrophically large tau values.
      pixels[pi] = Math.round(Math.min(1, Math.max(0, Math.exp(-tauR))) * 255)
      pixels[pi + 1] = Math.round(Math.min(1, Math.max(0, Math.exp(-tauG))) * 255)
      pixels[pi + 2] = Math.round(Math.min(1, Math.max(0, Math.exp(-tauB))) * 255)
      pixels[pi + 3] = 255
    }
  }

  const result: AtmosphereLutData = { width, height, pixels }
  lutCache.set(cacheKey, result)
  return result
}

/**
 * Test-only: clear the LUT memo. Lets tests cover both the cold-
 * compute path and the cache-hit path within the same test file
 * without spawning a fresh module instance.
 *
 * @internal
 */
export function _resetLutCacheForTests(): void {
  lutCache.clear()
}
