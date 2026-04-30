/**
 * Tests for GET /api/v1/search?q=...
 *
 * Coverage:
 *   - 503 when CATALOG_DB is unbound.
 *   - 400 for missing / overlong q, or out-of-range limit.
 *   - 200 + result set under MOCK_AI / MOCK_VECTORIZE.
 *   - KV cache: second call hits KV with `X-Cache: HIT`.
 *   - Different (q, limit, category, peer_id) tuples land in
 *     different cache slots.
 *   - Degraded responses (`degraded: 'unconfigured'`) are NOT cached
 *     and carry a `Warning` header so the docent can fall back to
 *     its local engine.
 */

import { describe, expect, it, vi } from 'vitest'
import { onRequestGet } from './search'
import { asD1, makeCtx, makeKV } from './_lib/test-helpers'
import { freshMigratedDb } from '../../../scripts/lib/catalog-migrations'
import { embedDatasetJob } from './_lib/embed-dataset-job'
import { __clearMockStore, type VectorizeEnv } from './_lib/vectorize-store'

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
       VALUES ('PUB001', 'p@t', 'P', 'staff', 'active', ?)`,
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
  seedDataset('DS_HURR', 'Atlantic Hurricane Tracks', ['hurricane', 'storm'])
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

interface SearchBody {
  datasets: Array<{ id: string; title: string; score: number }>
  degraded?: string
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/search', () => {
  it('503 when CATALOG_DB is unbound', async () => {
    const ctx = makeCtx({ env: {}, url: 'https://t/api/v1/search?q=hurricane' })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('binding_missing')
  })

  it('400 for missing q', async () => {
    const { env } = setup()
    const ctx = makeCtx({ env, url: 'https://t/api/v1/search' })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(400)
    expect((await readJson<{ message: string }>(res)).message).toMatch(/q/)
  })

  it('400 for overlong q', async () => {
    const { env } = setup()
    const longQ = 'a'.repeat(201)
    const ctx = makeCtx({ env, url: `https://t/api/v1/search?q=${longQ}` })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(400)
  })

  it('accepts q whose canonical form is ≤ MAX_QUERY_LENGTH after surrounding whitespace is trimmed', async () => {
    // Regression for Copilot review on PR #59: length was checked
    // against the raw URL value before NFC + trim, so
    // `q=<spaces>hurricane<spaces>` (canonical length 9) could be
    // rejected if the URL exceeded 200 chars. Validation now runs
    // against the canonical form.
    const { env } = setup()
    await index(env, ['DS_HURR'])
    const padded = '%20'.repeat(70) + 'hurricane' + '%20'.repeat(70) // ~210 raw chars; 9 canonical
    const ctx = makeCtx({ env, url: `https://t/api/v1/search?q=${padded}` })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
  })

  it('400 when q is whitespace-only after trim', async () => {
    const { env } = setup()
    const ctx = makeCtx({ env, url: 'https://t/api/v1/search?q=%20%20%20' })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(400)
  })

  it('400 for invalid limit', async () => {
    const { env } = setup()
    for (const bad of ['0', '51', '-1', 'abc', '3.5']) {
      const ctx = makeCtx({ env, url: `https://t/api/v1/search?q=hurricane&limit=${bad}` })
      const res = await onRequestGet(ctx)
      expect(res.status).toBe(400)
    }
  })

  it('200 with results in score-sorted order', async () => {
    const { env } = setup()
    await index(env, ['DS_HURR', 'DS_VOLC'])

    const ctx = makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane%20storm' })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Cache')).toBe('MISS')
    const body = await readJson<SearchBody>(res)
    expect(body.degraded).toBeUndefined()
    expect(body.datasets[0].id).toBe('DS_HURR')
  })

  it('caches successful responses in KV', async () => {
    const { env, kv } = setup()
    await index(env, ['DS_HURR', 'DS_VOLC'])

    const url = 'https://t/api/v1/search?q=hurricane'
    const first = await onRequestGet(makeCtx({ env, url }))
    expect(first.headers.get('X-Cache')).toBe('MISS')

    // KV recorded the value.
    expect(kv?._store.size).toBe(1)

    const second = await onRequestGet(makeCtx({ env, url }))
    expect(second.headers.get('X-Cache')).toBe('HIT')
    const a = await readJson<SearchBody>(first)
    const b = await readJson<SearchBody>(second)
    expect(b).toEqual(a)
  })

  it('different filter shapes land in different cache slots', async () => {
    const { env, kv } = setup()
    await index(env, ['DS_HURR', 'DS_VOLC'])

    // Note: a bare `?q=hurricane` defaults `peer_id` to `'local'`,
    // so we use an explicit federated peer here for the third
    // variant to make sure the three URLs hit three distinct cache
    // slots.
    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane' }))
    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&limit=5' }))
    await onRequestGet(
      makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&peer_id=PEER_X' }),
    )
    expect(kv?._store.size).toBe(3)
  })

  it('case-sensitive peer_id values land in different cache slots', async () => {
    // Regression for #59 / Copilot review: lowercasing peer_id in
    // the cache key would let `peer_id=PEER_X` and `peer_id=peer_x`
    // share a slot, but Vectorize metadata is case-sensitive — they
    // would produce different result sets, so the cache must keep
    // them separate.
    const { env, kv } = setup()
    await index(env, ['DS_HURR'])
    await onRequestGet(
      makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&peer_id=PEER_X' }),
    )
    await onRequestGet(
      makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&peer_id=peer_x' }),
    )
    expect(kv?._store.size).toBe(2)
  })

  it('defaults peer_id to "local" when the URL omits it', async () => {
    // Per the route docs ("federated peers are excluded by
    // default"); the explicit and the implicit forms must share a
    // cache slot.
    const { env, kv } = setup()
    await index(env, ['DS_HURR'])
    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane' }))
    await onRequestGet(
      makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&peer_id=local' }),
    )
    expect(kv?._store.size).toBe(1)
  })

  it('whitespace-padded peer_id shares a cache slot with the trimmed form', async () => {
    // Regression for Copilot review on PR #59: peer_id was trimmed
    // for the cache key but not for the downstream filter, so
    // `?peer_id=%20PEER_X%20` would compute a result with a
    // space-padded filter (matching nothing) yet cache it under the
    // same key as `?peer_id=PEER_X`. Subsequent correct requests
    // would get the corrupt result back as a HIT.
    const { env, kv } = setup()
    await index(env, ['DS_HURR'])
    await onRequestGet(
      makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&peer_id=PEER_X' }),
    )
    await onRequestGet(
      makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&peer_id=%20PEER_X%20' }),
    )
    expect(kv?._store.size).toBe(1)
  })

  it('empty-after-trim peer_id falls through to default', async () => {
    // `?peer_id=` and `?peer_id=%20%20` should both behave like the
    // omitted-param form (default to 'local'), and share its slot.
    const { env, kv } = setup()
    await index(env, ['DS_HURR'])
    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane' }))
    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&peer_id=' }))
    await onRequestGet(
      makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&peer_id=%20%20' }),
    )
    expect(kv?._store.size).toBe(1)
  })

  it('empty-after-trim category shares a cache slot with the omitted-param form', async () => {
    // Regression for Copilot review on PR #59: an explicit
    // `?category=` (or all whitespace) used to produce `''` after
    // canonicalisation, falling into a different cache slot than
    // omitting the param even though both produced "no category
    // filter" downstream.
    const { env, kv } = setup()
    await index(env, ['DS_HURR'])
    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane' }))
    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&category=' }))
    await onRequestGet(
      makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane&category=%20%20' }),
    )
    expect(kv?._store.size).toBe(1)
  })

  it('canonicalises whitespace + case so trivial query variants share a cache slot', async () => {
    const { env, kv } = setup()
    await index(env, ['DS_HURR'])

    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/search?q=Hurricane' }))
    await onRequestGet(makeCtx({ env, url: 'https://t/api/v1/search?q=%20HURRICANE%20' }))
    expect(kv?._store.size).toBe(1)
  })

  it('does NOT cache degraded responses; stamps Warning header', async () => {
    const { env, kv } = setup({ withAi: false })

    const res = await onRequestGet(
      makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane' }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<SearchBody>(res)
    expect(body.degraded).toBe('unconfigured')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Warning')).toMatch(/unconfigured/)
    expect(kv?._store.size ?? 0).toBe(0)
  })

  it('works without CATALOG_KV (no-cache fallback)', async () => {
    const { env } = setup({ withKv: false })
    await index(env, ['DS_HURR'])

    const res = await onRequestGet(
      makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane' }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<SearchBody>(res)
    expect(body.datasets.length).toBeGreaterThan(0)
  })

  it('skips the SHA-256 cache-key computation when CATALOG_KV is not bound', async () => {
    // Regression for Copilot review on PR #59: cache key was being
    // hashed unconditionally, even when the value would never be
    // used. Verify by spying on `crypto.subtle.digest` and asserting
    // it isn't called when KV is absent.
    const { env } = setup({ withKv: false })
    await index(env, ['DS_HURR'])

    const digestSpy = vi.spyOn(crypto.subtle, 'digest')
    try {
      const res = await onRequestGet(
        makeCtx({ env, url: 'https://t/api/v1/search?q=hurricane' }),
      )
      expect(res.status).toBe(200)
      // The cache-key path uses SHA-256; the embedder mock and
      // anything else in the request flow uses no other digest, so
      // any digest call here would be the cache key.
      const sha256Calls = digestSpy.mock.calls.filter(call => {
        const algo = call[0] as string | { name?: string }
        if (typeof algo === 'string') return algo === 'SHA-256'
        return algo?.name === 'SHA-256'
      })
      expect(sha256Calls.length).toBe(0)
    } finally {
      digestSpy.mockRestore()
    }
  })
})
