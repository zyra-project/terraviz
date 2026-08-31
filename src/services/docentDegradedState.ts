// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Phase 1f/D — session-scoped degraded-mode state for the docent.
 *
 * The docent's chat path can land in a "Workers AI quota exhausted"
 * state if the Pages function's `/api/chat/completions` returns 503
 * `quota_exhausted` or `/api/v1/search` returns
 * `degraded: 'quota_exhausted'`. When that happens we want:
 *
 *   1. A persistent visible badge in the chat UI — current copy is
 *      "Reduced functionality — Workers AI quota reached.
 *      Suggestions are using offline matching until it recovers"
 *      (see `chatUI.degradedBadgeText`). Aligned with the
 *      `quota_exhausted` reason so user-facing messaging matches
 *      the underlying state rather than understating it.
 *   2. The local-engine fallback (`docentEngine.ts`) takes over
 *      transparently — already wired through the existing
 *      LLM-error → local-result path.
 *   3. The badge clears the moment the next LLM call succeeds, so
 *      a transient quota dip self-heals.
 *
 * State is module-level — same per-session lifetime as
 * `preSearchCache` (Commit 1f/C). The SPA re-initialises this
 * module on every page load → state resets on next session, no
 * explicit cleanup needed.
 *
 * Subscribers: `chatUI.ts` reads `getDegradedReason()` on every
 * render and listens via `subscribe()`.
 */

export type DegradedReason = 'quota_exhausted'

export interface DegradedState {
  reason: DegradedReason | null
  /** Wall-clock timestamp the reason was set; cleared with the reason. */
  since: number | null
}

let current: DegradedState = { reason: null, since: null }

type Listener = (state: DegradedState) => void
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener(current)
}

/**
 * Read the current degraded state. Returns a shallow copy so external
 * callers can't mutate module state without going through
 * `markDegraded` / `clearDegraded` (and bypassing subscriber
 * notification).
 */
export function getDegradedState(): Readonly<DegradedState> {
  return { ...current }
}

/** Convenience for checks like `if (getDegradedReason() === 'quota_exhausted')`. */
export function getDegradedReason(): DegradedReason | null {
  return current.reason
}

/**
 * Mark the docent degraded for the given reason. No-op when the
 * reason is already set (avoids redundant listener fanout when
 * multiple paths detect the same condition in the same turn).
 */
export function markDegraded(reason: DegradedReason): void {
  if (current.reason === reason) return
  current = { reason, since: Date.now() }
  emit()
}

/**
 * Clear the degraded state. Called when the next LLM call succeeds,
 * so a transient quota dip recovers without operator intervention.
 */
export function clearDegraded(): void {
  if (current.reason === null) return
  current = { reason: null, since: null }
  emit()
}

/**
 * Subscribe to state changes. Returns an unsubscribe function.
 * Listeners receive the new state synchronously after `markDegraded`
 * / `clearDegraded`.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test hook: drop the state and all listeners. */
export function resetForTests(): void {
  current = { reason: null, since: null }
  listeners.clear()
}
