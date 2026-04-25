/**
 * Telemetry emitter — batched event queue with tier-gated emission
 * and a pluggable network transport.
 *
 * Commit 1 landed the queue + tier gate + console-mode flush.
 * Commit 6 (this pass) wires a real network transport: successful
 * sends drop events locally, 410 cools the session down, 5xx /
 * network errors re-queue with exponential backoff, and a
 * `pagehide` handler fires a final `sendBeacon` so in-flight
 * events survive a tab close.
 *
 * A build with `VITE_TELEMETRY_ENABLED=false` compiles to a no-op
 * because the guards below inline to `false` and the minifier
 * drops the bodies.
 *
 * The transport is injected via `setTransport()` rather than
 * imported directly so tests can substitute a mock and so the
 * lazy Tauri HTTP plugin import stays in the transport module.
 * Until `setTransport()` is called, `flush()` falls back to the
 * Commit-1 console / no-op behaviour.
 */

import { TIER_B_EVENT_TYPES, type TelemetryEvent, type TelemetryTier } from '../types'
import {
  TELEMETRY_BUILD_ENABLED,
  TELEMETRY_CONSOLE_MODE,
  generateSessionId,
  loadConfig,
} from './config'
import {
  clearPersistedQueue,
  hydrateQueue,
  persistQueue,
  type Transport,
} from './transport'

/** Flush triggers. These constants are test-visible so a test can
 * verify the cadence without hard-coding literals. */
export const BATCH_SIZE = 20
export const BATCH_INTERVAL_MS = 5_000

/** Exponential backoff schedule in ms. Applied after a retryable
 * failure (5xx, 429, network error). We step through once per
 * consecutive failure, then clamp to the last entry. A 204 resets
 * the index to 0. */
export const BACKOFF_STEPS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
]

const TIER_B_SET: ReadonlySet<string> = new Set(TIER_B_EVENT_TYPES)

/** Pathnames where the emitter must stay silent regardless of tier.
 * The privacy policy page itself is a legal deliverable that must
 * emit zero events — fresh irony aside, a "we don't track you" page
 * that fires a session_start ping would be embarrassing. */
const SILENCED_PATHS: ReadonlySet<string> = new Set([
  '/privacy',
  '/privacy.html',
])

/** True when the current page is a no-emit surface. Reads
 * `location.pathname` defensively so non-DOM environments (early
 * Node, isolated unit tests) don't blow up. */
function isSilencedPath(): boolean {
  if (typeof location === 'undefined') return false
  return SILENCED_PATHS.has(location.pathname)
}

interface EmitterState {
  sessionId: string
  /** `performance.now()` captured at emitter construction. All
   * `client_offset_ms` values are computed relative to this. */
  sessionStartPerf: number
  /** Wall-clock `Date.now()` captured at emitter construction.
   * `session_end.duration_ms` is derived from this. */
  sessionStartWall: number
  /** Monotonically-incremented on every accepted emit(). Reported on
   * `session_end.event_count`. */
  eventCount: number
  queue: TelemetryEvent[]
  flushTimer: ReturnType<typeof setTimeout> | null
  /** True after the server responds 410. Caller should stop
   * attempting sends until the session is relaunched. */
  cooledDown: boolean
  /** Count of consecutive retryable failures. Indexes into
   * `BACKOFF_STEPS_MS`; a 204 resets to 0. */
  backoffIndex: number
  /** Earliest wall-clock time at which another send may be attempted.
   * Bumped to `now + BACKOFF_STEPS_MS[backoffIndex]` on failure. */
  nextSendAllowedAt: number
  /** Currently-wired transport. `null` means "no network attempts" —
   * flush() still drains the queue (Commit 1 behaviour), it just
   * doesn't POST. */
  transport: Transport | null
  /** Controller for the `pagehide` listener so `resetForTests` /
   * HMR can unwire it cleanly. */
  pagehideAbort: AbortController | null
  /** Flight tracking — non-null while a dispatch is in progress.
   * Tests `await` it to wait for the network cycle. */
  inflight: Promise<void> | null
}

function createState(): EmitterState {
  return {
    sessionId: generateSessionId(),
    sessionStartPerf:
      typeof performance !== 'undefined' ? performance.now() : 0,
    sessionStartWall: Date.now(),
    eventCount: 0,
    queue: [],
    flushTimer: null,
    cooledDown: false,
    backoffIndex: 0,
    nextSendAllowedAt: 0,
    transport: null,
    pagehideAbort: null,
    inflight: null,
  }
}

let state: EmitterState = createState()

/** Return the current in-memory session ID. Rotated at module load
 * and never persisted. Exposed for the Tools → Privacy UI display. */
export function getSessionId(): string {
  return state.sessionId
}

/** Queue an event for the next flush. Tier A events are queued when
 * the user is on Essential or Research; Tier B only on Research.
 * `tier === 'off'` drops everything. When the compile-time flag is
 * off, the whole body is dead code and tree-shakes out. */
export function emit(event: TelemetryEvent): void {
  if (!TELEMETRY_BUILD_ENABLED) return
  if (isSilencedPath()) return
  if (!tierGate(event.event_type)) return
  const stamped: TelemetryEvent = {
    ...event,
    client_offset_ms: currentOffset(),
  }
  state.queue.push(stamped)
  state.eventCount++
  if (state.queue.length >= BATCH_SIZE) {
    flush()
  } else {
    scheduleFlush()
  }
}

/** Total events accepted since app start. Used by `session_end`. */
export function getEventCount(): number {
  return state.eventCount
}

/** Wall-clock milliseconds since the session began. Used by
 * `session_end.duration_ms`. */
export function getSessionDurationMs(): number {
  return Math.max(0, Date.now() - state.sessionStartWall)
}

/** True if events of the given type are allowed under the current
 * tier. Pure function of config + event type — no side effects. */
export function tierGate(eventType: TelemetryEvent['event_type']): boolean {
  const { tier } = loadConfig()
  if (tier === 'off') return false
  if (tier === 'essential') return !TIER_B_SET.has(eventType)
  return true
}

/** Drain the queue. In console mode, logs the batch. With a transport
 * wired, hands the batch to the transport (async) and re-queues on
 * retryable failure. Returns the drained events synchronously so
 * tests and instrumentation can inspect what flushed without awaiting
 * the network round-trip. */
export function flush(): TelemetryEvent[] {
  if (!TELEMETRY_BUILD_ENABLED) return []
  if (state.flushTimer !== null) {
    clearTimeout(state.flushTimer)
    state.flushTimer = null
  }
  if (state.queue.length === 0) return []
  const drained = state.queue
  state.queue = []
  if (TELEMETRY_CONSOLE_MODE) {
    // eslint-disable-next-line no-console
    console.debug('[telemetry]', { sessionId: state.sessionId, events: drained })
    return drained
  }
  if (state.transport && !state.cooledDown) {
    state.inflight = dispatch(drained).finally(() => {
      state.inflight = null
    })
  }
  return drained
}

/** Async dispatch loop: send one batch, interpret the result, and
 * either drop / re-queue / persist + back off. Separated from
 * `flush()` so the synchronous call site returns immediately and
 * tests can still inspect drained events. */
async function dispatch(events: TelemetryEvent[]): Promise<void> {
  const transport = state.transport
  if (!transport) return

  // Pre-flight backoff gate. If we're still within a backoff window,
  // re-queue and schedule a retry instead of hitting the server. This
  // matters for the BATCH_SIZE path which calls flush() immediately
  // regardless of any in-flight backoff.
  const now = Date.now()
  if (now < state.nextSendAllowedAt) {
    requeue(events)
    persistIfTauri()
    scheduleFlushIn(state.nextSendAllowedAt - now + 50)
    return
  }

  let result
  try {
    result = await transport.send(state.sessionId, events)
  } catch {
    // Transport threw (should not normally happen — fetch errors are
    // caught inside transport.send — but defensive). Treat as retryable.
    requeue(events)
    stepBackoff()
    persistIfTauri()
    scheduleFlushIn(currentBackoffMs())
    return
  }

  if (result.ok) {
    state.backoffIndex = 0
    state.nextSendAllowedAt = 0
    clearPersistedQueue()
    // If anything landed in the queue while we were in flight (new
    // emits from call sites) schedule a follow-up flush.
    if (state.queue.length > 0) scheduleFlush()
    return
  }

  if (result.permanent) {
    // 410: kill switch on. Stop trying for the session. Drop the
    // batch and any queued events; nothing we hold now will be
    // accepted. Clearing the persisted queue prevents a stale
    // replay on relaunch.
    state.cooledDown = true
    state.queue = []
    clearPersistedQueue()
    if (state.flushTimer !== null) {
      clearTimeout(state.flushTimer)
      state.flushTimer = null
    }
    return
  }

  if (result.retryable) {
    requeue(events)
    stepBackoff()
    persistIfTauri()
    scheduleFlushIn(currentBackoffMs())
    return
  }

  // Non-retryable non-permanent (4xx malformed / 413 oversize).
  // Drop the batch to avoid infinite retries; log so a dev running
  // console mode can notice. Production consumers don't need the
  // noise.
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    // eslint-disable-next-line no-console
    console.warn('[telemetry] dropping batch, non-retryable status', result.status)
  }
}

/** Prepend retried events so ordering is preserved on replay. */
function requeue(events: TelemetryEvent[]): void {
  state.queue = events.concat(state.queue)
}

function stepBackoff(): void {
  state.backoffIndex = Math.min(
    state.backoffIndex + 1,
    BACKOFF_STEPS_MS.length - 1,
  )
  state.nextSendAllowedAt = Date.now() + currentBackoffMs()
}

function currentBackoffMs(): number {
  const idx = Math.min(state.backoffIndex, BACKOFF_STEPS_MS.length - 1)
  return BACKOFF_STEPS_MS[idx] ?? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]
}

function persistIfTauri(): void {
  // `transport.ts` only persists when running inside Tauri, so on
  // web this is effectively a no-op. Safe to call unconditionally.
  persistQueue(state.queue)
}

/** Install a transport. Call once during app init. A subsequent call
 * replaces the previous transport and reinstalls the `pagehide`
 * listener, which is useful during Vite HMR. Passing `null` detaches
 * the transport and returns the emitter to Commit-1 behaviour. */
export function setTransport(transport: Transport | null): void {
  // Hydrate any queue persisted by a previous session before we
  // start sending. First-launch no-ops (hydrateQueue returns []).
  if (transport && state.queue.length === 0) {
    const persisted = hydrateQueue()
    if (persisted.length > 0) {
      state.queue = persisted
      scheduleFlush()
    }
  }

  // Unwire any previous pagehide listener.
  state.pagehideAbort?.abort()
  state.pagehideAbort = null

  state.transport = transport

  if (transport && typeof window !== 'undefined') {
    const controller = new AbortController()
    state.pagehideAbort = controller
    // `pagehide` fires both on tab close and on bfcache entry; the
    // beacon-based path is the only reliable way to land a POST
    // during this event. We still clear the queue here so any
    // subsequent resume (bfcache) starts fresh.
    window.addEventListener(
      'pagehide',
      () => flushOnUnload(),
      { signal: controller.signal },
    )
  }
}

/** Fire a best-effort beacon for any pending events. Invoked from
 * the `pagehide` listener; safe to call directly in tests. On Tauri
 * the persistent queue covers this case; web relies on the beacon. */
export function flushOnUnload(): void {
  if (!TELEMETRY_BUILD_ENABLED) return
  if (state.cooledDown) return
  const transport = state.transport
  if (!transport) return
  if (state.queue.length === 0) return
  const drained = state.queue
  state.queue = []
  const accepted = transport.sendBeacon(state.sessionId, drained)
  if (!accepted) {
    // Browser refused the beacon (body too large, queue full, etc.).
    // Persist so the next launch can replay — on Tauri this is the
    // primary safety net; on web it's a last resort for returning
    // visitors whose tab closed mid-outage.
    requeue(drained)
    persistIfTauri()
  }
}

/** Current queue length. For tests and for a future dev inspector. */
export function size(): number {
  return state.queue.length
}

/** Test helper: reset emitter state. Regenerates the session ID,
 * clears the queue + timer, detaches any wired transport, and
 * unwires the pagehide listener. Not exported from the barrel. */
export function resetForTests(): void {
  if (state.flushTimer !== null) {
    clearTimeout(state.flushTimer)
  }
  state.pagehideAbort?.abort()
  state = createState()
}

/** Test helper: peek without draining. */
export function __peek(): readonly TelemetryEvent[] {
  return state.queue
}

/** Test helper: await any in-flight dispatch so assertions made
 * after flush() see the post-response state. Returns immediately
 * when nothing is in flight. */
export async function __awaitInflight(): Promise<void> {
  while (state.inflight) {
    await state.inflight
  }
}

/** Test helper: inspect transport bookkeeping without reaching
 * into module-private state. */
export function __transportState(): {
  cooledDown: boolean
  backoffIndex: number
  nextSendAllowedAt: number
  hasTransport: boolean
} {
  return {
    cooledDown: state.cooledDown,
    backoffIndex: state.backoffIndex,
    nextSendAllowedAt: state.nextSendAllowedAt,
    hasTransport: state.transport !== null,
  }
}

/** Apply the runtime consequences of a tier change to the in-memory
 * queue. `setTier()` in config.ts handles persistence; this handles
 * the buffer:
 *   - `off`  → drop every queued event (consent withdrawn)
 *   - `essential` → strip Tier B events that were queued while in
 *     research (stops research data from leaking after the user
 *     steps down a tier)
 *   - `research` → no-op (essential → research can only add new
 *     events; nothing queued needs removing)
 * Call sites should call this alongside `setTier` — the privacy UI
 * does. Keeping it a separate function keeps config.ts free of
 * emitter state references. */
export function applyTierChange(newTier: TelemetryTier): void {
  if (newTier === 'off') {
    state.queue = []
    if (state.flushTimer !== null) {
      clearTimeout(state.flushTimer)
      state.flushTimer = null
    }
    return
  }
  if (newTier === 'essential') {
    state.queue = state.queue.filter((e) => !TIER_B_SET.has(e.event_type))
  }
}

function currentOffset(): number {
  if (typeof performance === 'undefined') return 0
  return Math.max(0, Math.round(performance.now() - state.sessionStartPerf))
}

function scheduleFlush(): void {
  scheduleFlushIn(BATCH_INTERVAL_MS)
}

/** Schedule a flush after `ms` if one isn't already pending. Bumping
 * to a longer delay does not extend an already-scheduled flush; the
 * pending timer fires first and the follow-up dispatch's own backoff
 * gate will re-queue if needed. */
function scheduleFlushIn(ms: number): void {
  if (state.flushTimer !== null) return
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null
    flush()
  }, Math.max(0, ms))
}
