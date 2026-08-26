// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Resolve a `vimeo:<id>` reference to a source MP4 download URL.
 *
 * Phase 3 commit C helper. Slimmer than Phase 2's `vimeo-fetch.ts`
 * (the unmerged version) because Phase 3 doesn't need the byte
 * stream — FFmpeg takes the URL directly via `-i`. So this helper
 * stops at "give me the URL and the metadata," skipping the
 * fetch-and-buffer step entirely.
 *
 * Returns the highest-quality MP4 variant from the video-proxy's
 * `files[]` array. Quality selection prefers largest `size`, ties
 * broken by `width`. Non-MP4 entries (HLS playlists, audio-only)
 * are skipped — FFmpeg can read them too, but a single-file MP4
 * source is the most predictable input for our encode ladder.
 *
 * No Vimeo direct-API path. The proxy is ours, knows what variants
 * are available, and canonicalises the API surface. If a future
 * deploy needs higher-resolution downloads than the proxy serves,
 * that's a proxy-tier change, not a CLI change.
 */

export const DEFAULT_VIDEO_PROXY_BASE = 'https://video-proxy.zyra-project.org/video'

interface VideoProxyManifest {
  id: string
  title?: string
  duration?: number
  hls?: string
  files?: VideoProxyFile[]
}

interface VideoProxyFile {
  quality?: string
  width?: number
  height?: number
  size?: number
  type?: string
  link?: string
}

export interface VimeoSourceMetadata {
  /** Numeric Vimeo id — the value half of `vimeo:<id>`. */
  vimeoId: string
  /** Title from the proxy's manifest; empty string when absent. */
  title: string
  /** Duration in seconds. `null` when the proxy didn't report one. */
  durationSeconds: number | null
  /** Highest-quality MP4 download URL — pass directly to ffmpeg
   * as the `-i` input. */
  mp4Url: string
  /** Advertised file size in bytes when the proxy reported one. */
  sizeBytes: number | null
  /** Source resolution when the proxy reported it. */
  width: number | null
  height: number | null
}

export class VimeoSourceError extends Error {
  readonly vimeoId: string
  readonly stage: 'metadata' | 'selection'
  readonly status: number | null

  constructor(
    vimeoId: string,
    stage: 'metadata' | 'selection',
    status: number | null,
    message: string,
  ) {
    super(message)
    this.name = 'VimeoSourceError'
    this.vimeoId = vimeoId
    this.stage = stage
    this.status = status
  }
}

export interface VimeoSourceOptions {
  /** Override the proxy base URL. Defaults to the production zone. */
  proxyBase?: string
  /** Test injection — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Resolve a Vimeo id to its source metadata via the proxy.
 * Throws `VimeoSourceError` on unreachable proxy, non-2xx
 * response, malformed JSON, or no usable MP4 in the file list.
 */
export async function resolveVimeoSource(
  vimeoId: string,
  options: VimeoSourceOptions = {},
): Promise<VimeoSourceMetadata> {
  if (!/^\d+$/.test(vimeoId)) {
    throw new VimeoSourceError(
      vimeoId,
      'metadata',
      null,
      `vimeo id "${vimeoId}" is not numeric — refusing to construct an upstream URL.`,
    )
  }
  const proxyBase = (options.proxyBase ?? DEFAULT_VIDEO_PROXY_BASE).replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${proxyBase}/${vimeoId}`

  let res: Response
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  } catch (e) {
    throw new VimeoSourceError(
      vimeoId,
      'metadata',
      null,
      `proxy ${url} unreachable: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!res.ok) {
    throw new VimeoSourceError(
      vimeoId,
      'metadata',
      res.status,
      `proxy ${url} returned HTTP ${res.status}.`,
    )
  }
  let manifest: VideoProxyManifest
  try {
    manifest = (await res.json()) as VideoProxyManifest
  } catch (e) {
    throw new VimeoSourceError(
      vimeoId,
      'metadata',
      res.status,
      `proxy ${url} returned a non-JSON body: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const file = pickHighestQualityMp4(manifest.files ?? [])
  if (!file || !file.link) {
    throw new VimeoSourceError(
      vimeoId,
      'selection',
      null,
      `proxy manifest for vimeo:${vimeoId} contains no usable video/mp4 file.`,
    )
  }
  return {
    vimeoId,
    title: manifest.title ?? '',
    durationSeconds:
      typeof manifest.duration === 'number' && Number.isFinite(manifest.duration) && manifest.duration >= 0
        ? manifest.duration
        : null,
    mp4Url: file.link,
    sizeBytes:
      typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0 ? file.size : null,
    width: typeof file.width === 'number' && file.width > 0 ? file.width : null,
    height: typeof file.height === 'number' && file.height > 0 ? file.height : null,
  }
}

/**
 * Pick the highest-quality MP4 from the proxy's files array.
 * Largest `size` wins; ties break to largest `width`. Non-MP4
 * entries skipped. Returns `null` when no MP4 qualifies.
 *
 * Exported for tests + the operator-runbook example that prints
 * the picker's choice without resolving over the network.
 */
export function pickHighestQualityMp4(files: VideoProxyFile[]): VideoProxyFile | null {
  let best: VideoProxyFile | null = null
  for (const file of files) {
    if (!file || typeof file !== 'object') continue
    if (!file.link) continue
    const type = (file.type ?? '').toLowerCase()
    if (type !== 'video/mp4') continue
    if (best === null) {
      best = file
      continue
    }
    const bestSize = best.size ?? 0
    const fileSize = file.size ?? 0
    if (fileSize > bestSize) {
      best = file
      continue
    }
    if (fileSize === bestSize && (file.width ?? 0) > (best.width ?? 0)) {
      best = file
    }
  }
  return best
}
