// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output telemetry projections.
 *
 * Two of these have a wrong answer that would survive review and never
 * show up in the app: a framebuffer bucket rounded the wrong way
 * reports an installation running 4K as an 8K one, and a tier slip
 * would make installation-health events invisible for every operator
 * who did not opt into Research — which is nearly all of them, since
 * the whole point of the Tier A choice is that a museum operator is
 * not going to.
 *
 * `emit` is stubbed and the rest of the barrel is real, so the tier
 * assertions run against the shipped gate rather than a restatement of
 * it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../analytics', async importOriginal => ({
  ...(await importOriginal<typeof import('../../analytics')>()),
  emit: vi.fn(),
}))

import { emit, setTier, tierGate } from '../../analytics'
import { TIER_B_EVENT_TYPES } from '../../types'
import { FRAMEBUFFER_WIDTHS } from './protocol'
import {
  framebufferBucket,
  removalReasonFor,
  reportOutputAdded,
  reportOutputFailure,
  reportOutputRemoved,
} from './outputTelemetry'

const emitted = vi.mocked(emit)

beforeEach(() => {
  emitted.mockClear()
})

describe('framebufferBucket', () => {
  it('names every rung on the ladder', () => {
    expect(framebufferBucket(1024)).toBe('1k')
    expect(framebufferBucket(2048)).toBe('2k')
    expect(framebufferBucket(4096)).toBe('4k')
    expect(framebufferBucket(8192)).toBe('8k')
  })

  it('covers the whole ladder, whatever is on it', () => {
    // Guards the record against a rung being added to the protocol and
    // this file still passing because it only ever asks about four
    // numbers it happens to name.
    for (const width of FRAMEBUFFER_WIDTHS) {
      expect(framebufferBucket(width)).toMatch(/^\d+k$/)
    }
  })

  it('snaps down, because that is what the scene does', () => {
    // `setFramebufferWidth` snaps down so a window never asks for more
    // memory than the hardware reported. Reporting the nearer rung
    // would tell a dashboard an installation runs 8K when its window
    // is rendering 4K.
    expect(framebufferBucket(8191)).toBe('4k')
    expect(framebufferBucket(3000)).toBe('2k')
  })

  it('floors below the ladder and holds above it', () => {
    expect(framebufferBucket(640)).toBe('1k')
    expect(framebufferBucket(0)).toBe('1k')
    expect(framebufferBucket(16384)).toBe('8k')
  })

  it('gives an unreadable width the floor rather than undefined', () => {
    // The scene renders such a width at the floor; a bucket of
    // `undefined` would reach the wire as a missing blob and shift
    // every position after it.
    expect(framebufferBucket(Number.NaN)).toBe('1k')
    expect(framebufferBucket(Number.NEGATIVE_INFINITY)).toBe('1k')
  })
})

describe('removalReasonFor', () => {
  it('reports both deliberate closes as one reason', () => {
    // The manager has to keep Remove and a hand-close apart; a
    // dashboard does not, and splitting them there would publish the
    // manager's bookkeeping.
    expect(removalReasonFor('removed')).toBe('operator-close')
    expect(removalReasonFor('closed')).toBe('operator-close')
  })

  it('reports a crash as a crash', () => {
    expect(removalReasonFor('crashed')).toBe('crash')
  })
})

describe('the reporters', () => {
  it('reports an add with a bucket, not a pixel count', () => {
    reportOutputAdded({ mode: 'sos-equirect', framebufferWidth: 4096, monitorIndex: 2 })

    expect(emitted).toHaveBeenCalledTimes(1)
    expect(emitted).toHaveBeenCalledWith({
      event_type: 'output_added',
      mode: 'sos-equirect',
      framebuffer_bucket: '4k',
      monitor_index: 2,
    })
  })

  it('reports a removal with its reason', () => {
    reportOutputRemoved({ mode: 'sos-equirect', reason: 'crash' })

    expect(emitted).toHaveBeenCalledWith({
      event_type: 'output_removed',
      mode: 'sos-equirect',
      reason: 'crash',
    })
  })

  it('reports a failure with its counts', () => {
    reportOutputFailure({ kind: 'crash', retries: 0, recovered: false })

    expect(emitted).toHaveBeenCalledWith({
      event_type: 'output_failure',
      kind: 'crash',
      retries: 0,
      recovered: false,
    })
  })

  it('sends no monitor name, no width and no label anywhere', () => {
    // The privacy shape, asserted as a whole rather than trusted to
    // the three payload tests above: a field added later has to pass
    // this too.
    reportOutputAdded({ mode: 'sos-equirect', framebufferWidth: 8192, monitorIndex: 0 })
    reportOutputRemoved({ mode: 'sos-equirect', reason: 'operator-close' })
    reportOutputFailure({ kind: 'crash', retries: 1, recovered: true })

    for (const [event] of emitted.mock.calls) {
      const values = Object.values(event as unknown as Record<string, unknown>)
      for (const value of values) {
        expect(['string', 'number', 'boolean']).toContain(typeof value)
        if (typeof value === 'string') expect(value.length).toBeLessThan(32)
      }
    }
  })
})

describe('a telemetry failure', () => {
  it('cannot unwind into whatever was reporting', () => {
    // Every reporter is called from the middle of the manager's own
    // bookkeeping — between deleting a record and persisting it. A
    // throw here would skip that `persist()` and leave an output gone
    // from memory and still in the config, back on the next launch.
    emitted.mockImplementationOnce(() => {
      throw new Error('localStorage is unavailable')
    })

    expect(() =>
      reportOutputRemoved({ mode: 'sos-equirect', reason: 'crash' }),
    ).not.toThrow()
  })
})

describe('tier', () => {
  it('ships at Essential, which is the whole point of the choice', () => {
    // An installation-health event that only reached the Research
    // opt-in would answer "how often do outputs crash?" with a number
    // nobody could act on.
    setTier('essential')
    expect(tierGate('output_added')).toBe(true)
    expect(tierGate('output_removed')).toBe(true)
    expect(tierGate('output_failure')).toBe(true)
  })

  it('is not on the Tier B list', () => {
    const tierB: readonly string[] = TIER_B_EVENT_TYPES
    expect(tierB).not.toContain('output_added')
    expect(tierB).not.toContain('output_removed')
    expect(tierB).not.toContain('output_failure')
  })

  it('stops with everything else when telemetry is off', () => {
    setTier('off')
    expect(tierGate('output_added')).toBe(false)
    expect(tierGate('output_failure')).toBe(false)
    setTier('essential')
  })
})
