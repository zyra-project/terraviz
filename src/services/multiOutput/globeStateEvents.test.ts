// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  publishGlobeState,
  resetGlobeStateEventsForTests,
  subscribeGlobeState,
} from './globeStateEvents'

afterEach(() => {
  resetGlobeStateEventsForTests()
  vi.restoreAllMocks()
})

describe('globeStateEvents', () => {
  it('delivers a patch to every subscriber, in subscription order', () => {
    const order: string[] = []
    subscribeGlobeState(() => order.push('first'))
    subscribeGlobeState(() => order.push('second'))

    publishGlobeState({ simulationDate: '2026-01-01T00:00:00.000Z' })

    expect(order).toEqual(['first', 'second'])
  })

  it('passes the patch through unchanged', () => {
    const seen: unknown[] = []
    subscribeGlobeState(patch => seen.push(patch))

    const patch = { simulationDate: '2026-03-04T05:06:07.000Z' }
    publishGlobeState(patch)

    // Identity, not just equality: this module must not clone, coalesce
    // or normalise. The aggregator is what copies on store, and a
    // second copier here would make it ambiguous which one a future
    // mutation bug lived in.
    expect(seen).toEqual([patch])
    expect(seen[0]).toBe(patch)
  })

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeGlobeState(listener)

    publishGlobeState({ dataset: null })
    unsubscribe()
    publishGlobeState({ dataset: null })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not replay the last patch to a late subscriber', () => {
    publishGlobeState({ simulationDate: '2026-01-01T00:00:00.000Z' })

    const late = vi.fn()
    subscribeGlobeState(late)

    // A patch is a change, not a state. Replaying one would tell a late
    // joiner that a field changed at a moment it did not, and it still
    // would not know the fields that changed before it arrived — that
    // is what the aggregator's full() snapshot is for.
    expect(late).not.toHaveBeenCalled()
  })

  it('isolates a throwing listener from the others and from the publisher', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const after = vi.fn()
    subscribeGlobeState(() => {
      throw new Error('output link is broken')
    })
    subscribeGlobeState(after)

    // The publisher is a dataset load in the control window. A broken
    // output must not fail it, so this must not throw...
    expect(() => publishGlobeState({ dataset: null })).not.toThrow()
    // ...and must not cost the healthy listener its notification.
    expect(after).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })

  it('survives a listener that unsubscribes during notification', () => {
    const second = vi.fn()
    const unsubscribeFirst = subscribeGlobeState(() => unsubscribeFirst())
    subscribeGlobeState(second)

    expect(() => publishGlobeState({ dataset: null })).not.toThrow()
    // Mutating the live set mid-iteration must not skip the next
    // listener, which is why publish iterates a copy.
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('is a no-op with nothing subscribed', () => {
    expect(() => publishGlobeState({ dataset: null })).not.toThrow()
  })
})
