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
 * then always the short way round.
 *
 * **The seam is turned here.** An element that plays past the period
 * (into its sound track's tail) or stops at its own end is turned back
 * by this steer, to the target plus what the last turn cost, and the
 * layer is told (`noteSeek`). Left to the law's `play()`, which rewinds
 * an element at its end to 0, the restart was a seek nobody had timed,
 * and a short loop fell 170 to 300 ms behind at every seam (found in
 * review, in Chromium on the real streams).
 *
 * **One period for every copy.** The loop is the stream's playlist
 * total, the `#EXTINF`s summed (`HLSService.playlistDurationS`), not the
 * element's `duration`, which holds that number only until the stream has
 * buffered to its end and then becomes the latest end of every track:
 * measured in Chromium, 21 to 40 ms past it on the node's bundles
 * carrying AAC, and within 6 µs of it on Vimeo's (found in review,
 * October 2026). Wrapped on `duration`, a copy changed its period once
 * its last segment arrived, copies on different engines looped on
 * different periods and drifted apart by the difference every loop since
 * the anchor, and the exhibit's card could not name the period at all.
 * The playlist's total is one number for every copy that reads one,
 * wherever the renditions agree (the node's own bundles, and the Vimeo
 * streams the card has checked), and for those it is what the card sends
 * (the maintainer's decision, 26 October 2026). Only a stream with no playlist to state one (a single
 * file, or a browser playing HLS natively) loops on its element's own
 * length.
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

/** What turning an element back at the loop's seam is taken to cost until
 *  one turn has been timed: the restart measured 50 to 250 ms in Chromium
 *  on the real streams, and a fixed 0.13 s lead there brought each seam
 *  from 170 to 300 ms behind to within 45 ms (found in review). */
export const SEAM_LEAD_INITIAL_S = 0.1

/** The most a timed turn is believed to cost. One that stood still longer
 *  was a stall, or steering stopping (a hidden tab) while the element was
 *  frozen, not the restart, and is thrown away: leading by it would put
 *  the copy that far ahead. A shorter stop with the element frozen is
 *  timed as the turn, and usually costs one seam: the lead is capped
 *  (`SEAM_LEAD_MAX_CLIP_S`) and the next turn is timed again, unless that
 *  reading is dropped too. */
export const SEAM_LEAD_MAX_S = 0.5

/** The furthest a turn leads into the clip, in the clip's own seconds,
 *  whatever the stall times the rate. The node's bundles have one keyframe
 *  a segment, at its start, so a turn landing x seconds in decodes from 0
 *  to x first: at 4x a landing 0.7 s in stood 184 ms and one 2.1 s in
 *  349, where the restart at 0 stood about 100, and since a longer stall
 *  led deeper the lead fed itself, freezing Ocean Circulation for 22% of
 *  the time at 4x, against 11% before there was a lead (found in review,
 *  in Chromium on the real streams). A quarter second decodes in about
 *  30 ms, and binds at rate 1 only on a turn that stood longer than
 *  250 ms, the top of the measured range. What the lead does not cover is
 *  left to the law: trimmed inside the settle window, and not seeked while
 *  the seek-cost floor, which the turn's own stall raises, stays above
 *  it. At 12.8x on a 4.3 s loop nothing keeps sync, capped or not.
 *
 *  It must stay under `SETTLING_SEEK_THRESHOLD_S`, and a test holds it
 *  there. A turn lands ahead by its lead until the stall eats into it,
 *  and a lead past that threshold is seeked back on the first frame the
 *  seek lands, before the element plays on, so the turn is never timed
 *  and the lead never corrected: two seeks a seam for the element's life
 *  (found in review, in simulation). */
export const SEAM_LEAD_MAX_CLIP_S = 0.25

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

/** A length the clock can wrap on: finite and positive. An unbounded
 *  stream reads `Infinity`, which `toISOString` throws on. */
function usable(seconds: number | null | undefined): seconds is number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
}

/** The period a clip loops on: the stream's playlist total, when it
 *  states one (copies agree on it wherever the renditions do), or else
 *  the element's own length. */
function loopPeriodS(video: SyncTarget, periodS: number | null | undefined): number {
  return usable(periodS) ? periodS : video.duration
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
  /** The loop's length (`loopPeriodS`). Past it and before the element's
   *  own end is the start of the next loop. */
  periodS: number
}

/**
 * `play()`, its refusal handed to `onRefused` rather than left unhandled:
 * a real element answers with a promise, rejected when the browser won't
 * play it (an autoplay policy) or when something interrupts it.
 */
function play(element: SyncTarget, onRefused: (err: unknown) => void): void {
  const played = element.play() as unknown
  if (played && typeof (played as Promise<void>).catch === 'function') (played as Promise<void>).catch(onRefused)
}

function loopView(element: SyncTarget, onRefused: (err: unknown) => void): LoopView {
  const view = {
    element,
    centreS: 0,
    periodS: element.duration,
    get readyState() {
      return element.readyState
    },
    get duration() {
      return view.periodS
    },
    get paused() {
      return element.paused
    },
    get seeking() {
      return element.seeking
    },
    get currentTime() {
      const d = view.periodS
      return wrap(element.currentTime - view.centreS + d / 2, d)
    },
    set currentTime(seen: number) {
      const d = view.periodS
      const real = wrap(seen + view.centreS - d / 2, d)
      element.currentTime = real > d - END_AS_START_S ? 0 : real
    },
    get playbackRate() {
      return element.playbackRate
    },
    set playbackRate(rate: number) {
      element.playbackRate = rate
    },
    play: () => play(element, onRefused),
    pause: () => element.pause(),
  }
  return view
}

export interface WebClockSteer {
  /**
   * Steer `video` toward the clock. Called every frame, like the
   * desktop steering it reuses. `nowMs` is wall-clock time and
   * `readAtMs` when this copy read the clock (see `clockTargetS`).
   * `periodS` is the stream's playlist total, when it states one
   * (`loopPeriodS`); without it the element's own length is used.
   */
  steer(video: SyncTarget | null, clock: WebClock, nowMs: number, readAtMs: number, periodS?: number | null): SyncOutcome
}

export function createWebClockSteer(
  deps: {
    /** The playhead layer's own clock, monotonic, for its seek-settle
     *  window and seek-cost measurement. */
    monotonicMs?: () => number
    /** A `play()` the browser refused or something interrupted, with its
     *  error: how `webOutput` learns a page may not play aloud. */
    onPlayRefused?: (err: unknown) => void
  } = {},
): WebClockSteer {
  // The web output's own playhead memory. Not the mirror's: that one is
  // handed the real element, and the law here has to see `loopView`.
  const monotonicMs = deps.monotonicMs ?? (() => performance.now())
  const onRefused = deps.onPlayRefused ?? (() => {})
  const playhead = createPlayheadSync(monotonicMs)
  let view: LoopView | null = null
  /** What turning this element back at the seam last cost: how long it
   *  stood still, from the seek until it played on, and the turn still
   *  being timed, from when and where. */
  let seamCost: {
    element: SyncTarget
    seconds: number
    pending: { sinceMs: number; landingS: number } | null
  } | null = null
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
    steer(video, clock, nowMs, readAtMs, periodS) {
      if (!video || video.readyState < SIBLING_MIN_READY_STATE || !usable(video.duration)) {
        return { kind: 'not-ready', driftS: null, seeked: false }
      }
      const d = loopPeriodS(video, periodS)
      const targetS = clockTargetS(clock, nowMs, readAtMs, d)

      if (!clock.paused) {
        held = null
        if (!view || view.element !== video) view = loopView(video, onRefused)
        view.centreS = targetS
        view.periodS = d

        // The seam. An element past the period is in the tail its sound
        // track runs on, and one stopped at its own end waits for a
        // `play()` that rewinds it to 0: either way the restart, 50 to
        // 250 ms in Chromium on the real streams, was a seek the layer
        // never saw. It left a short loop 170 to 300 ms behind after each
        // seam, and a copy with no seek measured yet seeked again every
        // loop (found in review). So the element is turned back here, to
        // where the clock will be once the turn is served, and the layer
        // is told, so its settle window covers the restart.
        const now = monotonicMs()
        if (seamCost?.element !== video) seamCost = { element: video, seconds: SEAM_LEAD_INITIAL_S, pending: null }
        // Timed until the element plays on, not only until the seek is
        // served: the frames after it take a while to move too, and timing
        // the seek alone led each seam about 50 ms short. What the element
        // played since the turn is taken off, so the cost is the stall.
        const pending = seamCost.pending
        if (pending && !video.seeking && video.currentTime > pending.landingS) {
          const playedS = (video.currentTime - pending.landingS) / (video.playbackRate || 1)
          const stoodS = (now - pending.sinceMs) / 1000 - playedS
          // Below zero is no stall either: the element played further than
          // the time allows, as when hls.js nudges it over a hole.
          if (stoodS >= 0 && stoodS <= SEAM_LEAD_MAX_S) seamCost.seconds = stoodS
          seamCost.pending = null
        }
        const atItsEnd = video.paused && video.currentTime >= video.duration - END_AS_START_S
        if (!video.seeking && (video.currentTime >= d || atItsEnd)) {
          const driftS = view.currentTime - d / 2
          const landing = wrap(targetS + Math.min(seamCost.seconds * clock.rate, SEAM_LEAD_MAX_CLIP_S), d)
          // Past the element's own end as well as the period's: an element
          // shorter than its stated period would otherwise land on its end,
          // stop there, and be turned again every frame (found in review).
          // That holds the turn to one seek. While the target is between
          // the element's end and the period, a shortfall under about the
          // law's seek threshold lands early and is trimmed; a longer one
          // alternates the clip's first and last frames, the law seeking
          // toward a target the engine stops at the element's end and this
          // turning it back, until the target wraps (found in review, in
          // simulation). Real streams fall short by microseconds (Vimeo's
          // by 6 µs).
          const end = Math.min(d, video.duration) - END_AS_START_S
          const landingS = landing > end ? 0 : landing
          video.currentTime = landingS
          // After the seek: `play()` on an element at its end rewinds it.
          if (video.paused) play(video, onRefused)
          playhead.noteSeek(view)
          seamCost.pending = { sinceMs: now, landingS }
          return { kind: 'playing', driftS, seeked: true }
        }

        const inputs = clipClockInputs(d / 2, d, clock.rate)
        const outcome = playhead.sync(view, {
          dataset: { ...CLIP, ...inputs.span },
          primary: inputs.primary,
          playback: inputs.playback,
        })
        // A seek of the law's own moves the element off the turn being
        // timed, so that turn can no longer be.
        if (outcome.seeked) seamCost.pending = null
        return outcome
      }

      // A seek left outstanding when the clock paused would otherwise be
      // timed against the whole pause. Only that seek is dropped: the floor
      // already measured is this element's, and losing it on every pause
      // cost each resume an unprotected seek and a second stall to learn
      // it again (found in review).
      playhead.dropPendingSeek()
      // And a turn at the seam still being timed, or the pause would be
      // counted as its stall.
      if (seamCost) seamCost.pending = null
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
