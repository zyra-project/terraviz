/**
 * Tests for the agency-YouTube search proxy (task: media suggestion
 * engine) — privilege gate, key-absence/off behaviour, allowlist
 * filtering, KV cache semantics, and failure degradation. The upstream
 * fetch is stubbed; the suite never touches the network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet as searchGet, parseYoutubeSearch } from './youtube-search'
import { asD1, makeKV, seedFixtures } from '../../_lib/test-helpers'
import type { PublisherRow } from '../../_lib/publisher-store'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUB', email: 'p@e', role: 'publisher', is_admin: 0 }

const NASA = 'UCLA_DiR1FfKNvjuUpBHmylQ'

function ctx(opts: { env?: Record<string, unknown>; q?: string; publisher?: PublisherRow } = {}) {
  const url = `https://localhost/api/v1/publish/media/youtube-search${opts.q !== undefined ? `?q=${encodeURIComponent(opts.q)}` : ''}`
  return {
    request: new Request(url),
    env: opts.env ?? {},
    params: {},
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof searchGet>[0]
}

function stubUpstream(items: unknown[], ok = true) {
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok, json: async () => ({ items }) }) as unknown as Response)
  vi.stubGlobal('fetch', fetchFn)
  return fetchFn
}

afterEach(() => vi.unstubAllGlobals())

const readJson = async <T>(res: Response): Promise<T> => JSON.parse(await res.text()) as T

function item(videoId: string, channelId: string, title = 'A briefing') {
  return { id: { videoId }, snippet: { title, channelId } }
}

describe('parseYoutubeSearch', () => {
  it('keeps only allowlisted-channel video results, capped', () => {
    const videos = parseYoutubeSearch({
      items: [
        item('abc123XYZ', NASA), // kept
        item('def456XYZ', 'UCspoofedChannelNotAllowed'), // dropped
        { id: {}, snippet: { channelId: NASA } }, // no videoId → dropped
        item('ghi789XYZ', NASA), // kept
      ],
    })
    expect(videos.map(v => v.videoId)).toEqual(['abc123XYZ', 'ghi789XYZ'])
    expect(videos[0].channelName).toBe('NASA')
  })

  it('returns [] for a malformed body', () => {
    expect(parseYoutubeSearch(null)).toEqual([])
    expect(parseYoutubeSearch({ items: 'nope' })).toEqual([])
  })
})

describe('GET /api/v1/publish/media/youtube-search', () => {
  it('is 403 for a publisher-role account (no upstream request)', async () => {
    const fetchFn = stubUpstream([])
    const res = await searchGet(ctx({ q: 'hurricane', publisher: PUBLISHER, env: { YOUTUBE_API_KEY: 'k' } }))
    expect(res.status).toBe(403)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns an empty list (source off) with no key configured', async () => {
    const fetchFn = stubUpstream([item('abc123XYZ', NASA)])
    const res = await searchGet(ctx({ q: 'hurricane', env: {} })) // no YOUTUBE_API_KEY
    expect(res.status).toBe(200)
    expect(await readJson<{ videos: unknown[] }>(res)).toEqual({ videos: [] })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns an empty list for a blank query', async () => {
    const fetchFn = stubUpstream([item('abc123XYZ', NASA)])
    const res = await searchGet(ctx({ q: '   ', env: { YOUTUBE_API_KEY: 'k' } }))
    expect(await readJson<{ videos: unknown[] }>(res)).toEqual({ videos: [] })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('searches, filters to the allowlist, and caches the result', async () => {
    const fetchFn = stubUpstream([item('abc123XYZ', NASA), item('bad', 'UCnope')])
    const env = { YOUTUBE_API_KEY: 'k', CATALOG_KV: makeKV() }
    const first = await searchGet(ctx({ q: 'hurricane delta', env }))
    expect(first.headers.get('X-Cache')).toBe('MISS')
    const { videos } = await readJson<{ videos: Array<{ videoId: string }> }>(first)
    expect(videos.map(v => v.videoId)).toEqual(['abc123XYZ'])
    // The upstream request carried the key + query.
    const upstreamUrl = String(fetchFn.mock.calls[0][0])
    expect(upstreamUrl).toContain('key=k')
    expect(upstreamUrl).toContain('q=hurricane+delta')

    const second = await searchGet(ctx({ q: 'hurricane delta', env }))
    expect(second.headers.get('X-Cache')).toBe('HIT')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it("includes a node's custom channels in the effective allowlist", async () => {
    const CUSTOM = 'UCcustom0000000000000000'
    const sqlite = seedFixtures({ count: 0 })
    sqlite
      .prepare(`INSERT INTO youtube_channels (channel_id, channel_name, added_by, created_at) VALUES (?, ?, NULL, ?)`)
      .run(CUSTOM, 'City Museum', '2026-07-01T00:00:00.000Z')
    stubUpstream([item('cust123XYZ', CUSTOM), item('def456XYZ', 'UCnotAllowed')])
    const env = { YOUTUBE_API_KEY: 'k', CATALOG_DB: asD1(sqlite) }
    const res = await searchGet(ctx({ q: 'local flood', env }))
    const { videos } = await readJson<{ videos: Array<{ videoId: string; channelName: string }> }>(res)
    expect(videos).toEqual([{ videoId: 'cust123XYZ', title: 'A briefing', channelId: CUSTOM, channelName: 'City Museum' }])
  })

  it('degrades to defaults-only (not a 500) when the custom-channels table is missing', async () => {
    // An un-migrated preview D1: any query on `youtube_channels` throws.
    const failingDb = {
      prepare: () => ({
        all: async () => {
          throw new Error('no such table: youtube_channels')
        },
      }),
    } as unknown as D1Database
    stubUpstream([item('abc123XYZ', NASA), item('bad', 'UCnope')])
    const res = await searchGet(ctx({ q: 'hurricane', env: { YOUTUBE_API_KEY: 'k', CATALOG_DB: failingDb } }))
    expect(res.status).toBe(200)
    const { videos } = await readJson<{ videos: Array<{ videoId: string }> }>(res)
    // Built-in agency channels still filter through; no throw.
    expect(videos.map(v => v.videoId)).toEqual(['abc123XYZ'])
  })

  it('degrades to [] on upstream failure and does not cache it', async () => {
    const boom = vi.fn(async () => {
      throw new Error('quota exceeded')
    })
    vi.stubGlobal('fetch', boom)
    const env = { YOUTUBE_API_KEY: 'k', CATALOG_KV: makeKV() }
    const res = await searchGet(ctx({ q: 'hurricane', env }))
    expect(await readJson<{ videos: unknown[] }>(res)).toEqual({ videos: [] })
    const again = await searchGet(ctx({ q: 'hurricane', env }))
    expect(again.headers.get('X-Cache')).toBe('MISS') // not pinned
    expect(boom).toHaveBeenCalledTimes(2)
  })
})
