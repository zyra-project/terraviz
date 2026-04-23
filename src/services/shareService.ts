/**
 * Share Service — share datasets via the Web Share API or clipboard.
 *
 * Uses the Web Share API when available (iOS Safari, Android Chrome,
 * modern desktop browsers). Falls back to clipboard copy when not.
 *
 * The Web Share API invokes the native share sheet on mobile — same
 * UIActivityViewController / Intent.ACTION_SEND that a native app
 * would use — so no Tauri plugin is needed for this functionality.
 */

import { logger } from '../utils/logger'

export interface ShareData {
  title: string
  text: string
  url: string
}

/**
 * Share a dataset via the native share sheet or clipboard.
 *
 * @param data - the content to share (title, text, URL)
 * @returns true if sharing was initiated, false if unavailable
 */
export async function shareDataset(data: ShareData): Promise<boolean> {
  // Web Share API — triggers native share sheet on mobile
  if (navigator.share) {
    try {
      await navigator.share({
        title: data.title,
        text: data.text,
        url: data.url,
      })
      logger.info('[Share] Shared via Web Share API:', data.title)
      return true
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User cancelled — not an error, don't fall back
        return false
      }
      // Non-cancel failure — fall through to clipboard
      logger.warn('[Share] Web Share API failed, trying clipboard:', err)
    }
  }

  // Fallback: copy URL to clipboard
  try {
    await navigator.clipboard.writeText(data.url)
    logger.info('[Share] Copied URL to clipboard:', data.url)
    return true
  } catch {
    logger.warn('[Share] Clipboard write failed')
    return false
  }
}

/**
 * Build a shareable URL for a dataset.
 */
export function buildDatasetShareUrl(datasetId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://terraviz.zyra-project.org'
  return `${origin}/dataset/${encodeURIComponent(datasetId)}`
}
