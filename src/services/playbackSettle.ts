// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * When has the playhead stopped moving?
 *
 * The Analyze panel computes against **one frame**, read back once. While
 * a video plays that frame is replaced ~30 times a second, so everything
 * on the panel is either recomputed at a rate nothing can sustain or left
 * describing a frame that is gone. Today the surfaces take the second
 * option honestly — contours drop when the playhead moves rather than
 * lingering as a plausible overlay of a vanished frame.
 *
 * That leaves the case in between, which is the common one: the viewer
 * *pauses on something*, or scrubs to a moment and lets go. The frame is
 * then stable and the panel could describe it, but nothing tells the
 * panel that. This module is that signal.
 *
 * `npm run bench:analysis` is why this is worth having rather than
 * theoretical: a full region refresh — histogram, summary, zonal profile
 * — is around 60 ms on a 4096×2048 frame. On settle, that is a hitch
 * nobody perceives. It needs no worker and no async readback; those buy
 * headroom for harder cases (contours run 178–376 ms depending on how
 * much perimeter the levels cut), not for this one.
 *
 * ## The rule, and why it is only about pausing
 *
 * **Settled = the transport is paused, not seeking, and the playhead has
 * held still for `quietMs`.**
 *
 * It is tempting to want this to fire during *slow* playback too — drop
 * to a frame a second and let the analysis keep up. It cannot, and the
 * reason is worth stating so nobody re-derives it: `currentTime` is a
 * clock, not a frame counter. It advances continuously at any
 * `playbackRate` above zero, so there is no still moment to detect. At
 * 0.03× it moves 0.0075 s across a 250 ms window — smaller than at 1×,
 * but never zero, and no epsilon separates "slow" from "normal" without
 * knowing the dataset's frame interval.
 *
 * Tracking a slowly-playing video is therefore a *different* mechanism —
 * recompute on a timer while playing, not on settle — and deliberately
 * not built here. The bench says the stats half would be affordable
 * somewhere below ~5 fps; contours would not be.
 *
 * ## Shape
 *
 * A pure state machine plus a thin composition over an injected read,
 * mirroring `voiceVad`'s `EnergyVad` + `startMicVad`. No DOM, no rAF, no
 * timers: the caller supplies both the sample and the clock, so every
 * behaviour below is testable without a video element, and the watcher
 * composes into the rAF loop `playbackController` already runs rather
 * than starting a second one.
 */

/** What the transport looks like at one instant. */
export interface PlaybackSample {
  /** Seconds into the dataset, or `null` when there is no playhead at
   *  all — an image dataset, or a video that has not loaded. */
  playhead: number | null
  /** Whether the transport is paused. */
  paused: boolean
  /** Whether a seek is in flight. A seek-while-paused reports `paused`
   *  true with a playhead that is still moving, so without this the
   *  detector can settle on an intermediate position. */
  seeking?: boolean
}

export interface PlaybackSettleOptions {
  /**
   * How long the playhead must hold still before it counts as settled.
   *
   * Long enough that a scrub does not fire once per intermediate
   * position, short enough that a pause feels immediate. Playback
   * transports elsewhere in the app use a similar order of magnitude for
   * "the user has stopped fiddling".
   */
  quietMs?: number
  /**
   * Playhead movement below this counts as no movement.
   *
   * Not paranoia: a browser may nudge `currentTime` to the nearest frame
   * boundary after a seek completes, so a strict equality test would see
   * one last move and restart the quiet window every time.
   */
  epsilonSec?: number
}

const DEFAULT_QUIET_MS = 250
const DEFAULT_EPSILON_SEC = 1e-3

/**
 * The state machine. Feed it samples with a monotonic clock; it returns
 * the playhead it just settled on, or `null`.
 *
 * Fires **once** per settled position. A viewer who pauses and then sits
 * there for a minute gets one signal, not one per frame — the panel's
 * numbers have not gone stale just because time passed.
 */
export class PlaybackSettleDetector {
  private readonly quietMs: number
  private readonly epsilonSec: number
  /** The playhead the quiet window is currently timing. */
  private pending: number | null = null
  /** When `pending` last changed. */
  private lastMoveMs = 0
  /** The last position handed to the caller, so it is not handed twice. */
  private reported: number | null = null

  constructor(options: PlaybackSettleOptions = {}) {
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS
    this.epsilonSec = options.epsilonSec ?? DEFAULT_EPSILON_SEC
  }

  push(sample: PlaybackSample, nowMs: number): number | null {
    const { playhead, paused, seeking } = sample

    // No playhead at all. Forget everything: the next video to arrive is
    // a different dataset, and a position carried across would let the
    // first sample of the new one look like a continuation of the old.
    if (playhead === null || !Number.isFinite(playhead)) {
      this.reset()
      return null
    }

    // Playing, or mid-seek. The frame under the panel is being replaced,
    // so there is nothing stable to describe. Keep the window open on the
    // current position so the clock starts from the moment motion stops
    // rather than from whenever the last sample happened to land.
    if (!paused || seeking) {
      this.pending = playhead
      this.lastMoveMs = nowMs
      return null
    }

    if (this.pending === null || Math.abs(playhead - this.pending) > this.epsilonSec) {
      this.pending = playhead
      this.lastMoveMs = nowMs
      return null
    }

    // Already told the caller about this position.
    if (this.reported !== null && Math.abs(playhead - this.reported) <= this.epsilonSec) {
      return null
    }

    if (nowMs - this.lastMoveMs < this.quietMs) return null

    this.reported = playhead
    return playhead
  }

  /**
   * Forget the current position and any settle already reported.
   *
   * Call when the dataset under the panel changes: the same playhead
   * value means a different frame, and suppressing it as "already
   * reported" would leave the panel describing the previous dataset.
   */
  reset(): void {
    this.pending = null
    this.lastMoveMs = 0
    this.reported = null
  }
}

/** A settle watcher, driven by the caller's own animation loop. */
export interface PlaybackSettleWatcher {
  /** Sample once. Safe to call at frame rate; does its own throttling. */
  tick(nowMs: number): void
  /** Forget where the playhead was — see `PlaybackSettleDetector.reset`. */
  reset(): void
}

/**
 * Compose a detector over a source of samples.
 *
 * Returns a `tick` rather than starting a loop, so this rides the rAF
 * loop `playbackController.startPlaybackLoop` already runs — one line in
 * its existing `onTick` hook. A second requestAnimationFrame loop, on a
 * page whose whole performance story is a WebGL globe, would be a poor
 * trade for a signal that only matters when nothing is moving.
 *
 * `onSettled` throwing is contained. This is wired into the playback
 * loop, and that loop already treats a throw from `onTick` as something
 * to log and survive rather than a reason to stop driving the scrubber.
 */
export function createPlaybackSettleWatcher(
  read: () => PlaybackSample,
  onSettled: (playhead: number) => void,
  options: PlaybackSettleOptions = {},
): PlaybackSettleWatcher {
  const detector = new PlaybackSettleDetector(options)
  return {
    tick(nowMs: number): void {
      let settled: number | null = null
      try {
        settled = detector.push(read(), nowMs)
      } catch {
        // A read that throws mid-teardown is not a settle. Swallowing it
        // keeps the playback loop's own error handling for real faults.
        return
      }
      if (settled === null) return
      try {
        onSettled(settled)
      } catch {
        // Reported already; a failing consumer must not make the
        // detector re-fire the same position forever.
      }
    },
    reset(): void {
      detector.reset()
    },
  }
}
