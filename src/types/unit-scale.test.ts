// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the readable-units restatement.
 *
 * Two failure modes matter and they pull in opposite directions. One
 * is doing nothing — the RRFS smoke legend printing `0.0000002`, which
 * is what this exists to fix. The other is doing something wrong: a
 * relabel that moves the number without moving the unit, or that
 * "fixes" a unit no prefix belongs on, misreports every value in the
 * dataset while looking tidier than before. Most of these cases pin
 * the refusals.
 */
import { describe, expect, it } from 'vitest'
import { chooseUnitRescale, shiftDecimalExponent, toDisplayUnits } from './unit-scale'
import { lumaToValue, type ColorScale } from './color-scale'

const STOPS = [
  { t: 0, rgba: [0, 0, 0, 0] as [number, number, number, number] },
  { t: 1, rgba: [255, 255, 255, 255] as [number, number, number, number] },
]

function scale(over: Partial<ColorScale>): ColorScale {
  return { stops: STOPS, vmin: 0, vmax: 1, ...over }
}

describe('chooseUnitRescale', () => {
  it('turns the RRFS near-surface smoke range into micrograms', () => {
    // The case that motivated all of this: 0 to 2e-7 kg m-3 is 0 to
    // 200 µg m-3, which is how air quality is stated everywhere else.
    expect(chooseUnitRescale('kg m-3', 2e-7)).toEqual({ shift: 9, units: 'µg m-3' })
  })

  it('turns vertically integrated smoke into milligrams', () => {
    // The column-loading sibling of the case above, and the same
    // problem: `kg m-2` with a p99.9 around 5e-4. The whole plausible
    // band for this field — background through heavy plume — lands in
    // mg m-2, so the legend reads 0 to 500 rather than 0 to 0.0005.
    expect(chooseUnitRescale('kg m-2', 5e-4)).toEqual({ shift: 6, units: 'mg m-2' })
    expect(chooseUnitRescale('kg m-2', 2e-4)?.units).toBe('mg m-2')
    expect(chooseUnitRescale('kg m-2', 7e-4)?.units).toBe('mg m-2')
    expect(chooseUnitRescale('kg m-2', 1e-6)?.units).toBe('mg m-2')
  })

  it('agrees with the quantisation step the plan doc quotes', () => {
    // `docs/DATA_ENCODED_VIDEO_PLAN.md` states the shipped column
    // dataset's encoder RMSE as "1.96 mg m-2 against a 1.96 mg m-2
    // quantisation" — a number its author reached by converting out of
    // `kg m-2` by hand, because that is the unit the field is legible
    // in. Landing on the same one is the check that this module picks
    // what a person would have picked.
    const shown = toDisplayUnits(scale({ vmin: 0, vmax: 5e-4, units: 'kg m-2' }))
    expect(shown.units).toBe('mg m-2')
    expect((shown.vmax - shown.vmin) / 255).toBeCloseTo(1.96, 2)
  })

  it('aims for the [1, 1000) decade rather than the nearest prefix', () => {
    // 9.99e-7 kg m-3 is 999 µg m-3, not 0.999 mg m-3 — the point is to
    // spend the digits before the decimal point, not after it.
    expect(chooseUnitRescale('kg m-3', 9.99e-7)?.units).toBe('µg m-3')
    expect(chooseUnitRescale('kg m-3', 1e-6)?.units).toBe('mg m-3')
  })

  it('handles a magnitude sitting exactly on a decade boundary', () => {
    // Math.log10 of an exact power of ten can land either side of the
    // integer. Every one of these must pick the prefix that leaves the
    // magnitude at 1, not the one that leaves it at 1000.
    for (const [exponent, units] of [[-6, 'mg m-3'], [-9, 'µg m-3'], [-12, 'ng m-3']] as const) {
      const chosen = chooseUnitRescale('kg m-3', 10 ** exponent)
      expect(chosen?.units, `10^${exponent}`).toBe(units)
      expect(shiftDecimalExponent(10 ** exponent, chosen!.shift), `10^${exponent}`).toBe(1)
    }
  })

  it('scales up as well as down', () => {
    expect(chooseUnitRescale('J m-2', 4e9)).toEqual({ shift: -9, units: 'GJ m-2' })
  })

  it('leaves an already-readable range alone', () => {
    expect(chooseUnitRescale('K', 320)).toBeNull()
    expect(chooseUnitRescale('hPa', 1013)).toBeNull()
    expect(chooseUnitRescale('mg m-2', 0.5)).toBeNull()
    expect(chooseUnitRescale('m s-1', 60)).toBeNull()
  })

  it('leaves a unit no SI prefix belongs on alone', () => {
    for (const units of ['%', '1', 'ppbv', 'dBZ', 'index', 'unitless', 'AOD']) {
      expect(chooseUnitRescale(units, 2e-7), units).toBeNull()
    }
  })

  it('does not mistake a multi-letter symbol for a prefixed one', () => {
    // `min` is a minute, not a milli-`in`; `mol` is a mole, not a
    // milli-`ol`; `deg` is not a deci-`eg`. Splitting greedily here
    // would relabel a time axis as something 1000x its own size.
    expect(chooseUnitRescale('min', 2e-7)).toBeNull()
    expect(chooseUnitRescale('deg', 2e-7)).toBeNull()
    // Same magnitude, same shift, units three orders apart: the `m` in
    // `mmol` was read as milli and the one in `mol` was not read at all.
    expect(chooseUnitRescale('mol m-2', 2e-7)).toEqual({ shift: 9, units: 'nmol m-2' })
    expect(chooseUnitRescale('mmol m-2', 2e-7)).toEqual({ shift: 9, units: 'pmol m-2' })
  })

  it('refuses a leading factor carrying an exponent', () => {
    // Shifting a prefix on a squared term moves the value by twice the
    // shift. Getting that silently wrong is worse than a long number.
    expect(chooseUnitRescale('m2 s-1', 2e-7)).toBeNull()
    expect(chooseUnitRescale('m^2', 2e-7)).toBeNull()
    expect(chooseUnitRescale('kg2 m-3', 2e-7)).toBeNull()
  })

  it('refuses a string that does not start with a factor', () => {
    expect(chooseUnitRescale('/m3', 2e-7)).toBeNull()
    expect(chooseUnitRescale('per m3', 2e-7)).toBeNull()
    expect(chooseUnitRescale('', 2e-7)).toBeNull()
    expect(chooseUnitRescale(undefined, 2e-7)).toBeNull()
  })

  it('reads the micro sign, Greek mu and the ASCII u alike', () => {
    // 2e9 µg m-3 is 2 kg m-3 whichever way the micro was spelled.
    for (const micro of ['u', 'µ', 'μ']) {
      expect(chooseUnitRescale(`${micro}g m-3`, 2e9), micro)
        .toEqual({ shift: -9, units: 'kg m-3' })
    }
  })

  it('honours case, because M and m are nine orders apart', () => {
    // 2e-7 mg m-3 is 200 pg m-3; 2e-7 Mg m-3 is 200 mg m-3. Reading the
    // prefix case-insensitively would put the smoke off by a billion.
    expect(chooseUnitRescale('mg m-3', 2e-7)).toEqual({ shift: 9, units: 'pg m-3' })
    expect(chooseUnitRescale('Mg m-3', 2e-7)).toEqual({ shift: 9, units: 'mg m-3' })
  })

  it('never emits a prefix outside engineering notation', () => {
    // Accepted on input (`hPa`, `cm`), never produced: `dag m-3` reads
    // as a typo everywhere outside the handful of fields that own it.
    expect(chooseUnitRescale('cm', 2e-7)?.units).toBe('nm')
    expect(chooseUnitRescale('hPa', 2e-9)?.units).toBe('nPa')
  })

  it('refuses a magnitude that carries no information', () => {
    expect(chooseUnitRescale('kg m-3', 0)).toBeNull()
    expect(chooseUnitRescale('kg m-3', Number.NaN)).toBeNull()
    expect(chooseUnitRescale('kg m-3', Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('shiftDecimalExponent', () => {
  it('shifts exactly, where multiplying would not', () => {
    // A vmax of 9.99e-7 kg m-3 is 999 µg m-3, and multiplying gets
    // 999.0000000000001 — three significant digits hide that, the CSV
    // does not.
    expect(9.99e-7 * 1e9).not.toBe(999)
    expect(shiftDecimalExponent(9.99e-7, 9)).toBe(999)
    expect(shiftDecimalExponent(2e-7, 9)).toBe(200)
    expect(shiftDecimalExponent(-4.5e-7, 9)).toBe(-450)
  })

  it('passes through the values there is nothing to do to', () => {
    expect(shiftDecimalExponent(0, 9)).toBe(0)
    expect(shiftDecimalExponent(42, 0)).toBe(42)
    expect(shiftDecimalExponent(Number.NaN, 9)).toBeNaN()
  })
})

describe('toDisplayUnits', () => {
  it('restates the range and records what it was restated from', () => {
    const out = toDisplayUnits(scale({ vmin: 0, vmax: 2e-7, units: 'kg m-3' }))
    expect(out.vmin).toBe(0)
    expect(out.vmax).toBe(200)
    expect(out.units).toBe('µg m-3')
    expect(out.sourceUnits).toBe('kg m-3')
  })

  it('returns the scale itself when there is nothing to gain', () => {
    const input = scale({ vmin: 0, vmax: 200, units: 'µg m-3' })
    expect(toDisplayUnits(input)).toBe(input)
  })

  it('judges the range by its largest absolute value', () => {
    // A field that swings negative — an anomaly — is decided by
    // whichever end is furthest from zero.
    const out = toDisplayUnits(scale({ vmin: -5e-7, vmax: 1e-7, units: 'kg m-3' }))
    expect(out.vmin).toBe(-500)
    expect(out.vmax).toBe(100)
  })

  it('leaves the luma-space fields exactly as published', () => {
    // A change of unit says nothing about where data starts or which
    // band is too faint to draw; both are positions in the code range.
    const out = toDisplayUnits(scale({
      vmin: 0,
      vmax: 2e-7,
      units: 'kg m-3',
      transparentRange: 12 / 255,
      dataMinLuma: 12,
    }))
    expect(out.transparentRange).toBe(12 / 255)
    expect(out.dataMinLuma).toBe(12)
    expect(out.stops).toBe(STOPS)
  })

  it('reports the same measurement through lumaToValue', () => {
    // The property the whole change rests on: every luma code means
    // the same physical quantity before and after, just said differently.
    const raw = scale({ vmin: 0, vmax: 2e-7, units: 'kg m-3', dataMinLuma: 12 })
    const shown = toDisplayUnits(raw)
    for (const luma of [12, 64, 128, 200, 255]) {
      // 1e9 µg to the kg — the conversion a reader would do by hand.
      expect(lumaToValue(luma, shown)).toBeCloseTo(lumaToValue(luma, raw) * 1e9, 9)
    }
  })
})
