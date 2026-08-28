// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Coverage for the Workers AI quota-error classifier.
 *
 * The patterns are fuzzy by design — Cloudflare has shifted the
 * exact message text across versions ("3036 neurons exhausted",
 * "4006 quota exceeded", "Capacity temporarily exceeded"). The
 * tests pin every variant we've actually seen from the platform
 * so a wording change surfaces as a test failure rather than a
 * silent badge regression.
 */

import { describe, expect, it } from 'vitest'
import { isWorkersAiQuotaError } from './workers-ai-error'

describe('isWorkersAiQuotaError', () => {
  it.each([
    ['4006 quota exceeded', true],
    ['Workers AI 4006: quota exhausted', true],
    ['3036: You have used all available neurons.', true],
    ['Account is over the free-tier limit', true],
    ['neurons exhausted', true],
    ['quota exceeded', true],
  ])('detects %j as quota error → %s', (msg, expected) => {
    expect(isWorkersAiQuotaError(new Error(msg))).toBe(expected)
  })

  it.each([
    'Network error',
    'Bad gateway',
    'AbortError: aborted',
    'Workers AI returned 502',
    '',
    // Phase 1f/N — these strings look quota-adjacent but actually
    // signal provider-side load-shedding / incidents where the
    // customer's quota is unaffected. Misclassifying them as
    // `quota_exhausted` would route operators toward "upgrade to
    // Workers Paid" when the right action is "wait for the
    // Cloudflare incident to clear".
    'Capacity temporarily exceeded for this model',
    'Service temporarily unavailable',
    'Model is overloaded',
  ])('does not flag %j as a quota error', msg => {
    expect(isWorkersAiQuotaError(new Error(msg))).toBe(false)
  })

  it('handles bare strings, undefined, null, and non-Error throws', () => {
    expect(isWorkersAiQuotaError('4006 quota exceeded')).toBe(true)
    expect(isWorkersAiQuotaError('hello world')).toBe(false)
    expect(isWorkersAiQuotaError(undefined)).toBe(false)
    expect(isWorkersAiQuotaError(null)).toBe(false)
    expect(isWorkersAiQuotaError({ message: '4006' })).toBe(false)
  })
})
