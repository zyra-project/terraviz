// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the data-encoded video sidecar contract.
 *
 * The parser is fail-closed by design — a malformed sidecar must
 * return `null` so the caller falls back to treating the dataset as a
 * picture, rather than colouring real data through a half-valid
 * palette. Most of these cases pin that.
 */
import { describe, expect, it } from 'vitest'
import {
  buildColorScaleLut,
  COLOR_SCALE_LUT_SIZE,
  isTransparentLuma,
  lumaToValue,
  parseColorScale,
  type ColorScale,
} from './color-scale'

const VALID = {
  stops: [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 255, 255, 255] },
  ],
  vmin: 0,
  vmax: 100,
  units: 'mg m-2',
}

describe('parseColorScale', () => {
  it('accepts a well-formed sidecar as an object or a JSON string', () => {
    const fromObject = parseColorScale(VALID)
    const fromString = parseColorScale(JSON.stringify(VALID))
    expect(fromObject).not.toBeNull()
    expect(fromString).toEqual(fromObject)
    expect(fromObject?.vmin).toBe(0)
    expect(fromObject?.vmax).toBe(100)
    expect(fromObject?.units).toBe('mg m-2')
  })

  it('sorts stops rather than rejecting an out-of-order palette', () => {
    const scale = parseColorScale({
      ...VALID,
      stops: [
        { t: 1, rgba: [255, 255, 255, 255] },
        { t: 0.5, rgba: [128, 0, 0, 128] },
        { t: 0, rgba: [0, 0, 0, 0] },
      ],
    })
    expect(scale?.stops.map(s => s.t)).toEqual([0, 0.5, 1])
  })

  it.each([
    ['not an object', 42],
    ['null', null],
    ['unparseable JSON', '{nope'],
    ['no stops', { ...VALID, stops: undefined }],
    ['a single stop', { ...VALID, stops: [{ t: 0, rgba: [0, 0, 0, 0] }] }],
    ['a non-finite vmin', { ...VALID, vmin: Number.NaN }],
    ['a missing vmax', { ...VALID, vmax: undefined }],
    ['vmin === vmax (a zero-width range)', { ...VALID, vmin: 5, vmax: 5 }],
    ['a stop position outside [0,1]', { ...VALID, stops: [{ t: -0.1, rgba: [0, 0, 0, 0] }, VALID.stops[1]] }],
    ['a short rgba tuple', { ...VALID, stops: [{ t: 0, rgba: [0, 0, 0] }, VALID.stops[1]] }],
    ['an out-of-gamut channel', { ...VALID, stops: [{ t: 0, rgba: [0, 0, 0, 300] }, VALID.stops[1]] }],
  ])('returns null for %s', (_label, input) => {
    expect(parseColorScale(input)).toBeNull()
  })

  it('drops an empty units string and an out-of-range transparentRange', () => {
    const scale = parseColorScale({ ...VALID, units: '   ', transparentRange: 1.5 })
    expect(scale?.units).toBeUndefined()
    expect(scale?.transparentRange).toBeUndefined()
  })

  it('keeps a plausible transparentRange', () => {
    // The published smoke pipeline's value.
    expect(parseColorScale({ ...VALID, transparentRange: 12 / 256 })?.transparentRange)
      .toBeCloseTo(0.0469, 4)
  })
})

describe('buildColorScaleLut', () => {
  const scale = parseColorScale(VALID) as ColorScale

  it('produces one RGBA texel per 8-bit luma code', () => {
    expect(buildColorScaleLut(scale)).toHaveLength(COLOR_SCALE_LUT_SIZE * 4)
  })

  it('interpolates linearly between stops and pins both endpoints', () => {
    const lut = buildColorScaleLut(scale)
    expect([...lut.slice(0, 4)]).toEqual([0, 0, 0, 0])
    expect([...lut.slice(255 * 4, 256 * 4)]).toEqual([255, 255, 255, 255])
    // Midpoint of a black→white ramp.
    expect(lut[128 * 4]).toBeGreaterThan(126)
    expect(lut[128 * 4]).toBeLessThan(130)
  })

  it('honours multi-stop palettes at the stop positions', () => {
    const multi = parseColorScale({
      ...VALID,
      stops: [
        { t: 0, rgba: [0, 0, 0, 255] },
        { t: 0.5, rgba: [255, 0, 0, 255] },
        { t: 1, rgba: [255, 255, 0, 255] },
      ],
    }) as ColorScale
    const lut = buildColorScaleLut(multi)
    const mid = Math.round(0.5 * (COLOR_SCALE_LUT_SIZE - 1))
    expect(lut[mid * 4]).toBeGreaterThan(250) // red saturated
    expect(lut[mid * 4 + 1]).toBeLessThan(5) // green not yet risen
  })

  it('forces alpha to zero below transparentRange', () => {
    // A palette whose own low end already carries alpha — the cutoff
    // has to win, otherwise near-zero values haze the whole globe.
    const opaqueLow = parseColorScale({
      ...VALID,
      stops: [
        { t: 0, rgba: [10, 10, 10, 200] },
        { t: 1, rgba: [255, 255, 255, 255] },
      ],
      transparentRange: 0.1,
    }) as ColorScale
    const lut = buildColorScaleLut(opaqueLow)
    expect(lut[0 * 4 + 3]).toBe(0)
    expect(lut[10 * 4 + 3]).toBe(0) // 10/255 = 0.039 < 0.1
    expect(lut[200 * 4 + 3]).toBeGreaterThan(0)
  })
})

describe('lumaToValue', () => {
  const scale = parseColorScale({ ...VALID, vmin: -10, vmax: 30 }) as ColorScale

  it('maps the endpoints and the midpoint of the code range', () => {
    expect(lumaToValue(0, scale)).toBe(-10)
    expect(lumaToValue(255, scale)).toBe(30)
    expect(lumaToValue(127.5, scale)).toBeCloseTo(10, 6)
  })

  it('round-trips within one 8-bit step', () => {
    // The fidelity budget the design sets: a recovered value must sit
    // within one code level of the value that was encoded.
    const step = (scale.vmax - scale.vmin) / 255
    for (const luma of [0, 1, 64, 128, 200, 255]) {
      const value = lumaToValue(luma, scale)
      const back = ((value - scale.vmin) / (scale.vmax - scale.vmin)) * 255
      expect(Math.abs(back - luma) * step).toBeLessThanOrEqual(step)
    }
  })
})

describe('isTransparentLuma', () => {
  it('reports the no-data band, and nothing when no cutoff is declared', () => {
    const withCutoff = parseColorScale({ ...VALID, transparentRange: 12 / 256 }) as ColorScale
    expect(isTransparentLuma(0, withCutoff)).toBe(true)
    expect(isTransparentLuma(11, withCutoff)).toBe(true)
    expect(isTransparentLuma(64, withCutoff)).toBe(false)

    const noCutoff = parseColorScale(VALID) as ColorScale
    expect(isTransparentLuma(0, noCutoff)).toBe(false)
  })
})

/**
 * `dataMinLuma` — the reserved no-data band.
 *
 * The compatibility guarantee is meant to fall out of the arithmetic
 * rather than out of a branch, so the first test here is the one that
 * matters: absent and 0 must agree on every code, in both the value
 * mapping and the LUT. If that ever fails, every dataset published
 * before the field existed has silently changed meaning.
 */
describe('dataMinLuma', () => {
  const BAND = 12

  it('is byte-identical to the previous contract when absent or zero', () => {
    const absent = parseColorScale({ ...VALID, vmin: -10, vmax: 30 }) as ColorScale
    const zero = parseColorScale({ ...VALID, vmin: -10, vmax: 30, dataMinLuma: 0 }) as ColorScale

    for (let luma = 0; luma < COLOR_SCALE_LUT_SIZE; luma++) {
      expect(lumaToValue(luma, zero)).toBe(lumaToValue(luma, absent))
      expect(isTransparentLuma(luma, zero)).toBe(isTransparentLuma(luma, absent))
    }
    expect([...buildColorScaleLut(zero)]).toEqual([...buildColorScaleLut(absent)])
  })

  it.each([
    ['a non-integer code', 11.5],
    ['a negative code', -1],
    ['255, which leaves a single data code and a zero denominator', 255],
    ['a code past the 8-bit range', 300],
    ['a string', '12'],
    ['NaN', Number.NaN],
  ])('rejects the whole sidecar for %s', (_label, dataMinLuma) => {
    expect(parseColorScale({ ...VALID, dataMinLuma })).toBeNull()
  })

  it('keeps a well-formed band', () => {
    expect(parseColorScale({ ...VALID, dataMinLuma: BAND })?.dataMinLuma).toBe(BAND)
  })

  it('rejects a transparentRange that disagrees about where data starts', () => {
    // 0.2 would hide codes up to 50 while the band claims data from 12:
    // codes 12..50 would be real values drawn as nothing.
    expect(parseColorScale({ ...VALID, dataMinLuma: BAND, transparentRange: 0.2 })).toBeNull()
    // And the other direction — colour on screen where the readout
    // would report "no data".
    expect(parseColorScale({ ...VALID, dataMinLuma: 50, transparentRange: 12 / 256 })).toBeNull()
  })

  it('accepts the two fields when they describe the same boundary', () => {
    // The published smoke pipeline's cutoff, stated both ways.
    const scale = parseColorScale({ ...VALID, dataMinLuma: BAND, transparentRange: 12 / 256 })
    expect(scale?.dataMinLuma).toBe(BAND)
    expect(scale?.transparentRange).toBeCloseTo(0.0469, 4)
  })

  it('puts vmin at the first data code, not at zero', () => {
    const scale = parseColorScale({
      ...VALID, vmin: -10, vmax: 30, dataMinLuma: BAND,
    }) as ColorScale
    expect(lumaToValue(BAND, scale)).toBe(-10)
    expect(lumaToValue(255, scale)).toBe(30)
    // Un-clamped below the band, so a caller that skipped the
    // `isTransparentLuma` check gets an obviously out-of-range number
    // rather than a plausible one sitting exactly on vmin.
    expect(lumaToValue(0, scale)).toBeLessThan(-10)
  })

  it('reports the band as no-data, and wins over transparentRange', () => {
    const scale = parseColorScale({ ...VALID, dataMinLuma: BAND }) as ColorScale
    expect(isTransparentLuma(0, scale)).toBe(true)
    expect(isTransparentLuma(BAND - 1, scale)).toBe(true)
    expect(isTransparentLuma(BAND, scale)).toBe(false)
    expect(isTransparentLuma(255, scale)).toBe(false)
  })

  it('zeroes alpha across the band and rebases the palette onto the data', () => {
    const scale = parseColorScale({
      ...VALID,
      // An opaque low end, so a surviving alpha would be the palette's
      // rather than an accident of the ramp.
      stops: [
        { t: 0, rgba: [10, 10, 10, 200] },
        { t: 1, rgba: [255, 255, 255, 255] },
      ],
      dataMinLuma: BAND,
    }) as ColorScale
    const lut = buildColorScaleLut(scale)

    for (let i = 0; i < BAND; i++) expect(lut[i * 4 + 3]).toBe(0)
    expect(lut[BAND * 4 + 3]).toBe(200)

    // The palette spans [BAND, 255], not [0, 255]: the first data code
    // takes the stop at t=0 and the last takes t=1. Without the rebase
    // the colorbar's labels sit a band's width off its colours.
    expect(lut[BAND * 4]).toBe(10)
    expect(lut[255 * 4]).toBe(255)
    const mid = BAND + Math.round((255 - BAND) / 2)
    expect(lut[mid * 4]).toBeGreaterThan(130)
    expect(lut[mid * 4]).toBeLessThan(136)
  })
})
