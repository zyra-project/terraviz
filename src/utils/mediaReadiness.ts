// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * When can a `<video>` actually show something, and where.
 *
 * Two questions with the same root, both answered wrong by the obvious
 * code, and both first reached on WebKitGTK — the engine Linux SOS
 * installations run. They live here rather than in `datasetLoader.ts`,
 * where they were written, for two reasons that arrived together:
 * `playbackController` needs `playableStart` on its restart path and
 * `datasetLoader` already imports `playbackController`, so keeping them
 * there closes a cycle; and the multi-monitor output needs
 * `waitForDecodableFrame` in a bundle deliberately kept clear of the
 * SPA's loader graph. This module imports nothing, which is what makes
 * it safe for both.
 */

/**
 * How long to wait for a first decodable frame before giving up.
 *
 * Generous because the alternative is abandoning a load that was going
 * to succeed: a cold CDN fragment on a conference network is slow, not
 * broken.
 */
export const VIDEO_LOAD_TIMEOUT_MS = 20000

/**
 * Wait until `video` holds a frame the texture path can upload.
 *
 * The obvious shape — listen for `canplay`, time out — **deadlocks on
 * WebKitGTK**, which is the whole reason this is a named function
 * rather than an inline promise. Chrome, Firefox and Safari preroll a
 * media pipeline as soon as data is appended, so `canplay` arrives
 * unprompted; WebKitGTK waits to be asked, so an element nobody has
 * played never leaves `HAVE_METADATA` and this wait waits for
 * something its own caller was going to trigger a few lines later.
 * Measured on Ubuntu under WSLg: `readyState` 1 with 88 s buffered, a
 * known duration, no media error and no fatal hls.js event — and
 * `readyState` 4 with frames decoding the moment `play()` was called
 * by hand. It presents as a connection failure and is an ordering
 * bug.
 *
 * So the pipeline is **nudged**: muted playback is started and the
 * element is left running, because the SPA's caller plays it
 * immediately afterwards to capture a first frame, then pauses and
 * rewinds. A rejected `play()` costs the nudge and nothing else — and
 * an autoplay policy strict enough to refuse a muted element belongs
 * to an engine that prerolls on its own, which is the case the nudge
 * is not needed for.
 *
 * `readyState >= 3` is checked first because an already-decodable
 * element must not be played at all: the fast path is a dataset
 * switching back to media still warm in the element.
 *
 * A caller that must not be left with a playing element — the
 * multi-monitor output, whose playhead is steered from elsewhere —
 * passes `pauseWhenReady`. It pauses on the *resolve* path only: a
 * rejection means the nudge never took, and pausing there would be
 * pausing an element that is not playing while hiding the throw behind
 * a second operation that can fail.
 */
export function waitForDecodableFrame(
  video: HTMLVideoElement,
  options: { timeoutMs?: number; pauseWhenReady?: boolean } = {},
): Promise<void> {
  const { timeoutMs = VIDEO_LOAD_TIMEOUT_MS, pauseWhenReady = false } = options
  if (video.readyState >= 3) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      video.removeEventListener('canplay', onCanPlay)
      reject(new Error('Video took too long to load — check your connection and try again'))
    }, timeoutMs)

    function onCanPlay(): void {
      video.removeEventListener('canplay', onCanPlay)
      // Cleared rather than left to fire into a settled promise: the
      // reject is harmless by then, but a live 20 s timer per load is
      // not nothing on a tour stepping through datasets.
      clearTimeout(timer)
      if (pauseWhenReady) video.pause()
      resolve()
    }

    video.addEventListener('canplay', onCanPlay)
    // Muted so no autoplay policy has grounds to refuse, and because an
    // output on a projector must never make a sound.
    video.muted = true
    void video.play().catch(() => {})
  })
}

/**
 * The earliest instant this element can actually show.
 *
 * Normally `0`, and on every engine that buffers from the start of the
 * asset this is `0` by construction — which is what makes it safe to
 * rewind through rather than to a literal zero. WebKitGTK measured
 * `buffered [6.0, 94.1]` against a 94.1 s asset: the first six seconds
 * never appended, and `readyState` is defined at the *playback
 * position*, so parking the playhead at 0 leaves a decodable element
 * stalled on a hole with nothing to show and no error to report. That
 * is the same failure `waitForDecodableFrame` exists for, reached from
 * the other side — a load that now succeeds and then rewinds into the
 * gap it just played out of.
 *
 * Six seconds into a 24-hour animation is a visible offset and a far
 * better answer than a frozen first frame. The cause of the hole is
 * unestablished (`buffered` is the browser's intersection across
 * source buffers, so a misaligned audio track is the first suspect),
 * and this does not pretend to fix it — it declines to park where
 * nothing can be decoded, which is correct whatever the cause.
 *
 * **Every rewind has to go through this, not just the load**, and an
 * earlier version of this note got that wrong: it said the restart was
 * a native `loop` the app could not intercept. Nothing in the app sets
 * `video.loop`. The restarts are `playbackController`'s own — the
 * auto-loop at the end of a clip and the rewind button — both plain
 * assignments to `currentTime`, both of which parked the playhead back
 * in the hole a load had just correctly stepped over. So a fix applied
 * only at load time held for exactly one pass of the asset.
 */
export function playableStart(buffered: TimeRanges): number {
  let earliest = Number.POSITIVE_INFINITY
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i)
    const end = buffered.end(i)
    // An empty range holds no frame, so it is not somewhere to park —
    // and skipping it *before* the comparisons is the correctness: a
    // zero-length range at the origin otherwise wins `earliest` and
    // this returns the exact spot it exists to avoid.
    if (end <= start) continue
    // Zero is inside a real range: the ordinary case on every engine
    // that buffers from the start, and the one not to perturb.
    if (start <= 0) return 0
    earliest = Math.min(earliest, start)
  }
  return Number.isFinite(earliest) ? earliest : 0
}
