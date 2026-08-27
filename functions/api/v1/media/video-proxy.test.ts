// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire tests for the video-proxy — the allowlist gate (only hosts a
 * registered enabled source serves), Range + CORS passthrough, and the
 * OPTIONS preflight. Uses a stubbed upstream fetch (no network).
 */

import { describe, expect, it, vi } from 'vitest'
import { onRequestGet, onRequestHead, onRequestOptions } from './video-proxy'
import { asD1, seedFixtures } from '../_lib/test-helpers'
import { insertVideoSource } from '../_lib/video-sources-store'
import { upsertIndexedVideo } from '../_lib/video-index-store'

const NOW = '2026-07-17T12:00:00.000Z'

async function envWithAllowlistedHost(host: string, enabled = true) {
  const sqlite = seedFixtures({ count: 0 })
  const d = asD1(sqlite)
  const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml', enabled }, NOW)
  await upsertIndexedVideo(
    d,
    src.id,
    {
      externalId: 'https://ot.example/a.html',
      pageUrl: 'https://ot.example/a.html',
      title: 'A',
      description: 'a',
      tags: [],
      contentUrl: `https://${host}/a.mp4`,
      contentHost: host,
    },
    { vector: new Array(768).fill(0.1), version: 1, textHash: 'h' },
    NOW,
  )
  return { CATALOG_DB: d }
}

function ctx(env: Record<string, unknown>, url: string, headers: Record<string, string> = {}, method = 'GET') {
  return {
    request: new Request(url, { method, headers }),
    env,
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/media/video-proxy',
  } as unknown as Parameters<typeof onRequestGet>[0]
}

const PROXY = 'https://localhost/api/v1/media/video-proxy'

describe('video-proxy', () => {
  it('OPTIONS returns CORS preflight', async () => {
    const res = await onRequestOptions(ctx({}, PROXY, {}, 'OPTIONS'))
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('refuses a missing or non-http url', async () => {
    const env = await envWithAllowlistedHost('oceantoday.noaa.gov')
    expect((await onRequestGet(ctx(env, PROXY))).status).toBe(400)
    expect((await onRequestGet(ctx(env, `${PROXY}?url=ftp://oceantoday.noaa.gov/a.mp4`))).status).toBe(400)
  })

  it('refuses a host not on the registered-source allowlist', async () => {
    const env = await envWithAllowlistedHost('oceantoday.noaa.gov')
    const res = await onRequestGet(ctx(env, `${PROXY}?url=${encodeURIComponent('https://evil.example/a.mp4')}`))
    expect(res.status).toBe(403)
  })

  it('refuses a host whose source is disabled', async () => {
    const env = await envWithAllowlistedHost('oceantoday.noaa.gov', false)
    const res = await onRequestGet(ctx(env, `${PROXY}?url=${encodeURIComponent('https://oceantoday.noaa.gov/a.mp4')}`))
    expect(res.status).toBe(403)
  })

  it('proxies an allowlisted host, forwarding Range and adding CORS', async () => {
    const env = await envWithAllowlistedHost('oceantoday.noaa.gov')
    const seenInit: RequestInit[] = []
    const orig = globalThis.fetch
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenInit.push(init ?? {})
      return new Response('partialbytes', {
        status: 206,
        headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-11/1000', 'accept-ranges': 'bytes' },
      })
    }) as unknown as typeof fetch
    try {
      const res = await onRequestGet(
        ctx(env, `${PROXY}?url=${encodeURIComponent('https://oceantoday.noaa.gov/a.mp4')}`, { Range: 'bytes=0-11' }),
      )
      expect(res.status).toBe(206)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(res.headers.get('content-range')).toBe('bytes 0-11/1000')
      expect(res.headers.get('accept-ranges')).toBe('bytes')
      // The client's Range reached upstream.
      expect((seenInit[0].headers as Record<string, string>).Range).toBe('bytes=0-11')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('neutralizes a non-media content-type and forbids MIME sniffing', async () => {
    const env = await envWithAllowlistedHost('oceantoday.noaa.gov')
    const orig = globalThis.fetch
    // An allowlisted host (or a redirect it followed) serving HTML must
    // NOT be rendered as HTML on the app origin.
    globalThis.fetch = vi.fn(async () => new Response('<script>alert(1)</script>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch
    try {
      const res = await onRequestGet(ctx(env, `${PROXY}?url=${encodeURIComponent('https://oceantoday.noaa.gov/a.mp4')}`))
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('passes a real media content-type through', async () => {
    const env = await envWithAllowlistedHost('oceantoday.noaa.gov')
    const orig = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('bytes', {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    })) as unknown as typeof fetch
    try {
      const res = await onRequestGet(ctx(env, `${PROXY}?url=${encodeURIComponent('https://oceantoday.noaa.gov/a.mp4')}`))
      expect(res.headers.get('content-type')).toBe('video/mp4')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('HEAD returns headers with no body', async () => {
    const env = await envWithAllowlistedHost('oceantoday.noaa.gov')
    const orig = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('x', { status: 200, headers: { 'content-length': '1000', 'content-type': 'video/mp4' } })) as unknown as typeof fetch
    try {
      const res = await onRequestHead(ctx(env, `${PROXY}?url=${encodeURIComponent('https://oceantoday.noaa.gov/a.mp4')}`, {}, 'HEAD'))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-length')).toBe('1000')
      expect(await res.text()).toBe('')
    } finally {
      globalThis.fetch = orig
    }
  })
})
