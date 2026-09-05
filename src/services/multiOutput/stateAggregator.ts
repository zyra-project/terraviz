// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The control window's mirrored-state accumulator.
 *
 * Every fact an output needs arrives here from a different place and on
 * a different schedule — a dataset load, a palette change, a playback
 * tick, a camera move — and leaves as one ordered stream of
 * `OutputStateMessage`s. Design: `docs/MULTI_MONITOR_PLAN.md` §3
 * "Globe state — what gets mirrored" and "Per-state-change flow".
 *
 * It is **pure**: no DOM, no Tauri, no timers, no subscriptions. Facts
 * are pushed in with `apply()` and messages come back as return values,
 * so the whole diff/sequence contract is testable without a window and
 * without a second monitor. `MultiOutputManager` owns the timer that
 * drives the per-second tick and the transport that emits the result;
 * this owns what is worth sending and what number it carries.
 *
 * Two decisions worth knowing before changing anything here.
 *
 * **`full()` does not advance `seq`.** A full snapshot restates a point
 * the sequence has already reached — it is what a newly-ready output
 * gets so it can join mid-stream, not a new event. Bumping `seq` for it
 * would make two outputs that hold identical state disagree about how
 * far along they are, and the late joiner would out-rank a diff the
 * others correctly applied. Only a real change advances the sequence.
 *
 * **The view is projected per output, not stored per output.** Both
 * `cameraOffset` and `split` are per-output settings in the plan, but
 * only one of them *originates* per output: `split` is a pure operator
 * choice, while `cameraOffset` is derived once from the operator's
 * MapLibre camera and then either passed through or zeroed depending on
 * whether that output tracks the camera. Holding one shared view and
 * projecting it at the send boundary (`projectState`) keeps a single
 * source of truth for the camera; holding N views would mean N copies
 * of the same derivation, drifting the moment one update path misses
 * one of them.
 */

import {
  type MirroredGlobeState,
  type MirroredView,
  type OutputStateMessage,
} from './protocol'

/** The camera offset that produces a uniform 1:1 equirectangular
 *  unwrap — the identity, and what an output that does not track the
 *  operator's camera always gets. */
export const CENTRED_CAMERA = { x: 0, y: 0, z: 0 } as const

/**
 * The state before anything has loaded.
 *
 * `dayNight: true` matches the control globe's own default, so an
 * output opened on a freshly-booted app shows the same Earth the
 * operator is looking at rather than a flat-lit one that has to be
 * corrected by the first diff.
 */
export function initialState(): MirroredGlobeState {
  return {
    dataset: null,
    primary: null,
    playback: null,
    display: null,
    layers: [],
    simulationDate: null,
    view: {
      dayNight: true,
      cameraOffset: { ...CENTRED_CAMERA },
      split: false,
    },
  }
}

/** The per-output half of the view — what the Outputs panel sets on one
 *  output rather than on the globe. */
export interface OutputViewSettings {
  /** When false, this output gets `CENTRED_CAMERA` regardless of where
   *  the operator has panned. */
  trackCamera: boolean
  /** Mirror the area of focus to the antipodal hemisphere. */
  split: boolean
}

export const DEFAULT_VIEW_SETTINGS: OutputViewSettings = {
  trackCamera: true,
  split: false,
}

/** Apply one output's settings to the shared view. */
export function projectView(
  shared: MirroredView,
  settings: OutputViewSettings,
): MirroredView {
  return {
    dayNight: shared.dayNight,
    cameraOffset: settings.trackCamera
      ? { ...shared.cameraOffset }
      : { ...CENTRED_CAMERA },
    split: settings.split,
  }
}

/**
 * Apply one output's settings to a whole state or diff.
 *
 * Takes `Partial<MirroredGlobeState>` because it sits on the send path
 * for diffs as well as snapshots. A diff that does not mention `view`
 * passes through untouched — projecting an absent key into a present
 * one would turn "nothing about the view changed" into a redundant
 * write on every unrelated update.
 */
export function projectState<T extends Partial<MirroredGlobeState>>(
  state: T,
  settings: OutputViewSettings,
): T {
  if (!state.view) return state
  return { ...state, view: projectView(state.view, settings) }
}

/** `Object.hasOwn` in a codebase whose `tsconfig` targets ES2020.
 *  Own-property, not `in`: an inherited key must not be read as a
 *  present value. */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/**
 * Structural equality over the mirrored-state values.
 *
 * These cross a structured-clone boundary by contract (see
 * `protocol.ts`), so they are plain data all the way down and a
 * recursive compare is exact rather than approximate. `JSON.stringify`
 * would be shorter and wrong: it is key-order sensitive, so two objects
 * built by different call sites with the same fields would compare
 * unequal and re-broadcast forever.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false

  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    const x = a as unknown[]
    const y = b as unknown[]
    return x.length === y.length && x.every((v, i) => sameValue(v, y[i]))
  }

  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = Object.keys(x)
  if (keys.length !== Object.keys(y).length) return false
  return keys.every(k => hasOwn(y, k) && sameValue(x[k], y[k]))
}

/** Every top-level key of the mirrored state, so `apply` can walk a
 *  patch without trusting its shape. */
const STATE_KEYS = [
  'dataset',
  'primary',
  'playback',
  'display',
  'layers',
  'simulationDate',
  'view',
] as const

/**
 * Fold one key of a patch into the state, recording it in `changed`.
 * Returns whether anything moved.
 *
 * Generic over the single key rather than inlined into `apply`'s loop
 * because a union-typed key makes `state[key] = patch[key]` unsound to
 * TypeScript — the write would demand the *intersection* of every value
 * type. Pinning `K` per call keeps the read and the write on the same
 * indexed access, which is what makes this safe without a cast.
 */
function foldKey<K extends keyof MirroredGlobeState>(
  state: MirroredGlobeState,
  changed: Partial<MirroredGlobeState>,
  patch: Partial<MirroredGlobeState>,
  key: K,
): boolean {
  if (!hasOwn(patch, key)) return false
  const next = patch[key]
  // `{ dataset: undefined }` is what a spread of an optional field
  // produces, and it means "I have nothing to say about this", never
  // "clear it" — the schema spells absence as `null`. Forwarding it
  // would also be a broadcast the output cannot act on: structured
  // clone drops an `undefined` property outright, so the diff would
  // arrive naming a key that is not there.
  if (next === undefined) return false
  if (sameValue(state[key], next)) return false
  state[key] = next
  changed[key] = next
  return true
}

export class StateAggregator {
  private state: MirroredGlobeState = initialState()
  private seq = 0

  /** The current shared state. Returned by reference for reads; callers
   *  must not mutate it — every write goes through `apply`. */
  current(): Readonly<MirroredGlobeState> {
    return this.state
  }

  /** How far the sequence has advanced. Exposed for the manager's
   *  bookkeeping and for tests; not part of the wire format. */
  sequence(): number {
    return this.seq
  }

  /**
   * Fold a patch into the state.
   *
   * Returns the diff message to broadcast, or `null` when nothing
   * actually changed — which is the common case for the per-second
   * tick on a paused globe, and the reason the tick can run
   * unconditionally instead of being started and stopped alongside
   * playback.
   *
   * Only the keys that changed appear in the diff. A patch naming a key
   * whose value is structurally identical is dropped rather than
   * forwarded: an output that rebuilds an HLS instance on `dataset` has
   * to be able to trust that a `dataset` in a diff means a *different*
   * dataset.
   */
  apply(patch: Partial<MirroredGlobeState>): OutputStateMessage | null {
    const changed: Partial<MirroredGlobeState> = {}
    let any = false

    for (const key of STATE_KEYS) {
      if (foldKey(this.state, changed, patch, key)) any = true
    }

    if (!any) return null

    this.seq += 1
    return { seq: this.seq, full: false, state: changed }
  }

  /**
   * The whole state, stamped with the sequence number it is current as
   * of. Sent to an output on `output_ready` and after a reconnect.
   */
  full(): OutputStateMessage {
    return { seq: this.seq, full: true, state: this.state }
  }

  /**
   * Advance the sequence without changing the state, and return the new
   * value.
   *
   * For a message that is a genuine new event for **one** output but
   * not a change to shared state — today, only the per-output view
   * projection when the operator toggles that output's own settings.
   * Such a message still has to out-rank every diff that output has
   * already applied, and re-using the current `seq` does not: the
   * output coalesces most-recent-wins, so an equal number loses and the
   * update is silently dropped.
   *
   * The cost is that the other outputs see a **gap** in the sequence.
   * That is deliberate and safe: `seq` is an ordering key, not a
   * delivery counter, and nothing on either side infers loss from a
   * skipped number. Do not add a gap detector without first giving
   * per-output messages their own sequence space.
   */
  bump(): number {
    this.seq += 1
    return this.seq
  }

  /**
   * Drop back to the initial state and restart the sequence.
   *
   * The counterpart to the protocol's "it resets on manager restart,
   * which a `full` snapshot always accompanies" — a caller that resets
   * owes every live output a `full()` immediately, or they will hold
   * state from the previous session at sequence numbers the new one is
   * about to reuse.
   */
  reset(): void {
    this.state = initialState()
    this.seq = 0
  }
}
