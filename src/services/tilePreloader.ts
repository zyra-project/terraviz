/**
 * Eagerly fetches low-zoom GIBS tiles so they are warm in the browser / SW cache
 * before the user rotates the globe. At z0-z3 there are only 85 tiles per layer
 * (170 total for Blue Marble + Black Marble), roughly 5-6 MB.
 */

import { logger } from '../utils/logger'
import { isMobile, isSlowNetwork } from '../utils/deviceCapability'

// Proxied through Cloudflare edge — matches mapRenderer.ts tile URLs
const BLUE_MARBLE_TEMPLATE =
  '/api/tile/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg'
const BLACK_MARBLE_TEMPLATE =
  '/api/tile/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'

/** Generate all tile URLs for zoom levels 0 through maxZoom (inclusive). @internal */
export function generateTileUrls(template: string, maxZoom: number): string[] {
  const urls: string[] = []
  for (let z = 0; z <= maxZoom; z++) {
    const count = 1 << z // 2^z tiles per axis
    for (let y = 0; y < count; y++) {
      for (let x = 0; x < count; x++) {
        urls.push(
          template
            .replace('{z}', String(z))
            .replace('{y}', String(y))
            .replace('{x}', String(x))
        )
      }
    }
  }
  return urls
}

/**
 * Fetch URLs with a concurrency limit so we don't saturate the connection.
 * Each fetch is fire-and-forget — we only care about populating the cache.
 */
async function fetchWithConcurrency(urls: string[], concurrency: number): Promise<void> {
  let i = 0
  let completed = 0
  const total = urls.length

  async function next(): Promise<void> {
    while (i < urls.length) {
      const url = urls[i++]
      try {
        await fetch(url, { mode: 'cors', credentials: 'omit' })
      } catch {
        // Non-critical — tile will be fetched on-demand later
      }
      completed++
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => next())
  await Promise.all(workers)
  logger.info(`[TilePreloader] Preloaded ${completed}/${total} tiles`)
}

/**
 * Preload low-zoom tiles for both Blue Marble and Black Marble layers.
 * Skips preloading entirely on slow networks (2g / slow-2g).
 */
export function preloadLowZoomTiles(maxZoom = 3): void {
  if (isSlowNetwork()) {
    logger.info('[TilePreloader] Skipping preload — slow network detected')
    return
  }

  const concurrency = isMobile() ? 2 : 6
  const urls = [
    ...generateTileUrls(BLUE_MARBLE_TEMPLATE, maxZoom),
    ...generateTileUrls(BLACK_MARBLE_TEMPLATE, maxZoom),
  ]

  logger.info(`[TilePreloader] Preloading ${urls.length} tiles (concurrency=${concurrency})`)
  fetchWithConcurrency(urls, concurrency)
}
