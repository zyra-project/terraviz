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
 * - **The decoder budget.** It belongs with the code that counts
 *   decoders, not with the wire format. That turned out to be the
 *   *manager* rather than `datasetMirror` — the count is cross-window
 *   and an output can only see itself — so it landed as
 *   `PersistedOutputConfig.concurrentDecoderBudget` in
 *   `outputPersistence.ts`, machine-scoped and operator-settable.
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
 * The index in an output label, or `null` if it does not carry one.
 *
 * The inverse of `outputLabel`, and it lives beside it so the grammar
 * has one home rather than a mint here and an ad-hoc parse at the call
 * site. Rung 10 needs it to advance the label counter past a restored
 * set, so a fresh Add cannot mint a label that collides with a window
 * already on screen.
 *
 * Strict about what it accepts: `output-01` and `output-1x` are not
 * labels this module would ever have minted, and reading an index out
 * of them would be inventing one.
 */
export function outputLabelIndex(label: string): number | null {
  if (!isOutputLabel(label)) return null
  const suffix = label.slice(OUTPUT_LABEL_PREFIX.length)
  if (!/^[1-9][0-9]*$/.test(suffix)) return null
  return Number(suffix)
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

/**
 * Every projection geometry an output can be, and the one list a new
 * mode is registered in — the type is derived from it, so a mode cannot
 * be added to one and forgotten in the other.
 *
 * - `sos-equirect` — v1's 2:1 unwrap, for an LED sphere, a dome, or
 *   anything else that takes an equirectangular frame. A persisted
 *   string, so it keeps its name though an SOS projector rig is now
 *   `projector-warp`'s: renaming it would reset every operator's saved
 *   outputs to buy nothing.
 * - `projector-warp` — a projector rig's warp meshes, each in its
 *   viewport of one spanned framebuffer (rung 16). Named for what it
 *   does rather than for SOS, whose four quadrants are one rig among the
 *   several sphere-sim calibrates.
 */
export const OUTPUT_MODES = ['sos-equirect', 'projector-warp'] as const

/** Output projection mode. */
export type OutputMode = (typeof OUTPUT_MODES)[number]

/**
 * The mode a window whose URL names none renders — every window a build
 * before rung 16 spawned, and every `sos-equirect` one since, because
 * `outputModeQuery` spawns that mode bare.
 */
export const DEFAULT_OUTPUT_MODE: OutputMode = 'sos-equirect'

/**
 * Narrow a value read from outside — a stored config, a URL — to a mode
 * this build renders. Anything else is `false`, never a guess: a mode
 * this build does not know must not come back as one it does, least of
 * all as `sos-equirect`, which thrown across calibrated projectors is an
 * unwarped picture worse than black.
 */
export function isOutputMode(value: unknown): value is OutputMode {
  return (OUTPUT_MODES as readonly unknown[]).includes(value)
}

/** The query parameter an output's entry URL carries its mode in. */
export const OUTPUT_MODE_PARAM = 'mode'

/**
 * The query an output window is spawned with, which is how it learns its
 * geometry — **and the only way**. A window must know its mode before it
 * hears anything, or the check that a `view` arm matches it would be
 * vacuous (see `acceptView` in `outputLink`), and the URL is the one
 * carrier that exists before any IPC does.
 *
 * `sos-equirect` spawns with no query at all, exactly as every window
 * before rung 16 did, so the bare URL keeps meaning what it always
 * meant. Grammar, like `outputLabel`, and beside it for the same reason:
 * the manager writes it and the output reads it, and the two must agree.
 */
export function outputModeQuery(mode: OutputMode): string {
  return mode === DEFAULT_OUTPUT_MODE ? '' : `?${OUTPUT_MODE_PARAM}=${mode}`
}

/**
 * The mode an output's own URL names: `sos-equirect` when it names none,
 * or `null` when it names one this build does not know, or names more
 * than one. `null` is the output's cue to draw nothing and say so.
 */
export function outputModeFromQuery(search: string): OutputMode | null {
  const named = new URLSearchParams(search).getAll(OUTPUT_MODE_PARAM)
  if (named.length === 0) return DEFAULT_OUTPUT_MODE
  return named.length === 1 && isOutputMode(named[0]) ? named[0] : null
}

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
  /**
   * The dataset's own temporal span, ISO 8601, or `null` for a dataset
   * with no time axis.
   *
   * **The output cannot derive this and cannot sync without it.**
   * `computeSiblingSyncCorrection` maps the primary's real-world
   * `playback.date` onto a video time through the *sibling's* own
   * `sibStart` / `sibEnd`, and an output has no catalog to look them up
   * in — `MirroredPrimary.rangeMs` gives the span's length but not
   * where it starts, so a date cannot be placed on the timeline from it
   * alone.
   *
   * They belong on the dataset rather than beside `duration` in
   * `MirroredPrimary` because they are properties of the *data*, fixed
   * for as long as it is loaded, while `duration` is a property of one
   * decoded media element and is unknown until its metadata arrives.
   *
   * In the mirroring case these equal the primary's own range and the
   * pacing ratio comes out at 1. That is the degenerate case of the
   * general one, not a separate path — which is why the output runs the
   * same control law a sibling globe does rather than a simplified one.
   */
  startTime: string | null
  endTime: string | null
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
  /**
   * ISO 8601 — the real-world instant the primary is showing — or
   * `null` for a dataset with **no time axis**.
   *
   * Nullable rather than absent, and the whole record published rather
   * than withheld, because a dataset without `startTime`/`endTime` still
   * has transport state an output must mirror: whether it is running,
   * and how fast. Withholding the record was the shipped behaviour, and
   * it left every such dataset frozen on its first decoded frame —
   * `syncVideoToState`'s only `play()` sits past the gate that rejected
   * a null playback. On a 24-hour animation that reads as a *longitude*
   * error rather than a time one, because the terminator and any
   * burnt-in clock are then half a day out from the operator's globe.
   * That is how it was first reported from hardware.
   */
  date: string | null
  /**
   * Position within the clip, 0-1.
   *
   * The one position measure that survives having no time axis, and the
   * reason a raw `currentTime` still does not cross: a ratio is
   * comparable across renditions, and `hlsService` resolves a rendition
   * per instance, so an output's element is not required to be the same
   * encode as the primary's. With a time axis this is redundant with
   * `date` and unread; without one it is the only thing keeping two
   * copies of a looping animation together.
   */
  positionRatio: number
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

/**
 * `sos-equirect`'s renderer parameters — the payload of that arm of
 * `MirroredView`.
 *
 * Two of its fields are properties of *that projection* rather than of
 * outputs in general:
 *
 * - `cameraOffset` is bounded by `MAX_CAMERA_OFFSET` because the
 *   ray-march requires a camera strictly **inside** the unit sphere —
 *   that is why the shader has no miss branch. A projector sitting
 *   outside the sphere, or an ordinary perspective camera, has no such
 *   bound, so the constraint describes this projection and not a
 *   camera in general.
 * - `split` is `fract(u * 2)` — a fold of the equirectangular U axis.
 *   A perspective view has no U axis to fold.
 *
 * **Structurally identical to `EquirectParams` in
 * `src/output/equirectRtt.ts`, deliberately** — that is what the
 * shader's `setParams` already takes, so an output that has narrowed
 * on `mode` hands `view.params` straight through with no adapter.
 * `protocol.test.ts` proves the two stay assignable in both
 * directions; it is declared here rather than imported because the
 * contract must not depend on one of its consumers, and because
 * `equirectRtt` lives in the output bundle.
 *
 * The `|o| ≤ MAX_CAMERA_OFFSET` bound is enforced once, in
 * `cameraOffsetForCamera`, where the maths is. Re-checking it here
 * would be a second enforcer free to disagree with the first.
 */
export interface MirroredEquirectParams {
  /**
   * Derived from the operator's MapLibre zoom, so zooming the control
   * window concentrates pixels around the sphere's **front**, where
   * `orientation` has brought the area of focus. In the sphere's frame,
   * so it moves toward the front whatever is turned to face it. Pinned
   * to `(0, 0, 0)` when the per-output "Track operator camera" toggle is
   * off, which produces a uniform 1:1 equirectangular unwrap.
   *
   * A plain triple rather than a `THREE.Vector3`: this crosses a
   * structured-clone boundary, and the output bundle owns the only
   * Three.js import.
   */
  cameraOffset: { x: number; y: number; z: number }
  /**
   * The turn from the sphere's frame to the content's, row-major, so
   * the operator's centre faces the sphere's front with the control
   * globe's way up — how a pole is brought round to where an audience
   * can see it (`equirectRtt.followOrientation`). Identity when the
   * output does not track the operator's camera.
   *
   * Nine numbers rather than the camera's lat/lon/bearing, because this
   * object is the renderer's: a narrowed output uploads it as it comes,
   * and deriving it on the output would put a second implementation of
   * the turn in every window, free to disagree with the one the tests
   * pin.
   */
  orientation: readonly [number, number, number, number, number, number, number, number, number]
  /** Mirror the area of focus to the antipodal hemisphere — matches
   *  existing SOS sphere-split behaviour. Per-output. */
  split: boolean
  /**
   * Per-installation longitude rotation, **radians** (rung 14).
   *
   * Per-output rather than shared, and that is the whole reason it is
   * in `params`: two spheres in two rooms are mounted differently, and
   * a globally-broadcast offset would turn both when the operator
   * aligns one.
   *
   * Radians on the wire though the operator types degrees, because
   * this object *is* `equirectRtt`'s `EquirectParams` — a narrowed
   * output hands it straight to `setParams` — so a degree value here
   * would need converting inside the output too, which is a second
   * conversion free to disagree with `projectView`'s.
   */
  rotationOffsetRad: number
}

/** What every arm of `MirroredView` carries, whatever its geometry. */
export interface MirroredViewCommon {
  /** How the Earth is lit. Projection-independent — true of any
   *  geometry that draws one — so it sits outside `params`. */
  dayNight: boolean
}

/** The `sos-equirect` arm: v1's LED-sphere / dome unwrap. */
export interface MirroredEquirectView extends MirroredViewCommon {
  mode: 'sos-equirect'
  params: MirroredEquirectParams
}

/**
 * The `projector-warp` arm (rung 16): a projector rig's warp meshes over
 * the same ray-march.
 *
 * **The same parameters as `sos-equirect`'s, `split` included.** A warp
 * changes how an arm becomes pixels, not what it holds: the fragment
 * recovers `(u, v)` from the direction the mesh interpolates, and
 * everything after that line is the equirect shader — the camera offset
 * that is operator zoom, SOS's split fold, the rotation. One thing reads
 * differently: a sphere rig's mechanical rotation is already baked into
 * the mesh, so here `rotationOffsetRad` is a **content** rotation, a
 * turn of the picture on top of whatever the warp maps (plan §"Three
 * conventions that fail silently", 3). The value and the uniform are the
 * same; the panel's label is not.
 *
 * A separate arm rather than a flag on the first, because the mode is
 * what a window is spawned as and what it checks every view against.
 */
export interface MirroredWarpView extends MirroredViewCommon {
  mode: 'projector-warp'
  params: MirroredEquirectParams
}

/**
 * How **one output** should project the globe, discriminated on its
 * mode. Produced by `projectView` at the send boundary; never stored.
 *
 * A union rather than a flat bag, and the discriminant earns itself
 * twice over:
 *
 * 1. **An output cannot receive settings it has no meaning for.** These
 *    fields were once flat beside `dayNight` and went to every output
 *    with nothing marking two of the three conditional. With one mode
 *    that is merely untidy; with two it is a perspective output handed
 *    a `split` it has to know to ignore, and an offset whose invariant
 *    does not describe its camera.
 * 2. **It is checkable on arrival.** An output announces its own mode
 *    in `OutputReadyEvent`, so `view.mode` disagreeing with it is a
 *    real fault — a window that booted as one geometry being driven as
 *    another — and now one an output can detect rather than render
 *    wrongly.
 *
 * Each arm's payload is `params`, uniformly, because that is what the
 * arm's renderer takes: `sos-equirect`'s is `equirectRtt`'s own
 * `EquirectParams`, which is what `outputScene.setParams` already
 * accepts, and `projector-warp`'s is the same object because the same
 * ray-march runs behind the warp. A mode with a different renderer adds
 * an arm whose `params` is *its* renderer's object; nothing else in the
 * union changes.
 *
 * The two proofs below tie the union to `OutputMode` in both
 * directions, so neither list can gain a member without the other.
 */
export type MirroredView = MirroredEquirectView | MirroredWarpView

/**
 * Compile-time proof that `OutputMode` and the union agree.
 *
 * Both directions, because either alone is satisfiable by a subset: a
 * mode with no arm would be broadcast as some other mode's shape, and
 * an arm with no mode could never be selected. `Exclude` is `never`
 * only when nothing is missing, so the constraint stops satisfying the
 * moment the two lists diverge.
 *
 * A *constraint*, not an annotated empty value — the same trap
 * `STATE_KEYS` documents in `stateAggregator.ts`: `const _: Missing[] =
 * []` compiles whatever the type resolves to.
 */
type AssertNoneMissing<T extends never> = T
type _EveryModeHasAnArm = AssertNoneMissing<Exclude<OutputMode, MirroredView['mode']>>
type _EveryArmIsAMode = AssertNoneMissing<Exclude<MirroredView['mode'], OutputMode>>

/**
 * Where the operator has the control globe pointed, in the operator's
 * own terms.
 *
 * These are MapLibre's numbers, unconverted, and that is the point: the
 * operator drives one globe with one camera, and *every* output
 * geometry is a function of it. `sos-equirect` turns it into a turn
 * that brings the operator's centre to the sphere's front and a
 * ray-march origin inside the unit sphere; a perspective mode would
 * turn the same numbers into an eye position and a field of view; a
 * warped projector rig runs `sos-equirect`'s answer behind its meshes.
 * None of those is more canonical than another, so the shared state
 * holds the input rather than any one mode's output.
 *
 * This replaced storing `sos-equirect`'s own `cameraOffset` as the
 * shared value. That worked — the offset is invertible, `|o|` recovers
 * the zoom factor and its direction the lat/lon — but it made one
 * geometry's encoding the thing every other geometry had to be derived
 * *through*, and a derivation chained off another mode's lossy,
 * clamped output is a worse starting point than the operator's actual
 * camera. `MAX_CAMERA_OFFSET` clamps the equirect offset, so a zoom
 * past that point is no longer recoverable from it at all.
 */
export interface OperatorCamera {
  /** Degrees, −90 (south pole) to 90. */
  lat: number
  /** Degrees, −180 to 180. */
  lon: number
  /** MapLibre zoom. `0` is the whole globe, and derives to a centred
   *  camera in every mode — see `DEFAULT_OPERATOR_CAMERA`. */
  zoom: number
  /**
   * MapLibre bearing, degrees in (−180, 180]: the compass direction at
   * the top of the control globe. The control globe turns on a
   * right-drag or a two-finger twist, and an output following it shows
   * that same way up. Pitch is deliberately absent — it tilts a viewer,
   * and no output geometry has a viewer to tilt.
   */
  bearing: number
}

/**
 * What the **control window** knows about the view: one globe's facts,
 * belonging to no output's geometry.
 *
 * The aggregator holds exactly one of these and diffs it. It is not
 * what an output receives — `projectView` turns it into that output's
 * `MirroredView` arm, using that output's own mode and settings.
 *
 * Keeping the two apart is what stops any mode being privileged. While
 * the shared value was an `sos-equirect` arm, a second mode could only
 * be reached by deriving from equirect's, and `CANONICAL_VIEW_MODE`
 * existed to name which arm that was. There is no canonical arm now, so
 * there is nothing to name.
 */
export interface SharedView extends MirroredViewCommon {
  camera: OperatorCamera
}

/**
 * Everything an output needs to render, and nothing it does not.
 *
 * Generic over the view because the control window and an output hold
 * genuinely different ones: the control window has a globe and a camera
 * (`SharedView`), an output has a geometry and that geometry's
 * parameters (`MirroredView`). Every other field is identical, so one
 * structure with two instantiations says that, where two hand-written
 * interfaces would drift the first time a field is added to one.
 *
 * `null` means "nothing loaded", which an output renders as the idle
 * photoreal Earth. Note that idle stays Earth even for a node whose
 * catalog is mostly another body — it is only the *loaded-dataset*
 * path that consults `overlay.celestialBody`.
 */
export interface GlobeState<V> {
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
  view: V
}

/** What the control window accumulates and diffs. One per app. */
export type MirroredGlobeState = GlobeState<SharedView>

/** What one output receives, after `projectView` has resolved the
 *  shared camera into that output's own geometry. */
export type OutputGlobeState = GlobeState<MirroredView>

// --- Output window configuration ---

/**
 * Framebuffer widths the resolution picker offers, and the one place
 * both ends agree on them.
 *
 * Here rather than in `outputScene` because **both ends need the
 * list**: the Outputs panel offers it, the output snaps a requested
 * width to it. `outputUI` cannot import the output bundle — it is
 * pulled eagerly by `main.ts`, so a value import from `src/output/`
 * would drag the scene and its Three seams into the web entry chunk —
 * and a second copy in the panel is a copy that drifts from the rungs
 * the renderer actually supports.
 *
 * Heights are always half: an equirectangular frame that is not 2:1 is
 * not equirectangular. That is a property of *this projection*, not of
 * outputs in general — a second `OutputMode` brings its own ladder
 * rather than widening this one (plan §"Geometry is a per-output
 * configuration"). `projector-warp` brings none at all: a projector's
 * raster is whatever shape the spanned display is, so that window sizes
 * its buffer from itself and never reads this (rung 16).
 */
export const FRAMEBUFFER_WIDTHS = [1024, 2048, 4096, 8192] as const

export type FramebufferWidth = (typeof FRAMEBUFFER_WIDTHS)[number]

/** What an output renders at by default. The middle of the ladder:
 *  8192 costs 128 MiB a window and 1024 is a preview rung. */
export const DEFAULT_FRAMEBUFFER_WIDTH: FramebufferWidth = 4096

/** Event name for manager → output window configuration. */
export const OUTPUT_RENDER_CONFIG_EVENT = 'output_render_config'

/**
 * How one output window should render, as opposed to *what* it should
 * render.
 *
 * A separate channel from `OUTPUT_STATE_EVENT`, deliberately. Globe
 * state and window configuration change for different reasons, on
 * different schedules, and land on different things: state drives the
 * shader's uniforms and the decoder, config drives the renderer's
 * framebuffer and a DOM overlay. Folding these into `GlobeState` would
 * put a window setting inside the structure the aggregator diffs and
 * sequences — paying coalescing and `seq` for values that are
 * last-write-wins by nature, and making a per-output setting part of a
 * type whose whole point is that it describes one globe.
 *
 * No `seq`, for that reason: there is no ordering hazard in a setting
 * whose latest value is the only one that matters, and inventing one
 * would imply a guarantee this channel does not need.
 */
export interface OutputRenderConfig {
  /** Snapped to `FRAMEBUFFER_WIDTHS` by the output; height is derived. */
  framebufferWidth: number
  /** Whether to draw the debug HUD over the projection. */
  debugOverlay: boolean
  /**
   * Show the calibration test pattern **instead of** whatever this
   * output is mirroring (rung 14b).
   *
   * It rides this channel rather than `GlobeState` for the reason the
   * channel exists: it is a property of one *window*, and calibration
   * is done one sphere at a time — a rig with four outputs is four
   * differently-mounted spheres, and putting a pattern on all of them
   * to align one is the opposite of what the operator asked for.
   * Routing it through the mirrored `dataset` would do exactly that,
   * and would also replace the control window's own globe, which is
   * where the operator is reading the rotation they are turning.
   *
   * Instead-of rather than over: a pattern is for checking *geometry*,
   * and a graticule composited over a dataset leaves neither legible.
   */
  calibration: boolean
  /**
   * A `projector-warp` window's meshes and where each goes (rung 16), or
   * `null` — which that window renders as nothing, and says so. Every
   * other mode ignores it.
   *
   * On this channel rather than in `GlobeState` for the channel's own
   * reason: it belongs to one window, and a rig's calibration is not a
   * fact about the globe. Resent whole on every `output_ready` and every
   * health-check resync, never in the heartbeat — so `id` exists, and the
   * output compares it to decide whether its geometry needs rebuilding.
   */
  warp: OutputWarpSet | null
  /**
   * The display gamma a warp's blend weight is applied through (rung 16,
   * convention 2). sphere-sim's weight multiplies radiance in *linear
   * light*, and this window writes display-space values, so the weight
   * reaches a pixel as `c · w^(1/γ)` — multiplying the encoded value
   * instead leaves a band at 44% of target along every seam. Per output
   * rather than per projector, because one rig's projectors are normally
   * one model. Every other mode ignores it.
   */
  blendGamma: number
}

/**
 * One mesh of a warp set as it crosses: the file's own text, and the
 * rect of the framebuffer it goes in.
 *
 * The text rather than a parse, because the output re-reads it through
 * the same fail-closed parser the import used — one parser, one set of
 * refusals, wherever a set is read. Structurally identical to
 * `projectorWarp`'s `WarpSetEntry`, deliberately, so the output hands
 * these straight to `placeWarpSet`; `protocol.test.ts` proves the two
 * stay assignable both ways, and it is declared here rather than
 * imported because a contract must not depend on one of its consumers.
 */
export interface OutputWarpMesh {
  id: string
  /** Fractions of the framebuffer, origin bottom-left — GL's, and SOS's. */
  viewport: { x: number; y: number; w: number; h: number }
  text: string
}

/**
 * What a warp set's `u` and `v` address, as a bundle's `layout.json`
 * states it (sphere-sim#52): the equirectangular map with the sphere's
 * mechanical rotation already taken off `u`, or a model's own UV set,
 * which has no rotation. A pair rather than two fields, so the type
 * admits a sphere with a number and a mesh with `null` and nothing in
 * between — sphere-sim's own `WarpTexture`, restated.
 */
export type WarpTexture =
  | { readonly surface: 'sphere'; readonly rotationOffsetDeg: number }
  | { readonly surface: 'mesh'; readonly rotationOffsetDeg: null }

export interface OutputWarpSet {
  /** The set's content id — `warpImport.warpSetId`, and its storage key. */
  id: string
  /**
   * What the meshes address, when the bundle said; `null` when nothing
   * did — loose `.data` files, or a bundle exported before its layout.
   * It changes no pixel, since the rotation is already in the meshes, and
   * the output ignores it. It rides the set because the set is the one
   * record of what an output holds, and the panel shows it beside the
   * content rotation, so an operator can see what was baked in rather
   * than enter it a second time. Not part of the content id, for the same
   * reason: two sets that draw the same are the same set.
   */
  texture: WarpTexture | null
  meshes: OutputWarpMesh[]
}

/**
 * Whether a string can be a warp set's content id: sixteen lowercase hex
 * digits, which is what `warpSetId` writes. Checked wherever an id is
 * read from outside — a stored reference, a storage key — so a hand-edited
 * value cannot address a key the import never wrote.
 */
export function isWarpSetId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)
}

/**
 * The display gamma a warp's blend weight is decoded and re-encoded
 * through when nobody has said otherwise. Here rather than beside
 * `blendFactor` because both ends need it: the manager seeds a record
 * with it and the output applies it. sphere-sim classes its photometry
 * provisional, which is why this is a field at all.
 */
export const DEFAULT_BLEND_GAMMA = 2.2

/**
 * Whether a value can be a blend gamma: a finite number above zero, and
 * no more than 10 — past which the weight is all but ignored and the
 * value is more likely a slip than a calibration. Narrowing, for a value
 * read from outside; `blendFactor` falls back to the default for
 * anything else rather than drawing black.
 */
export function isBlendGamma(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10
}

/**
 * What an output renders at before anyone has said otherwise.
 *
 * The one function in this module, and it earns the exception: both
 * ends need these defaults — the manager to seed a new output's record,
 * the output to have something to render with while the handshake is in
 * flight — and two copies of a two-field literal is exactly the drift a
 * shared contract exists to prevent. It builds a fresh object rather
 * than exporting a shared one, because a module-scoped default that a
 * caller mutates in place is a default that silently changes for
 * everyone (the aliasing `outputInitialState` guards against with
 * `IDENTITY_PARAMS`).
 *
 * It matters that the default is not "nothing": an output that rendered
 * at no resolution until a config arrived would show a black window for
 * the length of the handshake, and black on an output is the one thing
 * indistinguishable from a real failure.
 */
export function defaultRenderConfig(): OutputRenderConfig {
  return {
    framebufferWidth: DEFAULT_FRAMEBUFFER_WIDTH,
    debugOverlay: false,
    calibration: false,
    warp: null,
    blendGamma: DEFAULT_BLEND_GAMMA,
  }
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
 *
 * Generic over the state for the same reason `GlobeState` is: the
 * aggregator produces these carrying shared state, the manager
 * re-states each one per output, and only the second kind reaches a
 * window. Typing both as one shape would let an unprojected message be
 * emitted — an output receiving the operator's raw camera and no mode
 * at all, which it has no way to render and no way to complain about.
 */
export interface GlobeStateMessage<S> {
  seq: number
  /** `true` → `state` is complete; `false` → only the keys present
   *  have changed. */
  full: boolean
  state: S | Partial<S>
}

/** Aggregator → manager. Carries the shared view; never emitted. */
export type SharedStateMessage = GlobeStateMessage<MirroredGlobeState>

/** Manager → output, over `OUTPUT_STATE_EVENT`. */
export type OutputStateMessage = GlobeStateMessage<OutputGlobeState>

/**
 * Narrowing helper — a full message carries the complete state.
 *
 * Generic over the state, so it serves both directions: the manager
 * narrows a `SharedStateMessage` from the aggregator, an output
 * narrows the `OutputStateMessage` it received. `full` describes the
 * envelope, not what is in it.
 */
export function isFullState<S>(
  msg: GlobeStateMessage<S>,
): msg is GlobeStateMessage<S> & { full: true; state: S } {
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
/**
 * Manager → one output: *are you still there, and please say so.*
 *
 * The boot scan for orphaned windows (`docs/MULTI_MONITOR_PLAN.md` §3
 * "Failure recovery", case 6). A control window whose webview reloaded
 * or crashed leaves its `output-*` windows alive and rendering, with a
 * fresh manager that has never heard of them — so the manager finds
 * them with `existingOutputs()` and pokes each one here.
 *
 * **It carries nothing, and the reply is `output_ready`, not a
 * dedicated pong.** Both choices are the same choice: an output that
 * re-announces is served by the one path that already serves a first
 * announcement and a health-check ping, so a reattached window gets its
 * render config before its first snapshot exactly like every other
 * window does. A bespoke reply would need a second serve path, and the
 * config-before-state ordering in it is load-bearing.
 *
 * Targeted with `emitTo`, so the payload needs no label: the window
 * that receives it is the window being asked.
 *
 * The 60-second `IPC_ORPHAN_MS` is why this exists at all. Inside that
 * window an out-of-contact output is still pinging, and a fresh manager
 * hears it the moment it registers a record — no poke required. Past
 * it the output has stopped talking, by design, and nothing would ever
 * arrive again unless the manager spoke first.
 */
export const OUTPUT_REATTACH_EVENT = 'output_reattach'

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

/** The output's own stream died: it would not load while still the
 *  dataset asked for, or hls.js spent its retries after it had
 *  (`datasetMirror`). Distinct from the link going quiet. The manager
 *  reports it as `output_failure` with `kind: 'hls-stalled'`, at most
 *  once per output per dataset. It does not badge it yet; the panel
 *  shows nothing for it. */
export interface OutputDatasetStalledEvent extends OutputEventBase {
  type: 'output_dataset_stalled'
  datasetId: string | null
}

/**
 * This window's WebGL context went away (rung 13, case 5).
 *
 * It exists because the manager has no other way to learn this. The
 * window is alive, the link is fine, the heartbeat is answered — and
 * the sphere is black. Every other failure signal the manager has is
 * an *absence*, and this one is the opposite: a healthy channel
 * reporting an unhealthy picture, which is exactly the case the
 * absence-based detectors are blind to.
 */
export interface OutputGpuLostEvent extends OutputEventBase {
  type: 'output_gpu_lost'
}

/**
 * A lost WebGL context came back.
 *
 * Deliberately **not** a claim that the picture did. Three rebuilds its
 * GL state on restore and re-uploads on the next draw, which for the
 * output's scene should be the whole of it — but that is read from
 * Three's source rather than observed on hardware, and the two states
 * are reported separately so the difference stays visible if it turns
 * out not to hold.
 */
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
  | OutputGpuLostEvent
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
 * How often a stale output pings while it waits to be heard.
 *
 * **Moved here from `linkWatchdog.ts`, where it was first written with
 * an argument that this slice falsified.** That argument was: only the
 * output sends these and the manager answers whatever arrives, so a
 * shared constant would imply a coupling that does not exist. True
 * until the Outputs panel needed a stale *badge* — because deciding
 * that an output has *stopped* complaining means knowing how long a
 * silence has to be before the last complaint is out of date, and that
 * is the ping cadence. A manager holding its own guess would flicker
 * the badge whenever the two numbers disagreed, which is precisely the
 * "both ends must agree" test this block exists for.
 *
 * Twice the broadcast tick: frequent enough that a manager which comes
 * back mid-window resyncs within a couple of seconds, sparse enough
 * that the whole stale period costs about 27 pings rather than 55.
 */
export const LINK_PING_INTERVAL_MS = 2000

/**
 * Silence after which the output considers itself orphaned and stops
 * pinging.
 *
 * It does **not** self-destruct — the sphere keeps showing content for
 * any visitor mid-session. It just stops phoning home and waits for the
 * manager's boot scan to re-establish contact.
 */
export const IPC_ORPHAN_MS = 60000
