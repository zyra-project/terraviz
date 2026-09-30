// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Floating in-VR HUD — a small panel with dataset title, play/pause,
 * mute, Orbit's mic, browse and exit-VR buttons, and a caption strip
 * under it for Orbit's voice turns. Rendered as a `CanvasTexture` on a
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
import { t } from '../i18n'
import { wrapText } from './vrTourOverlay'

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
 * Layout when a video dataset is loaded and Orbit voice is available:
 *   [play-pause] [mute] [ title ... ] [voice] [browse] [exit]
 *     0.00-0.12  .12-.24  0.24-0.58   .58-.72  .72-.86  .86-1.00
 *
 * The title shrank from 46 % of the bar to 36 % to fit the mute
 * button next to play-pause — those two are a logical group
 * ("audio/video playback controls") so they belong together. The
 * Orbit mic then took 0.14 by narrowing every button a little rather
 * than the title a lot: the title keeps 34 %. Without voice the title
 * runs on over the mic's band, the way it runs left over play/pause
 * and mute for an image dataset.
 */
const BUTTON_LAYOUT = {
  playPause: { uMin: 0.0, uMax: 0.12 },
  mute: { uMin: 0.12, uMax: 0.24 },
  voice: { uMin: 0.58, uMax: 0.72 },
  browse: { uMin: 0.72, uMax: 0.86 },
  exit: { uMin: 0.86, uMax: 1.0 },
  // The title fills what's left between mute and the next button — non-interactive.
} as const

/**
 * The caption strip under the HUD that carries Orbit's side of a voice
 * turn. A child of the HUD mesh, so it follows the HUD through
 * placement and hides with it during the loading scene. It has no
 * buttons: `vrInteraction` raycasts it on its own (the HUD raycast is
 * non-recursive, and `hitTest` only knows the bar's UVs) and lets a
 * tap on a visible caption stop there.
 */
const CAPTION_HEIGHT = 0.1125
const CAPTION_GAP = 0.01
const CAPTION_CANVAS_HEIGHT = 192

/**
 * How far the caption strip reaches below the bar's bottom edge.
 * `vrSession` hangs the tour-control strip this much further down the
 * HUD's plane so the two never share the space under the bar.
 */
export const HUD_CAPTION_DROP = CAPTION_GAP + CAPTION_HEIGHT

export type VrHudAction = 'play-pause' | 'mute' | 'voice' | 'browse' | 'exit-vr'

/**
 * Orbit's voice turn as the HUD draws it — structurally the chat
 * module's `ImmersiveVoiceState`, restated here so the VR modules don't
 * import the chat UI. `idle` with a caption is a finished reply that
 * is still lingering.
 */
export type VrVoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'
export interface VrVoiceState {
  phase: VrVoicePhase
  caption: string
}

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
  /**
   * Value under the controller's aim on a data-encoded dataset, already
   * formatted with units — the in-VR counterpart of the 2D globe's
   * lat/lon strip. Null for a picture dataset, for a point outside a
   * regional dataset's box, or when nothing is aimed at a globe, in
   * which case the title keeps the full width it has today.
   */
  probeReadout?: string | null
  /**
   * Short warning under the title — set while the globe shows the
   * placeholder Earth because the dataset failed to load or the
   * loading scene gave up waiting, so the grey globe isn't mistaken
   * for the data. The readout takes the slot when both are set.
   */
  notice?: string | null
  /**
   * Orbit's voice turn. Null/absent when no speech recognition is
   * available for the active locale — the mic is then not drawn and
   * its band goes back to the title, rather than offering a dead
   * button.
   */
  voice?: VrVoiceState | null
}

/**
 * Map a UV point on the HUD to the button under it, for the state the
 * HUD is showing. Pure, so the layout is testable without a canvas.
 */
export function hudActionAt(state: VrHudState, uv: { x: number; y: number }): VrHudAction | null {
  const { x: u, y: v } = uv
  if (v < 0 || v > 1) return null
  const within = (band: { uMin: number; uMax: number }): boolean => u >= band.uMin && u <= band.uMax
  if (state.hasVideo && within(BUTTON_LAYOUT.playPause)) return 'play-pause'
  if (state.hasVideo && within(BUTTON_LAYOUT.mute)) return 'mute'
  if (state.voice && within(BUTTON_LAYOUT.voice)) return 'voice'
  if (within(BUTTON_LAYOUT.browse)) return 'browse'
  if (within(BUTTON_LAYOUT.exit)) return 'exit-vr'
  return null
}

/**
 * What the caption strip says for a voice state — a short label and
 * the text under it — or null when there's nothing to show and the
 * strip hides. Pure for the same reason as {@link hudActionAt}.
 */
export function voiceCaption(voice: VrVoiceState | null | undefined): { label: string; text: string } | null {
  if (!voice) return null
  switch (voice.phase) {
    case 'listening':
      return { label: t('vr.voice.listening'), text: voice.caption || t('vr.voice.listeningHint') }
    case 'thinking':
      return { label: t('vr.voice.thinking'), text: voice.caption }
    case 'speaking':
      return { label: t('vr.voice.speaker'), text: voice.caption }
    case 'error':
      return { label: t('vr.voice.speaker'), text: t('vr.voice.error') }
    case 'idle':
      return voice.caption ? { label: t('vr.voice.speaker'), text: voice.caption } : null
  }
}

export interface VrHudHandle {
  /** The Three.js mesh — add to the scene, no further handling needed. */
  readonly mesh: THREE.Mesh
  /**
   * The caption strip — a child of {@link mesh}, visible only while a
   * voice turn has something to say. Exposed so `vrInteraction` can
   * stop a ray on it: it is drawn over whatever is behind it, and a
   * tap there must not press something the user can't see.
   */
  readonly captionMesh: THREE.Mesh
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
  //
  // Running date display lives on its own floating panel above the
  // globe (vrTimeLabel) — not here. Embedding it in the HUD
  // required the host to feed a per-frame string AND the HUD to
  // redraw its canvas every frame, which was both wasteful and
  // indirect. The session/host computes the label string (from
  // video.currentTime via `VrSessionContext.getDatasetTimeLabel`
  // in main.ts); vrTimeLabel just renders what it's given and
  // billboards to face the user.
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
  const titleUMax = state.voice ? BUTTON_LAYOUT.voice.uMin : BUTTON_LAYOUT.browse.uMin
  const titleMaxWidth = (titleUMax - titleUMin) * w * 0.92
  const titleCenterX = ((titleUMin + titleUMax) / 2) * w
  let title = titleText
  while (ctx.measureText(title).width > titleMaxWidth && title.length > 4) {
    title = title.slice(0, -2) + '…'
  }
  // The readout shares the title's column: title lifts, value sits
  // under it in the accent colour. Only a data-encoded dataset ever
  // supplies one, so every existing dataset keeps the centred
  // full-height title it has today.
  const readout = state.probeReadout
  const notice = readout ? null : state.notice
  ctx.fillText(title, titleCenterX, readout || notice ? h / 2 - 26 : h / 2)
  if (readout) {
    ctx.fillStyle = '#4da6ff' // --color-accent
    ctx.font = '500 40px ui-monospace, SFMono-Regular, Menlo, monospace'
    let value = readout
    while (ctx.measureText(value).width > titleMaxWidth && value.length > 4) {
      value = value.slice(0, -2) + '…'
    }
    ctx.fillText(value, titleCenterX, h / 2 + 30)
  } else if (notice) {
    // Same slot as the readout, in the warning colour and the title's
    // proportional face — it's prose, not a number.
    ctx.fillStyle = '#e0a23c' // --color-warning fallback
    ctx.font = '500 38px system-ui, -apple-system, sans-serif'
    let text = notice
    while (ctx.measureText(text).width > titleMaxWidth && text.length > 4) {
      text = text.slice(0, -2) + '…'
    }
    ctx.fillText(text, titleCenterX, h / 2 + 30)
  }

  // --- Orbit voice button ---
  if (state.voice) drawVoiceButton(ctx, state.voice.phase, h)

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
 * The mic, coloured by what a tap will do next: text colour to start,
 * red while listening (tap sends), dimmed accent while Orbit thinks
 * (tap does nothing), and a stop square while Orbit speaks (tap stops).
 */
function drawVoiceButton(ctx: CanvasRenderingContext2D, phase: VrVoicePhase, h: number): void {
  const cx = ((BUTTON_LAYOUT.voice.uMin + BUTTON_LAYOUT.voice.uMax) / 2) * CANVAS_WIDTH
  const cy = h / 2
  if (phase === 'speaking') {
    ctx.fillStyle = 'rgba(77, 166, 255, 0.95)' // --color-accent
    ctx.fillRect(cx - 26, cy - 26, 52, 52)
    return
  }
  const colour = phase === 'listening'
    ? '#ff6b6b'
    : phase === 'thinking'
      ? 'rgba(77, 166, 255, 0.55)'
      : 'rgba(232, 234, 240, 0.85)' // --color-text, as browse and exit
  if (phase === 'listening') {
    // A ring behind the mic: "on air", visible at a glance in the headset.
    ctx.strokeStyle = colour
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.arc(cx, cy, 58, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.fillStyle = colour
  ctx.strokeStyle = colour
  ctx.lineWidth = 7
  ctx.lineCap = 'round'
  // Capsule
  const capW = 30
  const capH = 56
  const capTop = cy - 44
  ctx.beginPath()
  ctx.arc(cx, capTop + capW / 2, capW / 2, Math.PI, 0)
  ctx.lineTo(cx + capW / 2, capTop + capH - capW / 2)
  ctx.arc(cx, capTop + capH - capW / 2, capW / 2, 0, Math.PI)
  ctx.closePath()
  ctx.fill()
  // Cradle, stem and base
  ctx.beginPath()
  ctx.arc(cx, capTop + capH - capW / 2, 26, 0.15 * Math.PI, 0.85 * Math.PI)
  ctx.moveTo(cx, capTop + capH + 12)
  ctx.lineTo(cx, cy + 40)
  ctx.moveTo(cx - 18, cy + 40)
  ctx.lineTo(cx + 18, cy + 40)
  ctx.stroke()
}

/**
 * Break `text` into at most `maxLines` lines that fit `maxWidth`,
 * ending the last with an ellipsis when the text runs over.
 *
 * Words wrap as they do on the tour panels (`wrapText`, which also
 * shortens a word too wide for a line of its own — a URL, say). Text
 * with no spaces at all has no words to wrap: Japanese and Chinese are
 * written that way, and as one "word" a whole reply would be cut down
 * to a single line. That is broken by character instead.
 */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  // One paragraph: a caption is a sentence, and a hard break inside it
  // would spend one of very few lines.
  const flat = text.replace(/\s+/g, ' ').trim()
  const lines = flat.includes(' ') ? wrapText(ctx, flat, maxWidth) : wrapByCharacter(ctx, flat, maxWidth)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  let last = kept[maxLines - 1]!.replace(/…$/, '')
  while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1)
  kept[maxLines - 1] = `${last.trimEnd()}…`
  return kept
}

/** Fill each line with as many characters as fit — for text without spaces. */
function wrapByCharacter(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  // By code point, so a surrogate pair is never split across lines.
  for (const char of text) {
    if (line && ctx.measureText(line + char).width > maxWidth) {
      lines.push(line)
      line = char
    } else {
      line += char
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawCaption(ctx: CanvasRenderingContext2D, caption: { label: string; text: string }): void {
  const w = CANVAS_WIDTH
  const h = CAPTION_CANVAS_HEIGHT
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(13, 13, 18, 0.85)'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, w - 2, h - 2)
  const padX = 28
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#4da6ff' // --color-accent
  ctx.font = '600 30px system-ui, -apple-system, sans-serif'
  ctx.fillText(caption.label, padX, 34)
  ctx.fillStyle = '#e8eaf0' // --color-text
  ctx.font = '500 38px system-ui, -apple-system, sans-serif'
  const lines = wrapLines(ctx, caption.text, w - padX * 2, 2)
  lines.forEach((line, i) => ctx.fillText(line, padX, 92 + i * 56))
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

  // Caption strip, hung just below the bar (below rather than above so
  // it never covers the globe). Hidden until a voice turn has something
  // to say.
  const captionCanvas = document.createElement('canvas')
  captionCanvas.width = CANVAS_WIDTH
  captionCanvas.height = CAPTION_CANVAS_HEIGHT
  const captionCtx = captionCanvas.getContext('2d')
  if (!captionCtx) throw new Error('[VR HUD] 2D canvas context unavailable')
  const captionTexture = new THREE_.CanvasTexture(captionCanvas)
  captionTexture.colorSpace = THREE_.SRGBColorSpace
  captionTexture.minFilter = THREE_.LinearFilter
  captionTexture.magFilter = THREE_.LinearFilter
  const captionMaterial = new THREE_.MeshBasicMaterial({
    map: captionTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const captionGeometry = new THREE_.PlaneGeometry(HUD_WIDTH, CAPTION_HEIGHT)
  const captionMesh = new THREE_.Mesh(captionGeometry, captionMaterial)
  captionMesh.position.set(0, -(HUD_HEIGHT / 2 + CAPTION_GAP + CAPTION_HEIGHT / 2), 0)
  captionMesh.renderOrder = 10
  captionMesh.visible = false
  mesh.add(captionMesh)

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

  function redrawCaption() {
    const caption = voiceCaption(currentState.voice)
    captionMesh.visible = caption !== null
    if (!caption) return
    drawCaption(captionCtx!, caption)
    captionTexture.needsUpdate = true
  }

  // Initial paint so the HUD isn't blank for the first frame.
  redraw()

  return {
    mesh,
    captionMesh,

    setState(state) {
      const changed =
        state.datasetTitle !== currentState.datasetTitle ||
        state.isPlaying !== currentState.isPlaying ||
        state.hasVideo !== currentState.hasVideo ||
        state.isMuted !== currentState.isMuted ||
        state.panelCount !== currentState.panelCount ||
        state.primaryIndex !== currentState.primaryIndex ||
        state.browseOpen !== currentState.browseOpen ||
        // Normalised so an omitted readout and an explicit null don't
        // count as a change — vrSession's first setState omits it.
        (state.probeReadout ?? null) !== (currentState.probeReadout ?? null) ||
        (state.notice ?? null) !== (currentState.notice ?? null)
      // The caption only redraws when the voice turn moves on — the
      // state object itself is new every frame.
      const prevVoice = currentState.voice ?? null
      const nextVoice = state.voice ?? null
      const voiceChanged =
        (prevVoice === null) !== (nextVoice === null) ||
        prevVoice?.phase !== nextVoice?.phase ||
        prevVoice?.caption !== nextVoice?.caption
      if (!changed && !voiceChanged) return
      // The bar draws the mic's phase and yields the mic's band to the
      // title when voice comes or goes; the caption text is the strip's alone.
      const barChanged = changed || (prevVoice === null) !== (nextVoice === null) || prevVoice?.phase !== nextVoice?.phase
      currentState = state
      if (barChanged) redraw()
      if (voiceChanged) redrawCaption()
    },

    hitTest(uv) {
      return hudActionAt(currentState, uv)
    },

    dispose() {
      texture.dispose()
      material.dispose()
      geometry.dispose()
      captionTexture.dispose()
      captionMaterial.dispose()
      captionGeometry.dispose()
    },
  }
}
