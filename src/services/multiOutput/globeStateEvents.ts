// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The control window's publish side of the mirrored globe state
 * (`docs/MULTI_MONITOR_PLAN.md` §3 "Globe state — what gets mirrored").
 *
 * `main.ts` and `datasetLoader` know *when* a fact about the globe
 * changes; `MultiOutputManager` knows *who* to tell. This module is the
 * seam between them, and it exists so neither has to import the other:
 * the app publishes whether or not a manager was ever constructed, and
 * a manager subscribes without the app knowing it did. That is what
 * keeps commit 9's backout honest — remove the manager and the app
 * still type-checks and still runs, publishing into an empty listener
 * set at the cost of one `Set` iteration over nothing.
 *
 * **Patches, not domain events.** A payload here is a
 * `Partial<MirroredGlobeState>` — the same shape `StateAggregator
 * .apply()` consumes — rather than a `{ type: 'dataset:loaded', … }`
 * union. A domain-event vocabulary would need translating to a patch
 * somewhere, and the only translation table would live in the
 * subscriber, where it could disagree with this module about what a
 * `dataset:loaded` implies without either side failing to compile.
 * Publishing the patch itself makes the wire format the only
 * vocabulary, so a field added to `MirroredGlobeState` is a field both
 * ends already agree on.
 *
 * Deliberately **not** here:
 *
 * - **Coalescing, diffing and sequence numbers.** `StateAggregator`
 *   owns all three. A publisher that also diffed would drop a patch the
 *   aggregator needed to see, and two things holding "the current
 *   state" is the bug the aggregator's copy-on-store rule exists to
 *   prevent.
 * - **Any notion of an output.** Projection per output (`split`,
 *   `cameraOffset`) happens at the send boundary in the manager. This
 *   module cannot see outputs and must not learn to.
 *
 * Pure: no DOM, no Tauri, no timers, no network. Mirrors the
 * module-scoped subscribe/notify shape of
 * `src/services/docentDegradedState.ts`.
 */

import type { MirroredGlobeState } from './protocol'

/** A change to the mirrored globe state. Only the keys present changed. */
export type GlobeStatePatch = Partial<MirroredGlobeState>

type Listener = (patch: GlobeStatePatch) => void

const listeners = new Set<Listener>()

/**
 * Publish a patch to every subscriber.
 *
 * A no-op when nothing is subscribed, which is the normal case: the web
 * build and every desktop launch without an output window publish into
 * an empty set. Call sites therefore do not gate on "is there a
 * manager" — asking would couple them to the thing this module exists
 * to decouple them from.
 *
 * Listeners are invoked synchronously, in subscription order. A
 * throwing listener must not cost the others their notification, nor
 * unwind into the dataset-load path that published — a broken output
 * link is not a reason for the control window's load to fail — so each
 * call is isolated and a failure is reported without being rethrown.
 */
export function publishGlobeState(patch: GlobeStatePatch): void {
  if (listeners.size === 0) return
  // Iterate a copy: a listener that unsubscribes itself (or another)
  // while being notified would otherwise mutate the set mid-iteration.
  for (const listener of [...listeners]) {
    try {
      listener(patch)
    } catch (err) {
      // Not `logger.error` on the app's behalf — this is the output
      // link's problem, and the control window is still correct.
      console.warn('[multiOutput] a globe-state listener threw', err)
    }
  }
}

/**
 * Subscribe to globe-state patches. Returns an unsubscribe function.
 *
 * There is deliberately no replay of the last patch on subscribe: a
 * patch is a *change*, and a subscriber that joined late has missed
 * changes it cannot reconstruct from one of them. The manager's own
 * `full()` snapshot is how a late joiner is brought up to date, and
 * that is the aggregator's job rather than this module's.
 */
export function subscribeGlobeState(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test hook: drop every listener. */
export function resetGlobeStateEventsForTests(): void {
  listeners.clear()
}
