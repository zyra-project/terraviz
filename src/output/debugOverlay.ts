// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output window's debug HUD (`docs/MULTI_MONITOR_PLAN.md` rung 11).
 *
 * Five numbers in a corner, for an operator standing in front of a
 * sphere with no other way to ask it anything. There is no console on a
 * projector, no devtools on a kiosk, and the control window cannot see
 * what its outputs are actually doing.
 *
 * ## What each field is for
 *
 * - **dataset** — which dataset this window has *decoded*, read from
 *   `datasetMirror`, not from the link. During a load those two differ,
 *   and the useful answer is what is on the glass.
 * - **sync** — the drift `outputSync` measured, in milliseconds and
 *   signed. Positive is ahead. This is the number that says whether an
 *   installation is in step, and it comes straight from the value that
 *   *steered*, never recomputed here — a second implementation would be
 *   free to disagree with the one doing the work. When there is no
 *   number the reason is printed beside the dash, because the reasons
 *   are not equivalent: `not-ready` on a still image is the correct
 *   answer and `seeking` on every sample is a correction fighting
 *   itself.
 * - **fps** — measured over a wall-clock window, never a frame counter
 *   divided by an assumed interval. The spike behind the decoder budget
 *   found that a cumulative count taken a fixed time after playback
 *   *starts* folds in startup latency and showed a spurious ⅓ drop that
 *   vanished once two samples were differenced. It is a measure of
 *   *pacing*, not of capacity: the loop caps video at 30, floors static
 *   content at 1 Hz, and draws on every callback while the camera is
 *   moving — in which case the ceiling is the control window's own
 *   render rate, since that is what sets `dirty`. Which is why the
 *   next field exists.
 * - **draw** — the mean wall-clock time spent inside `scene.render()`,
 *   over the frames since the last reading. The one number here that
 *   answers "can this window keep up" independently of what is asking
 *   it to. Two hardware passes failed to separate a slow shader from a
 *   slow texture upload because every reading available was a *pacing*
 *   measurement bounded by something other than the draw: fps under
 *   video is capped at 30, fps on static content is floored at 1, and
 *   fps during a drag is ceilinged by the control window's publish
 *   rate. See the plan's Appendix B. This measures the draw itself.
 *   CPU-side, and that bound is sharper than it first reads: `render()`
 *   *submits*, the GPU executes afterwards, and when GPU work overruns
 *   the budget the CPU does not block inside `render()` — it blocks at
 *   buffer swap, which in a browser is the compositor's business and
 *   happens between rAF callbacks, never inside anything this module
 *   times. So a GPU-bound output reads **under a millisecond here**.
 *   What the field rules out is CPU cost in the draw; what it cannot
 *   see is the GPU, which is why the next field exists.
 * - **raf** — how often the browser is calling the render loop at all,
 *   beside **fps**, which is how often the loop chose to draw. The two
 *   together are the fork every earlier reading was missing. `raf` near
 *   60 beside an `fps` of 19 means the callbacks are arriving and this
 *   app is declining to draw on them — a bug in the loop's own frame
 *   decision. `raf` near 19 means the loop draws on essentially every
 *   callback it gets and the browser is only offering 19: the cost is
 *   outside this JS entirely — GPU execution, compositing the
 *   framebuffer, or present — which is exactly the region a
 *   sub-millisecond `draw` cannot see into.
 * - **gpu** — the unmasked WebGL renderer string. The app cannot choose
 *   its GPU: a spike found the webview silently on the iGPU of a machine
 *   with a 4090, `powerPreference` is inert, and neither wry nor tauri
 *   reads an override. An installation can therefore run at a fraction
 *   of its provisioned capacity, undiagnosable from logs. Seeing this
 *   string is the entire mitigation.
 * - **buffer** — the framebuffer's own dimensions, which is how rung
 *   11's resolution picker is confirmed to have taken effect. It is
 *   deliberately *not* the window size: the two differ by design, and
 *   conflating them is what the plan's "the frame and the monitor are
 *   two rectangles" section exists to prevent.
 *
 * ## Why it is not routed through i18n
 *
 * These are field names and machine values for an operator debugging an
 * installation, in the same category as the report strings
 * `scripts/screenshots/` emits. `check:i18n-strings` scans `src/ui/` and
 * the docent services, not `src/output/`, so this is consistent with
 * that boundary rather than an exception to it. The Outputs panel's
 * *toggle* — which a curator sees — is translated.
 *
 * ## Pacing
 *
 * Updated on a ~2 Hz timer of its own rather than per frame. The render
 * loop drops to 1 Hz for static content by design, so driving the HUD
 * from it would freeze the fps readout at exactly the moment someone is
 * asking why nothing is moving; and at 30 fps it would write the DOM
 * thirty times a second to show numbers a human reads twice.
 */

import { logger } from '../utils/logger'
import type { LinkHealth } from './linkWatchdog'
import type { GpuContextState } from './outputScene'
import type { SyncKind } from './outputSync'

/** How often the HUD re-reads and repaints. */
export const OVERLAY_REFRESH_MS = 500

/** Everything the HUD shows, gathered once per refresh. */
export interface DebugOverlayReading {
  datasetId: string | null
  /** Signed seconds; positive means this output is ahead. `null` when
   *  nothing is steering — an image, or no dataset. */
  driftS: number | null
  /** What the correction did on the last steered frame, or `null` when
   *  it has never run. Shown only when there is no number: a dash on
   *  its own cannot separate "this is a still image" from "this element
   *  has been seeking for the last ten seconds", and those want opposite
   *  responses from whoever is standing in front of the sphere. It was
   *  a bare dash that made the first hardware pass record a bbox
   *  forecast as "sync just shows a dash" with no way to tell which. */
  syncKind: SyncKind | null
  fps: number
  /** Mean milliseconds spent inside `scene.render()` since the last
   *  reading, or `null` before the first frame. The capacity number —
   *  see the header. */
  drawMs: number | null
  /** Render-loop callbacks per second — the *offered* rate, against
   *  `fps`'s taken one. See the header: the pair is the fork between a
   *  loop that is declining to draw and a browser that is not asking
   *  it to. */
  rafHz: number
  /** What the output believes about its link to the control window
   *  (rung 13, case 3). Shown because it separates the two questions
   *  an operator in front of a frozen sphere actually has — "is the
   *  picture wrong?" from "has the control window stopped talking to
   *  me?" — which every other field on this HUD leaves indistinguish-
   *  able, since a stale link renders a perfectly good last frame
   *  forever. */
  link: LinkHealth
  gpu: string | null
  /** What this window has observed about its GPU context (rung 13,
   *  case 5). Shown beside the renderer name because it is the same
   *  subject, and shown *only* when it is not `live` — for the reason
   *  the Outputs panel draws no badge on a healthy output: a line
   *  decorated in the normal case is a line the reader learns to skip,
   *  and this one has to be legible at a glance from a few metres
   *  away. */
  gpuState: GpuContextState
  framebuffer: { width: number; height: number }
}

/**
 * Render one reading as the HUD's lines.
 *
 * Pure, so the formatting is testable without a DOM — which matters
 * more than it looks: the sign convention on `sync` is the field an
 * operator acts on, and getting it backwards would send someone
 * hunting a lead output that is actually late.
 */
export function formatOverlay(reading: DebugOverlayReading): string[] {
  const { datasetId, driftS, drawMs, fps, gpu, gpuState, framebuffer, rafHz, syncKind, link } =
    reading
  const sync =
    driftS === null
      ? `sync  —${syncKind ? ` ${syncKind}` : ''}`
      : // Signed and in ms: `+` reads as "ahead of the control window".
        // Rounded to whole ms because the hard-seek threshold is 150 ms
        // and sub-millisecond precision is noise a reader must ignore.
        `sync  ${driftS >= 0 ? '+' : '−'}${Math.abs(Math.round(driftS * 1000))} ms`
  return [
    `data  ${datasetId ?? '—'}`,
    sync,
    // Directly under `sync`, because the two are read together: a
    // drift the correction cannot fix means something different when
    // the link that supplies the target went quiet four seconds ago.
    `link  ${link}`,
    // The offered rate rides the same line as the taken one, because
    // neither number means much alone: 19 of 60 and 19 of 19 are
    // different faults with different owners.
    `fps   ${fps.toFixed(1)}  (raf ${rafHz.toFixed(1)})`,
    // Directly under `fps`, and read against it: fps says how often this
    // window painted, `draw` says how long a paint costs. A 30 next to a
    // 4 ms is a window with headroom; a 19 next to a 53 ms is one that
    // cannot keep up, and the two are indistinguishable from fps alone.
    // A dash before the first frame, never a zero — a zero-millisecond
    // draw is a claim, and "not measured yet" is the truth.
    `draw  ${drawMs === null ? '—' : `${drawMs.toFixed(1)} ms`}`,
    `buf   ${framebuffer.width}×${framebuffer.height}`,
    `gpu   ${gpu ?? 'unreported'}${gpuState === 'live' ? '' : ` — context ${gpuState}`}`,
  ]
}

/**
 * Frames per second over a wall-clock window.
 *
 * A delta, never a total: a cumulative count divided by time-since-start
 * folds in however long the first frame took, which is exactly the
 * measurement error the decoder-budget spike chased before differencing
 * two samples made it vanish.
 *
 * The window is **held open until it contains a frame**, and that is not
 * a refinement — it is the difference between this field working and
 * lying. The loop floors a static output at 1 Hz while the HUD samples
 * about twice a second, so roughly half of all windows on a correctly
 * idling output hold no drawn frame at all; closing those would divide
 * zero by the window and report exactly `0.0`. That is the reading a
 * *black projector* gives, which is the one state the 1 Hz floor exists
 * to make visible and the one `render()`-skipped-while-lost is written
 * to produce (rung 13, case 5). Found on hardware: an operator dragged
 * the control globe, stopped, and watched a healthy output report zero.
 *
 * What is reported while the window stays open is the upper bound the
 * wait implies: no frame has arrived in `elapsed`, so the rate is below
 * `1000 / elapsed`, and that decays — 2, 1, 0.5, 0.25 — as the silence
 * grows. A genuine stall therefore still collapses toward zero, just
 * continuously rather than by flicker, and can be told from an idle
 * output holding steady near 1.
 */
export interface FpsMeter {
  /** Call once per rendered frame. */
  tick(now: number): void
  /** Frames per second since the previous `sample()`. */
  sample(now: number): number
}

export function createFpsMeter(): FpsMeter {
  let frames = 0
  let since: number | null = null
  let last = 0
  return {
    tick(now) {
      if (since === null) since = now
      frames++
    },
    sample(now) {
      if (since === null || now <= since) return last
      const elapsed = now - since
      // Empty window: hold it open rather than reporting a hard zero,
      // and report the bound the wait implies. See the header — this is
      // what keeps a 1 Hz idle output distinguishable from a dead one.
      // `Math.min` because no frame arrived, so the rate cannot have
      // risen since the last reading.
      if (frames === 0) return (last = Math.min(last, 1000 / elapsed))
      last = (frames * 1000) / elapsed
      frames = 0
      since = now
      return last
    },
  }
}

/**
 * Mean time spent drawing, over the frames since the last reading.
 *
 * Separate from `FpsMeter` rather than folded into it, because the two
 * answer opposite questions and only one of them is bounded by the
 * loop's own pacing. fps is how often this window painted, which the
 * frame gate caps, the static rung floors and — while the camera is
 * moving — the *control window's* render rate ceilings, since that is
 * what sets `dirty`. None of those touch how long a paint takes. Two
 * hardware passes went by without being able to tell a slow shader from
 * a slow texture upload, and this is the reading that separates them.
 *
 * Holds its last value across a window with no frames, for `FpsMeter`'s
 * reason inverted: a mean over nothing is not zero, it is unknown, and
 * an idle output draws once a second so the next window will have one.
 */
export interface DrawTimer {
  /** Call once per drawn frame, with the time `render()` took. */
  record(durationMs: number): void
  /** Mean milliseconds per drawn frame since the previous `sample()`;
   *  `null` before any frame has been drawn. */
  sample(): number | null
}

export function createDrawTimer(): DrawTimer {
  let totalMs = 0
  let frames = 0
  let last: number | null = null
  return {
    record(durationMs) {
      // A clock that went backwards (a suspended machine, a coarsened
      // timer) would otherwise drag the mean below zero and read as a
      // free draw, which is the one answer this field must never give.
      if (!Number.isFinite(durationMs) || durationMs < 0) return
      totalMs += durationMs
      frames++
    },
    sample() {
      if (frames === 0) return last
      last = totalMs / frames
      totalMs = 0
      frames = 0
      return last
    },
  }
}

export interface DebugOverlay {
  /** Show or hide without tearing down — an operator toggles this while
   *  looking at the sphere, and a rebuild would blink. */
  setVisible(visible: boolean): void
  dispose(): void
}

/**
 * Mount the HUD, reading through `read` on its own timer.
 *
 * The reader is a callback rather than a set of setters so the HUD
 * cannot hold a stale copy of anything: every refresh asks the live
 * objects, and there is no second place for the dataset id or the
 * drift to be written and forgotten.
 */
export function createDebugOverlay(
  read: () => DebugOverlayReading,
  deps: {
    document?: Pick<Document, 'createElement'> & { body: Pick<HTMLElement, 'appendChild'> }
    setInterval?: (fn: () => void, ms: number) => number
    clearInterval?: (id: number) => void
  } = {},
): DebugOverlay {
  const doc = deps.document ?? (typeof document !== 'undefined' ? document : null)
  const setTimer = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms) as unknown as number)
  const clearTimer = deps.clearInterval ?? (id => globalThis.clearInterval(id))

  if (!doc) {
    // The static fixture page can render this file in a context with no
    // DOM. Costing the HUD is right; throwing out of the render loop is
    // not.
    logger.warn('[output] no document for the debug overlay')
    return { setVisible: () => {}, dispose: () => {} }
  }

  const el = doc.createElement('div')
  el.id = 'output-debug-overlay'
  el.hidden = true
  doc.body.appendChild(el)

  const refresh = (): void => {
    if (el.hidden) return
    try {
      el.textContent = formatOverlay(read()).join('\n')
    } catch (err) {
      // A HUD that throws must not take down the window it is drawn
      // over. An operator losing the readout still has the picture.
      logger.warn('[output] debug overlay read failed:', err)
    }
  }

  const timer = setTimer(refresh, OVERLAY_REFRESH_MS)

  return {
    setVisible(visible) {
      el.hidden = !visible
      // Paint immediately rather than waiting out the refresh interval:
      // an operator who just ticked the box should not see half a
      // second of empty box and wonder whether it worked.
      if (visible) refresh()
    },
    dispose() {
      clearTimer(timer)
      el.remove()
    },
  }
}
