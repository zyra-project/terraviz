// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for GET /api/v1/datasets/{id}/related
 *
 * Coverage:
 *   - 503 when CATALOG_DB is unbound.
 *   - 404 when the seed dataset is missing / not public.
 *   - 400 for an out-of-range limit.
 *   - 200 returns the seed's nearest neighbours, EXCLUDING the seed
 *     itself, semantically ranked (a token-sharing dataset outranks an
 *     unrelated one under the deterministic mock embedder).
 *   - `limit` caps the result count.
 *   - Degraded (`unconfigured`) passthrough when the embed bindings
 *     aren't wired — NOT cached, stamps a Warning header, so the client
 *     falls back to the lexical scorer.
 *   - KV cache: second call hits KV with `X-Cache: HIT`.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet } from './related'
import { asD1, makeCtx, makeKV } from '../../_lib/test-helpers'
import { freshMigratedDb } from '../../../../../scripts/lib/catalog-migrations'
import { embedDatasetJob } from '../../_lib/embed-dataset-job'
import { __clearMockStore, type VectorizeEnv } from '../../_lib/vectorize-store'

const TS = '2026-04-29T12:00:00.000Z'

function setup(opts: { withAi?: boolean; withVec?: boolean; withKv?: boolean } = {}) {
  const sqlite = freshMigratedDb()
  sqlite
    .prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
       VALUES ('LOCAL_NODE', 'T', 'https://t', 'k', ?)`,
    )
    .run(TS)
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, status, created_at)
       VALUES ('PUB001', 'p@t', 'P', 'admin', 'active', ?)`,
    )
    .run(TS)

  const seedDataset = (id: string, title: string, keywords: string[]): void => {
    sqlite
      .prepare(
        `INSERT INTO datasets (id, slug, origin_node, title, abstract, format, data_ref,
                               weight, visibility, is_hidden, schema_version,
                               created_at, updated_at, published_at, publisher_id)
         VALUES (?, ?, 'LOCAL_NODE', ?, 'Abstract.', 'video/mp4', 'vimeo:1',
                 0, 'public', 0, 1, ?, ?, ?, 'PUB001')`,
      )
      .run(id, id.toLowerCase(), title, TS, TS, TS)
    for (const k of keywords) {
      sqlite
        .prepare(`INSERT INTO dataset_keywords (dataset_id, keyword) VALUES (?, ?)`)
        .run(id, k)
    }
  }
  // Seed shares the most tokens with DS_STORM (both about hurricanes /
  // storms) and the least with DS_VOLC (volcanoes), so the mock
  // feature-hashing embedder ranks DS_STORM above DS_VOLC.
  seedDataset('DS_HURR', 'Atlantic Hurricane Tracks', ['hurricane', 'storm'])
  seedDataset('DS_STORM', 'Hurricane Storm Surge Forecast', ['hurricane', 'storm', 'surge'])
  seedDataset('DS_VOLC', 'Volcano Eruptions', ['volcano', 'lava'])

  const kv = opts.withKv === false ? undefined : makeKV()
  const env: Record<string, unknown> = {
    CATALOG_DB: asD1(sqlite),
    ...(kv ? { CATALOG_KV: kv } : {}),
    ...(opts.withAi !== false ? { MOCK_AI: 'true' } : {}),
    ...(opts.withVec !== false ? { MOCK_VECTORIZE: 'true' } : {}),
  }
  __clearMockStore(env as VectorizeEnv)
  return { sqlite, env, kv }
}

async function index(env: Record<string, unknown>, ids: string[]): Promise<void> {
  for (const id of ids) await embedDatasetJob(env as never, { dataset_id: id })
}

interface RelatedBody {
  datasets: Array<{ id: string; title: string; score: number }>
  degraded?: string
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/datasets/:id/related', () => {
  it('503 when CATALOG_DB is unbound', async () => {
    const ctx = makeCtx<'id'>({ env: {}, url: 'https://t/api/v1/datasets/DS_HURR/related', params: { id: 'DS_HURR' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('binding_missing')
  })

  it('404 when the seed dataset is not found', async () => {
    const { env } = setup()
    const ctx = makeCtx<'id'>({ env, url: 'https://t/api/v1/datasets/NOPE/related', params: { id: 'NOPE' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(404)
    expect((await readJson<{ error: string }>(res)).error).toBe('not_found')
  })

  it('400 for an out-of-range limit', async () => {
    const { env } = setup()
    for (const bad of ['0', '21', '-1', 'abc', '2.5']) {
      const ctx = makeCtx<'id'>({
        env,
        url: `https://t/api/v1/datasets/DS_HURR/related?limit=${bad}`,
        params: { id: 'DS_HURR' },
      })
      const res = await onRequestGet(ctx)
      expect(res.status, `limit=${bad}`).toBe(400)
    }
  })

  it('returns nearest neighbours excluding the seed, semantically ranked', async () => {
    const { env } = setup()
    await index(env, ['DS_HURR', 'DS_STORM', 'DS_VOLC'])

    const ctx = makeCtx<'id'>({
      env,
      url: 'https://t/api/v1/datasets/DS_HURR/related',
      params: { id: 'DS_HURR' },
    })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Cache')).toBe('MISS')
    const body = await readJson<RelatedBody>(res)
    expect(body.degraded).toBeUndefined()
    const ids = body.datasets.map(d => d.id)
    // The seed never appears in its own neighbour list.
    expect(ids).not.toContain('DS_HURR')
    // The storm dataset shares tokens with the seed; the volcano one
    // doesn't — so storm is present and ranks ahead of volcano.
    expect(ids).toContain('DS_STORM')
    if (ids.includes('DS_VOLC')) {
      expect(ids.indexOf('DS_STORM')).toBeLessThan(ids.indexOf('DS_VOLC'))
    }
  })

  it('caps the result count at `limit`', async () => {
    const { env } = setup()
    await index(env, ['DS_HURR', 'DS_STORM', 'DS_VOLC'])
    const ctx = makeCtx<'id'>({
      env,
      url: 'https://t/api/v1/datasets/DS_HURR/related?limit=1',
      params: { id: 'DS_HURR' },
    })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<RelatedBody>(res)
    expect(body.datasets).toHaveLength(1)
    expect(body.datasets[0].id).not.toBe('DS_HURR')
  })

  it('does NOT cache degraded responses; stamps Warning header', async () => {
    const { env, kv } = setup({ withAi: false })
    const ctx = makeCtx<'id'>({
      env,
      url: 'https://t/api/v1/datasets/DS_HURR/related',
      params: { id: 'DS_HURR' },
    })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<RelatedBody>(res)
    expect(body.degraded).toBe('unconfigured')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Warning')).toMatch(/unconfigured/)
    expect(kv?._store.size ?? 0).toBe(0)
  })

  it('caches successful responses in KV (second call is a HIT)', async () => {
    const { env, kv } = setup()
    await index(env, ['DS_HURR', 'DS_STORM', 'DS_VOLC'])
    const url = 'https://t/api/v1/datasets/DS_HURR/related'
    const first = await onRequestGet(makeCtx<'id'>({ env, url, params: { id: 'DS_HURR' } }))
    expect(first.headers.get('X-Cache')).toBe('MISS')
    expect(kv?._store.size).toBe(1)
    const second = await onRequestGet(makeCtx<'id'>({ env, url, params: { id: 'DS_HURR' } }))
    expect(second.headers.get('X-Cache')).toBe('HIT')
    expect(await readJson<RelatedBody>(second)).toEqual(await readJson<RelatedBody>(first))
  })
})
