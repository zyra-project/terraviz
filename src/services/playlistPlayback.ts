/**
 * Playlist playback — the "active playlist" state machine.
 *
 * Owns the timer that advances entries and decouples the playlist
 * UI from the rest of the app via two callbacks:
 *
 *   - `loadDataset(id)` — bound to main.ts's regular load path so
 *     the playlist module doesn't have to know about overlay
 *     options, multi-panel routing, telemetry, etc.
 *   - `hasTourOnLoad(id)` — true if the dataset is configured to
 *     auto-start a tour on load. The playback module pauses its
 *     timer for tour-bearing entries; main.ts notifies completion
 *     by calling `notifyTourEnded()` (wired into the existing
 *     `TourCallbacks.onTourEnd` hook).
 *
 * Single-active model: starting playlist B while A is playing
 * stops A. This was confirmed with the user; the plan didn't
 * specify but it's the simplest mental model (matches video /
 * Spotify behaviour).
 *
 * End-of-list behaviour: stop. Looping is a v2 add and not in
 * scope for §8.1. Same with shuffle.
 *
 * Load failures don't abort the playlist — the timer still starts
 * on the failed entry so the user can see the failure state for
 * the usual duration, then advances. Manual skip-next obviously
 * also works.
 */

import { logger } from '../utils/logger'
import { effectiveDuration, type Playlist } from './playlistService'

/** Callbacks main.ts wires in at boot. */
export interface PlaylistPlaybackCallbacks {
  /** Load a dataset onto the primary viewport. Returns when the
   *  load path has resolved; the playback module awaits it but
   *  proceeds with the timer regardless of success/failure. */
  loadDataset(datasetId: string): Promise<void>
  /** True if loading this dataset will auto-start a tour
   *  (`dataset.runTourOnLoad` is set). The playback module then
   *  defers its advance timer until `notifyTourEnded()` fires. */
  hasTourOnLoad(datasetId: string): boolean
}

/** Public read-only snapshot of the active playback state. */
export interface PlaylistPlaybackState {
  /** The currently-playing playlist. Deep-copied at play() time so
   *  the playback module sees a stable view even if the user edits
   *  the playlist while it's playing. The UI is responsible for
   *  surfacing edits if it wants them to apply mid-play; usually
   *  the user expects "what's playing now keeps playing." */
  playlist: Playlist
  /** 0-indexed cursor into `playlist.datasets`. */
  index: number
  /** True when the user has explicitly paused. The timer is
   *  cleared on pause and re-armed on resume with the remaining
   *  time for the current entry. */
  paused: boolean
  /** True when a tour is running for the current entry. The
   *  advance timer still runs concurrently, but if it fires while
   *  a tour is pending we mark `timerExpiredDuringTour` instead
   *  of advancing — the plan says we must wait for the tour to
   *  finish before moving on. */
  waitingForTour: boolean
}

let callbacks: PlaylistPlaybackCallbacks | null = null
let active: PlaylistPlaybackState | null = null
let advanceTimer: ReturnType<typeof setTimeout> | null = null
/** Wall-clock time the current entry's timer was last (re-)armed,
 *  in ms. Used to compute remaining time on pause. */
let timerStartedAt = 0
/** Remaining ms when paused — restored on resume. `null` when no
 *  pause is in flight. */
let remainingMs: number | null = null
/** Set to true if the per-entry advance timer fires while
 *  `waitingForTour` is still true. We can't advance yet — the
 *  plan says wait for the tour — but when the tour ends we need
 *  to know to advance immediately rather than letting the user
 *  sit on a frozen entry. Cleared on every entry transition. */
let timerExpiredDuringTour = false

const CHANGE_EVENT = 'sos-playlist-playback:change'
const target: EventTarget = typeof window === 'undefined' ? new EventTarget() : window

/** Wire callbacks. Called once at app boot from main.ts. */
export function initPlaylistPlayback(cb: PlaylistPlaybackCallbacks): void {
  callbacks = cb
}

/**
 * Start a playlist. Stops any active playlist first (single-active
 * model). No-op if the playlist has zero datasets — surfacing that
 * to the user is the UI's job; the state machine just declines to
 * enter a degenerate state.
 */
export function play(playlist: Playlist, opts: { startAt?: number } = {}): void {
  if (!callbacks) {
    logger.warn('[playlistPlayback] play() before init')
    return
  }
  if (playlist.datasets.length === 0) {
    logger.info('[playlistPlayback] play() ignored — empty playlist')
    return
  }
  clearTimer()
  const startAt = clampIndex(opts.startAt ?? 0, playlist.datasets.length)
  active = {
    playlist: {
      ...playlist,
      datasets: playlist.datasets.map((e) => ({ ...e })),
    },
    index: startAt,
    paused: false,
    waitingForTour: false,
  }
  notify()
  void loadCurrentEntry()
}

/** Pause the advance timer. Resume picks up where the entry left off. */
export function pause(): void {
  if (!active || active.paused) return
  active.paused = true
  if (advanceTimer != null) {
    const elapsed = Date.now() - timerStartedAt
    const total = currentDurationMs()
    remainingMs = Math.max(0, total - elapsed)
    clearTimer()
  }
  notify()
}

/** Resume after a pause. Re-arms the timer with the remaining time
 *  recorded at pause(). No-op if the playlist is not paused. */
export function resume(): void {
  if (!active || !active.paused) return
  active.paused = false
  if (!active.waitingForTour) {
    armTimer(remainingMs ?? currentDurationMs())
  }
  remainingMs = null
  notify()
}

/** Advance to the next entry. Stops at end-of-list. */
export function skipNext(): void {
  if (!active) return
  const next = active.index + 1
  if (next >= active.playlist.datasets.length) {
    stop()
    return
  }
  active.index = next
  active.waitingForTour = false
  timerExpiredDuringTour = false
  remainingMs = null
  clearTimer()
  notify()
  void loadCurrentEntry()
}

/** Skip to the previous entry. No-op at index 0. */
export function skipPrev(): void {
  if (!active) return
  if (active.index === 0) return
  active.index -= 1
  active.waitingForTour = false
  timerExpiredDuringTour = false
  remainingMs = null
  clearTimer()
  notify()
  void loadCurrentEntry()
}

/** Jump to a specific index in the active playlist. Out-of-range
 *  values are clamped. */
export function skipTo(index: number): void {
  if (!active) return
  const clamped = clampIndex(index, active.playlist.datasets.length)
  if (clamped === active.index) return
  active.index = clamped
  active.waitingForTour = false
  timerExpiredDuringTour = false
  remainingMs = null
  clearTimer()
  notify()
  void loadCurrentEntry()
}

/** Stop playlist playback. The currently-loaded dataset stays put —
 *  the user's last-seen view shouldn't change just because the
 *  playlist ended. */
export function stop(): void {
  if (!active) return
  active = null
  remainingMs = null
  timerExpiredDuringTour = false
  clearTimer()
  notify()
}

/** Read-only snapshot of the current playback state, or null. */
export function getActive(): PlaylistPlaybackState | null {
  if (!active) return null
  return {
    playlist: {
      ...active.playlist,
      datasets: active.playlist.datasets.map((e) => ({ ...e })),
    },
    index: active.index,
    paused: active.paused,
    waitingForTour: active.waitingForTour,
  }
}

/**
 * Notify the playback module that a tour just finished. If the
 * active entry was waiting for a tour, advance to the next entry.
 * Idempotent — if no tour was pending, this is a no-op.
 */
export function notifyTourEnded(): void {
  if (!active || !active.waitingForTour) return
  active.waitingForTour = false
  notify()
  // Resolve the race with the per-entry timer:
  //   - If the timer already expired while the tour was running,
  //     advance now (the user has watched at least durationSec +
  //     the rest of the tour, fulfilling both signals).
  //   - Otherwise the timer is still ticking — let it run out and
  //     advance then. The user gets the full per-entry duration
  //     even when the tour wraps up early.
  if (timerExpiredDuringTour) {
    timerExpiredDuringTour = false
    skipNext()
  }
}

/** Subscribe to active-state changes (play/pause/advance/stop). */
export function onPlaybackChange(listener: (state: PlaylistPlaybackState | null) => void): () => void {
  const handler = () => listener(getActive())
  target.addEventListener(CHANGE_EVENT, handler)
  return () => target.removeEventListener(CHANGE_EVENT, handler)
}

// ─────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────

async function loadCurrentEntry(): Promise<void> {
  if (!active || !callbacks) return
  const snapshot = active
  const entry = snapshot.playlist.datasets[snapshot.index]
  if (!entry) {
    stop()
    return
  }

  const hasTour = callbacks.hasTourOnLoad(entry.datasetId)
  if (hasTour) {
    snapshot.waitingForTour = true
    notify()
  }

  let loadFailed = false
  try {
    await callbacks.loadDataset(entry.datasetId)
  } catch (err) {
    loadFailed = true
    logger.warn('[playlistPlayback] loadDataset failed:', entry.datasetId, err)
  }

  // The user may have stopped / skipped while the load was in flight.
  // Check that we're still on the same entry before arming the timer.
  if (active !== snapshot) return
  if (snapshot.index !== snapshot.playlist.datasets.indexOf(entry)) return
  // If the load failed, the tour we were speculatively waiting for
  // will never start — release the wait flag so the timer can
  // advance the playlist on its per-entry duration.
  if (loadFailed && snapshot.waitingForTour) {
    snapshot.waitingForTour = false
    notify()
  }
  // Always arm the per-entry timer, even for tour-bearing entries.
  // The timer + tour-end race resolves in armTimer's callback:
  //   timer fires, no tour pending → advance
  //   timer fires, tour still running → mark expired, wait
  //   tour ends, timer not yet expired → just clear waitingForTour
  //   tour ends, timer already expired → advance
  // This honors the user's durationSec as a floor while still
  // letting a long tour push the advance later, per the plan's
  // "waits for it to finish before advancing."
  timerExpiredDuringTour = false
  if (snapshot.paused) {
    remainingMs = currentDurationMs()
    return
  }
  armTimer(currentDurationMs())
}

function armTimer(ms: number): void {
  clearTimer()
  timerStartedAt = Date.now()
  advanceTimer = setTimeout(() => {
    advanceTimer = null
    // If a tour is still running on the current entry, defer the
    // advance — we record that the timer expired so the tour-end
    // path can advance immediately when it fires.
    if (active?.waitingForTour) {
      timerExpiredDuringTour = true
      return
    }
    skipNext()
  }, ms)
}

function clearTimer(): void {
  if (advanceTimer != null) {
    clearTimeout(advanceTimer)
    advanceTimer = null
  }
}

function currentDurationMs(): number {
  if (!active) return 0
  const entry = active.playlist.datasets[active.index]
  if (!entry) return 0
  return effectiveDuration(entry) * 1000
}

function clampIndex(value: number, length: number): number {
  if (length === 0) return 0
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(length - 1, Math.floor(value)))
}

function notify(): void {
  target.dispatchEvent(new Event(CHANGE_EVENT))
}

/** Test-only — reset every module-level field so test cases don't
 *  leak state. Paired with `localStorage.clear()` in beforeEach. */
export function resetPlaylistPlaybackForTests(): void {
  clearTimer()
  callbacks = null
  active = null
  remainingMs = null
  timerStartedAt = 0
  timerExpiredDuringTour = false
}
