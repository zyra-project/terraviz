import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetFormatterCacheForTests,
  formatDate,
  formatNumber,
  formatRegion,
  formatRelative,
} from './format'

describe('format helpers', () => {
  beforeEach(() => {
    __resetFormatterCacheForTests()
  })

  it('formats dates via the active locale', () => {
    // Default locale in tests is 'en' — output is en-format. We
    // don't assert exact text (varies by ICU version) but the
    // result should contain the year and be non-empty.
    const out = formatDate('2010-06-15T00:00:00Z')
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('2010')
  })

  it('formats numbers via the active locale', () => {
    expect(formatNumber(1234567)).toMatch(/[1-9]/)
    // English grouping comma — sanity check on locale plumbing.
    expect(formatNumber(1234)).toContain('1,234')
  })

  it('formatRegion expands ISO country codes to full names', () => {
    expect(formatRegion('US')).toBe('United States')
    expect(formatRegion('FR')).toBe('France')
  })

  it('formatRegion falls back to the raw code for unknown values', () => {
    // Cloudflare emits XX (unknown) / T1 (Tor) pseudo-codes that
    // aren't real regions — show them verbatim rather than throw.
    expect(formatRegion('XX')).toBe('XX')
  })

  it('formatRelative returns localized relative-time strings', () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const out = formatRelative(past)
    // Don't pin exact wording (ICU variance) — just check we got
    // something English-ish back, not an empty string or thrown.
    expect(out.length).toBeGreaterThan(0)
  })

  it('reuses Intl.DateTimeFormat instances per (locale, opts) tuple', () => {
    // Memoization regression: the helpers used to construct a new
    // Intl.* on every call, which showed up as measurable cost in
    // browse-card render where formatDate fires twice per card.
    // vi.spyOn doesn't track `new` calls reliably across runtimes,
    // so monkey-patch the constructor with a counting wrapper.
    const original = Intl.DateTimeFormat
    let count = 0
    ;(Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat =
      function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        count++
        return new original(...args)
      } as unknown as typeof Intl.DateTimeFormat
    try {
      formatDate('2010-06-15')
      formatDate('2011-07-20')
      formatDate('2012-08-25')
      expect(count).toBe(1)
    } finally {
      ;(Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = original
    }
  })

  it('rebuilds the formatter when opts change (different cache key)', () => {
    const original = Intl.DateTimeFormat
    let count = 0
    ;(Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat =
      function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        count++
        return new original(...args)
      } as unknown as typeof Intl.DateTimeFormat
    try {
      formatDate('2010-06-15', { year: 'numeric' })
      formatDate('2010-06-15', { month: 'short' })
      expect(count).toBe(2)
    } finally {
      ;(Intl as unknown as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = original
    }
  })

  it('reuses Intl.NumberFormat instances per (locale, opts) tuple', () => {
    const original = Intl.NumberFormat
    let count = 0
    ;(Intl as unknown as { NumberFormat: typeof Intl.NumberFormat }).NumberFormat =
      function (this: unknown, ...args: ConstructorParameters<typeof Intl.NumberFormat>) {
        count++
        return new original(...args)
      } as unknown as typeof Intl.NumberFormat
    try {
      formatNumber(1)
      formatNumber(2)
      formatNumber(3)
      expect(count).toBe(1)
    } finally {
      ;(Intl as unknown as { NumberFormat: typeof Intl.NumberFormat }).NumberFormat = original
    }
  })
})
