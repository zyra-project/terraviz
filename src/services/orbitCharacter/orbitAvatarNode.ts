/**
 * OrbitAvatarNode — renderer-agnostic embedding of the Orbit character.
 *
 * `OrbitController` (in {@link ./index}) owns the standalone `/orbit`
 * page: its own renderer, its own camera, its own photoreal Earth, and
 * DOM listeners for cursor + tickle gestures. That works for a page
 * dedicated to the avatar, but not for hosts that already have all of
 * those — VR (`vrSession.ts`'s WebXR renderer + headset camera +
 * primary photoreal globe) and the future 2D companion (the main
 * app's chat panel, with the avatar as a small overlay).
 *
 * `OrbitAvatarNode` is the embedding-friendly surface:
 *
 *   - Exposes a {@link THREE.Object3D} (`group`) that the host parents
 *     into its existing scene. No standalone renderer, no internal
 *     scene background, no internal Earth.
 *   - Per-frame `update(dt, ctx)` takes the host's camera and a
 *     world-space sun direction. Body shading, sub-shadow direction,
 *     and the eye-dome streak orient to that sun, so the avatar is
 *     lit coherently with whatever Earth the host is rendering.
 *   - State / gesture / palette / flight setters mirror
 *     `OrbitController`. The character behaviour is identical — same
 *     STATES + GESTURES tables, same flight Bézier, same trail logic —
 *     just driven from the host's render loop instead of an internal
 *     `requestAnimationFrame`.
 *
 * Both classes share the construction primitives in `orbitScene.ts`
 * via the {@link BuildSceneMode | `mode`} parameter, so the avatar
 * mesh, material, and animation logic stay single-source-of-truth.
 *
 * See `docs/VR_INVESTIGATION_PLAN.md` §Phase 4 + §Phase 4b for the
 * planned consumers (VR scene, 2D companion).
 */

import * as THREE from 'three'
import {
  buildScene,
  createAnimationState,
  updateCharacter,
  startGesture,
  isGesturePlaying,
  type OrbitSceneHandles,
  type AnimationState,
} from './orbitScene'
import type { EyeMode, PaletteKey, ScaleKey, StateKey, GestureKind } from './orbitTypes'
import { PALETTES } from './orbitTypes'
import { STATES } from './orbitStates'
import { GESTURES } from './orbitGestures'
import {
  createFlightState, startFlyToEarth, startFlyHome, resetFlight,
  SCALE_PRESETS,
  type FlightState,
} from './orbitFlight'
import { logger } from '../../utils/logger'

/**
 * Rebase threshold for the per-instance `time` counter — matches the
 * standalone controller's value. Anything comparing times relatively
 * is unaffected; the goal is just to keep the raw counter inside a
 * safe floating-point range during long sessions.
 */
const TIME_REBASE_THRESHOLD_SECONDS = 3600

/**
 * Default `cursorActivityTime` reported to `updateCharacter` when the
 * host doesn't supply one. A value well past the gaze-bias decay
 * window (`ACTIVITY_FULL + ACTIVITY_FADE` ≈ 2.5 s in `orbitScene.ts`)
 * makes the avatar's gaze fall back to the state's native behaviour
 * (wandering / tracking the active feature target) rather than chase
 * a stale cursor position. VR hosts that wire controller-pointing
 * into gaze input can override per frame via
 * {@link OrbitAvatarUpdateContext.cursorActivityTime}.
 */
const NO_CURSOR_ACTIVITY = 100

export interface OrbitAvatarNodeOptions {
  palette?: PaletteKey
  scalePreset?: ScaleKey
  /**
   * Pixel ratio used for trail point-sprite sizing — typically the
   * host renderer's `renderer.getPixelRatio()`. Falls back to the
   * window's `devicePixelRatio` (or 1 outside a browser context).
   * Doesn't drive any per-frame behaviour, only initial trail buffer
   * setup.
   */
  pixelRatio?: number
  /**
   * Optional callback fired when {@link OrbitAvatarNode.setState}
   * actually changes the active state. Mirrors the standalone
   * controller's `onStateChange` hook so the docent bridge (Phase 4
   * commit 3 / 4b) can announce changes without polling.
   */
  onStateChange?: (state: StateKey) => void
}

/**
 * Per-frame inputs the host hands the avatar.
 */
export interface OrbitAvatarUpdateContext {
  /**
   * Active camera for proximity / NDC-space gaze response. In VR this
   * is the per-eye `XRCamera` exposed by Three.js's WebXRManager; in a
   * 2D host it's the orthographic / perspective camera the host renders
   * with. Required — `handles.camera` is always null in embedded mode.
   */
  camera: THREE.Camera
  /**
   * World-space unit vector toward the sun. Drives the key-light
   * position and eye-dome specular streak. The host should feed the
   * SAME sun direction it uses for its own globe / day-night shading
   * so Orbit's body and the surrounding world stay lit coherently.
   */
  sunDir: THREE.Vector3
  /**
   * Normalized cursor / pointer X in [-1, 1]. CHATTING / TALKING /
   * LISTENING use this for ambient gaze tracking. Hosts without a
   * cursor (VR controller raycast, voice-only) can omit; the avatar
   * falls back to the state's native gaze target.
   */
  mouseX?: number
  /**
   * Normalized cursor / pointer Y in [-1, 1]. See `mouseX`.
   */
  mouseY?: number
  /**
   * Seconds since the host's input device last produced a "look" hint
   * (cursor move, controller pointing change). If omitted, the avatar
   * assumes a long idle so gaze decays to the state's native target —
   * this is the right default for hosts that don't wire input to gaze.
   */
  cursorActivityTime?: number
}

/**
 * Renderer-agnostic Orbit character node. Construct once, parent
 * {@link OrbitAvatarNode.group} into your scene, then call
 * {@link OrbitAvatarNode.update} from the host's render loop.
 *
 * The constructor returns synchronously; geometry / material setup
 * is identical to the standalone controller and runs eagerly.
 */
export class OrbitAvatarNode {
  /**
   * Parent this into the host scene to mount the avatar. Currently a
   * {@link THREE.Group} (created by `buildScene` in embedded mode)
   * containing the head subtree, sub-spheres, trails, target marker
   * + halo, and the avatar's ambient + key lights. Layer assignment
   * is identical to standalone — every avatar object lives on
   * `ORBIT_LAYER`, and the host should call
   * `camera.layers.enable(ORBIT_LAYER)` once after mounting so the
   * camera can see the avatar.
   */
  readonly group: THREE.Object3D

  private readonly handles: OrbitSceneHandles
  private readonly anim: AnimationState
  private readonly onStateChange?: (state: StateKey) => void

  private state: StateKey = 'IDLE'
  private palette: PaletteKey
  private scalePreset: ScaleKey
  // Paired-eye configuration is permanent under the vinyl redesign;
  // see ORBIT_CHARACTER_VINYL_REDESIGN.md §Face. Field retained for
  // API parity with `OrbitController` so hosts that drive both end
  // up with one mental model.
  private eyeMode: EyeMode = 'two'
  private reducedMotion = false
  private reducedMotionMql: MediaQueryList | null = null
  private readonly flight: FlightState = createFlightState()
  private time = 0
  private disposed = false

  constructor(options: OrbitAvatarNodeOptions = {}) {
    this.palette = options.palette ?? 'cyan'
    this.scalePreset = options.scalePreset ?? 'close'
    this.onStateChange = options.onStateChange
    const pixelRatio = options.pixelRatio
      ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1)

    this.handles = buildScene({
      palette: this.palette,
      pixelRatio,
      scalePreset: this.scalePreset,
      mode: 'embedded',
    })
    // In embedded mode `buildScene` returns a Group as `scene`. Hand
    // that out as `group` for the host to parent — same Object3D, just
    // a clearer name from the caller's perspective.
    this.group = this.handles.scene
    this.anim = createAnimationState(this.palette)

    // Subscribe to OS prefers-reduced-motion so the avatar quiets its
    // motion-heavy effects (jitter, pupil pulse, gesture flashes,
    // flight arcs) in line with the standalone controller. Hosts can
    // also override programmatically via setReducedMotion().
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)')
      this.reducedMotion = this.reducedMotionMql.matches
      this.reducedMotionMql.addEventListener('change', this.handleReducedMotionChange)
    }
  }

  // ---- Public API -------------------------------------------------------

  setState(state: StateKey): void {
    if (!(state in STATES)) {
      logger.warn(`[OrbitAvatarNode] Unknown state: ${state}`)
      return
    }
    if (state === this.state) return
    this.state = state
    this.onStateChange?.(state)
  }

  getState(): StateKey {
    return this.state
  }

  playGesture(kind: GestureKind): void {
    if (!(kind in GESTURES)) {
      logger.warn(`[OrbitAvatarNode] Unknown gesture: ${kind}`)
      return
    }
    startGesture(this.anim, kind, this.time)
  }

  isGesturePlaying(): boolean {
    return isGesturePlaying(this.anim)
  }

  setPalette(palette: PaletteKey): void {
    if (!(palette in PALETTES)) {
      logger.warn(`[OrbitAvatarNode] Unknown palette: ${palette}`)
      return
    }
    this.palette = palette
  }

  getPalette(): PaletteKey {
    return this.palette
  }

  setScalePreset(preset: ScaleKey): void {
    if (!(preset in SCALE_PRESETS)) {
      logger.warn(`[OrbitAvatarNode] Unknown scale preset: ${preset}`)
      return
    }
    if (preset === this.scalePreset) return
    // Embedded mode never rebuilds Earth (the host owns the globe),
    // but the preset still drives flight parking + feature targets,
    // so a swap clears any in-flight state and lets the next frame
    // re-evaluate from the new preset's coordinates.
    resetFlight(this.flight)
    this.scalePreset = preset
  }

  getScalePreset(): ScaleKey {
    return this.scalePreset
  }

  setEyeMode(mode: EyeMode): void {
    if (mode !== 'two') {
      logger.warn(`[OrbitAvatarNode] Eye mode '${mode}' is not supported under the vinyl redesign`)
      return
    }
    this.eyeMode = mode
  }

  getEyeMode(): EyeMode {
    return this.eyeMode
  }

  flyToEarth(): boolean {
    return startFlyToEarth(
      this.flight,
      SCALE_PRESETS[this.scalePreset],
      this.time,
      this.reducedMotion,
    )
  }

  flyHome(): boolean {
    return startFlyHome(
      this.flight,
      SCALE_PRESETS[this.scalePreset],
      this.time,
      this.reducedMotion,
    )
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced
  }

  getReducedMotion(): boolean {
    return this.reducedMotion
  }

  /** 'rest' | 'out' | 'atEarth' | 'back' — same as `OrbitController`. */
  getFlightMode(): FlightState['mode'] {
    return this.flight.mode
  }

  /**
   * Per-frame tick. Call from the host's render loop AFTER the host
   * has updated its own globe (so `sunDir` is fresh) and BEFORE the
   * host's `renderer.render()`.
   */
  update(dt: number, ctx: OrbitAvatarUpdateContext): void {
    if (this.disposed) return
    // Clamp dt the same way the standalone animate() loop does — keeps
    // a single dropped frame from triggering a one-shot-warp in flight
    // / gesture progression.
    const clampedDt = Math.min(Math.max(dt, 0), 0.05)
    this.time += clampedDt

    if (this.time > TIME_REBASE_THRESHOLD_SECONDS) {
      const shift = TIME_REBASE_THRESHOLD_SECONDS
      this.time -= shift
      if (this.anim.blinkStartTime >= 0) this.anim.blinkStartTime -= shift
      this.anim.nextBlinkTime -= shift
      this.anim.jitterNextTime -= shift
      if (this.anim.activeGesture) this.anim.activeGesture.startTime -= shift
      if (this.anim.surpriseStart >= 0) this.anim.surpriseStart -= shift
      if (this.anim.arrivalSquashStart >= 0) this.anim.arrivalSquashStart -= shift
      this.flight.startTime -= shift
      // Trail timestamps drift the same way as the standalone path —
      // without rebasing them, the state-fade envelope would clamp to
      // zero after a rebase and the trails would render dead.
      for (const trail of this.handles.trails) {
        trail.stateChangeTime -= shift
      }
    }

    updateCharacter(this.handles, this.anim, {
      state: this.state,
      palette: this.palette,
      scalePreset: this.scalePreset,
      eyeMode: this.eyeMode,
      flight: this.flight,
      time: this.time,
      dt: clampedDt,
      mouseX: ctx.mouseX ?? 0,
      mouseY: ctx.mouseY ?? 0,
      reducedMotion: this.reducedMotion,
      cursorActivityTime: ctx.cursorActivityTime ?? NO_CURSOR_ACTIVITY,
      camera: ctx.camera,
      sunDir: ctx.sunDir,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reducedMotionMql?.removeEventListener('change', this.handleReducedMotionChange)
    this.reducedMotionMql = null
    // Embedded mode never built an internal Earth, so dispose is just
    // a scene traversal. Mirrors the standalone disposer's
    // property-test (geometry + material) so trails (Points, not Mesh)
    // and any future Sprite / Line additions get freed correctly.
    this.handles.scene.traverse((obj) => {
      const disposable = obj as THREE.Object3D & {
        geometry?: { dispose?: () => void }
        material?: { dispose?: () => void } | Array<{ dispose?: () => void }>
      }
      disposable.geometry?.dispose?.()
      const mat = disposable.material
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.())
      else mat?.dispose?.()
    })
    // The host parented this.group into its scene; pulling it out is
    // the host's responsibility (same contract as the existing
    // `PhotorealEarthHandle.removeFrom` pattern). We don't reach into
    // the host's scene graph here.
  }

  // ---- Internals --------------------------------------------------------

  private handleReducedMotionChange = (e: MediaQueryListEvent): void => {
    this.reducedMotion = e.matches
  }
}
