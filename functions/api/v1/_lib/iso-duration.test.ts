import { describe, expect, it } from 'vitest'
import { parseIsoDuration } from './iso-duration'

describe('parseIsoDuration (3pg/B)', () => {
  it('parses common hour / minute / second durations', () => {
    expect(parseIsoDuration('PT1H')).toBe(3_600_000)
    expect(parseIsoDuration('PT30M')).toBe(30 * 60_000)
    expect(parseIsoDuration('PT15S')).toBe(15_000)
    expect(parseIsoDuration('PT1H30M')).toBe(3_600_000 + 30 * 60_000)
  })

  it('parses day-and-week durations', () => {
    expect(parseIsoDuration('P1D')).toBe(86_400_000)
    expect(parseIsoDuration('P1W')).toBe(7 * 86_400_000)
    expect(parseIsoDuration('P3D')).toBe(3 * 86_400_000)
  })

  it('parses calendar units against the Gregorian average', () => {
    // Tests the average-year assumption — frames calls use the
    // result to map an index to a timestamp where drift across
    // multi-year sequences is acceptable.
    expect(parseIsoDuration('P1Y')!).toBeCloseTo(365.2425 * 86_400_000)
    expect(parseIsoDuration('P1M')!).toBeCloseTo((365.2425 / 12) * 86_400_000)
  })

  it('accepts fractional components', () => {
    expect(parseIsoDuration('PT1.5H')).toBe(1.5 * 3_600_000)
    expect(parseIsoDuration('P0.5D')).toBe(0.5 * 86_400_000)
  })

  it('returns null on shapes that have no components', () => {
    // Empty P is valid per the regex but carries no meaning; the
    // catalog's `period` column should be NULL in that case, not
    // "P".
    expect(parseIsoDuration('P')).toBeNull()
    expect(parseIsoDuration('PT')).toBeNull()
  })

  it('returns null on garbage input', () => {
    expect(parseIsoDuration('')).toBeNull()
    expect(parseIsoDuration('5 hours')).toBeNull()
    expect(parseIsoDuration('1H')).toBeNull() // missing T prefix
    expect(parseIsoDuration('P1Z')).toBeNull() // unknown unit
    // Non-string input — the public API typing forbids this, but
    // the catalog row is `string | null` and a hand-edited row
    // could surface as something stranger.
    expect(parseIsoDuration(null as unknown as string)).toBeNull()
  })
})
