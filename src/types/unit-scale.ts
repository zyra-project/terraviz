// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Readable units for a data-encoded colour scale.
 *
 * A model file states its field in whatever units the modelling centre
 * chose, and those are almost never the units a person would say out
 * loud. RRFS near-surface smoke arrives as `kg m-3` over a range of
 * `0` to `2e-7`, so every surface that prints a number from it — the
 * colorbar ticks, the hover readout, the Analyze summary, the CSV, the
 * sentence Orbit speaks — prints six leading zeros for a quantity the
 * rest of the world writes as `0` to `200 µg m-3`.
 *
 * The fix is a change of unit, not a change of number: pick the SI
 * prefix that lands the range in a decade people read at a glance, and
 * relabel. `2e-7 kg m-3` and `200 µg m-3` are the same measurement,
 * so nothing downstream has to know this happened. That is the whole
 * design — `vmin`/`vmax`/`units` are rewritten once at the seam where
 * the catalog becomes a `Dataset`, and every consumer that derives a
 * value through `lumaToValue` and labels it with `scale.units` is
 * correct afterwards without being touched.
 *
 * **This is a change of unit, not one of the display transforms in
 * `colorScaleDisplay.ts`.** Those are forbidden from changing a
 * reported value, and this one changes every reported value — but it
 * changes the label in exact lockstep, applies before any of them run,
 * and is invisible to all of them. The invariant they protect is that
 * *how a field is coloured* cannot alter *what it measures*; expressing
 * the same measurement in a sane unit never did.
 *
 * Deliberately display-only: nothing here is written back to the
 * catalog. What zyra encoded, the publisher pasted and D1 stores stays
 * exactly as authored, so a re-encode, an export, or a federated peer
 * still sees the publisher's own numbers.
 *
 * Pure and dependency-free — imported by browser code, portal code and
 * tests, and safe for Workers code that wants to warn at publish time.
 */

import type { ColorScale } from './color-scale'

/**
 * Prefixes accepted on an incoming unit string.
 *
 * Case is load-bearing and there is no forgiving it: `M` is mega and
 * `m` is milli, `P` is peta and `p` is pico. `K` is deliberately absent
 * — it is kelvin, and treating a stray `Km` as kilometres would mean
 * guessing at a typo in the one place a guess turns a temperature into
 * a length. `u` is here because ASCII-only pipelines write `ug m-3`,
 * and both the micro sign (U+00B5) and Greek mu (U+03BC) are here
 * because files carry both and they are visually identical.
 */
const INPUT_PREFIXES: Record<string, number> = {
  Q: 30, R: 27, Y: 24, Z: 21, E: 18, P: 15, T: 12, G: 9, M: 6, k: 3,
  h: 2, da: 1,
  d: -1, c: -2, m: -3, u: -6, 'µ': -6, 'μ': -6,
  n: -9, p: -12, f: -15, a: -18, z: -21, y: -24, r: -27, q: -30,
}

/**
 * Prefixes we are willing to *emit*, keyed by exponent.
 *
 * Multiples of three only. Engineering notation is what a reader
 * expects of a physical quantity — micrograms, milligrams, kilometres
 * — and the in-between prefixes (`h`, `da`, `d`, `c`) read as errors
 * outside the handful of fields that own them. Accepting them on input
 * and never producing them is the asymmetry that makes `hPa` parse and
 * `dag m-3` impossible.
 */
const OUTPUT_PREFIXES: Record<number, string> = {
  30: 'Q', 27: 'R', 24: 'Y', 21: 'Z', 18: 'E', 15: 'P', 12: 'T', 9: 'G',
  6: 'M', 3: 'k', 0: '',
  [-3]: 'm', [-6]: 'µ', [-9]: 'n', [-12]: 'p', [-15]: 'f',
  [-18]: 'a', [-21]: 'z', [-24]: 'y', [-27]: 'r', [-30]: 'q',
}

const MIN_OUTPUT_EXPONENT = -30
const MAX_OUTPUT_EXPONENT = 30

/**
 * Base units a prefix may attach to — an allowlist, not a pattern.
 *
 * SI symbols are genuinely ambiguous when read as prefix-plus-base:
 * `mol` is a mole and not a milli-`ol`, `min` is a minute and not a
 * milli-`in`, `Pa` is a pascal and not a peta-`a`. A rule that split
 * greedily would relabel minutes; a rule that split lazily would miss
 * `mm`. Matching the whole token against this list *first* and only
 * then trying prefix-plus-base resolves every one of those correctly,
 * and anything not on the list is simply left alone — which is the
 * right answer for `%`, `1`, `ppbv`, `dBZ`, `index` and every other
 * unit an SI prefix would be meaningless on.
 *
 * The gram is here rather than the kilogram, which is what makes the
 * arithmetic uniform: `kg` is read as kilo + gram like any other
 * prefixed unit, so nothing needs a special case for the one SI base
 * that ships with a prefix attached.
 */
const BASE_UNITS = new Set([
  'mol', 'Pa', 'Hz', 'g', 'm', 's', 'K', 'W', 'J', 'N', 'L', 'l', 'V', 'A',
])

/**
 * Below this the numbers grow leading zeros; at or above it they grow
 * digit groups. Between them, leave the publisher's units alone.
 *
 * The band is wide on purpose. A dataset in `hPa` reading `0` to
 * `1013`, or one in `K` reading `200` to `320`, is already stated the
 * way its field states it, and "improving" it to `1.01 kPa m-1`-style
 * cleverness would be a regression dressed as a feature. Only a range
 * nobody would choose to write down gets touched.
 */
const READABLE_MIN = 0.01
const READABLE_MAX = 1e6

/** The decade the rescale aims for: `[1, 1000)`, so the top of the
 *  range reads as up to three whole digits — `200`, `500`, `999`. */
const TARGET_DECADES = 3

/**
 * A `ColorScale` that has been through {@link toDisplayUnits}.
 *
 * Separate from `ColorScale` rather than an optional field on it,
 * because `ColorScale` is the *wire* contract: it is embedded in
 * `WireDataset` and published as `public/schema/v1/dataset.schema.json`
 * for federated peers to validate against. A display-only field there
 * would announce to every peer that the server might emit something it
 * never emits. Here it is what it actually is — a fact the browser
 * derived, on a type only the browser has.
 */
export interface DisplayColorScale extends ColorScale {
  /**
   * The units the publisher stored, present only when the scale was
   * restated — `kg m-3` on a scale now reporting `µg m-3`. Provenance
   * for the surfaces that archive a number rather than merely print
   * it, above all the CSV export, and the signal the publisher form
   * uses to show what viewers will see.
   */
  sourceUnits?: string
}

export interface UnitRescale {
  /** Decimal exponent to shift a source value by. `9` turns
   *  `2e-7 kg m-3` into `200 µg m-3`. */
  shift: number
  /** The relabelled unit string. */
  units: string
}

/**
 * Shift a value by a power of ten without accumulating float error.
 *
 * `2e-7 * 1e9` is `200.00000000000003` in binary floating point, which
 * survives a three-significant-digit colorbar tick and then shows up
 * in the CSV, where values are written at full precision precisely so
 * they can be trusted. Editing the decimal exponent of the value's own
 * exponential form is exact for anything `Number` can represent, and
 * `Number()` re-parses it back to the nearest double.
 */
export function shiftDecimalExponent(value: number, shift: number): number {
  if (!Number.isFinite(value) || value === 0 || shift === 0) return value
  const [mantissa, exponent] = value.toExponential().split('e')
  return Number(`${mantissa}e${Number(exponent) + shift}`)
}

/**
 * Split a unit string into its leading factor and everything after it.
 *
 * Only the leading factor can carry the prefix — `kg m-3` becomes
 * `µg m-3`, never `kg mm-3`, because a prefix on a denominator term
 * would be cubed by its exponent and the arithmetic here is a single
 * power of ten. Returns `null` for a string that does not begin with a
 * factor at all (`/m3`, `per m3`, an empty string), which is also the
 * refusal for anything whose shape this module does not understand.
 */
function splitLeadingFactor(units: string): [string, string] | null {
  const match = /^([^\s/*·]+)([\s\S]*)$/.exec(units)
  return match ? [match[1], match[2]] : null
}

/**
 * Read a token as prefix-plus-base, or `null`.
 *
 * The token must be *exactly* a prefix and a base with nothing left
 * over. A trailing exponent (`m2`, `m-3`, `m^2`) is a refusal rather
 * than something to reason about: shifting a prefix on a squared term
 * moves the value by twice the exponent, and a module that quietly got
 * that wrong would misreport every number in the dataset by orders of
 * magnitude. Refusing costs a legible unit on a rare shape; being
 * clever there costs correctness on all of them.
 */
function parsePrefixedUnit(token: string): { prefixExponent: number; base: string } | null {
  if (BASE_UNITS.has(token)) return { prefixExponent: 0, base: token }
  // Longest prefix first, so `da` is tried before `d`.
  for (const length of [2, 1]) {
    const prefix = token.slice(0, length)
    const base = token.slice(length)
    const exponent = INPUT_PREFIXES[prefix]
    if (exponent !== undefined && BASE_UNITS.has(base)) {
      return { prefixExponent: exponent, base }
    }
  }
  return null
}

/**
 * Choose a readable unit for a range, or `null` to leave it alone.
 *
 * `magnitude` is the largest absolute value the scale reports — the
 * number the range is judged by, since it is the one the top tick
 * prints and the one that decides how many zeros the others carry.
 */
export function chooseUnitRescale(
  units: string | undefined,
  magnitude: number,
): UnitRescale | null {
  if (!units) return null
  if (!Number.isFinite(magnitude) || magnitude <= 0) return null
  if (magnitude >= READABLE_MIN && magnitude < READABLE_MAX) return null

  const split = splitLeadingFactor(units)
  if (!split) return null
  const [token, rest] = split
  const parsed = parsePrefixedUnit(token)
  if (!parsed) return null

  // Where the range sits once expressed in the *unprefixed* base, then
  // the largest multiple-of-three prefix that leaves it at or above 1.
  // The epsilon absorbs `Math.log10`'s error at exact decade
  // boundaries, where a result of -6.0000000001 for 1e-6 would
  // otherwise step one prefix too far and print 1000 µg instead of
  // 1 mg. It is far smaller than any real range and cannot move a
  // magnitude that is not already sitting on a boundary.
  const inBase = Math.log10(magnitude) + parsed.prefixExponent
  const exponent = TARGET_DECADES * Math.floor(inBase / TARGET_DECADES + 1e-9)
  const clamped = Math.min(MAX_OUTPUT_EXPONENT, Math.max(MIN_OUTPUT_EXPONENT, exponent))
  const shift = parsed.prefixExponent - clamped
  if (shift === 0) return null

  return { shift, units: `${OUTPUT_PREFIXES[clamped]}${parsed.base}${rest}` }
}

/**
 * Restate a colour scale in units a person would say out loud.
 *
 * Returns the input untouched whenever there is nothing to gain — a
 * range that already reads well, units no prefix attaches to, a scale
 * with no units at all — so callers can apply it unconditionally.
 *
 * Only `vmin`, `vmax` and `units` move. `stops`, `transparentRange`
 * and `dataMinLuma` are all expressed in luma or normalised position,
 * which a change of unit does not touch, so the palette, the no-data
 * band and the transparent band come through exactly as published.
 */
export function toDisplayUnits(scale: ColorScale): DisplayColorScale {
  const magnitude = Math.max(Math.abs(scale.vmin), Math.abs(scale.vmax))
  const rescale = chooseUnitRescale(scale.units, magnitude)
  if (!rescale) return scale
  return {
    ...scale,
    vmin: shiftDecimalExponent(scale.vmin, rescale.shift),
    vmax: shiftDecimalExponent(scale.vmax, rescale.shift),
    units: rescale.units,
    sourceUnits: scale.units,
  }
}
