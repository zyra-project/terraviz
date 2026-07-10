/**
 * Tests for the agency-YouTube search proxy (task: media suggestion
 * engine) — privilege gate, key-absence/off behaviour, allowlist
 * filtering, KV cache semantics, and failure degradation. The upstream
 * fetch is stubbed; the suite never touches the network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeChannelCandidates, onRequestGet as searchGet, parseYoutubeSearch } from './youtube-search'
import { channelName, isAllowlistedChannel } from '../../_lib/youtube-channels'
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

describe('agency allowlist', () => {
  // Verified channel ids (each confirmed against the channel's own
  // youtube.com/feeds/videos.xml title) → guard against an accidental
  // edit silently dropping one from the reputability gate.
  const VERIFIED: Array<[string, string]> = [
    ['UCLA_DiR1FfKNvjuUpBHmylQ', 'NASA'],
    ['UCAY-SMFNfynqz1bdoaV8BeQ', 'NASA Goddard'],
    ['UCryGec9PdUCLjpJW2mgCuLw', 'NASA Jet Propulsion Laboratory'],
    ['UCe9IxQeBttZIYl5c43ycf9g', 'NOAA'],
    ['UC9hQvMjzSxurMirYDgOMezw', 'National Weather Service (NWS)'],
    ['UCv0qlvvLtEuCxAoEitAuoFg', 'NOAA/NWS National Hurricane Center'],
    ['UCJJqaSw7Z7SD7TM80cViEGg', 'NOAA Satellites'],
    ['UCIBaDdAbGlFDeS33shmlD0A', 'European Space Agency, ESA'],
    ['UCdK5sfMQcJ64q8AGR_7-ZRw', 'Copernicus ECMWF'],
    ['UChpGvNdQPdI7EI75z6oelTw', 'ECMWF'],
    ['UCQxQlcjXuh32ctfX3QHiyRg', 'National Snow and Ice Data Center'],
    ['UCjheKtYFOKfSgEZAHfN1iVg', 'NSF NCAR & UCAR'],
  ]

  it.each(VERIFIED)('allowlists %s → %s', (id, name) => {
    expect(isAllowlistedChannel(id)).toBe(true)
    expect(channelName(id)).toBe(name)
  })

  it('rejects a non-allowlisted channel', () => {
    expect(isAllowlistedChannel('UCspoofedChannelNotAllowed')).toBe(false)
    expect(channelName('UCspoofedChannelNotAllowed')).toBeNull()
  })
})

describe('mergeChannelCandidates', () => {
  const cand = (videoId: string, channelId = NASA): ReturnType<typeof parseYoutubeSearch>[number] => ({
    videoId,
    title: '',
    channelId,
    channelName: '',
  })

  it('interleaves channels round-robin and caps at the shortlist', () => {
    const merged = mergeChannelCandidates([
      [cand('a1'), cand('a2'), cand('a3')],
      [cand('b1'), cand('b2')],
      [cand('c1')],
    ])
    // One from each channel before any channel's second — capped at 4.
    expect(merged.map(v => v.videoId)).toEqual(['a1', 'b1', 'c1', 'a2'])
  })

  it('de-dupes a video cross-posted to two channels', () => {
    const merged = mergeChannelCandidates([[cand('dup')], [cand('dup')], [cand('x')]])
    expect(merged.map(v => v.videoId)).toEqual(['dup', 'x'])
  })

  it('is empty for no channels or all-empty channels', () => {
    expect(mergeChannelCandidates([])).toEqual([])
    expect(mergeChannelCandidates([[], []])).toEqual([])
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

  it('searches per channel, filters to the allowlist, and caches the result', async () => {
    const fetchFn = stubUpstream([item('abc123XYZ', NASA), item('bad', 'UCnope')])
    const env = { YOUTUBE_API_KEY: 'k', CATALOG_KV: makeKV() }
    const first = await searchGet(ctx({ q: 'hurricane delta', env }))
    expect(first.headers.get('X-Cache')).toBe('MISS')
    const { videos } = await readJson<{ videos: Array<{ videoId: string }> }>(first)
    // Every channel's stub returns the same NASA hit — de-duped to one.
    expect(videos.map(v => v.videoId)).toEqual(['abc123XYZ'])
    // Each upstream request is channelId-scoped and carries the key + query.
    const upstreamUrl = String(fetchFn.mock.calls[0][0])
    expect(upstreamUrl).toContain('key=k')
    expect(upstreamUrl).toContain('q=hurricane+delta')
    expect(upstreamUrl).toContain('channelId=')
    // One request per built-in agency channel (fan-out, not one global search).
    const callsAfterFirst = fetchFn.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(1)

    const second = await searchGet(ctx({ q: 'hurricane delta', env }))
    expect(second.headers.get('X-Cache')).toBe('HIT')
    // The cache hit issues no further upstream requests.
    expect(fetchFn.mock.calls.length).toBe(callsAfterFirst)
  })

  it('fans out one channelId-scoped search per channel and merges across them', async () => {
    const NOAA_EDU = 'UC012BUr9u82skTv9bOfmG4w'
    // A per-channel stub: a distinct hit for two of the agency channels,
    // nothing for the rest — so a merged two-video result can only come
    // from separate per-channel requests, not a single global search.
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const channelId = new URL(String(input)).searchParams.get('channelId')
      const vid = channelId === NASA ? 'nasaVIDabc' : channelId === NOAA_EDU ? 'noaaVIDxyz' : null
      return { ok: true, json: async () => ({ items: vid ? [item(vid, channelId!)] : [] }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchFn)
    const res = await searchGet(ctx({ q: 'coastal storm', env: { YOUTUBE_API_KEY: 'k' } }))
    const { videos } = await readJson<{ videos: Array<{ videoId: string }> }>(res)
    expect(videos.map(v => v.videoId).sort()).toEqual(['nasaVIDabc', 'noaaVIDxyz'])
    // Every request was scoped to a single channel, and both hit channels
    // were among those queried.
    const queried = fetchFn.mock.calls.map(c => new URL(String(c[0])).searchParams.get('channelId'))
    expect(queried.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(queried).toContain(NASA)
    expect(queried).toContain(NOAA_EDU)
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

  it('excludes a built-in channel the node has switched off', async () => {
    const sqlite = seedFixtures({ count: 0 })
    sqlite
      .prepare(`INSERT INTO youtube_channels_disabled (channel_id, disabled_by, created_at) VALUES (?, NULL, ?)`)
      .run(NASA, '2026-07-01T00:00:00.000Z')
    // NASA would match, but it's disabled → never queried, never surfaced.
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const channelId = new URL(String(input)).searchParams.get('channelId')
      const vid = channelId === NASA ? 'nasaVIDabc' : null
      return { ok: true, json: async () => ({ items: vid ? [item(vid, channelId!)] : [] }) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchFn)
    const res = await searchGet(ctx({ q: 'hurricane', env: { YOUTUBE_API_KEY: 'k', CATALOG_DB: asD1(sqlite) } }))
    expect(await readJson<{ videos: unknown[] }>(res)).toEqual({ videos: [] })
    const queried = fetchFn.mock.calls.map(c => new URL(String(c[0])).searchParams.get('channelId'))
    expect(queried).not.toContain(NASA)
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

  it('degrades to [] when every channel search fails and does not cache it', async () => {
    const boom = vi.fn(async () => {
      throw new Error('quota exceeded')
    })
    vi.stubGlobal('fetch', boom)
    const env = { YOUTUBE_API_KEY: 'k', CATALOG_KV: makeKV() }
    const res = await searchGet(ctx({ q: 'hurricane', env }))
    expect(await readJson<{ videos: unknown[] }>(res)).toEqual({ videos: [] })
    const callsAfterFirst = boom.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)
    const again = await searchGet(ctx({ q: 'hurricane', env }))
    expect(again.headers.get('X-Cache')).toBe('MISS') // not pinned
    // The un-cached empty result forces a fresh fan-out on the retry.
    expect(boom.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })
})
