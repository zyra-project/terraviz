import { logger } from '../utils/logger'
import { reportError } from '../analytics'

/**
 * Build-time switch that controls where `dataService.ts` and
 * `datasetLoader.ts` source their catalog data from.
 *
 *   - `node` (default, post-1d cutover): pull the rendered catalog
 *     from this deployment's own `/api/v1/catalog`, follow each
 *     dataset's `dataLink` (`/api/v1/datasets/{id}/manifest`) for
 *     video / image resolution. The wire shape is the same as the
 *     existing `Dataset` plus a few additive fields, so call sites
 *     that already work against `Dataset` need no further changes.
 *   - `legacy`: existing behaviour — pull SOS catalog JSON from
 *     `s3.dualstack.us-east-1.amazonaws.com`, merge with
 *     `/assets/sos_dataset_metadata.json`, point video playback at
 *     `https://video-proxy.zyra-project.org/video/{vimeoId}`. Kept
 *     behind the explicit flag for the cutover stabilisation
 *     window — operators can roll back to legacy with a single
 *     env-var change while the rest of the cutover commits are
 *     reverted in their own follow-on PR.
 *
 * Pre-1d/G the default was `legacy`. The flip to `node` is
 * reversed by `git revert` of this commit alongside the other two
 * cutover commits (1d/E, 1d/F) — no schema or data changes.
 */

export type CatalogSource = 'legacy' | 'node'

export function getCatalogSource(): CatalogSource {
  const raw = (import.meta.env.VITE_CATALOG_SOURCE as string | undefined) ?? 'node'
  return raw === 'legacy' ? 'legacy' : 'node'
}

/**
 * True when a `dataLink` URL is shaped like one of this node's
 * manifest endpoints. Used by the dataset loader to decide whether
 * to fetch the manifest envelope or treat the link as a direct
 * asset URL (the sample tours' `/assets/test-tour.json` paths, or
 * any legacy URL the SOS source still hands us).
 *
 * Accepts both the public manifest URL and the token-gated preview
 * sibling (`.../preview/{token}/manifest`) so a draft dataset
 * loaded via the SPA's `?preview=` consumer (3pe/B) routes through
 * the same manifest-fetch path as a published one.
 */
export function isManifestUrl(dataLink: string): boolean {
  return /^\/api\/v\d+\/datasets\/[^/]+(?:\/preview\/[^/]+)?\/manifest$/.test(dataLink)
}

/**
 * Public origin of the production Pages deployment. Used as the
 * fallback host for `/api/v1/...` requests in Tauri builds, where
 * the webview origin is `tauri://localhost/` (or
 * `http://tauri.localhost/` on Windows) and there is no Pages
 * Functions backend to serve relative API paths — they would
 * otherwise return the bundled `index.html` and fail JSON parse
 * with `Unexpected token '<'`.
 *
 * Override at build time via `VITE_API_ORIGIN` to point a fork's
 * desktop builds at a different deployment.
 */
const DEFAULT_API_ORIGIN = 'https://terraviz.zyra-project.org'

/**
 * Whether the SPA is currently running inside a Tauri webview.
 * Resolved per call (rather than captured once at module load) so
 * tests can flip `window.__TAURI__` between cases without resorting
 * to `vi.resetModules()` and dynamic re-imports.
 */
function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as { __TAURI__?: unknown }).__TAURI__
  )
}

/**
 * Resolve the active API origin. Reads `VITE_API_ORIGIN` and
 * normalises it to just `<scheme>://<host>[:port]` via the URL
 * constructor — anything past the origin (path, query, fragment)
 * is dropped, which matches the variable's name and prevents a
 * misconfigured `https://staging.example.com/foo` from producing
 * `https://staging.example.com/foo/api/v1/catalog`. Non-URL or
 * non-http(s) values fall back to `DEFAULT_API_ORIGIN` rather
 * than throwing, so a typo can't take desktop builds offline.
 */
export function getApiOrigin(): string {
  const override = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.trim()
  if (!override) return DEFAULT_API_ORIGIN
  try {
    const u = new URL(override)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_API_ORIGIN
    return u.origin
  } catch {
    return DEFAULT_API_ORIGIN
  }
}

/**
 * Lazy-loaded reference to the Tauri HTTP plugin's `fetch`. The
 * webview's native fetch enforces CORS for cross-origin HTTPS
 * targets and the catalog API endpoints don't set
 * `Access-Control-Allow-Origin`, so requests from `tauri://localhost`
 * to the production deployment would otherwise be blocked. The
 * plugin issues the request from Rust (reqwest), bypassing webview
 * CORS — same lazy-import pattern used by `llmProvider.ts` and
 * `downloadService.ts`. We log + `reportError` on import failure
 * (same telemetry category as the catalog fetch itself) so a broken
 * plugin doesn't silently degrade to native fetch and re-trigger
 * the original `<!DOCTYPE` crash class with no diagnostic.
 */
let tauriFetchPromise: Promise<typeof globalThis.fetch | null> | null = null
function getTauriFetch(): Promise<typeof globalThis.fetch | null> {
  if (tauriFetchPromise) return tauriFetchPromise
  tauriFetchPromise = import('@tauri-apps/plugin-http')
    .then(m => {
      logger.info('[catalog] Tauri HTTP plugin loaded')
      return m.fetch as typeof globalThis.fetch
    })
    .catch(err => {
      logger.warn('[catalog] Failed to load Tauri HTTP plugin:', err)
      reportError('download', err)
      return null
    })
  return tauriFetchPromise
}

/**
 * Resolve a path or URL to one the active runtime can actually
 * fetch. Web builds (and Tauri requests already pointed at an
 * external HTTPS origin) pass through unchanged. In Tauri the
 * function rewrites paths under `/api/...` to the production API
 * origin so the cross-origin fetch reaches a real Pages Functions
 * backend instead of the webview's bundled `index.html`.
 *
 * URLs that already include the webview origin (the typical output
 * of `new URL(path, window.location.origin).toString()`) are
 * stripped back to their pathname before the rewrite so callers
 * who construct a URL via the URL constructor — like the docent —
 * get the same routing as callers who pass a raw path.
 *
 * Non-`/api/` relative paths (`/assets/...`, `/sw.js`, sample-tour
 * JSON, etc.) are deliberately NOT rewritten: they live in the
 * Tauri-bundled SPA and must continue to resolve against the
 * webview origin. The rewrite is gated narrowly to keep this helper
 * safe to reuse for non-catalog fetches in the future.
 */
export function resolveApiUrl(pathOrUrl: string): string {
  if (!isTauri()) return pathOrUrl
  let path = pathOrUrl
  if (typeof window !== 'undefined') {
    const origin = window.location.origin
    if (origin && path.startsWith(origin)) {
      path = path.slice(origin.length) || '/'
    }
  }
  if (!path.startsWith('/api/')) return path
  return `${getApiOrigin()}${path}`
}

/**
 * `fetch` wrapper for `/api/...` calls. Pass-through to the
 * native `fetch` in web builds. In Tauri it rewrites the path
 * via {@link resolveApiUrl} and — only for the resulting absolute
 * `http(s)://` URL — routes through the Tauri HTTP plugin to
 * bypass webview CORS, which would otherwise reject every
 * cross-origin request because the catalog Pages Functions don't
 * set `Access-Control-Allow-Origin`. Same-origin relative paths
 * (the SPA's bundled `/assets/...`, `/sw.js`, etc.) deliberately
 * stay on native fetch: they don't need the plugin and the plugin
 * doesn't know about the webview origin. If the plugin failed to
 * load for an absolute URL, we still attempt native fetch but
 * emit a loud warning so the failure surfaces in logs instead of
 * looking like the original silent `<!DOCTYPE` crash.
 */
export async function apiFetch(
  pathOrUrl: string,
  init?: RequestInit,
): Promise<Response> {
  const url = resolveApiUrl(pathOrUrl)
  const isAbsolute = /^https?:\/\//i.test(url)
  if (isTauri() && isAbsolute) {
    const tauriFetch = await getTauriFetch()
    if (tauriFetch) return tauriFetch(url, init)
    logger.warn(
      `[catalog] Tauri HTTP plugin unavailable; native fetch for ${url} will likely be CORS-blocked.`,
    )
  }
  return fetch(url, init)
}
