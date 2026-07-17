/**
 * Unit tests for the shared video-source refresh job — fetch → parse →
 * embed → upsert → prune, plus the skip-reembed-on-unchanged path,
 * content-only indexing when AI is absent, sitemap-index expansion, and
 * the unreachable-source error path. Uses MOCK_AI for deterministic
 * embeddings and a stubbed fetch (no network).
 */

import { describe, it, expect, vi } from 'vitest'
import { asD1, seedFixtures } from './test-helpers'
import { insertVideoSource } from './video-sources-store'
import { refreshVideoSource } from './video-source-refresh'
import { queryVideosBySimilarity } from './video-index-store'

const NOW = '2026-07-17T12:00:00.000Z'

function db() {
  return asD1(seedFixtures({ count: 0 }))
}

const SITEMAP = (entries: string) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">${entries}</urlset>`

const ENTRY = (slug: string, title: string, desc: string) => `
  <url>
    <loc>https://ot.example/${slug}.html</loc>
    <video:video>
      <video:title>${title}</video:title>
      <video:description>${desc}</video:description>
      <video:content_loc>https://ot.example/${slug}.mp4"</video:content_loc>
      <video:thumbnail_loc>https://ot.example/${slug}.jpg</video:thumbnail_loc>
      <video:duration>120</video:duration>
      <video:publication_date>2025-01-01</video:publication_date>
      <video:tag>${title}</video:tag>
    </video:video>
  </url>`

const INDEX_XML = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://ot.example/child-1.xml</loc></sitemap>
  <sitemap><loc>https://ot.example/child-2.xml</loc></sitemap>
</sitemapindex>`

/** A fetch stub mapping URL → xml body (200), 404 otherwise. */
function stubFetch(map: Record<string, string>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = map[url]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
}

const MOCK_AI = { MOCK_AI: 'true' } as const

describe('refreshVideoSource', () => {
  it('fetches, parses, embeds, and upserts entries', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    const xml = SITEMAP(ENTRY('coral', 'Coral Bleaching', 'Warming seas stress reefs.') + ENTRY('turtle', 'Sea Turtle Rescue', 'A rescued loggerhead returns to sea.'))
    const res = await refreshVideoSource(d, src, { env: MOCK_AI, fetchFn: stubFetch({ 'https://ot.example/s.xml': xml }) })
    expect(res).toMatchObject({ ok: true, fetched: 2, indexed: 2, embedded: 2, pruned: 0 })
    // Both are embedded → matchable. A coral-themed query should rank coral first.
    const all = await queryVideosBySimilarity(d, (await embed('coral reef bleaching warming')), { minScore: -1, limit: 5 })
    expect(all[0].title).toBe('Coral Bleaching')
    // Content URL trailing quote sanitized through the whole pipeline.
    expect(all.every(v => !v.contentUrl.includes('"'))).toBe(true)
  })

  it('skips re-embedding unchanged entries but re-embeds changed text', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    const fetch1 = stubFetch({ 'https://ot.example/s.xml': SITEMAP(ENTRY('coral', 'Coral', 'Reefs under stress.')) })
    const first = await refreshVideoSource(d, src, { env: MOCK_AI, fetchFn: fetch1 })
    expect(first.embedded).toBe(1)
    // Same content → no re-embed.
    const second = await refreshVideoSource(d, src, { env: MOCK_AI, fetchFn: fetch1 })
    expect(second).toMatchObject({ indexed: 1, embedded: 0, pruned: 0 })
    // Changed description → re-embed.
    const fetch2 = stubFetch({ 'https://ot.example/s.xml': SITEMAP(ENTRY('coral', 'Coral', 'A brand new description about reefs.')) })
    const third = await refreshVideoSource(d, src, { env: MOCK_AI, fetchFn: fetch2 })
    expect(third.embedded).toBe(1)
  })

  it('indexes content-only when AI is unconfigured (no embed, not matchable yet)', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    const res = await refreshVideoSource(d, src, { fetchFn: stubFetch({ 'https://ot.example/s.xml': SITEMAP(ENTRY('coral', 'Coral', 'Reefs.')) }) })
    expect(res).toMatchObject({ ok: true, indexed: 1, embedded: 0 })
    // Unembedded → not returned by the similarity query.
    expect(await queryVideosBySimilarity(d, (await embed('coral')), { minScore: -1, limit: 5 })).toEqual([])
  })

  it('respects the shared embed budget', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    const xml = SITEMAP(ENTRY('a', 'A', 'aaa') + ENTRY('b', 'B', 'bbb') + ENTRY('c', 'C', 'ccc'))
    const budget = { remaining: 2 }
    const res = await refreshVideoSource(d, src, { env: MOCK_AI, embedBudget: budget, fetchFn: stubFetch({ 'https://ot.example/s.xml': xml }) })
    expect(res.indexed).toBe(3)
    expect(res.embedded).toBe(2)
    expect(budget.remaining).toBe(0)
  })

  it('prunes entries that fell out of the sitemap', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    await refreshVideoSource(d, src, { env: MOCK_AI, fetchFn: stubFetch({ 'https://ot.example/s.xml': SITEMAP(ENTRY('a', 'A', 'aaa') + ENTRY('b', 'B', 'bbb')) }) })
    const res = await refreshVideoSource(d, src, { env: MOCK_AI, fetchFn: stubFetch({ 'https://ot.example/s.xml': SITEMAP(ENTRY('a', 'A', 'aaa')) }) })
    expect(res).toMatchObject({ fetched: 1, pruned: 1 })
  })

  it('expands a sitemap-index one level', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/index.xml' }, NOW)
    const res = await refreshVideoSource(d, src, {
      env: MOCK_AI,
      fetchFn: stubFetch({
        'https://ot.example/index.xml': INDEX_XML,
        'https://ot.example/child-1.xml': SITEMAP(ENTRY('a', 'A', 'aaa')),
        'https://ot.example/child-2.xml': SITEMAP(ENTRY('b', 'B', 'bbb')),
      }),
    })
    expect(res).toMatchObject({ ok: true, fetched: 2, indexed: 2 })
  })

  it('reports an unreachable source without throwing', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/missing.xml' }, NOW)
    const res = await refreshVideoSource(d, src, { env: MOCK_AI, fetchFn: stubFetch({}) })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not reach/i)
  })

  it('rejects a non-http source URL as a config error', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'Bad', url: 'https://ot.example/s.xml' }, NOW)
    // Force a bad URL on the row (bypasses the create-route guard).
    const bad = { ...src, url: 'ftp://ot.example/s.xml' }
    const res = await refreshVideoSource(d, bad, { env: MOCK_AI, fetchFn: stubFetch({}) })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/must be http/i)
  })
})

/** Embed a query the same way the job does (MOCK_AI, deterministic). */
async function embed(text: string): Promise<number[]> {
  const { embedDatasetText } = await import('./embeddings')
  return embedDatasetText({ MOCK_AI: 'true' }, text)
}
