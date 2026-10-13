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
import { isWorkersAiQuotaError, workersAiErrorMessage } from './workers-ai-error'

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

  it('classifies a JSON error body by its error, not its request id', () => {
    // #457: every caller passes the caught error as is, so the reduction
    // has to happen in here for all of them.
    const notQuota = '{"errors":[{"code":5007,"message":"No such model"}],"request_id":"9f1c2b7a-3e5d-4006-8a1b-2c3d4e5f6a7b"}'
    expect(isWorkersAiQuotaError(new Error(notQuota))).toBe(false)
    expect(isWorkersAiQuotaError(notQuota)).toBe(false)
    expect(isWorkersAiQuotaError(new Error('{"errors":[{"code":4006,"message":"daily free allocation used"}]}'))).toBe(true)
  })
})

describe('workersAiErrorMessage', () => {
  it('reduces the Cloudflare errors[] envelope to code: message', () => {
    expect(workersAiErrorMessage(JSON.stringify({
      errors: [{ code: 4006, message: 'you have used up your daily free allocation' }],
      success: false,
    }))).toBe('4006: you have used up your daily free allocation')
  })

  it('keeps a request_id out of what the classifier sees', () => {
    // The body that came back as quota_exhausted: `\b4006\b` matched the
    // standalone "4006" group of the request id, not the error. The
    // classifier now reduces the body itself (#457), so it is not fooled
    // even when handed the whole envelope.
    const body = '{"errors":[{"code":5007,"message":"No such model"}],' +
      '"request_id":"9f1c2b7a-3e5d-4006-8a1b-2c3d4e5f6a7b"}'
    expect(isWorkersAiQuotaError(body)).toBe(false)
    const message = workersAiErrorMessage(body)
    expect(message).toBe('5007: No such model')
    expect(isWorkersAiQuotaError(message)).toBe(false)
  })

  it.each([
    ['{"error":"4006: neurons exhausted"}', '4006: neurons exhausted'],
    ['{"error":{"code":3036,"message":"quota exceeded"}}', '3036: quota exceeded'],
    ['{"internalCode":4006,"description":"daily free allocation used"}', '4006: daily free allocation used'],
    ['{"code":5007,"message":"No such model"}', '5007: No such model'],
  ])('reads %s', (body, expected) => {
    expect(workersAiErrorMessage(body)).toBe(expected)
  })

  it('yields nothing for a JSON body with no error in it', () => {
    expect(workersAiErrorMessage('{"request_id":"9f1c2b7a-3e5d-4006-8a1b-2c3d4e5f6a7b"}')).toBe('')
  })

  it('returns anything that is not a JSON object unchanged', () => {
    expect(workersAiErrorMessage('Capacity temporarily exceeded for this model'))
      .toBe('Capacity temporarily exceeded for this model')
    expect(workersAiErrorMessage('4006')).toBe('4006')
    expect(workersAiErrorMessage('{not json')).toBe('{not json')
    expect(workersAiErrorMessage('')).toBe('')
  })
})
