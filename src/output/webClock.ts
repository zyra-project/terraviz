// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Steering a web output's video to the shared clock in its address
 * (`docs/SECOND_LIFE_COMPAT.md` §7 item 4).
 *
 * Every copy of the page works out where the clip should be from the
 * same anchor — a position, the moment it was current, and a rate — and
 * its own computer's clock. That keeps copies close as long as
 * visitors' clocks are set from internet time.
 *
 * **Playing reuses the desktop steering; paused does not.** While
 * playing, the target goes to the output's existing playhead layer,
 * `computeSiblingSyncCorrection` behind the seek-settle window and the
 * seek-cost floor, because "close" is what was asked for there and that
 * layer is already measured. Paused, the requirement is *exactly the
 * same frame*, and that layer leaves anything within 0.15 s alone
 * (`SIBLING_HARD_SEEK_THRESHOLD_S`), which is several frames apart at
 * 30 fps. So a paused clock seeks to its exact time whatever the drift,
 * and holds there. The desktop tolerance is unchanged.
 *
 * **Dated, not by ratio.** A dataset with no time axis takes that
 * layer's `syncByRatio` on desktop, which seeks and never trims the rate.
 * That leaves the output behind by however long the seek took, and the
 * seek-cost floor then declines to seek again for anything smaller. On
 * desktop that is a constant offset from the operator's globe. Here it
 * is a different offset on every visitor's copy, because each is its
 * own seek on its own connection: 2.7 s on a remote stream in the first
 * browser run, against an expected 0.5. The ratio path skips the trim
 * because it has "no independent clock to measure against", and a web
 * output has one, the wall clock. So the clip's own seconds are given to
 * the dated law as instants from the Unix epoch (`clipClockInputs`). The
 * law then trims an error inside its threshold away, as it does for a
 * sibling globe.
 *
 * **On the loop, not along the line.** The dated law measures error as
 * the straight difference of two positions in [0, d), which is right for
 * a dated span and wrong for a clip that loops: just after the target
 * wraps to 0.5 s, a copy at 15.8 s of a 16 s clip is 0.7 s behind, and
 * the law read it as 15.3 s ahead. Past a wrap it trimmed the wrong way,
 * and with a slow seek raising its threshold it could stay out for tens
 * of seconds (found in review, in simulation). So the law is shown the
 * element *as seen from the target* (`loopView`): every position is
 * measured round the loop and re-centred so the target sits mid-clip,
 * and a seek is turned back into the real position. The error it sees is
 * then always the short way round. An element that played to its end is
 * at the same point of the loop as one at its start, and the law's
 * `play()` rewinds it there, so the loop needs no case of its own.
 *
 * **On a short loop, one slow seek can end seeking.** Round the loop no
 * error exceeds half the clip, and the seek-cost floor is 1.5 times the
 * last seek's cost, so a seek costing a third of the clip or more leaves
 * nothing big enough to seek again. A 6 s first seek, network fetch
 * included, does that to a 16 s loop. The copy then converges by the
 * trim alone, the short way round, within about twice the clip's length.
 * Capping the floor below half the clip was tried and lets almost
 * nothing through, because the trim shrinks the error first. Capping it
 * lower restores the seek loop the floor exists to prevent, on exactly
 * the links that make seeks slow. The real answer is the slow-link
 * design in `docs/SECOND_LIFE_COMPAT.md` §7 (buffer, then join), which
 * is undecided.
 */

import type { WebClock } from './webMode'
import { createPlayheadSync, type SyncOutcome, type SyncTarget } from './outputSync'
import type {
  MirroredDataset,
  MirroredPlayback,
  MirroredPrimary,
} from '../services/multiOutput/protocol'
import { SIBLING_MIN_READY_STATE } from '../utils/time'

/** Closer than this to the paused target is the target. A frame at
 *  30 fps is 33 ms, so a millisecond is well inside one frame. */
export const EXACT_PAUSE_EPS_S = 0.001

/** How far off a seek this steer already made may land before it is
 *  made again. A browser can read `currentTime` back a hair off what was
 *  written, and re-seeking for that would seek every frame; a landing a
 *  frame or more away is the wrong frame, and is retried. Half a frame at
 *  30 fps. */
export const HELD_TOLERANCE_S = 1 / 60

/** How many times a paused seek that landed a frame or more away is
 *  made again. Once is enough for a seek that landed on a hole in what
 *  was buffered. An engine that reports the frame's own timestamp rather
 *  than the time written would otherwise be re-seeked after every
 *  landing, forever (found in review). */
export const PAUSED_RESEEKS = 1

/** A position the loop counts as its start: a seek written a hair short
 *  of the end, where the millisecond rounding of the law's target can
 *  put one just after a wrap, lands on the end and waits for a `play()`
 *  to rewind it. */
const END_AS_START_S = 0.001

/** `value` wrapped into [0, period), for a clip that loops. A value
 *  already inside is returned untouched: the modulo arithmetic would
 *  turn a paused 61.2 into 61.19999999999999, and "exactly the same
 *  frame" should mean the number the address wrote. */
function wrap(value: number, period: number): number {
  if (value >= 0 && value < period) return value
  return ((value % period) + period) % period
}

/** A duration the clock can wrap on: finite and positive. An unbounded
 *  stream reads `Infinity`, which `toISOString` throws on. */
function usableDuration(video: SyncTarget): boolean {
  return Number.isFinite(video.duration) && video.duration > 0
}

/**
 * Where the clip should be, in seconds, wrapped into the clip.
 *
 * `nowMs` and `readAtMs` are wall-clock milliseconds (`Date.now()`),
 * because the anchor is Unix time; a page-relative clock would put every
 * copy on its own epoch. `readAtMs` is when this copy read the clock, the
 * anchor for one with no `at`. A position past the end wraps, paused or
 * playing, since the datasets this plays loop.
 */
export function clockTargetS(
  clock: WebClock,
  nowMs: number,
  readAtMs: number,
  durationS: number,
): number {
  if (clock.paused) return wrap(clock.positionS, durationS)
  const anchorMs = clock.atUnixS === null ? readAtMs : clock.atUnixS * 1000
  return wrap(clock.positionS + ((nowMs - anchorMs) / 1000) * clock.rate, durationS)
}

/** A playing target, as the desktop's dated control law takes it. */
export interface ClipClockInputs {
  /** The dataset span to steer against: the clip's own length, from
   *  the epoch. It replaces the dataset's own span, which describes the
   *  data rather than this clock. */
  span: { startTime: string; endTime: string }
  primary: MirroredPrimary
  playback: MirroredPlayback
}

/**
 * The clip's own seconds as instants: second `s` of the clip is `s`
 * seconds after the epoch, and the "primary" is a clip of the same
 * length over the same span, so the law's pacing rate comes out at
 * exactly `rate`.
 *
 * Whole milliseconds, since that is what an ISO instant holds, and both
 * rounded the same way so the target can never land past the span's
 * end: a target past it reads as out of range and pauses the clip.
 */
export function clipClockInputs(targetS: number, durationS: number, rate: number): ClipClockInputs {
  const rangeMs = Math.round(durationS * 1000)
  return {
    span: { startTime: new Date(0).toISOString(), endTime: new Date(rangeMs).toISOString() },
    primary: { duration: durationS, rangeMs },
    playback: {
      date: new Date(Math.round(targetS * 1000)).toISOString(),
      positionRatio: targetS / durationS,
      paused: false,
      playbackRate: rate,
    },
  }
}

/** What the law reads of a dataset is its span; the rest is never
 *  looked at, and this names no real one. */
const CLIP: Omit<MirroredDataset, 'startTime' | 'endTime'> = {
  id: 'web-clock',
  url: '',
  kind: 'video',
  overlay: {},
}

/** An element seen from a target: positions round the loop, re-centred
 *  on the target. One per element, kept for its life, because the
 *  playhead layer recognises an element by identity and forgets its
 *  seek-cost measurement when that changes. */
interface LoopView extends SyncTarget {
  readonly element: SyncTarget
  /** Real position that reads as mid-clip. */
  centreS: number
}

function loopView(element: SyncTarget): LoopView {
  const view = {
    element,
    centreS: 0,
    get readyState() {
      return element.readyState
    },
    get duration() {
      return element.duration
    },
    get paused() {
      return element.paused
    },
    get seeking() {
      return element.seeking
    },
    get currentTime() {
      const d = element.duration
      return wrap(element.currentTime - view.centreS + d / 2, d)
    },
    set currentTime(seen: number) {
      const d = element.duration
      const real = wrap(seen + view.centreS - d / 2, d)
      element.currentTime = real > d - END_AS_START_S ? 0 : real
    },
    get playbackRate() {
      return element.playbackRate
    },
    set playbackRate(rate: number) {
      element.playbackRate = rate
    },
    play: () => element.play(),
    pause: () => element.pause(),
  }
  return view
}

export interface WebClockSteer {
  /**
   * Steer `video` toward the clock. Called every frame, like the
   * desktop steering it reuses. `nowMs` is wall-clock time and
   * `readAtMs` when this copy read the clock (see `clockTargetS`).
   */
  steer(video: SyncTarget | null, clock: WebClock, nowMs: number, readAtMs: number): SyncOutcome
}

export function createWebClockSteer(
  deps: {
    /** The playhead layer's own clock, monotonic, for its seek-settle
     *  window and seek-cost measurement. */
    monotonicMs?: () => number
  } = {},
): WebClockSteer {
  // The web output's own playhead memory. Not the mirror's: that one is
  // handed the real element, and the law here has to see `loopView`.
  const playhead = createPlayheadSync(deps.monotonicMs)
  let view: LoopView | null = null
  /** The paused target this steer last seeked to, on which element, and
   *  how many times it has seeked there again. Held so a readback a hair
   *  off does not earn a seek every frame, but only within
   *  `HELD_TOLERANCE_S`: an element a frame or more away has not been
   *  seeked there, and gets up to `PAUSED_RESEEKS` more. Tied to the
   *  element because a dataset switch at the same paused time is a new
   *  element owed its own seek: held by target alone, an element that
   *  had spent its re-seeks left the next one on frame 0 while fresh
   *  copies sat on the frame (found in review, twice). */
  let held: { element: SyncTarget; targetS: number; reseeks: number } | null = null

  return {
    steer(video, clock, nowMs, readAtMs) {
      if (!video || video.readyState < SIBLING_MIN_READY_STATE || !usableDuration(video)) {
        return { kind: 'not-ready', driftS: null, seeked: false }
      }
      const d = video.duration
      const targetS = clockTargetS(clock, nowMs, readAtMs, d)

      if (!clock.paused) {
        held = null
        if (!view || view.element !== video) view = loopView(video)
        view.centreS = targetS
        const inputs = clipClockInputs(d / 2, d, clock.rate)
        return playhead.sync(view, {
          dataset: { ...CLIP, ...inputs.span },
          primary: inputs.primary,
          playback: inputs.playback,
        })
      }

      // A seek left outstanding when the clock paused would otherwise be
      // timed against the whole pause. Only that seek is dropped: the floor
      // already measured is this element's, and losing it on every pause
      // cost each resume an unprotected seek and a second stall to learn
      // it again (found in review).
      playhead.dropPendingSeek()
      if (!video.paused) video.pause()
      // Mid-seek, `currentTime` already reads the target while the old
      // frame is still on the glass; measuring it would be fiction.
      if (video.seeking) return { kind: 'seeking', driftS: null, seeked: false }
      const driftS = video.currentTime - targetS
      if (Math.abs(driftS) <= EXACT_PAUSE_EPS_S) return { kind: 'paused', driftS, seeked: false }
      if (held?.element !== video || held.targetS !== targetS) {
        held = { element: video, targetS, reseeks: 0 }
      } else if (Math.abs(driftS) < HELD_TOLERANCE_S || held.reseeks >= PAUSED_RESEEKS) {
        return { kind: 'paused', driftS, seeked: false }
      } else {
        held.reseeks++
      }
      video.currentTime = targetS
      return { kind: 'paused', driftS, seeked: true }
    },
  }
}
