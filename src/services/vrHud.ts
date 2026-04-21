/**
 * Floating in-VR HUD — a small panel with dataset title, play/pause
 * button, and exit-VR button. Rendered as a `CanvasTexture` on a
 * `PlaneGeometry` so we can use familiar 2D canvas drawing (text,
 * icons) instead of spinning up another shader for UI work.
 *
 * The HUD exposes its mesh so `vrSession` can attach it to the scene,
 * and a `hitTest(uv)` method so `vrInteraction` can translate a
 * raycast intersection into a semantic action. `vrInteraction` is
 * responsible for doing the raycast — this module only knows about
 * the 2D layout of its own buttons in UV space.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}.
 */

import type * as THREE from 'three'

/** World-space size of the HUD plane. Wide strip that tucks below the globe. */
const HUD_WIDTH = 0.6
const HUD_HEIGHT = 0.15

/**
 * Local-floor placement. Globe sits at `(0, 1.3, -1.5)` with 0.5 m
 * radius; its nearest surface point to the user is roughly z=-1.0.
 * HUD at (0, 1.0, -1.0) sits just below the globe's visible bottom
 * edge and in front of its nearest surface, which puts it inside
 * the natural gaze cone when looking at the globe — no deliberate
 * head-tilt needed to notice it. `depthTest: false` + `renderOrder`
 * on the mesh means any z-coincidence with the globe surface
 * doesn't cause z-fighting.
 *
 * An earlier position (y=0.75, z=-1.05) put the HUD at chest level
 * for a standing user — it was technically in the field of view
 * but required looking down deliberately, so on-headset testing
 * missed it entirely. Kept here as a note for future re-tuning.
 */
const HUD_POSITION = { x: 0, y: 1.0, z: -1.0 }

/** Canvas resolution. 4:1 ratio matches the 0.6 × 0.15 m plane. */
const CANVAS_WIDTH = 1024
const CANVAS_HEIGHT = 256

/**
 * Hit-region layout in UV space. `u` runs 0 (left) → 1 (right), `v`
 * runs 0 (bottom) → 1 (top) — Three.js' default PlaneGeometry UVs.
 * All regions are full-height bands; users don't need fine-grained
 * vertical targeting for buttons this small.
 *
 * Layout when a video dataset is loaded:
 *   [play-pause] [mute] [ title ...  ] [browse] [exit]
 *     0.00-0.14   .14-.28   0.28-0.64    0.64-    0.82-
 *                                         0.82     1.00
 *
 * The title shrank from 46 % of the bar to 36 % to fit the mute
 * button next to play-pause — those two are a logical group
 * ("audio/video playback controls") so they belong together.
 */
const BUTTON_LAYOUT = {
  playPause: { uMin: 0.0, uMax: 0.14 },
  mute: { uMin: 0.14, uMax: 0.28 },
  browse: { uMin: 0.64, uMax: 0.82 },
  exit: { uMin: 0.82, uMax: 1.0 },
  // 0.28-0.64 is the dataset title — non-interactive.
} as const

export type VrHudAction = 'play-pause' | 'mute' | 'browse' | 'exit-vr'

export interface VrHudState {
  /** Title shown in the middle of the panel. Null/empty renders "No dataset". */
  datasetTitle: string | null
  /** Drives the play/pause icon. */
  isPlaying: boolean
  /** Hides the play/pause + mute buttons when the loaded dataset is an image (no playback). */
  hasVideo: boolean
  /** Drives the speaker / muted-speaker icon variant on the mute button. */
  isMuted: boolean
  /**
   * Number of panels in the 2D layout (1/2/4). When > 1 the HUD renders
   * a small indicator strip so the user can see how many globes exist
   * and which one they're currently controlling.
   */
  panelCount: number
  /** Which panel index is primary — drives the highlighted dot in the strip. */
  primaryIndex: number
  /**
   * Drives the Browse button's active-state highlight. True when the
   * in-VR dataset browse panel is currently visible — gives the user
   * visual feedback that tapping the button will close it rather than
   * open a second one.
   */
  browseOpen: boolean
}

export interface VrHudHandle {
  /** The Three.js mesh — add to the scene, no further handling needed. */
  readonly mesh: THREE.Mesh
  /** Update visible state. Triggers a canvas redraw. */
  setState(state: VrHudState): void
  /**
   * Map a UV-space intersection (from a controller raycast) to an
   * action. Returns null if the ray hit the panel but not a button.
   * The caller (vrInteraction) supplies the UV directly from the
   * `Raycaster.intersectObject(mesh)` result.
   */
  hitTest(uv: { x: number; y: number }): VrHudAction | null
  dispose(): void
}

/**
 * Draw the HUD contents into a 2D canvas. Called every time state
 * changes — cheap enough at this resolution (1024 × 256) that we
 * don't bother with partial redraws.
 */
function drawCanvas(
  ctx: CanvasRenderingContext2D,
  state: VrHudState,
): void {
  const w = CANVAS_WIDTH
  const h = CANVAS_HEIGHT

  // Clear + translucent dark background. Matches the glass-surface
  // look used by the 2D UI (see src/styles/tokens.css).
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(13, 13, 18, 0.85)'
  ctx.fillRect(0, 0, w, h)

  // Thin border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, w - 2, h - 2)

  // --- Left: play/pause button (or spacer if no video) ---
  const ppMinX = BUTTON_LAYOUT.playPause.uMin * w
  const ppMaxX = BUTTON_LAYOUT.playPause.uMax * w
  const ppCenterX = (ppMinX + ppMaxX) / 2
  const ppCenterY = h / 2

  if (state.hasVideo) {
    ctx.fillStyle = 'rgba(77, 166, 255, 0.9)' // --color-accent
    if (state.isPlaying) {
      // Pause icon — two vertical bars
      const barW = 16
      const barH = 72
      ctx.fillRect(ppCenterX - barW - 6, ppCenterY - barH / 2, barW, barH)
      ctx.fillRect(ppCenterX + 6, ppCenterY - barH / 2, barW, barH)
    } else {
      // Play icon — right-pointing triangle
      const size = 40
      ctx.beginPath()
      ctx.moveTo(ppCenterX - size / 2, ppCenterY - size)
      ctx.lineTo(ppCenterX - size / 2, ppCenterY + size)
      ctx.lineTo(ppCenterX + size, ppCenterY)
      ctx.closePath()
      ctx.fill()
    }

    // --- Mute button (speaker glyph / speaker-with-slash when muted) ---
    const muMinX = BUTTON_LAYOUT.mute.uMin * w
    const muMaxX = BUTTON_LAYOUT.mute.uMax * w
    const muCenterX = (muMinX + muMaxX) / 2
    const muCenterY = h / 2
    ctx.fillStyle = state.isMuted
      ? 'rgba(232, 234, 240, 0.5)' // dimmed when muted
      : 'rgba(77, 166, 255, 0.9)' // accent when sound is on
    // Speaker body: rectangular base + triangular cone
    const bodyW = 16
    const bodyH = 32
    const coneW = 28
    const coneH = 60
    ctx.beginPath()
    // Rectangular part (left side of speaker)
    ctx.moveTo(muCenterX - coneW / 2 - bodyW, muCenterY - bodyH / 2)
    ctx.lineTo(muCenterX - coneW / 2, muCenterY - bodyH / 2)
    // Triangular cone tip (right side — points away)
    ctx.lineTo(muCenterX + coneW / 2, muCenterY - coneH / 2)
    ctx.lineTo(muCenterX + coneW / 2, muCenterY + coneH / 2)
    ctx.lineTo(muCenterX - coneW / 2, muCenterY + bodyH / 2)
    ctx.lineTo(muCenterX - coneW / 2 - bodyW, muCenterY + bodyH / 2)
    ctx.closePath()
    ctx.fill()
    if (state.isMuted) {
      // Slash through the speaker when muted.
      ctx.strokeStyle = 'rgba(232, 234, 240, 0.85)'
      ctx.lineWidth = 6
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(muCenterX - coneW / 2 - bodyW - 6, muCenterY - coneH / 2 - 6)
      ctx.lineTo(muCenterX + coneW / 2 + 6, muCenterY + coneH / 2 + 6)
      ctx.stroke()
    } else {
      // Two short arc "sound waves" emanating to the right.
      ctx.strokeStyle = 'rgba(77, 166, 255, 0.9)'
      ctx.lineWidth = 5
      ctx.lineCap = 'round'
      for (const r of [18, 32]) {
        ctx.beginPath()
        ctx.arc(muCenterX + coneW / 2 + 4, muCenterY, r, -Math.PI / 4, Math.PI / 4)
        ctx.stroke()
      }
    }
  }

  // --- Middle: dataset title ---
  // When no dataset is loaded the MVP has nothing to play, so steer
  // the user back to the 2D browse panel. Dataset switching inside
  // VR is Phase 3 work (see VR_INVESTIGATION_PLAN.md).
  const titleText = state.datasetTitle || 'Load a dataset in 2D view first'
  ctx.fillStyle = '#e8eaf0' // --color-text
  ctx.font = '500 54px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Title region grows left when there's no video (play/pause and
  // mute are hidden), so image datasets don't waste the left third
  // of the HUD on blank space. Right edge always stops before the
  // Browse button regardless.
  //
  // Crude ellipsis — if the title doesn't fit at full size, truncate
  // character-by-character until it does. Fine for typical dataset
  // names (< 40 chars); a longer implementation would binary-search.
  const titleUMin = state.hasVideo ? BUTTON_LAYOUT.mute.uMax : 0
  const titleUMax = BUTTON_LAYOUT.browse.uMin
  const titleMaxWidth = (titleUMax - titleUMin) * w * 0.92
  const titleCenterX = ((titleUMin + titleUMax) / 2) * w
  let title = titleText
  while (ctx.measureText(title).width > titleMaxWidth && title.length > 4) {
    title = title.slice(0, -2) + '…'
  }
  ctx.fillText(title, titleCenterX, h / 2)

  // --- Browse button (three horizontal bars, "list" glyph) ---
  // Highlights in accent when the panel is currently open so the
  // user sees the toggle state; otherwise renders in the default
  // text color to match the exit button's weight.
  const brMinX = BUTTON_LAYOUT.browse.uMin * w
  const brMaxX = BUTTON_LAYOUT.browse.uMax * w
  const brCenterX = (brMinX + brMaxX) / 2
  const brCenterY = h / 2
  ctx.fillStyle = state.browseOpen
    ? 'rgba(77, 166, 255, 0.95)' // --color-accent
    : 'rgba(232, 234, 240, 0.85)'
  const barW = 64
  const barH = 8
  const barGap = 16
  const totalH = barH * 3 + barGap * 2
  const topY = brCenterY - totalH / 2
  for (let i = 0; i < 3; i++) {
    const y = topY + i * (barH + barGap)
    ctx.fillRect(brCenterX - barW / 2, y, barW, barH)
  }

  // --- Right: exit VR button (×) ---
  const exMinX = BUTTON_LAYOUT.exit.uMin * w
  const exMaxX = BUTTON_LAYOUT.exit.uMax * w
  const exCenterX = (exMinX + exMaxX) / 2
  const exCenterY = h / 2
  ctx.strokeStyle = 'rgba(232, 234, 240, 0.85)'
  ctx.lineWidth = 7
  ctx.lineCap = 'round'
  const armLength = 32
  ctx.beginPath()
  ctx.moveTo(exCenterX - armLength, exCenterY - armLength)
  ctx.lineTo(exCenterX + armLength, exCenterY + armLength)
  ctx.moveTo(exCenterX + armLength, exCenterY - armLength)
  ctx.lineTo(exCenterX - armLength, exCenterY + armLength)
  ctx.stroke()

  // --- Top-center: multi-panel indicator strip ---
  // Tiny dots near the top edge of the HUD, one per panel in the 2D
  // layout, with the primary drawn in the accent colour and others
  // dimmed. Omitted entirely when there's only one panel — single-
  // globe sessions have no use for this affordance.
  if (state.panelCount > 1) {
    const dotRadius = 6
    const dotSpacing = 24
    const totalWidth = (state.panelCount - 1) * dotSpacing
    const startX = w / 2 - totalWidth / 2
    const y = 22
    for (let i = 0; i < state.panelCount; i++) {
      const cx = startX + i * dotSpacing
      ctx.beginPath()
      ctx.arc(cx, y, dotRadius, 0, Math.PI * 2)
      ctx.fillStyle = i === state.primaryIndex
        ? 'rgba(77, 166, 255, 0.95)'
        : 'rgba(232, 234, 240, 0.35)'
      ctx.fill()
    }
  }
}

/**
 * Build the HUD. Caller is responsible for adding `handle.mesh` to
 * the scene, calling `setState()` when dataset or play state changes,
 * and calling `dispose()` on session end.
 */
export function createVrHud(THREE_: typeof THREE): VrHudHandle {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) throw new Error('[VR HUD] 2D canvas context unavailable')

  const texture = new THREE_.CanvasTexture(canvas)
  texture.colorSpace = THREE_.SRGBColorSpace
  texture.minFilter = THREE_.LinearFilter
  texture.magFilter = THREE_.LinearFilter

  const material = new THREE_.MeshBasicMaterial({
    map: texture,
    transparent: true,
    // Render on top of the globe even when the HUD is visually
    // beyond the globe's bottom edge — avoids z-fighting fussiness
    // and is the expected UI behaviour anyway.
    depthTest: false,
    depthWrite: false,
  })
  // `renderOrder` > 0 + depthTest:false guarantees the HUD draws
  // after the scene geometry so it's always visible.
  const geometry = new THREE_.PlaneGeometry(HUD_WIDTH, HUD_HEIGHT)
  const mesh = new THREE_.Mesh(geometry, material)
  mesh.position.set(HUD_POSITION.x, HUD_POSITION.y, HUD_POSITION.z)
  mesh.renderOrder = 10

  // Mutable state; the canvas redraw is idempotent, so tracking the
  // current state here means setState() can skip redraws when nothing
  // changed (cheap but a nice win during typical playback).
  let currentState: VrHudState = {
    datasetTitle: null,
    isPlaying: false,
    hasVideo: false,
    isMuted: true,
    panelCount: 1,
    primaryIndex: 0,
    browseOpen: false,
  }

  function redraw() {
    drawCanvas(ctx2d!, currentState)
    texture.needsUpdate = true
  }

  // Initial paint so the HUD isn't blank for the first frame.
  redraw()

  return {
    mesh,

    setState(state) {
      const changed =
        state.datasetTitle !== currentState.datasetTitle ||
        state.isPlaying !== currentState.isPlaying ||
        state.hasVideo !== currentState.hasVideo ||
        state.isMuted !== currentState.isMuted ||
        state.panelCount !== currentState.panelCount ||
        state.primaryIndex !== currentState.primaryIndex ||
        state.browseOpen !== currentState.browseOpen
      if (!changed) return
      currentState = state
      redraw()
    },

    hitTest(uv) {
      const { x: u, y: v } = uv
      if (v < 0 || v > 1) return null
      if (
        currentState.hasVideo &&
        u >= BUTTON_LAYOUT.playPause.uMin &&
        u <= BUTTON_LAYOUT.playPause.uMax
      ) {
        return 'play-pause'
      }
      if (
        currentState.hasVideo &&
        u >= BUTTON_LAYOUT.mute.uMin &&
        u <= BUTTON_LAYOUT.mute.uMax
      ) {
        return 'mute'
      }
      if (u >= BUTTON_LAYOUT.browse.uMin && u <= BUTTON_LAYOUT.browse.uMax) {
        return 'browse'
      }
      if (u >= BUTTON_LAYOUT.exit.uMin && u <= BUTTON_LAYOUT.exit.uMax) {
        return 'exit-vr'
      }
      return null
    },

    dispose() {
      texture.dispose()
      material.dispose()
      geometry.dispose()
    },
  }
}
