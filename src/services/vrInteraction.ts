/**
 * VR controller interaction layer.
 *
 * Wires the two XR controllers' input events (trigger = `select`,
 * grip = `squeeze`, thumbstick via gamepad API) into the semantic
 * actions the scene cares about:
 *
 *   - Trigger-drag while pointing at the globe  → rotate the globe
 *   - Trigger-click on a HUD button             → fire the HUD action
 *   - Grip press on either controller           → exit VR
 *   - Thumbstick Y on either controller         → zoom the globe
 *
 * The module is intentionally decoupled from session management:
 * `vrSession.ts` calls `update()` every frame, and receives
 * `onExit()` when the user asks out. All scene/mesh references come
 * in through the context so this can be re-used for the multi-globe
 * Phase 2.5 work without changing its internals.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}.
 */

import type * as THREE from 'three'
import type { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js'
import type { VrHudAction, VrHudHandle } from './vrHud'
import type { VrBrowseAction, VrBrowseHandle } from './vrBrowse'
import type { VrPlacementHandle } from './vrPlacement'
import type { VrTourControlsAction, VrTourControlsHandle } from './vrTourControls'
import type { VrTourInteractiveAction, VrTourOverlayHandle } from './vrTourOverlay'
import { MAX_GLOBE_SCALE, MIN_GLOBE_SCALE } from './vrScene'
import { logger } from '../utils/logger'
import { emit } from '../analytics'
import type { VrGesture } from '../types'

/** Per-gesture rate cap. Tier B `vr_interaction` events fire once
 * per discrete gesture (drag release, pinch release, flick start,
 * thumbstick-zoom release, hud tap), but a user with twitchy
 * controllers can produce many in quick succession. Cap each
 * gesture type independently so a flurry of one type doesn't
 * starve the others off the wire. */
export const VR_INTERACTION_MAX_PER_MINUTE = 30
const VR_INTERACTION_WINDOW_MS = 60_000
const vrInteractionTimes = new Map<VrGesture, number[]>()

/** Emit a `vr_interaction` event if the per-gesture throttle
 * permits. Magnitude semantics vary per gesture (see emit sites)
 * but always rounded to 2 decimals so the wire stays narrow.
 *
 * Exported for tests; production callers should reach for it via
 * the gesture-specific emit sites in this file. */
export function emitVrInteraction(gesture: VrGesture, magnitude: number): void {
  const now = Date.now()
  let times = vrInteractionTimes.get(gesture)
  if (!times) {
    times = []
    vrInteractionTimes.set(gesture, times)
  }
  // Drop expired entries from the front of the window.
  const cutoff = now - VR_INTERACTION_WINDOW_MS
  while (times.length > 0 && times[0] < cutoff) times.shift()
  if (times.length >= VR_INTERACTION_MAX_PER_MINUTE) return
  times.push(now)
  emit({
    event_type: 'vr_interaction',
    gesture,
    magnitude: Math.round(magnitude * 100) / 100,
  })
}

/** Test-only — clears the throttle state so consecutive tests
 * don't leak emit counts between cases. */
export function __resetVrInteractionThrottleForTests(): void {
  vrInteractionTimes.clear()
}

/**
 * Strict payload-level equality for browse actions. The selectstart
 * / selectend click semantics require the "armed" action and the
 * action under the ray at release to match exactly — comparing
 * `kind` alone would fire the wrong dataset / category if the user
 * pressed on card A, slid to card B, and released. Kind-only
 * matching was the original Phase 3 stub; this tightens to per-
 * variant payload checks. `close` has no payload, so kind is enough.
 */
function browseActionsEqual(a: VrBrowseAction, b: VrBrowseAction): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'select' && b.kind === 'select') return a.datasetId === b.datasetId
  if (a.kind === 'category' && b.kind === 'category') return a.category === b.category
  return true // kind === 'close' — no payload to compare
}

/**
 * Thumbstick reading below this magnitude is treated as zero. Quest
 * thumbsticks rest slightly off-center; without a deadzone the globe
 * creeps when the user isn't touching anything.
 */
const THUMBSTICK_DEADZONE = 0.15

/**
 * Zoom rate at full-deflection — scale factor multiplier per second.
 *
 * At 2.5 it takes ~1 s at full thumbstick to cross half the
 * MIN→MAX range, which testers reported feels responsive without
 * being twitchy. The previous value of 1.3 took ~3.5 s for the same
 * range — called "slightly slow" on-headset.
 */
const ZOOM_RATE_PER_SECOND = 2.5

/**
 * Multiplier applied to every rotation delta (single-hand and
 * two-hand). On-headset feedback called the rotation "slow…
 * doesn't quite keep up with the controllers". The native rotation
 * rates are geometry-bound (surface-pinned) or input-bound
 * (rigid-body): both can produce sub-1:1 globe rotation per unit
 * of physical motion, which feels sluggish.
 *
 * 2.0 doubles the rotation produced per unit of input. Trade-off:
 * surface-pinning becomes approximate (the grab point drifts under
 * the ray during fast drags) but the rotation amount feels closer
 * to the user's expectation of "the globe matches my motion". If
 * 2.0 still feels slow, try 3.0; if it overshoots, drop to 1.5.
 */
const ROTATION_SENSITIVITY = 2.0

/**
 * Inertia parameters — match the 2D MapLibre "flick the globe and it
 * keeps spinning" feel.
 *
 * - `MIN_INERTIA_SPEED`: kick-off threshold (rad/s). Slow drags below
 *   this produce no inertia (no annoying micro-spins after a careful
 *   release). Also serves as the stop threshold — inertia ends when
 *   decayed velocity drops below it.
 * - `INERTIA_TIME_CONSTANT`: exponential decay τ in seconds. Velocity
 *   decays to 37 % at 1τ, 13 % at 2τ, 5 % at 3τ.
 * - `VELOCITY_SMOOTHING_ALPHA`: how much the per-frame measured
 *   velocity contributes to the running average. Lower = more
 *   smoothing, less jitter, but also more lag in capturing a flick.
 *
 * Tuning history:
 *   - τ=1.5 s, min=0.5 → spins lasted ~3.5 s. On-headset feedback:
 *     "stops should be a little snappier".
 *   - τ=0.7 s, min=1.0 → confident flicks last ~1 s, casual drags
 *     decay almost immediately. Current values.
 */
const MIN_INERTIA_SPEED = 1.0
const INERTIA_TIME_CONSTANT = 0.7
const VELOCITY_SMOOTHING_ALPHA = 0.4

/**
 * Length of the visible controller ray in metres. Matches the
 * Three.js WebXR examples' convention.
 */
const RAY_LENGTH = 5

export interface VrInteractionContext {
  scene: THREE.Scene
  /** Primary globe — scene slot 0. Drives rotation + surface-pinned raycast. */
  globe: THREE.Mesh
  /**
   * Every globe in the current layout (primary + secondaries). Used
   * for multi-globe hit-testing so grab/rotate picks up whichever
   * globe the controller is pointing at — the surface-pinned drag
   * math needs the hit globe's position as the pivot. For a 1-globe
   * session this is just `[globe]`. Function (not a snapshot) so
   * panel-count changes mid-session are reflected without
   * re-creating the interaction handle.
   */
  getAllGlobes: () => THREE.Mesh[]
  hud: VrHudHandle
  /** In-VR dataset browse panel. */
  browse: VrBrowseHandle
  /** In-VR tour control strip — visible only while a tour is active. */
  tourControls: VrTourControlsHandle
  /** Tour overlay manager — exposes interactive meshes (currently question panels) for controller raycast. */
  tourOverlay: VrTourOverlayHandle
  /** AR-only spatial placement. Null in VR mode or when hit-test isn't available. */
  placement: VrPlacementHandle | null
  renderer: THREE.WebGLRenderer
  /** Fired when the user taps a HUD button. */
  onHudAction: (action: VrHudAction) => void
  /** Fired when the user interacts with the browse panel (close / select dataset). */
  onBrowseAction: (action: VrBrowseAction) => void
  /** Fired when the user taps a tour-control button (prev/play-pause/next/stop). */
  onTourAction: (action: VrTourControlsAction) => void
  /** Fired when the user taps the floating Place button — caller toggles Place mode. */
  onPlaceButton: () => void
  /** Fired when the user pulls trigger while in Place mode — caller anchors the globe. */
  onPlaceConfirm: () => void
  /** Fired when the user squeezes the grip — caller ends the session. */
  onExit: () => void
  /**
   * Fired when globe manipulation settles: trigger-drag release
   * (to idle, not inertia), two-hand pinch release, flick-inertia
   * decay stop, or thumbstick-zoom release. Caller computes the
   * gaze-to-globe lat/lon and emits `camera_settled` with
   * `projection='vr'|'ar'`. The per-session throttle in
   * `analytics/camera.ts` rate-limits the emit across 2D + VR.
   */
  onCameraSettled?: () => void
}

export interface VrInteractionHandle {
  /** Drive per-frame polling (thumbstick zoom, drag tracking). */
  update(deltaSeconds: number): void
  dispose(): void
}

/**
 * Rotation mode — mutually-exclusive union of the three states the
 * globe can be in based on how many triggers are on the globe:
 *
 * - `idle` — no rotation happening
 * - `single` — one trigger on globe; surface-pinned raycast drag.
 *   Lateral controller motion rotates the globe because the grab
 *   point stays pinned under the current ray. Matches MapLibre's
 *   "drag the surface under your cursor" feel.
 * - `two-hand` — both triggers on globe; mobile-style pinch +
 *   rigid-body rotate. Distance between controllers scales the
 *   globe; orientation is built from the axis between the hands
 *   plus the average of their up-vectors, giving a full 3-DoF
 *   rotation that includes wrist-roll / twist around the
 *   connecting axis. See `computeTwoHandOrientation` for the math.
 *
 * Transitions recapture the baseline so switching modes never
 * introduces drift. Thumbstick zoom is active in `idle` + `single`
 * but suppressed in `two-hand` because pinch already handles zoom
 * and the two inputs would fight.
 */
type RotationMode =
  | { kind: 'idle' }
  | {
      kind: 'single'
      index: 0 | 1
      /** The specific globe mesh the user grabbed — may be any globe in the arc. */
      grabbedGlobe: THREE.Mesh
      /** Unit vector from globe center to grabbed surface point, world-space. */
      worldGrabDir: THREE.Vector3
      /** Globe quaternion when the single drag began. */
      globeStartQuat: THREE.Quaternion
    }
  | {
      kind: 'two-hand'
      /**
       * Orientation of the virtual "rigid body" defined by the two
       * controllers at gesture start. Derived from the axis between
       * them (primary direction) + the average of each controller's
       * up-vector projected onto the perpendicular plane. Capturing
       * this — instead of just the axis direction — means wrist
       * twists around the connecting axis also rotate the globe,
       * which matches the user's mental model of "grabbing the
       * globe with both hands".
       */
      startOrientation: THREE.Quaternion
      /** Distance between controllers when the two-hand gesture began. */
      startDistance: number
      /** Globe uniform scale when the two-hand gesture began. */
      startScale: number
      /** Globe quaternion when the two-hand gesture began. */
      globeStartQuat: THREE.Quaternion
    }
  | {
      kind: 'inertia'
      /**
       * Angular velocity in world space — direction = rotation axis,
       * magnitude = radians per second. Decays exponentially each
       * frame; mode reverts to `idle` when speed drops below
       * `MIN_INERTIA_SPEED`. Cancelled instantly by any new trigger
       * press that hits the globe.
       */
      velocity: THREE.Vector3
    }

/**
 * Build a line segment extending from the controller along -Z. The
 * line is full-length (RAY_LENGTH) by default; the per-frame
 * `updateRayVisuals()` shortens it to the raycast hit distance via
 * `line.scale.z` so it visually "lands" on whatever the user is
 * pointing at, rather than poking through.
 */
function buildRayLine(THREE_: typeof THREE): THREE.Line {
  const geometry = new THREE_.BufferGeometry().setFromPoints([
    new THREE_.Vector3(0, 0, 0),
    new THREE_.Vector3(0, 0, -RAY_LENGTH),
  ])
  const material = new THREE_.LineBasicMaterial({
    color: 0x4da6ff, // --color-accent
    transparent: true,
    opacity: 0.6,
  })
  const line = new THREE_.Line(geometry, material)
  line.name = 'vr-controller-ray'
  return line
}

/**
 * Floating button-affordance label sprite that sits above the
 * controller. Sprites always face the camera, so the text stays
 * readable no matter how the user holds the controller.
 *
 * Phase 2.2 basic version: always-on labels for the three core
 * inputs, hand-tuned for Quest Touch position. Future polish
 * (fade-on-idle, mode-sensitive hints, per-controller-type
 * positioning via XR Input Profiles) is planned — see
 * VR_INVESTIGATION_PLAN.md.
 */
function buildControllerTooltip(THREE_: typeof THREE): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('[VR tooltip] 2D canvas context unavailable')

  // Subtle translucent backplate — helps readability against both
  // dark VR void and bright AR passthrough backgrounds without
  // dominating the visual.
  ctx.fillStyle = 'rgba(13, 13, 18, 0.55)'
  // Rounded-rectangle shape for a polished look. Fall back to
  // plain rect if the Path2D helper is unavailable.
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(8, 8, 496, 240, 24)
    ctx.fill()
  } else {
    ctx.fillRect(8, 8, 496, 240)
  }

  // Thin accent border
  ctx.strokeStyle = 'rgba(77, 166, 255, 0.45)' // --color-accent
  ctx.lineWidth = 2
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(8, 8, 496, 240, 24)
    ctx.stroke()
  } else {
    ctx.strokeRect(8, 8, 496, 240)
  }

  // Label lines — matching the three input affordances exposed by
  // vrInteraction today.
  ctx.fillStyle = '#e8eaf0' // --color-text
  ctx.font = '500 38px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('Trigger: rotate', 256, 58)
  ctx.fillText('Grip: exit', 256, 128)
  ctx.fillText('Thumbstick: zoom', 256, 198)

  const texture = new THREE_.CanvasTexture(canvas)
  texture.colorSpace = THREE_.SRGBColorSpace
  texture.minFilter = THREE_.LinearFilter
  texture.magFilter = THREE_.LinearFilter

  const material = new THREE_.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE_.Sprite(material)
  // 14 cm wide × 7 cm tall (matches 2:1 canvas aspect). Large enough
  // to read comfortably, small enough to not dominate peripheral view.
  sprite.scale.set(0.14, 0.07, 1)
  // 13 cm above the grip — safely clear of the controller body but
  // still close enough to feel attached.
  sprite.position.set(0, 0.13, 0)
  sprite.renderOrder = 12 // above the ray dot (11)
  return sprite
}

export function createVrInteraction(
  THREE_: typeof THREE,
  ControllerModelFactory: typeof XRControllerModelFactory,
  ctx: VrInteractionContext,
): VrInteractionHandle {
  const raycaster = new THREE_.Raycaster()
  // Scratch vectors + quaternions reused across frames. The VR
  // render loop calls these helpers 90+ times/sec; allocating new
  // Vector3 / Quaternion instances every call shows up as GC churn
  // on-device. Keep a small pool and `.set()` / `.copy()` them.
  const rayOrigin = new THREE_.Vector3()
  const rayDirection = new THREE_.Vector3()
  const scratchQuat = new THREE_.Quaternion()
  const scratchVec3A = new THREE_.Vector3()
  const scratchVec3B = new THREE_.Vector3()
  const scratchVec3C = new THREE_.Vector3()
  const scratchVec3D = new THREE_.Vector3()
  const scratchMatrix4 = new THREE_.Matrix4()
  const scratchQuatB = new THREE_.Quaternion()
  /** Quaternion that computeTwoHandOrientation writes into when called per-frame. */
  const twoHandOrientationScratch = new THREE_.Quaternion()
  /** Axis scratch for updateInertia — avoids a Vector3 alloc every inertia tick. */
  const inertiaAxisScratch = new THREE_.Vector3()

  // One controller per hand. Three.js assigns indices 0 and 1; the
  // mapping to left/right is set by the platform at runtime. For MVP
  // we don't care which is which — either trigger rotates, either
  // grip exits, either thumbstick zooms.
  const controllers: THREE.XRTargetRaySpace[] = []
  const rayLines: THREE.Line[] = []
  /**
   * Per-controller "is this trigger actively rotating the globe?".
   * True while a trigger was pressed while pointing at the globe
   * and has not yet been released. Separate from HUD arming so that
   * pointing at HUD buttons doesn't disturb rotation state.
   */
  const triggersOnGlobe: boolean[] = [false, false]
  /**
   * Whether each controller's most recent selectstart hit the HUD
   * instead of the globe. We only fire a HUD action on `selectend`
   * to match the DOM `click` model (press + release on the same
   * button).
   */
  const hudArmed: (VrHudAction | null)[] = [null, null]
  /** Per-controller "trigger pressed on the Place button" flag (DOM click semantics). */
  const placeArmed: boolean[] = [false, false]
  /** Per-controller browse action armed on selectstart (DOM click semantics). */
  const browseArmed: (VrBrowseAction | null)[] = [null, null]
  /** Per-controller tour-control action armed on selectstart (DOM click semantics). */
  const tourArmed: (VrTourControlsAction | null)[] = [null, null]
  /** Per-controller tour-overlay interactive action armed on selectstart (question answer / continue). */
  const tourOverlayArmed: (VrTourInteractiveAction | null)[] = [null, null]

  /**
   * Drag-to-reposition state. Populated on `selectstart` when the
   * ray hits a world-mode text / popup / image overlay (see
   * `tourOverlay.getDraggableMeshes`) and cleared on `selectend`.
   * While active, the per-frame `update` reads the controller's
   * world pose and writes a new custom offset onto the overlay so
   * the panel "follows" the controller like a held card.
   *
   * Stored offset is in controller-local coords at grab time,
   * rotated back to world by the current controller quaternion
   * each frame. That way the panel maintains its initial distance
   * + angle from the controller — feels natural whether the user
   * is pushing the panel away, pulling it in, or rotating the
   * wrist.
   */
  type OverlayDragState =
    | { kind: 'idle' }
    | {
        kind: 'overlay'
        controllerIndex: 0 | 1
        overlayId: string
        /** Offset from controller origin to panel center, in controller-local axes, captured at grab. */
        initialOffsetLocal: THREE.Vector3
      }
  let overlayDrag: OverlayDragState = { kind: 'idle' }
  /** Scratch vectors / quat reused each drag-update frame. */
  const dragScratchPos = new THREE_.Vector3()
  const dragScratchQuat = new THREE_.Quaternion()
  const dragScratchOffset = new THREE_.Vector3()
  /** Per-controller "ray is currently on the browse panel" — drives thumbstick scroll. */
  const rayOnBrowse: boolean[] = [false, false]
  /**
   * Per-controller reference to the globe mesh that was grabbed on
   * selectstart. Passed to captureSingleMode so the surface-pinned
   * rotation math uses the correct globe center — critical when the
   * user grabs a secondary globe at a different arc position.
   */
  const lastGrabbedGlobe: (THREE.Mesh | null)[] = [null, null]
  /** Current rotation mode — recomputed on every trigger state change. */
  let rotationMode: RotationMode = { kind: 'idle' }

  /**
   * Running track of the globe's angular velocity during single +
   * two-hand modes. We measure the actual quaternion delta produced
   * by each frame's rotation update (rather than deriving from
   * controller motion) so the tracker is agnostic to single vs.
   * two-hand math — both feed the same source.
   *
   * On release (mode → idle), if the smoothed velocity exceeds
   * `MIN_INERTIA_SPEED`, we transition to inertia mode instead and
   * the globe keeps spinning with exponential decay. This mirrors
   * the 2D MapLibre flick-to-spin behaviour requested by testers.
   */
  const velocityTracker = {
    /** Globe quaternion at the previous tick — used to compute deltas. */
    prevQuat: new THREE_.Quaternion(),
    /** Smoothed angular velocity (axis * rad/s). */
    velocity: new THREE_.Vector3(),
    /** True while we're actively tracking; false in idle / inertia. */
    active: false,
  }

  /**
   * Update `raycaster` so its ray matches the given controller's
   * world-space pose. Returns true (always) so callers can chain.
   */
  function setRaycasterFromController(controller: THREE.XRTargetRaySpace): boolean {
    controller.getWorldPosition(rayOrigin)
    // Controllers point down their local -Z axis. Rotating the
    // unit -Z vector by the controller's world quaternion gives us
    // the forward direction in world space. Reuses scratchQuat to
    // avoid per-call allocation — this runs 90+ times/sec in VR.
    controller.getWorldQuaternion(scratchQuat)
    rayDirection.set(0, 0, -1).applyQuaternion(scratchQuat)
    raycaster.ray.origin.copy(rayOrigin)
    raycaster.ray.direction.copy(rayDirection)
    return true
  }

  /**
   * Resolve what the controller is pointing at. Order matters: the
   * HUD is drawn on top of the globe (renderOrder + depthTest:false)
   * so from the user's visual perspective it should always win ties.
   *
   * Any globe hit (primary or secondary) returns `'globe'` with the
   * mesh reference — all globes rotate in lockstep, so grabbing any
   * of them initiates the same surface-pinned drag.
   */
  /**
   * Equality check for tour-overlay interactive actions — used by
   * the selectend "still armed on the same thing?" guard. Actions
   * discriminate by `kind`, then by `overlayId`, and for answer
   * hits also by `index`.
   */
  function tourOverlayActionsEqual(
    a: VrTourInteractiveAction,
    b: VrTourInteractiveAction,
  ): boolean {
    if (a.kind !== b.kind) return false
    if (a.overlayId !== b.overlayId) return false
    if (a.kind === 'question-answer' && b.kind === 'question-answer') {
      return a.index === b.index
    }
    return true
  }

  function pickHit(controller: THREE.XRTargetRaySpace):
    | { kind: 'hud'; action: VrHudAction }
    | { kind: 'browse'; action: VrBrowseAction }
    | { kind: 'browse-scroll' }
    | { kind: 'tour-control'; action: VrTourControlsAction }
    | { kind: 'tour-overlay'; action: VrTourInteractiveAction }
    | { kind: 'overlay-drag'; overlayId: string; mesh: THREE.Mesh }
    | { kind: 'place-button' }
    | { kind: 'globe'; mesh: THREE.Mesh }
    | null {
    setRaycasterFromController(controller)

    const hudHits = raycaster.intersectObject(ctx.hud.mesh, false)
    if (hudHits.length > 0 && hudHits[0].uv) {
      const action = ctx.hud.hitTest({ x: hudHits[0].uv.x, y: hudHits[0].uv.y })
      if (action) return { kind: 'hud', action }
    }

    // Browse panel — checked before globe so the user can interact
    // with the panel even when it overlaps the globe from their angle.
    if (ctx.browse.isVisible()) {
      const browseHits = raycaster.intersectObject(ctx.browse.mesh, false)
      if (browseHits.length > 0 && browseHits[0].uv) {
        const action = ctx.browse.hitTest({
          x: browseHits[0].uv.x,
          y: browseHits[0].uv.y,
        })
        if (action) return { kind: 'browse', action }
        // Ray hit the panel but not a button/card — still counts as
        // a browse hit for scroll purposes.
        return { kind: 'browse-scroll' }
      }
    }

    // Tour controls — checked before place button so the strip is
    // tappable even if the place reticle happens to overlap it in
    // the user's view. Gated by `isVisible()` so non-tour sessions
    // skip the extra raycast entirely.
    if (ctx.tourControls.isVisible()) {
      const tourHits = raycaster.intersectObject(ctx.tourControls.mesh, false)
      if (tourHits.length > 0 && tourHits[0].uv) {
        const action = ctx.tourControls.hitTest({
          x: tourHits[0].uv.x,
          y: tourHits[0].uv.y,
        })
        if (action) return { kind: 'tour-control', action }
      }
    }

    // Tour overlay interactive surfaces — currently question panels
    // with answer / Continue regions. Checked after tourControls so
    // an answer button that visually stacks near the strip still
    // goes to the strip (defensive — they're spatially separated in
    // practice). Short-circuits when no interactive overlays exist.
    const interactiveMeshes = ctx.tourOverlay.getInteractiveMeshes()
    if (interactiveMeshes.length > 0) {
      const overlayHits = raycaster.intersectObjects(interactiveMeshes, false)
      if (overlayHits.length > 0 && overlayHits[0].uv) {
        const hitMesh = overlayHits[0].object as THREE.Mesh
        const action = ctx.tourOverlay.hitTestInteractive(hitMesh, {
          x: overlayHits[0].uv.x,
          y: overlayHits[0].uv.y,
        })
        if (action) return { kind: 'tour-overlay', action }
      }
    }

    // Draggable tour overlay panels (world-mode text / popup /
    // image). Checked AFTER interactive meshes so a question panel
    // still routes its answer-button hits first; `getDraggableMeshes`
    // already excludes questions to prevent overlap. Ordered before
    // the place button and globes so a trigger on an overlay pans
    // into drag mode rather than falling through to a globe grab.
    const draggableMeshes = ctx.tourOverlay.getDraggableMeshes()
    if (draggableMeshes.length > 0) {
      const dragHits = raycaster.intersectObjects(draggableMeshes, false)
      if (dragHits.length > 0) {
        const hitMesh = dragHits[0].object as THREE.Mesh
        const overlayId = (hitMesh.userData as { overlayId?: string }).overlayId
        if (overlayId) {
          return { kind: 'overlay-drag', overlayId, mesh: hitMesh }
        }
      }
    }

    // Place button (AR-only, hit-test-supported sessions). Same
    // depth-overrides + renderOrder strategy as the HUD so it
    // always wins ties with the globe behind it.
    const place = ctx.placement
    if (place && place.placeButtonMesh.visible) {
      const placeHits = raycaster.intersectObject(place.placeButtonMesh, false)
      if (placeHits.length > 0 && placeHits[0].uv) {
        const action = place.hitTestButton({
          x: placeHits[0].uv.x,
          y: placeHits[0].uv.y,
        })
        if (action) return { kind: 'place-button' }
      }
    }

    // Raycast against every globe in the layout. All globes rotate
    // in lockstep (scene.update copies the primary's quaternion to
    // all secondaries), so we don't need to distinguish which globe
    // was hit — any grab initiates the same surface-pinned rotation.
    const allGlobes = ctx.getAllGlobes()
    const globeHits = raycaster.intersectObjects(allGlobes, false)
    if (globeHits.length > 0) {
      return { kind: 'globe', mesh: globeHits[0].object as THREE.Mesh }
    }

    return null
  }

  /**
   * Snapshot the single-drag baseline for the given controller.
   * Raycasts the controller against the globe; if the ray misses
   * (user's aim slipped during a mode transition) we fall back to
   * `idle` and the user can re-grab. Returns the new mode.
   */
  function captureSingleMode(index: 0 | 1, targetGlobe?: THREE.Mesh): RotationMode {
    const controller = controllers[index]
    setRaycasterFromController(controller)
    // If a specific globe was identified by pickHit, raycast against
    // it directly. Otherwise fall back to all globes (e.g. during
    // mode re-evaluation after the other trigger releases).
    const globe = targetGlobe ?? ctx.globe
    const hits = targetGlobe
      ? raycaster.intersectObject(targetGlobe, false)
      : raycaster.intersectObjects(ctx.getAllGlobes(), false)
    if (hits.length === 0 || !hits[0].point) return { kind: 'idle' }
    const hitGlobe = (hits[0].object as THREE.Mesh) ?? globe
    return {
      kind: 'single',
      index,
      grabbedGlobe: hitGlobe,
      worldGrabDir: hits[0].point.clone().sub(hitGlobe.position).normalize(),
      globeStartQuat: ctx.globe.quaternion.clone(),
    }
  }

  /**
   * Build the quaternion of the virtual "rigid body" the two
   * controllers define at their current poses. The frame is:
   *
   *   X axis — along the connecting axis (controller 0 → 1)
   *   Y axis — average of each controller's world +Y, projected onto
   *            the plane perpendicular to X (captures wrist rolls)
   *   Z axis — derived via cross product for right-handedness
   *
   * Fallback: if the averaged up-vector is parallel to the axis
   * (hands perfectly side-by-side with both aligned), pick a
   * perpendicular from world-up; if that too is parallel (axis
   * vertical), fall back to world-right. Fallback paths still
   * produce a stable rotation because the ambiguity is around a
   * vertical axis, which matters less for globe manipulation.
   */
  /**
   * Build a world-space orientation quaternion from the two
   * controllers' current poses. Called from updateTwoHand() every
   * frame during a two-hand gesture, so this must not allocate —
   * uses only the closure-scoped scratch vectors / quaternions /
   * matrix declared above.
   *
   * @param out Target quaternion to write into. Callers who need
   *   a persistent copy (e.g. `captureTwoHandMode` storing the
   *   start orientation) pass a fresh Quaternion; per-frame
   *   callers pass a scratch.
   */
  function computeTwoHandOrientation(out: THREE.Quaternion): THREE.Quaternion {
    // pos0, pos1 → positions of both controllers in world space.
    const pos0 = scratchVec3A
    const pos1 = scratchVec3B
    controllers[0].getWorldPosition(pos0)
    controllers[1].getWorldPosition(pos1)

    // axis = unit vector from controller 0 → controller 1.
    const axis = scratchVec3C
    axis.copy(pos1).sub(pos0).normalize()

    // pos0 / pos1 no longer needed; reuse their slots as up0 / up1
    // (each controller's local +Y in world space).
    const up0 = pos0
    const up1 = pos1
    controllers[0].getWorldQuaternion(scratchQuat)
    up0.set(0, 1, 0).applyQuaternion(scratchQuat)
    controllers[1].getWorldQuaternion(scratchQuatB)
    up1.set(0, 1, 0).applyQuaternion(scratchQuatB)

    // avgUp = mean of both controller ups — the "which way is up"
    // for the virtual rigid body, including wrist-roll input.
    const avgUp = scratchVec3D
    avgUp.copy(up0).add(up1).multiplyScalar(0.5)

    // perpUp = component of avgUp perpendicular to the axis.
    // Remove the axis-parallel projection by subtracting
    // axis * (avgUp · axis). Reuses up0 as the projection scratch.
    const projection = up0
    projection.copy(axis).multiplyScalar(avgUp.dot(axis))
    const perpUp = up1
    perpUp.copy(avgUp).sub(projection)

    // Degenerate case: avgUp was parallel to axis. Fall back on
    // cross products against world-up then world-right.
    if (perpUp.lengthSq() < 0.001) {
      const worldAxis = scratchVec3A
      worldAxis.set(0, 1, 0)
      perpUp.crossVectors(axis, worldAxis)
      if (perpUp.lengthSq() < 0.001) {
        worldAxis.set(1, 0, 0)
        perpUp.crossVectors(axis, worldAxis)
      }
    }
    perpUp.normalize()

    // forward = axis × perpUp — completes the right-handed basis.
    const forward = scratchVec3D // reuse avgUp; no longer needed
    forward.crossVectors(axis, perpUp)

    scratchMatrix4.makeBasis(axis, perpUp, forward)
    return out.setFromRotationMatrix(scratchMatrix4)
  }

  /** Snapshot the two-hand baseline. Both controllers assumed on-globe. */
  function captureTwoHandMode(): RotationMode {
    const p0 = new THREE_.Vector3()
    const p1 = new THREE_.Vector3()
    controllers[0].getWorldPosition(p0)
    controllers[1].getWorldPosition(p1)
    const startDistance = p0.distanceTo(p1)
    // Guard against degenerate start distance (controllers coincident).
    // Fall back to idle; user can release and re-grab.
    if (startDistance < 0.001) return { kind: 'idle' }
    return {
      kind: 'two-hand',
      // Fresh quaternion — this is stored as the two-hand baseline
      // and needs to survive beyond the next frame's scratch reuse.
      startOrientation: computeTwoHandOrientation(new THREE_.Quaternion()),
      startDistance,
      startScale: ctx.globe.scale.x,
      globeStartQuat: ctx.globe.quaternion.clone(),
    }
  }

  /**
   * Rebuild `rotationMode` from the current `triggersOnGlobe` state.
   * Idempotent for mode kinds that are already correct — avoids
   * re-snapshotting on unrelated updates (e.g. HUD arming).
   *
   * On the rotation → idle transition, kicks off `inertia` mode if
   * the user was rotating fast enough at release. New presses on
   * the globe always cancel inertia (rotationMode becomes `single`
   * or `two-hand`, replacing the inertia state).
   */
  function reevaluateRotationMode(): void {
    const wasRotating =
      rotationMode.kind === 'single' || rotationMode.kind === 'two-hand'
    // Capture the SPECIFIC kind before the assignment below
    // overwrites it — needed to tag the Tier B vr_interaction event
    // with the right gesture (drag vs pinch).
    const wasTwoHand = rotationMode.kind === 'two-hand'
    const g0 = triggersOnGlobe[0]
    const g1 = triggersOnGlobe[1]
    if (g0 && g1) {
      if (rotationMode.kind !== 'two-hand') rotationMode = captureTwoHandMode()
    } else if (g0) {
      if (!(rotationMode.kind === 'single' && rotationMode.index === 0)) {
        rotationMode = captureSingleMode(0, lastGrabbedGlobe[0] ?? undefined)
      }
    } else if (g1) {
      if (!(rotationMode.kind === 'single' && rotationMode.index === 1)) {
        rotationMode = captureSingleMode(1, lastGrabbedGlobe[1] ?? undefined)
      }
    } else {
      // Releasing the last trigger. If the velocity tracker has a
      // significant signal, transition to inertia rather than
      // idle so the spin continues with decay.
      const releaseSpeed = velocityTracker.velocity.length()
      if (wasRotating && releaseSpeed > MIN_INERTIA_SPEED) {
        rotationMode = {
          kind: 'inertia',
          velocity: velocityTracker.velocity.clone(),
        }
        // Tier B: flick-to-spin started. Magnitude is the
        // initial angular speed in rad/s — surfaces "casual
        // tap" vs "vigorous flick" without leaking head pose.
        emitVrInteraction('flick_spin', releaseSpeed)
      } else {
        rotationMode = { kind: 'idle' }
        // Transitioned straight from rotating to idle — the user let
        // go without enough velocity for inertia. That's a settle.
        // Inertia → idle settles are emitted from the per-frame
        // update loop instead (when velocity decays below threshold).
        if (wasRotating) {
          ctx.onCameraSettled?.()
          // Tier B: rotation gesture released without a flick.
          // Magnitude is the velocity-tracker speed at release
          // (rad/s) rounded to 2 decimals — small for careful
          // panning, large for fast turns.
          emitVrInteraction(wasTwoHand ? 'pinch' : 'drag', releaseSpeed)
        }
      }
    }
  }

  function onSelectStart(index: 0 | 1): void {
    const controller = controllers[index]

    // Place mode short-circuits everything — trigger anywhere
    // confirms the placement at whatever the reticle currently
    // shows. Don't even bother with a raycast; just fire the
    // confirm callback. Globe-grab is suppressed during Place mode.
    if (ctx.placement?.isPlacing()) {
      ctx.onPlaceConfirm()
      return
    }

    const hit = pickHit(controller)
    if (!hit) return

    if (hit.kind === 'hud') {
      hudArmed[index] = hit.action
      return
    }

    if (hit.kind === 'browse') {
      browseArmed[index] = hit.action
      return
    }

    if (hit.kind === 'browse-scroll') {
      // Ray hit the panel body (not a button/card) — no action to arm.
      return
    }

    if (hit.kind === 'tour-control') {
      tourArmed[index] = hit.action
      return
    }

    if (hit.kind === 'tour-overlay') {
      tourOverlayArmed[index] = hit.action
      return
    }

    if (hit.kind === 'overlay-drag') {
      // Capture the current controller → panel offset in the
      // controller's local frame. Per-frame `update` applies the
      // current controller quaternion to this stored offset and
      // adds the controller world position, so the panel stays at
      // the same relative place as the user moves/rotates the
      // controller. Feels like "grabbing" the panel at its current
      // spot.
      const controller = controllers[index]
      controller.getWorldPosition(dragScratchPos)
      controller.getWorldQuaternion(dragScratchQuat)
      // offset_local = (panel_world - controller_world) rotated by
      // inverse-controller. Reuse scratch vectors to avoid GC.
      dragScratchOffset.copy(hit.mesh.position).sub(dragScratchPos)
      dragScratchQuat.invert()
      dragScratchOffset.applyQuaternion(dragScratchQuat)
      overlayDrag = {
        kind: 'overlay',
        controllerIndex: index,
        overlayId: hit.overlayId,
        // Clone — scratch is reused next frame, but our stored
        // offset needs to persist for the life of the drag.
        initialOffsetLocal: dragScratchOffset.clone(),
      }
      return
    }

    if (hit.kind === 'place-button') {
      placeArmed[index] = true
      return
    }

    // Any globe hit (primary or secondary) — flip this trigger's
    // rotation bit and capture which globe was grabbed so the
    // surface-pinned drag math uses the right center point.
    // All globes rotate in lockstep (scene.update copies the
    // primary's quaternion), so grabbing any globe works the same.
    lastGrabbedGlobe[index] = hit.mesh
    triggersOnGlobe[index] = true
    reevaluateRotationMode()
  }

  function onSelectEnd(index: 0 | 1): void {
    // HUD actions fire on release (mirrors DOM click semantics).
    if (hudArmed[index]) {
      const controller = controllers[index]
      const hit = pickHit(controller)
      // Only fire if the user is still pointing at the same action
      // as when they pressed — otherwise they slid off the button
      // and cancelled.
      if (hit?.kind === 'hud' && hit.action === hudArmed[index]) {
        ctx.onHudAction(hudArmed[index]!)
        // Tier B: HUD button activated. Magnitude is always 1 —
        // the event is presence/absence, not intensity.
        emitVrInteraction('hud_tap', 1)
      }
      hudArmed[index] = null
    }
    // Browse panel: same click semantics — fire only if still pointing
    // at the same action on release.
    if (browseArmed[index]) {
      const controller = controllers[index]
      const hit = pickHit(controller)
      if (hit?.kind === 'browse') {
        const armed = browseArmed[index]!
        if (browseActionsEqual(armed, hit.action)) {
          ctx.onBrowseAction(hit.action)
        }
      }
      browseArmed[index] = null
    }
    // Tour controls: same press-and-release-on-same-target click semantics.
    if (tourArmed[index]) {
      const controller = controllers[index]
      const hit = pickHit(controller)
      if (hit?.kind === 'tour-control' && hit.action === tourArmed[index]) {
        ctx.onTourAction(tourArmed[index]!)
      }
      tourArmed[index] = null
    }
    // Tour overlay interactions (question answers / continue).
    if (tourOverlayArmed[index]) {
      const controller = controllers[index]
      const hit = pickHit(controller)
      const armed = tourOverlayArmed[index]!
      if (hit?.kind === 'tour-overlay' && tourOverlayActionsEqual(hit.action, armed)) {
        ctx.tourOverlay.activateInteractive(armed)
      }
      tourOverlayArmed[index] = null
    }
    // Overlay drag end — release the held panel. The per-frame
    // `update` has been writing customWorldOffset via
    // `setOverlayCustomOffset`, so the panel stays at its last
    // drag position. No explicit "commit" action — the last
    // update's offset IS the committed state.
    if (overlayDrag.kind === 'overlay' && overlayDrag.controllerIndex === index) {
      overlayDrag = { kind: 'idle' }
    }
    // Place button: same press-and-release-on-same-target click semantics.
    if (placeArmed[index]) {
      const controller = controllers[index]
      const hit = pickHit(controller)
      if (hit?.kind === 'place-button') {
        ctx.onPlaceButton()
      }
      placeArmed[index] = false
    }
    if (triggersOnGlobe[index]) {
      triggersOnGlobe[index] = false
      lastGrabbedGlobe[index] = null
      reevaluateRotationMode()
    }
  }

  function onSqueezeStart(): void {
    // Grip = exit. Either controller does it.
    logger.info('[VR] Grip pressed — exiting VR session')
    ctx.onExit()
  }

  // --- Wire up both controllers ---

  // One factory shared between both controllers; the addon caches
  // model fetches internally so each controller doesn't re-download.
  const modelFactory = new ControllerModelFactory()

  // Per-controller grip spaces (where the controller body sits) and
  // small white dots placed at the raycast hit point each frame.
  // Grip space is distinct from the target-ray space (`getController`)
  // — the ray fires from a sensible "pointer" origin while the grip
  // tracks the physical controller body, which is what we want to
  // attach the visual model to.
  const grips: THREE.XRGripSpace[] = []
  const dots: THREE.Mesh[] = []
  // Button-affordance tooltip sprites attached to each grip — tracked
  // separately so we can dispose their canvases and materials.
  const tooltips: THREE.Sprite[] = []

  for (const i of [0, 1] as const) {
    const controller = ctx.renderer.xr.getController(i) as THREE.XRTargetRaySpace
    controllers.push(controller)
    const ray = buildRayLine(THREE_)
    rayLines.push(ray)
    controller.add(ray)
    ctx.scene.add(controller)

    // Controller model — auto-detects which Quest controller (Touch,
    // Touch Pro, etc.) and downloads the matching glTF from the
    // WebXR Input Profiles CDN. The model animates trigger pulls
    // and button presses automatically.
    const grip = ctx.renderer.xr.getControllerGrip(i) as THREE.XRGripSpace
    grip.add(modelFactory.createControllerModel(grip))
    ctx.scene.add(grip)
    grips.push(grip)

    // Button-affordance tooltip floating above each controller.
    // Shown on BOTH controllers for symmetry — either hand provides
    // the same hint regardless of dominance.
    const tooltip = buildControllerTooltip(THREE_)
    grip.add(tooltip)
    tooltips.push(tooltip)

    // Intersection dot — small white sphere positioned at the
    // raycast hit point each frame. Hidden when the ray misses.
    // Disable depth test so the dot never gets clipped behind the
    // surface it's resting on (robust against floating-point z-fight).
    const dotGeometry = new THREE_.SphereGeometry(0.008, 12, 12)
    const dotMaterial = new THREE_.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
    })
    const dot = new THREE_.Mesh(dotGeometry, dotMaterial)
    dot.renderOrder = 11 // above HUD (which is 10)
    dot.visible = false
    ctx.scene.add(dot)
    dots.push(dot)

    // Bind captured index so the shared handlers know which slot.
    controller.addEventListener('selectstart', () => onSelectStart(i))
    controller.addEventListener('selectend', () => onSelectEnd(i))
    controller.addEventListener('squeezestart', () => onSqueezeStart())

    // Stash this controller's XRInputSource on `connected`. Needed
    // by updateThumbstickZoom, which reads the gamepad — iterating
    // `session.inputSources` directly would conflate controller
    // indices with transient-pointer / gaze sources (which don't
    // have gamepads but still occupy an index in the list), causing
    // the rayOnBrowse lookup to land on the wrong hand.
    controller.addEventListener('connected', (ev: { data: XRInputSource }) => {
      inputSources[i] = ev.data
    })
    controller.addEventListener('disconnected', () => {
      inputSources[i] = null
    })
  }

  /**
   * Per-controller XRInputSource, populated on `connected` /
   * cleared on `disconnected`. Index matches `controllers[i]`, so
   * inputSources[0] is always the left-hand (or first-connected)
   * controller — stable across the session even when transient-
   * pointer / gaze sources come and go.
   */
  const inputSources: (XRInputSource | null)[] = [null, null]

  // Scratch vectors + quaternion reused every frame; avoids
  // allocation in the XR hot path.
  const currentWorldDir = new THREE_.Vector3()
  const deltaQ = new THREE_.Quaternion()
  const p0 = new THREE_.Vector3()
  const p1 = new THREE_.Vector3()

  /**
   * Scale the rotation a quaternion represents by `factor`, in place.
   * `q` is interpreted as a rotation by angle θ about some axis;
   * after the call it represents a rotation by `θ * factor` about
   * the same axis, clamped so the final angle stays within ±π
   * (Three.js wraps beyond that anyway, but explicit clamping
   * avoids the visible "snap" wraparound).
   */
  function scaleRotationAngle(q: THREE.Quaternion, factor: number): void {
    // Normalize to the shortest-path representation (w ≥ 0). Both q
    // and -q encode the same rotation, but axis-angle decomposition
    // requires the canonical form.
    if (q.w < 0) {
      q.x = -q.x
      q.y = -q.y
      q.z = -q.z
      q.w = -q.w
    }
    const w = Math.min(1, q.w)
    const angle = 2 * Math.acos(w)
    if (angle < 1e-6) return
    const sinHalf = Math.sin(angle / 2)
    const ax = q.x / sinHalf
    const ay = q.y / sinHalf
    const az = q.z / sinHalf
    const newAngle = Math.min(Math.PI, angle * factor)
    const halfNew = newAngle / 2
    const sinHalfNew = Math.sin(halfNew)
    q.set(ax * sinHalfNew, ay * sinHalfNew, az * sinHalfNew, Math.cos(halfNew))
  }

  /** Apply the surface-pinned rotation for the active single-drag. */
  function updateSingle(mode: Extract<RotationMode, { kind: 'single' }>): void {
    // Guard: the grabbed globe may have been disposed mid-frame if
    // the 2D app dropped from a 2-globe to a 1-globe layout while
    // the user had trigger held — scene.setPanelCount pops and
    // disposes the secondary, leaving our captured reference
    // dangling. Raycasting against a disposed mesh would throw or
    // return garbage; cancel the mode back to idle and let the next
    // frame re-capture on the current geometry.
    if (!ctx.getAllGlobes().includes(mode.grabbedGlobe)) {
      rotationMode = { kind: 'idle' }
      return
    }
    const controller = controllers[mode.index]
    setRaycasterFromController(controller)
    // Raycast against the specific globe the user grabbed so the
    // surface-pinned math stays correct even when the grabbed globe
    // is a secondary at a different arc position than the primary.
    const hits = raycaster.intersectObject(mode.grabbedGlobe, false)
    // Ray swung off-globe — freeze rotation until it lands back on
    // the surface. Matches 2D mouse-off-canvas semantics.
    if (hits.length === 0 || !hits[0].point) return
    currentWorldDir.copy(hits[0].point).sub(mode.grabbedGlobe.position).normalize()
    deltaQ.setFromUnitVectors(mode.worldGrabDir, currentWorldDir)
    scaleRotationAngle(deltaQ, ROTATION_SENSITIVITY)
    // Always write to the PRIMARY globe's quaternion — scene.update()
    // copies it to all secondaries, so the lockstep stays intact.
    ctx.globe.quaternion.copy(mode.globeStartQuat).premultiply(deltaQ)
  }

  /** Apply pinch-scale + full rigid-body rotation for the two-hand gesture. */
  function updateTwoHand(mode: Extract<RotationMode, { kind: 'two-hand' }>): void {
    controllers[0].getWorldPosition(p0)
    controllers[1].getWorldPosition(p1)
    const currentDistance = p0.distanceTo(p1)
    // Degenerate mid-gesture (hands coincident) — freeze to avoid a
    // divide-by-zero-ish blow-up.
    if (currentDistance < 0.001) return

    // Pinch zoom: scale is proportional to the distance ratio,
    // clamped to the globe's configured min/max.
    const scale = Math.max(
      MIN_GLOBE_SCALE,
      Math.min(MAX_GLOBE_SCALE, mode.startScale * (currentDistance / mode.startDistance)),
    )
    ctx.globe.scale.setScalar(scale)

    // Rotation: full rigid-body delta. Earlier version only
    // considered the axis direction between the hands, so wrist
    // twists produced no globe rotation — users reported that
    // rotation "didn't keep up with the controllers". Capturing
    // the average up-vector inside the two-hand orientation picks
    // up wrist rolls too.
    // Writes into scratch — no allocation, per-frame safe.
    const currentOrientation = computeTwoHandOrientation(twoHandOrientationScratch)
    // delta = current * start⁻¹, then globe = delta * globeStart
    deltaQ.copy(mode.startOrientation).invert().premultiply(currentOrientation)
    scaleRotationAngle(deltaQ, ROTATION_SENSITIVITY)
    ctx.globe.quaternion.copy(mode.globeStartQuat).premultiply(deltaQ)
  }

  /**
   * Continue the decaying spin from a release-time velocity. Stops
   * (transitions to idle) when speed drops below `MIN_INERTIA_SPEED`
   * so we don't burn frames applying invisible rotations.
   */
  function updateInertia(
    mode: Extract<RotationMode, { kind: 'inertia' }>,
    deltaSeconds: number,
  ): void {
    // Exponential decay of velocity over wall-clock time.
    const decay = Math.exp(-deltaSeconds / INERTIA_TIME_CONSTANT)
    mode.velocity.multiplyScalar(decay)
    const speed = mode.velocity.length()
    if (speed < MIN_INERTIA_SPEED) {
      rotationMode = { kind: 'idle' }
      // Flick-inertia has decayed to a stop — the globe is now
      // settled at wherever the spin left it.
      ctx.onCameraSettled?.()
      return
    }
    const angle = speed * deltaSeconds
    // Normalize into a scratch rather than cloning the velocity —
    // this function runs every frame during a flick-to-spin, and
    // mode.velocity is a mutable vector we can't normalize in-place
    // (that would change its magnitude, which encodes speed).
    inertiaAxisScratch.copy(mode.velocity).normalize()
    deltaQ.setFromAxisAngle(inertiaAxisScratch, angle)
    ctx.globe.quaternion.premultiply(deltaQ)
  }

  /** Quaternion scratch reused for velocity-delta math. */
  const velDelta = new THREE_.Quaternion()
  const velPrevInverse = new THREE_.Quaternion()
  const velSampleAxis = new THREE_.Vector3()
  const velSample = new THREE_.Vector3()

  /**
   * Track the globe's angular velocity each frame during single +
   * two-hand modes. Activates on first frame of rotation, deactivates
   * outside those modes. Smoothes via `lerp` so a single jittery
   * frame doesn't poison the velocity captured at release.
   */
  function updateVelocityTracking(deltaSeconds: number, isRotating: boolean): void {
    if (!isRotating) {
      velocityTracker.active = false
      return
    }
    if (!velocityTracker.active) {
      // First frame of a fresh rotation — initialize, no sample yet.
      velocityTracker.prevQuat.copy(ctx.globe.quaternion)
      velocityTracker.velocity.set(0, 0, 0)
      velocityTracker.active = true
      return
    }
    if (deltaSeconds <= 0) return

    // delta = current * prev⁻¹  (rotation that takes prev → current).
    velPrevInverse.copy(velocityTracker.prevQuat).invert()
    velDelta.copy(ctx.globe.quaternion).multiply(velPrevInverse)

    // Convert delta quaternion to angular velocity vector. Take the
    // shortest-path interpretation (flip sign if w < 0).
    const w = Math.max(-1, Math.min(1, velDelta.w < 0 ? -velDelta.w : velDelta.w))
    const sign = velDelta.w < 0 ? -1 : 1
    const angle = 2 * Math.acos(w)
    if (angle > 1e-5) {
      const sinHalf = Math.sin(angle / 2)
      velSampleAxis.set(velDelta.x, velDelta.y, velDelta.z).multiplyScalar(sign / sinHalf)
      velSample.copy(velSampleAxis).multiplyScalar(angle / deltaSeconds)
    } else {
      velSample.set(0, 0, 0)
    }
    velocityTracker.velocity.lerp(velSample, VELOCITY_SMOOTHING_ALPHA)
    velocityTracker.prevQuat.copy(ctx.globe.quaternion)
  }

  /**
   * Per-frame: position the laser dot at each controller's raycast
   * intersection point and shorten the ray line so it visually
   * "lands" on the surface instead of poking through. Hides the dot
   * + restores full-length ray when the ray misses everything.
   *
   * Raycasts against the globe, HUD, AND the AR Place button
   * (when it's visible). Keeping this target list in sync with
   * `pickHit`'s list is important — if the ray visuals don't land
   * on the same surfaces `pickHit` considers interactive, aiming
   * at buttons feels broken. Run after rotation updates so the dot
   * reflects the current globe orientation.
   */
  const rayTargets: THREE.Object3D[] = []
  /**
   * One-shot suppression for the updateRayVisuals try/catch. First
   * exception logs; subsequent exceptions in the same session stay
   * silent to avoid spamming the Quest browser console at 72–90 Hz
   * if something unexpectedly goes persistent.
   */
  let rayVisualErrorLogged = false
  function updateRayVisuals(): void {
    // Reuse one closure-scoped array, clear-and-push each frame so
    // we don't allocate at XR frame rate. Includes every globe in
    // the layout (so the dot snaps to secondaries), the HUD, the
    // browse panel (when visible), and the AR Place button (when
    // visible).
    rayTargets.length = 0
    const allGlobes = ctx.getAllGlobes()
    for (let i = 0; i < allGlobes.length; i++) rayTargets.push(allGlobes[i])
    rayTargets.push(ctx.hud.mesh)
    if (ctx.browse.isVisible()) {
      rayTargets.push(ctx.browse.mesh)
    }
    if (ctx.tourControls.isVisible()) {
      rayTargets.push(ctx.tourControls.mesh)
    }
    // Tour-overlay interactive meshes — question panels only right
    // now. Fetched fresh each frame because the set changes as
    // tours advance (question appears/disappears between steps);
    // the tourOverlay handle returns an empty array when nothing
    // interactive is showing so the cost is negligible.
    const overlayTargets = ctx.tourOverlay.getInteractiveMeshes()
    for (let i = 0; i < overlayTargets.length; i++) {
      rayTargets.push(overlayTargets[i])
    }
    // Draggable overlays — world-mode text/popup/image. Added to
    // the ray-target list so the visible laser dot lands on them
    // like any other UI target; picking + arming happens via
    // `pickHit` above.
    const draggableTargets = ctx.tourOverlay.getDraggableMeshes()
    for (let i = 0; i < draggableTargets.length; i++) {
      rayTargets.push(draggableTargets[i])
    }
    if (ctx.placement && ctx.placement.placeButtonMesh.visible) {
      rayTargets.push(ctx.placement.placeButtonMesh)
    }
    for (let i = 0; i < 2; i++) {
      const controller = controllers[i]
      setRaycasterFromController(controller)
      // Closest hit across all interactive surfaces wins for the
      // ray-dot position + line length.
      const hits = raycaster.intersectObjects(rayTargets, false)
      if (hits.length > 0 && hits[0].point) {
        const distance = hits[0].distance
        // Scale Z so the line ends exactly at the hit. Min clamp
        // avoids a degenerate zero-length scale on extreme close-up.
        rayLines[i].scale.z = Math.max(0.001, distance / RAY_LENGTH)
        dots[i].position.copy(hits[0].point)
        dots[i].visible = true
      } else {
        rayLines[i].scale.z = 1
        dots[i].visible = false
      }
      // rayOnBrowse drives thumbstick-Y → scroll (vs. zoom). Match
      // `pickHit`'s priority: the browse panel wins over the globe
      // even if the globe is closer to the camera, so we check
      // whether browse.mesh is anywhere in the hit list, not just
      // at position 0. Without this, a ray that crosses both the
      // panel and a globe behind it would scroll-route incorrectly
      // (closest hit is globe → rayOnBrowse false → zoom instead of
      // scroll, mismatching the click-route above).
      const browseMesh = ctx.browse.mesh
      let onBrowse = false
      for (let h = 0; h < hits.length; h++) {
        if (hits[h].object === browseMesh) { onBrowse = true; break }
      }
      rayOnBrowse[i] = onBrowse
    }
  }

  /** Poll thumbstick Y across controllers and scale globe accordingly. */
  /** Scroll speed for the browse panel: canvas pixels per second at full thumbstick deflection. */
  const BROWSE_SCROLL_SPEED = 400

  function updateThumbstickZoom(deltaSeconds: number): void {
    // Each Quest controller maps axes [2, 3] to the thumbstick
    // (axes [0, 1] are the touchpad, which the Quest doesn't
    // have). We iterate our two controllers directly using the
    // stashed inputSources array rather than `session.inputSources`:
    // the former is indexed 1:1 with `controllers[i]` / `rayOnBrowse[i]`,
    // the latter can interleave transient-pointer / gaze sources
    // that throw off index-based lookups.
    const session = ctx.renderer.xr.getSession()
    if (!session) return
    let zoomAxis = 0
    let scrollAxis = 0
    for (let i = 0; i < 2; i++) {
      const source = inputSources[i]
      const gp = source?.gamepad
      if (!gp) continue
      const y = gp.axes[3] ?? gp.axes[1] ?? 0
      if (Math.abs(y) <= THUMBSTICK_DEADZONE) continue
      // When this controller's ray is on the browse panel, redirect
      // its Y axis to scroll instead of zoom.
      if (rayOnBrowse[i]) {
        if (Math.abs(y) > Math.abs(scrollAxis)) scrollAxis = y
      } else {
        // Invert so pushing up → zoom in. Take the strongest signal
        // across controllers (user might use either hand).
        const signed = -y
        if (Math.abs(signed) > Math.abs(zoomAxis)) zoomAxis = signed
      }
    }
    if (zoomAxis !== 0) {
      // Capture the start-of-gesture scale on the rising edge so
      // the matching release can report a magnitude that means
      // "scale ratio over the whole gesture", not "ratio for the
      // last frame". Approximate log-ratio is the privacy-friendly
      // choice — small fractional values for small zooms,
      // ±1 / ±2 for an order-of-magnitude change.
      if (!wasZoomingThumbstick) {
        zoomGestureStartScale = ctx.globe.scale.x
      }
      const factor = Math.pow(ZOOM_RATE_PER_SECOND, zoomAxis * deltaSeconds)
      const next = ctx.globe.scale.x * factor
      const clamped = Math.max(MIN_GLOBE_SCALE, Math.min(MAX_GLOBE_SCALE, next))
      ctx.globe.scale.setScalar(clamped)
      wasZoomingThumbstick = true
    } else if (wasZoomingThumbstick) {
      // Thumbstick was pushing zoom last frame and returned to
      // neutral this frame — the user let go and the globe scale
      // is now settled.
      wasZoomingThumbstick = false
      ctx.onCameraSettled?.()
      // Tier B: thumbstick zoom released. Magnitude is the log2
      // ratio over the whole gesture: +1 = doubled, -1 = halved,
      // 0 = unchanged. Bounded by the MIN/MAX globe scale clamp
      // so it can't run away.
      const endScale = ctx.globe.scale.x
      if (zoomGestureStartScale > 0 && endScale > 0) {
        const log2Ratio = Math.log2(endScale / zoomGestureStartScale)
        emitVrInteraction('thumbstick_zoom', log2Ratio)
      }
      zoomGestureStartScale = 0
    }
    if (scrollAxis !== 0) {
      ctx.browse.scroll(scrollAxis * BROWSE_SCROLL_SPEED * deltaSeconds)
    }
  }
  /** Edge-triggered flag for thumbstick-zoom settle. Set true while
   * zoom axis is non-zero; flipping back to false fires one
   * `onCameraSettled` callback. */
  let wasZoomingThumbstick = false
  /** Globe scale at the moment the user started a thumbstick-zoom
   * gesture. Captured on the rising edge so the matching release
   * can report a magnitude that means "ratio over the whole
   * gesture", not "ratio for the last frame". */
  let zoomGestureStartScale = 0

  return {
    update(deltaSeconds) {
      switch (rotationMode.kind) {
        case 'idle':
          break
        case 'single':
          updateSingle(rotationMode)
          break
        case 'two-hand':
          updateTwoHand(rotationMode)
          break
        case 'inertia':
          updateInertia(rotationMode, deltaSeconds)
          break
      }

      // Overlay drag — writes a new customWorldOffset to the
      // overlay manager each frame based on the controller's
      // current pose. tourOverlay.update (called later in
      // vrSession's render loop) picks it up and positions the
      // panel; the panel "follows" the controller like a held
      // card until the user releases the trigger.
      if (overlayDrag.kind === 'overlay') {
        const controller = controllers[overlayDrag.controllerIndex]
        controller.getWorldPosition(dragScratchPos)
        controller.getWorldQuaternion(dragScratchQuat)
        // Rotate the stored local offset into world space by the
        // current controller quaternion, then add controller pos.
        dragScratchOffset.copy(overlayDrag.initialOffsetLocal).applyQuaternion(dragScratchQuat)
        dragScratchOffset.add(dragScratchPos)
        // Now `dragScratchOffset` holds the desired panel world
        // position. Convert to globe-relative before passing to
        // setOverlayCustomOffset so the panel continues to track
        // the globe if it moves in AR placement.
        dragScratchOffset.sub(ctx.globe.position)
        ctx.tourOverlay.setOverlayCustomOffset(overlayDrag.overlayId, dragScratchOffset)
      }

      // Velocity tracker only runs during user-driven rotation;
      // inertia drives itself from a captured velocity and would
      // otherwise feed back into its own decay calculation.
      const isUserRotating =
        rotationMode.kind === 'single' || rotationMode.kind === 'two-hand'
      updateVelocityTracking(deltaSeconds, isUserRotating)

      // Thumbstick zoom runs in idle + single modes. Suppressed
      // during two-hand (pinch owns scale) and inertia (avoid
      // accidental scale during a flick spin).
      if (rotationMode.kind !== 'two-hand' && rotationMode.kind !== 'inertia') {
        updateThumbstickZoom(deltaSeconds)
      }

      // Update the visible laser dot + ray length last so it
      // reflects the current globe position after rotation/scale.
      // The try/catch is defensive — the grabbed-globe guard in
      // updateSingle and the stable-array design of
      // ctx.getAllGlobes() should prevent raycast errors, but a
      // silent frame-break on an unexpected throw would be worse
      // than a frame with missing dots. Log once so persistent
      // failures are visible in the Quest console without spamming
      // the log at XR frame rate.
      try {
        updateRayVisuals()
      } catch (err) {
        if (!rayVisualErrorLogged) {
          rayVisualErrorLogged = true
          logger.warn('[VR] updateRayVisuals error (further errors suppressed):', err)
        }
      }
    },

    dispose() {
      // Three.js doesn't provide a `removeEventListener` for the
      // bound-lambda pattern without stashing references; instead
      // we remove the controllers from the scene entirely, which
      // releases the pose tracking and GC'd listeners with them.
      for (let i = 0; i < controllers.length; i++) {
        const controller = controllers[i]
        controller.remove(rayLines[i])
        ctx.scene.remove(controller)
        const line = rayLines[i]
        ;(line.geometry as THREE.BufferGeometry).dispose()
        ;(line.material as THREE.Material).dispose()
      }
      for (let i = 0; i < grips.length; i++) {
        // Removing the grip from the scene also removes the
        // controller-model child + releases its glTF resources via
        // Three.js' standard scene-graph disposal.
        ctx.scene.remove(grips[i])
      }
      for (const sprite of tooltips) {
        const mat = sprite.material as THREE.SpriteMaterial
        mat.map?.dispose()
        mat.dispose()
      }
      for (let i = 0; i < dots.length; i++) {
        const dot = dots[i]
        ctx.scene.remove(dot)
        ;(dot.geometry as THREE.BufferGeometry).dispose()
        ;(dot.material as THREE.Material).dispose()
      }
    },
  }
}
