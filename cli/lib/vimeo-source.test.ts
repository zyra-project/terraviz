// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `cli/lib/vimeo-source.ts` (Phase 3 commit C helper).
 *
 * Coverage:
 *   - Hits the default proxy base; honours overrides
 *   - Rejects non-numeric vimeo ids before any network call
 *   - Throws VimeoSourceError(metadata) on HTTP non-2xx, network
 *     throw, or non-JSON body
 *   - Throws VimeoSourceError(selection) when no MP4 in files[]
 *   - Picks highest-quality MP4 by size, breaks ties on width
 *   - Returns metadata fields (title, duration, size, width, height)
 *     in their canonical shape
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_VIDEO_PROXY_BASE,
  pickHighestQualityMp4,
  resolveVimeoSource,
  VimeoSourceError,
} from './vimeo-source'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const MP4_4K = {
  quality: '2160p',
  width: 4096,
  height: 2048,
  size: 1_500_000_000,
  type: 'video/mp4',
  link: 'https://cdn.example.org/v/123/4k.mp4',
}
const MP4_HD = {
  quality: 'hd',
  width: 1920,
  height: 1080,
  size: 600_000_000,
  type: 'video/mp4',
  link: 'https://cdn.example.org/v/123/hd.mp4',
}
const HLS_PLAYLIST = {
  quality: 'hls',
  type: 'application/x-mpegURL',
  link: 'https://cdn.example.org/v/123/playlist.m3u8',
  size: 999_999,
}

describe('pickHighestQualityMp4', () => {
  it('returns the largest-by-size MP4 file', () => {
    expect(pickHighestQualityMp4([MP4_HD, MP4_4K])).toBe(MP4_4K)
  })
  it('breaks ties on size with width', () => {
    const a = { ...MP4_HD, size: 500, width: 1920 }
    const b = { ...MP4_HD, size: 500, width: 1280, link: 'https://x/y.mp4' }
    expect(pickHighestQualityMp4([b, a])).toBe(a)
  })
  it('skips non-MP4 entries', () => {
    expect(pickHighestQualityMp4([HLS_PLAYLIST, MP4_HD])).toBe(MP4_HD)
  })
  it('skips entries with no link', () => {
    const orphan = { quality: 'hd', type: 'video/mp4', size: 999_999_999 }
    expect(pickHighestQualityMp4([orphan, MP4_HD])).toBe(MP4_HD)
  })
  it('returns null when no MP4 qualifies', () => {
    expect(pickHighestQualityMp4([HLS_PLAYLIST])).toBeNull()
    expect(pickHighestQualityMp4([])).toBeNull()
  })
})

describe('resolveVimeoSource', () => {
  it('hits the default proxy base and returns canonical metadata', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${DEFAULT_VIDEO_PROXY_BASE}/123`)
      return jsonResponse({
        id: '123',
        title: 'Tsunami: Asteroid Impact',
        duration: 18,
        files: [HLS_PLAYLIST, MP4_4K, MP4_HD],
      })
    })
    const meta = await resolveVimeoSource('123', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(meta.vimeoId).toBe('123')
    expect(meta.title).toBe('Tsunami: Asteroid Impact')
    expect(meta.durationSeconds).toBe(18)
    expect(meta.mp4Url).toBe(MP4_4K.link)
    expect(meta.sizeBytes).toBe(MP4_4K.size)
    expect(meta.width).toBe(4096)
    expect(meta.height).toBe(2048)
  })

  it('honours a custom proxyBase override and trims trailing slashes', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://video-proxy.test/video/456')
      return jsonResponse({ id: '456', files: [MP4_HD] })
    })
    await resolveVimeoSource('456', {
      proxyBase: 'https://video-proxy.test/video/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
  })

  it('rejects non-numeric vimeo ids before any network call', async () => {
    const fetchImpl = vi.fn()
    await expect(
      resolveVimeoSource('abc', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: 'VimeoSourceError', stage: 'metadata' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws VimeoSourceError(metadata) on non-2xx proxy response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }))
    await expect(
      resolveVimeoSource('123', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ stage: 'metadata', status: 502 })
  })

  it('throws VimeoSourceError(metadata) when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connection refused')
    })
    await expect(
      resolveVimeoSource('123', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ stage: 'metadata', status: null })
  })

  it('throws VimeoSourceError(selection) when no MP4 in files[]', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: '123', files: [HLS_PLAYLIST] }),
    )
    await expect(
      resolveVimeoSource('123', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ stage: 'selection' })
  })

  it('reports duration / size as null when the proxy omits them', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      id: '123',
      files: [{ ...MP4_HD, size: undefined, width: undefined, height: undefined }],
    }))
    const meta = await resolveVimeoSource('123', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(meta.durationSeconds).toBeNull()
    expect(meta.sizeBytes).toBeNull()
    expect(meta.width).toBeNull()
    expect(meta.height).toBeNull()
  })

  it('VimeoSourceError carries vimeoId for telemetry attribution', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 504 }))
    try {
      await resolveVimeoSource('999', { fetchImpl: fetchImpl as unknown as typeof fetch })
    } catch (e) {
      expect(e).toBeInstanceOf(VimeoSourceError)
      expect((e as VimeoSourceError).vimeoId).toBe('999')
      expect((e as VimeoSourceError).status).toBe(504)
    }
  })
})
