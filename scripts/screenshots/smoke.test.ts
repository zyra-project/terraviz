import { describe, expect, it } from 'vitest'

import { AssertionError, assert, summarizeSmoke } from './smoke'

describe('assert', () => {
  it('passes through truthy conditions', () => {
    expect(() => assert(true, 'nope')).not.toThrow()
    expect(() => assert(1, 'nope')).not.toThrow()
  })

  it('throws AssertionError with the message on falsy conditions', () => {
    expect(() => assert(false, 'boom')).toThrow(AssertionError)
    expect(() => assert(0, 'boom')).toThrow('boom')
  })
})

describe('summarizeSmoke', () => {
  it('counts passes and failures and is ok only when none failed', () => {
    expect(
      summarizeSmoke([
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ]),
    ).toEqual({ passed: 2, failed: 0, ok: true })

    expect(
      summarizeSmoke([
        { name: 'a', ok: true },
        { name: 'b', ok: false, error: 'x' },
      ]),
    ).toEqual({ passed: 1, failed: 1, ok: false })
  })

  it('is ok for an empty run', () => {
    expect(summarizeSmoke([])).toEqual({ passed: 0, failed: 0, ok: true })
  })
})
