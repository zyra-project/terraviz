// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The video proxy that resolves a `vimeo:<id>` `data_ref` to a playable
 * stream, shared by the manifest (`datasets/[id]/manifest.ts`) and the
 * exhibit's card (`_lib/exhibit-reads.ts`), which reads the stream's own
 * playlists for the clip's exact length (`hls-duration.ts`).
 *
 * The proxy returns `{ id, title, duration, hls, dash, files }`. `dash`
 * is dropped (the frontend never used it) and `kind: "video"` stamped, so
 * the manifest's union discriminator is in place. Its `duration` is
 * Vimeo's own, in whole seconds, and stays the manifest's meaning.
 */

/** Where the proxy runs when `VIDEO_PROXY_BASE` doesn't say. */
export const DEFAULT_VIDEO_PROXY_BASE = 'https://video-proxy.zyra-project.org/video'

export interface VideoProxyFile {
  quality: string
  width?: number
  height?: number
  size: number
  type: string
  link: string
}

export interface VideoManifest {
  kind: 'video'
  id: string
  title: string
  duration: number
  hls: string
  files: VideoProxyFile[]
}

/**
 * Resolve a `vimeo:<id>` to a `VideoManifest` by calling the upstream
 * proxy, or `null` when it doesn't answer with one. A manifest whose
 * proxy fails is a 502: this is one of the few paths in the catalog
 * backend with a hard external dependency, so a clear error envelope is
 * worth more than a half-rendered manifest.
 */
export async function fetchVimeoManifest(
  vimeoId: string,
  proxyBase: string,
  fetchImpl: typeof fetch,
): Promise<VideoManifest | null> {
  return (await requestVimeoManifest(vimeoId, proxyBase, fetchImpl)).manifest
}

/** A Vimeo video id as the proxy takes one: digits, nothing that could
 *  make `${proxyBase}/${id}` another path on the proxy's host. */
export function isVimeoId(id: string): boolean {
  return /^[0-9]{1,20}$/.test(id)
}

/**
 * `fetchVimeoManifest` with the proxy's status beside it, for a caller
 * that tells a video that is gone (404, which the proxy passes on from
 * Vimeo for a deleted or never-existing id) from a proxy that is failing.
 * `manifest` is `null` for any status but a 2xx. An id that isn't one is
 * never sent (status 0), and a redirect, which the proxy never answers,
 * is not followed.
 */
export async function requestVimeoManifest(
  vimeoId: string,
  proxyBase: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ status: number; manifest: VideoManifest | null }> {
  if (!isVimeoId(vimeoId)) return { status: 0, manifest: null }
  const upstream = await fetchImpl(`${proxyBase}/${vimeoId}`, { redirect: 'manual', ...(signal ? { signal } : {}) })
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {})
    return { status: upstream.status, manifest: null }
  }
  return { status: upstream.status, manifest: await manifestFrom(upstream) }
}

async function manifestFrom(upstream: Response): Promise<VideoManifest> {
  const data = (await upstream.json()) as {
    id: string
    title?: string
    duration?: number
    hls: string
    files?: VideoProxyFile[]
  }
  return {
    kind: 'video',
    id: data.id,
    title: data.title ?? '',
    // The manifest's `duration` is never negative: anything the proxy
    // sends that isn't a usable length reads as unknown.
    duration:
      typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration > 0
        ? data.duration
        : 0,
    hls: data.hls,
    files: data.files ?? [],
  }
}
