/**
 * Tests for GET /api/v1/featured (the docent's read endpoint).
 *
 * Coverage:
 *   - 503 when CATALOG_DB is unbound.
 *   - 400 for an out-of-range or non-integer `limit`.
 *   - 200 + result with the documented payload shape.
 *   - KV cache: second call hits KV with `X-Cache: HIT`.
 *   - Different `limit` values land in different cache slots.
 *   - Works without CATALOG_KV (no-cache fallback).
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet } from './featured'
import { asD1, makeCtx, makeKV } from './_lib/test-helpers'
import { freshMigratedDb } from '../../../scripts/lib/catalog-migrations'

const TS = '2026-04-29T12:00:00.000Z'

function setup(opts: { withKv?: boolean } = {}) {
  const sqlite = freshMigratedDb()
  sqlite
    .prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
       VALUES ('NODE000', 'T', 'https://t', 'k', ?)`,
    )
    .run(TS)
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, status, created_at)
       VALUES ('PUB001', 'p@t', 'P', 'staff', 'active', ?)`,
    )
    .run(TS)
  for (let i = 0; i < 3; i++) {
    const id = `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)
    sqlite
      .prepare(
        `INSERT INTO datasets (id, slug, origin_node, title, abstract, format, data_ref,
                               weight, visibility, is_hidden, schema_version,
                               created_at, updated_at, published_at, publisher_id)
         VALUES (?, ?, 'NODE000', ?, ?, 'video/mp4', 'vimeo:1',
                 0, 'public', 0, 1, ?, ?, ?, 'PUB001')`,
      )
      .run(id, `dataset-${i}`, `Dataset ${i}`, 'Abstract.', TS, TS, TS)
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, 'PUB001', ?)`,
      )
      .run(id, i, TS)
  }

  const kv = opts.withKv === false ? undefined : makeKV()
  const env: Record<string, unknown> = {
    CATALOG_DB: asD1(sqlite),
    ...(kv ? { CATALOG_KV: kv } : {}),
  }
  return { sqlite, env, kv }
}

interface FeaturedBody {
  datasets: Array<{ id: string; title: string; position: number; thumbnail_url: string | null }>
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/featured', () => {
  it('503 when CATALOG_DB is unbound', async () => {
    const ctx = makeCtx({ env: {}, url: 'https://t/api/v1/featured' })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
  })

  it('400 for non-integer limit', async () => {
    const { env } = setup()
    for (const bad of ['abc', '-1', '1.5', '0', '999']) {
      const ctx = makeCtx({ env, url: `https://t/api/v1/featured?limit=${bad}` })
      const res = await onRequestGet(ctx)
      expect(res.status).toBe(400)
    }
  })

  it('200 with the documented payload shape', async () => {
    const { env } = setup()
    const ctx = makeCtx({ env, url: 'https://t/api/v1/featured' })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Cache')).toBe('MISS')
    const body = await readJson<FeaturedBody>(res)
    expect(body.datasets).toHaveLength(3)
    expect(body.datasets[0]).toMatchObject({
      title: 'Dataset 0',
      position: 0,
      thumbnail_url: null,
    })
  })

  it('caches successful responses in KV', async () => {
    const { env, kv } = setup()
    const url = 'https://t/api/v1/featured'

    const a = await onRequestGet(makeCtx({ env, url }))
    expect(a.headers.get('X-Cache')).toBe('MISS')
    expect(kv?._store.size).toBe(1)

    const b = await onRequestGet(makeCtx({ env, url }))
    expect(b.headers.get('X-Cache')).toBe('HIT')
    expect(await readJson<FeaturedBody>(a)).toEqual(await readJson<FeaturedBody>(b))
  })

  it('different limit values land in different cache slots', async () => {
    const { env, kv } = setup()
    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/featured?limit=2' }))
    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/featured?limit=3' }))
    expect(kv?._store.size).toBe(2)
  })

  it('works without CATALOG_KV (no-cache fallback)', async () => {
    const { env } = setup({ withKv: false })
    const res = await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/featured' }))
    expect(res.status).toBe(200)
    const body = await readJson<FeaturedBody>(res)
    expect(body.datasets.length).toBe(3)
  })
})
