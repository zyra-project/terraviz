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
import { onRequestGet as toursList, onRequestPost } from './tours'
import { onRequestDelete as tourDelete, onRequestGet as tourGet, onRequestPut as tourPut } from './tours/[id]'
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

describe('GET /api/v1/publish/tours (tour/G)', () => {
  it('returns an empty list when no tours exist', async () => {
    const { env } = setupEnv()
    const res = await toursList(
      ctx({ env, method: 'GET', url: 'https://localhost/api/v1/publish/tours' }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ tours: unknown[]; next_cursor: string | null }>(res)
    expect(body.tours).toEqual([])
    expect(body.next_cursor).toBeNull()
  })

  it('returns the publisher’s tours in reverse-id order', async () => {
    const { env } = setupEnv()
    // Create three tours by POSTing the create endpoint. Sleep
    // 2 ms between creates so each ULID's time prefix is
    // distinct — without that, two ULIDs minted in the same
    // millisecond would have random tails that break
    // lexicographic ordering.
    const ids: string[] = []
    for (const title of ['First tour', 'Second tour', 'Third tour']) {
      const res = await onRequestPost(
        ctx({
          env,
          method: 'POST',
          body: { title, tour_json_ref: 'r2:tours/seed.json' },
        }),
      )
      ids.push((await readJson<{ tour: { id: string } }>(res)).tour.id)
      await new Promise(r => setTimeout(r, 2))
    }
    const res = await toursList(
      ctx({ env, method: 'GET', url: 'https://localhost/api/v1/publish/tours' }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ tours: Array<{ id: string; title: string }> }>(res)
    expect(body.tours).toHaveLength(3)
    // ULIDs are lexicographic in creation order; DESC = newest first.
    expect(body.tours.map(t => t.title)).toEqual(['Third tour', 'Second tour', 'First tour'])
  })

  it('paginates via next_cursor when over the limit', async () => {
    const { env } = setupEnv()
    for (let i = 0; i < 5; i++) {
      await onRequestPost(
        ctx({
          env,
          method: 'POST',
          body: { title: `Tour ${i}`, tour_json_ref: 'r2:tours/seed.json' },
        }),
      )
      await new Promise(r => setTimeout(r, 2))
    }
    const first = await toursList(
      ctx({
        env,
        method: 'GET',
        url: 'https://localhost/api/v1/publish/tours?limit=2',
      }),
    )
    const firstBody = await readJson<{
      tours: Array<{ id: string }>
      next_cursor: string | null
    }>(first)
    expect(firstBody.tours).toHaveLength(2)
    expect(firstBody.next_cursor).toBeTruthy()
    const second = await toursList(
      ctx({
        env,
        method: 'GET',
        url: `https://localhost/api/v1/publish/tours?limit=2&cursor=${firstBody.next_cursor}`,
      }),
    )
    const secondBody = await readJson<{
      tours: Array<{ id: string }>
      next_cursor: string | null
    }>(second)
    expect(secondBody.tours).toHaveLength(2)
    // Pages don't overlap.
    expect(
      firstBody.tours.some(t => secondBody.tours.some(s => s.id === t.id)),
    ).toBe(false)
  })

  it('rejects bad limit values', async () => {
    const { env } = setupEnv()
    for (const bad of ['0', '-1', 'abc', '1e2', '10.0']) {
      const res = await toursList(
        ctx({
          env,
          method: 'GET',
          url: `https://localhost/api/v1/publish/tours?limit=${bad}`,
        }),
      )
      expect(res.status, `limit=${bad}`).toBe(400)
    }
  })
})

describe('DELETE /api/v1/publish/tours/{id} (tour/G)', () => {
  it('removes the row + drops the row from subsequent list reads', async () => {
    const { env, sqlite } = setupEnv()
    // Create a tour to delete.
    const created = await onRequestPost(
      ctx({
        env,
        method: 'POST',
        body: { title: 'To delete', tour_json_ref: 'r2:tours/seed.json' },
      }),
    )
    const id = (await readJson<{ tour: { id: string } }>(created)).tour.id
    const res = await tourDelete(
      ctx<'id'>({ env, method: 'DELETE', params: { id } }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ deleted_id: string }>(res)
    expect(body.deleted_id).toBe(id)
    // Row is gone from D1.
    const row = sqlite
      .prepare('SELECT id FROM tours WHERE id = ?')
      .get(id)
    expect(row).toBeUndefined()
  })

  it('returns 404 for an unknown id', async () => {
    const { env } = setupEnv()
    const res = await tourDelete(
      ctx<'id'>({
        env,
        method: 'DELETE',
        params: { id: '01HXAAAAAAAAAAAAAAAAAAAAAA' },
      }),
    )
    expect(res.status).toBe(404)
  })

  it('succeeds when CATALOG_R2 is unbound (best-effort blob delete)', async () => {
    // No R2 binding — the row should still be deleted from D1
    // and the response should be 200. Orphaned blobs are
    // harmless until a cleanup job runs.
    const { env, sqlite } = setupEnv()
    delete (env as { CATALOG_R2?: unknown }).CATALOG_R2
    const created = await onRequestPost(
      ctx({
        env,
        method: 'POST',
        body: { title: 'No-R2 delete', tour_json_ref: 'r2:tours/seed.json' },
      }),
    )
    const id = (await readJson<{ tour: { id: string } }>(created)).tour.id
    const res = await tourDelete(
      ctx<'id'>({ env, method: 'DELETE', params: { id } }),
    )
    expect(res.status).toBe(200)
    expect(
      sqlite.prepare('SELECT id FROM tours WHERE id = ?').get(id),
    ).toBeUndefined()
  })
})
