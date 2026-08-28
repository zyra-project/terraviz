// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Coverage for the SPA-side degraded-mode state.
 *
 * The state is module-level and persists across `processMessage`
 * calls within a session. Tests reset between cases via the
 * exported `resetForTests()` hook.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  clearDegraded,
  getDegradedReason,
  getDegradedState,
  markDegraded,
  resetForTests,
  subscribe,
} from './docentDegradedState'

afterEach(() => {
  resetForTests()
})

describe('docentDegradedState', () => {
  it('starts cleared', () => {
    expect(getDegradedReason()).toBeNull()
    expect(getDegradedState()).toEqual({ reason: null, since: null })
  })

  it('markDegraded sets reason + timestamp and notifies subscribers', () => {
    const seen: string[] = []
    subscribe(state => seen.push(`${state.reason ?? 'null'}`))
    const before = Date.now()
    markDegraded('quota_exhausted')
    const state = getDegradedState()
    expect(state.reason).toBe('quota_exhausted')
    expect(state.since).not.toBeNull()
    expect(state.since!).toBeGreaterThanOrEqual(before)
    expect(seen).toEqual(['quota_exhausted'])
  })

  it('markDegraded with the same reason is a no-op (no listener fanout)', () => {
    const seen: string[] = []
    subscribe(s => seen.push(`${s.reason ?? 'null'}`))
    markDegraded('quota_exhausted')
    markDegraded('quota_exhausted')
    markDegraded('quota_exhausted')
    expect(seen).toEqual(['quota_exhausted'])
  })

  it('clearDegraded resets state and notifies subscribers', () => {
    const seen: string[] = []
    subscribe(s => seen.push(`${s.reason ?? 'null'}`))
    markDegraded('quota_exhausted')
    clearDegraded()
    expect(getDegradedReason()).toBeNull()
    expect(seen).toEqual(['quota_exhausted', 'null'])
  })

  it('clearDegraded on already-clear state is a no-op', () => {
    const seen: string[] = []
    subscribe(s => seen.push(`${s.reason ?? 'null'}`))
    clearDegraded()
    clearDegraded()
    expect(seen).toEqual([])
  })

  it('subscribe returns an unsubscribe function', () => {
    const seen: string[] = []
    const unsub = subscribe(s => seen.push(`${s.reason ?? 'null'}`))
    markDegraded('quota_exhausted')
    unsub()
    clearDegraded()
    expect(seen).toEqual(['quota_exhausted'])
  })
})
