// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output's playback-sync decision layer
 * (`docs/MULTI_MONITOR_PLAN.md` §3 "Playback sync algorithm").
 *
 * The control law itself is `computeSiblingSyncCorrection` in
 * `src/utils/time.ts`, already measured and already tested — an output
 * is just another sibling viewport, so it runs the same law a second
 * globe in a 2-up layout does rather than a simplified one. What lives
 * here is the layer around it: the gates that decide whether a
 * correction can be computed at all, and the translation from a
 * correction into writes on a media element.
 *
 * Split out of the composition below it for the reason `playbackSettle`
 * and `voiceVad` are: this is where the wrong answers live, and it has
 * no business needing a DOM to be tested. `SyncTarget` is the whole
 * surface it touches — five properties and two methods that
 * `HTMLVideoElement` satisfies structurally — so every branch is
 * reachable from a plain object.
 *
 * ## The constants are imported, never restated
 *
 * `SIBLING_HARD_SEEK_THRESHOLD_S`, `SIBLING_MIN_READY_STATE` and
 * `SIBLING_SEEK_EPS_S` all live beside the control law with
 * measurements in their docstrings. An earlier draft of the plan
 * proposed 2000 ms for the hard-seek threshold — 13× the shipped 0.15,
 * and 4× above a value already measured and rejected for being too
 * high. On a control window that is twelve-plus seconds of staggered
 * globes after every scrub; on an 8K sphere in a gallery it is the same
 * error, larger, with nobody able to explain it. A local copy is a copy
 * that drifts from the measurement, so there is none.
 *
 * ## What is deliberately not a special case
 *
 * Operator pause, operator seek, and re-entry from out-of-range are all
 * handled by the general path: a pause is the `paused` branch, a seek is
 * a large error that trips `shouldSeek`, and an out-of-range date pins
 * the output to its nearest boundary frame. Only a *dataset* change
 * needs its own path, and that belongs to whoever owns the media
 * element, not here.
 */

import {
  SIBLING_HARD_SEEK_THRESHOLD_S,
  SIBLING_MIN_READY_STATE,
  SYNC_MAX_RATE_TRIM,
  computeSiblingSyncCorrection,
} from '../utils/time'
import type {
  MirroredDataset,
  MirroredPlayback,
  MirroredPrimary,
} from '../services/multiOutput/protocol'

/**
 * The part of a media element this layer touches.
 *
 * Deliberately minimal, and structural rather than
 * `Pick<HTMLVideoElement, …>`: a real element satisfies it, and a test
 * can satisfy it with an object literal. `play()` is typed as returning
 * `void` so an element's `Promise<void>` is assignable — the promise is
 * not awaited here because a rejected play (autoplay policy, a
 * mid-teardown element) must not throw out of a render loop.
 */
export interface SyncTarget {
  readonly readyState: number
  readonly duration: number
  readonly paused: boolean
  /** True while a `currentTime` write is still being served. Steering a
   *  seeking element measures the *target* against a frame that has not
   *  been decoded yet, so the error reads as a fresh desync and earns
   *  another seek — the tightest turn of the loop below. */
  readonly seeking: boolean
  currentTime: number
  playbackRate: number
  play(): void
  pause(): void
}

/** Everything the decision needs from the mirrored state. */
export interface SyncInputs {
  dataset: MirroredDataset | null
  primary: MirroredPrimary | null
  playback: MirroredPlayback | null
}

export type SyncKind =
  /** No video, no playback state, or metadata that has not arrived.
   *  Nothing to steer yet. */
  | 'not-ready'
  /** A seek this layer asked for is still being served. Left alone. */
  | 'seeking'
  /** The dataset has no time axis, so the clip is steered on its own
   *  position rather than on a real-world instant. Still playing. */
  | 'no-range'
  /** The control window is paused; the output holds the same frame. */
  | 'paused'
  /** The date falls outside this dataset's span; pinned to a boundary. */
  | 'out-of-range'
  /** Steering, in range. */
  | 'playing'

export interface SyncOutcome {
  kind: SyncKind
  /**
   * Seconds this output is *ahead* of where it should be — negative
   * when behind — or `null` when no correction could be computed.
   *
   * Returned rather than merely acted on because it is the number the
   * debug overlay reports as "sync delta", and recomputing it there
   * would be a second implementation free to disagree with the one
   * actually steering.
   */
  driftS: number | null
  /** Whether this call hard-seeked. */
  seeked: boolean
}

const NOT_STEERING = (kind: SyncKind): SyncOutcome => ({ kind, driftS: null, seeked: false })

/**
 * Parse an ISO instant, or `null` if it is not one.
 *
 * These strings come off the wire. `new Date('nonsense')` is an
 * Invalid Date, which propagates silently through the arithmetic below
 * as `NaN` and lands as a `currentTime = NaN` write — a seek that
 * throws or does nothing, depending on the browser, with no clue why.
 */
function instant(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * How long after a hard seek this layer stops reaching for another.
 *
 * A seek is not instant. The element stalls, the decoder refills, and
 * the primary keeps playing throughout — so the moment a seek lands, the
 * output is behind again by however long the seek took. If that is more
 * than the hard-seek threshold, the correction *manufactures* the error
 * it is correcting: seek, stall, measure a fresh desync, seek again,
 * once per rAF. The debug HUD caught it in the field reading a steady
 * `sync -166 ms` against a 150 ms threshold, with the picture visibly
 * choppy — and choppy only sometimes, because an output that happens to
 * start inside the threshold trims and stays smooth, while one that ever
 * falls outside can never get back in.
 *
 * This is an **output** problem rather than a sibling-panel one, which
 * is why the constant lives here and the threshold is still imported
 * unchanged: two globes in one window share a process and a clock, and
 * the 150 ms was measured against that. An output is a second window, a
 * second decoder, and an IPC hop.
 */
export const OUTPUT_SEEK_SETTLE_MS = 1000

/**
 * The error bound that still earns a seek inside the settle window.
 *
 * Derived rather than picked: the trim closes at most
 * `SYNC_MAX_RATE_TRIM` seconds of error per second of playback, so
 * within one settle window it can absorb exactly that much on top of
 * what the threshold already tolerates. An error above this cannot be
 * trimmed away in the time we are asking the trim to work, so a seek is
 * the only tool left and suppressing it would strand the output.
 */
const SETTLING_SEEK_THRESHOLD_S =
  SIBLING_HARD_SEEK_THRESHOLD_S + SYNC_MAX_RATE_TRIM * (OUTPUT_SEEK_SETTLE_MS / 1000)

/**
 * How much slower than the last one the next seek is assumed to be.
 *
 * The floor below is built from a measurement of the *previous* seek,
 * and the loop it prevents re-arms on a single under-estimate: one seek
 * that runs slightly long lands the output back outside the threshold
 * and earns another. An over-estimate costs only a slower convergence,
 * which the rate trim still completes. The asymmetry is the whole
 * argument for a margin, and 1.5 is enough to cover ordinary variance
 * between two seeks on the same asset without making the floor a
 * different kind of guess from the one it replaces.
 */
export const SEEK_COST_MARGIN = 1.5

/**
 * The smallest error a seek can still be expected to improve.
 *
 * A seek is not free and it is not instant: the element stalls while
 * the decoder refills, and the primary plays on throughout. So a seek
 * that costs `C` seconds of wall clock leaves the output roughly
 * `C x rate` seconds behind the moment it lands — which means seeking
 * to correct an error *smaller* than that is guaranteed to end further
 * from the target than it started. Do it once per rendered frame and
 * the correction becomes the fault: seek, stall, measure a fresh
 * desync, seek again, forever, with the picture stuttering and the
 * debug HUD reading a permanent dash because every sampled frame is
 * mid-seek.
 *
 * `OUTPUT_SEEK_SETTLE_MS` was the first attempt at this and it only
 * covers the case it assumed — a seek that finishes inside a second and
 * leaves less than `SETTLING_SEEK_THRESHOLD_S` behind. A seek slower
 * than that outlives the window, so the threshold falls back to 150 ms
 * while the error is still measured in seconds, and the loop closes.
 * The field case was a bbox data-encoded forecast published *as
 * uploaded* rather than transcoded: sparse keyframes, so every seek
 * decodes from a distant one, and none of them finished inside the
 * window.
 *
 * Measured rather than assumed, so it costs nothing where seeks are
 * cheap: an asset that seeks in 20 ms yields a floor below the sibling
 * threshold and `Math.max` discards it. `rate` is the primary's, since
 * that is how far the target moves during the stall — an output mirrors
 * one dataset, so the primary's rate *is* the target's rate here rather
 * than an approximation of it.
 */
export function seekCostFloorS(lastSeekCostS: number, primaryPlaybackRate: number): number {
  if (!Number.isFinite(lastSeekCostS) || lastSeekCostS <= 0) return 0
  const rate =
    Number.isFinite(primaryPlaybackRate) && primaryPlaybackRate > 0 ? primaryPlaybackRate : 1
  return lastSeekCostS * rate * SEEK_COST_MARGIN
}

/**
 * Steer one output's video toward the primary's real-world instant.
 *
 * Call it on every playback diff and once per rAF while playing. It is
 * idempotent in the steady state: with the drift inside the hard-seek
 * threshold it only trims the rate, which is what keeps a sphere from
 * flickering (terraviz#229).
 *
 * `sinceLastSeekMs` is how long ago *this* layer last issued a seek, and
 * it raises the threshold rather than vetoing the seek outright — the
 * control law already takes the threshold as a parameter, so raising it
 * makes the law choose its own trim and hand back the trimmed rate. A
 * veto would have to invent that rate, and a second derivation of it is
 * the thing this module exists not to have. Defaults to "no seek in
 * living memory", which is the unsuppressed behaviour.
 *
 * `lastSeekCostS` is how long the previous seek took to be served, and
 * it raises the threshold the same way — but permanently rather than
 * for a window, because a seek that costs a second cannot improve an
 * error of a tenth no matter how long ago the last one was. See
 * `seekCostFloorS`. Defaults to 0, which is "nothing measured yet" and
 * leaves the threshold exactly where the settle window puts it.
 */
export function syncVideoToState(
  video: SyncTarget | null,
  state: SyncInputs,
  sinceLastSeekMs: number = Number.POSITIVE_INFINITY,
  lastSeekCostS: number = 0,
): SyncOutcome {
  const { dataset, primary, playback } = state
  if (!video || !playback) return NOT_STEERING('not-ready')

  // Both gates are the plan's, and both matter: an element below
  // `HAVE_METADATA` has no meaningful `currentTime` to read or write,
  // and a zero/NaN duration makes every ratio below degenerate.
  if (video.readyState < SIBLING_MIN_READY_STATE) return NOT_STEERING('not-ready')
  if (!(video.duration > 0)) return NOT_STEERING('not-ready')
  // Mid-seek: `currentTime` already reads the target while the frame on
  // the glass is the old one, so any error computed here is fiction.
  if (video.seeking) return NOT_STEERING('seeking')

  // Two independent reasons to tolerate more error than a sibling panel
  // would, and the correction has to respect the larger of them. The
  // settle window is a *timeout* — it expires whether or not the seek it
  // was covering has been paid for — while the floor is a standing
  // property of this asset on this machine, and the field case is
  // precisely the one where the timeout runs out first.
  //
  // **Neither applies while the primary is paused,** and that is the
  // premise rather than an exception. Both raised bounds exist because
  // the target keeps moving: the floor because a seek costing `C`
  // leaves the output `C x rate` behind by the time it lands, the
  // settle window because the trim needs time to close what the last
  // seek left. Against a *stationary* target a seek manufactures no
  // error at all — it lands exactly where it aimed — and there is no
  // trim to wait for, because a paused element has no rate to trim.
  // Raising the bound there only strands the output: the paused branch
  // below declines the seek, nothing converges it, and the sphere holds
  // a frame up to a floor's width from the operator's until they press
  // play. On a forecast that is an hour of model time on the wrong
  // frame, in front of an audience, silently.
  //
  // Nor can the plain threshold thrash here, which is the fear that
  // motivated both bounds: the seek lands on a target that has not
  // moved, so the next call measures ~0 and issues nothing. One seek,
  // converged.
  const hardSeekThresholdS = playback.paused
    ? SIBLING_HARD_SEEK_THRESHOLD_S
    : Math.max(
        sinceLastSeekMs < OUTPUT_SEEK_SETTLE_MS
          ? SETTLING_SEEK_THRESHOLD_S
          : SIBLING_HARD_SEEK_THRESHOLD_S,
        seekCostFloorS(lastSeekCostS, playback.playbackRate),
      )

  const date = instant(playback.date)
  const sibStart = instant(dataset?.startTime)
  const sibEnd = instant(dataset?.endTime)
  // No real-world clock on either side of the correction — a dataset
  // with no time axis, or a span that will not parse. Steer on the
  // clip's own position rather than standing down. An earlier version
  // returned here without touching the element, reasoning that "a
  // looping animation keeps looping" — but nothing had ever started it,
  // so every such dataset held its first decoded frame for the life of
  // the window while the control globe played.
  if (!date || !primary || !sibStart || !sibEnd)
    return syncByRatio(video, playback, hardSeekThresholdS)

  const { position, targetTime, rate, shouldSeek } = computeSiblingSyncCorrection({
    date,
    sibCurrentTime: video.currentTime,
    sibDuration: video.duration,
    sibStart,
    sibEnd,
    primaryDuration: primary.duration,
    primaryRangeMs: primary.rangeMs,
    hardSeekThresholdS,
    // Never assume 1: a tour's `frameRate` task sets the primary's rate
    // alone, so an output that assumed 1 against a 0.167× primary runs
    // ~6× fast, hard-seeks back, and repeats for the whole tour.
    primaryPlaybackRate: playback.playbackRate,
  })

  const driftS = video.currentTime - targetTime

  if (position !== 'inside' || playback.paused) {
    if (!video.paused) video.pause()
    if (shouldSeek) video.currentTime = targetTime
    return {
      kind: playback.paused ? 'paused' : 'out-of-range',
      driftS,
      seeked: shouldSeek,
    }
  }

  if (video.paused) video.play()
  video.playbackRate = rate
  if (shouldSeek) video.currentTime = targetTime
  return { kind: 'playing', driftS, seeked: shouldSeek }
}

/**
 * Steer a clip that has no time axis, on its own position.
 *
 * `positionRatio` rather than a raw `currentTime` because the two
 * elements are not required to be the same rendition — `hlsService`
 * resolves one per instance — and a ratio survives that where a value
 * in seconds does not.
 *
 * No rate trim, unlike the dated law above. There the primary's mapping
 * to real time can move under the output (a scrub, a tour's `frameRate`
 * task), so the correction has to keep converging. Here both elements
 * run the same clip at the same mirrored rate, so one seek leaves a
 * constant offset rather than a growing one, and a trim would be a
 * second control law with no independent clock to measure against.
 */
function syncByRatio(
  video: SyncTarget,
  playback: MirroredPlayback,
  hardSeekThresholdS: number,
): SyncOutcome {
  const ratio = Number.isFinite(playback.positionRatio)
    ? Math.max(0, Math.min(1, playback.positionRatio))
    : 0
  const targetTime = ratio * video.duration
  const driftS = video.currentTime - targetTime
  const seeked = Math.abs(driftS) > hardSeekThresholdS

  if (playback.paused) {
    if (!video.paused) video.pause()
    if (seeked) video.currentTime = targetTime
    return { kind: 'paused', driftS, seeked }
  }

  video.playbackRate = playback.playbackRate
  if (seeked) video.currentTime = targetTime
  // After the seek, never before: `play()` on an element sitting at its
  // end rewinds to zero, which would silently undo the seek this call
  // just made and restart the loop instead of joining the primary.
  if (video.paused) video.play()
  return { kind: 'no-range', driftS, seeked }
}

/**
 * The stateful half: remembers when it last seeked, and what that cost.
 *
 * `syncVideoToState` stays pure — every wrong answer this module can
 * give is reachable from an object literal, which is the split
 * `playbackSettle` and `voiceVad` use and the reason this file has no
 * DOM in it. All the controller adds are the facts a pure function
 * cannot hold across calls, and it reads the clock through an injected
 * `nowMs` so both the settle window and the cost measurement are
 * testable without waiting one out.
 *
 * The measurement is the whole reason this is not just a timestamp: a
 * seek's cost is a property of the asset, the decoder and the machine,
 * and no constant compiled into this file knows any of the three. The
 * element reports it for free — `seeking` is true from the write until
 * the frame is served — so the only thing needed is to notice when it
 * goes false, which is a comparison on a loop that is already running.
 */
export interface PlayheadSync {
  sync(video: SyncTarget | null, state: SyncInputs): SyncOutcome
  /**
   * Drop a seek still being timed, keeping the floor already measured,
   * and forget when `sync` was last called. For a caller that stops
   * calling `sync` on purpose, as the web clock does while paused: the
   * pause would otherwise be timed as the seek, and the gap before the
   * next call counted as one of the loop's intervals.
   */
  dropPendingSeek(): void
}

/**
 * When a gap between two calls is a stop rather than a slow frame, and
 * a seek left outstanding across it cannot be timed: the measurement is
 * dropped rather than closed. Closed, the gap was recorded as the
 * seek's cost, and a 60 s gap (a hidden tab, an occluded media face)
 * set a 90 s floor that stopped the element seeking for good (found in
 * review of the web output).
 *
 * A stop is a gap longer than both `STEER_GAP_DISCARD_MS` and
 * `STEER_GAP_FACTOR` times the loop's pace. The pace is the median of
 * the last `STEER_PACE_WINDOW` intervals, stops included, and the lower
 * of the middle two since the window is even. The median, because
 * neither one stop nor one unusually short interval moves it, and
 * because it takes a reading on any loop, however slow.
 *
 * Three rules were tried first:
 * - A fixed second dropped every seek on a loop whose frames take longer
 *   than that, a software-rendered VM say, and so re-opened the seek loop
 *   (1.1 s frames went from one seek to a hundred, in simulation).
 * - A smoothed average with a 3 s base timed a long stall into the seek
 *   it followed, and the inflated floor slowed every later scrub (found
 *   in review). On desktop that stall is the first draw after an output
 *   goes from idle to a dataset: a shader compile and the first
 *   4096x2048 upload. Its length is estimated at one to three seconds,
 *   not measured.
 * - The shortest interval: a single 0 ms one, two calls in an instant,
 *   made every frame of a slow loop a stop.
 *
 * With the median, a 60 Hz loop's stops are anything over a second,
 * which drops that stall and costs at most one more seek, while a 1.1 s
 * loop's are anything over 4.4 s. The slowest measured running loop is
 * WebKitGTK at 4096x2048, about 350 ms a callback, which the base keeps
 * from reading as a stop when it follows an idle 16 ms one.
 *
 * The base must stay at least `STATIC_FRAME_MS` (`outputScene.ts`). The
 * pace cannot drop a seek on every frame unless long gaps are a
 * minority of the window, and a static draw slow enough to make one
 * comes due again as soon as it ends, so every frame turns slow alike.
 * Below the static interval, a draw costing more than the base once a
 * second would be a stop every second.
 */
export const STEER_GAP_DISCARD_MS = 1000
export const STEER_GAP_FACTOR = 4
export const STEER_PACE_WINDOW = 8

export function createPlayheadSync(nowMs: () => number = () => performance.now()): PlayheadSync {
  let lastSeekAtMs = Number.NEGATIVE_INFINITY
  let awaitingSeek = false
  let lastSeekCostS = 0
  let steering: SyncTarget | null = null
  let lastCallAtMs = Number.NEGATIVE_INFINITY
  /** The loop's last few intervals between calls; its pace is their
   *  median. */
  const recentCallMs: number[] = []
  const paceMs = (): number => {
    if (recentCallMs.length === 0) return 0
    const sorted = [...recentCallMs].sort((a, b) => a - b)
    return sorted[Math.floor((sorted.length - 1) / 2)]
  }

  return {
    dropPendingSeek() {
      awaitingSeek = false
      // The caller stopped calling on purpose, so the gap before its next
      // call is not one of the loop's intervals either.
      lastCallAtMs = Number.NEGATIVE_INFINITY
    },

    sync(video, state) {
      const now = nowMs()
      const sinceLastCallMs = now - lastCallAtMs
      lastCallAtMs = now
      const stopped = sinceLastCallMs > Math.max(STEER_GAP_DISCARD_MS, STEER_GAP_FACTOR * paceMs())
      if (Number.isFinite(sinceLastCallMs)) {
        recentCallMs.push(sinceLastCallMs)
        if (recentCallMs.length > STEER_PACE_WINDOW) recentCallMs.shift()
      }

      // A different element is a different measurement. `datasetMirror`
      // builds one per load and disposes the last, so a seek left
      // outstanding on an element that went away would otherwise be
      // closed against the *arrival of its replacement* — recording the
      // length of a dataset load as the cost of a seek, and pinning the
      // floor at several seconds for the life of the window.
      if (video !== steering) {
        steering = video
        awaitingSeek = false
        lastSeekCostS = 0
        lastSeekAtMs = Number.NEGATIVE_INFINITY
      }

      // Closed *before* steering, not after: this call is the first one
      // that can act on what the seek actually cost, and acting on it a
      // frame later is one more seek the loop gets to issue.
      if (awaitingSeek && stopped) {
        awaitingSeek = false
      } else if (awaitingSeek && video && !video.seeking) {
        lastSeekCostS = (now - lastSeekAtMs) / 1000
        awaitingSeek = false
      }

      const outcome = syncVideoToState(video, state, now - lastSeekAtMs, lastSeekCostS)
      if (outcome.seeked) {
        lastSeekAtMs = now
        awaitingSeek = true
      }
      return outcome
    },
  }
}
