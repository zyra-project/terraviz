/**
 * OrbitController — public API for the Orbit character.
 *
 * This is the only surface external callers touch. Internally it owns
 * the Three.js scene, a requestAnimationFrame loop, and the state
 * machine. Gestures (Phase 3) and flight (Phase 4) come later.
 *
 * External drivers (the docent AI, the debug panel, URL params,
 * postMessage bridges) only:
 *   - setState(StateKey)
 *   - playGesture(GestureKind)      // Phase 3
 *   - setPalette(PaletteKey)
 *   - setScalePreset(ScaleKey)      // Phase 4
 *   - flyToEarth() / flyHome()      // Phase 4
 *
 * Everything else is derived from the STATES table per frame.
 */

import * as THREE from 'three'
import {
  buildScene,
  computeEffectiveFov,
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
import { GESTURES, GESTURE_KEYS } from './orbitGestures'
import {
  createFlightState, startFlyToEarth, startFlyHome, resetFlight,
  SCALE_PRESETS, PRESET_KEYS,
  type FlightState,
} from './orbitFlight'

export type { EyeMode, PaletteKey, ScaleKey, StateKey, GestureKind } from './orbitTypes'
export { PALETTES } from './orbitTypes'
export { STATES, ALL_STATES, BEHAVIOR_STATES, EMOTION_STATES, GESTURE_STATES } from './orbitStates'
export { GESTURES, GESTURE_KEYS } from './orbitGestures'
export { SCALE_PRESETS, PRESET_KEYS } from './orbitFlight'

export const PALETTE_KEYS: PaletteKey[] = ['cyan', 'green', 'amber', 'violet']

/**
 * How often the animate loop rebases `this.time` (and every absolute
 * schedule that tracks it) back toward zero. Anything that compares
 * times relatively stays unaffected; the goal is to prevent the raw
 * counter from climbing into the tens of thousands during
 * long-session runs. 3600 s = 1 hour is well within a safe
 * floating-point range for every downstream multiplier.
 */
const TIME_REBASE_THRESHOLD_SECONDS = 3600

export interface OrbitControllerOptions {
  container: HTMLElement
  palette?: PaletteKey
  onStateChange?: (state: StateKey) => void
}

export class OrbitController {
  private readonly container: HTMLElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly handles: OrbitSceneHandles
  private readonly anim: AnimationState
  private readonly clock = new THREE.Clock()
  private readonly onStateChange?: (state: StateKey) => void

  private rafId = 0
  private disposed = false
  private state: StateKey = 'IDLE'
  private palette: PaletteKey
  private scalePreset: ScaleKey = 'close'
  // Paired-eye configuration is permanent under the vinyl redesign
  // (see `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md` §Face). The field
  // is kept so callers that invoke `setEyeMode('two')` still work;
  // any attempt to set another mode is rejected at the setter.
  private eyeMode: EyeMode = 'two'
  /**
   * Mirrors the OS `prefers-reduced-motion` query (initialized in the
   * constructor and kept in sync via a media-query listener). Read by
   * `updateCharacter` to cap orbit speed and skip flashes, and by
   * `flyToEarth`/`flyHome` to teleport instead of arc.
   */
  private reducedMotion = false
  private reducedMotionMql: MediaQueryList | null = null
  private readonly flight: FlightState = createFlightState()
  private time = 0

  // Pointer position, normalized to [-1, 1]. CHATTING/TALKING/LISTENING
  // gaze tracks this so Orbit's eye follows the user's cursor.
  private mouseX = 0
  private mouseY = 0

  constructor(options: OrbitControllerOptions) {
    this.container = options.container
    this.palette = options.palette ?? 'cyan'
    this.onStateChange = options.onStateChange

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    const isMobile = typeof window !== 'undefined'
      && window.matchMedia?.('(max-width: 768px)').matches
    const pixelRatio = Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2)
    this.renderer.setPixelRatio(pixelRatio)
    // Shadow mapping: the vinyl redesign uses sub-sphere shadows on
    // the body to teach planetary eclipses. Shadow map is small (512)
    // and frustum is tight around the character — cheap on Quest.
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    this.handles = buildScene({ palette: this.palette, pixelRatio, scalePreset: this.scalePreset })
    this.anim = createAnimationState(this.palette)

    // Subscribe to OS prefers-reduced-motion. Keeping the MQL on the
    // instance lets us tear the listener down in dispose() so we
    // don't keep the controller alive after the page unmounts.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)')
      this.reducedMotion = this.reducedMotionMql.matches
      this.reducedMotionMql.addEventListener('change', this.handleReducedMotionChange)
    }

    this.resize()
    this.container.appendChild(this.renderer.domElement)

    window.addEventListener('resize', this.handleResize)
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove)
    this.animate()
  }

  // ---- Public API -------------------------------------------------------

  setState(state: StateKey): void {
    if (!(state in STATES)) {
      console.warn(`[Orbit] Unknown state: ${state}`)
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
      console.warn(`[Orbit] Unknown gesture: ${kind}`)
      return
    }
    // startGesture is a no-op if one is already playing; design doc
    // §Open questions defers gesture chaining/interrupts pending real
    // use cases from the docent dialogue layer.
    startGesture(this.anim, kind, this.time)
  }

  isGesturePlaying(): boolean {
    return isGesturePlaying(this.anim)
  }

  setPalette(palette: PaletteKey): void {
    if (!(palette in PALETTES)) {
      console.warn(`[Orbit] Unknown palette: ${palette}`)
      return
    }
    // Palette swap lands fully in Phase 5 (palettes + pupil tint). The
    // scene update already propagates palette changes per-frame, so
    // storing it here and letting the next updateCharacter() pick it
    // up is enough for visual correctness; Phase 5 adds the tint blend.
    this.palette = palette
  }

  getPalette(): PaletteKey {
    return this.palette
  }

  setScalePreset(preset: ScaleKey): void {
    if (!(preset in SCALE_PRESETS)) {
      console.warn(`[Orbit] Unknown scale preset: ${preset}`)
      return
    }
    if (preset === this.scalePreset) return
    // Preset change cancels any in-flight / at-Earth state — the
    // world just mutated underneath Orbit. The applyPreset() call in
    // updateCharacter picks up this.scalePreset change next frame.
    resetFlight(this.flight)
    this.scalePreset = preset
  }

  getScalePreset(): ScaleKey {
    return this.scalePreset
  }

  setEyeMode(mode: EyeMode): void {
    if (mode !== 'two') {
      console.warn(`[Orbit] Unknown eye mode: ${mode}`)
      return
    }
    this.eyeMode = mode
  }

  getEyeMode(): EyeMode {
    return this.eyeMode
  }

  flyToEarth(): boolean {
    return startFlyToEarth(this.flight, SCALE_PRESETS[this.scalePreset], this.time, this.reducedMotion)
  }

  flyHome(): boolean {
    return startFlyHome(this.flight, SCALE_PRESETS[this.scalePreset], this.time, this.reducedMotion)
  }

  /**
   * Override the prefers-reduced-motion default. The constructor seeds
   * this from `window.matchMedia('(prefers-reduced-motion: reduce)')`
   * and listens for OS-level changes; explicit calls here win until
   * the OS query toggles next. Mostly useful for `?reduced=1` URL
   * params and tests that need to assert behavior under reduced
   * motion without actually changing OS settings.
   */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced
  }

  getReducedMotion(): boolean {
    return this.reducedMotion
  }

  /** 'rest' | 'out' | 'atEarth' | 'back' — exposed so the UI can
   *  reflect the state of the Fly button. */
  getFlightMode(): FlightState['mode'] {
    return this.flight.mode
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    window.removeEventListener('resize', this.handleResize)
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove)
    this.reducedMotionMql?.removeEventListener('change', this.handleReducedMotionChange)
    this.reducedMotionMql = null
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
    // Photoreal Earth owns off-scene resources (CDN-loaded diffuse /
    // lights textures, async cloud loader, sun + ambient lights) that
    // the scene traversal below won't reach. Pull its objects out of
    // the scene first (matching the PhotorealEarthHandle contract),
    // then dispose — that way the traversal only touches Orbit's own
    // meshes (body, eye rigs, sub-spheres, trails, markers) and
    // doesn't double-free Earth geometry/materials.
    this.handles.earth.removeFrom(this.handles.scene)
    this.handles.earth.dispose()
    // Property-test instead of instanceof — trails render as
    // THREE.Points, not Mesh, so an `instanceof Mesh` check would
    // leave trail geometry + shader material on the GPU when the
    // Orbit page unmounts. Anything with a disposable `geometry` /
    // `material` (Mesh, Points, Line / Line2, Sprite) is caught.
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
  }

  // ---- Internals --------------------------------------------------------

  private handleResize = (): void => {
    this.resize()
  }

  private handleReducedMotionChange = (e: MediaQueryListEvent): void => {
    this.reducedMotion = e.matches
  }

  private handlePointerMove = (e: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.mouseY = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.container
    if (clientWidth === 0 || clientHeight === 0) return
    this.renderer.setSize(clientWidth, clientHeight, false)
    const aspect = clientWidth / clientHeight
    this.handles.camera.aspect = aspect
    // Adaptive vertical FOV: at landscape aspects the preset's fov
    // reads as designed; at narrower aspects we scale vertical FOV
    // up so horizontal coverage stays roughly what the preset sees
    // in landscape. Keeps Orbit + Earth in-frame on portrait phones.
    const preset = SCALE_PRESETS[this.scalePreset]
    this.handles.camera.fov = computeEffectiveFov(preset.fov, aspect)
    this.handles.camera.updateProjectionMatrix()
  }

  private animate = (): void => {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this.animate)
    const dt = Math.min(this.clock.getDelta(), 0.05)
    this.time += dt
    // Long-session hygiene — keep `time` bounded so trig multipliers
    // (up to 9× for the pupil pulse) don't accumulate huge arguments
    // over hours/days. Rebase once per hour: shift `time` and every
    // absolute-time schedule (blinks, jitter, active gesture, flight)
    // by the same amount so relative comparisons stay unchanged.
    // Anything that counts *durations* (wanderTimer, orbitPhaseAccum)
    // is unaffected — it accumulates via `dt`, not absolute time.
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
    }
    updateCharacter(this.handles, this.anim, {
      state: this.state,
      palette: this.palette,
      scalePreset: this.scalePreset,
      eyeMode: this.eyeMode,
      flight: this.flight,
      time: this.time,
      dt,
      mouseX: this.mouseX,
      mouseY: this.mouseY,
      reducedMotion: this.reducedMotion,
    })
    this.renderer.render(this.handles.scene, this.handles.camera)
  }
}
