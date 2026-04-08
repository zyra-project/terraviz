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
  ShowPopupHtmlTaskParams, QuestionTaskParams,
} from '../types'
import type { TourEngine } from '../services/tourEngine'

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
 * SOS tours specify pixel sizes for 4K; we scale down and clamp.
 */
function responsiveFontSize(fontSizePx?: number): string {
  if (!fontSizePx) return '0.85rem'
  const mode = getLayoutMode()
  const scale = mode === 'phone-portrait' ? 0.7 : mode === 'mobile' ? 0.8 : 0.9
  const scaled = Math.round(fontSizePx * scale)
  return `clamp(12px, ${scaled}px, ${fontSizePx}px)`
}

/**
 * Parse SOS-style markup in captions:
 *   \n           → <br>
 *   <i>...</i>   → <em>...</em>
 *   <color=X>    → <span style="color:X">
 *   </color>     → </span>
 */
function parseCaptionMarkup(raw: string): string {
  return raw
    .replace(/\\n/g, '<br>')
    .replace(/<i>/gi, '<em>')
    .replace(/<\/i>/gi, '</em>')
    .replace(/<color=([^>]+)>/gi, '<span style="color:$1">')
    .replace(/<\/color>/gi, '</span>')
}

/** Get or create the tour overlay container (lives inside #ui). */
function getOverlayContainer(): HTMLElement {
  let container = document.getElementById('tour-overlay-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'tour-overlay-container'
    container.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:600;'
    const ui = document.getElementById('ui')
    if (ui) ui.appendChild(container)
    else document.body.appendChild(container)
  }
  return container
}

/** Build glass-surface CSS for positioned overlays. */
function glassStyles(xPct: number, yPct: number, widthPct: number, heightPct: number): string {
  const { left, bottom, width, height } = adaptOverlay(xPct, yPct, widthPct, heightPct)
  return `
    position: absolute;
    left: ${left}%;
    bottom: ${bottom}%;
    width: ${width}%;
    height: ${height}%;
    pointer-events: auto;
    background: rgba(13, 13, 18, 0.88);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 10px;
    overflow: hidden;
    animation: tour-box-fadein 0.35s ease;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
  `
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

// ── Text-box overlays (showRect / hideRect) ──────────────────────────

/** Show a text box overlay at the specified screen-percentage position. */
export function showTourTextBox(params: ShowRectTaskParams): void {
  hideTourTextBox(params.rectID)

  const container = getOverlayContainer()
  const box = document.createElement('div')
  box.dataset.rectId = params.rectID
  box.className = 'tour-textbox'

  const { left, bottom, width, height } = adaptOverlay(
    params.xPct, params.yPct, params.widthPct, params.heightPct
  )
  const fontSize = responsiveFontSize(params.fontSize)

  box.style.cssText = `
    position: absolute;
    left: ${left}%;
    bottom: ${bottom}%;
    max-width: ${width}%;
    max-height: ${height}%;
    width: fit-content;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    ${params.captionPos === 'center' ? 'align-items:center;justify-content:center;text-align:center;' : ''}
    ${params.captionPos === 'left' ? 'align-items:flex-start;text-align:left;' : ''}
    ${params.captionPos === 'right' ? 'align-items:flex-end;text-align:right;' : ''}
    ${params.captionPos === 'top' ? 'align-items:center;justify-content:flex-start;text-align:center;' : ''}
    ${params.captionPos === 'bottom' ? 'align-items:center;justify-content:flex-end;text-align:center;' : ''}
    background: rgba(13, 13, 18, 0.88);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: ${params.showBorder ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(255,255,255,0.06)'};
    border-radius: 10px;
    padding: 1rem 1.25rem;
    color: ${params.fontColor || 'white'};
    font-size: ${fontSize};
    line-height: 1.5;
    overflow-y: auto;
    animation: tour-box-fadein 0.35s ease;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
  `

  const caption = document.createElement('div')
  caption.innerHTML = parseCaptionMarkup(params.caption)
  box.appendChild(caption)

  if (params.isClosable) {
    addCloseButton(box, () => hideTourTextBox(params.rectID))
  }

  container.appendChild(box)
  textBoxes.add(params.rectID, box)
}

export function hideTourTextBox(rectID: string): void { textBoxes.remove(rectID) }
export function hideAllTourTextBoxes(): void { textBoxes.removeAll() }

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
  wrapper.appendChild(img)

  if (params.caption) {
    const cap = document.createElement('div')
    cap.style.cssText = `
      margin-top: 0.5rem;
      font-size: ${responsiveFontSize(params.fontSize)};
      color: ${params.fontColor || '#ddd'};
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
}

export function hideTourImage(imageID: string): void { images.remove(imageID) }
export function hideAllTourImages(): void { images.removeAll() }

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

  const { left, bottom, width, height } = adaptOverlay(xPct, yPct, sizePct, sizePct * 0.5625)

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
    padding: 0;
    visibility: hidden;
  `

  const video = document.createElement('video')
  video.src = params.filename
  video.autoplay = true
  video.controls = params.showControls ?? false
  video.style.cssText = `
    max-width: ${width}vw;
    max-height: ${height}vh;
    display: block;
    border-radius: 10px;
  `
  // Show wrapper once video has dimensions
  video.onloadedmetadata = () => { wrapper.style.visibility = '' }
  wrapper.appendChild(video)

  addCloseButton(wrapper, () => hideTourVideo(videoID))

  container.appendChild(wrapper)
  videos.add(videoID, wrapper)
}

export function hideTourVideo(videoID: string): void {
  // Pause any playing video inside the overlay before removing
  const wrapper = document.querySelector(`[data-overlay-id="video-${CSS.escape(videoID)}"]`)
  const videoEl = wrapper?.querySelector('video')
  if (videoEl) videoEl.pause()
  videos.remove(videoID)
}
export function hideAllTourVideos(): void { videos.removeAll() }

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

  wrapper.style.cssText = glassStyles(xPct, yPct, widthPct, heightPct) + `
    padding: 0;
  `

  if (params.url) {
    const iframe = document.createElement('iframe')
    iframe.src = params.url
    iframe.style.cssText = 'width:100%;height:100%;border:none;border-radius:10px;'
    iframe.setAttribute('sandbox', 'allow-scripts')
    wrapper.appendChild(iframe)
  } else if (params.html) {
    const content = document.createElement('div')
    content.style.cssText = 'width:100%;height:100%;overflow:auto;padding:1rem;color:#ddd;font-size:0.85rem;line-height:1.5;'
    content.innerHTML = params.html
    wrapper.appendChild(content)
  }

  addCloseButton(wrapper, () => hideTourPopup(params.popupID))

  container.appendChild(wrapper)
  popups.add(params.popupID, wrapper)
}

export function hideTourPopup(popupID: string): void { popups.remove(popupID) }
export function hideAllTourPopups(): void { popups.removeAll() }

// ── Question overlays ────────────────────────────────────────────────

interface QuestionDisplayParams extends QuestionTaskParams {
  /** Resolved URLs for question and answer images */
  imgQuestionFilename: string
  imgAnswerFilename: string
  /** Called when the user completes the question */
  onComplete: () => void
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

  wrapper.style.cssText = glassStyles(xPct, yPct, widthPct, heightPct) + `
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  `

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
}

export function hideAllTourQuestions(): void { questions.removeAll() }

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
  // Start with play button disabled — it enables when tour hits a pause
  updateTourPlayState(true)

  // Wire buttons
  document.getElementById('tour-prev-btn')?.addEventListener('click', onPrev)
  document.getElementById('tour-play-btn')?.addEventListener('click', onPlayPause)
  document.getElementById('tour-next-btn')?.addEventListener('click', onNext)
  document.getElementById('tour-stop-btn')?.addEventListener('click', onStop)

  // Space bar handler for resuming paused tours
  spaceHandler = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    const btn = document.getElementById('tour-play-btn') as HTMLButtonElement | null
    if (e.code === 'Space' && boundEngine && boundEngine.state === 'paused' && !btn?.disabled) {
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
  if (isPlaying) {
    // Tour is executing tasks — disable the button
    btn.innerHTML = '&#x23F8;&#xFE0E;'
    btn.setAttribute('aria-label', 'Tour running')
    btn.title = 'Tour running'
    btn.disabled = true
    btn.style.opacity = '0.4'
  } else {
    // Tour is paused — enable the play button
    btn.innerHTML = '&#x25B6;&#xFE0E;'
    btn.setAttribute('aria-label', 'Continue tour')
    btn.title = 'Continue tour'
    btn.disabled = false
    btn.style.opacity = ''
  }
}

function updatePlayPauseBtn(_isPlaying: boolean): void {
  // Delegate to updateTourPlayState for consistency
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
  updatePlayPauseBtn(boundEngine.state === 'playing')
}

function onStop(): void {
  if (stopCallback) {
    stopCallback()
  } else {
    boundEngine?.stop()
  }
}
