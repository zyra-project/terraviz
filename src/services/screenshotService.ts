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

/** IDs of elements that should be excluded from the full-screen capture. */
const EXCLUDE_IDS = new Set([
  'help-panel',
  'help-trigger',
  'help-trigger-browse',
])

/**
 * Fallback capture that reads straight from a DOM canvas with the id
 * `globe-canvas`. Used only when no MapRenderer is registered — the
 * result may be blank on a MapLibre canvas because the drawing buffer
 * can be cleared between frames.
 */
function captureFromDom(): string | null {
  const canvas = document.getElementById('globe-canvas') as HTMLCanvasElement | null
  if (!canvas) return null
  try {
    const { width, height } = canvas
    const scale = Math.min(1, SCREENSHOT_MAX_SIZE / Math.max(width, height))
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
 * Capture the full app viewport — globe plus UI overlays — as a JPEG
 * data URL. Used by the feedback form so bug reports can include the
 * UI state.
 *
 * The help panel itself is excluded via html2canvas's ignoreElements
 * option, so reports show the app as it was behind the feedback form.
 *
 * The globe is pre-captured at full resolution and swapped into the
 * cloned DOM via onclone — this sidesteps the WebGL drawing-buffer
 * unreliability that a naive html2canvas call would hit when reading
 * the canvas directly.
 *
 * Returns null if capture fails for any reason.
 */
export async function captureFullScreen(): Promise<string | null> {
  try {
    // 1) Grab the globe at full resolution so the composite renders
    //    it at the canvas's natural display size.
    let globeDataUrl: string | null = null
    const renderer = getActiveMapRenderer()
    if (renderer) {
      globeDataUrl = await renderer.captureScreenshot({ maxSize: Infinity })
    } else {
      globeDataUrl = captureFromDom()
    }

    // 2) Lazy-load html2canvas — only fetched when a user actually
    //    attaches a screenshot to a feedback submission.
    const { default: html2canvas } = await import('html2canvas')

    // 3) Render the full body to a canvas, skipping the help panel
    //    and swapping the globe canvas for a pre-baked img so
    //    html2canvas never has to read the WebGL buffer.
    const composite = await html2canvas(document.body, {
      backgroundColor: '#0d0d12',
      useCORS: true,
      logging: false,
      scale: 1,
      ignoreElements: (el) => EXCLUDE_IDS.has(el.id),
      onclone: (clonedDoc) => {
        if (!globeDataUrl) return
        const canvas = clonedDoc.getElementById('globe-canvas') as HTMLCanvasElement | null
        if (!canvas) return
        const img = clonedDoc.createElement('img')
        img.src = globeDataUrl
        // Preserve the layout size so surrounding elements don't reflow.
        const rect = canvas.getBoundingClientRect()
        img.style.width = rect.width + 'px'
        img.style.height = rect.height + 'px'
        img.style.display = 'block'
        canvas.parentElement?.replaceChild(img, canvas)
      },
    })

    return downsampleCanvas(composite, FULL_SCREEN_MAX_SIZE, 0.7)
  } catch (err) {
    logger.warn('[screenshotService] captureFullScreen failed:', err)
    return null
  }
}
