// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
 *   - A KV read that rejects: rendered from D1, byte-for-byte the
 *     cache-miss response, and 304s still work.
 *   - A dataset withheld while the snapshot was stale: a retraction
 *     whose KV delete failed in an outage is not served once KV
 *     recovers, by the isolate that saw the outage or a fresh one, and
 *     not even as a 304 to the pre-outage ETag; a render that read D1
 *     before a retraction, whether its put or its data read straddles
 *     the retraction, is not served after it; an entry from before the
 *     generation check is re-rendered, and never served unverified.
 *     When D1 cannot be read a cached snapshot this code wrote is
 *     served unverified, logged, under the TTL every put carries; a
 *     deploy ahead of migration 0062 keeps caching and re-renders once
 *     the migration applies; a failing KV put costs one render per
 *     isolate per generation, not one per request.
 *   - `?since=` cursor filter: only rows updated after the cursor
 *     come back; cursor stamp updates accordingly.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from 'vitest'
import { MIGRATIONS_DIR } from '../../../scripts/lib/catalog-migrations'
import { onRequestGet, renderCatalog } from './catalog'
import {
  asD1,
  expectSameResponse,
  makeCtx,
  makeFailingD1,
  makeFailingKV,
  makeKV,
  seedFixtures,
} from './_lib/test-helpers'
import { invalidateSnapshot, SNAPSHOT_KEY, SNAPSHOT_TTL_SECONDS } from './_lib/snapshot'
import { retractDataset } from './_lib/dataset-mutations'
import { PUBLIC_DATASET_PREDICATE } from './_lib/catalog-store'

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

  describe('when CATALOG_KV reads reject (binding to a deleted namespace)', () => {
    // The 2026-11-09 NOAA-GSL outage: every catalog read threw, and
    // every visitor got a 500. KV holds only a cache of D1, so a
    // failing read must answer exactly as a cache miss does.
    let warn: MockInstance<typeof console.warn>
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => warn.mockRestore())

    it('renders from D1 with the same response as a cache miss', async () => {
      // Two databases with the same rows, so the second request renders
      // rather than hitting the copy the first left in this isolate.
      const miss = await onRequestGet(
        makeCtx({ env: { CATALOG_DB: asD1(seedFixtures({ count: 2 })), CATALOG_KV: makeKV() } }),
      )
      const failed = await onRequestGet(
        makeCtx({ env: { CATALOG_DB: asD1(seedFixtures({ count: 2 })), CATALOG_KV: makeFailingKV() } }),
      )

      expect(failed.status).toBe(200)
      await expectSameResponse(failed, miss)
      expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/\[catalog\] KV snapshot read failed/)
    })

    it('answers 304 to an ETag a KV hit served, once KV starts failing', async () => {
      const db = asD1(seedFixtures({ count: 2 }))
      const kv = makeKV()
      await onRequestGet(makeCtx({ env: { CATALOG_DB: db, CATALOG_KV: kv } }))
      const hit = await onRequestGet(makeCtx({ env: { CATALOG_DB: db, CATALOG_KV: kv } }))
      expect(kv.get).toHaveBeenCalledTimes(2)
      const etag = hit.headers.get('etag')!

      const after = await onRequestGet(
        makeCtx({ env: { CATALOG_DB: db, CATALOG_KV: makeFailingKV() }, headers: { 'if-none-match': etag } }),
      )
      expect(after.status).toBe(304)
      expect(after.headers.get('etag')).toBe(etag)
    })

    it('rebuilds over a snapshot entry that is not valid JSON', async () => {
      const kv = makeKV()
      kv._store.set(SNAPSHOT_KEY, '{not json')
      const res = await onRequestGet(makeCtx({ env: { CATALOG_DB: asD1(seedFixtures({ count: 2 })), CATALOG_KV: kv } }))
      expect(res.status).toBe(200)
      const stored = JSON.parse(kv._store.get(SNAPSHOT_KEY)!) as { etag: string }
      expect(stored.etag).toBe(res.headers.get('etag'))
    })

    it('still answers 304 to a matching If-None-Match', async () => {
      const env = { CATALOG_DB: asD1(seedFixtures({ count: 2 })), CATALOG_KV: makeFailingKV() }
      const first = await onRequestGet(makeCtx({ env }))
      const etag = first.headers.get('etag')!
      const second = await onRequestGet(makeCtx({ env, headers: { 'if-none-match': etag } }))
      expect(second.status).toBe(304)
      expect(second.headers.get('etag')).toBe(etag)
    })
  })

  describe('a dataset withheld while the cached snapshot still lists it', () => {
    // The KV snapshot has no say in what is public: D1 does. These pin
    // that a body listing a retracted row is never served once D1 has
    // the retraction, however the KV delete that should have retired
    // the body went (`_lib/snapshot.ts`, "Invalidation").
    const TARGET = 'DS001' + 'A'.repeat(21)
    let warn: MockInstance<typeof console.warn>
    let error: MockInstance<typeof console.error>
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      error = vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(() => {
      warn.mockRestore()
      error.mockRestore()
    })

    const logged = (spy: MockInstance<typeof console.warn>) =>
      spy.mock.calls.map(c => c.join(' ')).join('\n')
    const idsOf = async (res: Response) => (await readJson<CatalogBody>(res)).datasets.map(d => d.id)

    it('is not served once KV recovers from an outage that failed the retraction\'s delete', async () => {
      const db = asD1(seedFixtures({ count: 3 }))
      const kv = makeKV()
      const healthy = { CATALOG_DB: db, CATALOG_KV: kv }

      // Before the outage: the snapshot is cached, and lists TARGET.
      const before = await onRequestGet(makeCtx({ env: healthy }))
      const staleEtag = before.headers.get('etag')!
      expect(await idsOf(before)).toContain(TARGET)

      // The outage: the namespace is intact but every KV call rejects.
      // The retraction lands in D1; its snapshot delete fails.
      const outage = { CATALOG_DB: db, CATALOG_KV: makeFailingKV() }
      expect((await retractDataset(outage, TARGET)).ok).toBe(true)
      expect(await idsOf(await onRequestGet(makeCtx({ env: outage })))).not.toContain(TARGET)
      // The premise: the pre-outage entry is still there, listing TARGET.
      expect(kv._store.get(SNAPSHOT_KEY)).toContain(TARGET)

      // KV recovers. A client revalidating the pre-outage body is not
      // told it is current, and gets a body without TARGET. This
      // isolate rendered during the outage, so it answers from that.
      const revalidated = await onRequestGet(
        makeCtx({ env: healthy, headers: { 'if-none-match': staleEtag } }),
      )
      expect(revalidated.status).toBe(200)
      expect(revalidated.headers.get('etag')).not.toBe(staleEtag)
      expect(await idsOf(revalidated)).not.toContain(TARGET)

      // An isolate that never rendered finds the pre-outage entry in KV,
      // does not serve it, and replaces it.
      vi.resetModules()
      const fresh = (await import('./catalog')).onRequestGet
      expect(await idsOf(await fresh(makeCtx({ env: healthy })))).not.toContain(TARGET)
      expect(kv._store.get(SNAPSHOT_KEY)).not.toContain(TARGET)

      // The failed delete was logged. The generation write landed, so it
      // exposed nothing: a warning, not an error.
      expect(logged(warn)).toMatch(/KV snapshot delete failed — the generation write landed/)
      expect(error).not.toHaveBeenCalled()
    })

    it('is not served from a render that read D1 before the retraction and cached after it', async () => {
      const db = asD1(seedFixtures({ count: 3 }))
      const kv = makeKV()
      const env = { CATALOG_DB: db, CATALOG_KV: kv }

      // Land the retraction, invalidation included, between a render
      // and its put: a request that read D1 just before the retraction
      // committed and wrote KV just after its delete.
      const put = kv.put
      let retraction: Awaited<ReturnType<typeof retractDataset>> | null = null
      ;(kv as { put: KVNamespace['put'] }).put = vi.fn(async (...args: Parameters<KVNamespace['put']>) => {
        retraction ??= await retractDataset(env, TARGET)
        return put(...args)
      })

      // That request read D1 first, so it answers with TARGET, and it
      // cached that body after the retraction's delete.
      expect(await idsOf(await onRequestGet(makeCtx({ env })))).toContain(TARGET)
      expect(retraction).toMatchObject({ ok: true })
      expect(kv._store.get(SNAPSHOT_KEY)).toContain(TARGET)

      // The next request does not serve it.
      expect(await idsOf(await onRequestGet(makeCtx({ env })))).not.toContain(TARGET)
      expect(kv._store.get(SNAPSHOT_KEY)).not.toContain(TARGET)
    })

    it('is not served from a render whose data read straddles the retraction', async () => {
      // Land the retraction inside the render, just after it read the
      // public rows. The generation must already have been read by then;
      // read afterwards, it would stamp the retracted row as current.
      const db = asD1(seedFixtures({ count: 3 }))
      const env = { CATALOG_DB: db, CATALOG_KV: makeKV() }
      const prepare = db.prepare.bind(db)
      let retraction: Awaited<ReturnType<typeof retractDataset>> | null = null
      ;(db as { prepare: D1Database['prepare'] }).prepare = (sql: string) => {
        const stmt = prepare(sql)
        if (retraction || !sql.includes(PUBLIC_DATASET_PREDICATE)) return stmt
        const bind = stmt.bind.bind(stmt)
        stmt.bind = (...values: unknown[]) => {
          const bound = bind(...values)
          const all = bound.all.bind(bound)
          bound.all = (async () => {
            const rows = await all()
            retraction = await retractDataset(env, TARGET)
            return rows
          }) as typeof bound.all
          return bound
        }
        return stmt
      }

      expect(await idsOf(await onRequestGet(makeCtx({ env })))).toContain(TARGET)
      expect(retraction).toMatchObject({ ok: true })
      expect(await idsOf(await onRequestGet(makeCtx({ env })))).not.toContain(TARGET)
    })

    it('re-renders over an entry written before the generation check existed', async () => {
      const kv = makeKV()
      kv._store.set(
        SNAPSHOT_KEY,
        JSON.stringify({ etag: '"old"', generatedAt: '2026-11-01T00:00:00.000Z', body: '{"stale":true}', contentType: 'application/json' }),
      )
      const res = await onRequestGet(makeCtx({ env: { CATALOG_DB: asD1(seedFixtures({ count: 2 })), CATALOG_KV: kv } }))
      expect(res.headers.get('etag')).not.toBe('"old"')
      expect(await idsOf(res)).toHaveLength(2)
    })

    it('when D1 cannot be read, serves the cached snapshot unverified, logged, under the TTL every put sets', async () => {
      const kv = makeKV()
      await onRequestGet(makeCtx({ env: { CATALOG_DB: asD1(seedFixtures({ count: 3 })), CATALOG_KV: kv } }))
      expect(kv.put).toHaveBeenCalledWith(SNAPSHOT_KEY, expect.any(String), {
        expirationTtl: SNAPSHOT_TTL_SECONDS,
      })
      const cached = JSON.parse(kv._store.get(SNAPSHOT_KEY)!) as { body: string }

      const res = await onRequestGet(makeCtx({ env: { CATALOG_DB: makeFailingD1(), CATALOG_KV: kv } }))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(cached.body)
      expect(logged(error)).toMatch(/generation read failed — serving the cached snapshot unverified/)
    })

    it('never serves an entry from before the check unverified, since it has no TTL', async () => {
      const legacy = JSON.stringify({
        etag: '"old"', generatedAt: '2026-11-01T00:00:00.000Z', body: '{"stale":true}', contentType: 'application/json',
      })

      // D1 works but migration 0062 has not been applied: render, and
      // replace the entry with one that carries a TTL.
      const sqlite = seedFixtures({ count: 2 })
      sqlite.prepare('DROP TABLE catalog_snapshot_generation').run()
      const kv = makeKV()
      kv._store.set(SNAPSHOT_KEY, legacy)
      const res = await onRequestGet(makeCtx({ env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv } }))
      expect(await idsOf(res)).toHaveLength(2)
      expect(kv.put).toHaveBeenCalledWith(SNAPSHOT_KEY, expect.any(String), {
        expirationTtl: SNAPSHOT_TTL_SECONDS,
      })

      // D1 down: there is nothing safe to serve, so the request fails.
      const down = makeKV()
      down._store.set(SNAPSHOT_KEY, legacy)
      await expect(onRequestGet(makeCtx({ env: { CATALOG_DB: makeFailingD1(), CATALOG_KV: down } }))).rejects.toThrow(
        /database unavailable/,
      )
    })

    it('renders once per generation, not per request, when KV puts fail', async () => {
      // The free tier's 1k daily KV writes can be spent by other caches;
      // every put then fails, and each request would otherwise render.
      const sqlite = seedFixtures({ count: 2 })
      const kv = makeKV()
      ;(kv as { put: KVNamespace['put'] }).put = vi.fn(async () => {
        throw new Error('KV put limit exceeded')
      })
      const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv }
      expect(await idsOf(await onRequestGet(makeCtx({ env })))).toHaveLength(2)

      // A row added without an invalidation is not seen: no re-render.
      sqlite
        .prepare(
          `INSERT INTO datasets (id, slug, origin_node, title, format, data_ref, weight, visibility,
             schema_version, created_at, updated_at, published_at)
           VALUES ('DS998AAAAAAAAAAAAAAAAAAAAA', 'unseen', 'NODE000', 'Unseen', 'video/mp4', 'vimeo:998', 0,
             'public', 1, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
        )
        .run()
      expect(await idsOf(await onRequestGet(makeCtx({ env })))).toHaveLength(2)

      // A new generation is.
      await invalidateSnapshot(env)
      expect(await idsOf(await onRequestGet(makeCtx({ env })))).toHaveLength(3)
      expect(logged(warn)).toMatch(/KV snapshot write failed — not cached.*KV put limit exceeded/)
    })

    it('keeps caching on a deploy ahead of migration 0062, and re-renders once it applies', async () => {
      const sqlite = seedFixtures({ count: 2 })
      sqlite.prepare('DROP TABLE catalog_snapshot_generation').run()
      const kv = makeKV()
      const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv }
      const stamp = () => (JSON.parse(kv._store.get(SNAPSHOT_KEY)!) as { generation: unknown }).generation

      await onRequestGet(makeCtx({ env }))
      await onRequestGet(makeCtx({ env }))
      expect(kv.put).toHaveBeenCalledTimes(1)
      expect(stamp()).toBeNull()

      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0062_catalog_snapshot_generation.sql'), 'utf8'))
      await onRequestGet(makeCtx({ env }))
      expect(kv.put).toHaveBeenCalledTimes(2)
      expect(stamp()).toMatch(/^[0-9a-f]{32}$/)
    })
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

  // Regression: a facet named after an Object.prototype member made
  // the serializer throw, so one author's dataset turned every visitor's
  // catalog read into a 500.
  it('serves a dataset whose category facet is named toString', async () => {
    const sqlite = seedFixtures({ count: 1 })
    const { id } = sqlite.prepare(`SELECT id FROM datasets LIMIT 1`).get() as { id: string }
    sqlite
      .prepare(`INSERT INTO dataset_categories (dataset_id, facet, value) VALUES (?, ?, ?)`)
      .run(id, 'toString', 'Oddly named')
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }

    const res = await onRequestGet(makeCtx({ env }))
    expect(res.status).toBe(200)
    const body = await readJson<CatalogBody>(res)
    expect(body.datasets[0].enriched?.categories).toEqual({
      Theme: ['Climate'],
      toString: ['Oddly named'],
    })
  })
})
