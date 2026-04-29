/**
 * Tests for the manifest endpoint.
 *
 * Coverage:
 *   - 503 envelopes for missing CATALOG_DB and missing node_identity.
 *   - 404 for unknown / hidden / retracted / non-public dataset.
 *   - vimeo: data_ref → fetches the proxy, drops `dash`, returns the
 *     existing VideoProxyResponse-compatible shape with `kind`.
 *   - 502 when the upstream proxy errors.
 *   - 400 when the data_ref scheme and the dataset format don't
 *     agree (vimeo:<id> on an image dataset, etc.).
 *   - url:<href> for video → single-file synthesised manifest.
 *   - url:<href> for image → progressive-resolution variant ladder.
 *   - 501 for not-yet-implemented schemes (stream:, r2:, peer:).
 *   - 304 with `If-None-Match`.
 *   - Pure helpers (`parseDataRef`, `imageVariants`) are exercised
 *     directly so the wire-format invariants don't drift away from
 *     what the frontend expects.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  imageVariants,
  onRequestGet,
  parseDataRef,
  resolveManifest,
} from './manifest'
import {
  asD1,
  makeCtx,
  makeKV,
  seedFixtures,
} from '../../_lib/test-helpers'

const VIDEO_PROXY_BASE = 'https://video-proxy.test/video'

interface VideoBody {
  kind: 'video'
  id: string
  title: string
  duration: number
  hls: string
  files: Array<{ quality: string; type: string; link: string; size: number }>
}

interface ImageBody {
  kind: 'image'
  variants: Array<{ width: number; url: string }>
  fallback: string
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('parseDataRef', () => {
  it('splits scheme:value pairs', () => {
    expect(parseDataRef('vimeo:12345')).toEqual({ scheme: 'vimeo', value: '12345' })
    expect(parseDataRef('url:https://example.com/x.png')).toEqual({
      scheme: 'url',
      value: 'https://example.com/x.png',
    })
  })

  it('returns null on a malformed ref', () => {
    expect(parseDataRef('')).toBeNull()
    expect(parseDataRef('no-scheme-at-all')).toBeNull()
    expect(parseDataRef(':leading-colon')).toBeNull()
  })
})

describe('imageVariants', () => {
  it('builds the progressive-resolution ladder mirroring the frontend', () => {
    const m = imageVariants('https://example.com/foo.png')
    expect(m.kind).toBe('image')
    expect(m.fallback).toBe('https://example.com/foo.png')
    expect(m.variants).toEqual([
      { width: 4096, url: 'https://example.com/foo_4096.png' },
      { width: 2048, url: 'https://example.com/foo_2048.png' },
      { width: 1024, url: 'https://example.com/foo_1024.png' },
    ])
  })

  it('handles URLs without an extension', () => {
    const m = imageVariants('https://example.com/foo')
    expect(m.variants[0].url).toBe('https://example.com/foo_4096')
    expect(m.fallback).toBe('https://example.com/foo')
  })
})

describe('GET /api/v1/datasets/{id}/manifest', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 503 when CATALOG_DB is not bound', async () => {
    const ctx = makeCtx<'id'>({ env: {}, params: { id: 'whatever' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('binding_missing')
  })

  it('returns 503 when node_identity is missing', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite.prepare('DELETE FROM node_identity').run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('identity_missing')
  })

  it('returns 404 for unknown ids', async () => {
    const sqlite = seedFixtures({ count: 1 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx<'id'>({ env, params: { id: 'NOPE' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(404)
  })

  it('returns 404 for hidden / retracted / non-public datasets', async () => {
    const sqlite = seedFixtures({ count: 3 })
    sqlite.prepare(`UPDATE datasets SET is_hidden = 1 WHERE slug = 'dataset-0'`).run()
    sqlite
      .prepare(
        `UPDATE datasets SET retracted_at = '2026-02-01T00:00:00.000Z' WHERE slug = 'dataset-1'`,
      )
      .run()
    sqlite.prepare(`UPDATE datasets SET visibility = 'private' WHERE slug = 'dataset-2'`).run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    for (const id of [
      'DS000AAAAAAAAAAAAAAAAAAAAA',
      'DS001AAAAAAAAAAAAAAAAAAAAA',
      'DS002AAAAAAAAAAAAAAAAAAAAA',
    ]) {
      const res = await onRequestGet(makeCtx<'id'>({ env, params: { id } }))
      expect(res.status).toBe(404)
    }
  })

  it('resolves a vimeo: ref via the configured upstream proxy', async () => {
    const sqlite = seedFixtures({ count: 1 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      VIDEO_PROXY_BASE,
    }

    const fetchMock = vi.fn(async (input: RequestInfo) => {
      expect(String(input)).toBe(`${VIDEO_PROXY_BASE}/100`)
      return new Response(
        JSON.stringify({
          id: '100',
          title: 'Upstream Title',
          duration: 600,
          hls: 'https://cdn.test/hls.m3u8',
          dash: 'https://cdn.test/dash.mpd',
          files: [
            { quality: '720p', size: 42, type: 'video/mp4', link: 'https://cdn.test/720.mp4' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('max-age=300')
    const body = await readJson<VideoBody>(res)
    expect(body.kind).toBe('video')
    expect(body.id).toBe('100')
    expect(body.title).toBe('Upstream Title')
    expect(body.duration).toBe(600)
    expect(body.hls).toBe('https://cdn.test/hls.m3u8')
    expect(body.files).toHaveLength(1)
    expect(body.files[0]).toMatchObject({ quality: '720p', link: 'https://cdn.test/720.mp4' })
    // The frontend never used `dash`; manifest must drop it so the
    // wire shape is the union the frontend expects in Commit H.
    expect((body as unknown as { dash?: string }).dash).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns 502 when the video proxy fails', async () => {
    const sqlite = seedFixtures({ count: 1 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      VIDEO_PROXY_BASE,
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })))
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(502)
    expect((await readJson<{ error: string }>(res)).error).toBe('upstream_unavailable')
  })

  it('returns 400 when the data_ref scheme does not match the format', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(`UPDATE datasets SET format = 'image/png' WHERE slug = 'dataset-0'`)
      .run()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      VIDEO_PROXY_BASE,
    }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('data_ref_format_mismatch')
  })

  it('returns a synthesized single-file manifest for url:<href> + video format', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(`UPDATE datasets SET data_ref = 'url:https://example.com/clip.mp4' WHERE slug = 'dataset-0'`)
      .run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<VideoBody>(res)
    expect(body.kind).toBe('video')
    expect(body.hls).toBe('')
    expect(body.files).toEqual([
      {
        quality: 'source',
        size: 0,
        type: 'video/mp4',
        link: 'https://example.com/clip.mp4',
      },
    ])
  })

  it('returns the variant ladder for url:<href> + image format', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(
        `UPDATE datasets SET data_ref = 'url:https://example.com/foo.png',
                              format = 'image/png'
         WHERE slug = 'dataset-0'`,
      )
      .run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<ImageBody>(res)
    expect(body.kind).toBe('image')
    expect(body.fallback).toBe('https://example.com/foo.png')
    expect(body.variants.map(v => v.width)).toEqual([4096, 2048, 1024])
  })

  it('resolves a stream: data_ref to a video manifest with the HLS playback URL', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(
        `UPDATE datasets SET data_ref = 'stream:abc123', format = 'video/mp4'
         WHERE slug = 'dataset-0'`,
      )
      .run()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      STREAM_CUSTOMER_SUBDOMAIN: 'customer-real.cloudflarestream.com',
    }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<{ kind: string; hls: string; files: unknown[] }>(res)
    expect(body.kind).toBe('video')
    expect(body.hls).toBe('https://customer-real.cloudflarestream.com/abc123/manifest/video.m3u8')
    expect(body.files).toEqual([])
  })

  it('returns 503 stream_unconfigured when stream: data_ref but no subdomain configured', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(
        `UPDATE datasets SET data_ref = 'stream:abc123', format = 'video/mp4'
         WHERE slug = 'dataset-0'`,
      )
      .run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('stream_unconfigured')
  })

  it('returns 400 data_ref_format_mismatch when stream: paired with a non-video format', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(
        `UPDATE datasets SET data_ref = 'stream:abc123', format = 'image/png'
         WHERE slug = 'dataset-0'`,
      )
      .run()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      STREAM_CUSTOMER_SUBDOMAIN: 'customer-real.cloudflarestream.com',
    }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('data_ref_format_mismatch')
  })

  it('resolves an r2: data_ref + image format to Cloudflare Images variants when configured', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(
        `UPDATE datasets SET data_ref = ?, format = 'image/png'
         WHERE slug = 'dataset-0'`,
      )
      .run(`r2:datasets/DS000AAAAAAAAAAAAAAAAAAAAA/by-digest/sha256/abc/asset.png`)
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CF_IMAGES_RESIZE_BASE: 'https://images.example.com',
      CATALOG_R2_BUCKET: 'terraviz-assets',
      R2_PUBLIC_BASE: 'https://assets.example.com',
    }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<{
      kind: string
      variants: Array<{ width: number; url: string }>
      fallback: string
    }>(res)
    expect(body.kind).toBe('image')
    expect(body.variants.map(v => v.width)).toEqual([4096, 2048, 1024])
    expect(body.variants[0].url).toContain(
      'images.example.com/cdn-cgi/image/fit=scale-down,width=4096',
    )
    expect(body.fallback).toBe(
      'https://assets.example.com/datasets/DS000AAAAAAAAAAAAAAAAAAAAA/by-digest/sha256/abc/asset.png',
    )
  })

  it('resolves an r2: image without Cloudflare Images to a single-fallback manifest', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(
        `UPDATE datasets SET data_ref = 'r2:datasets/x/asset.png', format = 'image/png'
         WHERE slug = 'dataset-0'`,
      )
      .run()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      MOCK_R2: 'true',
    }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<{ kind: string; variants: unknown[]; fallback: string }>(res)
    expect(body.kind).toBe('image')
    expect(body.variants).toEqual([])
    expect(body.fallback).toContain('mock-r2.localhost/terraviz-assets/datasets/x/asset.png')
  })

  it('returns 503 r2_unconfigured when no R2 read-URL source is set', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(
        `UPDATE datasets SET data_ref = 'r2:datasets/x/asset.png', format = 'image/png'
         WHERE slug = 'dataset-0'`,
      )
      .run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('r2_unconfigured')
  })

  it('returns 415 unsupported_format for r2: tour/json datasets (Phase 3)', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(
        `UPDATE datasets SET data_ref = 'r2:tours/x/tour.json', format = 'tour/json'
         WHERE slug = 'dataset-0'`,
      )
      .run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV(), MOCK_R2: 'true' }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    // Tour engines fetch tour_json_ref directly, not via /manifest;
    // adding a `kind: 'file'` shape is a wider frontend change so
    // we surface 415 explicitly rather than emit a video-shaped
    // manifest that would mislead clients.
    expect(res.status).toBe(415)
    expect((await readJson<{ error: string }>(res)).error).toBe('unsupported_format')
  })

  it('returns 501 for peer: data_ref schemes (Phase 4)', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(`UPDATE datasets SET data_ref = 'peer:NODE001/DS999' WHERE slug = 'dataset-0'`)
      .run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(501)
    expect((await readJson<{ error: string }>(res)).error).toBe('unsupported_data_ref')
  })

  it('returns 304 when If-None-Match matches the manifest etag', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite
      .prepare(
        `UPDATE datasets SET data_ref = 'url:https://example.com/foo.png',
                              format = 'image/png'
         WHERE slug = 'dataset-0'`,
      )
      .run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const id = 'DS000AAAAAAAAAAAAAAAAAAAAA'

    const first = await onRequestGet(makeCtx<'id'>({ env, params: { id } }))
    const etag = first.headers.get('etag')!
    expect(etag).toBeTruthy()

    const second = await onRequestGet(
      makeCtx<'id'>({ env, params: { id }, headers: { 'if-none-match': etag } }),
    )
    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
  })
})

describe('resolveManifest (unit)', () => {
  it('passes a custom fetch implementation through to the vimeo path', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: '7', hls: 'https://x/stream.m3u8' }),
        { status: 200 },
      ),
    )
    const result = await resolveManifest(
      { id: 'DSXXX', format: 'video/mp4', data_ref: 'vimeo:7' },
      { VIDEO_PROXY_BASE: 'https://test/video' },
      fetchImpl as unknown as typeof fetch,
    )
    expect('manifest' in result).toBe(true)
    if ('manifest' in result) {
      expect(result.manifest.kind).toBe('video')
    }
    expect(fetchImpl).toHaveBeenCalledWith('https://test/video/7')
  })
})
