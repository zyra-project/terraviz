// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { until } from './test-utils'

describe('until', () => {
  it('returns as soon as the condition holds', async () => {
    let calls = 0
    await until(() => ++calls >= 3)
    expect(calls).toBe(3)
  })

  it('returns without yielding when the condition already holds', async () => {
    let checked = 0
    await until(() => {
      checked++
      return true
    })
    expect(checked).toBe(1)
  })

  it('waits for work that completes after several turns', async () => {
    let done = false
    // Four chained turns — more than a two-tick drain would have allowed.
    void Promise.resolve()
      .then(() => new Promise(r => setTimeout(r, 0)))
      .then(() => new Promise(r => setTimeout(r, 0)))
      .then(() => new Promise(r => setTimeout(r, 0)))
      .then(() => {
        done = true
      })

    await until(() => done)
    expect(done).toBe(true)
  })

  it('throws at the timeout, naming what it waited for', async () => {
    await expect(
      until(() => false, 'the widget to appear', { timeoutMs: 20 }),
    ).rejects.toThrow(/Timed out after 20ms waiting for: the widget to appear/)
  })

  // Without a description the stringified condition is the message.
  // That is the difference between a useful failure and a bare timeout,
  // and it is why call sites are not forced to write prose.
  it('falls back to the condition source when undescribed', async () => {
    const calls: unknown[] = []
    await expect(until(() => calls.length > 0, undefined, { timeoutMs: 20 })).rejects.toThrow(
      /calls\.length > 0/,
    )
  })

  // The motivating shape: `mock.calls[1][0]` throws until the second
  // call lands. Swallowing it is what lets a call site read naturally
  // rather than defensively.
  it('treats a throwing condition as not-yet, and surfaces it on timeout', async () => {
    const calls: string[][] = []
    const second = (): boolean => calls[1][0] === 'ready'

    await expect(until(second, 'the second call', { timeoutMs: 20 })).rejects.toThrow(
      /condition kept throwing/,
    )

    setTimeout(() => {
      calls.push(['first'], ['ready'])
    }, 5)
    await expect(until(second, 'the second call')).resolves.toBeUndefined()
  })

  // A condition that throws on the way to becoming true must not leave
  // a stale error attached to an unrelated later timeout.
  it('clears a recovered error rather than reporting it later', async () => {
    let ready = false
    setTimeout(() => {
      ready = true
    }, 5)
    const flaky = (): boolean => {
      if (!ready) throw new Error('not yet')
      return false
    }
    await expect(until(flaky, 'never true', { timeoutMs: 40 })).rejects.toThrow(
      /waiting for: never true$/,
    )
  })
})
