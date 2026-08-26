// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Deep Link Handler — responds to zyra:// URLs and https://terraviz.zyra-project.org/dataset/* links.
 *
 * When the app is opened via a deep link like
 * `zyra://dataset/north-america-smoke` or
 * `https://terraviz.zyra-project.org/dataset/north-america-smoke`, this
 * module parses the dataset reference and triggers a load. The
 * reference may be a slug, a ULID, or a legacy `INTERNAL_SOS_*` id —
 * `dataService.getDatasetById()` resolves all three.
 *
 * Only active in the Tauri native app. On web, dataset loading is handled
 * by main.ts from the `/dataset/<slug>` path (or a legacy `?dataset=`
 * query param).
 */

import { logger } from '../utils/logger'
import { isDatasetRef, parseDatasetPathname } from '../utils/datasetUrl'
import { getApiOrigin } from './catalogSource'

export { parseDatasetPathname }

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
 * Parse a dataset reference from a deep link URL.
 *
 * Supports (each reference may be a slug, a ULID, or a legacy id):
 * - zyra://dataset/north-america-smoke
 * - https://terraviz.zyra-project.org/dataset/north-america-smoke
 * - ?dataset=INTERNAL_SOS_123 (legacy query-param form)
 */
export function parseDatasetFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)

    // Custom scheme: zyra://dataset/north-america-smoke
    // new URL('zyra://dataset/REF') sets hostname='dataset', pathname='/REF'
    if (parsed.protocol === 'zyra:' && parsed.hostname === 'dataset') {
      const ref = parsed.pathname.replace(/^\//, '')
      if (ref && isDatasetRef(ref)) return ref
    }

    // Path-based: https://<this-node>/dataset/north-america-smoke
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
      // Same parser the web boot path uses, so a link that resolves
      // in the browser resolves in the native app and vice versa —
      // including its length cap and its refusal of nested segments.
      const fromPath = parseDatasetPathname(parsed.pathname)
      if (fromPath) return fromPath

      // Query param: ?dataset=INTERNAL_SOS_123 (validated, known hosts only)
      const queryRef = parsed.searchParams.get('dataset')
      if (queryRef && isDatasetRef(queryRef)) return queryRef
    }

    return null
  } catch {
    // Not a valid URL — try as a bare path. Normalising the leading
    // slash routes it through the same parser rather than a second,
    // looser regex that would accept refs the others reject.
    return parseDatasetPathname(url.startsWith('/') ? url : `/${url}`)
  }
}
