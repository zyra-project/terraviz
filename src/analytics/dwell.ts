/**
 * Tier B dwell tracking.
 *
 * Measures wall-clock time spent on a named view target (chat
 * panel, browse panel, info panel, individual dataset, …) and
 * emits one `dwell` event per finished session. Sessions are
 * scoped to a handle returned by `startDwell` — callers stop the
 * handle when the user leaves the surface, and the helper handles
 * tab visibility transitions so a backgrounded tab doesn't accrue
 * minutes of dwell on a panel the user can't see.
 *
 * Privacy posture: `dwell` is Tier B (research mode only). The
 * emitter's tier gate drops these events for users on Essential or
 * Off, so this helper can be unconditional at call sites — the
 * tier filter happens at emit time. `view_target` is a closed enum
 * of panel names plus `dataset:<id>` for layer-specific dwell;
 * never carries free text.
 *
 * Visibility discipline mirrors the perf sampler's pattern:
 * `visibilitychange:hidden` pauses every active dwell handle (the
 * accumulated time freezes); `visibilitychange:visible` resumes;
 * `pagehide` stops every handle and emits one event each so an
 * unmount mid-dwell still produces a record (rides the
 * pagehide-beacon path in emitter.ts).
 *
 * Multiple concurrent dwells are supported — the chat panel can
 * be open while the user is scrolling browse, and both produce
 * independent events on close.
 */

import { emit } from './emitter'
import type { DwellTarget } from '../types'

/** Handle returned by `startDwell`. Holds private accumulators
 * the helper updates on every visibility transition. Calling
 * `stop()` emits exactly one `dwell` event with the elapsed
 * unhidden time; subsequent `stop()` calls are no-ops so a
 * defensive double-stop in a callback can't double-count. */
export interface DwellHandle {
  /** Stop tracking and emit the `dwell` event. Idempotent. */
  stop(): void
  /** Read elapsed unhidden milliseconds without stopping. Useful
   * for tests and for in-progress dashboards. */
  elapsed(): number
}

/** Internal tracker shape — exported for tests only. */
interface ActiveDwell {
  target: DwellTarget
  /** Wall-clock at which the current visible run started. Null
   * when the dwell is paused (tab hidden). */
  runStartedAt: number | null
  /** Total visible time accumulated across all run segments. */
  accumulatedMs: number
  /** True after `stop()` has fired so a defensive second call
   * doesn't double-emit. */
  stopped: boolean
}

const active = new Set<ActiveDwell>()
let visibilityListenersInstalled = false

/** Start tracking dwell on `target`. Returns a handle the caller
 * stops when the user leaves the surface. The same target can
 * have multiple concurrent handles — the helper doesn't dedupe
 * (a caller that wants singleton semantics can keep its own handle
 * reference and call stop before starting again). */
export function startDwell(target: DwellTarget): DwellHandle {
  ensureVisibilityListeners()
  const tracker: ActiveDwell = {
    target,
    runStartedAt: shouldRun() ? Date.now() : null,
    accumulatedMs: 0,
    stopped: false,
  }
  active.add(tracker)
  return {
    stop(): void {
      if (tracker.stopped) return
      tracker.stopped = true
      active.delete(tracker)
      const total = computeElapsed(tracker, Date.now())
      emit({
        event_type: 'dwell',
        view_target: tracker.target,
        duration_ms: Math.max(0, Math.round(total)),
      })
    },
    elapsed(): number {
      return Math.max(0, Math.round(computeElapsed(tracker, Date.now())))
    },
  }
}

/** Test helper — clear every active dwell + tear down listeners.
 * Not exported from the analytics barrel. */
export function __resetDwellForTests(): void {
  for (const tracker of active) tracker.stopped = true
  active.clear()
  if (visibilityListenersInstalled && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('pagehide', onPageHide)
  }
  visibilityListenersInstalled = false
}

/** Test helper — the count of currently-active dwell trackers. */
export function __activeDwellCount(): number {
  return active.size
}

// ---------------------------------------------------------------
// Internals
// ---------------------------------------------------------------

function shouldRun(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

function computeElapsed(tracker: ActiveDwell, now: number): number {
  if (tracker.runStartedAt === null) return tracker.accumulatedMs
  return tracker.accumulatedMs + (now - tracker.runStartedAt)
}

function pauseAll(at: number): void {
  for (const tracker of active) {
    if (tracker.runStartedAt === null) continue
    tracker.accumulatedMs += at - tracker.runStartedAt
    tracker.runStartedAt = null
  }
}

function resumeAll(at: number): void {
  for (const tracker of active) {
    if (tracker.runStartedAt !== null) continue
    tracker.runStartedAt = at
  }
}

function onVisibilityChange(): void {
  const now = Date.now()
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'hidden') {
    pauseAll(now)
  } else {
    resumeAll(now)
  }
}

function onPageHide(): void {
  // Drain every active dwell so the user's last surface visit
  // makes it onto the wire via the emitter's pagehide beacon.
  // Iterate over a snapshot — stop() mutates the set.
  for (const tracker of [...active]) {
    if (tracker.stopped) continue
    tracker.stopped = true
    active.delete(tracker)
    const total = computeElapsed(tracker, Date.now())
    emit({
      event_type: 'dwell',
      view_target: tracker.target,
      duration_ms: Math.max(0, Math.round(total)),
    })
  }
}

function ensureVisibilityListeners(): void {
  if (visibilityListenersInstalled) return
  visibilityListenersInstalled = true
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide)
  }
}
