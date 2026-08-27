// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for GET /api/v1/publish/feeds/preview — the
 * dry-run feed preview.
 *
 * Coverage: privileged gate (403), kind/url validation (400), 502 when
 * the feed is unreachable, a 200 RSS preview whose items carry
 * title/publishedAt/url and are capped at PREVIEW_MAX_ITEMS, and a 200
 * EONET preview. Nothing writes to the DB — the route needs no
 * CATALOG_DB binding.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet as previewGet, PREVIEW_MAX_ITEMS } from './preview'
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
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUBLISHER', email: 'c@e', role: 'publisher', is_admin: 0 }

function ctx(query: string, publisher: PublisherRow = ADMIN) {
  return {
    request: new Request(`https://localhost/api/v1/publish/feeds/preview${query}`),
    env: {},
    params: {} as Record<string, string | string[]>,
    data: { publisher },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/feeds/preview',
  } as unknown as Parameters<typeof previewGet>[0]
}

function rssItem(n: number): string {
  return `<item>
    <title>Story ${n}</title>
    <link>https://example.org/story-${n}</link>
    <guid>story-${n}</guid>
    <pubDate>Wed, 0${n} Jul 2026 10:00:00 GMT</pubDate>
    <description>Summary ${n}.</description>
  </item>`
}

function rssXml(count: number): string {
  const items = Array.from({ length: count }, (_, i) => rssItem(i + 1)).join('\n')
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>${items}</channel></rss>`
}

const EONET_FEED = {
  events: [
    {
      id: 'EONET_1001',
      title: 'Wildfire — Example Ridge',
      categories: [{ id: 'wildfires', title: 'Wildfires' }],
      sources: [{ id: 'IRWIN', url: 'https://eonet.gsfc.nasa.gov/events/EONET_1001' }],
      geometry: [{ date: '2026-06-25T00:00:00Z', type: 'Point', coordinates: [-120.5, 38.2] }],
    },
  ],
}

function stubFetch(body: string | unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok,
          status: ok ? 200 : 502,
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
          json: async () => body,
        }) as unknown as Response,
    ),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/v1/publish/feeds/preview', () => {
  it('403 for a publisher-role account', async () => {
    stubFetch(rssXml(1))
    const res = await previewGet(ctx('?kind=rss&url=https%3A%2F%2Fexample.org%2Ffeed', PUBLISHER))
    expect(res.status).toBe(403)
  })

  it('400 for an unknown kind', async () => {
    const res = await previewGet(ctx('?kind=scrape&url=https%3A%2F%2Fexample.org%2Ffeed'))
    expect(res.status).toBe(400)
    expect(JSON.parse(await res.text()).error).toBe('invalid_kind')
  })

  it('400 for a non-http(s) url', async () => {
    for (const q of ['?kind=rss', '?kind=rss&url=javascript%3Aalert(1)', '?kind=rss&url=not-a-url']) {
      const res = await previewGet(ctx(q))
      expect(res.status).toBe(400)
      expect(JSON.parse(await res.text()).error).toBe('invalid_url')
    }
  })

  it('502 when the feed is unreachable', async () => {
    stubFetch('', false)
    const res = await previewGet(ctx('?kind=rss&url=https%3A%2F%2Fexample.org%2Ffeed'))
    expect(res.status).toBe(502)
    expect(JSON.parse(await res.text()).error).toBe('feed_unavailable')
  })

  it('200 RSS preview: items carry title/publishedAt/url, capped at the max', async () => {
    // One extra linkless item the mapper skips — `fetched` counts it
    // (raw document items), `mappable` doesn't.
    const skipped = '<item><title>No link — unmappable</title></item>'
    stubFetch(rssXml(PREVIEW_MAX_ITEMS + 3).replace('</channel>', `${skipped}</channel>`))
    const res = await previewGet(ctx('?kind=rss&url=https%3A%2F%2Fexample.org%2Ffeed'))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as {
      fetched: number
      mappable: number
      items: Array<{ title: string; publishedAt: string | null; url: string }>
    }
    expect(body.fetched).toBe(PREVIEW_MAX_ITEMS + 4)
    expect(body.mappable).toBe(PREVIEW_MAX_ITEMS + 3)
    expect(body.items).toHaveLength(PREVIEW_MAX_ITEMS)
    expect(body.items[0]).toMatchObject({ title: 'Story 1', url: 'https://example.org/story-1' })
    expect(body.items[0].publishedAt).toContain('2026-07-01')
  })

  it('200 EONET preview maps the structured feed', async () => {
    stubFetch(EONET_FEED)
    const res = await previewGet(ctx('?kind=eonet&url=https%3A%2F%2Feonet.gsfc.nasa.gov%2Fapi%2Fv3%2Fevents'))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { items: Array<{ title: string; url: string }> }
    expect(body.items).toHaveLength(1)
    expect(body.items[0].title).toContain('Wildfire')
    expect(body.items[0].url).toMatch(/^https:\/\//)
  })
})
