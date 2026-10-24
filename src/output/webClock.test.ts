// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import {
  EXACT_PAUSE_EPS_S,
  HELD_TOLERANCE_S,
  clipClockInputs,
  clockTargetS,
  createWebClockSteer,
  type ClipClockInputs,
} from './webClock'
import { MAX_WEB_RATE, type WebClock } from './webMode'
import { syncVideoToState, type SyncTarget } from './outputSync'
import type { MirroredDataset } from '../services/multiOutput/protocol'

const LOADED_AT = 1_761_288_000_000

function clock(over: Partial<WebClock> = {}): WebClock {
  return { positionS: 0, atUnixS: null, rate: 1, paused: false, ...over }
}

function video(over: Partial<SyncTarget> = {}): SyncTarget {
  return {
    readyState: 4,
    duration: 100,
    paused: false,
    seeking: false,
    currentTime: 0,
    playbackRate: 1,
    play: vi.fn(),
    pause: vi.fn(),
    ...over,
  }
}

describe('clockTargetS', () => {
  it('runs from the anchor at the given rate', () => {
    const c = clock({ positionS: 10, atUnixS: LOADED_AT / 1000, rate: 2 })
    expect(clockTargetS(c, LOADED_AT + 5_000, 0, 100)).toBe(20)
  })

  it('tells resuming at 40 s from resuming at 70 s', () => {
    // The reason the clock carries a position and not just a start.
    const at = LOADED_AT / 1000
    expect(clockTargetS(clock({ positionS: 40, atUnixS: at }), LOADED_AT, 0, 100)).toBe(40)
    expect(clockTargetS(clock({ positionS: 70, atUnixS: at }), LOADED_AT, 0, 100)).toBe(70)
  })

  it('uses when this copy read the clock as the anchor when the address gives none', () => {
    expect(clockTargetS(clock({ positionS: 0 }), LOADED_AT + 3_000, LOADED_AT, 100)).toBe(3)
  })

  it('wraps round a looping clip, in either direction', () => {
    const at = LOADED_AT / 1000
    expect(clockTargetS(clock({ positionS: 90, atUnixS: at }), LOADED_AT + 20_000, 0, 100)).toBe(10)
    // A visitor's clock a little behind the anchor's.
    expect(clockTargetS(clock({ positionS: 0, atUnixS: at }), LOADED_AT - 2_000, 0, 100)).toBe(98)
  })

  it('holds a paused position, whatever the time', () => {
    const c = clock({ positionS: 61.2, atUnixS: 1, paused: true })
    expect(clockTargetS(c, LOADED_AT, 0, 100)).toBe(61.2)
    expect(clockTargetS(c, LOADED_AT + 99_000, 0, 100)).toBe(61.2)
  })
})

/** The desktop layer, given the clip's span in place of the dataset's
 *  own, as the steer gives it. */
const desktopLaw = (v: SyncTarget) => (inputs: ClipClockInputs) =>
  syncVideoToState(v, {
    dataset: { ...DATASET, ...inputs.span },
    primary: inputs.primary,
    playback: inputs.playback,
  })

const DATASET: MirroredDataset = {
  id: 'D',
  url: 'https://example/d.m3u8',
  kind: 'video',
  overlay: {},
  startTime: null,
  endTime: null,
}

describe('clipClockInputs', () => {
  it('paces the law at exactly the clock rate', () => {
    // The "primary" is a clip of the same length over the same span, so
    // the law's pacing ratio is 1 and only the clock rate is left.
    const v = video({ duration: 200, currentTime: 50 })
    const outcome = desktopLaw(v)(clipClockInputs(50, 200, 0.5))
    expect(outcome).toEqual({ kind: 'playing', driftS: 0, seeked: false })
    expect(v.playbackRate).toBe(0.5)
  })

  it('never puts a target past the end of the span', () => {
    // Past the end reads as out of range, which pauses the clip.
    const inputs = clipClockInputs(100.00049, 100.0005, 1)
    expect(Date.parse(inputs.playback.date!)).toBeLessThanOrEqual(Date.parse(inputs.span.endTime))
    const v = video({ duration: 100.0005, currentTime: 100.0004 })
    expect(desktopLaw(v)(inputs).kind).toBe('playing')
  })
})

describe('createWebClockSteer', () => {
  const AT = LOADED_AT / 1000

  /** A steer whose playhead layer runs on a clock the test moves. */
  function harness() {
    let mono = 0
    const steer = createWebClockSteer({ monotonicMs: () => mono })
    return {
      steer,
      advance(ms: number) {
        mono += ms
      },
      /** Serve a seek on `v` for `ms`, steering every 100 ms as a running
       *  loop does; then land it. Returns the wall-clock offset reached. */
      serve(v: SyncTarget, c: WebClock, ms: number, wallFromMs = 0): number {
        ;(v as { seeking: boolean }).seeking = true
        let wall = wallFromMs
        for (let t = 0; t < ms; t += 100) {
          mono += 100
          wall += 100
          steer.steer(v, c, LOADED_AT + wall, LOADED_AT)
        }
        ;(v as { seeking: boolean }).seeking = false
        return wall
      },
    }
  }

  it('steers a playing copy to the clock', () => {
    const { steer } = harness()
    const v = video({ duration: 200, currentTime: 50 })
    const outcome = steer.steer(v, clock({ positionS: 50, atUnixS: AT, rate: 0.5 }), LOADED_AT, LOADED_AT)
    expect(outcome).toEqual({ kind: 'playing', driftS: 0, seeked: false })
    expect(v.playbackRate).toBe(0.5)
  })

  it('trims away what a slow seek leaves behind, instead of holding it', () => {
    // The first browser run's case. A seek that takes 2 s lands the copy
    // 2 s behind, and the seek-cost floor then declines to seek for
    // anything that small. The ratio path stopped there, at rate 1.
    const { steer, serve } = harness()
    const v = video({ duration: 200, currentTime: 40 })
    const playing = clock({ positionS: 50, atUnixS: AT })

    expect(steer.steer(v, playing, LOADED_AT, LOADED_AT).seeked).toBe(true)
    expect(v.currentTime).toBe(50)
    const wall = serve(v, playing, 2_000)

    const outcome = steer.steer(v, playing, LOADED_AT + wall, LOADED_AT)
    expect(outcome).toEqual({ kind: 'playing', driftS: expect.closeTo(-2, 6), seeked: false })
    expect(v.currentTime).toBe(50)
    expect(v.playbackRate).toBeGreaterThan(1)
  })

  describe('round the loop', () => {
    // Found in review: the law measured error along the line, so just
    // past a wrap a copy 0.7 s behind read as 15.3 s ahead.
    it('reads a copy short of the wrap as behind, not far ahead', () => {
      const { steer } = harness()
      const v = video({ duration: 16, currentTime: 15.8 })
      const outcome = steer.steer(v, clock({ positionS: 0.5, atUnixS: AT }), LOADED_AT, LOADED_AT)
      expect(outcome.driftS).toBeCloseTo(-0.7, 6)
    })

    it('reads a copy just past the wrap as ahead, not far behind', () => {
      const { steer } = harness()
      const v = video({ duration: 16, currentTime: 0.2 })
      const outcome = steer.steer(v, clock({ positionS: 15.9, atUnixS: AT }), LOADED_AT, LOADED_AT)
      expect(outcome.driftS).toBeCloseTo(0.3, 6)
    })

    it('trims the short way round once a slow seek has raised the threshold', () => {
      const { steer, advance } = harness()
      const v = video({ duration: 16, currentTime: 3 })
      const at = (t: number) => clock({ positionS: t, atUnixS: AT })
      // One slow seek, measured at 2.1 s: the floor is now 3.15 s.
      steer.steer(v, at(10), LOADED_AT, LOADED_AT)
      ;(v as { seeking: boolean }).seeking = true
      for (let t = 0; t < 2_000; t += 100) {
        advance(100)
        steer.steer(v, at(10), LOADED_AT, LOADED_AT)
      }
      ;(v as { seeking: boolean }).seeking = false
      advance(100)
      steer.steer(v, at(10), LOADED_AT, LOADED_AT)
      advance(2_000)
      // Short of the wrap, a second behind: speed up, no seek.
      v.currentTime = 15.5
      const outcome = steer.steer(v, at(0.5), LOADED_AT, LOADED_AT)
      expect(outcome).toEqual({ kind: 'playing', driftS: expect.closeTo(-1, 6), seeked: false })
      expect(v.playbackRate).toBeGreaterThan(1)
    })

    it('seeks to the real target, not the re-centred one', () => {
      const { steer } = harness()
      const v = video({ duration: 16, currentTime: 3 })
      expect(steer.steer(v, clock({ positionS: 10, atUnixS: AT }), LOADED_AT, LOADED_AT).seeked).toBe(true)
      expect(v.currentTime).toBeCloseTo(10, 9)
    })

    it('plays a finished element on round the loop, without a seek of its own', () => {
      // An element at its end is at the same point of the loop as one at
      // its start, and `play()` rewinds it there.
      const { steer } = harness()
      const v = video({ duration: 16, currentTime: 16, paused: true })
      const outcome = steer.steer(v, clock({ positionS: 0.1, atUnixS: AT }), LOADED_AT, LOADED_AT)
      expect(outcome).toEqual({ kind: 'playing', driftS: expect.closeTo(-0.1, 6), seeked: false })
      expect(v.play).toHaveBeenCalled()
      expect(v.currentTime).toBe(16)
    })
  })

  it('converges by the trim alone, the short way, after one slow seek on a short loop', () => {
    // A 6 s seek on a 16 s loop sets a 9 s floor, more than any error
    // round the loop can be, so nothing seeks again (found in review, and
    // left so on purpose: see the module doc). What must hold is that
    // the trim then closes the gap the short way round.
    const { steer, serve } = harness()
    const v = video({ duration: 16, currentTime: 3 })
    const playing = clock({ positionS: 10, atUnixS: AT })
    steer.steer(v, playing, LOADED_AT, LOADED_AT)
    const wall = serve(v, playing, 6_000)
    // Landed at 10 with the clock at 16, which is 0: 6 s behind round the loop.
    const outcome = steer.steer(v, playing, LOADED_AT + wall, LOADED_AT)
    expect(outcome).toEqual({ kind: 'playing', driftS: expect.closeTo(-6, 6), seeked: false })
    expect(v.playbackRate).toBeGreaterThan(1)
  })

  it('does not time a seek across a pause', () => {
    // Found in review: a pause while a seek was in flight was recorded as
    // the seek's cost, and the floor stopped the copy seeking for good.
    const { steer, advance } = harness()
    const v = video({ duration: 200, currentTime: 3 })
    steer.steer(v, clock({ positionS: 50, atUnixS: AT }), LOADED_AT, LOADED_AT)
    ;(v as { seeking: boolean }).seeking = true
    // Paused at 50 while the seek is served; the pause lasts a minute.
    for (let t = 0; t < 60_000; t += 100) {
      advance(100)
      steer.steer(v, clock({ positionS: 50, paused: true }), LOADED_AT, LOADED_AT)
    }
    ;(v as { seeking: boolean }).seeking = false
    v.currentTime = 50
    // Resumed, then the address jumps 5 s: a seek, not a trim.
    const resumed = clock({ positionS: 55, atUnixS: AT })
    expect(steer.steer(v, resumed, LOADED_AT, LOADED_AT).seeked).toBe(true)
  })

  it('does not time a seek across a pause shorter than a steering gap', () => {
    // The playhead layer drops a measurement across a stop, a gap over a
    // second and four times the loop's pace; a shorter pause would still
    // be timed, so the paused branch drops the pending seek too.
    const { steer, advance } = harness()
    const v = video({ duration: 200, currentTime: 3 })
    steer.steer(v, clock({ positionS: 50, atUnixS: AT }), LOADED_AT, LOADED_AT)
    ;(v as { seeking: boolean }).seeking = true
    for (let t = 0; t < 900; t += 100) {
      advance(100)
      steer.steer(v, clock({ positionS: 50, paused: true }), LOADED_AT, LOADED_AT)
    }
    ;(v as { seeking: boolean }).seeking = false
    v.currentTime = 50
    // Timed across the pause, 0.9 s would set a 1.35 s floor and trim this.
    expect(steer.steer(v, clock({ positionS: 51, atUnixS: AT }), LOADED_AT, LOADED_AT).seeked).toBe(true)
  })

  it('never writes a seek a hair short of the end, where it would wait for a rewind', () => {
    const { steer } = harness()
    // Half of this clip is not a whole millisecond, so the law's target,
    // rounded to one, sits a sliver short of the view's centre, and a
    // seek to just past the wrap came out a sliver before it.
    const v = video({ duration: 10.0007, currentTime: 6 })
    steer.steer(v, clock({ positionS: 0.0002, atUnixS: AT }), LOADED_AT, LOADED_AT)
    expect(v.currentTime).toBeLessThan(1)
  })

  it('leaves the trim room to catch up at the fastest rate the address allows', () => {
    // At 16x the trim could not speed up, and a copy a seek left behind
    // stayed behind for good (found in review); 12.8 leaves it a quarter.
    const { steer } = harness()
    const v = video({ duration: 1000, currentTime: 49.9 })
    steer.steer(v, clock({ positionS: 50, atUnixS: AT, rate: MAX_WEB_RATE }), LOADED_AT, LOADED_AT)
    expect(v.playbackRate).toBeGreaterThan(MAX_WEB_RATE)
  })

  it('takes a clock with no anchor from when this copy read it', () => {
    // A `#t=40` written ten minutes after the page loaded means 40 s
    // now, not 640 s.
    const { steer } = harness()
    const v = video({ duration: 1000, currentTime: 40 })
    const read = LOADED_AT + 600_000
    expect(steer.steer(v, clock({ positionS: 40 }), read, read).driftS).toBe(0)
  })

  it('does nothing before the element has metadata, or with no length to wrap on', () => {
    const { steer } = harness()
    expect(steer.steer(video({ readyState: 0 }), clock(), LOADED_AT, LOADED_AT).kind).toBe('not-ready')
    expect(steer.steer(video({ duration: NaN }), clock(), LOADED_AT, LOADED_AT).kind).toBe('not-ready')
    // An unbounded stream: `toISOString` throws on it, and a throw here
    // stops the render loop for good (found in review).
    expect(steer.steer(video({ duration: Infinity }), clock(), LOADED_AT, LOADED_AT).kind).toBe('not-ready')
    expect(steer.steer(null, clock(), LOADED_AT, LOADED_AT).kind).toBe('not-ready')
  })

  it('seeks a paused element to the exact frame, however small the drift', () => {
    // The desktop layer would leave 0.05 s alone; "exactly the same
    // frame" cannot.
    const { steer } = harness()
    const v = video({ currentTime: 50.05 })
    const outcome = steer.steer(v, clock({ positionS: 50, paused: true }), LOADED_AT, LOADED_AT)
    expect(v.pause).toHaveBeenCalled()
    expect(v.currentTime).toBe(50)
    expect(outcome).toEqual({ kind: 'paused', driftS: expect.closeTo(0.05, 6), seeked: true })
  })

  it('seeks once per paused target, even if the browser reads back a hair off', () => {
    const { steer } = harness()
    const v = video({ currentTime: 10, paused: true })
    const paused = clock({ positionS: 50, paused: true })
    expect(steer.steer(v, paused, LOADED_AT, LOADED_AT).seeked).toBe(true)
    // The element lands a little off the written value.
    v.currentTime = 50.002
    expect(steer.steer(v, paused, LOADED_AT, LOADED_AT).seeked).toBe(false)
    expect(v.currentTime).toBe(50.002)
    // A new paused position earns a new seek.
    expect(steer.steer(v, clock({ positionS: 60, paused: true }), LOADED_AT, LOADED_AT).seeked).toBe(true)
  })

  it('seeks a paused element again when the first seek landed a frame away, but only once', () => {
    const { steer } = harness()
    const v = video({ currentTime: 10, paused: true })
    const paused = clock({ positionS: 50, paused: true })
    steer.steer(v, paused, LOADED_AT, LOADED_AT)
    v.currentTime = 50 + HELD_TOLERANCE_S * 3
    expect(steer.steer(v, paused, LOADED_AT, LOADED_AT).seeked).toBe(true)
    expect(v.currentTime).toBe(50)
    // An engine that lands it there every time is left there, rather
    // than re-seeked after every landing.
    v.currentTime = 50 + HELD_TOLERANCE_S * 3
    expect(steer.steer(v, paused, LOADED_AT, LOADED_AT).seeked).toBe(false)
    expect(steer.steer(v, paused, LOADED_AT, LOADED_AT).seeked).toBe(false)
  })

  it('wraps a paused t past the end of the clip', () => {
    const { steer } = harness()
    const v = video({ duration: 100, currentTime: 0, paused: true })
    steer.steer(v, clock({ positionS: 130, paused: true }), LOADED_AT, LOADED_AT)
    expect(v.currentTime).toBe(30)
  })

  it('seeks the new element after a switch, even when the old one spent its re-seek', () => {
    // Found in review, the second time: held by target alone, the budget
    // one element had spent was charged to the next.
    const { steer } = harness()
    const paused = clock({ positionS: 30, paused: true })
    const a = video({ currentTime: 0, paused: true })
    steer.steer(a, paused, LOADED_AT, LOADED_AT)
    a.currentTime = 30 + HELD_TOLERANCE_S * 3
    steer.steer(a, paused, LOADED_AT, LOADED_AT)
    a.currentTime = 30 + HELD_TOLERANCE_S * 3
    expect(steer.steer(a, paused, LOADED_AT, LOADED_AT).seeked).toBe(false)
    const b = video({ currentTime: 0, paused: true })
    expect(steer.steer(b, paused, LOADED_AT, LOADED_AT).seeked).toBe(true)
    expect(b.currentTime).toBe(30)
  })

  it('keeps the floor it measured across a pause', () => {
    const { steer, serve } = harness()
    const v = video({ duration: 200, currentTime: 3 })
    const playing = clock({ positionS: 50, atUnixS: AT })
    steer.steer(v, playing, LOADED_AT, LOADED_AT)
    const wall = serve(v, playing, 2_000)
    steer.steer(v, playing, LOADED_AT + wall, LOADED_AT)
    steer.steer(v, clock({ positionS: 60, paused: true }), LOADED_AT, LOADED_AT)
    // Resumed 1 s out: under the 3 s floor that seek measured, trimmed.
    v.currentTime = 59
    expect(steer.steer(v, clock({ positionS: 60, atUnixS: AT }), LOADED_AT, LOADED_AT).seeked).toBe(false)
  })

  it('seeks the new element after a dataset switch at the same paused time', () => {
    // Found in review: the hold remembered the target and not the
    // element, so the new dataset stayed at 0 while copies that loaded
    // fresh sat at 30.
    const { steer } = harness()
    const paused = clock({ positionS: 30, paused: true })
    const a = video({ currentTime: 0, paused: true })
    steer.steer(a, paused, LOADED_AT, LOADED_AT)
    a.currentTime = 30
    const b = video({ currentTime: 0.03, paused: true })
    expect(steer.steer(b, paused, LOADED_AT, LOADED_AT).seeked).toBe(true)
    expect(b.currentTime).toBe(30)
  })

  it('leaves a paused element alone within a millisecond of the target', () => {
    const { steer } = harness()
    const v = video({ currentTime: 50 + EXACT_PAUSE_EPS_S / 2, paused: true })
    expect(steer.steer(v, clock({ positionS: 50, paused: true }), LOADED_AT, LOADED_AT).seeked).toBe(false)
  })

  it('does not measure a paused element mid-seek', () => {
    const { steer } = harness()
    const v = video({ currentTime: 3, seeking: true, paused: true })
    expect(steer.steer(v, clock({ positionS: 50, paused: true }), LOADED_AT, LOADED_AT)).toEqual({
      kind: 'seeking',
      driftS: null,
      seeked: false,
    })
    expect(v.currentTime).toBe(3)
  })

  it('forgets the held target when play resumes, so pausing at the same time seeks again', () => {
    const { steer } = harness()
    const v = video({ currentTime: 10 })
    const paused = clock({ positionS: 50, paused: true })
    steer.steer(v, paused, LOADED_AT, LOADED_AT)
    steer.steer(v, clock({ positionS: 50, atUnixS: AT }), LOADED_AT, LOADED_AT)
    v.currentTime = 55
    expect(steer.steer(v, paused, LOADED_AT, LOADED_AT).seeked).toBe(true)
  })
})
