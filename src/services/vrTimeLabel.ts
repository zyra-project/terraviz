/**
 * In-VR dataset time label — a small floating panel that sits
 * above the globe and always billboards to face the user.
 *
 * Mirrors the 2D `#time-label` overlay for the same purpose: keep
 * the "what date is this?" anchor visible alongside the data
 * texture as a climate video animates through its time series.
 * Critically different from the 2D path: the string is recomputed
 * from `video.currentTime` every frame by the host
 * (`VrSessionContext.getDatasetTimeLabel`) rather than polled from
 * `appState.timeLabel`. WebXR pauses `window.requestAnimationFrame`
 * while an immersive session is active, which freezes the 2D
 * playback loop and with it any consumer reading `appState.timeLabel`;
 * VR therefore computes the label directly from the video's
 * playhead so it advances every XR frame. Pause behaviour is free:
 * a paused video's `currentTime` doesn't advance, so the formatted
 * string stays fixed until playback resumes.
 *
 * Visual: 320 × 80 mm glass-surface rectangle with a large
 * centered date. Kept deliberately plain — no buttons, no hit
 * regions, no controls. Existing tour / playback affordances live
 * on the HUD below the globe; the time label is a pure read-out
 * positioned where a visitor naturally looks (upward from the
 * globe when tracking its rotation).
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}.
 */

import type * as THREE from 'three'

/** World-space size. Narrow strip; text fills most of it. */
const PANEL_WIDTH = 0.32
const PANEL_HEIGHT = 0.08

/** Canvas resolution. 4:1 matches the 0.32 × 0.08 m plane. */
const CANVAS_WIDTH = 640
const CANVAS_HEIGHT = 160

const BG_COLOR = 'rgba(13, 13, 18, 0.82)'
const BORDER_COLOR = 'rgba(255, 255, 255, 0.12)'
const TEXT_COLOR = '#e8eaf0'

export interface VrTimeLabelHandle {
  readonly mesh: THREE.Mesh
  /**
   * Update the displayed text. Null hides the panel. Repeat calls
   * with the same string are idempotent cheap comparisons — safe
   * to call every frame. When the text changes, the canvas is
   * repainted and `texture.needsUpdate` flips.
   */
  setText(text: string | null): void
  /**
   * Per-frame billboard + position. `globePosition` drives the
   * panel position (offset above the globe so the panel stays
   * visible while the user tracks the globe's rotation);
   * `cameraPosition` is the lookAt target so the text always
   * faces the user regardless of where they've walked to in AR.
   */
  update(camera: THREE.Camera, globePosition: THREE.Vector3): void
  dispose(): void
}

/**
 * World-space offset from the globe center. Above the globe at
 * 0.7 m — clear of the 0.5 m-radius globe silhouette with a ~20 cm
 * gap so the panel doesn't visually clip the top of the sphere
 * during pinch-zoom-up.
 */
const POSITION_OFFSET_Y = 0.7

function drawLabel(ctx: CanvasRenderingContext2D, text: string): void {
  const w = CANVAS_WIDTH
  const h = CANVAS_HEIGHT
  ctx.clearRect(0, 0, w, h)

  // Glass surface background.
  ctx.fillStyle = BG_COLOR
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = BORDER_COLOR
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, w - 2, h - 2)

  // Large centered date.
  ctx.fillStyle = TEXT_COLOR
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Start at a generous 80 px and shrink if the string is too long
  // for the panel — "2023-06-15 18:00" fits at 80 px but some
  // sub-daily periods might push sizes; letting the font scale
  // gives comfort room without clipping.
  let fontPx = 80
  ctx.font = `600 ${fontPx}px system-ui, -apple-system, sans-serif`
  const maxWidth = w * 0.9
  while (ctx.measureText(text).width > maxWidth && fontPx > 32) {
    fontPx -= 4
    ctx.font = `600 ${fontPx}px system-ui, -apple-system, sans-serif`
  }
  ctx.fillText(text, w / 2, h / 2)
}

export function createVrTimeLabel(THREE_: typeof THREE): VrTimeLabelHandle {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) throw new Error('[VR TimeLabel] 2D canvas context unavailable')

  const texture = new THREE_.CanvasTexture(canvas)
  texture.colorSpace = THREE_.SRGBColorSpace
  texture.minFilter = THREE_.LinearFilter
  texture.magFilter = THREE_.LinearFilter

  const material = new THREE_.MeshBasicMaterial({
    map: texture,
    transparent: true,
    // Same rationale as the HUD — ensure the panel always draws on
    // top so z-coincidence with cloud / atmosphere shells doesn't
    // cause z-fighting.
    depthTest: false,
    depthWrite: false,
  })
  const geometry = new THREE_.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT)
  const mesh = new THREE_.Mesh(geometry, material)
  mesh.renderOrder = 10
  mesh.visible = false

  let currentText: string | null = null
  const scratchTarget = new THREE_.Vector3()
  const scratchCamPos = new THREE_.Vector3()

  return {
    mesh,

    setText(text) {
      if (text === currentText) return
      currentText = text
      if (!text) {
        mesh.visible = false
        return
      }
      drawLabel(ctx2d, text)
      texture.needsUpdate = true
      mesh.visible = true
    },

    update(camera, globePosition) {
      if (!mesh.visible) return
      // Position: directly above the globe's current world
      // position (tracks AR placement, pinch-zoom — panel follows
      // wherever the globe went).
      scratchTarget.copy(globePosition)
      scratchTarget.y += POSITION_OFFSET_Y
      mesh.position.copy(scratchTarget)
      // Billboard: always face the user. Unlike a gaze-follow
      // panel (which lerps toward a camera-local offset), this
      // one is world-anchored and just rotates to face whoever's
      // looking at it. Reads more like a clock on a wall than a
      // subtitle track in the user's face.
      camera.getWorldPosition(scratchCamPos)
      mesh.lookAt(scratchCamPos)
    },

    dispose() {
      texture.dispose()
      material.dispose()
      geometry.dispose()
    },
  }
}
