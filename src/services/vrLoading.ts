// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * 3D translation of the 2D loading screen (`src/styles/loading.css`).
 *
 * Faithful to the 2D visual language: small dark-blue sphere with a
 * subtle pulse, two concentric rings spinning at different speeds and
 * directions, "Terraviz" title + subtitle, thin progress bar,
 * status text. Replaces the 2D HTML loading screen with a spatial
 * version while the WebXR session is starting up and the dataset
 * texture is decoding.
 *
 * Visible from the moment `vrSession.enterImmersive()` builds the
 * scene until the dataset texture has a decoded frame — or its video
 * reports an error, or a fallback timer gives up waiting (see
 * `vrLoadingHandover.ts`). Then fades out via `fadeOut()` and the real
 * globe takes over the same anchor point.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}
 * Phase 2 — visual polish, loading gate.
 */

import type * as THREE from 'three'
import { getLocale } from '../i18n'
import { isNodeTagline, splashTagline } from '../ui/splashTagline'

/** Anchor in local-floor space — same spot the globe will occupy when ready. */
const LOADING_POSITION = { x: 0, y: 1.3, z: -1.5 }

// --- Geometry sizes (metres). Sized to feel "small but inviting" — not
//     dominating the user's view. Roughly matches the 2D version's
//     compact 88px loading globe.
const SPHERE_RADIUS = 0.06
const OUTER_RING_RADIUS = 0.075
const OUTER_RING_TUBE = 0.0015
const INNER_RING_RADIUS = 0.065
const INNER_RING_TUBE = 0.0012

// --- Animation rates (matching 2D loading.css keyframes).
const OUTER_RING_PERIOD_S = 1.6
const INNER_RING_PERIOD_S = 2.4 // reverse direction
const SPHERE_PULSE_PERIOD_S = 2.4

// --- Colours pulled from src/styles/tokens.css.
const ACCENT_COLOR = 0x4da6ff // --color-accent
const SPHERE_COLOR_DEEP = 0x08111f // 2D radial gradient inner
const SPHERE_COLOR_RIM = 0x1e3a6e // 2D radial gradient outer
const TEXT_COLOR = '#e8eaf0' // --color-text
const TEXT_MUTED = '#999' // --color-text-muted

// --- Title / subtitle / progress / status panel sizes.
const TITLE_PANEL_WIDTH = 0.18 // 18 cm
const TITLE_PANEL_HEIGHT = 0.045
const TITLE_CANVAS_WIDTH = 768
const TITLE_CANVAS_HEIGHT = 192
const TITLE_OFFSET_Y = -0.11

const PROGRESS_WIDTH = 0.13
const PROGRESS_HEIGHT = 0.0015
const PROGRESS_OFFSET_Y = -0.155

const STATUS_PANEL_WIDTH = 0.18
const STATUS_PANEL_HEIGHT = 0.025
const STATUS_CANVAS_WIDTH = 768
const STATUS_CANVAS_HEIGHT = 96
const STATUS_OFFSET_Y = -0.18

const FADE_DURATION_MS = 800 // matches 2D's `transition: opacity 0.8s ease`

export interface VrLoadingHandle {
  /** Three.js group to add to the scene. */
  readonly group: THREE.Group
  /** Update progress (0-1) and optionally the status text. */
  setProgress(progress: number, status?: string): void
  /** Per-frame animation update — call from the session render loop. */
  update(deltaSeconds: number): void
  /**
   * Begin a fade-out animation; resolves when complete. Caller
   * typically removes + disposes the group right after.
   */
  fadeOut(): Promise<void>
  /** Release every GPU resource. Safe to call multiple times. */
  dispose(): void
}

/** The subtitle's font, at a size in px. */
function subtitleFont(px: number): string {
  return `500 ${px}px system-ui, -apple-system, sans-serif`
}

/** Horizontal room for the subtitle: the canvas less a margin each side. */
const SUBTITLE_MAX_WIDTH = TITLE_CANVAS_WIDTH - 64
/** One-line sizes tried in turn, then two-line sizes. The two-line
 *  sizes are smaller because the pair has to fit below the title in a
 *  192 px canvas. */
const SUBTITLE_ONE_LINE_PX = [32, 28, 24] as const
const SUBTITLE_TWO_LINE_PX = [24, 22, 20] as const

/** How the subtitle is laid out: its lines and their size. `squeeze`
 *  means even the smallest size overflows, so each line is drawn with
 *  `fillText`'s `maxWidth`, which compresses it to fit. */
export interface SubtitleLayout {
  lines: string[]
  px: number
  squeeze: boolean
}

/**
 * Fit the subtitle to {@link SUBTITLE_MAX_WIDTH}: one line at the
 * largest size that fits, else two lines split at the space that
 * balances them, at the largest size that fits, else two lines at the
 * smallest size, squeezed. A node's tagline may be 80 characters, and
 * at the default 32 px a canvas this wide holds about 35 capitals, so
 * drawing it unfitted cut both ends off; squeezing it alone made a
 * long one unreadable. `measure` is the text's width at a size, so the
 * fit is testable without a canvas.
 */
export function fitSubtitle(text: string, measure: (text: string, px: number) => number): SubtitleLayout {
  for (const px of SUBTITLE_ONE_LINE_PX) {
    if (measure(text, px) <= SUBTITLE_MAX_WIDTH) return { lines: [text], px, squeeze: false }
  }
  const words = text.split(' ')
  if (words.length < 2) {
    return { lines: [text], px: SUBTITLE_ONE_LINE_PX[SUBTITLE_ONE_LINE_PX.length - 1], squeeze: true }
  }
  const smallest = SUBTITLE_TWO_LINE_PX[SUBTITLE_TWO_LINE_PX.length - 1]
  let best: [string, string] = [words[0], words.slice(1).join(' ')]
  let bestWidth = Infinity
  for (let i = 1; i < words.length; i++) {
    const pair: [string, string] = [words.slice(0, i).join(' '), words.slice(i).join(' ')]
    const widest = Math.max(measure(pair[0], smallest), measure(pair[1], smallest))
    if (widest < bestWidth) {
      best = pair
      bestWidth = widest
    }
  }
  for (const px of SUBTITLE_TWO_LINE_PX) {
    if (best.every(line => measure(line, px) <= SUBTITLE_MAX_WIDTH)) return { lines: best, px, squeeze: false }
  }
  return { lines: best, px: smallest, squeeze: true }
}

/**
 * Draw the title canvas. "Terraviz" big uppercase + the subtitle in
 * accent (the node's tagline, or "Science On a Sphere") — mirrors the
 * 2D headings.
 */
function drawTitle(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, TITLE_CANVAS_WIDTH, TITLE_CANVAS_HEIGHT)
  ctx.fillStyle = TEXT_COLOR
  ctx.font = '300 88px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Letter-spacing isn't a Canvas2D property — fake it by drawing
  // each letter with a fixed advance. Matches 2D's letter-spacing: 0.25em.
  const titleText = 'TERRAVIZ'
  const letterSpacingPx = 12
  const letterWidth = ctx.measureText('M').width // approx em width
  const totalWidth = titleText.length * (letterWidth * 0.55 + letterSpacingPx)
  let x = TITLE_CANVAS_WIDTH / 2 - totalWidth / 2
  for (const ch of titleText) {
    ctx.fillText(ch, x + (letterWidth * 0.55) / 2, TITLE_CANVAS_HEIGHT / 2 - 8)
    x += letterWidth * 0.55 + letterSpacingPx
  }

  // Subtitle in accent: the same line the 2D splash shows — the
  // node's own tagline, else the `loading.subtitle` default
  // (`splashTagline`). The 2D version applies `text-transform:
  // uppercase`; canvas can't do CSS so we uppercase here. The
  // translated default is cased with the active i18n locale passed
  // explicitly (rather than the host environment's), which is what
  // gets the Turkish dotted/dotless-I case right when the user has
  // picked a locale that differs from the browser default. A node's
  // own tagline is not in that locale — the 2D line is marked
  // `lang=""` for the same reason — so it is cased without one.
  // Scripts without case (Arabic, CJK, etc.) pass through unchanged.
  const subtitle = isNodeTagline()
    ? splashTagline().toUpperCase()
    : splashTagline().toLocaleUpperCase(getLocale())
  ctx.fillStyle = '#4da6ff'
  const layout = fitSubtitle(subtitle, (text, px) => {
    ctx.font = subtitleFont(px)
    return ctx.measureText(text).width
  })
  ctx.font = subtitleFont(layout.px)
  const centreX = TITLE_CANVAS_WIDTH / 2
  const maxWidth = layout.squeeze ? SUBTITLE_MAX_WIDTH : undefined
  if (layout.lines.length === 1) {
    ctx.fillText(layout.lines[0], centreX, TITLE_CANVAS_HEIGHT / 2 + 64, maxWidth)
  } else {
    // Two lines fill the canvas below the title: centres at +54 and
    // +80 keep the pair clear of the title and inside the canvas.
    ctx.fillText(layout.lines[0], centreX, TITLE_CANVAS_HEIGHT / 2 + 54, maxWidth)
    ctx.fillText(layout.lines[1], centreX, TITLE_CANVAS_HEIGHT / 2 + 80, maxWidth)
  }
}

/** Draw the status text canvas. */
function drawStatus(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.clearRect(0, 0, STATUS_CANVAS_WIDTH, STATUS_CANVAS_HEIGHT)
  ctx.fillStyle = TEXT_MUTED
  ctx.font = '400 36px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, STATUS_CANVAS_WIDTH / 2, STATUS_CANVAS_HEIGHT / 2)
}

export function createVrLoading(THREE_: typeof THREE): VrLoadingHandle {
  const group = new THREE_.Group()
  group.position.set(LOADING_POSITION.x, LOADING_POSITION.y, LOADING_POSITION.z)

  // Track materials we need to fade out — collected as we build them.
  const fadeMaterials: THREE.Material[] = []

  // --- Sphere ---
  const sphereGeometry = new THREE_.SphereGeometry(SPHERE_RADIUS, 48, 48)
  const sphereMaterial = new THREE_.MeshStandardMaterial({
    color: SPHERE_COLOR_RIM,
    emissive: SPHERE_COLOR_DEEP,
    emissiveIntensity: 0.6,
    roughness: 0.7,
    metalness: 0.1,
    transparent: true,
  })
  const sphere = new THREE_.Mesh(sphereGeometry, sphereMaterial)
  group.add(sphere)
  fadeMaterials.push(sphereMaterial)

  // Soft point light at the sphere centre so it self-illuminates a bit
  // even in dim AR passthrough scenes (Phase 2.1) where the only
  // ambient comes from the room.
  const sphereLight = new THREE_.PointLight(0x6088ff, 0.5, 0.5)
  sphere.add(sphereLight)

  // --- Outer ring (forward spin) ---
  const outerRingGeometry = new THREE_.TorusGeometry(OUTER_RING_RADIUS, OUTER_RING_TUBE, 8, 64)
  const outerRingMaterial = new THREE_.MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.85,
  })
  const outerRing = new THREE_.Mesh(outerRingGeometry, outerRingMaterial)
  // TorusGeometry default plane is XY; rotate so it faces the user
  // (axis along +Z, viewer looks along -Z).
  outerRing.rotation.x = 0 // already in XY plane
  group.add(outerRing)
  fadeMaterials.push(outerRingMaterial)

  // --- Inner ring (reverse spin, perpendicular axis) ---
  const innerRingGeometry = new THREE_.TorusGeometry(INNER_RING_RADIUS, INNER_RING_TUBE, 8, 64)
  const innerRingMaterial = new THREE_.MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.55,
  })
  const innerRing = new THREE_.Mesh(innerRingGeometry, innerRingMaterial)
  // Rotate 90° around Y so it sits on a perpendicular plane to the
  // outer ring — gives the spatial-ness the 2D design implies.
  innerRing.rotation.y = Math.PI / 2
  group.add(innerRing)
  fadeMaterials.push(innerRingMaterial)

  // --- Title + subtitle panel ---
  const titleCanvas = document.createElement('canvas')
  titleCanvas.width = TITLE_CANVAS_WIDTH
  titleCanvas.height = TITLE_CANVAS_HEIGHT
  const titleCtx = titleCanvas.getContext('2d')
  if (!titleCtx) throw new Error('[VR loading] 2D canvas context unavailable')
  drawTitle(titleCtx)

  const titleTexture = new THREE_.CanvasTexture(titleCanvas)
  titleTexture.colorSpace = THREE_.SRGBColorSpace
  titleTexture.minFilter = THREE_.LinearFilter
  titleTexture.magFilter = THREE_.LinearFilter

  const titleMaterial = new THREE_.MeshBasicMaterial({
    map: titleTexture,
    transparent: true,
    depthTest: false,
  })
  const titlePlane = new THREE_.Mesh(
    new THREE_.PlaneGeometry(TITLE_PANEL_WIDTH, TITLE_PANEL_HEIGHT),
    titleMaterial,
  )
  titlePlane.position.y = TITLE_OFFSET_Y
  titlePlane.renderOrder = 5
  group.add(titlePlane)
  fadeMaterials.push(titleMaterial)

  // --- Progress bar — track + fill, both as plane meshes ---
  const trackGeometry = new THREE_.PlaneGeometry(PROGRESS_WIDTH, PROGRESS_HEIGHT)
  const trackMaterial = new THREE_.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.08,
    depthTest: false,
  })
  const track = new THREE_.Mesh(trackGeometry, trackMaterial)
  track.position.y = PROGRESS_OFFSET_Y
  track.renderOrder = 5
  group.add(track)
  fadeMaterials.push(trackMaterial)

  // Fill mesh: same geometry, scaled X by progress. Pivot anchored at
  // the left edge by translating the geometry once at construction
  // time (so scale.x = 0..1 grows from the left).
  const fillGeometry = new THREE_.PlaneGeometry(PROGRESS_WIDTH, PROGRESS_HEIGHT)
  fillGeometry.translate(PROGRESS_WIDTH / 2, 0, 0)
  const fillMaterial = new THREE_.MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  })
  const fill = new THREE_.Mesh(fillGeometry, fillMaterial)
  // Position the left edge at -PROGRESS_WIDTH/2 in world (matches track).
  fill.position.x = -PROGRESS_WIDTH / 2
  fill.position.y = PROGRESS_OFFSET_Y
  fill.position.z = 0.0001 // slightly in front of track to avoid z-fight
  fill.scale.x = 0
  fill.renderOrder = 6
  group.add(fill)
  fadeMaterials.push(fillMaterial)

  // --- Status text panel ---
  const statusCanvas = document.createElement('canvas')
  statusCanvas.width = STATUS_CANVAS_WIDTH
  statusCanvas.height = STATUS_CANVAS_HEIGHT
  const statusCtx = statusCanvas.getContext('2d')
  if (!statusCtx) throw new Error('[VR loading] 2D canvas context unavailable')
  drawStatus(statusCtx, 'Initializing\u2026')

  const statusTexture = new THREE_.CanvasTexture(statusCanvas)
  statusTexture.colorSpace = THREE_.SRGBColorSpace
  statusTexture.minFilter = THREE_.LinearFilter
  statusTexture.magFilter = THREE_.LinearFilter

  const statusMaterial = new THREE_.MeshBasicMaterial({
    map: statusTexture,
    transparent: true,
    depthTest: false,
  })
  const statusPlane = new THREE_.Mesh(
    new THREE_.PlaneGeometry(STATUS_PANEL_WIDTH, STATUS_PANEL_HEIGHT),
    statusMaterial,
  )
  statusPlane.position.y = STATUS_OFFSET_Y
  statusPlane.renderOrder = 5
  group.add(statusPlane)
  fadeMaterials.push(statusMaterial)

  // --- Animation state ---
  let elapsedSeconds = 0
  /** Target progress (0-1). Animated toward by `displayedProgress`. */
  let targetProgress = 0
  /** What's currently shown on the bar — eased toward target each frame. */
  let displayedProgress = 0
  let lastStatus = 'Initializing\u2026'

  /** Active fade tween, if any. */
  let fadeStart: number | null = null
  let fadePromise: { resolve: () => void } | null = null

  return {
    group,

    setProgress(progress, status) {
      targetProgress = Math.max(0, Math.min(1, progress))
      if (status !== undefined && status !== lastStatus) {
        lastStatus = status
        drawStatus(statusCtx, status)
        statusTexture.needsUpdate = true
      }
    },

    update(deltaSeconds) {
      elapsedSeconds += deltaSeconds

      // Outer ring spin (forward).
      outerRing.rotation.z = (elapsedSeconds / OUTER_RING_PERIOD_S) * Math.PI * 2
      // Inner ring spin (reverse, around its own local axis = world Y after the X-axis tilt).
      innerRing.rotation.x = -(elapsedSeconds / INNER_RING_PERIOD_S) * Math.PI * 2

      // Sphere pulse — emissive intensity oscillates between 0.4 and 1.0.
      const phase = (elapsedSeconds / SPHERE_PULSE_PERIOD_S) * Math.PI * 2
      const pulse = (Math.sin(phase) + 1) / 2 // 0..1
      sphereMaterial.emissiveIntensity = 0.4 + 0.6 * pulse

      // Smoothly ease displayed progress toward target.
      // Frame-rate independent lerp via 1 - exp(-rate * dt).
      const easeRate = 6 // higher = snappier
      displayedProgress += (targetProgress - displayedProgress) *
        (1 - Math.exp(-easeRate * deltaSeconds))
      fill.scale.x = Math.max(0.0001, displayedProgress)

      // Fade-out animation.
      if (fadeStart !== null) {
        const fadeProgress = (elapsedSeconds * 1000 - fadeStart) / FADE_DURATION_MS
        const opacity = Math.max(0, 1 - fadeProgress)
        // Apply opacity uniformly to everything that's transparent.
        for (const mat of fadeMaterials) {
          // Scale base opacities so initial differences (e.g. inner ring
          // is 0.55) are preserved through the fade.
          const baseOpacity = mat.userData.baseOpacity ?? mat.opacity
          if (mat.userData.baseOpacity === undefined) {
            mat.userData.baseOpacity = baseOpacity
          }
          mat.opacity = (mat.userData.baseOpacity as number) * opacity
        }
        if (fadeProgress >= 1) {
          fadeStart = null
          group.visible = false
          fadePromise?.resolve()
          fadePromise = null
        }
      }
    },

    fadeOut() {
      return new Promise<void>(resolve => {
        if (fadeStart !== null) {
          // Already fading — just chain.
          const prev = fadePromise?.resolve
          fadePromise = {
            resolve: () => { prev?.(); resolve() },
          }
          return
        }
        fadeStart = elapsedSeconds * 1000
        fadePromise = { resolve }
      })
    },

    dispose() {
      sphereGeometry.dispose()
      sphereMaterial.dispose()
      outerRingGeometry.dispose()
      outerRingMaterial.dispose()
      innerRingGeometry.dispose()
      innerRingMaterial.dispose()
      titleTexture.dispose()
      titleMaterial.dispose()
      ;(titlePlane.geometry as THREE.BufferGeometry).dispose()
      trackGeometry.dispose()
      trackMaterial.dispose()
      fillGeometry.dispose()
      fillMaterial.dispose()
      statusTexture.dispose()
      statusMaterial.dispose()
      ;(statusPlane.geometry as THREE.BufferGeometry).dispose()
    },
  }
}
