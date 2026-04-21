/**
 * In-VR tour control strip — a small floating panel with prev /
 * play-pause / next / stop buttons plus a "step N / M" counter.
 *
 * Mirrors the 2D `#tour-controls` bar driven by
 * `showTourControls` / `hideTourControls` in `src/ui/tourUI.ts`, but
 * rendered as a CanvasTexture on a PlaneGeometry so it can live in
 * the VR scene graph. Shown only while a tour is active — when the
 * user isn't on a tour, the mesh is invisible and its UV hit-test
 * short-circuits.
 *
 * Positioning is the caller's job: `vrSession` tracks the strip to
 * a world-space offset below the main HUD so the two controls read
 * as a cluster. Kept as a separate mesh (rather than extending
 * `vrHud.ts`) so the dataset HUD's geometry stays untouched —
 * growing the HUD plane would start occluding the globe's bottom
 * edge for the common case where no tour is active.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}
 * Phase 3.5 section.
 */

import type * as THREE from 'three'

/** World-space size of the strip. Narrower than the HUD (0.6 m) so it reads as secondary. */
const STRIP_WIDTH = 0.5
const STRIP_HEIGHT = 0.09

/** Canvas resolution. 5.55:1 matches 0.5 × 0.09 m. */
const CANVAS_WIDTH = 1000
const CANVAS_HEIGHT = 180

const BG_COLOR = 'rgba(13, 13, 18, 0.85)'
const BORDER_COLOR = 'rgba(255, 255, 255, 0.12)'
const TEXT_COLOR = '#e8eaf0'
const ACCENT_COLOR = 'rgba(77, 166, 255, 0.9)'
const DIM_COLOR = 'rgba(232, 234, 240, 0.65)'

/**
 * Hit-region layout in UV space (u left→right, v bottom→top —
 * Three.js PlaneGeometry defaults). All regions span the full
 * height; users don't need vertical-precision targeting on a strip
 * this thin.
 *
 *   [prev] [play/pause] [next]  step N / M  [stop]
 *     0-.18    .18-.36    .36-.54  .54-.80    .80-1.00
 *
 * Step counter (.54-.80) is non-interactive — just a label.
 */
const BUTTON_LAYOUT = {
  prev: { uMin: 0.0, uMax: 0.18 },
  playPause: { uMin: 0.18, uMax: 0.36 },
  next: { uMin: 0.36, uMax: 0.54 },
  // 0.54 - 0.80 is the step-counter label
  stop: { uMin: 0.80, uMax: 1.0 },
} as const

export type VrTourControlsAction = 'tour-prev' | 'tour-play-pause' | 'tour-next' | 'tour-stop'

export interface VrTourControlsState {
  /** True while a tour is running (playing OR paused). Drives strip visibility. */
  active: boolean
  /** Drives the play/pause icon glyph. Ignored when `active` is false. */
  isPlaying: boolean
  /** Current step index (0-based). */
  step: number
  /** Total number of steps in the tour. */
  totalSteps: number
}

export interface VrTourControlsHandle {
  readonly mesh: THREE.Mesh
  setState(state: VrTourControlsState): void
  /** True iff the tour is active → the strip is visible. Mirror for vrInteraction. */
  isVisible(): boolean
  hitTest(uv: { x: number; y: number }): VrTourControlsAction | null
  dispose(): void
}

function drawStrip(
  ctx: CanvasRenderingContext2D,
  state: VrTourControlsState,
): void {
  const w = CANVAS_WIDTH
  const h = CANVAS_HEIGHT

  ctx.clearRect(0, 0, w, h)

  // Background + border — matches vrHud styling so the two panels
  // read as a coherent control cluster.
  ctx.fillStyle = BG_COLOR
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = BORDER_COLOR
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, w - 2, h - 2)

  // Button icon-drawing helpers use pixel centers computed from the
  // UV rects above; drawStrip needs the inverse of the UV space.
  function centerPx(region: { uMin: number; uMax: number }): { x: number; y: number } {
    return {
      x: ((region.uMin + region.uMax) / 2) * w,
      y: h / 2,
    }
  }

  // --- Prev (|◀) ---
  {
    const { x, y } = centerPx(BUTTON_LAYOUT.prev)
    ctx.fillStyle = DIM_COLOR
    // Vertical bar
    const barW = 10
    const barH = 48
    ctx.fillRect(x - 30, y - barH / 2, barW, barH)
    // Left-pointing triangle
    const size = 22
    ctx.beginPath()
    ctx.moveTo(x + 24, y - size)
    ctx.lineTo(x - 14, y)
    ctx.lineTo(x + 24, y + size)
    ctx.closePath()
    ctx.fill()
  }

  // --- Play / Pause ---
  {
    const { x, y } = centerPx(BUTTON_LAYOUT.playPause)
    ctx.fillStyle = ACCENT_COLOR
    if (state.isPlaying) {
      // Pause — two vertical bars
      const barW = 12
      const barH = 54
      ctx.fillRect(x - barW - 6, y - barH / 2, barW, barH)
      ctx.fillRect(x + 6, y - barH / 2, barW, barH)
    } else {
      // Play — right-pointing triangle
      const size = 28
      ctx.beginPath()
      ctx.moveTo(x - size / 2, y - size)
      ctx.lineTo(x - size / 2, y + size)
      ctx.lineTo(x + size, y)
      ctx.closePath()
      ctx.fill()
    }
  }

  // --- Next (▶|) ---
  {
    const { x, y } = centerPx(BUTTON_LAYOUT.next)
    ctx.fillStyle = DIM_COLOR
    // Right-pointing triangle
    const size = 22
    ctx.beginPath()
    ctx.moveTo(x - 24, y - size)
    ctx.lineTo(x + 14, y)
    ctx.lineTo(x - 24, y + size)
    ctx.closePath()
    ctx.fill()
    // Vertical bar
    const barW = 10
    const barH = 48
    ctx.fillRect(x + 20, y - barH / 2, barW, barH)
  }

  // --- Step counter (middle-right, non-interactive) ---
  ctx.fillStyle = TEXT_COLOR
  ctx.font = '500 44px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // The engine indexes from 0; tour authors + users expect a 1-based
  // count ("step 3 of 12"). totalSteps=0 is possible briefly between
  // tours — fall back to "—" to avoid a confusing "0 / 0".
  const label = state.totalSteps > 0
    ? `${state.step + 1} / ${state.totalSteps}`
    : '\u2014'
  const stepCx = ((0.54 + 0.80) / 2) * w
  ctx.fillText(label, stepCx, h / 2)

  // --- Stop (✕) ---
  {
    const { x, y } = centerPx(BUTTON_LAYOUT.stop)
    ctx.strokeStyle = DIM_COLOR
    ctx.lineWidth = 6
    ctx.lineCap = 'round'
    const arm = 22
    ctx.beginPath()
    ctx.moveTo(x - arm, y - arm)
    ctx.lineTo(x + arm, y + arm)
    ctx.moveTo(x + arm, y - arm)
    ctx.lineTo(x - arm, y + arm)
    ctx.stroke()
  }
}

export function createVrTourControls(THREE_: typeof THREE): VrTourControlsHandle {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) throw new Error('[VR Tour Controls] 2D canvas context unavailable')

  const texture = new THREE_.CanvasTexture(canvas)
  texture.colorSpace = THREE_.SRGBColorSpace
  texture.minFilter = THREE_.LinearFilter
  texture.magFilter = THREE_.LinearFilter

  const material = new THREE_.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const geometry = new THREE_.PlaneGeometry(STRIP_WIDTH, STRIP_HEIGHT)
  const mesh = new THREE_.Mesh(geometry, material)
  mesh.renderOrder = 10 // match HUD
  mesh.visible = false

  let currentState: VrTourControlsState = {
    active: false,
    isPlaying: false,
    step: 0,
    totalSteps: 0,
  }

  function redraw(): void {
    drawStrip(ctx2d!, currentState)
    texture.needsUpdate = true
  }

  redraw()

  return {
    mesh,

    setState(state) {
      const changed =
        state.active !== currentState.active ||
        state.isPlaying !== currentState.isPlaying ||
        state.step !== currentState.step ||
        state.totalSteps !== currentState.totalSteps
      if (!changed) return
      currentState = state
      mesh.visible = state.active
      if (state.active) redraw()
    },

    isVisible() {
      return currentState.active
    },

    hitTest(uv) {
      if (!currentState.active) return null
      const { x: u, y: v } = uv
      if (v < 0 || v > 1) return null
      if (u >= BUTTON_LAYOUT.prev.uMin && u <= BUTTON_LAYOUT.prev.uMax) return 'tour-prev'
      if (u >= BUTTON_LAYOUT.playPause.uMin && u <= BUTTON_LAYOUT.playPause.uMax) return 'tour-play-pause'
      if (u >= BUTTON_LAYOUT.next.uMin && u <= BUTTON_LAYOUT.next.uMax) return 'tour-next'
      if (u >= BUTTON_LAYOUT.stop.uMin && u <= BUTTON_LAYOUT.stop.uMax) return 'tour-stop'
      return null
    },

    dispose() {
      texture.dispose()
      material.dispose()
      geometry.dispose()
    },
  }
}
