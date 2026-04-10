/**
 * Screenshot Service — captures the globe canvas (and optionally the
 * surrounding UI) as a compressed JPEG data URL.
 *
 * Two capture modes:
 *
 *   captureGlobeScreenshot() — globe canvas only, max 512px, used by
 *   the Orbit vision flow where only the 3D view matters to the LLM.
 *
 *   captureFullScreen() — globe PLUS the surrounding overlay UI
 *   (info panel, chat, map controls, playback controls, etc.), max
 *   1280px, used by the bug-report form where the UI state is often
 *   what the report is about. Lazy-loads html2canvas on first use so
 *   the ~48KB dependency isn't in the main bundle. The help panel and
 *   its triggers are deliberately excluded so the screenshot shows
 *   the app as it was before the user opened the feedback form.
 *
 * Both modes delegate to MapRenderer.captureScreenshot() under the
 * hood to get a reliable globe image — a naive canvas.toDataURL() is
 * unreliable on MapLibre, see the comment on that method for details.
 */

import { getActiveMapRenderer } from './mapRenderer'
import { logger } from '../utils/logger'

/** Max dimension for the globe-only screenshot (Orbit vision flow). */
export const SCREENSHOT_MAX_SIZE = 512

/** Max dimension for the full-UI screenshot (feedback flow). */
const FULL_SCREEN_MAX_SIZE = 1280

/**
 * Upper bound (ms) on captureFullScreen(). html2canvas has known
 * issues on iOS Safari where it can hang — especially on large DOM
 * trees, memory pressure, or stalled iframe clones. Rather than
 * leave the user stranded with a disabled submit button, race the
 * capture against this timeout and fall back to no screenshot.
 */
const FULL_SCREEN_TIMEOUT_MS = 10_000

/** Upper bound (ms) on the Image.decode() / load step. */
const IMAGE_LOAD_TIMEOUT_MS = 3_000

/** IDs of elements that should be excluded from the full-screen capture. */
const EXCLUDE_IDS = new Set([
  'help-panel',
  'help-backdrop',
  'help-trigger',
  'help-trigger-browse',
])

/**
 * Fallback capture that reads straight from a DOM canvas with the id
 * `globe-canvas`. Used only when no MapRenderer is registered — the
 * result may be blank on a MapLibre canvas because the drawing buffer
 * can be cleared between frames.
 *
 * @param maxSize Max dimension on the longer edge. Defaults to
 * SCREENSHOT_MAX_SIZE; pass `Infinity` to skip the downsample.
 */
function captureFromDom(maxSize: number = SCREENSHOT_MAX_SIZE): string | null {
  const canvas = document.getElementById('globe-canvas') as HTMLCanvasElement | null
  if (!canvas) return null
  try {
    const { width, height } = canvas
    const scale = Math.min(1, maxSize / Math.max(width, height))
    if (scale < 1) {
      const offscreen = document.createElement('canvas')
      offscreen.width = Math.round(width * scale)
      offscreen.height = Math.round(height * scale)
      const ctx = offscreen.getContext('2d')
      if (!ctx) return canvas.toDataURL('image/jpeg', 0.6)
      ctx.drawImage(canvas, 0, 0, offscreen.width, offscreen.height)
      return offscreen.toDataURL('image/jpeg', 0.6)
    }
    return canvas.toDataURL('image/jpeg', 0.6)
  } catch {
    logger.warn('[screenshotService] Failed to capture globe screenshot (DOM fallback)')
    return null
  }
}

/**
 * Downsample a canvas to fit within maxSize on its longer edge and
 * return a JPEG data URL at the given quality.
 */
function downsampleCanvas(canvas: HTMLCanvasElement, maxSize: number, quality: number): string {
  const { width, height } = canvas
  const scale = Math.min(1, maxSize / Math.max(width, height))
  if (scale >= 1) {
    return canvas.toDataURL('image/jpeg', quality)
  }
  const offscreen = document.createElement('canvas')
  offscreen.width = Math.round(width * scale)
  offscreen.height = Math.round(height * scale)
  const ctx = offscreen.getContext('2d')
  if (!ctx) return canvas.toDataURL('image/jpeg', quality)
  ctx.drawImage(canvas, 0, 0, offscreen.width, offscreen.height)
  return offscreen.toDataURL('image/jpeg', quality)
}

/**
 * Race a promise against a timeout. If the timeout fires first,
 * resolve with `fallback` and log a warning. Errors from the inner
 * promise are also swallowed and resolved with `fallback` so callers
 * don't have to try/catch. Used to put hard upper bounds on each
 * step of screenshot capture.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  return new Promise((resolve) => {
    let settled = false
    const timeoutId = window.setTimeout(() => {
      if (settled) return
      settled = true
      logger.warn(`[screenshotService] ${label} timed out after ${ms}ms`)
      resolve(fallback)
    }, ms)
    promise.then((result) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      resolve(result)
    }).catch((err) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      logger.warn(`[screenshotService] ${label} failed:`, err)
      resolve(fallback)
    })
  })
}

/**
 * Load an image from a data URL and resolve once it's fully decoded.
 * Uses the modern `img.decode()` promise when available, falling
 * back to the load/error events otherwise.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load globe image'))
    img.src = src
    if (typeof img.decode === 'function') {
      img.decode().then(() => resolve(img)).catch(() => {
        // Fall through to onload/onerror — decode() can reject on
        // some browsers even though the image is loadable.
      })
    }
  })
}

/**
 * Capture the globe canvas as a compressed JPEG data URL, downsized to
 * at most SCREENSHOT_MAX_SIZE px on the longest edge so the payload
 * stays small. Used by the Orbit vision flow.
 *
 * Returns null if the canvas is not available or the capture fails.
 */
export async function captureGlobeScreenshot(): Promise<string | null> {
  const renderer = getActiveMapRenderer()
  if (renderer) {
    const result = await renderer.captureScreenshot()
    if (result) return result
    // Renderer exists but capture failed — fall through to DOM fallback
  }
  return captureFromDom()
}

/**
 * Inner implementation — see captureFullScreen() for the public
 * contract. Factored out so the top-level export can race the whole
 * operation against a timeout.
 */
async function doCaptureFullScreen(): Promise<string | null> {
  // 1) Grab the globe at full resolution so the composite renders
  //    it at the canvas's natural display size.
  let globeDataUrl: string | null = null
  const renderer = getActiveMapRenderer()
  if (renderer) {
    globeDataUrl = await renderer.captureScreenshot({ maxSize: Infinity })
  } else {
    globeDataUrl = captureFromDom(Infinity)
  }

  // 2) Preload the globe image so onclone can paint it synchronously
  //    — avoids any race with html2canvas's render walk and doesn't
  //    rely on async onclone support. Bounded by its own timeout so
  //    a flaky decode on iOS Safari can't stall us.
  let globeImage: HTMLImageElement | null = null
  if (globeDataUrl) {
    globeImage = await withTimeout(
      loadImage(globeDataUrl),
      IMAGE_LOAD_TIMEOUT_MS,
      null,
      'loadImage',
    )
  }

  // 3) Lazy-load html2canvas — only fetched when a user actually
  //    attaches a screenshot to a feedback submission.
  const { default: html2canvas } = await import('html2canvas')

  // 4) Render the full body to a canvas, skipping the help panel
  //    and painting the pre-loaded globe image onto the cloned
  //    canvas's 2D context so html2canvas never has to read the
  //    WebGL buffer.
  const composite = await html2canvas(document.body, {
    backgroundColor: '#0d0d12',
    useCORS: true,
    logging: false,
    scale: 1,
    ignoreElements: (el) => EXCLUDE_IDS.has(el.id),
    onclone: (clonedDoc) => {
      if (!globeImage) return
      const clonedCanvas = clonedDoc.getElementById('globe-canvas') as HTMLCanvasElement | null
      if (!clonedCanvas) return

      // Match the cloned canvas's backing-store size to the live
      // canvas so what we paint ends up the right size. Assigning
      // to width/height also clears the surface per spec, wiping
      // whatever html2canvas's createCanvasClone put there.
      const liveCanvas = document.getElementById('globe-canvas') as HTMLCanvasElement | null
      if (liveCanvas) {
        clonedCanvas.width = liveCanvas.width
        clonedCanvas.height = liveCanvas.height
        const rect = liveCanvas.getBoundingClientRect()
        clonedCanvas.style.width = rect.width + 'px'
        clonedCanvas.style.height = rect.height + 'px'
      }

      const ctx = clonedCanvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(globeImage, 0, 0, clonedCanvas.width, clonedCanvas.height)
      }
    },
  })

  return downsampleCanvas(composite, FULL_SCREEN_MAX_SIZE, 0.7)
}

/**
 * Capture the full app viewport — globe plus UI overlays — as a JPEG
 * data URL. Used by the feedback form so bug reports can include the
 * UI state.
 *
 * The help panel and its backdrop are excluded via html2canvas's
 * ignoreElements option, so reports show the app as it was behind
 * the feedback form.
 *
 * The globe is pre-captured at full resolution and preloaded as an
 * Image BEFORE html2canvas is invoked. The onclone hook is then
 * synchronous: it paints the already-loaded image onto the cloned
 * canvas's 2D context. This sidesteps the WebGL drawing-buffer
 * unreliability that a direct html2canvas read would hit.
 *
 * The entire operation is bounded by FULL_SCREEN_TIMEOUT_MS. If it
 * doesn't complete in time, this resolves to null rather than
 * hanging — important on iOS Safari where html2canvas has been
 * observed to stall during DOM traversal or image decoding. Callers
 * should treat null as "couldn't capture" and proceed accordingly.
 */
export async function captureFullScreen(): Promise<string | null> {
  return withTimeout(
    doCaptureFullScreen(),
    FULL_SCREEN_TIMEOUT_MS,
    null,
    'captureFullScreen',
  )
}
