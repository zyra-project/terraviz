/**
 * Tests for the catalog read endpoint.
 *
 * Coverage:
 *   - Healthy path: 200 with the expected wire shape, decoration
 *     fields populated, etag derived from body.
 *   - Empty catalog (no datasets seeded): 200 with empty array,
 *     stable etag.
 *   - Missing CATALOG_DB binding: 503 with a typed error envelope.
 *   - Missing node_identity row: graceful empty-catalog response,
 *     not a crash.
 *   - KV cache: second call hits KV not D1; bumping a row
 *     invalidates the snapshot only on explicit invalidation.
 *   - ETag-driven 304 with `If-None-Match`.
 *   - `?since=` cursor filter: only rows updated after the cursor
 *     come back; cursor stamp updates accordingly.
 */

import { describe, it, expect } from 'vitest'
import { onRequestGet, renderCatalog } from './catalog'
import {
  asD1,
  makeCtx,
  makeKV,
  seedFixtures,
} from './_lib/test-helpers'
import { invalidateSnapshot } from './_lib/snapshot'

interface CatalogBody {
  schema_version: number
  generated_at: string
  etag: string
  cursor: string | null
  datasets: Array<{
    id: string
    title: string
    dataLink: string
    originNode: string
    visibility: string
    schemaVersion: number
    enriched?: { categories?: Record<string, string[]>; keywords?: string[] }
    tags?: string[]
  }>
  tombstones: string[]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/catalog', () => {
  it('returns 503 when CATALOG_DB is not bound', async () => {
    const ctx = makeCtx({ env: {} })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('binding_missing')
  })

  it('returns the seeded catalog with wire-shape datasets', async () => {
    const sqlite = seedFixtures({ count: 3 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx({ env })

    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.headers.get('etag')).toMatch(/^".+"$/)
    expect(res.headers.get('cache-control')).toContain('max-age=60')

    const body = await readJson<CatalogBody>(res)
    expect(body.schema_version).toBe(1)
    expect(body.datasets).toHaveLength(3)
    expect(body.tombstones).toEqual([])
    // Deterministic order: weight DESC, then id ASC. With weights
    // 0/1/2 the highest weight comes first.
    expect(body.datasets[0].title).toBe('Test Dataset 2')
    // Phase-1a additive fields all present.
    const ds = body.datasets[0]
    expect(ds.dataLink).toBe(`/api/v1/datasets/${ds.id}/manifest`)
    expect(ds.originNode).toBe('NODE000')
    expect(ds.visibility).toBe('public')
    expect(ds.schemaVersion).toBe(1)
    expect(ds.enriched?.categories).toEqual({ Theme: ['Climate'] })
    expect(ds.enriched?.keywords).toEqual(['temperature'])
    expect(ds.tags).toEqual(['demo'])
    // Cursor stamps the latest updated_at across the result set.
    expect(body.cursor).toBe('2026-01-03T00:00:00.000Z')
    // generated_at mirrors cursor so the body bytes are a pure
    // function of dataset state — same content, same response
    // bytes, so the ETag really does identify the bytes you get
    // back.
    expect(body.generated_at).toBe(body.cursor)
  })

  it('produces byte-identical bodies across rebuilds when state is unchanged', async () => {
    // Regression: an earlier draft baked a fresh `Date.now()` into
    // `generated_at` on every render, even though the etag seed
    // excluded it. Two rebuilds with no row changes therefore
    // produced different body bytes with the same ETag — a
    // contract violation. Pin both texts to verify they match.
    const sqlite = seedFixtures({ count: 2 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }

    const first = await renderCatalog(env)
    // Bypass the snapshot cache by re-rendering directly.
    const second = await renderCatalog(env)
    expect(second.body).toBe(first.body)
    expect(second.etag).toBe(first.etag)
  })

  it('returns an empty catalog when no node_identity exists', async () => {
    const sqlite = seedFixtures({ count: 0 })
    sqlite.prepare('DELETE FROM node_identity').run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx({ env })

    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<CatalogBody>(res)
    expect(body.datasets).toEqual([])
  })

  it('caches the rendered response in KV after the first call', async () => {
    const sqlite = seedFixtures({ count: 2 })
    const kv = makeKV()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv }

    expect(kv._store.size).toBe(0)
    const first = await onRequestGet(makeCtx({ env }))
    expect(first.status).toBe(200)
    expect(kv._store.size).toBe(1)

    // Second call hits the cache; the body should be byte-identical.
    const second = await onRequestGet(makeCtx({ env }))
    const a = await first.text()
    const b = await second.text()
    expect(b).toBe(a)
  })

  it('returns 304 when If-None-Match matches the snapshot etag', async () => {
    const sqlite = seedFixtures({ count: 2 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }

    const first = await onRequestGet(makeCtx({ env }))
    const etag = first.headers.get('etag')!
    expect(etag).toBeTruthy()

    const second = await onRequestGet(
      makeCtx({ env, headers: { 'if-none-match': etag } }),
    )
    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
  })

  it('serves a body whose .etag field matches the response ETag header', async () => {
    // Regression: an earlier draft computed the snapshot etag over
    // the body bytes after `.etag` had been baked in, so the header
    // and body values diverged. Both must derive from the same
    // canonical seed so 304s work end-to-end.
    const sqlite = seedFixtures({ count: 2 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const res = await onRequestGet(makeCtx({ env }))
    const headerEtag = res.headers.get('etag')!
    const body = await readJson<CatalogBody>(res)
    expect(body.etag).toBe(headerEtag)

    // And after the snapshot is cached, a refetch keeps both equal.
    const res2 = await onRequestGet(makeCtx({ env }))
    const headerEtag2 = res2.headers.get('etag')!
    const body2 = await readJson<CatalogBody>(res2)
    expect(body2.etag).toBe(headerEtag2)
    expect(headerEtag2).toBe(headerEtag)
  })

  it('serves fresh data after invalidateSnapshot', async () => {
    const sqlite = seedFixtures({ count: 2 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }

    const first = await onRequestGet(makeCtx({ env }))
    const firstBody = await readJson<CatalogBody>(first)
    expect(firstBody.datasets).toHaveLength(2)

    // Add a third row, then invalidate.
    sqlite
      .prepare(
        `INSERT INTO datasets
          (id, slug, origin_node, title, format, data_ref, weight, visibility,
           schema_version, created_at, updated_at, published_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'DS999AAAAAAAAAAAAAAAAAAAAA',
        'extra',
        'NODE000',
        'Extra Dataset',
        'video/mp4',
        'vimeo:999',
        99,
        'public',
        1,
        '2026-02-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
      )
    await invalidateSnapshot(env)

    const second = await onRequestGet(makeCtx({ env }))
    const secondBody = await readJson<CatalogBody>(second)
    expect(secondBody.datasets).toHaveLength(3)
    expect(secondBody.datasets[0].title).toBe('Extra Dataset')
  })

  it('?since= filters to rows updated after the cursor', async () => {
    const sqlite = seedFixtures({ count: 3 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }

    const ctx = makeCtx({
      env,
      url: 'https://test.local/api/v1/catalog?since=2026-01-01T00:00:00.000Z',
    })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<CatalogBody>(res)
    // Only rows 1 and 2 were updated *after* 2026-01-01.
    expect(body.datasets.map(d => d.title).sort()).toEqual([
      'Test Dataset 1',
      'Test Dataset 2',
    ])
    expect(body.cursor).toBe('2026-01-03T00:00:00.000Z')
    expect(res.headers.get('cache-control')).toBe('public, max-age=30')
  })

  it('renderCatalog excludes hidden, retracted, and non-public rows', async () => {
    const sqlite = seedFixtures({ count: 3 })
    sqlite.prepare(`UPDATE datasets SET is_hidden = 1 WHERE slug = 'dataset-0'`).run()
    sqlite
      .prepare(
        `UPDATE datasets SET retracted_at = '2026-02-01T00:00:00.000Z' WHERE slug = 'dataset-1'`,
      )
      .run()
    sqlite.prepare(`UPDATE datasets SET visibility = 'private' WHERE slug = 'dataset-2'`).run()

    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const { body } = await renderCatalog(env)
    const parsed = JSON.parse(body) as CatalogBody
    expect(parsed.datasets).toEqual([])
  })
})
