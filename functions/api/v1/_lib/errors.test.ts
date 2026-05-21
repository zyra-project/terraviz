/**
 * Tests for the typed-error helpers in `errors.ts`. The
 * `safeErrorReason` reducer is the security-relevant piece: it is
 * the seam that decides whether a caught `unknown` reaches the
 * client verbatim or is collapsed to a generic fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ConfigurationError,
  UpstreamError,
  isConfigurationError,
  isUpstreamError,
  safeErrorReason,
} from './errors'

describe('isConfigurationError / isUpstreamError', () => {
  it('discriminates by `kind` brand', () => {
    expect(isConfigurationError(new ConfigurationError('x'))).toBe(true)
    expect(isUpstreamError(new ConfigurationError('x'))).toBe(false)
    expect(isUpstreamError(new UpstreamError('x'))).toBe(true)
    expect(isConfigurationError(new UpstreamError('x'))).toBe(false)
    expect(isConfigurationError(new Error('x'))).toBe(false)
    expect(isUpstreamError('not-an-error')).toBe(false)
  })
})

describe('safeErrorReason', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('passes ConfigurationError messages through', () => {
    expect(
      safeErrorReason(new ConfigurationError('CATALOG_R2 binding missing'), 'fallback'),
    ).toBe('CATALOG_R2 binding missing')
  })

  it('passes UpstreamError messages through', () => {
    expect(
      safeErrorReason(new UpstreamError('Stream returned 500', 500), 'fallback'),
    ).toBe('Stream returned 500')
  })

  it('collapses whitespace and caps length on typed messages', () => {
    const noisy = `line one\n\tline two   line three${' x'.repeat(300)}`
    const reduced = safeErrorReason(new UpstreamError(noisy), 'fallback')
    expect(reduced).not.toContain('\n')
    expect(reduced).not.toContain('\t')
    expect(reduced.length).toBeLessThanOrEqual(256)
  })

  it('returns fallback for an unbranded Error (the stack-trace exposure case)', () => {
    const generic = new Error('TypeError: Cannot read properties of undefined')
    expect(safeErrorReason(generic, 'Upload backend returned an error.')).toBe(
      'Upload backend returned an error.',
    )
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it('returns fallback for non-Error throws', () => {
    expect(safeErrorReason('raw string', 'fallback')).toBe('fallback')
    expect(safeErrorReason({ weird: true }, 'fallback')).toBe('fallback')
    expect(safeErrorReason(null, 'fallback')).toBe('fallback')
  })

  it('falls back when a typed error has an empty message', () => {
    expect(safeErrorReason(new ConfigurationError(''), 'Configured fallback.')).toBe(
      'Configured fallback.',
    )
  })
})
