// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the data-encoded display transforms.
 *
 * The invariant under test throughout is the one in the module's
 * docstring: **a display transform never changes a reported value.**
 * Every assertion about colour is paired, where it could plausibly
 * regress, with one asserting that `lumaToValue` is untouched — because
 * a stretch that quietly rescaled the values would produce a globe
 * whose colours and whose readout disagree, and only one of those is
 * visible.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DISPLAY,
  PALETTE_IDS,
  buildDisplayLut,
  colorbarTicks,
  dataQuantileOfLuma,
  displayGradientStops,
  fractionKept,
  lumaAtDataQuantile,
  isDefaultDisplay,
  positionOfValue,
  valueAtPosition,
  type ColorScaleDisplay,
} from './colorScaleDisplay'
import { buildColorScaleLut, lumaToValue, type ColorScale } from '../types/color-scale'

/** A ramp that fades in over its low end, like the shipped smoke
 *  palettes: alpha 0 through the transparent band, then rising. */
const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [255, 255, 229, 0] },
    { t: 0.5, rgba: [254, 153, 41, 128] },
    { t: 1, rgba: [102, 37, 6, 255] },
  ],
  vmin: 0,
  vmax: 0.0005,
  units: 'kg m-2',
  transparentRange: 12 / 256,
}

const display = (over: Partial<ColorScaleDisplay> = {}): ColorScaleDisplay => ({
  ...DEFAULT_DISPLAY,
  ...over,
  stretch: { ...DEFAULT_DISPLAY.stretch, ...over.stretch },
  threshold: { ...DEFAULT_DISPLAY.threshold, ...over.threshold },
})

const alphaAt = (lut: Uint8Array, luma: number) => lut[luma * 4 + 3]
const rgbAt = (lut: Uint8Array, luma: number) =>
  [lut[luma * 4], lut[luma * 4 + 1], lut[luma * 4 + 2]] as const

describe('isDefaultDisplay', () => {
  it('recognises the identity and anything off it', () => {
    expect(isDefaultDisplay(DEFAULT_DISPLAY)).toBe(true)
    expect(isDefaultDisplay(display({ palette: 'viridis' }))).toBe(false)
    expect(isDefaultDisplay(display({ stretch: { lo: 0.1, hi: 1 } }))).toBe(false)
    expect(isDefaultDisplay(display({ threshold: { min: 0.0001, max: null } }))).toBe(false)
  })
})

describe('buildDisplayLut — the identity', () => {
  it('reproduces the shared builder exactly when nothing is set', () => {
    // If this drifts, every data-encoded dataset changes appearance the
    // moment the display layer is wired in, with no user action.
    const plain = buildColorScaleLut(SCALE)
    const viaDisplay = buildDisplayLut(SCALE, DEFAULT_DISPLAY)
    expect([...viaDisplay]).toEqual([...plain])
  })
})

describe('buildDisplayLut — palette swap', () => {
  it('replaces the colours', () => {
    const src = buildDisplayLut(SCALE, DEFAULT_DISPLAY)
    const viridis = buildDisplayLut(SCALE, display({ palette: 'viridis' }))
    expect(rgbAt(viridis, 255)).not.toEqual(rgbAt(src, 255))
    // Viridis tops out at its yellow end.
    expect(rgbAt(viridis, 255)).toEqual([253, 231, 37])
    expect(rgbAt(viridis, 12)).not.toEqual(rgbAt(src, 12))
  })

  it('keeps the dataset own alpha profile rather than the ramp opaque one', () => {
    // The ramps are opaque throughout. Taking their alpha would turn
    // the bounding box into a solid rectangle — every colour correct,
    // and obviously broken.
    const src = buildDisplayLut(SCALE, DEFAULT_DISPLAY)
    for (const palette of PALETTE_IDS) {
      const lut = buildDisplayLut(SCALE, display({ palette }))
      for (const luma of [0, 11, 12, 64, 128, 200, 255]) {
        expect(alphaAt(lut, luma)).toBe(alphaAt(src, luma))
      }
    }
  })

  it('keeps the nodata band fully transparent under every palette', () => {
    for (const palette of PALETTE_IDS) {
      const lut = buildDisplayLut(SCALE, display({ palette }))
      expect(alphaAt(lut, 0)).toBe(0)
      expect(alphaAt(lut, 11)).toBe(0)
    }
  })

  it('offers grayscale as a true ramp', () => {
    const lut = buildDisplayLut(SCALE, display({ palette: 'grayscale' }))
    expect(rgbAt(lut, 255)).toEqual([255, 255, 255])
    const mid = rgbAt(lut, 128)
    expect(mid[0]).toBe(mid[1])
    expect(mid[1]).toBe(mid[2])
  })
})

describe('buildDisplayLut — stretch', () => {
  it('spreads the ramp across the sub-range', () => {
    // With lo=0, hi=0.5 the palette top lands at luma 128 rather than 255.
    const lut = buildDisplayLut(SCALE, display({ stretch: { lo: 0, hi: 0.5 } }))
    const plain = buildColorScaleLut(SCALE)
    expect(rgbAt(lut, 128)).toEqual(rgbAt(plain, 255))
  })

  it('clamps outside the stretched range instead of wrapping', () => {
    const lut = buildDisplayLut(SCALE, display({ stretch: { lo: 0.25, hi: 0.5 } }))
    // Everything above hi holds the ramp top colour.
    expect(rgbAt(lut, 200)).toEqual(rgbAt(lut, 255))
    // Everything below lo holds the ramp bottom colour (above the
    // nodata band, which is transparent regardless).
    expect(rgbAt(lut, 20)).toEqual(rgbAt(lut, 60))
  })

  it('tolerates a reversed range by ordering it', () => {
    const forward = buildDisplayLut(SCALE, display({ stretch: { lo: 0.2, hi: 0.8 } }))
    const reversed = buildDisplayLut(SCALE, display({ stretch: { lo: 0.8, hi: 0.2 } }))
    expect([...reversed]).toEqual([...forward])
  })

  it('falls back to identity on a zero-width stretch', () => {
    // Dividing by zero here would paint the globe one flat colour,
    // which reads as a rendering failure rather than as a setting.
    const lut = buildDisplayLut(SCALE, display({ stretch: { lo: 0.4, hi: 0.4 } }))
    expect([...lut]).toEqual([...buildColorScaleLut(SCALE)])
  })

  it('leaves the nodata band transparent no matter where the stretch sits', () => {
    const lut = buildDisplayLut(SCALE, display({ stretch: { lo: 0, hi: 0.02 } }))
    expect(alphaAt(lut, 0)).toBe(0)
    expect(alphaAt(lut, 11)).toBe(0)
  })

  it('does not move any value', () => {
    // The whole point. A stretch changes colour, never arithmetic.
    for (const luma of [12, 50, 128, 255]) {
      const before = lumaToValue(luma, SCALE)
      buildDisplayLut(SCALE, display({ stretch: { lo: 0.1, hi: 0.3 } }))
      expect(lumaToValue(luma, SCALE)).toBe(before)
    }
  })
})

describe('buildDisplayLut — a band declared as dataMinLuma', () => {
  /** The same band as `SCALE`, spelled the other way the contract
   *  allows: `dataMinLuma` alone, with no `transparentRange` beside it.
   *  `parseColorScale` accepts this — it only requires the two to agree
   *  when *both* are present — so the display path has to honour the
   *  band unaided. Note this is not the same scale as `SCALE`: with the
   *  band declared, the palette spans the data codes rather than all
   *  256, so both the colours and `lumaToValue` legitimately differ. */
  const BAND_ONLY: ColorScale = {
    stops: SCALE.stops,
    vmin: SCALE.vmin,
    vmax: SCALE.vmax,
    units: SCALE.units,
    dataMinLuma: 12,
  }

  it('is transparent at the identity, where the source alpha still lines up', () => {
    // Not the interesting case — but it is why the gap stayed hidden.
    // Unstretched, each texel's alpha is copied from its own index in
    // the source LUT, where the band is already zeroed, so nothing here
    // depends on the explicit band test at all.
    const lut = buildDisplayLut(BAND_ONLY, display())
    expect(alphaAt(lut, 0)).toBe(0)
    expect(alphaAt(lut, 11)).toBe(0)
    expect(alphaAt(lut, 128)).toBeGreaterThan(0)
  })

  it('stays transparent under a stretch anchored at the low end', () => {
    // The regression. A stretch pulls each texel's alpha from a *higher*
    // source index, so the band's own zeroes slide out from under it and
    // the reserved codes take alpha from real data — painting "nothing
    // measured here" as measurement. Low-anchored is the common case
    // rather than a corner: these fields put most of their data just
    // above the band, which is what `lumaAtDataQuantile` exists for.
    for (const hi of [0.1, 0.25, 0.5]) {
      const lut = buildDisplayLut(BAND_ONLY, display({ stretch: { lo: 0, hi } }))
      for (let luma = 0; luma < 12; luma++) {
        expect(alphaAt(lut, luma), `luma ${luma} under stretch 0..${hi}`).toBe(0)
      }
      expect(alphaAt(lut, 128)).toBeGreaterThan(0)
    }
  })

  it('is unchanged by a redundant transparentRange alongside it', () => {
    // A well-formed sidecar may carry both fields, and the parser has
    // already established they agree. The display path must therefore
    // not care which arrived — same band, same LUT, byte for byte.
    const BOTH: ColorScale = { ...BAND_ONLY, transparentRange: 12 / 256 }
    for (const d of [display(), display({ stretch: { lo: 0, hi: 0.1 } })]) {
      expect([...buildDisplayLut(BOTH, d)]).toEqual([...buildDisplayLut(BAND_ONLY, d)])
    }
  })

  it('still applies a threshold to the data codes above the band', () => {
    // The band is settled first, but it must not short-circuit the
    // threshold for everything else.
    const lut = buildDisplayLut(BAND_ONLY, display({ threshold: { min: null, max: 0.0002 } }))
    expect(alphaAt(lut, 0)).toBe(0)
    expect(alphaAt(lut, 11)).toBe(0)
    expect(alphaAt(lut, 50)).toBeGreaterThan(0)
    expect(alphaAt(lut, 200)).toBe(0)
  })
})

describe('buildDisplayLut — threshold', () => {
  it('hides values below the minimum', () => {
    // Half-scale on a 0..5e-4 range.
    const lut = buildDisplayLut(SCALE, display({ threshold: { min: 0.00025, max: null } }))
    expect(alphaAt(lut, 100)).toBe(0)
    expect(alphaAt(lut, 255)).toBeGreaterThan(0)
  })

  it('hides values above the maximum', () => {
    const lut = buildDisplayLut(SCALE, display({ threshold: { min: null, max: 0.00025 } }))
    expect(alphaAt(lut, 255)).toBe(0)
    expect(alphaAt(lut, 100)).toBeGreaterThan(0)
  })

  it('keeps only the band between both bounds', () => {
    const lut = buildDisplayLut(SCALE, display({
      threshold: { min: 0.0002, max: 0.0003 },
    }))
    expect(alphaAt(lut, 60)).toBe(0)
    expect(alphaAt(lut, 140)).toBeGreaterThan(0)
    expect(alphaAt(lut, 240)).toBe(0)
  })

  it('is inclusive at both bounds', () => {
    const at128 = lumaToValue(128, SCALE)
    const lut = buildDisplayLut(SCALE, display({ threshold: { min: at128, max: at128 } }))
    expect(alphaAt(lut, 128)).toBeGreaterThan(0)
  })

  it('composes with a stretch without either winning', () => {
    const lut = buildDisplayLut(SCALE, display({
      stretch: { lo: 0, hi: 0.5 },
      threshold: { min: 0.00025, max: null },
    }))
    // Threshold is in physical units, so it still cuts at luma 128
    // regardless of where the stretch put the colours.
    expect(alphaAt(lut, 100)).toBe(0)
    expect(alphaAt(lut, 200)).toBeGreaterThan(0)
  })
})

describe('valueAtPosition / positionOfValue', () => {
  it('spans the full range with no stretch', () => {
    expect(valueAtPosition(SCALE, DEFAULT_DISPLAY, 0)).toBeCloseTo(0, 12)
    expect(valueAtPosition(SCALE, DEFAULT_DISPLAY, 1)).toBeCloseTo(0.0005, 12)
    expect(valueAtPosition(SCALE, DEFAULT_DISPLAY, 0.5)).toBeCloseTo(0.00025, 12)
  })

  it('reports the sub-range in view when stretched', () => {
    // A colorbar that kept showing the full range while the globe
    // showed a tenth of it would be a lie in the most authoritative
    // place on screen.
    const d = display({ stretch: { lo: 0.2, hi: 0.4 } })
    expect(valueAtPosition(SCALE, d, 0)).toBeCloseTo(0.0001, 12)
    expect(valueAtPosition(SCALE, d, 1)).toBeCloseTo(0.0002, 12)
  })

  it('round-trips against positionOfValue', () => {
    for (const d of [DEFAULT_DISPLAY, display({ stretch: { lo: 0.1, hi: 0.9 } })]) {
      for (const p of [0, 0.25, 0.5, 0.75, 1]) {
        expect(positionOfValue(SCALE, d, valueAtPosition(SCALE, d, p))).toBeCloseTo(p, 9)
      }
    }
  })

  it('clamps a position outside the bar', () => {
    expect(valueAtPosition(SCALE, DEFAULT_DISPLAY, -1)).toBeCloseTo(0, 12)
    expect(valueAtPosition(SCALE, DEFAULT_DISPLAY, 2)).toBeCloseTo(0.0005, 12)
    expect(positionOfValue(SCALE, DEFAULT_DISPLAY, 999)).toBe(1)
    expect(positionOfValue(SCALE, DEFAULT_DISPLAY, -999)).toBe(0)
  })
})

describe('colorbarTicks', () => {
  it('lands on round numbers, not even fractions', () => {
    const ticks = colorbarTicks(SCALE, DEFAULT_DISPLAY, 5)
    expect(ticks.length).toBeGreaterThan(2)
    // 0..5e-4 in five: the nice step is 1e-4.
    for (const t of ticks) {
      const multiples = t.value / 0.0001
      expect(multiples).toBeCloseTo(Math.round(multiples), 6)
    }
  })

  it('gets near the requested count instead of overshooting the step', () => {
    // Regression: the MPAS reflectivity field, −35..78.025 dBZ. The step
    // snapper took the first 1/2/5 candidate at or *above* the rough
    // step, so a rough 23.3 became 50 rather than 20 — and 2→5 is a
    // factor of 2.5, so the count halved. Asking for five gave two.
    const dbz: ColorScale = {
      stops: [
        { t: 0, rgba: [0, 0, 0, 0] },
        { t: 1, rgba: [255, 255, 255, 255] },
      ],
      vmin: -35,
      vmax: 78.025,
      units: 'dBZ',
      dataMinLuma: 8,
    }
    for (const target of [4, 5]) {
      const ticks = colorbarTicks(dbz, DEFAULT_DISPLAY, target)
      // Two isolines across a whole field is not a contour plot; the
      // Analyze panel reads its levels from exactly this function.
      expect(ticks.length).toBeGreaterThanOrEqual(target - 1)
      expect(ticks.length).toBeLessThanOrEqual(target + 1)
    }
  })

  it('never labels a tick negative zero', () => {
    // `Math.ceil` of a fraction in (−1, 0) returns −0, which survives
    // the multiplication and renders as "-0" through `toFixed` — so a
    // bar straddling zero labelled its own origin "-0".
    const straddling: ColorScale = {
      stops: [
        { t: 0, rgba: [0, 0, 0, 0] },
        { t: 1, rgba: [255, 255, 255, 255] },
      ],
      vmin: -35,
      vmax: 78.025,
      units: 'dBZ',
      dataMinLuma: 8,
    }
    for (const target of [2, 3, 4, 5, 6, 8]) {
      for (const t of colorbarTicks(straddling, DEFAULT_DISPLAY, target)) {
        expect(Object.is(t.value, -0)).toBe(false)
      }
    }
  })

  it('keeps every tick inside the bar', () => {
    for (const d of [DEFAULT_DISPLAY, display({ stretch: { lo: 0.37, hi: 0.62 } })]) {
      for (const t of colorbarTicks(SCALE, d, 5)) {
        expect(t.position).toBeGreaterThanOrEqual(-1e-9)
        expect(t.position).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('follows a stretch into an awkward sub-range', () => {
    const d = display({ stretch: { lo: 0.073, hi: 0.481 } })
    const ticks = colorbarTicks(SCALE, d, 5)
    expect(ticks.length).toBeGreaterThan(1)
    const lo = valueAtPosition(SCALE, d, 0)
    const hi = valueAtPosition(SCALE, d, 1)
    for (const t of ticks) {
      expect(t.value).toBeGreaterThanOrEqual(lo - 1e-12)
      expect(t.value).toBeLessThanOrEqual(hi + 1e-12)
    }
  })

  it('handles a negative range, for the diverging fields A0 unblocks', () => {
    const anomaly: ColorScale = { ...SCALE, vmin: -10, vmax: 10, units: 'K' }
    const ticks = colorbarTicks(anomaly, DEFAULT_DISPLAY, 5)
    expect(ticks.some((t) => t.value < 0)).toBe(true)
    expect(ticks.some((t) => t.value > 0)).toBe(true)
    expect(ticks.some((t) => Math.abs(t.value) < 1e-9)).toBe(true)
  })

  it('returns nothing rather than hanging on a degenerate range', () => {
    // vmin === vmax is rejected by parseColorScale, but a stretch can
    // still collapse the displayed span; a loop that never terminates
    // here would take the frame with it.
    const flat: ColorScale = { ...SCALE, vmin: 5, vmax: 5 }
    expect(colorbarTicks(flat, DEFAULT_DISPLAY, 5)).toEqual([])
  })
})

describe('displayGradientStops', () => {
  it('samples the same LUT the shader gets', () => {
    const d = display({ palette: 'viridis' })
    const lut = buildDisplayLut(SCALE, d)
    const stops = displayGradientStops(SCALE, d, 8)
    expect(stops).toHaveLength(8)
    expect(stops[0].position).toBe(0)
    expect(stops[7].position).toBe(1)
    expect(stops[7].rgba.slice(0, 3)).toEqual([...rgbAt(lut, 255)])
  })

  it('shows the threshold as a transparent band in the bar', () => {
    // The bar and the globe hide the same values, which is what makes a
    // threshold legible rather than mysterious.
    const stops = displayGradientStops(
      SCALE, display({ threshold: { min: null, max: 0.00025 } }), 16)
    expect(stops.at(-1)!.rgba[3]).toBe(0)
    expect(stops[8].rgba[3]).toBe(0)
  })

  it('samples the stretched sub-range, not the bar position', () => {
    // Sampling the wrong one draws a bar that does not match the globe.
    const d = display({ stretch: { lo: 0.5, hi: 1 } })
    const stops = displayGradientStops(SCALE, d, 4)
    const lut = buildDisplayLut(SCALE, d)
    expect(stops[0].rgba.slice(0, 3)).toEqual([...rgbAt(lut, 128)])
    expect(stops[3].rgba.slice(0, 3)).toEqual([...rgbAt(lut, 255)])
  })
})

describe('data-quantile control placement', () => {
  // The distribution that motivated this: measured on a published RRFS
  // smoke frame, 88% of the frame is absent and of the rest half sits
  // below 8% of a linear slider's travel. Approximated here by piling
  // the weight into the bottom of the range.
  const skewed = (): Float64Array => {
    const w = new Float64Array(256)
    for (let l = 12; l < 30; l++) w[l] = 1000 // the bulk, near the floor
    for (let l = 30; l < 140; l++) w[l] = 10
    for (let l = 140; l < 256; l++) w[l] = 0.1 // the long, near-empty tail
    return w
  }

  it('puts half the data at half the travel', () => {
    // The whole point. Linear placement puts the median at ~8%.
    const w = skewed()
    const mid = lumaAtDataQuantile(w, 0.5)
    let below = 0
    let total = 0
    for (let l = 0; l < 256; l++) {
      total += w[l]
      if (l <= mid) below += w[l]
    }
    expect(below / total).toBeGreaterThan(0.45)
    expect(below / total).toBeLessThan(0.55)
    // …and that median is far below where a linear slider would put it.
    expect(mid).toBeLessThan(0.25 * 255)
  })

  it('spans the ends exactly', () => {
    const w = skewed()
    expect(lumaAtDataQuantile(w, 0)).toBeGreaterThanOrEqual(12)
    expect(lumaAtDataQuantile(w, 1)).toBe(255)
  })

  it('round-trips against dataQuantileOfLuma', () => {
    const w = skewed()
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const luma = lumaAtDataQuantile(w, p)
      expect(dataQuantileOfLuma(w, luma)).toBeCloseTo(p, 1)
    }
  })

  it('falls back to linear when no distribution is available', () => {
    // No WebGL2, or no frame decoded yet. Wrong in the old way, never
    // worse, and never throwing.
    expect(lumaAtDataQuantile(null, 0.5)).toBeCloseTo(127.5, 6)
    expect(lumaAtDataQuantile(undefined, 1)).toBe(255)
    expect(dataQuantileOfLuma(null, 255)).toBeCloseTo(1, 6)
  })

  it('falls back to linear for an all-empty distribution', () => {
    const empty = new Float64Array(256)
    expect(lumaAtDataQuantile(empty, 0.5)).toBeCloseTo(127.5, 6)
    expect(dataQuantileOfLuma(empty, 128)).toBeCloseTo(128 / 255, 6)
  })

  it('clamps positions outside the track', () => {
    const w = skewed()
    expect(lumaAtDataQuantile(w, -1)).toBe(lumaAtDataQuantile(w, 0))
    expect(lumaAtDataQuantile(w, 2)).toBe(lumaAtDataQuantile(w, 1))
  })
})

describe('fractionKept', () => {
  const w = (): Float64Array => {
    const a = new Float64Array(256)
    a[50] = 3
    a[200] = 1
    return a
  }

  it('reports how much of the field a threshold keeps', () => {
    // The number the old readout did not have: "only X and below" kept
    // 99.8% of the real frame and looked like it had done nothing.
    expect(fractionKept(w(), SCALE, { min: null, max: null })).toBeCloseTo(1, 6)
    expect(fractionKept(w(), SCALE, { min: null, max: lumaToValue(100, SCALE) }))
      .toBeCloseTo(0.75, 6)
    expect(fractionKept(w(), SCALE, { min: lumaToValue(100, SCALE), max: null }))
      .toBeCloseTo(0.25, 6)
  })

  it('is null when the distribution is unknown, rather than guessing', () => {
    expect(fractionKept(null, SCALE, { min: 1, max: null })).toBeNull()
  })
})
