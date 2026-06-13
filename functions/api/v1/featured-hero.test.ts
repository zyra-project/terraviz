/**
 * Tests for GET /api/v1/featured-hero (the public hero read).
 *
 * Coverage:
 *   - 503 when CATALOG_DB is unbound.
 *   - 200 `{ hero: null }` when no override is set.
 *   - 200 with the raw override payload when one is set.
 *   - KV cache: second call hits KV with `X-Cache: HIT`.
 *   - Works without CATALOG_KV (no-cache fallback).
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet } from './featured-hero'
import { asD1, makeCtx, makeKV } from './_lib/test-helpers'
import { setHeroOverride } from './_lib/hero-override-store'
import { freshMigratedDb } from '../../../scripts/lib/catalog-migrations'
import type { PublisherRow } from './_lib/publisher-store'

const TS = '2026-05-01T00:00:00.000Z'
const URL_HERO = 'https://t/api/v1/featured-hero'

const ADMIN: PublisherRow = {
  id: 'PUB001',
  email: 'p@t',
  display_name: 'P',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: TS,
}

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
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, 'p@t', 'P', 'admin', 1, 'active', ?)`,
    )
    .run(ADMIN.id, TS)
  const datasetId = 'DS000' + 'A'.repeat(21)
  sqlite
    .prepare(
      `INSERT INTO datasets (id, slug, origin_node, title, abstract, format, data_ref,
                             weight, visibility, is_hidden, schema_version,
                             created_at, updated_at, published_at, publisher_id)
       VALUES (?, 'dataset-0', 'NODE000', 'Dataset 0', 'Abstract.', 'video/mp4', 'vimeo:1',
               0, 'public', 0, 1, ?, ?, ?, ?)`,
    )
    .run(datasetId, TS, TS, TS, ADMIN.id)
  const kv = opts.withKv === false ? undefined : makeKV()
  const env: Record<string, unknown> = {
    CATALOG_DB: asD1(sqlite),
    ...(kv ? { CATALOG_KV: kv } : {}),
  }
  return { sqlite, env, kv, datasetId }
}

interface HeroBody {
  hero: { datasetId: string; window: { start: string; end: string }; headline?: string } | null
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

async function pin(env: Record<string, unknown>, datasetId: string, headline?: string): Promise<void> {
  await setHeroOverride(
    env.CATALOG_DB as D1Database,
    ADMIN,
    { dataset_id: datasetId, window_start: '2026-05-01T00:00:00.000Z', window_end: '2026-06-01T00:00:00.000Z', headline: headline ?? null },
    TS,
  )
}

describe('GET /api/v1/featured-hero', () => {
  it('503 when CATALOG_DB is unbound', async () => {
    const res = await onRequestGet(makeCtx({ env: {}, url: URL_HERO }))
    expect(res.status).toBe(503)
  })

  it('200 { hero: null } when no override is set', async () => {
    const { env } = setup()
    const res = await onRequestGet(makeCtx({ env, url: URL_HERO }))
    expect(res.status).toBe(200)
    const body = await readJson<HeroBody>(res)
    expect(body.hero).toBeNull()
  })

  it('200 with the raw override payload when set', async () => {
    const { env, datasetId } = setup()
    await pin(env, datasetId, 'Big storm')
    const res = await onRequestGet(makeCtx({ env, url: URL_HERO }))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Cache')).toBe('MISS')
    const body = await readJson<HeroBody>(res)
    expect(body.hero).toEqual({
      datasetId,
      window: { start: '2026-05-01T00:00:00.000Z', end: '2026-06-01T00:00:00.000Z' },
      headline: 'Big storm',
    })
  })

  it('caches successful responses in KV', async () => {
    const { env, kv, datasetId } = setup()
    await pin(env, datasetId)
    const a = await onRequestGet(makeCtx({ env, url: URL_HERO }))
    expect(a.headers.get('X-Cache')).toBe('MISS')
    expect(kv?._store.size).toBe(1)
    const b = await onRequestGet(makeCtx({ env, url: URL_HERO }))
    expect(b.headers.get('X-Cache')).toBe('HIT')
    expect(await readJson<HeroBody>(a)).toEqual(await readJson<HeroBody>(b))
  })

  it('works without CATALOG_KV (no-cache fallback)', async () => {
    const { env, datasetId } = setup({ withKv: false })
    await pin(env, datasetId)
    const res = await onRequestGet(makeCtx({ env, url: URL_HERO }))
    expect(res.status).toBe(200)
    const body = await readJson<HeroBody>(res)
    expect(body.hero?.datasetId).toBe(datasetId)
  })

  it('degrades to { hero: null } (200) when the read throws (table missing / D1 error)', async () => {
    // Simulate the pre-migration state: a CATALOG_DB whose query throws
    // (e.g. `no such table: hero_override`). The endpoint must not 500.
    const throwingDb = {
      prepare: () => ({
        first: async () => {
          throw new Error('D1_ERROR: no such table: hero_override')
        },
      }),
    } as unknown as D1Database
    const res = await onRequestGet(makeCtx({ env: { CATALOG_DB: throwingDb }, url: URL_HERO }))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Cache')).toBe('BYPASS')
    const body = await readJson<HeroBody>(res)
    expect(body.hero).toBeNull()
  })
})
