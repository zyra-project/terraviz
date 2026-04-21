/**
 * In-VR tour overlay manager — floating CanvasTexture panels that
 * replace the 2D tour-overlay DOM surface (`src/ui/tourUI.ts`) while
 * the user is inside a WebXR session.
 *
 * This is the scaffold (Phase 3.5 commit 2):
 *
 * - A parent `THREE.Group` hosts every tour overlay mesh; `vrSession`
 *   adds the group once and everything inside tracks automatically.
 * - The text overlay type is implemented end-to-end (panel mesh,
 *   CanvasTexture drawing, title + body + close affordance) as the
 *   prototype for the other overlay types landing in later commits
 *   (image, video, popup, interactive question).
 * - Two anchor modes — world-anchored (overlay position follows the
 *   globe in world space; matches how the HUD and browse panel
 *   track the placed globe in AR) and gaze-follow (overlay rides
 *   in front of the user's head, subtitle-style). Both ship together
 *   per the locked-in Phase 3.5 decision.
 * - No tour engine wiring yet — that lands in commit 4. The public
 *   API is deliberately shaped around the tour-task params
 *   (`ShowRectTaskParams` and friends in `src/types/index.ts`) so
 *   hooking the engine up later is a plumbing change rather than a
 *   rework of this module.
 *
 * The close affordance is rendered but not yet raycastable; the
 * controller hit-test wiring comes in commit 6 alongside interactive
 * questions, which need the same pattern.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}
 * Phase 3.5 section.
 */

import type * as THREE from 'three'
import type { ShowPopupHtmlTaskParams, ShowRectTaskParams } from '../types'

/**
 * Anchor mode for a single overlay. Controls how the per-frame
 * `update()` call positions and orients the panel.
 *
 * - `world` — position is fixed in world space, offset from the
 *   globe. When the user places the globe on a real surface in AR
 *   the overlay moves with it, so a caption that says "Pacific
 *   Ocean" stays anchored to the side of the globe rather than
 *   drifting in mid-air. Overlays billboard toward the camera each
 *   frame so the text is always readable head-on.
 * - `gaze` — position is resolved in camera-local space each frame,
 *   so the overlay trails the user's head. Lerped (not hard-locked)
 *   so slight head motion doesn't shake the panel. Matches the
 *   "subtitle rail" pattern used by movie captioning in VR apps.
 */
export type VrTourAnchorMode = 'world' | 'gaze'

/**
 * A caller-supplied anchor override for a specific overlay. When
 * omitted, the manager's current default (set via
 * `setGazeFollowDefault`) is used. The offset is interpreted
 * differently per mode:
 *
 * - `world`: offset is in world axes relative to the globe's
 *   position. A positive y lifts the overlay above the globe, a
 *   positive x puts it to the globe's right from the user's default
 *   viewpoint. No implicit depth pullback — world-anchored panels
 *   are visible because they're near the globe, not because they're
 *   in front of the user.
 * - `gaze`: offset is in camera-local axes. +x = right, +y = up,
 *   -z = forward (Three.js convention). The default offset pulls
 *   the panel ~1.4 m in front of the camera and slightly below eye
 *   level so it doesn't occlude the globe.
 */
export interface VrTourAnchor {
  mode: VrTourAnchorMode
  offset?: { x: number; y: number; z: number }
}

/**
 * Subset of {@link ShowRectTaskParams} that the text-overlay path
 * consumes. Kept as a structural subset so the tour-engine wiring
 * (commit 4) can pass the task params through unchanged.
 *
 * Extra `anchor` + `size` fields let the caller override the
 * default pose / geometry. Both are optional; callers that don't
 * care get sensible defaults.
 *
 * Note — the 2D `xPct` / `yPct` / `widthPct` / `heightPct` fields
 * from the tour JSON are intentionally NOT consumed here: the
 * screen-percentage coordinate system doesn't translate to a
 * free-floating 3D panel, and using them would force us into the
 * tour author's screen-layout thinking when we have 6DoF available.
 * Anchoring is driven by `anchor` instead.
 */
export interface VrTourTextParams
  extends Pick<ShowRectTaskParams,
    'rectID' | 'caption' | 'fontSize' | 'fontColor' | 'isClosable' | 'showBorder'
  > {
  anchor?: VrTourAnchor
  /** World-space size of the panel. Defaults to a portrait 0.6 × 0.36 m rectangle. */
  size?: { width: number; height: number }
}

/**
 * Subset of {@link ShowPopupHtmlTaskParams} consumed by the popup
 * overlay path. The 2D DOM path renders an iframe for `url` popups
 * (sandboxed; tour-author-controlled `allowScripts`) and an srcdoc-
 * iframe for `html` popups. Neither translates to a canvas panel —
 * iframes can't be drawn into a CanvasTexture and third-party
 * content can't be captured across the cross-origin boundary.
 *
 * VR-side strategy (v1): treat popups as extended text panels.
 *
 * - `html` payloads are stripped of tags and rendered as plain
 *   text on a larger panel than `showRect` caption boxes. Most
 *   SOS popup usage is short descriptive copy; for those, the
 *   plain-text render reads naturally.
 * - `url` payloads are unreachable in VR (we can't embed a live
 *   iframe). The panel shows the URL with a "view in 2D" prompt
 *   so the user knows exit-and-reopen is how to read it.
 *
 * Richer rendering (headless iframe → canvas capture, markdown
 * parser, image embeds) is layered on as a follow-up once we see
 * which popup variants in-tree tours actually use.
 */
export interface VrTourPopupParams
  extends Pick<ShowPopupHtmlTaskParams,
    'popupID' | 'url' | 'html'
  > {
  anchor?: VrTourAnchor
  /** World-space size of the panel. Defaults are larger than text overlays to fit denser content. */
  size?: { width: number; height: number }
}

/**
 * Classification of overlay meshes so per-kind bulk operations
 * (`hideAllText`, `hideAllPopups`, …) can filter the single
 * overlay map without maintaining a second per-kind index. Extended
 * alongside each future overlay type (image/video/question) as
 * those commits land.
 */
export type VrTourOverlayKind = 'text' | 'popup'

/** Every mesh carries its overlay id + mode so per-frame pose resolution is keyed off userData. */
interface OverlayUserData {
  overlayId: string
  kind: VrTourOverlayKind
  anchor: VrTourAnchor
  /** World-space offset for `world` mode; zero for `gaze`. Kept materialized to avoid allocations. */
  worldOffset: THREE.Vector3
  /** Camera-local offset for `gaze` mode; zero for `world`. */
  gazeOffset: THREE.Vector3
  /** Close-button UV rect, or null if the overlay isn't closable. Populated by drawText. */
  closeUv: { uMin: number; uMax: number; vMin: number; vMax: number } | null
}

/**
 * Public handle returned by {@link createVrTourOverlay}. The caller
 * (`vrSession`) adds {@link group} to the scene once, pushes
 * overlays through `show*` / `hide*`, calls `update` once per
 * frame, and finally `dispose` on session end.
 */
export interface VrTourOverlayHandle {
  readonly group: THREE.Group
  showText(params: VrTourTextParams): void
  /**
   * Render a tour popup panel. Thin wrapper on the same mesh / canvas
   * pipeline as `showText` — differences are the default panel size
   * (larger) and the canvas-drawing routine (prefixes URL popups with
   * a "view in 2D" prompt when no HTML body is available). The two
   * overlay kinds share an id space, so you can mix them freely; a
   * `popupID` and a `rectID` with the same string value would collide
   * (tour authors don't do this in practice).
   */
  showPopup(params: VrTourPopupParams): void
  hideOverlay(id: string): void
  hideAll(): void
  /** Remove every text overlay; leaves popups, images, videos, questions untouched. */
  hideAllText(): void
  /** Remove every popup overlay. */
  hideAllPopups(): void
  /**
   * Toggle the default anchor mode used when an overlay arrives
   * without an explicit `anchor` hint. Persists until flipped;
   * overlays already on screen keep their anchor (authors who tag
   * specific overlays shouldn't see their positions change when a
   * global toggle flips).
   */
  setGazeFollowDefault(enabled: boolean): void
  /** Current default mode — exposed so the HUD toggle can reflect it. */
  getGazeFollowDefault(): boolean
  /**
   * Per-frame positioning pass. `globePosition` drives world-anchor
   * placement; `camera` drives gaze-follow and also provides the
   * billboard target for world-anchored panels. `delta` in seconds
   * drives the gaze-follow lerp smoothing.
   */
  update(camera: THREE.Camera, globePosition: THREE.Vector3, delta: number): void
  dispose(): void
}

// ── Visual constants ───────────────────────────────────────────────

/** Default panel world-size — wide enough for a paragraph, tall enough for 4–5 lines. */
const DEFAULT_PANEL_WIDTH = 0.6
const DEFAULT_PANEL_HEIGHT = 0.36

/**
 * Popups get a larger default plane than text overlays — they carry
 * denser copy (paragraphs, attribution, external-link prompts) and
 * a wider reading width reduces line-wrap thrash when authors paste
 * marketing-style blurbs. Not so large they dominate the field of
 * view next to the globe; matches the footprint of the browse panel
 * (0.8 × 0.6 m).
 */
const POPUP_PANEL_WIDTH = 0.8
const POPUP_PANEL_HEIGHT = 0.5

/** Canvas pixel dimensions. 5:3 aspect matches the default 0.6 × 0.36 m plane. */
const CANVAS_WIDTH = 1000
const CANVAS_HEIGHT = 600

/** Colors — keep in sync with src/styles/tokens.css glass surface vars. */
const BG_COLOR = 'rgba(13, 13, 18, 0.88)'
const BORDER_COLOR = 'rgba(255, 255, 255, 0.15)'
const BORDER_DIM = 'rgba(255, 255, 255, 0.06)'
const TEXT_COLOR = '#e8eaf0'
const CLOSE_COLOR = 'rgba(232, 234, 240, 0.85)'

const CANVAS_PADDING = 36
const TITLE_BAR_HEIGHT = 0 // reserved for overlay-type-specific headers (image overlay, question) added later
const CLOSE_BUTTON_SIZE = 48
const CLOSE_BUTTON_MARGIN = 10

// ── Defaults for anchor modes ──────────────────────────────────────

/**
 * World-anchored default offset from the globe: above-right of the
 * globe at eye level, slightly pulled toward the user so it reads
 * as "floating near the Earth" rather than intersecting it. Matches
 * the spatial feel of the browse panel's offset from the globe.
 */
const DEFAULT_WORLD_OFFSET = { x: 0.6, y: 0.2, z: 0.15 }

/**
 * Gaze-follow default offset in camera-local axes: in front of the
 * user at subtitle distance, a touch below the viewing axis so it
 * doesn't occlude whatever the user is looking at. -z is forward
 * in Three.js camera space.
 */
const DEFAULT_GAZE_OFFSET = { x: 0, y: -0.15, z: -1.4 }

/** Lerp factor for gaze-follow smoothing. 0 = locked rigidly, 1 = no smoothing. Per-second, compounded by delta. */
const GAZE_LERP_RATE = 6.0

// ── Markup → plain text ────────────────────────────────────────────

/**
 * Strip the SOS caption markup down to plain text. The 2D path
 * (src/ui/tourUI.ts) renders `<i>…</i>` as italic and
 * `<color=…>…</color>` as styled spans via HTML; VR renders onto
 * a canvas, so for v1 we strip tags and render plain text. Italic
 * / colored runs on canvas would need segmented drawing (split
 * into runs with different fillStyle/font) — worth adding later
 * if testers flag it, but every in-tree tour reads fine without.
 *
 * The escape sequence `\n` (two characters) is honored as a real
 * newline, matching tour-author expectations.
 */
function stripCaptionMarkup(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/<i>/gi, '')
    .replace(/<\/i>/gi, '')
    .replace(/<color=[^>]+>/gi, '')
    .replace(/<\/color>/gi, '')
}

/**
 * Very coarse HTML → plain-text conversion for popup bodies. Strips
 * tags, collapses whitespace, decodes a handful of common named /
 * numeric entities. Not a full HTML parser; tour popups in the wild
 * are short descriptive blurbs, not complex markup. If a popup in
 * the field shows up mangled, we upgrade to a proper parser then.
 */
function htmlToPlainText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Word-wrap plain text to a max pixel width, returning the laid-out
 * lines. Respects hard newlines from the caption. Bails out if a
 * single word doesn't fit rather than overflowing the panel — the
 * word is truncated with an ellipsis so at least the first syllables
 * are readable.
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const hardLines = text.split('\n')
  const out: string[] = []
  for (const hard of hardLines) {
    if (!hard) {
      out.push('')
      continue
    }
    const words = hard.split(/\s+/)
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate
        continue
      }
      if (current) out.push(current)
      // Word too wide to fit on its own: truncate it character-by-
      // character with an ellipsis. Rare with typical captions.
      if (ctx.measureText(word).width > maxWidth) {
        let truncated = word
        while (truncated.length > 2 && ctx.measureText(`${truncated}…`).width > maxWidth) {
          truncated = truncated.slice(0, -1)
        }
        out.push(`${truncated}…`)
        current = ''
      } else {
        current = word
      }
    }
    if (current) out.push(current)
  }
  return out
}

// ── Canvas drawing: text overlay ───────────────────────────────────

/**
 * Fallback rounded-rect for Canvas 2D contexts without the
 * `roundRect` method (older Chromium / Quest Browser builds). Same
 * pattern as vrBrowse.ts's `fillRoundRect`.
 */
function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
    ctx.fill()
  } else {
    ctx.fillRect(x, y, w, h)
  }
}

/**
 * Sanitize a caller-supplied color to something safe to feed into
 * `fillStyle`. Accepts hex, named colors, rgb/rgba/hsl/hsla. Returns
 * null on failure so the caller can fall back to the default. Mirror
 * of the 2D path's `sanitizeCaptionColor`.
 */
function sanitizeCaptionColor(raw: string | undefined): string | null {
  if (!raw) return null
  const color = raw.trim()
  if (/^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%]+\))$/i.test(color)) {
    return color
  }
  return null
}

/**
 * Shared canvas shell used by every text-based overlay type (text,
 * popup for now — image caption, question prompt once those land).
 * Paints the glass background + border, wraps + draws the body
 * text, and adds a close X in the top-right when requested. Returns
 * the close-button UV rect (null if not closable) so the caller
 * can stash it in userData for the controller hit-test wired up in
 * commit 6.
 *
 * Decoupled from the caller's param shape so text overlays and
 * popups can share the same renderer without forcing a
 * `VrTourTextParams` cast in the popup path.
 */
function drawTextPanel(
  ctx: CanvasRenderingContext2D,
  body: string,
  opts: {
    fontColor?: string
    fontSize?: number
    showBorder?: boolean
    isClosable?: boolean
    /** Dimmed secondary line rendered above the body (e.g. "Open in 2D to view"). */
    header?: string
  },
): { uMin: number; uMax: number; vMin: number; vMax: number } | null {
  const w = CANVAS_WIDTH
  const h = CANVAS_HEIGHT
  ctx.clearRect(0, 0, w, h)

  // Background + border — glass surface.
  ctx.fillStyle = BG_COLOR
  fillRoundRect(ctx, 0, 0, w, h, 18)
  ctx.strokeStyle = opts.showBorder ? BORDER_COLOR : BORDER_DIM
  ctx.lineWidth = 2
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(1, 1, w - 2, h - 2, 17)
    ctx.stroke()
  } else {
    ctx.strokeRect(1, 1, w - 2, h - 2)
  }

  // Body text area. Accounts for the optional close-button column
  // so long lines don't collide with the X.
  const textColor = sanitizeCaptionColor(opts.fontColor) ?? TEXT_COLOR
  const bodyFontPx = Math.round(opts.fontSize ? Math.max(22, Math.min(44, opts.fontSize * 0.7)) : 36)
  ctx.fillStyle = textColor
  ctx.font = `500 ${bodyFontPx}px system-ui, -apple-system, sans-serif`
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'

  const textLeft = CANVAS_PADDING
  const textRight = w - CANVAS_PADDING - (opts.isClosable ? CLOSE_BUTTON_SIZE : 0)
  const textWidth = textRight - textLeft

  // Optional dimmed header (used by URL-only popups to hint at the
  // 2D-only fallback). Rendered smaller and with reduced contrast
  // so it reads as metadata, not primary content.
  const headerFontPx = Math.round(bodyFontPx * 0.66)
  const headerLineHeight = headerFontPx * 1.2
  let headerLines: string[] = []
  if (opts.header) {
    ctx.font = `500 ${headerFontPx}px system-ui, -apple-system, sans-serif`
    headerLines = wrapText(ctx, opts.header, textWidth)
  }

  ctx.font = `500 ${bodyFontPx}px system-ui, -apple-system, sans-serif`
  const bodyLines = wrapText(ctx, body, textWidth)

  const lineHeight = bodyFontPx * 1.3
  const bodyHeight = bodyLines.length * lineHeight
  const headerBlockHeight = headerLines.length > 0
    ? headerLines.length * headerLineHeight + headerLineHeight * 0.6
    : 0
  const totalHeight = headerBlockHeight + bodyHeight

  // Vertical centering — looks better than top-aligned for short
  // captions that only fill the top third of the panel.
  const textTop = TITLE_BAR_HEIGHT + Math.max(
    CANVAS_PADDING,
    (h - TITLE_BAR_HEIGHT - totalHeight) / 2,
  )

  // Draw header first so body starts beneath it.
  if (headerLines.length > 0) {
    ctx.fillStyle = 'rgba(232, 234, 240, 0.55)'
    ctx.font = `500 ${headerFontPx}px system-ui, -apple-system, sans-serif`
    for (let i = 0; i < headerLines.length; i++) {
      ctx.fillText(headerLines[i], textLeft, textTop + i * headerLineHeight)
    }
    ctx.fillStyle = textColor
    ctx.font = `500 ${bodyFontPx}px system-ui, -apple-system, sans-serif`
  }
  const bodyTop = textTop + headerBlockHeight
  for (let i = 0; i < bodyLines.length; i++) {
    ctx.fillText(bodyLines[i], textLeft, bodyTop + i * lineHeight)
  }

  if (!opts.isClosable) return null

  // Close X in the top-right corner. Pixel geometry tracked so the
  // UV rect we return matches the drawn glyph exactly — the
  // controller hit-test in commit 6 will rely on it.
  const closePxMinX = w - CANVAS_PADDING - CLOSE_BUTTON_SIZE / 2 - CLOSE_BUTTON_MARGIN
  const closePxMinY = CLOSE_BUTTON_MARGIN
  const closePxMaxX = closePxMinX + CLOSE_BUTTON_SIZE
  const closePxMaxY = closePxMinY + CLOSE_BUTTON_SIZE
  const cx = (closePxMinX + closePxMaxX) / 2
  const cy = (closePxMinY + closePxMaxY) / 2
  ctx.strokeStyle = CLOSE_COLOR
  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  const arm = 14
  ctx.beginPath()
  ctx.moveTo(cx - arm, cy - arm)
  ctx.lineTo(cx + arm, cy + arm)
  ctx.moveTo(cx + arm, cy - arm)
  ctx.lineTo(cx - arm, cy + arm)
  ctx.stroke()

  // UV = (x / w, 1 - y / h); flip v because Three.js PlaneGeometry
  // maps v=0 at the bottom but canvas y grows downward.
  return {
    uMin: closePxMinX / w,
    uMax: closePxMaxX / w,
    vMin: 1 - closePxMaxY / h,
    vMax: 1 - closePxMinY / h,
  }
}

// ── Per-overlay mesh lifecycle ─────────────────────────────────────

interface ManagedOverlay {
  mesh: THREE.Mesh
  canvas: HTMLCanvasElement
  ctx2d: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
  material: THREE.MeshBasicMaterial
  geometry: THREE.PlaneGeometry
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Build the tour overlay manager. Caller is responsible for adding
 * {@link VrTourOverlayHandle.group} to the scene, driving
 * `update()` each frame, and calling `dispose()` on session end.
 */
export function createVrTourOverlay(THREE_: typeof THREE): VrTourOverlayHandle {
  const group = new THREE_.Group()
  group.name = 'vr-tour-overlays'

  /** Keyed by overlay id. Map preserves insertion order → render order. */
  const overlays = new Map<string, ManagedOverlay>()
  let gazeFollowDefault = false

  /**
   * Scratch vectors + quaternions reused across `update` calls so
   * the per-frame pose pass doesn't allocate. Shared across all
   * overlays — update processes them one at a time.
   */
  const scratchTarget = new THREE_.Vector3()
  const scratchCamPos = new THREE_.Vector3()
  const scratchRight = new THREE_.Vector3()
  const scratchUp = new THREE_.Vector3()
  const scratchForward = new THREE_.Vector3()

  function buildMeshForOverlay(
    id: string,
    kind: VrTourOverlayKind,
    size: { width: number; height: number },
    anchor: VrTourAnchor,
  ): ManagedOverlay {
    const canvas = document.createElement('canvas')
    canvas.width = CANVAS_WIDTH
    canvas.height = CANVAS_HEIGHT
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) throw new Error('[VR Tour] 2D canvas context unavailable')

    const texture = new THREE_.CanvasTexture(canvas)
    texture.colorSpace = THREE_.SRGBColorSpace
    texture.minFilter = THREE_.LinearFilter
    texture.magFilter = THREE_.LinearFilter

    const material = new THREE_.MeshBasicMaterial({
      map: texture,
      transparent: true,
      // Same rationale as vrHud.ts / vrBrowse.ts — UI panels should
      // always draw on top regardless of z-coincidence with globe
      // geometry. renderOrder > 0 pushes them after scene content.
      depthTest: false,
      depthWrite: false,
    })
    const geometry = new THREE_.PlaneGeometry(size.width, size.height)
    const mesh = new THREE_.Mesh(geometry, material)
    mesh.renderOrder = 8

    const worldOffset = new THREE_.Vector3(
      anchor.mode === 'world' ? (anchor.offset?.x ?? DEFAULT_WORLD_OFFSET.x) : 0,
      anchor.mode === 'world' ? (anchor.offset?.y ?? DEFAULT_WORLD_OFFSET.y) : 0,
      anchor.mode === 'world' ? (anchor.offset?.z ?? DEFAULT_WORLD_OFFSET.z) : 0,
    )
    const gazeOffset = new THREE_.Vector3(
      anchor.mode === 'gaze' ? (anchor.offset?.x ?? DEFAULT_GAZE_OFFSET.x) : 0,
      anchor.mode === 'gaze' ? (anchor.offset?.y ?? DEFAULT_GAZE_OFFSET.y) : 0,
      anchor.mode === 'gaze' ? (anchor.offset?.z ?? DEFAULT_GAZE_OFFSET.z) : 0,
    )
    const userData: OverlayUserData = {
      overlayId: id,
      kind,
      anchor,
      worldOffset,
      gazeOffset,
      closeUv: null,
    }
    mesh.userData = userData

    return { mesh, canvas, ctx2d, texture, material, geometry }
  }

  function disposeOverlay(managed: ManagedOverlay): void {
    group.remove(managed.mesh)
    managed.texture.dispose()
    managed.material.dispose()
    managed.geometry.dispose()
  }

  function resolveAnchor(explicit: VrTourAnchor | undefined): VrTourAnchor {
    if (explicit) return explicit
    return { mode: gazeFollowDefault ? 'gaze' : 'world' }
  }

  return {
    group,

    showText(params) {
      // Replace any existing overlay with the same id so re-shows
      // during the same tour step (or engine retry paths) don't
      // stack meshes.
      const existing = overlays.get(params.rectID)
      if (existing) {
        disposeOverlay(existing)
        overlays.delete(params.rectID)
      }

      const size = params.size ?? { width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT }
      const anchor = resolveAnchor(params.anchor)
      const managed = buildMeshForOverlay(params.rectID, 'text', size, anchor)

      const closeUv = drawTextPanel(managed.ctx2d, stripCaptionMarkup(params.caption), {
        fontColor: params.fontColor,
        fontSize: params.fontSize,
        showBorder: params.showBorder,
        isClosable: params.isClosable,
      })
      managed.texture.needsUpdate = true
      const ud = managed.mesh.userData as OverlayUserData
      ud.closeUv = closeUv

      group.add(managed.mesh)
      overlays.set(params.rectID, managed)
    },

    showPopup(params) {
      // Same replace-by-id discipline as showText — tour authors may
      // re-fire showPopupHtml with the same popupID to refresh
      // content without an explicit hide first.
      const existing = overlays.get(params.popupID)
      if (existing) {
        disposeOverlay(existing)
        overlays.delete(params.popupID)
      }

      const size = params.size ?? { width: POPUP_PANEL_WIDTH, height: POPUP_PANEL_HEIGHT }
      const anchor = resolveAnchor(params.anchor)
      const managed = buildMeshForOverlay(params.popupID, 'popup', size, anchor)

      // Three rendering cases:
      //   1. `html` present — strip tags + render as plain text.
      //   2. `url` present, no `html` — can't embed a live iframe in
      //      a CanvasTexture, so show a 2D-fallback prompt with the
      //      URL itself so the user knows what to revisit.
      //   3. Neither — author error; show a placeholder so the
      //      overlay is still visible (easier to spot than silent).
      let body: string
      let header: string | undefined
      if (params.html) {
        body = htmlToPlainText(params.html)
      } else if (params.url) {
        header = 'Open in 2D view to interact with this content'
        body = params.url
      } else {
        body = '(No popup content)'
      }

      const closeUv = drawTextPanel(managed.ctx2d, body, {
        isClosable: true,
        header,
      })
      managed.texture.needsUpdate = true
      const ud = managed.mesh.userData as OverlayUserData
      ud.closeUv = closeUv

      group.add(managed.mesh)
      overlays.set(params.popupID, managed)
    },

    hideOverlay(id) {
      const existing = overlays.get(id)
      if (!existing) return
      disposeOverlay(existing)
      overlays.delete(id)
    },

    hideAll() {
      for (const managed of overlays.values()) disposeOverlay(managed)
      overlays.clear()
    },

    hideAllText() {
      // Two-pass to avoid mutating the map under iteration.
      const ids: string[] = []
      for (const [id, managed] of overlays) {
        if ((managed.mesh.userData as OverlayUserData).kind === 'text') ids.push(id)
      }
      for (const id of ids) {
        const managed = overlays.get(id)
        if (managed) disposeOverlay(managed)
        overlays.delete(id)
      }
    },

    hideAllPopups() {
      const ids: string[] = []
      for (const [id, managed] of overlays) {
        if ((managed.mesh.userData as OverlayUserData).kind === 'popup') ids.push(id)
      }
      for (const id of ids) {
        const managed = overlays.get(id)
        if (managed) disposeOverlay(managed)
        overlays.delete(id)
      }
    },

    setGazeFollowDefault(enabled) {
      gazeFollowDefault = enabled
    },

    getGazeFollowDefault() {
      return gazeFollowDefault
    },

    update(camera, globePosition, delta) {
      if (overlays.size === 0) return

      // Camera world position + basis vectors, resolved once per
      // frame and reused across every overlay.
      camera.getWorldPosition(scratchCamPos)
      // Three.js cameras look down -z; matrixWorld's columns give
      // us the world-space basis. Extract right / up / forward so
      // gaze-follow offsets can be applied without re-fetching the
      // matrix per overlay.
      const e = camera.matrixWorld.elements
      scratchRight.set(e[0], e[1], e[2])
      scratchUp.set(e[4], e[5], e[6])
      // Forward is -z of the camera, so flip the third column.
      scratchForward.set(-e[8], -e[9], -e[10])

      for (const managed of overlays.values()) {
        const ud = managed.mesh.userData as OverlayUserData
        if (ud.anchor.mode === 'world') {
          // World-anchored: glue position to the globe with the
          // overlay's offset. Billboard toward the camera so text
          // stays readable regardless of where the user stands.
          scratchTarget.copy(globePosition).add(ud.worldOffset)
          managed.mesh.position.copy(scratchTarget)
          managed.mesh.lookAt(scratchCamPos)
        } else {
          // Gaze-follow: target = camera origin + camera-local
          // offset applied through the camera's world basis. Lerp
          // toward the target instead of snapping so natural head
          // motion doesn't produce a rigidly-locked subtitle bar.
          scratchTarget.copy(scratchCamPos)
            .addScaledVector(scratchRight, ud.gazeOffset.x)
            .addScaledVector(scratchUp, ud.gazeOffset.y)
            // gazeOffset uses the Three.js camera-local convention where
            // -z is forward, so we negate .z when projecting along the
            // world-space forward vector.
            .addScaledVector(scratchForward, -ud.gazeOffset.z)
          const t = 1 - Math.exp(-GAZE_LERP_RATE * delta)
          managed.mesh.position.lerp(scratchTarget, t)
          managed.mesh.lookAt(scratchCamPos)
        }
      }
    },

    dispose() {
      for (const managed of overlays.values()) disposeOverlay(managed)
      overlays.clear()
    },
  }
}
