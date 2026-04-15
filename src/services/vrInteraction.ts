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
import type { VrHudAction, VrHudHandle } from './vrHud'
import { MAX_GLOBE_SCALE, MIN_GLOBE_SCALE } from './vrScene'
import { logger } from '../utils/logger'

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
  globe: THREE.Mesh
  hud: VrHudHandle
  renderer: THREE.WebGLRenderer
  /** Fired when the user taps a HUD button. */
  onHudAction: (action: VrHudAction) => void
  /** Fired when the user squeezes the grip — caller ends the session. */
  onExit: () => void
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
 * - `two-hand` — both triggers on globe; mobile-style pinch + axis
 *   rotate. Distance between controllers scales the globe; the axis
 *   connecting them rotates it. Captures 5 of 6 DoF; twist around
 *   the connecting axis is deliberately dropped (Phase 4 polish).
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
 * Build a simple line segment extending from the controller along -Z.
 * Gives the user a visual reference for where the ray is pointing —
 * without it, aiming at the HUD is frustrating. We deliberately skip
 * `XRControllerModelFactory` (which would fetch a glTF Quest model)
 * for MVP bundle simplicity.
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

export function createVrInteraction(
  THREE_: typeof THREE,
  ctx: VrInteractionContext,
): VrInteractionHandle {
  const raycaster = new THREE_.Raycaster()
  /** Scratch vectors reused per frame to avoid allocation in the hot path. */
  const rayOrigin = new THREE_.Vector3()
  const rayDirection = new THREE_.Vector3()

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
    // the forward direction in world space.
    rayDirection.set(0, 0, -1).applyQuaternion(controller.getWorldQuaternion(new THREE_.Quaternion()))
    raycaster.ray.origin.copy(rayOrigin)
    raycaster.ray.direction.copy(rayDirection)
    return true
  }

  /**
   * Resolve what the controller is pointing at. Order matters: the
   * HUD is drawn on top of the globe (renderOrder + depthTest:false)
   * so from the user's visual perspective it should always win ties.
   */
  function pickHit(controller: THREE.XRTargetRaySpace):
    | { kind: 'hud'; action: VrHudAction }
    | { kind: 'globe' }
    | null {
    setRaycasterFromController(controller)

    const hudHits = raycaster.intersectObject(ctx.hud.mesh, false)
    if (hudHits.length > 0 && hudHits[0].uv) {
      const action = ctx.hud.hitTest({ x: hudHits[0].uv.x, y: hudHits[0].uv.y })
      if (action) return { kind: 'hud', action }
    }

    const globeHits = raycaster.intersectObject(ctx.globe, false)
    if (globeHits.length > 0) {
      return { kind: 'globe' }
    }

    return null
  }

  /**
   * Snapshot the single-drag baseline for the given controller.
   * Raycasts the controller against the globe; if the ray misses
   * (user's aim slipped during a mode transition) we fall back to
   * `idle` and the user can re-grab. Returns the new mode.
   */
  function captureSingleMode(index: 0 | 1): RotationMode {
    const controller = controllers[index]
    setRaycasterFromController(controller)
    const hits = raycaster.intersectObject(ctx.globe, false)
    if (hits.length === 0 || !hits[0].point) return { kind: 'idle' }
    return {
      kind: 'single',
      index,
      worldGrabDir: hits[0].point.clone().sub(ctx.globe.position).normalize(),
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
  function computeTwoHandOrientation(): THREE.Quaternion {
    const pos0 = new THREE_.Vector3()
    const pos1 = new THREE_.Vector3()
    controllers[0].getWorldPosition(pos0)
    controllers[1].getWorldPosition(pos1)
    const axis = pos1.sub(pos0).normalize()

    const up0 = new THREE_.Vector3(0, 1, 0).applyQuaternion(controllers[0].getWorldQuaternion(new THREE_.Quaternion()))
    const up1 = new THREE_.Vector3(0, 1, 0).applyQuaternion(controllers[1].getWorldQuaternion(new THREE_.Quaternion()))
    const avgUp = up0.add(up1).multiplyScalar(0.5)
    // Remove the component along the axis to get a perpendicular up.
    const perpUp = avgUp.sub(axis.clone().multiplyScalar(avgUp.dot(axis)))
    if (perpUp.lengthSq() < 0.001) {
      perpUp.crossVectors(axis, new THREE_.Vector3(0, 1, 0))
      if (perpUp.lengthSq() < 0.001) {
        perpUp.crossVectors(axis, new THREE_.Vector3(1, 0, 0))
      }
    }
    perpUp.normalize()

    const forward = new THREE_.Vector3().crossVectors(axis, perpUp)
    const basis = new THREE_.Matrix4().makeBasis(axis, perpUp, forward)
    return new THREE_.Quaternion().setFromRotationMatrix(basis)
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
      startOrientation: computeTwoHandOrientation(),
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
    const g0 = triggersOnGlobe[0]
    const g1 = triggersOnGlobe[1]
    if (g0 && g1) {
      if (rotationMode.kind !== 'two-hand') rotationMode = captureTwoHandMode()
    } else if (g0) {
      if (!(rotationMode.kind === 'single' && rotationMode.index === 0)) {
        rotationMode = captureSingleMode(0)
      }
    } else if (g1) {
      if (!(rotationMode.kind === 'single' && rotationMode.index === 1)) {
        rotationMode = captureSingleMode(1)
      }
    } else {
      // Releasing the last trigger. If the velocity tracker has a
      // significant signal, transition to inertia rather than
      // idle so the spin continues with decay.
      if (wasRotating && velocityTracker.velocity.length() > MIN_INERTIA_SPEED) {
        rotationMode = {
          kind: 'inertia',
          velocity: velocityTracker.velocity.clone(),
        }
      } else {
        rotationMode = { kind: 'idle' }
      }
    }
  }

  function onSelectStart(index: 0 | 1): void {
    const controller = controllers[index]
    const hit = pickHit(controller)
    if (!hit) return

    if (hit.kind === 'hud') {
      hudArmed[index] = hit.action
      return
    }

    // Globe hit — flip this trigger's rotation bit and let the
    // reevaluator pick the right mode (single or two-hand based on
    // the other trigger's state).
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
      }
      hudArmed[index] = null
    }
    if (triggersOnGlobe[index]) {
      triggersOnGlobe[index] = false
      reevaluateRotationMode()
    }
  }

  function onSqueezeStart(): void {
    // Grip = exit. Either controller does it.
    logger.info('[VR] Grip pressed — exiting VR session')
    ctx.onExit()
  }

  // --- Wire up both controllers ---

  for (const i of [0, 1] as const) {
    const controller = ctx.renderer.xr.getController(i) as THREE.XRTargetRaySpace
    controllers.push(controller)
    const ray = buildRayLine(THREE_)
    rayLines.push(ray)
    controller.add(ray)
    ctx.scene.add(controller)

    // Bind captured index so the shared handlers know which slot.
    controller.addEventListener('selectstart', () => onSelectStart(i))
    controller.addEventListener('selectend', () => onSelectEnd(i))
    controller.addEventListener('squeezestart', () => onSqueezeStart())
  }

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
    const controller = controllers[mode.index]
    setRaycasterFromController(controller)
    const hits = raycaster.intersectObject(ctx.globe, false)
    // Ray swung off-globe — freeze rotation until it lands back on
    // the surface. Matches 2D mouse-off-canvas semantics.
    if (hits.length === 0 || !hits[0].point) return
    currentWorldDir.copy(hits[0].point).sub(ctx.globe.position).normalize()
    deltaQ.setFromUnitVectors(mode.worldGrabDir, currentWorldDir)
    scaleRotationAngle(deltaQ, ROTATION_SENSITIVITY)
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
    const currentOrientation = computeTwoHandOrientation()
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
      return
    }
    const angle = speed * deltaSeconds
    deltaQ.setFromAxisAngle(mode.velocity.clone().normalize(), angle)
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

  /** Poll thumbstick Y across controllers and scale globe accordingly. */
  function updateThumbstickZoom(deltaSeconds: number): void {
    // The WebXR `inputSources` list is the source of truth for
    // gamepad axes — Three.js doesn't abstract this for us. Each
    // Quest controller maps axes [2, 3] to the thumbstick (axes
    // [0, 1] are the touchpad, which the Quest doesn't have).
    const session = ctx.renderer.xr.getSession()
    if (!session) return
    let zoomAxis = 0
    for (const source of session.inputSources) {
      const gp = source.gamepad
      if (!gp) continue
      // Prefer the primary thumbstick axis pair; fall back to the
      // legacy pair for older devices that expose only it.
      const y = gp.axes[3] ?? gp.axes[1] ?? 0
      if (Math.abs(y) > THUMBSTICK_DEADZONE) {
        // Invert so pushing up → zoom in. Take the strongest signal
        // across controllers (user might use either hand).
        const signed = -y
        if (Math.abs(signed) > Math.abs(zoomAxis)) zoomAxis = signed
      }
    }
    if (zoomAxis === 0) return
    const factor = Math.pow(ZOOM_RATE_PER_SECOND, zoomAxis * deltaSeconds)
    const next = ctx.globe.scale.x * factor
    const clamped = Math.max(MIN_GLOBE_SCALE, Math.min(MAX_GLOBE_SCALE, next))
    ctx.globe.scale.setScalar(clamped)
  }

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
    },
  }
}
