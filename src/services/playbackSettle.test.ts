// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the playback→panel settle seam.
 *
 * Two behaviours carry the design and are worth stating plainly, because
 * both would be easy to "fix" into something worse:
 *
 *   1. **Playing never settles**, at any rate. A recompute per frame is
 *      what the whole surface is built to avoid.
 *   2. **One signal per settled position.** Sitting on a paused frame
 *      does not make its numbers stale, so re-firing would be pure cost.
 *
 * The clock is injected throughout, so none of this waits on real time.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PlaybackSettleDetector,
  createPlaybackSettleWatcher,
  type PlaybackSample,
} from './playbackSettle'

const paused = (playhead: number): PlaybackSample => ({ playhead, paused: true })
const playing = (playhead: number): PlaybackSample => ({ playhead, paused: false })

describe('PlaybackSettleDetector', () => {
  it('settles on a paused playhead once the quiet window elapses', () => {
    const d = new PlaybackSettleDetector({ quietMs: 250 })
    expect(d.push(paused(12), 0)).toBeNull()
    expect(d.push(paused(12), 200)).toBeNull()
    expect(d.push(paused(12), 250)).toBe(12)
  })

  it('reports a settled position exactly once', () => {
    // Sitting on a frame does not make its numbers stale. Re-firing
    // would recompute the identical answer for as long as someone looks
    // at it.
    const d = new PlaybackSettleDetector({ quietMs: 100 })
    d.push(paused(5), 0)
    expect(d.push(paused(5), 100)).toBe(5)
    expect(d.push(paused(5), 200)).toBeNull()
    expect(d.push(paused(5), 10_000)).toBeNull()
  })

  it('never settles while playing, however long the loop runs', () => {
    // The load-bearing one. `currentTime` advances continuously during
    // playback, so there is no still moment — and recomputing per frame
    // is exactly what this surface cannot afford.
    const d = new PlaybackSettleDetector({ quietMs: 100 })
    for (let i = 0; i < 200; i++) {
      expect(d.push(playing(i * 0.033), i * 16)).toBeNull()
    }
  })

  it('does not settle during slow playback either', () => {
    // A 0.03× rate moves the playhead 0.0075 s across a 250 ms window —
    // far less than at 1×, but never zero. Tracking a slowly-playing
    // video is a periodic-recompute mechanism, not this one, and this
    // test exists so that distinction is not quietly eroded by an
    // epsilon someone widens later.
    const d = new PlaybackSettleDetector({ quietMs: 250 })
    for (let i = 0; i < 400; i++) {
      expect(d.push(playing(i * 0.0005), i * 16)).toBeNull()
    }
  })

  it('settles once after a pause, timed from when motion stopped', () => {
    const d = new PlaybackSettleDetector({ quietMs: 200 })
    for (let i = 0; i < 10; i++) d.push(playing(i * 0.033), i * 16)
    // Paused at t=160ms on frame 0.297. The window starts here, not at
    // whenever the last sample happened to land.
    expect(d.push(paused(0.297), 160)).toBeNull()
    expect(d.push(paused(0.297), 300)).toBeNull()
    expect(d.push(paused(0.297), 360)).toBe(0.297)
  })

  it('fires once at the end of a scrub, not at every position it crossed', () => {
    // The behaviour that makes this usable: dragging the scrubber past
    // fifty positions must not queue fifty full-frame readbacks.
    const d = new PlaybackSettleDetector({ quietMs: 200 })
    const fired: number[] = []
    for (let i = 0; i < 50; i++) {
      const out = d.push(paused(i * 0.5), i * 20)
      if (out !== null) fired.push(out)
    }
    expect(fired).toEqual([])
    // Let go at 24.5s; nothing moves after t=980ms.
    expect(d.push(paused(24.5), 1100)).toBeNull()
    expect(d.push(paused(24.5), 1190)).toBe(24.5)
  })

  it('does not settle mid-seek, even though a seek reports paused', () => {
    // A seek-while-paused has `paused: true` and a playhead still being
    // adjusted. Without the seeking gate this settles on an intermediate
    // position and the panel describes a frame nobody asked for.
    const d = new PlaybackSettleDetector({ quietMs: 100 })
    expect(d.push({ playhead: 8, paused: true, seeking: true }, 0)).toBeNull()
    expect(d.push({ playhead: 8, paused: true, seeking: true }, 500)).toBeNull()
    // The window runs from the *last sample that reported motion*, so a
    // seek ending somewhere in (500, 600] settles at 600 rather than a
    // full window after the first quiet sample. That is the minimum
    // latency consistent with never settling mid-seek: while a scrub is
    // live, seeking samples keep arriving and keep pushing the window
    // out.
    expect(d.push({ playhead: 8, paused: true, seeking: false }, 600)).toBe(8)
  })

  it('absorbs a sub-epsilon nudge rather than restarting the window', () => {
    // Browsers may snap `currentTime` to a frame boundary once a seek
    // completes. Treated as movement, that restarts the quiet window on
    // every settle and the signal never arrives.
    const d = new PlaybackSettleDetector({ quietMs: 100, epsilonSec: 1e-3 })
    d.push(paused(4.0), 0)
    d.push(paused(4.0003), 60)
    // Settles on schedule, and reports where the playhead *actually is*
    // rather than the position the window opened on — the snap moved the
    // frame, so the nudged value is the truthful one to hand the panel.
    const settled = d.push(paused(4.0004), 100)
    expect(settled).not.toBeNull()
    expect(Math.abs(settled! - 4.0)).toBeLessThanOrEqual(1e-3)
  })

  it('treats a move larger than epsilon as a new position', () => {
    const d = new PlaybackSettleDetector({ quietMs: 100, epsilonSec: 1e-3 })
    d.push(paused(4.0), 0)
    expect(d.push(paused(4.0), 100)).toBe(4.0)
    // A step to the next frame is a different frame, and settles again.
    d.push(paused(4.5), 120)
    expect(d.push(paused(4.5), 260)).toBe(4.5)
  })

  it('is inert with no playhead, and forgets what it saw', () => {
    // An image dataset, or a video that has not loaded. The forgetting
    // matters: carrying a position across a dataset swap would let the
    // first sample of the new one look like a continuation of the old.
    const d = new PlaybackSettleDetector({ quietMs: 100 })
    d.push(paused(7), 0)
    expect(d.push(paused(7), 100)).toBe(7)
    expect(d.push({ playhead: null, paused: true }, 200)).toBeNull()
    // Same position, new dataset — it must settle again rather than be
    // suppressed as already reported.
    d.push(paused(7), 300)
    expect(d.push(paused(7), 400)).toBe(7)
  })

  it('ignores a non-finite playhead rather than settling on NaN', () => {
    const d = new PlaybackSettleDetector({ quietMs: 100 })
    expect(d.push({ playhead: NaN, paused: true }, 0)).toBeNull()
    expect(d.push({ playhead: NaN, paused: true }, 500)).toBeNull()
  })

  it('re-arms after reset, for a dataset swap at the same position', () => {
    const d = new PlaybackSettleDetector({ quietMs: 100 })
    d.push(paused(3), 0)
    expect(d.push(paused(3), 100)).toBe(3)
    d.reset()
    d.push(paused(3), 200)
    expect(d.push(paused(3), 300)).toBe(3)
  })
})

describe('createPlaybackSettleWatcher', () => {
  it('calls back once with the settled playhead', () => {
    let sample: PlaybackSample = playing(0)
    const onSettled = vi.fn()
    const w = createPlaybackSettleWatcher(() => sample, onSettled, { quietMs: 100 })

    w.tick(0)
    sample = paused(9)
    w.tick(10)
    w.tick(110)
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledWith(9)

    w.tick(400)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('survives a read that throws during teardown', () => {
    // Wired into the playback loop, which must keep driving the scrubber
    // through a transient null access on a panel being torn down.
    const onSettled = vi.fn()
    const w = createPlaybackSettleWatcher(
      () => { throw new Error('video gone') },
      onSettled,
      { quietMs: 10 },
    )
    expect(() => w.tick(0)).not.toThrow()
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('does not re-fire a position whose consumer threw', () => {
    // The alternative is a consumer that fails once and is then retried
    // at frame rate forever — the exact runaway this surface exists to
    // avoid.
    let sample: PlaybackSample = paused(2)
    const onSettled = vi.fn(() => { throw new Error('panel blew up') })
    const w = createPlaybackSettleWatcher(() => sample, onSettled, { quietMs: 50 })
    w.tick(0)
    expect(() => w.tick(60)).not.toThrow()
    expect(onSettled).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) w.tick(100 + i * 16)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('re-arms through reset', () => {
    let sample: PlaybackSample = paused(1)
    const onSettled = vi.fn()
    const w = createPlaybackSettleWatcher(() => sample, onSettled, { quietMs: 50 })
    w.tick(0)
    w.tick(60)
    expect(onSettled).toHaveBeenCalledTimes(1)
    w.reset()
    w.tick(100)
    w.tick(200)
    expect(onSettled).toHaveBeenCalledTimes(2)
  })
})
