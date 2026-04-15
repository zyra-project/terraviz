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

/** Zoom rate at full-deflection — scale factor multiplier per second. */
const ZOOM_RATE_PER_SECOND = 1.3

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

/** Per-controller state tracked during a trigger-drag. */
interface DragState {
  /** Controller world-space quaternion at the moment `selectstart` fired. */
  controllerStartQuat: THREE.Quaternion
  /** Globe quaternion at the moment `selectstart` fired. */
  globeStartQuat: THREE.Quaternion
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
  /** Active drag per controller index. Null when not trigger-held on the globe. */
  const drags: (DragState | null)[] = [null, null]
  /**
   * Whether each controller's most recent selectstart hit the HUD
   * instead of the globe. We only fire a HUD action on `selectend`
   * to match the DOM `click` model (press + release on the same
   * button).
   */
  const hudArmed: (VrHudAction | null)[] = [null, null]

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

  function onSelectStart(index: number): void {
    const controller = controllers[index]
    const hit = pickHit(controller)
    if (!hit) return

    if (hit.kind === 'hud') {
      hudArmed[index] = hit.action
    } else {
      // Start tracking a globe rotation drag. We record both
      // quaternions at press time and recompute the globe's
      // orientation each frame from (currentControllerQ * startQ⁻¹)
      // composed on top of the starting globe orientation. This
      // produces a "grab the globe" feel — rotating the wrist
      // rotates the globe.
      drags[index] = {
        controllerStartQuat: controller.getWorldQuaternion(new THREE_.Quaternion()),
        globeStartQuat: ctx.globe.quaternion.clone(),
      }
    }
  }

  function onSelectEnd(index: number): void {
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
    drags[index] = null
  }

  function onSqueezeStart(): void {
    // Grip = exit. Either controller does it.
    logger.info('[VR] Grip pressed — exiting VR session')
    ctx.onExit()
  }

  // --- Wire up both controllers ---

  for (let i = 0; i < 2; i++) {
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

  // Scratch quaternion for drag composition.
  const currentControllerQ = new THREE_.Quaternion()
  const deltaQ = new THREE_.Quaternion()

  return {
    update(deltaSeconds) {
      // --- Drag rotation ---
      for (let i = 0; i < 2; i++) {
        const drag = drags[i]
        if (!drag) continue
        const controller = controllers[i]
        controller.getWorldQuaternion(currentControllerQ)
        // delta = current * startInverse
        deltaQ
          .copy(drag.controllerStartQuat)
          .invert()
          .premultiply(currentControllerQ)
        // globe = delta * startGlobe
        ctx.globe.quaternion
          .copy(drag.globeStartQuat)
          .premultiply(deltaQ)
      }

      // --- Thumbstick zoom ---
      // The WebXR `inputSources` list is the source of truth for
      // gamepad axes — Three.js doesn't abstract this for us. Each
      // Quest controller maps axes [2, 3] to the thumbstick (axes
      // [0, 1] are the touchpad, which the Quest doesn't have).
      const session = ctx.renderer.xr.getSession()
      if (session) {
        let zoomAxis = 0
        for (const source of session.inputSources) {
          const gp = source.gamepad
          if (!gp) continue
          // Prefer the primary thumbstick axis pair; fall back to
          // the legacy pair for older devices that expose only it.
          const y = gp.axes[3] ?? gp.axes[1] ?? 0
          if (Math.abs(y) > THUMBSTICK_DEADZONE) {
            // Invert so pushing up → zoom in. Take the strongest
            // signal across controllers (user might use either hand).
            const signed = -y
            if (Math.abs(signed) > Math.abs(zoomAxis)) zoomAxis = signed
          }
        }
        if (zoomAxis !== 0) {
          const factor = Math.pow(ZOOM_RATE_PER_SECOND, zoomAxis * deltaSeconds)
          const next = ctx.globe.scale.x * factor
          const clamped = Math.max(MIN_GLOBE_SCALE, Math.min(MAX_GLOBE_SCALE, next))
          ctx.globe.scale.setScalar(clamped)
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
    },
  }
}
