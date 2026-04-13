/**
 * Deep Link Handler — responds to zyra:// URLs and https://sphere.zyra-project.org/dataset/* links.
 *
 * When the app is opened via a deep link like `zyra://dataset/INTERNAL_SOS_123`
 * or `https://sphere.zyra-project.org/dataset/INTERNAL_SOS_123`, this module
 * parses the dataset ID and triggers a load.
 *
 * Only active in the Tauri native app. On web, dataset loading is handled
 * via the `?dataset=ID` query parameter in main.ts.
 */

import { logger } from '../utils/logger'

const IS_TAURI = typeof window !== 'undefined' && !!(window as any).__TAURI__

/**
 * Initialize deep link listening. Call once at app startup.
 *
 * @param onDatasetRequested - callback invoked with the dataset ID when
 *   a deep link targets a dataset.
 */
export async function initDeepLinks(
  onDatasetRequested: (datasetId: string) => void,
): Promise<void> {
  if (!IS_TAURI) return

  try {
    const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link')

    await onOpenUrl((urls) => {
      for (const url of urls) {
        const datasetId = parseDatasetFromUrl(url)
        if (datasetId) {
          logger.info(`[DeepLink] Dataset requested: ${datasetId} from ${url}`)
          onDatasetRequested(datasetId)
          return // handle only the first valid dataset link
        }
        logger.warn(`[DeepLink] Unrecognized URL: ${url}`)
      }
    })

    logger.info('[DeepLink] Listener registered')
  } catch (err) {
    logger.warn('[DeepLink] Plugin not available:', err)
  }
}

/**
 * Parse a dataset ID from a deep link URL.
 *
 * Supports:
 * - zyra://dataset/INTERNAL_SOS_123
 * - https://sphere.zyra-project.org/dataset/INTERNAL_SOS_123
 * - ?dataset=INTERNAL_SOS_123 (query param fallback)
 */
export function parseDatasetFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)

    // Path-based: /dataset/INTERNAL_SOS_123
    const pathMatch = parsed.pathname.match(/\/dataset\/([A-Z0-9_]+)/i)
    if (pathMatch) return pathMatch[1]

    // Query param: ?dataset=INTERNAL_SOS_123
    const queryId = parsed.searchParams.get('dataset')
    if (queryId) return queryId

    return null
  } catch {
    // Not a valid URL — try as a bare path
    const bareMatch = url.match(/dataset\/([A-Z0-9_]+)/i)
    return bareMatch ? bareMatch[1] : null
  }
}
