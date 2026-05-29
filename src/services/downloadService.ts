/**
 * Download Service — manages offline dataset downloads via Tauri backend.
 *
 * Desktop-only (Tauri). All functions are no-ops on the web.
 */

import type { Dataset } from '../types'
import { dataService } from './dataService'
import { apiFetch, isManifestUrl } from './catalogSource'
import { proxyCaptionUrl } from '../utils/captionProxy'
import { logger } from '../utils/logger'
import { VIDEO_PROXY_BASE } from '../config/endpoints'

const IS_TAURI = !!(window as any).__TAURI__

// Use Tauri's CORS-free fetch for HEAD probes when available.
const tauriFetchReady: Promise<typeof globalThis.fetch | null> = IS_TAURI
  ? import('@tauri-apps/plugin-http')
      .then(m => m.fetch as typeof globalThis.fetch)
      .catch(() => null)
  : Promise.resolve(null)

async function corsFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const f = await tauriFetchReady
  return f ? f(input, init) : fetch(input, init)
}

// --- Types ---

export interface DownloadedDataset {
  dataset_id: string
  title: string
  format: string
  kind: string
  primary_file: string
  caption_file: string | null
  thumbnail_file: string | null
  legend_file: string | null
  total_bytes: number
  downloaded_at: string
}

export interface DownloadProgress {
  dataset_id: string
  title: string
  downloaded_bytes: number
  total_bytes: number
  phase: string
}

interface AssetInput {
  url: string
  filename: string
}

interface DownloadInput {
  datasetId: string
  title: string
  format: string
  kind: string
  primaryFile: string
  captionFile: string | null
  thumbnailFile: string | null
  legendFile: string | null
  assets: AssetInput[]
}

interface VideoProxyFile {
  quality: string
  width?: number
  height?: number
  size: number
  type: string
  link: string
}

interface VideoProxyResponse {
  id: string
  title: string
  duration: number
  hls: string
  dash: string
  files: VideoProxyFile[]
}

// --- Tauri invoke helper ---

let invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null
let listen: ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null

const tauriReady: Promise<boolean> = IS_TAURI
  ? Promise.all([
    import('@tauri-apps/api/core').then(m => { invoke = m.invoke }),
    import('@tauri-apps/api/event').then(m => { listen = m.listen }),
  ]).then(() => true).catch(() => false)
  : Promise.resolve(false)

async function cmd<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  await tauriReady
  if (!invoke) throw new Error('Tauri not available')
  return invoke(name, args) as Promise<T>
}

// --- Public API ---

/** Check if we're running in a desktop context that supports downloads. */
export function isDownloadAvailable(): boolean {
  return IS_TAURI
}

/**
 * True if `url` is an absolute http(s) URL — i.e. something the Rust
 * download manager (reqwest) can actually fetch. Catches the failure
 * modes that previously surfaced as opaque `HTTP request failed:
 * builder error` in the Rust log: relative paths (`/api/v1/...`),
 * raw `r2:` / `stream:` / `vimeo:` data_ref schemes leaked through
 * the catalog serializer, and empty strings.
 */
function isHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false
  return /^https?:\/\//i.test(url)
}

/**
 * Pull the file extension off a URL (`.mp4`, `.jpg`, `.png`), tolerant
 * of query strings. Falls back to `defaultExt` if nothing matches.
 */
function extFromUrl(url: string, defaultExt: string): string {
  const match = url.match(/(\.\w+)(\?|#|$)/)
  return match ? match[1] : defaultExt
}

/**
 * Fetch the catalog's manifest envelope for a node-mode dataset. The
 * envelope shape is documented in
 * `functions/api/v1/datasets/[id]/manifest.ts`: `{ kind: 'video' |
 * 'image', ... }` with `files[]` for videos and `variants[]` +
 * `fallback` for images. Same shape datasetLoader.ts consumes for
 * playback, kept in sync here so download and play resolve to the
 * same underlying URLs.
 */
async function fetchManifestEnvelope(dataLink: string): Promise<
  | { kind: 'video'; files?: VideoProxyFile[] }
  | { kind: 'image'; variants?: Array<{ width: number; url: string }>; fallback?: string }
> {
  const res = await apiFetch(dataLink, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status} ${res.statusText}`)
  return res.json()
}

/**
 * Pure picker over a video manifest envelope's `files[]`: returns the
 * highest-width MP4 with an http(s) link, or throws a typed error.
 * Extracted so unit tests can call into the real selection logic
 * (sort + HLS-empty guard + non-HTTP guard) rather than re-implementing
 * it inline.
 */
function pickBestVideoFile(envelope: { kind: 'video'; files?: VideoProxyFile[] }): {
  link: string
  size: number
} {
  const files = envelope.files ?? []
  if (files.length === 0) {
    // R2 HLS bundles (Phase 3 r2-hls migration) populate `hls` but
    // leave `files[]` empty — there's no direct MP4 to grab and
    // reassembling a playlist + .ts segments into a single offline
    // file is a follow-on feature. Surface a clear error so the UI
    // can render something better than reqwest's `builder error`.
    throw new Error(
      'This dataset is HLS-streamed and not yet available for offline download. ' +
      'Open it online to view, or try a different dataset for offline use.',
    )
  }
  const sorted = [...files].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  const best = sorted[0]
  if (!isHttpUrl(best.link)) {
    throw new Error(`Video manifest returned a non-HTTP file link: ${best.link}`)
  }
  return { link: best.link, size: best.size }
}

/**
 * Pure ordering over an image manifest envelope: returns http(s)-only
 * candidate URLs, highest-width variant first, with `fallback`
 * appended last. Empty result is valid — callers throw their own
 * "no usable variants" error so the message matches their context.
 */
function orderImageCandidates(envelope: {
  kind: 'image'
  variants?: Array<{ width: number; url: string }>
  fallback?: string
}): string[] {
  const variants = [...(envelope.variants ?? [])].sort((a, b) => b.width - a.width)
  return [
    ...variants.map(v => v.url),
    ...(envelope.fallback ? [envelope.fallback] : []),
  ].filter(isHttpUrl)
}

/** Resolve the best video file for download (highest quality MP4). */
async function resolveVideoAssets(dataset: Dataset): Promise<{ assets: AssetInput[]; totalSize: number }> {
  // Node-mode: dataLink is `/api/v1/datasets/{id}/manifest`. Fetch
  // the envelope and walk `files[]` — same path datasetLoader.ts
  // uses for playback. The legacy direct-Vimeo path below stays for
  // catalogs that still serve vimeo.com URLs in dataLink (the
  // `legacy` catalog source).
  if (isManifestUrl(dataset.dataLink)) {
    const envelope = await fetchManifestEnvelope(dataset.dataLink)
    if (envelope.kind !== 'video') {
      throw new Error(`Expected a video manifest; got kind=${envelope.kind}.`)
    }
    const best = pickBestVideoFile(envelope)
    return { assets: [{ url: best.link, filename: 'video.mp4' }], totalSize: best.size }
  }

  // Legacy catalog: dataLink is a vimeo.com URL, resolve via proxy.
  const vimeoId = dataService.extractVimeoId(dataset.dataLink)
  if (!vimeoId) throw new Error(`Cannot extract Vimeo ID from ${dataset.dataLink}`)

  const res = await fetch(`${VIDEO_PROXY_BASE}/${vimeoId}`)
  if (!res.ok) throw new Error(`Video proxy returned ${res.status}`)
  const manifest: VideoProxyResponse = await res.json()

  const sorted = [...manifest.files].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  const best = sorted[0]
  if (!best) throw new Error('No video files available')
  return { assets: [{ url: best.link, filename: 'video.mp4' }], totalSize: best.size }
}

/** Resolve image assets for download (highest available resolution). */
async function resolveImageAssets(dataset: Dataset): Promise<{ assets: AssetInput[]; primaryFile: string }> {
  // Node-mode: dataLink is the manifest endpoint. Walk `variants[]`
  // highest-width-first, HEAD-probe each, fall back to `fallback`.
  if (isManifestUrl(dataset.dataLink)) {
    const envelope = await fetchManifestEnvelope(dataset.dataLink)
    if (envelope.kind !== 'image') {
      throw new Error(`Expected an image manifest; got kind=${envelope.kind}.`)
    }
    const ordered = orderImageCandidates(envelope)
    if (ordered.length === 0) {
      throw new Error('Image manifest returned no usable variants')
    }
    for (const candidateUrl of ordered) {
      try {
        const probe = await corsFetch(candidateUrl, { method: 'HEAD' })
        if (probe.ok) {
          const ext = extFromUrl(candidateUrl, '.jpg')
          const filename = `image${ext}`
          return { assets: [{ url: candidateUrl, filename }], primaryFile: filename }
        }
      } catch { /* try next */ }
    }
    // No HEAD probe succeeded; trust the highest-resolution variant
    // and let the Rust downloader surface the real HTTP error if it
    // 404s. Same fail-soft posture as the legacy path below.
    const fallback = ordered[0]
    const ext = extFromUrl(fallback, '.jpg')
    const filename = `image${ext}`
    return { assets: [{ url: fallback, filename }], primaryFile: filename }
  }

  // Legacy: SPA mangles the suffix to probe `_4096` / `_2048` /
  // original. Kept for catalogs that still serve direct asset URLs.
  const url = dataset.dataLink
  const ext = url.match(/(\.\w+)$/)
  const base = ext ? url.slice(0, -ext[1].length) : url
  const suffix = ext ? ext[1] : ''

  const candidates = [
    { url: `${base}_4096${suffix}`, filename: `image_4096${suffix}` },
    { url: `${base}_2048${suffix}`, filename: `image_2048${suffix}` },
    { url, filename: `image${suffix}` },
  ]

  for (const candidate of candidates) {
    try {
      const res = await corsFetch(candidate.url, { method: 'HEAD' })
      if (res.ok) {
        return { assets: [candidate], primaryFile: candidate.filename }
      }
    } catch {
      // Try next
    }
  }

  // Last resort: use original URL and hope for the best
  const fallback = candidates[candidates.length - 1]
  return { assets: [fallback], primaryFile: fallback.filename }
}

/** Get the estimated download size for a dataset. */
export async function getDownloadSize(dataset: Dataset): Promise<number> {
  if (!IS_TAURI) return 0

  const isVideo = dataset.format === 'video/mp4'
  if (isVideo) {
    try {
      const { totalSize } = await resolveVideoAssets(dataset)
      return totalSize
    } catch {
      return 0
    }
  }
  return 0 // Can't determine image sizes without HEAD requests
}

/** Start downloading a dataset for offline use. */
export async function downloadDataset(dataset: Dataset): Promise<void> {
  if (!IS_TAURI) return

  const isVideo = dataset.format === 'video/mp4'
  const kind = isVideo ? 'video' : 'image'

  let assets: AssetInput[]
  let primaryFile: string
  if (isVideo) {
    const result = await resolveVideoAssets(dataset)
    assets = result.assets
    primaryFile = 'video.mp4'
  } else {
    const result = await resolveImageAssets(dataset)
    assets = result.assets
    primaryFile = result.primaryFile
  }

  // Supplementary assets. The catalog serializer currently passes
  // `thumbnail_ref` / `legend_ref` / `caption_ref` through verbatim
  // (see functions/api/v1/_lib/dataset-serializer.ts:154-156), so
  // they may arrive as raw `r2:` / `stream:` / `vimeo:` URIs rather
  // than absolute https URLs. Filter to http(s) only — reqwest
  // refuses anything else with a `builder error` that previously
  // killed the whole download, and a missing thumbnail is much
  // better UX than a failed download.
  let hasThumbnail = false
  let hasLegend = false
  let hasCaption = false
  if (isHttpUrl(dataset.thumbnailLink)) {
    const thumbExt = extFromUrl(dataset.thumbnailLink, '.jpg')
    assets.push({ url: dataset.thumbnailLink, filename: `thumbnail${thumbExt}` })
    hasThumbnail = true
  } else if (dataset.thumbnailLink) {
    logger.warn('[Download] Skipping non-HTTP thumbnail ref:', dataset.thumbnailLink)
  }
  if (isHttpUrl(dataset.legendLink)) {
    const legendExt = extFromUrl(dataset.legendLink, '.png')
    assets.push({ url: dataset.legendLink, filename: `legend${legendExt}` })
    hasLegend = true
  } else if (dataset.legendLink) {
    logger.warn('[Download] Skipping non-HTTP legend ref:', dataset.legendLink)
  }
  if (isHttpUrl(dataset.closedCaptionLink)) {
    // Caption URLs from sos.noaa.gov need to go through the proxy.
    // Host-matched (not substring) so a URL like
    //   https://attacker.example/sos.noaa.gov/foo.srt
    // isn't accidentally routed through the proxy. See
    // `src/utils/captionProxy.ts`.
    const captionUrl = proxyCaptionUrl(dataset.closedCaptionLink)
    assets.push({ url: captionUrl, filename: 'captions.srt' })
    hasCaption = true
  } else if (dataset.closedCaptionLink) {
    logger.warn('[Download] Skipping non-HTTP caption ref:', dataset.closedCaptionLink)
  }
  const ext = isHttpUrl(dataset.thumbnailLink) ? extFromUrl(dataset.thumbnailLink, '.jpg') : '.jpg'
  const legendExt = isHttpUrl(dataset.legendLink) ? extFromUrl(dataset.legendLink, '.png') : '.png'

  const input: DownloadInput = {
    datasetId: dataset.id,
    title: dataset.title,
    format: dataset.format,
    kind,
    primaryFile,
    captionFile: hasCaption ? 'captions.srt' : null,
    thumbnailFile: hasThumbnail ? `thumbnail${ext}` : null,
    legendFile: hasLegend ? `legend${legendExt}` : null,
    assets,
  }

  logger.info('[Download] Starting download:', dataset.id, assets.map(a => a.filename))
  await cmd('download_dataset', { input })
}

/** Cancel an in-progress download. */
export async function cancelDownload(datasetId: string): Promise<void> {
  if (!IS_TAURI) return
  await cmd('cancel_download', { datasetId })
}

/** List all downloaded datasets. */
export async function listDownloads(): Promise<DownloadedDataset[]> {
  if (!IS_TAURI) return []
  return cmd<DownloadedDataset[]>('list_downloads')
}

/** Check if a specific dataset is downloaded. */
export async function getDownload(datasetId: string): Promise<DownloadedDataset | null> {
  if (!IS_TAURI) return null
  return cmd<DownloadedDataset | null>('get_download', { datasetId })
}

/** Delete a downloaded dataset. */
export async function deleteDownload(datasetId: string): Promise<void> {
  if (!IS_TAURI) return
  await cmd('delete_download', { datasetId })
}

/** Get the local file path for a downloaded asset. */
export async function getDownloadPath(datasetId: string, filename: string): Promise<string | null> {
  if (!IS_TAURI) return null
  return cmd<string | null>('get_download_path', { datasetId, filename })
}

/** Get total disk usage of all downloaded datasets. */
export async function getDownloadsSize(): Promise<number> {
  if (!IS_TAURI) return 0
  return cmd<number>('get_downloads_size')
}

/** Check if a download is currently in progress. */
export async function isDownloading(datasetId: string): Promise<boolean> {
  if (!IS_TAURI) return false
  return cmd<boolean>('is_downloading', { datasetId })
}

/** Listen for download progress events. Returns an unsubscribe function. */
export async function onDownloadProgress(handler: (progress: DownloadProgress) => void): Promise<() => void> {
  await tauriReady
  if (!listen) return () => {}
  return listen('download-progress', (e) => handler(e.payload as DownloadProgress))
}

/** Listen for download completion events. Returns an unsubscribe function. */
export async function onDownloadComplete(handler: (datasetId: string) => void): Promise<() => void> {
  await tauriReady
  if (!listen) return () => {}
  return listen('download-complete', (e) => handler(e.payload as string))
}

/** Listen for download error events. Returns an unsubscribe function. */
export async function onDownloadError(handler: (datasetId: string, error: string) => void): Promise<() => void> {
  await tauriReady
  if (!listen) return () => {}
  return listen('download-error', (e) => {
    const [id, err] = e.payload as [string, string]
    handler(id, err)
  })
}

/** Format bytes into a human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}

/**
 * Test-only surface. Exposes the pure helpers used by `resolveVideo
 * Assets` / `resolveImageAssets` / `downloadDataset` so unit tests
 * call into the real implementation rather than re-running the same
 * logic inline (which would let production drift silently). Don't
 * import this outside `*.test.ts`.
 */
export const __test__ = {
  isHttpUrl,
  extFromUrl,
  pickBestVideoFile,
  orderImageCandidates,
}
