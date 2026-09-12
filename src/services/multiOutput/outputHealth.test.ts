// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the departure classification and the crash-storm guard.
 *
 * Both are small enough to look obviously right and both have a wrong
 * answer that is invisible in production, which is the combination
 * worth pinning: a misclassified crash is a silent one, and a guard
 * that never trips leaves an operator re-adding an output onto a
 * monitor that keeps killing it.
 */

import { describe, it, expect } from 'vitest'

import {
  CRASH_STORM_LIMIT,
  CRASH_STORM_WINDOW_MS,
  classifyDeparture,
  createCrashStormGuard,
} from './outputHealth'

describe('classifyDeparture', () => {
  it('calls a silent destroy a crash', () => {
    // The only evidence a crash leaves is the absence of everything
    // else: a killed process cannot report its own death.
    expect(classifyDeparture({ managerInitiated: false, sawClosing: false })).toBe('crashed')
  })

  it('calls a warned destroy an operator close', () => {
    // Alt+F4, a window manager's close button, or an operator reaching
    // an output they took out of fullscreen with F11.
    expect(classifyDeparture({ managerInitiated: false, sawClosing: true })).toBe('closed')
  })

  it('calls a close the manager asked for a removal', () => {
    expect(classifyDeparture({ managerInitiated: true, sawClosing: false })).toBe('removed')
  })

  it('prefers the manager’s own intent when both signals are set', () => {
    // The ordering that matters. Remove in the panel makes the manager
    // call `close()`, which fires the output's close-requested handler,
    // which emits `output_closing` — so both are true for one
    // departure, and reporting it as a hand-close would be wrong in the
    // one case the panel already knows the answer to.
    expect(classifyDeparture({ managerInitiated: true, sawClosing: true })).toBe('removed')
  })
})

describe('createCrashStormGuard', () => {
  /** A guard on a clock the test drives. */
  function guardAt() {
    let clock = 0
    const guard = createCrashStormGuard({ nowMs: () => clock })
    return { guard, advance: (ms: number) => (clock += ms) }
  }

  const MONITOR = 'HDMI-1@0,0'

  it('does not block before the limit', () => {
    const { guard } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT - 1; i++) guard.record(MONITOR)

    expect(guard.isBlocked(MONITOR)).toBe(false)
  })

  it('blocks once the limit is reached inside the window', () => {
    const { guard } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) guard.record(MONITOR)

    expect(guard.isBlocked(MONITOR)).toBe(true)
    expect(guard.blocked()).toEqual([MONITOR])
  })

  it('does not block crashes spread wider than the window', () => {
    // Three crashes across an afternoon are three incidents, not a
    // storm, and refusing the monitor for them would take a working
    // display away from an operator.
    const { guard, advance } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) {
      guard.record(MONITOR)
      advance(CRASH_STORM_WINDOW_MS + 1)
    }

    expect(guard.isBlocked(MONITOR)).toBe(false)
  })

  it('never lifts a block it has tripped', () => {
    // The window detects the storm; it does not time the block out.
    // Nothing observed after the third crash suggests the hardware
    // improved, and an expiring block puts the operator back into the
    // re-add loop the guard exists to break.
    const { guard, advance } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) guard.record(MONITOR)
    advance(CRASH_STORM_WINDOW_MS * 100)

    expect(guard.isBlocked(MONITOR)).toBe(true)
  })

  it('keeps monitors apart', () => {
    // One bad display must not cost the operator the others — the
    // reason this is keyed at all rather than counting globally.
    const { guard } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) guard.record(MONITOR)

    expect(guard.isBlocked('DP-2@1920,0')).toBe(false)
  })

  it('starts clean, which is what makes relaunch the reset', () => {
    // A fresh guard is a fresh session. Nothing here is persisted, so
    // the block cannot outlive the reseated cable that fixed it.
    const { guard } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) guard.record(MONITOR)
    expect(guard.isBlocked(MONITOR)).toBe(true)

    const { guard: relaunched } = guardAt()
    expect(relaunched.isBlocked(MONITOR)).toBe(false)
    expect(relaunched.blocked()).toEqual([])
  })
})
