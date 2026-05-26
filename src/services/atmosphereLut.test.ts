/**
 * Coverage for the CPU-side transmittance LUT computation.
 *
 * The LUT is pure-JS — it doesn't touch a GL context, a canvas, or
 * the DOM — so it's testable without a renderer. We assert the
 * physical invariants that any correct atmospheric model must
 * satisfy, not exact pixel values (which depend on the integration
 * step count and may shift slightly if those are tuned).
 */

import { describe, expect, it } from 'vitest'
import {
  TRANSMITTANCE_LUT_WIDTH,
  TRANSMITTANCE_LUT_HEIGHT,
  computeTransmittanceLut,
  _resetLutCacheForTests,
} from './atmosphereLut'

describe('computeTransmittanceLut', () => {
  // Compute once and share — the full LUT takes ~10-50ms and the
  // assertions below are read-only. The memoization test explicitly
  // resets the cache before exercising its own calls so its
  // assertions still hit the cold-then-warm path.
  const lut = computeTransmittanceLut()

  it('produces RGBA pixels at the default resolution', () => {
    expect(lut.width).toBe(TRANSMITTANCE_LUT_WIDTH)
    expect(lut.height).toBe(TRANSMITTANCE_LUT_HEIGHT)
    expect(lut.pixels).toHaveLength(TRANSMITTANCE_LUT_WIDTH * TRANSMITTANCE_LUT_HEIGHT * 4)
  })

  it('sets alpha to fully opaque for every pixel', () => {
    for (let i = 3; i < lut.pixels.length; i += 4) {
      expect(lut.pixels[i]).toBe(255)
    }
  })

  // Ray pointing straight down (mu = -1) from any altitude is blocked
  // by the planet — column 0 of every row should be zero.
  it('blocks straight-down rays at every altitude (planet occlusion)', () => {
    for (let y = 0; y < lut.height; y++) {
      const i = (y * lut.width + 0) * 4
      expect(lut.pixels[i]).toBe(0)
      expect(lut.pixels[i + 1]).toBe(0)
      expect(lut.pixels[i + 2]).toBe(0)
    }
  })

  // Ray pointing straight up (mu = +1) from the top of the atmosphere
  // — last row, last column — has no atmosphere to traverse, full
  // transmittance everywhere.
  it('passes light through unattenuated when the ray starts above the atmosphere top', () => {
    const lastRow = lut.height - 1
    const lastCol = lut.width - 1
    const i = (lastRow * lut.width + lastCol) * 4
    expect(lut.pixels[i]).toBe(255)
    expect(lut.pixels[i + 1]).toBe(255)
    expect(lut.pixels[i + 2]).toBe(255)
  })

  // Sea-level straight-up ray traverses the full atmosphere column.
  // Blue is more strongly scattered/absorbed than red (Rayleigh +
  // ozone), so the surviving transmittance must satisfy R > G > B.
  // Also asserts the values are in a sensible range (not zero, not
  // saturated to white).
  it('attenuates blue more than red along a sea-level zenith path', () => {
    // Last column = mu=+1 (straight up). Row 0 = sea level.
    const i = (0 * lut.width + (lut.width - 1)) * 4
    const r = lut.pixels[i]
    const g = lut.pixels[i + 1]
    const b = lut.pixels[i + 2]
    expect(r).toBeGreaterThan(b)
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
    // The sky is blue because of scattering, but enough red survives
    // the column for the sun-disc to remain colourful — sanity-check
    // the magnitude isn't catastrophically off.
    expect(r).toBeGreaterThan(100)
    expect(r).toBeLessThan(255)
    expect(b).toBeGreaterThan(0)
  })

  // Transmittance should monotonically increase as altitude increases
  // along a fixed zenith direction (less atmosphere above means less
  // attenuation). Check this for blue at mu=+1.
  it('increases with altitude along a fixed zenith direction', () => {
    const col = lut.width - 1
    let lastB = -1
    for (let y = 0; y < lut.height; y++) {
      const b = lut.pixels[(y * lut.width + col) * 4 + 2]
      expect(b).toBeGreaterThanOrEqual(lastB)
      lastB = b
    }
  })

  it('honours an explicit smaller LUT size', () => {
    const tiny = computeTransmittanceLut(16, 8)
    expect(tiny.width).toBe(16)
    expect(tiny.height).toBe(8)
    expect(tiny.pixels).toHaveLength(16 * 8 * 4)
  })

  it('throws when width or height is < 2 (would divide by zero)', () => {
    expect(() => computeTransmittanceLut(1, 64)).toThrow(/>= 2/)
    expect(() => computeTransmittanceLut(256, 1)).toThrow(/>= 2/)
    expect(() => computeTransmittanceLut(0, 0)).toThrow(/>= 2/)
  })

  it('memoizes results by size — second call returns the same object', () => {
    // Reset only here so the first compute below is guaranteed cold;
    // the read-only tests above don't need a clean cache.
    _resetLutCacheForTests()
    const a = computeTransmittanceLut(64, 32)
    const b = computeTransmittanceLut(64, 32)
    expect(b).toBe(a)
    expect(b.pixels).toBe(a.pixels)
    // Different sizes get independent entries.
    const c = computeTransmittanceLut(32, 16)
    expect(c).not.toBe(a)
  })
})
