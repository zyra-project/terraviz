/**
 * Wire-level tests for GET /api/v1/tours.
 * Phase 3pt/G follow-up — public tour discovery endpoint.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet } from './tours'
import { asD1, makeKV, seedFixtures } from './_lib/test-helpers'
import type Database from 'better-sqlite3'

function insertTour(
  db: Database.Database,
  opts: {
    id: string
    slug?: string
    title?: string
    visibility?: 'public' | 'federated' | 'restricted' | 'private'
    published_at?: string | null
    retracted_at?: string | null
  },
): void {
  const ts = '2026-02-01T00:00:00.000Z'
  db.prepare(
    `INSERT INTO tours (
       id, slug, origin_node, title, description, tour_json_ref, thumbnail_ref,
       visibility, schema_version, created_at, updated_at, published_at, retracted_at, publisher_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.slug ?? `slug-${opts.id.slice(-4).toLowerCase()}`,
    'NODE000',
    opts.title ?? `Tour ${opts.id.slice(-4)}`,
    null,
    `r2:tours/${opts.id}/published/01HXSAMPLE.json`,
    null,
    opts.visibility ?? 'public',
    1,
    ts,
    ts,
    opts.published_at === undefined ? ts : opts.published_at,
    opts.retracted_at ?? null,
    null,
  )
}

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  const env = {
    CATALOG_DB: asD1(sqlite),
    CATALOG_KV: makeKV(),
    R2_PUBLIC_BASE: 'https://r2.example.com',
  }
  return { sqlite, env }
}

function ctx(env: Record<string, unknown>, search = '') {
  const url = `https://localhost/api/v1/tours${search}`
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<PagesFunction<Record<string, unknown>>>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/tours', () => {
  it('returns only public, published, non-retracted tours', async () => {
    const { sqlite, env } = setupEnv()
    insertTour(sqlite, { id: 'T0000000000000000000000PUB' })
    insertTour(sqlite, {
      id: 'T0000000000000000000DRAFT0',
      published_at: null,
    })
    insertTour(sqlite, {
      id: 'T00000000000000000RETRACT0',
      retracted_at: '2026-02-15T00:00:00.000Z',
    })
    insertTour(sqlite, { id: 'T000000000000000000PRIVATE', visibility: 'private' })
    insertTour(sqlite, {
      id: 'T0000000000000000RESTRICTED',
      visibility: 'restricted',
    })
    insertTour(sqlite, {
      id: 'T00000000000000000FEDERATED',
      visibility: 'federated',
    })
    const res = await onRequestGet(ctx(env))
    expect(res.status).toBe(200)
    const body = await readJson<{ tours: Array<{ id: string }> }>(res)
    expect(body.tours.map(t => t.id)).toEqual(['T0000000000000000000000PUB'])
  })

  it('resolves tour_json_ref and thumbnail_ref to HTTPS URLs via R2_PUBLIC_BASE', async () => {
    const { sqlite, env } = setupEnv()
    sqlite
      .prepare(
        `INSERT INTO tours (
           id, slug, origin_node, title, description, tour_json_ref, thumbnail_ref,
           visibility, schema_version, created_at, updated_at, published_at, retracted_at, publisher_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'T0000000000000000000000RES',
        'with-thumb',
        'NODE000',
        'With thumb',
        'A test tour with a thumbnail.',
        'r2:tours/T0000000000000000000000RES/published/01HX.json',
        'r2:tours/T0000000000000000000000RES/thumb.jpg',
        'public',
        1,
        '2026-02-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
        null,
        null,
      )
    const res = await onRequestGet(ctx(env))
    const body = await readJson<{
      tours: Array<{
        tour_json_url: string | null
        thumbnail_url: string | null
        description: string | null
      }>
    }>(res)
    expect(body.tours[0].tour_json_url).toBe(
      'https://r2.example.com/tours/T0000000000000000000000RES/published/01HX.json',
    )
    expect(body.tours[0].thumbnail_url).toBe(
      'https://r2.example.com/tours/T0000000000000000000000RES/thumb.jpg',
    )
    expect(body.tours[0].description).toBe('A test tour with a thumbnail.')
  })

  it('paginates via id < cursor in DESC order', async () => {
    const { sqlite, env } = setupEnv()
    // ULIDs sort lexicographically — make ids predictable.
    for (const suffix of ['001', '002', '003', '004', '005']) {
      insertTour(sqlite, { id: `T00000000000000000000000${suffix}` })
    }
    const first = await readJson<{ tours: Array<{ id: string }>; next_cursor: string | null }>(
      await onRequestGet(ctx(env, '?limit=2')),
    )
    expect(first.tours.map(t => t.id)).toEqual([
      'T00000000000000000000000005',
      'T00000000000000000000000004',
    ])
    expect(first.next_cursor).toBe('T00000000000000000000000004')

    const second = await readJson<{ tours: Array<{ id: string }>; next_cursor: string | null }>(
      await onRequestGet(ctx(env, `?limit=2&cursor=${first.next_cursor}`)),
    )
    expect(second.tours.map(t => t.id)).toEqual([
      'T00000000000000000000000003',
      'T00000000000000000000000002',
    ])
    expect(second.next_cursor).toBe('T00000000000000000000000002')
  })

  it('rejects invalid limit', async () => {
    const { env } = setupEnv()
    const res = await onRequestGet(ctx(env, '?limit=foo'))
    expect(res.status).toBe(400)
  })

  it('rejects limit out of [1, 200]', async () => {
    const { env } = setupEnv()
    const tooBig = await onRequestGet(ctx(env, '?limit=500'))
    expect(tooBig.status).toBe(400)
    const tooSmall = await onRequestGet(ctx(env, '?limit=0'))
    expect(tooSmall.status).toBe(400)
  })

  it('returns 503 binding_missing when CATALOG_DB is unbound', async () => {
    const res = await onRequestGet(ctx({}))
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('binding_missing')
  })

  it('emits Cache-Control public, max-age=60, stale-while-revalidate=300', async () => {
    const { env } = setupEnv()
    const res = await onRequestGet(ctx(env))
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=60, stale-while-revalidate=300',
    )
  })
})
