/**
 * Wire-level tests for the tour publisher endpoints.
 *
 * Mirrors `datasets.test.ts` shape: handlers tested directly with
 * a context that bypasses the middleware by populating
 * `data.publisher`. Lib-layer rules are tested in
 * `tour-mutations.test.ts`-style coverage via these handlers,
 * since the lib layer is comparatively small.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost } from './tours'
import { onRequestGet as tourGet, onRequestPut as tourPut } from './tours/[id]'
import { onRequestPost as tourPreview } from './tours/[id]/preview'
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

function ctx<P extends string = never>(opts: {
  env: Record<string, unknown>
  url?: string
  method?: string
  body?: unknown
  params?: Record<string, string>
}) {
  const url = opts.url ?? 'https://localhost/api/v1/publish/tours'
  const headers = new Headers()
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json')
  const init: RequestInit = { method: opts.method ?? 'GET', headers }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    request: new Request(url, init),
    env: opts.env,
    params: (opts.params ?? {}) as { [K in P]: string | string[] },
    data: { publisher: STAFF },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<PagesFunction<Record<string, unknown>, P>>[0]
}

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(STAFF.id, STAFF.email, STAFF.display_name, STAFF.role, STAFF.is_admin, STAFF.status, STAFF.created_at)
  return {
    sqlite,
    env: {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      PREVIEW_SIGNING_KEY: 'test-preview-secret',
    },
  }
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('publish/tours', () => {
  it('POST creates a tour with a derived slug', async () => {
    const { env } = setupEnv()
    const res = await onRequestPost(
      ctx({
        env,
        method: 'POST',
        body: { title: 'My Sample Tour', tour_json_ref: 'r2:tours/sample.json' },
      }),
    )
    expect(res.status).toBe(201)
    const body = await readJson<{ tour: { id: string; slug: string } }>(res)
    expect(body.tour.slug).toBe('my-sample-tour')
    expect(res.headers.get('location')).toBe(`/api/v1/publish/tours/${body.tour.id}`)
  })

  it('POST 503 identity_missing when node_identity has not been provisioned', async () => {
    const { env, sqlite } = setupEnv()
    sqlite.prepare('DELETE FROM node_identity').run()
    const res = await onRequestPost(
      ctx({
        env,
        method: 'POST',
        body: { title: 'My Tour', tour_json_ref: 'r2:tours/x.json' },
      }),
    )
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('identity_missing')
  })

  it('POST 400 when tour_json_ref is missing', async () => {
    const { env } = setupEnv()
    const res = await onRequestPost(
      ctx({ env, method: 'POST', body: { title: 'Lonely tour' } }),
    )
    expect(res.status).toBe(400)
    const body = await readJson<{ errors: Array<{ field: string }> }>(res)
    expect(body.errors.some(e => e.field === 'tour_json_ref')).toBe(true)
  })

  it('GET / PUT round-trip', async () => {
    const { env } = setupEnv()
    const created = await onRequestPost(
      ctx({
        env,
        method: 'POST',
        body: { title: 'Round trip', tour_json_ref: 'r2:tours/x.json' },
      }),
    )
    const id = (await readJson<{ tour: { id: string } }>(created)).tour.id
    const got = await tourGet(ctx<'id'>({ env, params: { id } }))
    expect(got.status).toBe(200)
    const put = await tourPut(
      ctx<'id'>({ env, method: 'PUT', body: { title: 'Renamed' }, params: { id } }),
    )
    expect(put.status).toBe(200)
    const body = await readJson<{ tour: { title: string } }>(put)
    expect(body.tour.title).toBe('Renamed')
  })

  it('preview mints a token + URL', async () => {
    const { env } = setupEnv()
    const created = await onRequestPost(
      ctx({
        env,
        method: 'POST',
        body: { title: 'Preview tour', tour_json_ref: 'r2:tours/p.json' },
      }),
    )
    const id = (await readJson<{ tour: { id: string } }>(created)).tour.id
    const res = await tourPreview(
      ctx<'id'>({ env, method: 'POST', params: { id }, body: {} }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ token: string; url: string }>(res)
    expect(body.url).toBe(`/api/v1/tours/${id}/preview/${body.token}`)
  })
})
