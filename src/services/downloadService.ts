/**
 * Download Service — manages offline dataset downloads via Tauri backend.
 *
 * Desktop-only (Tauri). All functions are no-ops on the web.
 */

import type { Dataset } from '../types'
import { dataService } from './dataService'
import { logger } from '../utils/logger'

const IS_TAURI = !!(window as any).__TAURI__

const VIDEO_PROXY_BASE = 'https://video-proxy.zyra-project.org/video'

// Use Tauri's CORS-free fetch for HEAD probes when available.
let tauriFetch: typeof globalThis.fetch | null = null
if (IS_TAURI) {
  import('@tauri-apps/plugin-http').then(m => {
    tauriFetch = m.fetch as typeof globalThis.fetch
  }).catch(() => {})
}
function corsFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (tauriFetch) return tauriFetch(input, init)
  return fetch(input, init)
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

/** Resolve the best video file for download (highest quality MP4). */
async function resolveVideoAssets(dataset: Dataset): Promise<{ assets: AssetInput[]; totalSize: number }> {
  const vimeoId = dataService.extractVimeoId(dataset.dataLink)
  if (!vimeoId) throw new Error(`Cannot extract Vimeo ID from ${dataset.dataLink}`)

  const res = await fetch(`${VIDEO_PROXY_BASE}/${vimeoId}`)
  if (!res.ok) throw new Error(`Video proxy returned ${res.status}`)
  const manifest: VideoProxyResponse = await res.json()

  // Pick highest quality MP4
  const sorted = [...manifest.files].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  const best = sorted[0]
  if (!best) throw new Error('No video files available')

  const assets: AssetInput[] = [{ url: best.link, filename: 'video.mp4' }]
  let totalSize = best.size

  return { assets, totalSize }
}

/** Resolve image assets for download (highest available resolution). */
async function resolveImageAssets(dataset: Dataset): Promise<{ assets: AssetInput[]; primaryFile: string }> {
  const url = dataset.dataLink
  const ext = url.match(/(\.\w+)$/)
  const base = ext ? url.slice(0, -ext[1].length) : url
  const suffix = ext ? ext[1] : ''

  // Try resolutions from highest to lowest; use the first that responds 200
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

  // Add supplementary assets
  if (dataset.thumbnailLink) {
    const thumbExt = dataset.thumbnailLink.match(/(\.\w+)$/)?.[1] ?? '.jpg'
    assets.push({ url: dataset.thumbnailLink, filename: `thumbnail${thumbExt}` })
  }
  if (dataset.legendLink) {
    const legendExt = dataset.legendLink.match(/(\.\w+)$/)?.[1] ?? '.png'
    assets.push({ url: dataset.legendLink, filename: `legend${legendExt}` })
  }
  if (dataset.closedCaptionLink) {
    // Caption URLs from sos.noaa.gov need to go through the proxy
    const captionUrl = dataset.closedCaptionLink.includes('sos.noaa.gov')
      ? `https://video-proxy.zyra-project.org/captions?url=${encodeURIComponent(dataset.closedCaptionLink)}`
      : dataset.closedCaptionLink
    assets.push({ url: captionUrl, filename: 'captions.srt' })
  }
  const ext = dataset.thumbnailLink?.match(/(\.\w+)$/)?.[1] ?? '.jpg'
  const legendExt = dataset.legendLink?.match(/(\.\w+)$/)?.[1] ?? '.png'

  const input: DownloadInput = {
    datasetId: dataset.id,
    title: dataset.title,
    format: dataset.format,
    kind,
    primaryFile,
    captionFile: dataset.closedCaptionLink ? 'captions.srt' : null,
    thumbnailFile: dataset.thumbnailLink ? `thumbnail${ext}` : null,
    legendFile: dataset.legendLink ? `legend${legendExt}` : null,
    assets,
  }

  logger.info('[Download] Starting download:', dataset.id, assets.map(a => a.filename))
  await cmd('download_dataset', { input })
}

/** Cancel an in-progress download. */
export async function cancelDownload(datasetId: string): Promise<void> {
  await cmd('cancel_download', { datasetId })
}

/** List all downloaded datasets. */
export async function listDownloads(): Promise<DownloadedDataset[]> {
  return cmd<DownloadedDataset[]>('list_downloads')
}

/** Check if a specific dataset is downloaded. */
export async function getDownload(datasetId: string): Promise<DownloadedDataset | null> {
  return cmd<DownloadedDataset | null>('get_download', { datasetId })
}

/** Delete a downloaded dataset. */
export async function deleteDownload(datasetId: string): Promise<void> {
  await cmd('delete_download', { datasetId })
}

/** Get the local file path for a downloaded asset. */
export async function getDownloadPath(datasetId: string, filename: string): Promise<string | null> {
  return cmd<string | null>('get_download_path', { datasetId, filename })
}

/** Get total disk usage of all downloaded datasets. */
export async function getDownloadsSize(): Promise<number> {
  return cmd<number>('get_downloads_size')
}

/** Check if a download is currently in progress. */
export async function isDownloading(datasetId: string): Promise<boolean> {
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
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}
