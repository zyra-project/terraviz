// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's sync decision layer.
 *
 * `computeSiblingSyncCorrection` is tested where it lives; these cover
 * the layer around it — the gates that stop a correction being computed
 * from nothing, and the writes a correction turns into. Each one is a
 * way a sphere in a gallery misbehaves with nothing on screen to say
 * why.
 */

import { describe, it, expect } from 'vitest'

import {
  OUTPUT_SEEK_SETTLE_MS,
  SEEK_COST_MARGIN,
  STEER_GAP_DISCARD_MS,
  STEER_PACE_WINDOW,
  createPlayheadSync,
  seekCostFloorS,
  syncVideoToState,
  type SyncInputs,
  type SyncTarget,
} from './outputSync'
import { STATIC_FRAME_MS } from './outputScene'
import { SIBLING_HARD_SEEK_THRESHOLD_S, SIBLING_MIN_READY_STATE } from '../utils/time'
import type { MirroredDataset } from '../services/multiOutput/protocol'

/** A week of data, so a date maps to a video time linearly. */
const START = '2026-01-01T00:00:00.000Z'
const END = '2026-01-08T00:00:00.000Z'
const RANGE_MS = Date.parse(END) - Date.parse(START)
/** 100 s of video across that week — 1 s of video per 6048 s of world. */
const DURATION = 100

function dataset(over: Partial<MirroredDataset> = {}): MirroredDataset {
  return {
    id: 'SST',
    url: 'https://cdn.example/sst.m3u8',
    kind: 'video',
    overlay: { datasetId: 'SST' },
    startTime: START,
    endTime: END,
    ...over,
  }
}

/** The instant that maps to `videoTime` seconds into the clip. */
function dateAt(videoTime: number): string {
  return new Date(Date.parse(START) + (videoTime / DURATION) * RANGE_MS).toISOString()
}

function inputs(over: Partial<SyncInputs> = {}): SyncInputs {
  return {
    dataset: dataset(),
    primary: { duration: DURATION, rangeMs: RANGE_MS },
    playback: { date: dateAt(50), positionRatio: 0.5, paused: false, playbackRate: 1 },
    ...over,
  }
}

function target(over: Partial<SyncTarget> = {}): SyncTarget & { played: number; paused_: number } {
  const t = {
    readyState: 4,
    duration: DURATION,
    paused: false,
    seeking: false,
    currentTime: 50,
    playbackRate: 1,
    played: 0,
    paused_: 0,
    play() {
      t.played++
      ;(t as { paused: boolean }).paused = false
    },
    pause() {
      t.paused_++
      ;(t as { paused: boolean }).paused = true
    },
  }
  Object.assign(t, over)
  return t
}

describe('gates — when there is nothing to steer', () => {
  it('does nothing without a video', () => {
    expect(syncVideoToState(null, inputs())).toEqual({
      kind: 'not-ready',
      driftS: null,
      seeked: false,
    })
  })

  it('does nothing before metadata arrives', () => {
    // Below HAVE_METADATA there is no meaningful currentTime to read or
    // write — a seek here is what left three siblings stuck for five
    // seconds in the capture behind SIBLING_SEEK_EPS_S.
    const video = target({ readyState: SIBLING_MIN_READY_STATE - 1, currentTime: 0 })

    const out = syncVideoToState(video, inputs())

    expect(out.kind).toBe('not-ready')
    expect(video.currentTime).toBe(0)
    expect(video.played).toBe(0)
  })

  it('does nothing with a zero or NaN duration', () => {
    for (const duration of [0, Number.NaN]) {
      expect(syncVideoToState(target({ duration }), inputs()).kind).toBe('not-ready')
    }
  })

  it('does nothing without playback state', () => {
    // The one absence with genuinely nothing to mirror: no position, no
    // rate, not even play or pause.
    expect(syncVideoToState(target(), inputs({ playback: null })).kind).toBe('not-ready')
  })

  it('refuses an instant that will not parse rather than seeking to NaN', () => {
    // `new Date('nonsense')` is an Invalid Date, and the arithmetic
    // carries the NaN all the way to `currentTime = NaN` — a seek that
    // throws or silently does nothing depending on the browser.
    const video = target()

    const out = syncVideoToState(
      video,
      inputs({
        playback: { date: 'not-a-date', positionRatio: 0.5, paused: false, playbackRate: 1 },
      }),
    )

    // It falls through to the position path, which is a real steer —
    // but never a NaN one.
    expect(out.kind).toBe('no-range')
    expect(video.currentTime).toBe(50)
  })
})

describe("no time axis — steering on the clip's own position", () => {
  /** A looping animation: media, but no span to place a date in. */
  function looping(over: Partial<SyncInputs> = {}): SyncInputs {
    return inputs({
      dataset: dataset({ startTime: null, endTime: null }),
      primary: null,
      playback: { date: null, positionRatio: 0.5, paused: false, playbackRate: 1 },
      ...over,
    })
  }

  it('starts a clip the output has never played', () => {
    // The bug this path exists to close. An output decodes frame zero
    // on load and then waits for something to call `play()`; the only
    // call sat past a gate that rejected a dateless playback, so every
    // SOS looping animation — Air Traffic among them — held its first
    // frame on every output for the life of the window. On a 24-hour
    // animation that reads as a *longitude* error, because the
    // terminator and the burnt-in clock end up half a day out.
    const video = target({ paused: true, currentTime: 0 })

    const out = syncVideoToState(video, looping())

    expect(out.kind).toBe('no-range')
    expect(video.played).toBe(1)
    expect(video.paused).toBe(false)
  })

  it("seeks to the primary's position in the clip when it is far off", () => {
    const video = target({ currentTime: 10 })

    const out = syncVideoToState(video, looping())

    // Half of a 100 s clip.
    expect(video.currentTime).toBe(50)
    expect(out.seeked).toBe(true)
    expect(out.driftS).toBeCloseTo(-40, 6)
  })

  it('leaves the playhead alone inside the hard-seek threshold', () => {
    // The rule the dated path follows, for the same reason: a seek per
    // frame is a visible stutter on a sphere in front of an audience.
    const video = target({ currentTime: 50 + SIBLING_HARD_SEEK_THRESHOLD_S / 2 })

    const out = syncVideoToState(video, looping())

    expect(out.seeked).toBe(false)
    expect(video.currentTime).toBe(50 + SIBLING_HARD_SEEK_THRESHOLD_S / 2)
  })

  it('mirrors a paused primary rather than running on', () => {
    const video = target({ currentTime: 50 })

    const out = syncVideoToState(
      video,
      looping({ playback: { date: null, positionRatio: 0.5, paused: true, playbackRate: 1 } }),
    )

    expect(out.kind).toBe('paused')
    expect(video.paused).toBe(true)
    expect(video.played).toBe(0)
  })

  it("mirrors the primary's rate rather than assuming 1", () => {
    // terraviz#229 in the dateless path: a tour's `frameRate` task sets
    // the primary's rate alone, and an output running 1x against a
    // 0.167x primary is six times too fast for the whole tour.
    const video = target({ currentTime: 50 })

    syncVideoToState(
      video,
      looping({ playback: { date: null, positionRatio: 0.5, paused: false, playbackRate: 0.167 } }),
    )

    expect(video.playbackRate).toBe(0.167)
  })

  it('seeks before it plays, so an ended clip is not rewound', () => {
    // `play()` on an element sitting at its end rewinds to zero. Called
    // before the seek it silently undoes it, and the output restarts
    // the loop every frame instead of joining the primary.
    const seenAtPlay: number[] = []
    const video = target({ paused: true, currentTime: DURATION })
    const inner = video.play.bind(video)
    video.play = () => {
      seenAtPlay.push(video.currentTime)
      inner()
    }

    syncVideoToState(video, looping())

    expect(seenAtPlay).toEqual([50])
  })

  it('treats a non-finite ratio as the start rather than seeking to NaN', () => {
    const video = target({ currentTime: 50 })

    syncVideoToState(
      video,
      looping({
        playback: { date: null, positionRatio: Number.NaN, paused: false, playbackRate: 1 },
      }),
    )

    expect(video.currentTime).toBe(0)
  })
})

describe('steering', () => {
  it('plays and reports no meaningful drift when already in step', () => {
    const video = target({ currentTime: 50, paused: true })

    const out = syncVideoToState(video, inputs())

    expect(out.kind).toBe('playing')
    expect(out.seeked).toBe(false)
    expect(out.driftS).toBeCloseTo(0, 6)
    expect(video.played).toBe(1)
  })

  it('trims the rate instead of seeking for drift inside the threshold', () => {
    // The terraviz#229 fix: a small error is eased out by the rate, not
    // by a jump. A seek here is a visible flicker on a sphere.
    const video = target({ currentTime: 50 + SIBLING_HARD_SEEK_THRESHOLD_S / 2 })

    const out = syncVideoToState(video, inputs())

    expect(out.seeked).toBe(false)
    expect(video.currentTime).toBeCloseTo(50 + SIBLING_HARD_SEEK_THRESHOLD_S / 2, 6)
    // Ahead of where it should be, so it is slowed down.
    expect(video.playbackRate).toBeLessThan(1)
    expect(out.driftS).toBeGreaterThan(0)
  })

  it('hard-seeks past the threshold — an operator scrub', () => {
    const video = target({ currentTime: 10 })

    const out = syncVideoToState(video, inputs())

    expect(out.seeked).toBe(true)
    expect(video.currentTime).toBeCloseTo(50, 6)
    expect(out.driftS).toBeCloseTo(-40, 6)
  })

  it('pauses without seeking when the control window is paused and in step', () => {
    const video = target({ currentTime: 50 })

    const out = syncVideoToState(
      video,
      inputs({ playback: { date: dateAt(50), positionRatio: 0.5, paused: true, playbackRate: 1 } }),
    )

    expect(out.kind).toBe('paused')
    expect(video.paused_).toBe(1)
    expect(video.currentTime).toBeCloseTo(50, 6)
  })

  it('pauses and lands on the frame when paused after a scrub', () => {
    const video = target({ currentTime: 10 })

    syncVideoToState(
      video,
      inputs({ playback: { date: dateAt(50), positionRatio: 0.5, paused: true, playbackRate: 1 } }),
    )

    expect(video.paused_).toBe(1)
    expect(video.currentTime).toBeCloseTo(50, 6)
  })

  it('pins to a boundary frame and pauses when the date is out of range', () => {
    const before = new Date(Date.parse(START) - 86_400_000).toISOString()
    const video = target({ currentTime: 50 })

    const out = syncVideoToState(
      video,
      inputs({ playback: { date: before, positionRatio: 0, paused: false, playbackRate: 1 } }),
    )

    expect(out.kind).toBe('out-of-range')
    expect(video.paused_).toBe(1)
    expect(video.currentTime).toBeCloseTo(0, 6)
  })

  it('tracks a primary running below 1×, rather than racing it', () => {
    // A tour's `frameRate` task sets the primary's rate alone. An
    // output that assumed 1 against a 0.167× primary runs ~6× fast,
    // hard-seeks back, and repeats for the whole tour — terraviz#229
    // reproduced in a second window.
    const atRate = (primaryPlaybackRate: number) => {
      const video = target({ currentTime: 50 })
      syncVideoToState(
        video,
        inputs({ playback: { date: dateAt(50), positionRatio: 0.5, paused: false, playbackRate: primaryPlaybackRate } }),
      )
      return video.playbackRate
    }

    expect(atRate(1)).toBeCloseTo(1, 6)
    expect(atRate(0.167)).toBeCloseTo(0.167, 6)
    expect(atRate(2)).toBeCloseTo(2, 6)
  })

  it('does not re-play a video that is already playing', () => {
    const video = target({ paused: false, currentTime: 50 })

    syncVideoToState(video, inputs())

    expect(video.played).toBe(0)
  })

  it('does not re-pause a video that is already paused', () => {
    const video = target({ paused: true, currentTime: 50 })

    syncVideoToState(
      video,
      inputs({ playback: { date: dateAt(50), positionRatio: 0.5, paused: true, playbackRate: 1 } }),
    )

    expect(video.paused_).toBe(0)
  })
})

describe('the reported drift', () => {
  it('is positive when ahead and negative when behind', () => {
    const ahead = syncVideoToState(target({ currentTime: 60 }), inputs())
    const behind = syncVideoToState(target({ currentTime: 40 }), inputs())

    // The sign is the contract the debug overlay renders. Flipping it
    // would put "+2.0 s" on a sphere that is two seconds late.
    expect(ahead.driftS).toBeCloseTo(10, 6)
    expect(behind.driftS).toBeCloseTo(-10, 6)
  })

  it('is measured before the correction, not after', () => {
    // Reporting post-seek drift would read 0 on exactly the frames a
    // reader most wants a number for.
    const out = syncVideoToState(target({ currentTime: 10 }), inputs())

    expect(out.seeked).toBe(true)
    expect(out.driftS).toBeCloseTo(-40, 6)
  })
})

describe('seek settling — not chasing a target the seek itself moved', () => {
  /** Behind by 166 ms: what the debug HUD read in the field. */
  const BEHIND_S = 0.166

  it('leaves a seeking element alone', () => {
    // Mid-seek, `currentTime` already reads the target while the frame
    // on the glass is the old one. Any error computed here is fiction,
    // and acting on it is the tightest turn of the loop.
    const video = target({ seeking: true, currentTime: 10 })

    const out = syncVideoToState(video, inputs())

    expect(out.kind).toBe('seeking')
    expect(video.currentTime).toBe(10)
    expect(video.played).toBe(0)
  })

  it('seeks a drift past the threshold when nothing has seeked recently', () => {
    const video = target({ currentTime: 50 - BEHIND_S })

    const out = syncVideoToState(video, inputs())

    expect(out.seeked).toBe(true)
    expect(out.driftS).toBeCloseTo(-BEHIND_S, 6)
  })

  it('trims the same drift instead, inside the settle window', () => {
    // The field bug. A seek is not instant: the element stalls, the
    // decoder refills, and the primary plays on throughout, so the
    // moment a seek lands the output is behind again by however long
    // the seek took. Seeking that is a loop that manufactures the error
    // it corrects — once per rAF, which is what "very choppy" was.
    const video = target({ currentTime: 50 - BEHIND_S })

    const out = syncVideoToState(video, inputs(), OUTPUT_SEEK_SETTLE_MS / 2)

    expect(out.seeked).toBe(false)
    expect(video.currentTime).toBe(50 - BEHIND_S)
    // Behind, so it runs faster and closes the gap smoothly instead.
    expect(video.playbackRate).toBeGreaterThan(1)
  })

  it('still seeks an error the trim could not close in that window', () => {
    // A scrub, not a settling seek. Suppressing this one would strand
    // the output seconds out with a control that visibly does nothing.
    const video = target({ currentTime: 10 })

    const out = syncVideoToState(video, inputs(), 0)

    expect(out.seeked).toBe(true)
    expect(video.currentTime).toBeCloseTo(50, 6)
  })

  it('reopens the window once the settle time has passed', () => {
    const video = target({ currentTime: 50 - BEHIND_S })

    expect(syncVideoToState(video, inputs(), OUTPUT_SEEK_SETTLE_MS).seeked).toBe(true)
  })
})

describe('createPlayheadSync', () => {
  const BEHIND_S = 0.166

  function at(times: number[]): { sync: ReturnType<typeof createPlayheadSync>['sync'] } {
    let i = 0
    return createPlayheadSync(() => times[Math.min(i++, times.length - 1)] ?? 0)
  }

  it('suppresses the second seek and allows one after the window', () => {
    const controller = at([0, 10, 20, OUTPUT_SEEK_SETTLE_MS + 1])
    const video = target({ currentTime: 50 - BEHIND_S })
    const state = inputs()

    // Seeks, and lands where it was asked to.
    expect(controller.sync(video, state).seeked).toBe(true)
    // Two frames later the primary has moved on and the element is
    // behind again — the loop's next turn, now refused.
    video.currentTime = 50 - BEHIND_S
    expect(controller.sync(video, state).seeked).toBe(false)
    video.currentTime = 50 - BEHIND_S
    expect(controller.sync(video, state).seeked).toBe(false)
    // Past the window, one more correction is allowed.
    video.currentTime = 50 - BEHIND_S
    expect(controller.sync(video, state).seeked).toBe(true)
  })

  it('treats a seek the caller noted as its own, settle window and all', () => {
    // The web clock's turn at a loop's seam: made on the element directly,
    // and without the note the next call seeked again for the restart.
    let now = 0
    const controller = createPlayheadSync(() => now)
    const video = target({ currentTime: 50 - BEHIND_S })
    const state = inputs()
    controller.noteSeek(video)
    now = 10
    expect(controller.sync(video, state).seeked).toBe(false)
    // Past the window, an error past the threshold is corrected again.
    now = OUTPUT_SEEK_SETTLE_MS + 20
    video.currentTime = 50 - BEHIND_S
    expect(controller.sync(video, state).seeked).toBe(true)
  })

  /** Frames at 16 ms from `from` to `to`, the element seeking until the last. */
  function standStill(controller: ReturnType<typeof createPlayheadSync>, video: SyncTarget, clock: { now: number }, to: number) {
    ;(video as { seeking: boolean }).seeking = true
    while (clock.now + 16 < to) {
      clock.now += 16
      controller.sync(video, inputs())
    }
    clock.now = to
    ;(video as { seeking: boolean }).seeking = false
    controller.sync(video, inputs())
  }

  it("measures a noted seek's cost into the floor", () => {
    const clock = { now: 0 }
    const controller = createPlayheadSync(() => clock.now)
    const video = target({ currentTime: 50 })
    controller.sync(video, inputs())
    clock.now = 16
    controller.noteSeek(video)
    // The turn stands still for 1.2 s before the element plays on.
    standStill(controller, video, clock, 1216)
    // Past the window, half a second out is under that cost's floor, so
    // the law trims rather than seek into another 1.2 s stall.
    clock.now += OUTPUT_SEEK_SETTLE_MS
    video.currentTime = 49.5
    const out = controller.sync(video, inputs())
    expect(out.seeked).toBe(false)
    expect(video.playbackRate).toBeGreaterThan(1)
  })

  it("starts a new element's measurement at the note, not at its first sync", () => {
    const clock = { now: 0 }
    const controller = createPlayheadSync(() => clock.now)
    const first = target({ currentTime: 10 })
    expect(controller.sync(first, inputs()).seeked).toBe(true)
    standStill(controller, first, clock, 1200)

    // A new element, turned at once. Without taking it as the element
    // being steered, its first sync would forget the note and seek again.
    const second = target({ currentTime: 50 - BEHIND_S })
    clock.now += 16
    controller.noteSeek(second)
    clock.now += 16
    expect(controller.sync(second, inputs()).seeked).toBe(false)
  })

  it('times a noted seek made on the first call after a stop', () => {
    // Steering stopped (a hidden tab), and the first thing on the way back
    // was the caller's own seek. Measured from the last `sync`, the next
    // call read the gap as a stop and dropped the seek unmeasured, so a
    // slow restart left no floor and the law seeked again (found in
    // review).
    const clock = { now: 0 }
    const controller = createPlayheadSync(() => clock.now)
    const video = target({ currentTime: 50 })
    controller.sync(video, inputs())
    clock.now = 60_000
    controller.noteSeek(video)
    standStill(controller, video, clock, 61_200)
    clock.now += OUTPUT_SEEK_SETTLE_MS
    video.currentTime = 49.5
    expect(controller.sync(video, inputs()).seeked).toBe(false)
  })

  it('times a noted seek made on the first call after a pause', () => {
    // A pause clears the call time on purpose, so the pause is not an
    // interval; the seek that ends it still is one to time.
    const clock = { now: 0 }
    const controller = createPlayheadSync(() => clock.now)
    const video = target({ currentTime: 50 })
    controller.sync(video, inputs())
    controller.dropPendingSeek()
    clock.now = 30_000
    controller.noteSeek(video)
    standStill(controller, video, clock, 31_200)
    clock.now += OUTPUT_SEEK_SETTLE_MS
    video.currentTime = 49.5
    expect(controller.sync(video, inputs()).seeked).toBe(false)
  })

  it("does not carry the last element's cost to a new one's note", () => {
    const clock = { now: 0 }
    const controller = createPlayheadSync(() => clock.now)
    const first = target({ currentTime: 10 })
    expect(controller.sync(first, inputs()).seeked).toBe(true)
    standStill(controller, first, clock, 1200)

    // The new element's note is dropped across a stop, so it has no cost
    // of its own yet. Half a second out past the window is then an
    // ordinary seek, not one held off by the first element's 1.2 s.
    const second = target({ currentTime: 49.5 })
    clock.now += 16
    controller.noteSeek(second)
    clock.now += 5_000
    expect(controller.sync(second, inputs()).seeked).toBe(true)
  })

  it('does not start the window on a call that did not seek', () => {
    // Stamping every call would suppress the *first* seek after a quiet
    // period, which is the one that matters.
    const controller = at([0, 10])
    const aligned = target({ currentTime: 50 })

    expect(controller.sync(aligned, inputs()).seeked).toBe(false)
    expect(controller.sync(target({ currentTime: 10 }), inputs()).seeked).toBe(true)
  })
})

/**
 * The seek loop, simulated.
 *
 * This is the one failure in this module that cannot be reasoned about
 * from a single call: every individual correction is right, and the bug
 * is what a sequence of right corrections does to an element that takes
 * time to serve them. So the element here models the part that matters
 * — a seek stalls it for a fixed cost, `currentTime` reads the target
 * throughout, and the control window plays on the whole time — and the
 * assertion is on the *count* of seeks over a run.
 *
 * Reported from hardware as a bbox forecast whose output "seems to
 * struggle" with the debug HUD showing a permanent dash for sync, and
 * whose control window returned to normal speed the moment the output
 * was closed.
 */
describe('a seek must not manufacture the error it corrects', () => {
  const SIM_START = '2026-01-01T00:00:00.000Z'
  /** Ten minutes of video over ten minutes of world: one video second
   *  per real second, which is what an output mirroring the control
   *  window's own dataset actually has. */
  const SIM_DURATION = 600
  const SIM_RANGE_MS = SIM_DURATION * 1000
  const SIM_END = new Date(Date.parse(SIM_START) + SIM_RANGE_MS).toISOString()
  const FRAME_MS = 1000 / 60

  function inputsAt(primaryTime: number): SyncInputs {
    return {
      dataset: dataset({ startTime: SIM_START, endTime: SIM_END }),
      primary: { duration: SIM_DURATION, rangeMs: SIM_RANGE_MS },
      playback: {
        date: new Date(Date.parse(SIM_START) + primaryTime * 1000).toISOString(),
        positionRatio: primaryTime / SIM_DURATION,
        paused: false,
        playbackRate: 1,
      },
    }
  }

  /**
   * Run the correction for `seconds`, reporting how often it seeked.
   *
   * `steer` is the layer under test: the controller (which measures)
   * or a bare `syncVideoToState` closure (which is what this module did
   * before it measured). Passing it in is what lets one simulation show
   * both behaviours without a second copy of the element model.
   */
  function simulate(opts: {
    seekMs: number
    initialDriftS: number
    seconds: number
    steer: (video: SyncTarget, state: SyncInputs, nowMs: number) => void
  }): { seeks: number; finalDriftS: number; stalledFraction: number } {
    let now = 0
    let primaryTime = 60
    let stalledFrames = 0
    let frames = 0
    const el = {
      time: 60 + opts.initialDriftS,
      paused: true,
      seekTarget: null as number | null,
      seekEndsAt: 0,
      seeks: 0,
    }
    const video: SyncTarget = {
      readyState: 4,
      duration: SIM_DURATION,
      playbackRate: 1,
      get paused() {
        return el.paused
      },
      // True from the write until the frame is served, exactly as an
      // element reports it — and `currentTime` reads the *target* for
      // that whole window, which is the trap the layer is built around.
      get seeking() {
        return el.seekTarget !== null
      },
      get currentTime() {
        return el.seekTarget ?? el.time
      },
      set currentTime(t: number) {
        el.seeks++
        el.seekTarget = t
        el.seekEndsAt = now + opts.seekMs
      },
      play() {
        el.paused = false
      },
      pause() {
        el.paused = true
      },
    }

    for (let frame = 0; frame * FRAME_MS < opts.seconds * 1000; frame++) {
      frames++
      now += FRAME_MS
      // The control window never stalls: it is playing its own copy.
      primaryTime += FRAME_MS / 1000
      if (el.seekTarget !== null && now >= el.seekEndsAt) {
        el.time = el.seekTarget
        el.seekTarget = null
      } else if (el.seekTarget === null && !el.paused) {
        // A stalled element does not advance; a playing one advances at
        // whatever rate the trim last asked for.
        el.time += (FRAME_MS / 1000) * video.playbackRate
      }
      // Counted after the element has been advanced and before it is
      // steered, so this is the fraction of frames the glass spent
      // showing a frame the decoder had already abandoned. It is also
      // the fraction of HUD samples that can only read a dash, since a
      // seeking element has no honest drift to report.
      if (el.seekTarget !== null) stalledFrames++
      opts.steer(video, inputsAt(primaryTime), now)
    }

    return {
      seeks: el.seeks,
      finalDriftS: (el.seekTarget ?? el.time) - primaryTime,
      stalledFraction: stalledFrames / frames,
    }
  }

  /**
   * What this module did before it measured: the settle window alone.
   *
   * Written out rather than reached by passing 0 for the cost, because
   * the contrast worth pinning is between two *controllers* — one that
   * remembers only when it seeked and one that also remembers what
   * that cost — and a literal 0 would read as an edge case rather than
   * as the previous design.
   */
  function unmeasuredSteer(): (video: SyncTarget, state: SyncInputs, nowMs: number) => void {
    let lastSeekAtMs = Number.NEGATIVE_INFINITY
    return (video, state, nowMs) => {
      if (syncVideoToState(video, state, nowMs - lastSeekAtMs).seeked) lastSeekAtMs = nowMs
    }
  }

  it('loops forever on a seek slower than the settle window, without the measurement', () => {
    // The regression this guards. A 1.2 s seek outlives
    // OUTPUT_SEEK_SETTLE_MS, so the threshold is back to 150 ms by the
    // time the element lands 1.2 s behind — which earns another seek,
    // which lands it 1.2 s behind again. Twenty seconds of that is one
    // seek roughly every seek-length, and never a frame of playback.
    const run = simulate({
      seekMs: 1200,
      initialDriftS: -5,
      seconds: 20,
      steer: unmeasuredSteer(),
    })

    expect(run.seeks).toBeGreaterThan(10)
    // And it never converges: the drift is still a seek-length out.
    expect(Math.abs(run.finalDriftS)).toBeGreaterThan(SIBLING_HARD_SEEK_THRESHOLD_S)
    // The symptom, which is the part that was reported: the element is
    // mid-seek on almost every frame, so it is decoding from a keyframe
    // over and over instead of playing, and the HUD has no honest drift
    // to print on any of those frames.
    expect(run.stalledFraction).toBeGreaterThan(0.9)
  })

  it('seeks once and then trims, when the cost is measured', () => {
    const playhead = createPlayheadSync(() => clock)
    let clock = 0
    const run = simulate({
      seekMs: 1200,
      initialDriftS: -5,
      seconds: 20,
      steer: (video, state, nowMs) => {
        clock = nowMs
        playhead.sync(video, state)
      },
    })

    // One seek to close the five seconds, and nothing after it: the
    // floor says a 1.2 s seek cannot improve on a 1.2 s error.
    expect(run.seeks).toBe(1)
    // The trim does the rest, and gets inside the sibling threshold
    // well within the run.
    expect(Math.abs(run.finalDriftS)).toBeLessThan(SIBLING_HARD_SEEK_THRESHOLD_S)
    // And the element spends the run playing rather than seeking — the
    // one seek is the only stall in it.
    expect(run.stalledFraction).toBeLessThan(0.1)
  })

  it('still seeks for a scrub, which is larger than any seek costs', () => {
    const playhead = createPlayheadSync(() => clock)
    let clock = 0
    // Two minutes out — an operator dragging the scrubber. A floor that
    // suppressed this would leave the output trimming at 25% for eight
    // minutes to catch up, which is the failure mode opposite to the
    // loop and just as wrong.
    const run = simulate({
      seekMs: 1200,
      initialDriftS: -120,
      seconds: 20,
      steer: (video, state, nowMs) => {
        clock = nowMs
        playhead.sync(video, state)
      },
    })

    expect(run.seeks).toBeGreaterThanOrEqual(1)
    expect(Math.abs(run.finalDriftS)).toBeLessThan(SIBLING_HARD_SEEK_THRESHOLD_S)
  })

  it('leaves a cheap seek exactly where it was', () => {
    const playhead = createPlayheadSync(() => clock)
    let clock = 0
    // 20 ms is a seek inside a buffered range. The floor it yields is
    // below the sibling threshold, so `Math.max` discards it and this
    // run must behave as it always did — which is the property that
    // makes the change free everywhere it is not needed.
    const run = simulate({
      seekMs: 20,
      initialDriftS: -5,
      seconds: 10,
      steer: (video, state, nowMs) => {
        clock = nowMs
        playhead.sync(video, state)
      },
    })

    expect(run.seeks).toBe(1)
    expect(Math.abs(run.finalDriftS)).toBeLessThan(SIBLING_HARD_SEEK_THRESHOLD_S)
  })
})

describe('seekCostFloorS', () => {
  it('is nothing until a seek has been measured', () => {
    // The default, and the reason the change is inert on every asset
    // that has not yet demonstrated a problem.
    expect(seekCostFloorS(0, 1)).toBe(0)
    expect(seekCostFloorS(Number.NaN, 1)).toBe(0)
    expect(seekCostFloorS(-1, 1)).toBe(0)
  })

  it('scales with the primary rate, because that is how far the target moves', () => {
    // The output stalls for the same wall-clock second either way; what
    // differs is how much of the clip the control window got through in
    // it. A tour running at 0.167x leaves six times less error behind
    // the same seek, and a floor that ignored the rate would suppress
    // seeks that were still worth issuing.
    expect(seekCostFloorS(1, 1)).toBeCloseTo(SEEK_COST_MARGIN)
    expect(seekCostFloorS(1, 4)).toBeCloseTo(4 * SEEK_COST_MARGIN)
    expect(seekCostFloorS(1, 0.25)).toBeCloseTo(0.25 * SEEK_COST_MARGIN)
  })

  it('falls back to 1x for a rate that is not one', () => {
    // `playbackFrom` already refuses a non-positive rate, but this
    // function is reachable from the pure entry point too, and a NaN
    // here would reach `Math.max` and make the threshold NaN — which
    // compares false against everything, silently restoring the loop.
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(seekCostFloorS(2, rate)).toBeCloseTo(2 * SEEK_COST_MARGIN)
    }
  })
})

describe('the measurement belongs to one element', () => {
  it('forgets an outstanding seek when the element is replaced', () => {
    // `datasetMirror` builds a fresh element per load and disposes the
    // last. A seek left outstanding on the old one would otherwise be
    // closed against the first frame of the new one — recording the
    // length of a dataset load as the cost of a seek, and pinning the
    // floor at several seconds for the rest of the window.
    let clock = 0
    const playhead = createPlayheadSync(() => clock)

    const first = target({ currentTime: 10 })
    expect(playhead.sync(first, inputs()).seeked).toBe(true)
    // ...and it is still being served when the dataset changes.
    ;(first as { seeking: boolean }).seeking = true

    // Thirty seconds pass loading the next dataset, then a fresh
    // element arrives 40 s out — an ordinary first correction.
    clock += 30_000
    const second = target({ currentTime: 10 })
    const out = playhead.sync(second, inputs())

    // Closing the stale seek against this element would record a 30 s
    // cost, whose floor is 45 s, and a 40 s error would not clear it —
    // so the output would sit where it loaded and never be corrected.
    expect(out.seeked).toBe(true)
    expect(second.currentTime).toBeCloseTo(50)
  })

  it('drops a seek left outstanding across a gap in steering, rather than timing the gap', () => {
    // A hidden tab stops the loop with a seek in flight. Closed on the
    // first frame back, the gap was recorded as the seek's cost and the
    // floor stopped the element seeking for good (found in review).
    let clock = 0
    const playhead = createPlayheadSync(() => clock)
    const video = target({ currentTime: 10 })
    expect(playhead.sync(video, inputs()).seeked).toBe(true)
    ;(video as { seeking: boolean }).seeking = true

    clock += 60_000
    ;(video as { seeking: boolean }).seeking = false
    // Back, and 5 s out: an ordinary correction, not one under a 90 s floor.
    video.currentTime = 45
    expect(playhead.sync(video, inputs()).seeked).toBe(true)
  })

  /** A loop that has been steering at `frameMs` for a while. */
  function runningLoop(frameMs: number, video: SyncTarget) {
    let clock = 0
    const playhead = createPlayheadSync(() => clock)
    for (let i = 0; i < 10; i++) {
      clock += frameMs
      playhead.sync(video, inputs())
    }
    return {
      playhead,
      advance(ms: number) {
        clock += ms
      },
    }
  }

  /**
   * Seek 40 s, let `gapMs` pass with the seek in flight, then come back
   * 5 s out. True when that comes back as a seek: the gap was a stop and
   * was not timed. Timed, a gap of 3.3 s or more sets a floor over 5 s.
   */
  function seekAcrossGap(loop: ReturnType<typeof runningLoop>, video: SyncTarget, gapMs: number, frameMs: number) {
    loop.advance(frameMs)
    video.currentTime = 10
    expect(loop.playhead.sync(video, inputs()).seeked).toBe(true)
    ;(video as { seeking: boolean }).seeking = true
    loop.advance(gapMs)
    ;(video as { seeking: boolean }).seeking = false
    video.currentTime = 45
    return loop.playhead.sync(video, inputs()).seeked
  }

  it('drops a seek across a stop on a loop that has a pace, and on a second stop soon after', () => {
    // The plain case the 60 s test above reaches only before the loop
    // has a pace: real loops always have one by then. The second stop
    // comes two frames after the first, so the first is still in the
    // window: one stop must not move the pace. A mean or a maximum
    // would put this threshold above 10 s.
    const video = target({ currentTime: 50 })
    const loop = runningLoop(16, video)
    expect(seekAcrossGap(loop, video, 60_000, 16)).toBe(true)
    loop.advance(16)
    loop.playhead.sync(video, inputs())
    expect(seekAcrossGap(loop, video, 10_000, 16)).toBe(true)
  })

  it('drops a seek across a stop that comes straight after another', () => {
    // Back for one frame, then gone again: the second gap is the very
    // next interval. A pace read off the last interval alone would take
    // the first stop as the loop's pace and time the second.
    const video = target({ currentTime: 50 })
    const loop = runningLoop(16, video)
    expect(seekAcrossGap(loop, video, 60_000, 16)).toBe(true)
    // That call seeked again, and the loop stops at once.
    ;(video as { seeking: boolean }).seeking = true
    loop.advance(10_000)
    ;(video as { seeking: boolean }).seeking = false
    video.currentTime = 45
    expect(loop.playhead.sync(video, inputs()).seeked).toBe(true)
  })

  it('drops a seek across a stop on a slow loop', () => {
    // 20 s on a 1.5 s loop is a stop at four times the pace; a factor
    // near 20 would time it.
    const video = target({ currentTime: 50 })
    const loop = runningLoop(1_500, video)
    expect(seekAcrossGap(loop, video, 20_000, 1_500)).toBe(true)
  })

  it('drops a seek when the element is still seeking as the loop comes back from a stop', () => {
    // The stop is the gap, whether or not the seek has landed by the
    // first call back. Waiting for it to land would time the whole gap.
    const video = target({ currentTime: 50 })
    const loop = runningLoop(16, video)
    loop.advance(16)
    video.currentTime = 10
    expect(loop.playhead.sync(video, inputs()).seeked).toBe(true)
    ;(video as { seeking: boolean }).seeking = true
    loop.advance(60_000)
    loop.playhead.sync(video, inputs())
    loop.advance(16)
    ;(video as { seeking: boolean }).seeking = false
    video.currentTime = 45
    expect(loop.playhead.sync(video, inputs()).seeked).toBe(true)
  })

  it('keeps timing seeks on a slow loop whose frames jitter', () => {
    // Frames 1.35 to 1.65 s apart. A gap a little over the pace is a
    // slow frame, not a stop; a factor near 1 would drop it.
    let clock = 0
    const playhead = createPlayheadSync(() => clock)
    const video = target({ currentTime: 50 })
    for (const ms of [1_350, 1_650, 1_400, 1_600, 1_500, 1_450, 1_550, 1_380, 1_620]) {
      clock += ms
      playhead.sync(video, inputs())
    }
    clock += 1_500
    video.currentTime = 10
    expect(playhead.sync(video, inputs()).seeked).toBe(true)
    ;(video as { seeking: boolean }).seeking = true
    clock += 1_650
    playhead.sync(video, inputs())
    ;(video as { seeking: boolean }).seeking = false
    clock += 1_650
    // 3.3 s of seek measured, a 4.95 s floor: 2 s out is trimmed.
    video.currentTime = 48
    expect(playhead.sync(video, inputs()).seeked).toBe(false)
  })

  it('takes the new pace within a window when a loop slows', () => {
    // A long run at 60 Hz, then 1.5 s frames. Within eight of them the
    // pace is the new one, and a seek is timed rather than dropped.
    const video = target({ currentTime: 50 })
    let clock = 0
    const playhead = createPlayheadSync(() => clock)
    for (let i = 0; i < 600; i++) {
      clock += 16
      playhead.sync(video, inputs())
    }
    // Eight, written out: a loop bound to the constant would follow a
    // wrong window and pass whatever it was.
    expect(STEER_PACE_WINDOW).toBe(8)
    for (let i = 0; i < 8; i++) {
      clock += 1_500
      playhead.sync(video, inputs())
    }
    clock += 1_500
    video.currentTime = 10
    expect(playhead.sync(video, inputs()).seeked).toBe(true)
    ;(video as { seeking: boolean }).seeking = true
    clock += 1_500
    playhead.sync(video, inputs())
    ;(video as { seeking: boolean }).seeking = false
    clock += 1_500
    // 3 s of seek measured, a 4.5 s floor: 2 s out is trimmed.
    video.currentTime = 48
    expect(playhead.sync(video, inputs()).seeked).toBe(false)
  })

  it('times a seek when an idle loop turns into slow video frames', () => {
    // WebKitGTK: idle callbacks at 16 ms, then 350 ms each once a
    // 4096x2048 video advances. The first of those follows a 16 ms pace,
    // so only the base keeps it from reading as a stop.
    const video = target({ currentTime: 50 })
    const loop = runningLoop(16, video)
    loop.advance(16)
    video.currentTime = 10
    expect(loop.playhead.sync(video, inputs()).seeked).toBe(true)
    ;(video as { seeking: boolean }).seeking = true
    for (let i = 0; i < 4; i++) {
      loop.advance(350)
      loop.playhead.sync(video, inputs())
    }
    ;(video as { seeking: boolean }).seeking = false
    loop.advance(350)
    // 1.75 s of seek measured, a 2.6 s floor: 1.2 s out is trimmed.
    video.currentTime = 48.8
    expect(loop.playhead.sync(video, inputs()).seeked).toBe(false)
  })

  it('keeps the base at least the static frame interval', () => {
    // Below it, a static draw costing more than the base once a second
    // would be a stop every second, and drop every seek.
    expect(STEER_GAP_DISCARD_MS).toBeGreaterThanOrEqual(STATIC_FRAME_MS)
  })

  it('drops the long first draw after a load rather than timing it into the seek', () => {
    // On desktop a long first frame (shader compile, first upload),
    // estimated at 1 to 3 s, follows the new element's first seek. Timed
    // in, it set a floor that slowed every later scrub; dropped, the next
    // scrub just seeks. The 1.5 s case pins the base well under 2.4 s.
    for (const { drawMs, scrubS } of [
      { drawMs: 2_500, scrubS: 3 },
      { drawMs: 1_500, scrubS: 2 },
    ]) {
      const video = target({ currentTime: 50 })
      const loop = runningLoop(16, video)
      loop.advance(16)
      video.currentTime = 10
      loop.playhead.sync(video, inputs())
      ;(video as { seeking: boolean }).seeking = true
      loop.advance(drawMs)
      ;(video as { seeking: boolean }).seeking = false
      loop.playhead.sync(video, inputs())
      loop.advance(2_000)
      video.currentTime = 50 - scrubS
      expect(loop.playhead.sync(video, inputs()).seeked).toBe(true)
    }
  })

  it('takes a pace on a loop slower than the base, and times its seeks', () => {
    const video = target({ currentTime: 50 })
    const loop = runningLoop(3_500, video)
    loop.advance(3_500)
    video.currentTime = 10
    expect(loop.playhead.sync(video, inputs()).seeked).toBe(true)
    ;(video as { seeking: boolean }).seeking = true
    loop.advance(3_500)
    loop.playhead.sync(video, inputs())
    ;(video as { seeking: boolean }).seeking = false
    loop.advance(3_500)
    // 7 s of seek measured, a 10.5 s floor: 5 s out is trimmed.
    video.currentTime = 45
    expect(loop.playhead.sync(video, inputs()).seeked).toBe(false)
  })

  it('does not count the gaps after a deliberate drop as the loop pace', () => {
    // Paused and resumed one frame at a time: each resume's gap is a
    // pause, not an interval, and must not slow the pace until a real
    // stop is timed (found in review).
    const video = target({ currentTime: 50 })
    const loop = runningLoop(16, video)
    for (const gapMs of [2_900, 2_900, 4_200, 6_700, 5_000, 5_000, 5_000, 5_000]) {
      loop.playhead.dropPendingSeek()
      loop.advance(gapMs)
      loop.playhead.sync(video, inputs())
    }
    video.currentTime = 10
    loop.playhead.sync(video, inputs())
    ;(video as { seeking: boolean }).seeking = true
    loop.advance(8_000)
    ;(video as { seeking: boolean }).seeking = false
    video.currentTime = 45
    expect(loop.playhead.sync(video, inputs()).seeked).toBe(true)
  })

  it('still times a seek on a loop whose every frame is slow', () => {
    // A software-rendered loop at 1.5 s a frame. A fixed one-second gap
    // rule dropped every seek here, and seeked on every frame.
    let clock = 0
    const playhead = createPlayheadSync(() => clock)
    const video = target({ currentTime: 50 })
    for (let i = 0; i < 5; i++) {
      clock += 1_500
      playhead.sync(video, inputs())
    }
    clock += 1_500
    video.currentTime = 10
    expect(playhead.sync(video, inputs()).seeked).toBe(true)
    ;(video as { seeking: boolean }).seeking = true
    clock += 1_500
    playhead.sync(video, inputs())
    ;(video as { seeking: boolean }).seeking = false
    clock += 1_500
    // 3 s of seek measured, a 4.5 s floor, so 2 s out is trimmed.
    video.currentTime = 48
    expect(playhead.sync(video, inputs()).seeked).toBe(false)
  })

  it('is not thrown by two calls in one instant on a slow loop', () => {
    // A 0 ms interval in the window. The pace as the shortest interval
    // read that as the loop's pace, so every 1.5 s frame was a stop and
    // the seek was dropped.
    let clock = 0
    const playhead = createPlayheadSync(() => clock)
    const video = target({ currentTime: 50 })
    for (let i = 0; i < 5; i++) {
      clock += 1_500
      playhead.sync(video, inputs())
    }
    // The 0 ms interval, deliberately: no clock advance.
    playhead.sync(video, inputs())
    clock += 1_500
    video.currentTime = 10
    expect(playhead.sync(video, inputs()).seeked).toBe(true)
    ;(video as { seeking: boolean }).seeking = true
    clock += 1_500
    playhead.sync(video, inputs())
    ;(video as { seeking: boolean }).seeking = false
    clock += 1_500
    video.currentTime = 48
    expect(playhead.sync(video, inputs()).seeked).toBe(false)
  })

  it('keeps the floor it measured when a pending seek is dropped on purpose', () => {
    let clock = 0
    const playhead = createPlayheadSync(() => clock)
    const video = target({ currentTime: 10 })
    playhead.sync(video, inputs())
    ;(video as { seeking: boolean }).seeking = true
    for (let ms = 0; ms < 2_000; ms += 100) {
      clock += 100
      playhead.sync(video, inputs())
    }
    ;(video as { seeking: boolean }).seeking = false
    clock += 100
    playhead.sync(video, inputs())
    // A second seek, dropped before it lands.
    video.currentTime = 10
    clock += 100
    expect(playhead.sync(video, inputs()).seeked).toBe(true)
    playhead.dropPendingSeek()
    clock += 100
    // The 2.1 s floor measured before still holds: 1 s out is trimmed.
    video.currentTime = 49
    expect(playhead.sync(video, inputs()).seeked).toBe(false)
  })

  it('still times a seek served while steering ran', () => {
    let clock = 0
    const playhead = createPlayheadSync(() => clock)
    const video = target({ currentTime: 10 })
    playhead.sync(video, inputs())
    ;(video as { seeking: boolean }).seeking = true
    for (let ms = 0; ms < 2_000; ms += 100) {
      clock += 100
      playhead.sync(video, inputs())
    }
    ;(video as { seeking: boolean }).seeking = false
    clock += 100
    // 2.1 s of seek: a 3.15 s floor, so 1 s out is trimmed, not seeked.
    video.currentTime = 49
    expect(playhead.sync(video, inputs()).seeked).toBe(false)
  })
})

/**
 * A paused primary is a stationary target.
 *
 * Both raised bounds — the settle window and the seek-cost floor —
 * exist because the target keeps moving while a seek is being served.
 * Against a stationary one they are not merely unnecessary, they strand
 * the output: the paused branch declines the seek and there is no rate
 * trim to close what is left, so the sphere holds the wrong frame until
 * someone presses play. Caught in review on this PR.
 */
describe('a paused primary is a stationary target', () => {
  const pausedAt50: SyncInputs = inputs({
    playback: { date: dateAt(50), positionRatio: 0.5, paused: true, playbackRate: 1 },
  })

  it('seeks a drift the seek-cost floor would otherwise strand', () => {
    // A 1.2 s seek was measured while playing, so the floor is 1.8 s.
    // The operator then pauses one second out. Nothing here can trim,
    // so declining this seek leaves the output a second from the
    // control globe — on a forecast, an hour of model time — with no
    // event that will ever correct it.
    const video = target({ paused: true, currentTime: 51 })

    const out = syncVideoToState(video, pausedAt50, Number.POSITIVE_INFINITY, 1.2)

    expect(out.kind).toBe('paused')
    expect(out.seeked).toBe(true)
    expect(video.currentTime).toBeCloseTo(50)
  })

  it('seeks a drift the settle window would otherwise strand', () => {
    // Same argument, the other bound: 0.3 s sits under
    // SETTLING_SEEK_THRESHOLD_S and over the sibling threshold. While
    // playing that is right — the trim closes it inside the window.
    // Paused, there is no trim.
    const video = target({ paused: true, currentTime: 50.3 })

    const out = syncVideoToState(video, pausedAt50, 100)

    expect(out.seeked).toBe(true)
    expect(video.currentTime).toBeCloseTo(50)
  })

  it('still leaves a paused output alone when it is already in step', () => {
    // The positive anchor for the two above: dropping the bounds must
    // not make every paused frame a seek. Inside the sibling threshold
    // nothing is issued, which is what stops a paused sphere flickering.
    const video = target({ paused: true, currentTime: 50.05 })

    const out = syncVideoToState(video, pausedAt50, Number.POSITIVE_INFINITY, 1.2)

    expect(out.seeked).toBe(false)
    expect(video.currentTime).toBe(50.05)
  })

  it('converges in one seek, because the target does not move', () => {
    // The fear that motivated both bounds is thrash, and it cannot
    // happen here: the seek lands where it aimed, so the next call
    // measures nothing to correct. One seek, not a loop.
    let clock = 0
    const playhead = createPlayheadSync(() => clock)
    const video = target({ paused: true, currentTime: 55 })

    expect(playhead.sync(video, pausedAt50).seeked).toBe(true)
    clock += 1000
    expect(playhead.sync(video, pausedAt50).seeked).toBe(false)
  })
})
