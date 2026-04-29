/**
 * Wire-level tests for the featured-list endpoints.
 *
 * Coverage:
 *   - GET /api/v1/publish/featured returns rows in display order.
 *   - POST adds a row for staff; refuses with 403 for community.
 *   - POST returns 400 for body shape problems.
 *   - POST returns 404 for an unknown dataset_id, 409 for a
 *     duplicate.
 *   - PUT /{dataset_id} updates position; 403 for community,
 *     404 for absent rows, 400 for bad bodies.
 *   - DELETE /{dataset_id} removes; 403 for community; idempotent
 *     when absent (still 204).
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet as featuredGet, onRequestPost as featuredPost } from './featured'
import {
  onRequestPut as featuredPut,
  onRequestDelete as featuredDelete,
} from './featured/[dataset_id]'
import { asD1, makeKV, seedFixtures } from '../_lib/test-helpers'
import type { PublisherRow } from '../_lib/publisher-store'

const STAFF: PublisherRow = {
  id: 'PUB-STAFF',
  email: 'staff@example.com',
  display_name: 'Staff',
  affiliation: null,
  org_id: null,
  role: 'staff',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}

const COMMUNITY: PublisherRow = {
  ...STAFF,
  id: 'PUB-COMMUNITY',
  email: 'community@example.com',
  display_name: 'Community',
  role: 'community',
  is_admin: 0,
}

function setupEnv() {
  const sqlite = seedFixtures({ count: 3 })
  for (const p of [STAFF, COMMUNITY]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  return {
    sqlite,
    env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() },
  }
}

const DS_0 = 'DS000' + 'A'.repeat(21)
const DS_1 = 'DS001' + 'A'.repeat(21)
const DS_2 = 'DS002' + 'A'.repeat(21)

function ctx(opts: {
  env: Record<string, unknown>
  publisher?: PublisherRow
  method?: string
  body?: unknown
  bodyText?: string
  url?: string
  params?: Record<string, string>
}) {
  const url = opts.url ?? 'https://localhost/api/v1/publish/featured'
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const init: RequestInit = { method: opts.method ?? 'GET', headers }
  if (opts.bodyText !== undefined) init.body = opts.bodyText
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    request: new Request(url, init),
    env: opts.env,
    params: (opts.params ?? {}) as { [K in string]: string | string[] },
    data: { publisher: opts.publisher ?? STAFF },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof featuredGet>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/publish/featured', () => {
  it('returns the featured list in display order', async () => {
    const { env, sqlite } = setupEnv()
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(DS_2, 5, STAFF.id, '2026-04-29T12:00:00.000Z')
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(DS_0, 1, STAFF.id, '2026-04-29T12:01:00.000Z')
    const res = await featuredGet(ctx({ env }))
    expect(res.status).toBe(200)
    const body = await readJson<{ featured: Array<{ dataset_id: string; position: number }> }>(res)
    expect(body.featured.map(r => r.dataset_id)).toEqual([DS_0, DS_2])
  })

  it('returns an empty list cleanly', async () => {
    const { env } = setupEnv()
    const res = await featuredGet(ctx({ env }))
    expect(res.status).toBe(200)
    expect((await readJson<{ featured: unknown[] }>(res)).featured).toEqual([])
  })

  it('rejects an invalid limit', async () => {
    const { env } = setupEnv()
    for (const bad of ['0', '-1', '1.5', '1e2', 'abc', '1abc']) {
      const res = await featuredGet(
        ctx({ env, url: `https://localhost/api/v1/publish/featured?limit=${bad}` }),
      )
      expect(res.status, `?limit=${bad} should reject`).toBe(400)
    }
  })

  it('accepts a positive integer limit', async () => {
    const { env } = setupEnv()
    const res = await featuredGet(
      ctx({ env, url: 'https://localhost/api/v1/publish/featured?limit=10' }),
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /api/v1/publish/featured', () => {
  it('adds a row for staff', async () => {
    const { env } = setupEnv()
    const res = await featuredPost(
      ctx({ env, method: 'POST', body: { dataset_id: DS_0, position: 1 } }),
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('location')).toBe(`/api/v1/publish/featured/${DS_0}`)
    const body = await readJson<{ featured: { dataset_id: string; position: number } }>(res)
    expect(body.featured.position).toBe(1)
  })

  it('refuses community publishers with 403', async () => {
    const { env } = setupEnv()
    const res = await featuredPost(
      ctx({ env, method: 'POST', publisher: COMMUNITY, body: { dataset_id: DS_0, position: 1 } }),
    )
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe('forbidden_role')
  })

  it('returns 400 for body shape problems', async () => {
    const { env } = setupEnv()
    const cases = [
      { body: 'not-an-object', expect: 'invalid_body' },
      { body: { dataset_id: DS_0 }, expectField: 'position' },
      { body: { position: 1 }, expectField: 'dataset_id' },
      { body: { dataset_id: DS_0, position: -1 }, expectField: 'position' },
      { body: { dataset_id: DS_0, position: 'one' }, expectField: 'position' },
    ]
    for (const c of cases) {
      const res = await featuredPost(ctx({ env, method: 'POST', body: c.body }))
      expect(res.status).toBe(400)
      if ('expectField' in c) {
        const body = await readJson<{ errors: Array<{ field: string }> }>(res)
        expect(body.errors.some(e => e.field === c.expectField)).toBe(true)
      }
    }
  })

  it('returns 400 invalid_json for unparseable bodies', async () => {
    const { env } = setupEnv()
    const res = await featuredPost(ctx({ env, method: 'POST', bodyText: '{not json' }))
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_json')
  })

  it('returns 404 for unknown dataset_id', async () => {
    const { env } = setupEnv()
    const res = await featuredPost(
      ctx({ env, method: 'POST', body: { dataset_id: 'DS999' + 'A'.repeat(21), position: 1 } }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 already_featured on duplicate add', async () => {
    const { env } = setupEnv()
    await featuredPost(ctx({ env, method: 'POST', body: { dataset_id: DS_0, position: 1 } }))
    const res = await featuredPost(
      ctx({ env, method: 'POST', body: { dataset_id: DS_0, position: 2 } }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('already_featured')
  })
})

describe('PUT /api/v1/publish/featured/{dataset_id}', () => {
  it('updates position for staff', async () => {
    const { env } = setupEnv()
    await featuredPost(ctx({ env, method: 'POST', body: { dataset_id: DS_0, position: 1 } }))
    const res = await featuredPut(
      ctx({
        env,
        method: 'PUT',
        body: { position: 5 },
        url: `https://localhost/api/v1/publish/featured/${DS_0}`,
        params: { dataset_id: DS_0 },
      }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ featured: { position: number } }>(res)
    expect(body.featured.position).toBe(5)
  })

  it('refuses community with 403', async () => {
    const { env } = setupEnv()
    const res = await featuredPut(
      ctx({
        env,
        method: 'PUT',
        publisher: COMMUNITY,
        body: { position: 5 },
        url: `https://localhost/api/v1/publish/featured/${DS_0}`,
        params: { dataset_id: DS_0 },
      }),
    )
    expect(res.status).toBe(403)
  })

  it('returns 404 for non-featured datasets', async () => {
    const { env } = setupEnv()
    const res = await featuredPut(
      ctx({
        env,
        method: 'PUT',
        body: { position: 5 },
        url: `https://localhost/api/v1/publish/featured/${DS_0}`,
        params: { dataset_id: DS_0 },
      }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid position', async () => {
    const { env } = setupEnv()
    await featuredPost(ctx({ env, method: 'POST', body: { dataset_id: DS_0, position: 1 } }))
    const res = await featuredPut(
      ctx({
        env,
        method: 'PUT',
        body: { position: -5 },
        url: `https://localhost/api/v1/publish/featured/${DS_0}`,
        params: { dataset_id: DS_0 },
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/v1/publish/featured/{dataset_id}', () => {
  it('removes when present', async () => {
    const { env } = setupEnv()
    await featuredPost(ctx({ env, method: 'POST', body: { dataset_id: DS_0, position: 1 } }))
    const res = await featuredDelete(
      ctx({
        env,
        method: 'DELETE',
        url: `https://localhost/api/v1/publish/featured/${DS_0}`,
        params: { dataset_id: DS_0 },
      }),
    )
    expect(res.status).toBe(204)
    const list = await featuredGet(ctx({ env }))
    expect((await readJson<{ featured: unknown[] }>(list)).featured).toEqual([])
  })

  it('is idempotent when absent', async () => {
    const { env } = setupEnv()
    const res = await featuredDelete(
      ctx({
        env,
        method: 'DELETE',
        url: `https://localhost/api/v1/publish/featured/${DS_1}`,
        params: { dataset_id: DS_1 },
      }),
    )
    expect(res.status).toBe(204)
  })

  it('refuses community with 403', async () => {
    const { env } = setupEnv()
    const res = await featuredDelete(
      ctx({
        env,
        method: 'DELETE',
        publisher: COMMUNITY,
        url: `https://localhost/api/v1/publish/featured/${DS_0}`,
        params: { dataset_id: DS_0 },
      }),
    )
    expect(res.status).toBe(403)
  })
})
