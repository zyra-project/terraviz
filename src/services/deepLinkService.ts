/**
 * Deep Link Handler — responds to zyra:// URLs and https://terraviz.zyra-project.org/dataset/* links.
 *
 * When the app is opened via a deep link like `zyra://dataset/INTERNAL_SOS_123`
 * or `https://terraviz.zyra-project.org/dataset/INTERNAL_SOS_123`, this module
 * parses the dataset ID and triggers a load.
 *
 * Only active in the Tauri native app. On web, dataset loading is handled
 * via the `?dataset=ID` query parameter in main.ts.
 */

import { logger } from '../utils/logger'
import { getApiOrigin } from './catalogSource'

const IS_TAURI = typeof window !== 'undefined' && !!(window as any).__TAURI__

/**
 * Hostname this node serves under, derived from the configured API
 * origin (`VITE_API_ORIGIN`, defaulting to the upstream production
 * host). A fork that sets `VITE_API_ORIGIN` to its own domain gets
 * its own `/dataset/<id>` deep links recognised automatically — no
 * code edit needed for node independence. Resolved lazily so tests
 * can stub the env / window between cases.
 */
function configuredHost(): string | null {
  try {
    return new URL(getApiOrigin()).hostname.toLowerCase()
  } catch {
    return null
  }
}

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
 * - https://terraviz.zyra-project.org/dataset/INTERNAL_SOS_123
 * - ?dataset=INTERNAL_SOS_123 (query param fallback)
 */
export function parseDatasetFromUrl(url: string): string | null {
  const ID_PATTERN = /^[A-Z0-9_]+$/i

  try {
    const parsed = new URL(url)

    // Custom scheme: zyra://dataset/INTERNAL_SOS_123
    // new URL('zyra://dataset/ID') sets hostname='dataset', pathname='/ID'
    if (parsed.protocol === 'zyra:' && parsed.hostname === 'dataset') {
      const id = parsed.pathname.replace(/^\//, '')
      if (id && ID_PATTERN.test(id)) return id
    }

    // Path-based: https://<this-node>/dataset/INTERNAL_SOS_123
    // Accept this node's own configured host (VITE_API_ORIGIN), the
    // upstream production host, *.pages.dev preview deploys, and
    // localhost. The configured-host check is what makes a fork's
    // own deep links resolve without a code edit.
    const host = parsed.hostname.toLowerCase()
    const ownHost = configuredHost()
    const isKnownHost = (ownHost !== null && host === ownHost) ||
      host === 'terraviz.zyra-project.org' ||
      host.endsWith('.pages.dev') ||
      host === 'localhost'
    if (isKnownHost) {
      const pathMatch = parsed.pathname.match(/\/dataset\/([A-Z0-9_]+)/i)
      if (pathMatch) return pathMatch[1]

      // Query param: ?dataset=INTERNAL_SOS_123 (validated, known hosts only)
      const queryId = parsed.searchParams.get('dataset')
      if (queryId && ID_PATTERN.test(queryId)) return queryId
    }

    return null
  } catch {
    // Not a valid URL — try as a bare path
    const bareMatch = url.match(/dataset\/([A-Z0-9_]+)/i)
    return bareMatch ? bareMatch[1] : null
  }
}
