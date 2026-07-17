/**
 * Unit tests for the video index store — BLOB pack/unpack round-trips,
 * cosine ranking, upsert idempotency + embedding preservation, prune,
 * and the enabled-source host allowlist. Runs against real migration SQL
 * (0040) via the `asD1` harness.
 */

import { describe, it, expect } from 'vitest'
import { asD1, seedFixtures } from './test-helpers'
import { VECTORIZE_EMBEDDING_DIMENSIONS } from './vectorize-store'
import { insertVideoSource } from './video-sources-store'
import {
  packEmbedding,
  unpackEmbedding,
  cosineSimilarity,
  upsertIndexedVideo,
  getIndexedVideoStamp,
  pruneIndexedVideos,
  allowlistedContentHosts,
  queryVideosBySimilarity,
  type IndexVideoInput,
} from './video-index-store'

const NOW = '2026-07-17T12:00:00.000Z'

function db() {
  return asD1(seedFixtures({ count: 0 }))
}

function unit(seedDim: number): number[] {
  const v = new Array(VECTORIZE_EMBEDDING_DIMENSIONS).fill(0)
  v[seedDim % VECTORIZE_EMBEDDING_DIMENSIONS] = 1
  return v
}

function video(overrides: Partial<IndexVideoInput> = {}): IndexVideoInput {
  return {
    externalId: 'https://oceantoday.noaa.gov/coral.html',
    pageUrl: 'https://oceantoday.noaa.gov/coral.html',
    title: 'Coral Bleaching Explained',
    description: 'Warming seas push corals past their limit.',
    tags: ['Coral', 'Climate'],
    category: 'Ocean Life',
    contentUrl: 'https://oceantoday.noaa.gov/coral/bleach_720p.mp4',
    contentHost: 'oceantoday.noaa.gov',
    thumbnailUrl: 'https://oceantoday.noaa.gov/coral/bleach.jpg',
    durationSec: 210,
    publishedAt: '2024-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('embedding BLOB helpers', () => {
  it('pack → unpack round-trips a 768-dim vector', () => {
    const v = unit(42).map((x, i) => x + i * 1e-4)
    const back = unpackEmbedding(packEmbedding(v))
    expect(back).not.toBeNull()
    expect(back!).toHaveLength(VECTORIZE_EMBEDDING_DIMENSIONS)
    // Float32 round-trip tolerance.
    for (let i = 0; i < v.length; i++) expect(back![i]).toBeCloseTo(v[i], 5)
  })

  it('unpack rejects null and wrong-sized blobs', () => {
    expect(unpackEmbedding(null)).toBeNull()
    expect(unpackEmbedding(new Uint8Array(10))).toBeNull()
  })

  it('cosine is 1 for identical, 0 for orthogonal unit vectors', () => {
    expect(cosineSimilarity(unit(1), unit(1))).toBeCloseTo(1, 6)
    expect(cosineSimilarity(unit(1), unit(2))).toBeCloseTo(0, 6)
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0)
  })
})

describe('video-index-store', () => {
  it('upsert with embedding is idempotent on (source_id, external_id)', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    await upsertIndexedVideo(d, src.id, video(), { vector: unit(5), version: 1, textHash: 'h1' }, NOW)
    await upsertIndexedVideo(d, src.id, video({ title: 'Updated Title' }), { vector: unit(5), version: 1, textHash: 'h1' }, NOW)
    const rows = await queryVideosBySimilarity(d, unit(5), { minScore: 0.9, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Updated Title')
  })

  it('content-only upsert preserves the existing embedding', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    await upsertIndexedVideo(d, src.id, video(), { vector: unit(7), version: 1, textHash: 'h1' }, NOW)
    // Re-index without an embedding (unchanged embed text).
    await upsertIndexedVideo(d, src.id, video({ durationSec: 999 }), null, NOW)
    const rows = await queryVideosBySimilarity(d, unit(7), { minScore: 0.9, limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0].durationSec).toBe(999)
    // Embedding survived → still matches unit(7).
    expect(rows[0].score).toBeCloseTo(1, 5)
  })

  it('getIndexedVideoStamp returns the stored hash/version for skip-reembed', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    await upsertIndexedVideo(d, src.id, video(), { vector: unit(3), version: 1, textHash: 'abc' }, NOW)
    const stamp = await getIndexedVideoStamp(d, src.id, video().externalId)
    expect(stamp).toMatchObject({ embedTextHash: 'abc', embeddingVersion: 1 })
    expect(await getIndexedVideoStamp(d, src.id, 'nope')).toBeNull()
  })

  it('ranks by cosine, filters by minScore, caps at limit', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    await upsertIndexedVideo(d, src.id, video({ externalId: 'a', pageUrl: 'https://ot/a' }), { vector: unit(1), version: 1, textHash: 'a' }, NOW)
    await upsertIndexedVideo(d, src.id, video({ externalId: 'b', pageUrl: 'https://ot/b' }), { vector: unit(2), version: 1, textHash: 'b' }, NOW)
    // Query near unit(1): only a matches above threshold.
    const near = await queryVideosBySimilarity(d, unit(1), { minScore: 0.5, limit: 5 })
    expect(near.map(r => r.pageUrl)).toEqual(['https://ot/a'])
    const cap = await queryVideosBySimilarity(d, unit(1), { minScore: -1, limit: 1 })
    expect(cap).toHaveLength(1)
  })

  it('excludes videos from disabled sources', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml', enabled: false }, NOW)
    await upsertIndexedVideo(d, src.id, video(), { vector: unit(1), version: 1, textHash: 'a' }, NOW)
    expect(await queryVideosBySimilarity(d, unit(1), { minScore: 0 })).toEqual([])
    expect([...(await allowlistedContentHosts(d))]).toEqual([])
  })

  it('allowlistedContentHosts is the distinct host set over enabled sources', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    await upsertIndexedVideo(d, src.id, video({ externalId: 'a', pageUrl: 'https://ot/a', contentHost: 'oceantoday.noaa.gov' }), { vector: unit(1), version: 1, textHash: 'a' }, NOW)
    await upsertIndexedVideo(d, src.id, video({ externalId: 'b', pageUrl: 'https://ot/b', contentHost: 'cdn.oceanservice.noaa.gov' }), { vector: unit(2), version: 1, textHash: 'b' }, NOW)
    expect([...(await allowlistedContentHosts(d))].sort()).toEqual(['cdn.oceanservice.noaa.gov', 'oceantoday.noaa.gov'])
  })

  it('prune removes entries no longer in the sitemap; empty keep clears the source', async () => {
    const d = db()
    const src = await insertVideoSource(d, { label: 'OT', url: 'https://ot.example/s.xml' }, NOW)
    await upsertIndexedVideo(d, src.id, video({ externalId: 'keep', pageUrl: 'https://ot/keep' }), { vector: unit(1), version: 1, textHash: 'k' }, NOW)
    await upsertIndexedVideo(d, src.id, video({ externalId: 'drop', pageUrl: 'https://ot/drop' }), { vector: unit(2), version: 1, textHash: 'd' }, NOW)
    expect(await pruneIndexedVideos(d, src.id, ['keep'])).toBe(1)
    expect((await queryVideosBySimilarity(d, unit(1), { minScore: -1, limit: 10 })).map(r => r.pageUrl)).toEqual(['https://ot/keep'])
    expect(await pruneIndexedVideos(d, src.id, [])).toBe(1)
    expect(await queryVideosBySimilarity(d, unit(1), { minScore: -1, limit: 10 })).toEqual([])
  })
})
