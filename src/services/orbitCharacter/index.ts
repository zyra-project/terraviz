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
  createAnimationState,
  updateCharacter,
  startGesture,
  isGesturePlaying,
  type OrbitSceneHandles,
  type AnimationState,
} from './orbitScene'
import type { PaletteKey, ScaleKey, StateKey, GestureKind } from './orbitTypes'
import { STATES } from './orbitStates'
import { GESTURES, GESTURE_KEYS } from './orbitGestures'
import {
  createFlightState, startFlyToEarth, startFlyHome, resetFlight,
  SCALE_PRESETS, PRESET_KEYS,
  type FlightState,
} from './orbitFlight'

export type { PaletteKey, ScaleKey, StateKey, GestureKind } from './orbitTypes'
export { PALETTES } from './orbitTypes'
export { STATES, ALL_STATES, BEHAVIOR_STATES, EMOTION_STATES, GESTURE_STATES } from './orbitStates'
export { GESTURES, GESTURE_KEYS } from './orbitGestures'
export { SCALE_PRESETS, PRESET_KEYS } from './orbitFlight'

export const PALETTE_KEYS: PaletteKey[] = ['cyan', 'green', 'amber', 'violet']

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

    this.handles = buildScene({ palette: this.palette, pixelRatio, scalePreset: this.scalePreset })
    this.anim = createAnimationState(this.palette)

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

  flyToEarth(): boolean {
    return startFlyToEarth(this.flight, SCALE_PRESETS[this.scalePreset], this.time)
  }

  flyHome(): boolean {
    return startFlyHome(this.flight, SCALE_PRESETS[this.scalePreset], this.time)
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
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement)
    }
    this.handles.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose()
        const mat = obj.material
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat?.dispose()
      }
    })
  }

  // ---- Internals --------------------------------------------------------

  private handleResize = (): void => {
    this.resize()
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
    this.handles.camera.aspect = clientWidth / clientHeight
    this.handles.camera.updateProjectionMatrix()
  }

  private animate = (): void => {
    if (this.disposed) return
    this.rafId = requestAnimationFrame(this.animate)
    const dt = Math.min(this.clock.getDelta(), 0.05)
    this.time += dt
    updateCharacter(this.handles, this.anim, {
      state: this.state,
      palette: this.palette,
      scalePreset: this.scalePreset,
      flight: this.flight,
      time: this.time,
      dt,
      mouseX: this.mouseX,
      mouseY: this.mouseY,
    })
    this.renderer.render(this.handles.scene, this.handles.camera)
  }
}
