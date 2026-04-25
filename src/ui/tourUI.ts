/**
 * Tour UI — manages the tour control bar and all overlay types.
 *
 * Overlay types:
 * - Text boxes (showRect / hideRect) — positioned captions
 * - Images (showImage / hideImage) — positioned image overlays
 * - Videos (playVideo / hideVideo) — positioned video players
 * - Popups (showPopupHtml / hidePopupHtml) — URL or inline HTML
 * - Questions (question) — image-based multiple-choice Q&A
 *
 * All overlays use the SOS coordinate system where (0,0) is bottom-left
 * and (100,100) is top-right.
 */

import type {
  ShowRectTaskParams, ShowImageTaskParams, PlayVideoTaskParams,
  ShowPopupHtmlTaskParams, QuestionTaskParams, TourOverlayAnchor,
} from '../types'
import type { TourEngine } from '../services/tourEngine'

// ── VR tour overlay mirror ──────────────────────────────────────────
//
// While a WebXR session is live, the 2D DOM overlays are invisible
// (hidden behind the headset output) but still rendered — the tour
// engine doesn't know VR is active, so it calls the same show/hide
// functions exported from this module. We mirror every call onto an
// optional `VrTourOverlaySink` so the VR layer can render equivalent
// CanvasTexture panels in the 3D scene.
//
// The sink is set by `vrSession` on session entry and cleared on
// session end. Mirroring is one-way (DOM → VR) and additive — the
// DOM overlays keep rendering in the background so the 2D experience
// resumes seamlessly when the user exits VR mid-tour.

/**
 * Subset of tour overlay ops mirrored into VR. Methods accept the
 * same param shapes as the DOM-side show/hide functions below so
 * wiring is a direct pass-through. Optional fields let the sink
 * implement overlay kinds incrementally as later Phase 3.5 commits
 * bring image / video / question variants online.
 */
export interface VrTourOverlaySink {
  showText(params: ShowRectTaskParams): void
  hideText(rectID: string): void
  hideAllText(): void
  showPopup(params: ShowPopupHtmlTaskParams): void
  hidePopup(popupID: string): void
  hideAllPopups(): void
  showImage(params: ShowImageTaskParams): void
  hideImage(imageID: string): void
  hideAllImages(): void
  /**
   * Shares the DOM `<video>` element the 2D tour layer just
   * created. VR wraps it in a `THREE.VideoTexture` so both paths
   * render from the same decoded stream — no double decode, no
   * second autoplay fight. The video id (second arg) matches the
   * 2D convention of using the resolved filename URL.
   */
  showVideo(params: PlayVideoTaskParams, video: HTMLVideoElement, videoID: string): void
  hideVideo(videoID: string): void
  hideAllVideos(): void
  /**
   * Interactive question overlay. Params are the already-resolved
   * URLs plus the engine's `onComplete` (already wrapped by
   * {@link showTourQuestion} to also clean up the 2D DOM when VR's
   * Continue button fires). `anchor` threads the optional VR
   * placement override from the tour JSON through to the overlay
   * manager.
   */
  showQuestion(params: {
    id: string
    questionImageUrl: string
    answerImageUrl: string
    numberOfAnswers: number
    correctAnswerIndex: number
    anchor?: TourOverlayAnchor
    onComplete: () => void
    /** Telemetry hook — fires the moment the user picks an answer
     * in VR. The 2D sibling fires the same hook through tourUI;
     * the engine dedupes so the event lands once per question. */
    onAnswered?: (chosenIndex: number) => void
  }): void
  hideAllQuestions(): void
}

let vrOverlaySink: VrTourOverlaySink | null = null

// Active-overlay registries keyed by overlay id. Maintained alongside
// the DOM-only registries (`textBoxes`, `images`, …) so a VR sink
// registered mid-tour can be immediately synced with whatever
// overlays the 2D layer is currently showing — without these, a
// user who starts a tour in 2D and then taps Enter VR would see an
// empty scene until the next tour task fires.
//
// The DOM registries above store HTML elements only; these store
// the original task params so we can replay them through the sink
// verbatim. Each show/hide/hideAll helper below keeps these in
// lockstep with its DOM counterpart.
const activeTextOverlays = new Map<string, ShowRectTaskParams>()
const activePopupOverlays = new Map<string, ShowPopupHtmlTaskParams>()
const activeImageOverlays = new Map<string, ShowImageTaskParams>()
interface ActiveVideoOverlay {
  params: PlayVideoTaskParams
  video: HTMLVideoElement
  videoID: string
}
const activeVideoOverlays = new Map<string, ActiveVideoOverlay>()
/**
 * Question overlay params as the sink expects them (resolved URLs,
 * wrapped onComplete). Stored post-wrap so replay passes the same
 * cleanup closure the original registration used. Questions are
 * single-active — tour engine pauses on a question until answered —
 * but keyed by id in case a future tour authors one concurrently.
 */
type ActiveQuestionSinkParams = Parameters<VrTourOverlaySink['showQuestion']>[0]
const activeQuestionOverlays = new Map<string, ActiveQuestionSinkParams>()

/**
 * Replay every currently-visible 2D overlay into the given sink.
 * Called when `setVrTourOverlaySink` is handed a non-null sink so
 * the VR scene reflects the active tour step immediately instead
 * of waiting for a later show/hide transition.
 *
 * Safe to call with no active overlays — every Map is checked for
 * emptiness by iteration. Order matches the categories' creation
 * order in the module (text → popup → image → video → question),
 * matching how the sink would receive them from a fresh tour run.
 */
function replayActiveVrTourOverlays(sink: VrTourOverlaySink): void {
  for (const params of activeTextOverlays.values()) {
    sink.showText(params)
  }
  for (const params of activePopupOverlays.values()) {
    sink.showPopup(params)
  }
  for (const params of activeImageOverlays.values()) {
    sink.showImage(params)
  }
  for (const { params, video, videoID } of activeVideoOverlays.values()) {
    sink.showVideo(params, video, videoID)
  }
  for (const params of activeQuestionOverlays.values()) {
    sink.showQuestion(params)
  }
}

/**
 * Register (or clear) the VR overlay sink. `vrSession` calls this
 * with a sink adapter on enter and `null` on exit. Safe to call
 * when no tour is running — the sink just sits dormant until the
 * next overlay op.
 *
 * When a non-null sink is registered while overlays are already
 * visible in the 2D DOM (the user enters VR mid-tour), the current
 * overlay set is replayed into the sink so the VR scene is
 * immediately in sync. Clearing the sink does NOT replay — the
 * session's existing dispose path already tears down VR meshes.
 */
export function setVrTourOverlaySink(sink: VrTourOverlaySink | null): void {
  vrOverlaySink = sink
  if (sink) replayActiveVrTourOverlays(sink)
}

// ── Shared helpers ──────────────────────────────────────────────────

/** Viewport layout mode for responsive tour overlays. */
type LayoutMode = 'desktop' | 'mobile' | 'phone-portrait'

function getLayoutMode(): LayoutMode {
  const w = window.innerWidth
  if (w <= 600 && window.innerHeight > w) return 'phone-portrait'
  if (w <= 768) return 'mobile'
  return 'desktop'
}


/**
 * Transform SOS overlay dimensions for the current viewport.
 *
 * The SOS tour format was designed for 4K touchscreens at arm's length.
 * On a web browser, those same percentage values produce oversized overlays.
 * This function scales and repositions without changing the tour JSON.
 */
function adaptOverlay(
  xPct: number,
  yPct: number,
  widthPct: number,
  heightPct: number,
): { left: number; bottom: number; width: number; height: number } {
  const mode = getLayoutMode()

  let scale: number
  let w: number
  let h: number
  let x: number
  let y: number

  switch (mode) {
    case 'phone-portrait':
      // Stack overlays near the bottom, nearly full width
      scale = 0.55
      w = Math.min(92, widthPct * scale * 1.6) // wider on narrow screens
      h = Math.min(50, heightPct * scale)       // cap height to half screen
      x = 50                                     // center horizontally
      y = Math.min(yPct, 40)                     // push toward bottom half
      break
    case 'mobile':
      scale = 0.6
      w = Math.min(85, widthPct * scale * 1.3)
      h = Math.min(55, heightPct * scale)
      x = xPct
      y = yPct
      break
    default: // desktop
      scale = 0.75
      w = widthPct * scale
      h = heightPct * scale
      x = xPct
      y = yPct
  }

  // Clamp to stay on-screen
  const left = Math.max(1, Math.min(99 - w, x - w / 2))
  const bottom = Math.max(1, Math.min(99 - h, y - h / 2))

  return { left, bottom, width: w, height: h }
}

/**
 * Compute a responsive font-size CSS value.
 * SOS tours specify pixel sizes for 4K; we scale down and use
 * viewport-relative units so text reflows on resize.
 */
function responsiveFontSize(fontSizePx?: number): string {
  if (!fontSizePx) return 'clamp(0.75rem, 1.4vw, 0.9rem)'
  const mode = getLayoutMode()
  const scale = mode === 'phone-portrait' ? 0.7 : mode === 'mobile' ? 0.8 : 0.9
  const scaled = Math.round(fontSizePx * scale)
  // Use vw-based sizing so text scales with viewport
  const vwSize = (scaled / 16).toFixed(2)
  return `clamp(12px, ${vwSize}vw + 0.3rem, ${fontSizePx}px)`
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeCaptionColor(raw: string): string | null {
  const color = raw.trim()
  if (/^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%]+\))$/i.test(color)) {
    return color
  }
  return null
}

/**
 * Parse SOS-style markup in captions:
 *   \n           → <br>
 *   <i>...</i>   → <em>...</em>
 *   <color=X>    → <span style="color:X">
 *   </color>     → </span>
 *
 * All other HTML is escaped so captions cannot inject arbitrary markup.
 */
function parseCaptionMarkup(raw: string): string {
  return escapeHtml(raw)
    .replace(/\\n/g, '<br>')
    .replace(/&lt;i&gt;/gi, '<em>')
    .replace(/&lt;\/i&gt;/gi, '</em>')
    .replace(/&lt;color=([^&]+)&gt;/gi, (_, color: string) => {
      const safeColor = sanitizeCaptionColor(color)
      return safeColor ? `<span style="color:${safeColor}">` : ''
    })
    .replace(/&lt;\/color&gt;/gi, '</span>')
}

/** Get or create the tour overlay container (lives inside #ui). */
function getOverlayContainer(): HTMLElement {
  let container = document.getElementById('tour-overlay-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'tour-overlay-container'
    container.className = 'tour-overlay-container'
    const ui = document.getElementById('ui')
    if (ui) ui.appendChild(container)
    else document.body.appendChild(container)
  }
  return container
}

/**
 * Apply the glass-surface class and set dynamic position/size from tour JSON.
 * The static visual properties (background, blur, border, shadow, animation)
 * are now in the `.tour-glass` CSS class in tour.css. Only the position and
 * size — which come from adaptOverlay() and vary per overlay — are set inline.
 */
function applyGlassPosition(el: HTMLElement, xPct: number, yPct: number, widthPct: number, heightPct: number): void {
  const { left, bottom, width, height } = adaptOverlay(xPct, yPct, widthPct, heightPct)
  el.classList.add('tour-glass')
  el.style.left = `${left}%`
  el.style.bottom = `${bottom}%`
  el.style.width = `min(${width}%, calc(100% - ${left}% - 0.5rem))`
  el.style.height = `min(${height}%, calc(100% - ${bottom}% - 0.5rem))`
}

function addCloseButton(el: HTMLElement, onClose: () => void): void {
  const btn = document.createElement('button')
  btn.className = 'tour-textbox-close'
  btn.innerHTML = '&#x2715;'
  btn.title = 'Close'
  btn.setAttribute('aria-label', 'Close')
  btn.addEventListener('click', onClose)
  el.appendChild(btn)
}

// ── Generic overlay registry ────────────────────────────────────────

function createRegistry() {
  const map = new Map<string, HTMLElement>()
  return {
    add(id: string, el: HTMLElement) { map.set(id, el) },
    remove(id: string) {
      const el = map.get(id)
      if (el) { el.remove(); map.delete(id) }
    },
    removeAll() {
      for (const [id] of map) {
        const el = map.get(id)
        if (el) el.remove()
      }
      map.clear()
    },
  }
}

const textBoxes = createRegistry()
const images = createRegistry()
const videos = createRegistry()
const popups = createRegistry()
const questions = createRegistry()

// ── Floating legend for mobile tours ────────────────────────────────

/** Show a small floating legend thumbnail during tours on mobile. */
export function showTourLegend(legendUrl: string): void {
  hideTourLegend()
  const container = getOverlayContainer()
  const wrapper = document.createElement('div')
  wrapper.id = 'tour-legend-float'
  wrapper.className = 'tour-legend'
  const img = document.createElement('img')
  img.src = legendUrl
  img.alt = 'Legend'
  img.style.cursor = 'zoom-in'
  // Tap to open the full legend modal (if it exists)
  img.addEventListener('click', () => {
    const thumb = document.querySelector('.info-legend-thumb') as HTMLElement | null
    thumb?.click()
  })
  wrapper.appendChild(img)
  container.appendChild(wrapper)
}

/** Remove the floating legend thumbnail. */
export function hideTourLegend(): void {
  document.getElementById('tour-legend-float')?.remove()
}

// ── Text-box overlays (showRect / hideRect) ──────────────────────────

/** Show a text box overlay at the specified screen-percentage position. */
export function showTourTextBox(params: ShowRectTaskParams): void {
  hideTourTextBox(params.rectID)

  const container = getOverlayContainer()
  const box = document.createElement('div')
  box.dataset.rectId = params.rectID
  box.className = 'tour-textbox'

  const mode = getLayoutMode()
  const fontSize = responsiveFontSize(params.fontSize)

  if (mode === 'phone-portrait') {
    // Bottom sheet layout — ignore SOS positioning, use full-width bottom panel
    box.style.cssText = `
      position: absolute;
      left: 0.5rem;
      right: 0.5rem;
      bottom: 8rem;
      max-height: 30vh;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      text-align: center;
      background: rgba(13, 13, 18, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: ${params.showBorder ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(255,255,255,0.06)'};
      border-radius: 12px;
      padding: 0.75rem 1rem;
      color: ${sanitizeCaptionColor(params.fontColor || '') || 'white'};
      font-size: ${fontSize};
      line-height: 1.45;
      overflow-y: auto;
      animation: tour-box-fadein 0.25s ease;
      box-shadow: 0 -2px 20px rgba(0, 0, 0, 0.5);
      z-index: 10;
    `
  } else {
    // Desktop/tablet — positioned overlay
    const { left, bottom, width } = adaptOverlay(
      params.xPct, params.yPct, params.widthPct, params.heightPct
    )

    box.style.cssText = `
      position: absolute;
      left: ${left}%;
      bottom: ${bottom}%;
      max-width: min(${width}vw, calc(100% - ${left}% - 0.5rem));
      max-height: calc(100% - ${bottom}% - 0.5rem);
      width: fit-content;
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      ${params.captionPos === 'center' ? 'align-items:center;text-align:center;' : ''}
      ${params.captionPos === 'left' ? 'align-items:flex-start;text-align:left;' : ''}
      ${params.captionPos === 'right' ? 'align-items:flex-end;text-align:right;' : ''}
      ${params.captionPos === 'top' ? 'align-items:center;text-align:center;' : ''}
      ${params.captionPos === 'bottom' ? 'align-items:center;text-align:center;' : ''}
      background: rgba(13, 13, 18, 0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: ${params.showBorder ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(255,255,255,0.06)'};
      border-radius: 10px;
      padding: 1rem 1.25rem;
      color: ${sanitizeCaptionColor(params.fontColor || '') || 'white'};
      font-size: ${fontSize};
      line-height: 1.5;
      overflow-y: auto;
      animation: tour-box-fadein 0.35s ease;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
    `
  }

  const caption = document.createElement('div')
  caption.innerHTML = parseCaptionMarkup(params.caption)
  box.appendChild(caption)

  if (params.isClosable) {
    addCloseButton(box, () => hideTourTextBox(params.rectID))
  }

  container.appendChild(box)
  textBoxes.add(params.rectID, box)
  activeTextOverlays.set(params.rectID, params)
  vrOverlaySink?.showText(params)
}

export function hideTourTextBox(rectID: string): void {
  textBoxes.remove(rectID)
  activeTextOverlays.delete(rectID)
  vrOverlaySink?.hideText(rectID)
}
export function hideAllTourTextBoxes(): void {
  textBoxes.removeAll()
  activeTextOverlays.clear()
  vrOverlaySink?.hideAllText()
}

// ── Image overlays (showImage / hideImage) ───────────────────────────

export function showTourImage(params: ShowImageTaskParams): void {
  hideTourImage(params.imageID)

  const container = getOverlayContainer()
  const wrapper = document.createElement('div')
  wrapper.className = 'tour-image-overlay'

  const xPct = params.xPct ?? 50
  const yPct = params.yPct ?? 50
  const widthPct = params.widthPct ?? 40
  const heightPct = params.heightPct ?? 40

  const { left, bottom, width, height } = adaptOverlay(xPct, yPct, widthPct, heightPct)

  // Images use fit-content so the container wraps the actual image.
  // Constrain the image with vw/vh units to avoid the circular
  // fit-content + max-width:100% problem.
  wrapper.style.cssText = `
    position: absolute;
    left: ${left}%;
    bottom: ${bottom}%;
    width: fit-content;
    max-width: ${width}%;
    pointer-events: auto;
    background: rgba(13, 13, 18, 0.88);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 10px;
    overflow: hidden;
    animation: tour-box-fadein 0.35s ease;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.75rem;
  `

  const img = document.createElement('img')
  img.src = params.filename
  img.alt = params.caption || 'Tour image'
  img.style.cssText = `
    max-width: ${width}vw;
    max-height: ${height}vh;
    object-fit: contain;
    border-radius: 6px;
    display: block;
  `
  // Hide wrapper until image loads so fit-content has intrinsic dimensions
  wrapper.style.visibility = 'hidden'
  img.onload = () => { wrapper.style.visibility = '' }
  img.onerror = () => { wrapper.style.visibility = '' }
  wrapper.appendChild(img)

  if (params.caption) {
    const cap = document.createElement('div')
    cap.style.cssText = `
      margin-top: 0.5rem;
      font-size: ${responsiveFontSize(params.fontSize)};
      color: ${sanitizeCaptionColor(params.fontColor || '') || '#ddd'};
      text-align: ${{ left: 'left', right: 'right', top: 'center', bottom: 'center', center: 'center' }[params.captionPos || 'center'] ?? 'center'};
    `
    cap.innerHTML = parseCaptionMarkup(params.caption)
    wrapper.appendChild(cap)
  }

  if (params.isClosable) {
    addCloseButton(wrapper, () => hideTourImage(params.imageID))
  }

  container.appendChild(wrapper)
  images.add(params.imageID, wrapper)
  activeImageOverlays.set(params.imageID, params)
  vrOverlaySink?.showImage(params)
}

export function hideTourImage(imageID: string): void {
  images.remove(imageID)
  activeImageOverlays.delete(imageID)
  vrOverlaySink?.hideImage(imageID)
}
export function hideAllTourImages(): void {
  images.removeAll()
  activeImageOverlays.clear()
  vrOverlaySink?.hideAllImages()
}

// ── Video overlays (playVideo / hideVideo) ───────────────────────────

export function showTourVideo(params: PlayVideoTaskParams): void {
  // Use filename as the ID for video overlays
  const videoID = params.filename
  hideTourVideo(videoID)

  const container = getOverlayContainer()
  const wrapper = document.createElement('div')
  wrapper.className = 'tour-video-overlay'
  wrapper.dataset.overlayId = `video-${videoID}`

  const xPct = params.xPct ?? 50
  const yPct = params.yPct ?? 50
  const sizePct = params.sizePct ?? 50

  // Videos are primary content — use less aggressive scaling than text/images
  const mode = getLayoutMode()

  if (mode === 'phone-portrait') {
    // Full-width centered video on phones
    wrapper.style.cssText = `
      position: absolute;
      left: 0.5rem;
      right: 0.5rem;
      top: 2rem;
      max-height: 50vh;
      pointer-events: auto;
      background: rgba(13, 13, 18, 0.92);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      overflow: hidden;
      animation: tour-box-fadein 0.25s ease;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;`
  } else {
    const videoScale = mode === 'mobile' ? 0.9 : 1.0
    const scaledSize = Math.max(35, sizePct * videoScale)
    const { left, bottom } = adaptOverlay(xPct, yPct, scaledSize, scaledSize * 0.5625)

    wrapper.style.cssText = `
      position: absolute;
      left: ${left}%;
      bottom: ${bottom}%;
      width: fit-content;
      max-width: ${scaledSize}%;
      pointer-events: auto;
      background: rgba(13, 13, 18, 0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px;
      overflow: hidden;
      animation: tour-box-fadein 0.35s ease;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);`
  }
  wrapper.style.cssText += 'visibility: hidden;'

  const video = document.createElement('video')
  video.src = params.filename
  video.playsInline = true
  // Don't set the autoplay attribute — we call play() explicitly so we can
  // handle a NotAllowedError (browsers block autoplay with sound unless the
  // tab has a media-engagement history).
  video.controls = params.showControls ?? false
  if (mode === 'phone-portrait') {
    video.style.cssText = `
      width: 100%;
      max-height: 50vh;
      display: block;
      border-radius: 12px;
    `
  } else {
    const scaledSz = Math.max(35, sizePct * (mode === 'mobile' ? 0.9 : 1.0))
    video.style.cssText = `
      max-width: ${scaledSz}vw;
      max-height: ${scaledSz * 0.5625}vh;
      display: block;
      border-radius: 10px;
    `
  }
  // Show wrapper once video has dimensions, or on error so it can be closed
  video.onloadedmetadata = () => { wrapper.style.visibility = '' }
  video.onerror = () => { wrapper.style.visibility = '' }
  // Start playback. If the browser blocks autoplay (typically because the
  // video has audio and the user hasn't interacted yet), fall back to muted
  // autoplay and expose controls so the user can unmute.
  const startVideo = async () => {
    try {
      await video.play()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        video.muted = true
        video.controls = true
        try { await video.play() } catch { /* give up — controls are visible */ }
      }
    }
  }
  void startVideo()
  wrapper.appendChild(video)

  addCloseButton(wrapper, () => hideTourVideo(videoID))

  container.appendChild(wrapper)
  videos.add(videoID, wrapper)
  activeVideoOverlays.set(videoID, { params, video, videoID })
  // Share the same <video> element with VR so both paths render
  // from one decoded stream (see VrTourOverlaySink.showVideo doc).
  vrOverlaySink?.showVideo(params, video, videoID)
}

export function hideTourVideo(videoID: string): void {
  const wrapper = document.querySelector(`[data-overlay-id="video-${CSS.escape(videoID)}"]`)
  const videoEl = wrapper?.querySelector('video')
  if (videoEl) videoEl.pause()
  videos.remove(videoID)
  activeVideoOverlays.delete(videoID)
  vrOverlaySink?.hideVideo(videoID)
}
export function hideAllTourVideos(): void {
  // Pause all videos before removing to stop media playback
  document.querySelectorAll('[data-overlay-id^="video-"]').forEach(wrapper => {
    const videoEl = wrapper.querySelector('video')
    if (videoEl) videoEl.pause()
  })
  videos.removeAll()
  activeVideoOverlays.clear()
  vrOverlaySink?.hideAllVideos()
}

// ── Popup HTML overlays (showPopupHtml / hidePopupHtml) ──────────────

export function showTourPopup(params: ShowPopupHtmlTaskParams): void {
  hideTourPopup(params.popupID)

  const container = getOverlayContainer()
  const wrapper = document.createElement('div')
  wrapper.className = 'tour-popup-overlay'

  const xPct = params.xPct ?? 50
  const yPct = params.yPct ?? 50
  const widthPct = params.widthPct ?? 50
  const heightPct = params.heightPct ?? 50

  applyGlassPosition(wrapper, xPct, yPct, widthPct, heightPct)
  wrapper.style.padding = '0'

  if (params.url) {
    const iframe = document.createElement('iframe')
    iframe.src = params.url
    iframe.style.cssText = 'width:100%;height:100%;border:none;border-radius:10px;'
    // Default to the most restrictive sandbox — no scripts, no same-origin,
    // no forms. Tour authors can opt in to scripts via allowScripts on the
    // task params when the target URL is known-trusted.
    const sandboxFlags = params.allowScripts ? 'allow-scripts' : ''
    iframe.setAttribute('sandbox', sandboxFlags)
    iframe.setAttribute('referrerpolicy', 'no-referrer')
    wrapper.appendChild(iframe)
  } else if (params.html) {
    // Render untrusted HTML in a sandboxed iframe via srcdoc
    const iframe = document.createElement('iframe')
    iframe.style.cssText = 'width:100%;height:100%;border:none;border-radius:10px;'
    iframe.setAttribute('sandbox', '')
    iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:1rem;background:transparent;color:#ddd;font-size:0.85rem;line-height:1.5;font-family:system-ui,sans-serif;overflow:auto;height:100%;box-sizing:border-box;}</style></head><body>${params.html}</body></html>`
    wrapper.appendChild(iframe)
  }

  addCloseButton(wrapper, () => hideTourPopup(params.popupID))

  container.appendChild(wrapper)
  popups.add(params.popupID, wrapper)
  activePopupOverlays.set(params.popupID, params)
  vrOverlaySink?.showPopup(params)
}

export function hideTourPopup(popupID: string): void {
  popups.remove(popupID)
  activePopupOverlays.delete(popupID)
  vrOverlaySink?.hidePopup(popupID)
}
export function hideAllTourPopups(): void {
  popups.removeAll()
  activePopupOverlays.clear()
  vrOverlaySink?.hideAllPopups()
}

// ── Question overlays ────────────────────────────────────────────────

interface QuestionDisplayParams extends QuestionTaskParams {
  /** Resolved URLs for question and answer images */
  imgQuestionFilename: string
  imgAnswerFilename: string
  /** Called when the user completes the question */
  onComplete: () => void
  /** Called the moment the user picks an answer (before the
   * 1.5 s reveal animation + Continue button). Optional; the
   * tour engine wires it for telemetry. The 2D and VR surfaces
   * both call it through to the engine, which dedupes so the
   * event fires exactly once per question. */
  onAnswered?: (chosenIndex: number) => void
}

export function showTourQuestion(params: QuestionDisplayParams): void {
  hideAllTourQuestions()

  const container = getOverlayContainer()
  const wrapper = document.createElement('div')
  wrapper.className = 'tour-question-overlay'

  const xPct = params.xPct ?? 50
  const yPct = params.yPct ?? 50
  const widthPct = params.widthPct ?? 50
  const heightPct = params.heightPct ?? 60

  applyGlassPosition(wrapper, xPct, yPct, widthPct, heightPct)
  wrapper.style.display = 'flex'
  wrapper.style.flexDirection = 'column'
  wrapper.style.alignItems = 'center'
  wrapper.style.justifyContent = 'center'
  wrapper.style.padding = '1rem'

  const img = document.createElement('img')
  img.src = params.imgQuestionFilename
  img.alt = 'Question'
  img.style.cssText = 'max-width:100%;max-height:60%;object-fit:contain;border-radius:6px;margin-bottom:1rem;'
  wrapper.appendChild(img)

  // Answer buttons
  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:0.5rem;flex-wrap:wrap;justify-content:center;'

  for (let i = 0; i < params.numberOfAnswers; i++) {
    const btn = document.createElement('button')
    btn.className = 'tour-question-btn'
    btn.textContent = String(i + 1)
    btn.setAttribute('aria-label', `Answer ${i + 1}`)
    btn.addEventListener('click', () => {
      // Disable all buttons
      btnRow.querySelectorAll('button').forEach(b => {
        (b as HTMLButtonElement).disabled = true
      })
      // Notify the engine for telemetry — fires once per question
      // regardless of which surface the user answered on (engine
      // dedupes; VR's activate handler also calls through).
      params.onAnswered?.(i)

      if (i === params.correctAnswerIndex) {
        btn.classList.add('tour-question-correct')
      } else {
        btn.classList.add('tour-question-wrong')
        // Highlight the correct answer
        const correct = btnRow.children[params.correctAnswerIndex] as HTMLElement | undefined
        if (correct) correct.classList.add('tour-question-correct')
      }

      // Show the answer image after a brief delay
      setTimeout(() => {
        img.src = params.imgAnswerFilename
        img.alt = 'Answer'

        // Add a continue button
        const continueBtn = document.createElement('button')
        continueBtn.className = 'tour-question-continue'
        continueBtn.textContent = 'Continue'
        continueBtn.addEventListener('click', () => {
          hideAllTourQuestions()
          params.onComplete()
        })
        wrapper.appendChild(continueBtn)
      }, 1500)
    })
    btnRow.appendChild(btn)
  }
  wrapper.appendChild(btnRow)

  container.appendChild(wrapper)
  questions.add(params.id, wrapper)

  // Mirror to VR. Wrap `onComplete` so VR's Continue tap also
  // cleans up the 2D DOM — the 2D `continueBtn` handler above
  // calls `hideAllTourQuestions` inline; VR's path goes through
  // this wrapper instead (which mirrors back into VR cleanup).
  // Build the sink-shape once and stash it in the active registry
  // so a replay (user enters VR mid-question) re-sends the same
  // wrapper without double-wrapping the engine's onComplete.
  const sinkParams: ActiveQuestionSinkParams = {
    id: params.id,
    questionImageUrl: params.imgQuestionFilename,
    answerImageUrl: params.imgAnswerFilename,
    numberOfAnswers: params.numberOfAnswers,
    correctAnswerIndex: params.correctAnswerIndex,
    anchor: params.anchor,
    onAnswered: params.onAnswered,
    onComplete: () => {
      hideAllTourQuestions()
      params.onComplete()
    },
  }
  activeQuestionOverlays.set(params.id, sinkParams)
  vrOverlaySink?.showQuestion(sinkParams)
}

export function hideAllTourQuestions(): void {
  questions.removeAll()
  activeQuestionOverlays.clear()
  vrOverlaySink?.hideAllQuestions()
}

// ── Tour controls bar ────────────────────────────────────────────────

let controlsEl: HTMLElement | null = null
let boundEngine: TourEngine | null = null
let spaceHandler: ((e: KeyboardEvent) => void) | null = null
let stopCallback: (() => void) | null = null

/** Show the tour controls bar and bind it to the given engine. */
export function showTourControls(engine: TourEngine, onStopCb?: () => void): void {
  // Remove any existing listeners first to prevent duplicates
  hideTourControls()

  boundEngine = engine
  stopCallback = onStopCb ?? null

  controlsEl = document.getElementById('tour-controls')
  if (!controlsEl) return

  controlsEl.classList.remove('hidden')
  updateTourProgress(engine.currentIndex, engine.totalSteps)
  // Show the pause icon — tour begins in the playing state
  updateTourPlayState(true)

  // Wire buttons
  document.getElementById('tour-prev-btn')?.addEventListener('click', onPrev)
  document.getElementById('tour-play-btn')?.addEventListener('click', onPlayPause)
  document.getElementById('tour-next-btn')?.addEventListener('click', onNext)
  document.getElementById('tour-stop-btn')?.addEventListener('click', onStop)

  // Space bar handler — toggles play/pause while a tour is active
  spaceHandler = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.code !== 'Space' || !boundEngine) return
    if (boundEngine.state === 'playing' || boundEngine.state === 'paused') {
      e.preventDefault()
      onPlayPause()
    }
  }
  document.addEventListener('keydown', spaceHandler)
}

/** Hide the tour controls bar and detach event listeners. */
export function hideTourControls(): void {
  controlsEl?.classList.add('hidden')
  document.getElementById('tour-prev-btn')?.removeEventListener('click', onPrev)
  document.getElementById('tour-play-btn')?.removeEventListener('click', onPlayPause)
  document.getElementById('tour-next-btn')?.removeEventListener('click', onNext)
  document.getElementById('tour-stop-btn')?.removeEventListener('click', onStop)
  if (spaceHandler) {
    document.removeEventListener('keydown', spaceHandler)
    spaceHandler = null
  }
  boundEngine = null
  stopCallback = null
}

/** Update the step counter display. */
export function updateTourProgress(index: number, total: number): void {
  const el = document.getElementById('tour-step-counter')
  if (el) el.textContent = `${index + 1} / ${total}`
}

/** Update the play/pause button to reflect the engine's current state. */
export function updateTourPlayState(isPlaying: boolean): void {
  const btn = document.getElementById('tour-play-btn') as HTMLButtonElement | null
  if (!btn) return
  // Button stays enabled in both states so the user can pause a running
  // tour or resume a paused one. Icon/label toggles accordingly.
  btn.disabled = false
  btn.style.opacity = ''
  if (isPlaying) {
    btn.innerHTML = '&#x23F8;&#xFE0E;'
    btn.setAttribute('aria-label', 'Pause tour')
    btn.title = 'Pause tour'
  } else {
    btn.innerHTML = '&#x25B6;&#xFE0E;'
    btn.setAttribute('aria-label', 'Continue tour')
    btn.title = 'Continue tour'
  }
}

function onPrev(): void { boundEngine?.prev() }

function onNext(): void {
  if (boundEngine) {
    boundEngine.next()
    if (boundEngine.state === 'paused') void boundEngine.play()
  }
}

function onPlayPause(): void {
  if (!boundEngine) return
  if (boundEngine.state === 'playing') boundEngine.pause()
  else void boundEngine.play()
  updateTourPlayState(boundEngine.state === 'playing')
}

function onStop(): void {
  if (stopCallback) {
    stopCallback()
  } else {
    boundEngine?.stop()
  }
}
