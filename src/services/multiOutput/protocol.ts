// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Control ↔ output IPC contract for multi-monitor output windows.
 *
 * This module is imported by **both** bundles — the control window's
 * `MultiOutputManager` and the output window's `src/output/main.ts` —
 * and is the single source of truth for the mirrored state schema.
 * Design: `docs/MULTI_MONITOR_PLAN.md` §3 "Globe state — what gets
 * mirrored" and §"Output capability spec".
 *
 * It is deliberately **types, names and agreed numbers only**: no DOM,
 * no Tauri import, no behaviour. Both bundles depend on it, so anything
 * with a runtime cost here is paid twice, and anything with a side
 * effect here runs in a window that may not have the capability for it.
 * Every type import below erases at compile time.
 *
 * What is *not* here, on purpose:
 *
 * - **Sync-control constants.** `SIBLING_MIN_READY_STATE`,
 *   `SIBLING_HARD_SEEK_THRESHOLD_S` and `SIBLING_SEEK_EPS_S` are tuned
 *   values in `src/utils/time.ts` with measurements behind them. The
 *   output imports them from there. A copy is a copy that drifts.
 * - **The decoder budget.** `DEFAULT_CONCURRENT_DECODERS` belongs with
 *   the code that counts decoders (`src/output/datasetMirror.ts`), not
 *   with the wire format.
 * - **`PersistedOutputConfig`.** That is the manager's on-disk shape,
 *   not something an output ever receives. It lands with persistence.
 */

import type { DatasetOverlayOptions } from '../../types'
import type { ColorScaleDisplay } from '../colorScaleDisplay'

// --- Window labels ---

/**
 * Label prefix for every output window.
 *
 * This is not cosmetic. `src-tauri/capabilities/output.json` scopes
 * itself with the glob `output-*`, so a window whose label does not
 * match this prefix silently gets the *wrong* capability set — and an
 * ACL denial does not announce itself, it looks like a feature that
 * does not work (see the plan's §6). Mint labels through
 * `outputLabel()` rather than by hand.
 */
export const OUTPUT_LABEL_PREFIX = 'output-'

/** The window label for output `index` (1-based, matching the UI). */
export function outputLabel(index: number): string {
  return `${OUTPUT_LABEL_PREFIX}${index}`
}

/**
 * True if `label` names an output window.
 *
 * Used by the manager's boot scan over `WebviewWindow.getAll()` to tell
 * orphaned outputs from the control window after a control-window crash
 * (plan §"Failure recovery" case 6). Requires at least one character
 * after the prefix, so the bare string `'output-'` is not an output.
 */
export function isOutputLabel(label: string): boolean {
  return label.startsWith(OUTPUT_LABEL_PREFIX) && label.length > OUTPUT_LABEL_PREFIX.length
}

// --- Mirrored globe state ---

/** Output projection mode. v1 ships one; the field exists so the wire
 *  format does not change when fisheye / mirrored modes land. */
export type OutputMode = 'sos-equirect'

/** What the control window's primary panel currently has loaded. */
export interface MirroredDataset {
  id: string
  /** Resolved by the *control* window, because it owns variant choice
   *  and offline-cache lookup. An output never resolves a URL itself. */
  url: string
  kind: 'image' | 'video'
  /**
   * The whole `DatasetOverlayOptions` bundle, not a bare bbox.
   *
   * Every field in it is a UV or shading decision the output would
   * otherwise re-derive from the catalog row and get wrong
   * independently: `lonOrigin` for textures that do not start at
   * −180°, `isFlippedInY` for bottom-up storage, `boundingBox` for
   * regional data clipped over a base Earth, `celestialBody` for
   * suppressing Earth decoration on a Mars or Moon dataset, and
   * `colorScale` — which is what carries data-encoded mode across.
   * `datasetId` / `datasetTitle` ride along so a *frame* can say what
   * it is rather than the reader asking app state and hoping the two
   * agree.
   */
  overlay: DatasetOverlayOptions
}

/**
 * The primary window's media state — the inputs
 * `computeSiblingSyncCorrection` needs about the thing being mirrored.
 *
 * Separate from `MirroredDataset` because the two have different
 * lifetimes: the dataset is known the instant a load starts, while
 * `duration` is not known until that element's metadata arrives. A
 * single block would have to encode "loaded but duration still
 * unknown" as a magic value.
 *
 * Note the plan's state table (§3 "Globe state") calls these
 * `dataset.duration` / `dataset.rangeMs` while its worked example in
 * §3 "The call" reads `state.primary.duration` / `state.primary
 * .rangeMs`. This follows the worked example, since that is the code
 * the output is written against.
 */
export interface MirroredPrimary {
  /** The primary video element's duration, in seconds. */
  duration: number
  /** The primary dataset's temporal span, `end - start`, in ms. */
  rangeMs: number
}

/**
 * Where the primary's playhead is — expressed as an instant, never as
 * a `currentTime`.
 *
 * A playhead is only meaningful against one specific media element. If
 * the output rebuilt its HLS instance, landed on a different rendition,
 * or is a diff behind on a dataset change, applying a raw playhead
 * shows the wrong moment with no way to notice. A date is checkable,
 * and it is what the read-back verification layer compares against.
 */
export interface MirroredPlayback {
  /** ISO 8601. The real-world instant the primary is showing. */
  date: string
  paused: boolean
  /**
   * The primary's **current** rate. Never assume `1`.
   *
   * `tourEngine`'s `frameRate` task computes `requestedFps /
   * datasetFps` and applies it to the primary alone — a 5 fps request
   * against a 30 fps dataset is 0.167×. An output that assumes 1 runs
   * ~6× fast, races ahead, hard-seeks back, and repeats for the whole
   * tour. That is terraviz#229 reproduced in a second window.
   */
  playbackRate: number
}

/** One layer of the composite. Array order *is* z-order — there is no
 *  depth buffer to disagree with it (`src/output/layerStack.ts`). */
export interface MirroredLayer {
  id: string
  datasetId: string
  url: string
  kind: 'image' | 'video'
  overlay: DatasetOverlayOptions
}

export interface MirroredView {
  dayNight: boolean
  /**
   * Derived from the operator's MapLibre camera, so zooming the control
   * window concentrates pixels around the area of focus on the sphere.
   * Pinned to `(0, 0, 0)` when the per-output "Track operator camera"
   * toggle is off, which produces a uniform 1:1 equirectangular unwrap.
   *
   * A plain triple rather than a `THREE.Vector3`: this crosses a
   * structured-clone boundary, and the output bundle owns the only
   * Three.js import.
   */
  cameraOffset: { x: number; y: number; z: number }
  /** Mirror the area of focus to the antipodal hemisphere — matches
   *  existing SOS sphere-split behaviour. Per-output. */
  split: boolean
}

/**
 * Everything an output needs to render, and nothing it does not.
 *
 * `null` means "nothing loaded", which an output renders as the idle
 * photoreal Earth. Note that idle stays Earth even for a node whose
 * catalog is mostly another body — it is only the *loaded-dataset*
 * path that consults `overlay.celestialBody`.
 */
export interface MirroredGlobeState {
  dataset: MirroredDataset | null
  primary: MirroredPrimary | null
  playback: MirroredPlayback | null
  /** The operator's palette / stretch / threshold. Absent for a dataset
   *  that is not data-encoded. Mirrored separately from `overlay
   *  .colorScale` because it is a *display* transform the operator
   *  changes at will — without it, an operator who switches the control
   *  globe to magma leaves the sphere on viridis. */
  display: ColorScaleDisplay | null
  layers: MirroredLayer[]
  /** ISO 8601, or `null` when no dataset is loaded. */
  simulationDate: string | null
  view: MirroredView
}

// --- Manager → output ---

/** Event name the manager targets with `emitTo(label, …)`. */
export const OUTPUT_STATE_EVENT = 'output_state'

/**
 * A state broadcast: a full snapshot on `output_ready` and after a
 * reconnect, a partial diff on every change thereafter.
 *
 * `seq` is monotonic per manager session and exists because the output
 * coalesces queued messages most-recent-wins. Without an ordering key
 * it cannot tell a late delivery from a new one, and a stale diff
 * applied after a fresh one silently shows the wrong frame. It resets
 * on manager restart, which a `full` snapshot always accompanies.
 */
export interface OutputStateMessage {
  seq: number
  /** `true` → `state` is a complete `MirroredGlobeState`; `false` →
   *  only the keys present have changed. */
  full: boolean
  state: MirroredGlobeState | Partial<MirroredGlobeState>
}

/** Narrowing helper — a full message carries the complete state. */
export function isFullState(
  msg: OutputStateMessage,
): msg is OutputStateMessage & { full: true; state: MirroredGlobeState } {
  return msg.full
}

// --- Output → manager ---

/**
 * The single channel every output emits on.
 *
 * One channel rather than one per message type, because the output's
 * capability grants `core:event:allow-emit` broadly and each extra
 * channel is another name to audit. The manager discriminates on
 * `type`.
 */
export const OUTPUT_EVENT = 'output_event'

/**
 * Every variant carries `label`.
 *
 * The output→manager direction uses `emit(…)`, which broadcasts rather
 * than targets, so the channel alone does not say which window spoke.
 * The manager routes on this field; an event without it is
 * unattributable and gets dropped.
 */
interface OutputEventBase {
  label: string
}

/** Output has booted and is listening. Manager replies with a full
 *  snapshot. Carries the monitor it actually landed on, so the manager
 *  can check that against the config it spawned from. */
export interface OutputReadyEvent extends OutputEventBase {
  type: 'output_ready'
  monitorName: string | null
  mode: OutputMode
}

/** Liveness ping while the output believes the link is stale. */
export interface OutputHealthCheckEvent extends OutputEventBase {
  type: 'output_health_check'
  /** How long the output has gone without a state message, in ms. */
  silentMs: number
}

/** The output's own stream stalled — distinct from the link going
 *  quiet, and the manager badges the two differently. */
export interface OutputDatasetStalledEvent extends OutputEventBase {
  type: 'output_dataset_stalled'
  datasetId: string | null
}

/** A lost WebGL context came back and the scene was rebuilt. */
export interface OutputGpuRecoveredEvent extends OutputEventBase {
  type: 'output_gpu_recovered'
}

/**
 * Read-back verification says the shown frame does not match the
 * broadcast date, on three consecutive checks.
 *
 * This layer reports; it never seeks. Re-seeking from here would fight
 * the sync controller for ownership of the playhead.
 */
export interface OutputFrameStaleEvent extends OutputEventBase {
  type: 'output_frame_stale'
  datasetId: string | null
  /** The instant the manager asked for. */
  expectedDate: string
  /** What the output believes it is actually showing, or `null` if it
   *  cannot tell. */
  shownDate: string | null
}

/** Graceful shutdown. Its *absence* before a window is destroyed is how
 *  the manager tells a crash from an operator-initiated close. */
export interface OutputClosingEvent extends OutputEventBase {
  type: 'output_closing'
}

export type OutputEvent =
  | OutputReadyEvent
  | OutputHealthCheckEvent
  | OutputDatasetStalledEvent
  | OutputGpuRecoveredEvent
  | OutputFrameStaleEvent
  | OutputClosingEvent

// --- Agreed timings ---

/**
 * These three live here because both sides must agree on them: the
 * manager's send cadence sets the floor the output's silence detector
 * measures against. Splitting them across the two bundles is how they
 * drift apart.
 */

/** Manager's steady-state broadcast cadence — the per-second timecode
 *  tick, which is the floor an output can expect while playing. */
export const STATE_TICK_MS = 1000

/** Silence after which the output declares the link stale and the
 *  Outputs panel badges it. The output keeps rendering its last known
 *  state; the audience sees frozen content, not a black screen. */
export const IPC_STALE_MS = 5000

/**
 * Silence after which the output considers itself orphaned and stops
 * pinging.
 *
 * It does **not** self-destruct — the sphere keeps showing content for
 * any visitor mid-session. It just stops phoning home and waits for the
 * manager's boot scan to re-establish contact.
 */
export const IPC_ORPHAN_MS = 60000
