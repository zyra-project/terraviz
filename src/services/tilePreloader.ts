// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Eagerly fetches low-zoom GIBS tiles so they are warm in the browser / SW cache
 * before the user rotates the globe. At z0-z3 there are only 85 tiles per layer
 * (170 total for Blue Marble + Black Marble), roughly 5-6 MB.
 */

import { logger } from '../utils/logger'
import { isMobile, isSlowNetwork } from '../utils/deviceCapability'

const IS_TAURI = !!(window as any).__TAURI__

// Lazy-load the public invoke API instead of using __TAURI_INTERNALS__
const tauriInvokeReady: Promise<((cmd: string, args: Record<string, unknown>) => Promise<unknown>) | null> = IS_TAURI
  ? import('@tauri-apps/api/core').then(m => m.invoke as (cmd: string, args: Record<string, unknown>) => Promise<unknown>)
    .catch(() => null)
  : Promise.resolve(null)

// Tile URL templates — matches mapRenderer.ts
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
        const tauriInvoke = await tauriInvokeReady
        if (tauriInvoke) {
          // In Tauri, warm the Rust tile cache directly via IPC
          const tilePath = url.replace('/api/tile/', '')
          await tauriInvoke('get_tile', { tilePath })
        } else {
          // Credentialed on purpose, even though these URLs are
          // same-origin. On a node whose hostname sits behind
          // Cloudflare Access, an uncredentialed `/api/tile/` request
          // carries no `CF_Authorization` cookie, so Access answers
          // 302 to `<team>.cloudflareaccess.com`. The browser follows
          // the redirect, the login origin sends no
          // `Access-Control-Allow-Origin`, and all 170 preloads fail
          // as CORS errors — silently, because the catch below eats
          // them. `same-origin` is the fetch default; it is spelled
          // out so it does not get tidied back to `omit`.
          await fetch(url, { credentials: 'same-origin' })
        }
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
