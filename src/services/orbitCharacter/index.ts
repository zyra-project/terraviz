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
  BODY_RADIUS,
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
import { logger } from '../../utils/logger'

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
  /**
   * Controller `time` (post-rebase) at which the pointer last moved.
   * `time - cursorLastMoveTime` is the cursor-activity metric passed
   * to `updateCharacter` for gaze-bias decay. Initialized well in
   * the past so IDLE starts with zero ambient gaze bias.
   */
  private cursorLastMoveTime = -100

  /**
   * Drag-to-rotate-Earth state. When the user pointer-downs outside
   * Orbit's silhouette, drag deltas rotate `handles.earth.globe`,
   * which in turn rotates the sun direction in world space (per the
   * photoreal Earth's `local × quaternion` convention). Lets you
   * visualize how Orbit's key-light + glass-dome-streak respond to
   * a changing sun angle without waiting minutes for the UTC clock
   * to move the real subsolar point.
   */
  private draggingEarth = false
  private dragLastClientX = 0
  private dragLastClientY = 0
  // Preallocated scratch objects for drag-rotate. pointermove can fire
  // at high frequency, so reusing these avoids per-event GC churn from
  // Quaternion / Vector3 allocation.
  private readonly _dragYawQuat = new THREE.Quaternion()
  private readonly _dragPitchQuat = new THREE.Quaternion()
  private readonly _dragYawAxis = new THREE.Vector3(0, 1, 0)
  private readonly _dragPitchAxis = new THREE.Vector3(1, 0, 0)
  // Scratch for projecting the head's world position into NDC when
  // computing the hit-test radius for tickle clicks.
  private readonly _headNdc = new THREE.Vector3()

  /**
   * Counts the first few `pointermove` events and the first few
   * animation frames, logging to console so a developer can verify
   * in DevTools that the handler is actually firing and that the
   * presence-awareness values are updating. Throttled (not an
   * every-frame stream) so it doesn't flood the console.
   */
  private pointerMoveLogCount = 0
  private frameLogIntervalFrames = 0

  constructor(options: OrbitControllerOptions) {
    this.container = options.container
    this.palette = options.palette ?? 'cyan'
    this.onStateChange = options.onStateChange

    // `stencil: true` is the WebGLRenderer default but set explicitly:
    // the eyelid clip uses a socket-shaped stencil mask to keep lid
    // geometry from escaping the bezel (see
    // `orbitMaterials.ts/createSocketMaskMaterial`).
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true })
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
    // `pointermove` is attached to WINDOW (not the canvas) so
    // cursor movement over the debug panel or topbar — both
    // positioned above the canvas at z-index: 10 — still updates
    // `mouseX` / `mouseY`. Eye tracking needs to work anywhere
    // on the page, not only when the cursor is inside the canvas.
    // `pointerdown` stays on the canvas so tickle-gesture clicks
    // only fire when the user actually clicks in the character
    // view area, not when they click on debug controls.
    window.addEventListener('pointermove', this.handlePointerMove)
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown)
    // `pointerup` on window (not the canvas) so a drag that started
    // on the canvas still ends cleanly if the user releases over a
    // debug panel or outside the viewport.
    window.addEventListener('pointerup', this.handlePointerUp)
    this.animate()
  }

  // ---- Public API -------------------------------------------------------

  setState(state: StateKey): void {
    if (!(state in STATES)) {
      logger.warn(`[Orbit] Unknown state: ${state}`)
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
      logger.warn(`[Orbit] Unknown gesture: ${kind}`)
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
      logger.warn(`[Orbit] Unknown palette: ${palette}`)
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
      logger.warn(`[Orbit] Unknown scale preset: ${preset}`)
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
      logger.warn(`[Orbit] Unknown eye mode: ${mode}`)
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
    window.removeEventListener('pointermove', this.handlePointerMove)
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown)
    window.removeEventListener('pointerup', this.handlePointerUp)
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
    // Drag-to-rotate-Earth applies pointer deltas to the globe's
    // quaternion. Runs BEFORE the gaze-tracking path so the drag
    // doesn't also drive Orbit's eye gaze (which would feel weird —
    // the character's eyes chasing the user's drag gesture).
    if (this.draggingEarth) {
      const dx = e.clientX - this.dragLastClientX
      const dy = e.clientY - this.dragLastClientY
      this.dragLastClientX = e.clientX
      this.dragLastClientY = e.clientY
      // Pixels → radians. 300px of drag roughly equals π radians,
      // matching the "one swipe across the screen rotates a
      // hemisphere" feel the main scene's MapLibre globe has.
      const pxToRad = Math.PI / 300
      const globe = this.handles.earth.globe
      this._dragYawQuat.setFromAxisAngle(this._dragYawAxis, dx * pxToRad)
      this._dragPitchQuat.setFromAxisAngle(this._dragPitchAxis, dy * pxToRad)
      // Pre-multiply in world space so axes stay world-aligned even
      // after successive rotations. (Post-multiplying would make the
      // rotation axes drift with the globe's current orientation.)
      globe.quaternion.premultiply(this._dragYawQuat).premultiply(this._dragPitchQuat)
      return
    }
    // Clamp to [-1, 1] since the pointermove listener is attached to
    // `window` — cursor movement over the topbar / debug panel (both
    // z-indexed above the canvas) still drives eye tracking, but if
    // the cursor escapes the canvas rect we don't want runaway NDC
    // values steering the gaze off-screen.
    const rect = this.renderer.domElement.getBoundingClientRect()
    const rawX = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const rawY = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.mouseX = Math.max(-1, Math.min(1, rawX))
    this.mouseY = Math.max(-1, Math.min(1, rawY))
    this.cursorLastMoveTime = this.time
    // First few events only — confirms the listener is firing so
    // users can diagnose "eyes aren't tracking" issues from DevTools
    // without us shipping a debug build.
    if (this.pointerMoveLogCount < 5) {
      this.pointerMoveLogCount++
      logger.debug(
        `[orbit] pointermove #${this.pointerMoveLogCount}`,
        { mouseX: this.mouseX.toFixed(3), mouseY: this.mouseY.toFixed(3) },
      )
    }
  }

  /**
   * Pointer-down handler for tickle response. Projects Orbit's head
   * position into NDC, compares to the click position, and fires
   * the `tickle` gesture if the click lands within the body
   * silhouette radius. Uses a slightly generous radius so the
   * gesture fires on a click NEAR Orbit rather than requiring
   * pixel-perfect placement on the body.
   */
  private handlePointerDown = (e: PointerEvent): void => {
    if (this.disposed) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this._headNdc.copy(this.handles.head.position).project(this.handles.camera)
    const dx = ndcX - this._headNdc.x
    const dy = ndcY - this._headNdc.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    // Derive the tickle hit-test radius from Orbit's actual projected
    // silhouette rather than a hardcoded NDC constant. At the close
    // preset Orbit fills a large fraction of the viewport; at
    // continental / planetary presets the character is much smaller
    // on screen and a fixed 0.22 would cover empty space. Using the
    // projected body radius (with 1.8× slack for "clicked near
    // Orbit" forgiveness) keeps the target appropriately sized at
    // every zoom level.
    const cam = this.handles.camera
    const distToHead = cam.position.distanceTo(this.handles.head.position)
    const fovRad = (cam.fov * Math.PI) / 180
    const projectedBodyRadius = BODY_RADIUS / (distToHead * Math.tan(fovRad / 2))
    const clickRadius = projectedBodyRadius * 1.8
    if (dist <= clickRadius) {
      this.playGesture('tickle')
      return
    }
    // Click missed Orbit — start an Earth-rotate drag. The globe's
    // quaternion is applied to the photoreal Earth's local sun
    // direction every frame, so rotating the globe effectively
    // rotates the sun in world space. Let the user "move the sun"
    // interactively to eyeball Orbit's sun-driven shading.
    this.draggingEarth = true
    this.dragLastClientX = e.clientX
    this.dragLastClientY = e.clientY
    // Capture the pointer so subsequent move/up events still reach
    // us even if the cursor leaves the canvas mid-drag.
    try {
      this.renderer.domElement.setPointerCapture(e.pointerId)
    } catch {
      // setPointerCapture can throw if the pointer was already lost;
      // not worth handling — the fallback is that drag just ends
      // when the user releases over the canvas, which is fine for
      // a debug interaction.
    }
  }

  private handlePointerUp = (e: PointerEvent): void => {
    if (!this.draggingEarth) return
    this.draggingEarth = false
    try {
      this.renderer.domElement.releasePointerCapture(e.pointerId)
    } catch {
      // releasePointerCapture after pointer is lost is a no-op; swallow.
    }
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
      this.cursorLastMoveTime -= shift
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
      cursorActivityTime: this.time - this.cursorLastMoveTime,
    })
    // Presence-state diagnostics: once every ~60 frames (~1 s at
    // 60 fps), log the eased scalars so DevTools users can verify
    // that gaze and proximity are responding to mouse movement.
    this.frameLogIntervalFrames++
    if (this.frameLogIntervalFrames >= 60) {
      this.frameLogIntervalFrames = 0
      logger.debug('[orbit] presence', {
        mouseX: this.mouseX.toFixed(3),
        mouseY: this.mouseY.toFixed(3),
        gazeBias: this.anim.gazeBias.toFixed(2),
        proximity: this.anim.userProximity.toFixed(2),
        cursorIdle: (this.time - this.cursorLastMoveTime).toFixed(2),
      })
    }
    this.renderer.render(this.handles.scene, this.handles.camera)
  }
}
