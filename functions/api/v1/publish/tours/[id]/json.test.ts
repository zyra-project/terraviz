/**
 * Wire-level tests for /api/v1/publish/tours/{id}/json.
 * Phase 3pt/E — the autosave + reopen endpoints.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet, onRequestPut } from './json'
import { onRequestPost as createDraft } from '../draft'
import { asD1, makeKV, seedFixtures } from '../../../_lib/test-helpers'
import type { PublisherRow } from '../../../_lib/publisher-store'

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

interface BucketState {
  puts: Map<string, string>
}

function makeBucket(state: BucketState): R2Bucket {
  return {
    put: async (key: string, body: ReadableStream | string | ArrayBuffer | null) => {
      const text =
        typeof body === 'string'
          ? body
          : body instanceof ArrayBuffer
            ? new TextDecoder().decode(body)
            : ''
      state.puts.set(key, text)
      return {} as unknown as R2Object
    },
    get: async (key: string) => {
      const text = state.puts.get(key)
      if (text == null) return null
      return { text: async () => text } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
}

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      STAFF.id,
      STAFF.email,
      STAFF.display_name,
      STAFF.role,
      STAFF.is_admin,
      STAFF.status,
      STAFF.created_at,
    )
  const bucket: BucketState = { puts: new Map() }
  return {
    sqlite,
    bucket,
    env: {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(bucket),
    },
  }
}

function makeCtx<P extends string>(opts: {
  env: Record<string, unknown>
  method: 'GET' | 'PUT'
  params: Record<string, string>
  body?: unknown
}) {
  const url = `https://localhost/api/v1/publish/tours/${opts.params.id}/json`
  const headers = new Headers()
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json')
  const init: RequestInit = { method: opts.method, headers }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    request: new Request(url, init),
    env: opts.env,
    params: opts.params as { [K in P]: string | string[] },
    data: { publisher: STAFF },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<PagesFunction<Record<string, unknown>, P>>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

async function createDraftAndId(env: Record<string, unknown>): Promise<string> {
  const draftRes = await createDraft({
    request: new Request('https://localhost/api/v1/publish/tours/draft', {
      method: 'POST',
    }),
    env,
    params: {},
    data: { publisher: STAFF },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/tours/draft',
  } as unknown as Parameters<PagesFunction>[0])
  const body = await readJson<{ tour: { id: string } }>(draftRes)
  return body.tour.id
}

describe('PUT /api/v1/publish/tours/{id}/json (tour/E)', () => {
  it('overwrites the draft blob + bumps updated_at', async () => {
    const { env, bucket, sqlite } = setupEnv()
    const id = await createDraftAndId(env)
    const before = sqlite
      .prepare('SELECT updated_at FROM tours WHERE id = ?')
      .get(id) as { updated_at: string }
    // Sleep a tick so updated_at can change.
    await new Promise(r => setTimeout(r, 10))
    const tourFile = { tourTasks: [{ flyTo: { lat: 29, lon: -89, altmi: 1000, animated: true } }] }
    const res = await onRequestPut(
      makeCtx<'id'>({ env, method: 'PUT', params: { id }, body: tourFile }),
    )
    expect(res.status).toBe(200)
    expect(bucket.puts.get(`tours/${id}/draft.json`)).toBe(JSON.stringify(tourFile))
    const after = sqlite
      .prepare('SELECT updated_at FROM tours WHERE id = ?')
      .get(id) as { updated_at: string }
    expect(after.updated_at).not.toBe(before.updated_at)
  })

  it('rejects a body without tourTasks array as 400 invalid_tour_file', async () => {
    const { env } = setupEnv()
    const id = await createDraftAndId(env)
    const res = await onRequestPut(
      makeCtx<'id'>({ env, method: 'PUT', params: { id }, body: { wrong: 'shape' } }),
    )
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_tour_file')
  })

  it('rejects malformed JSON as 400 invalid_json', async () => {
    const { env } = setupEnv()
    const id = await createDraftAndId(env)
    const ctxObj = makeCtx<'id'>({ env, method: 'PUT', params: { id } })
    ;(ctxObj as { request: Request }).request = new Request(
      `https://localhost/api/v1/publish/tours/${id}/json`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{not json' },
    )
    const res = await onRequestPut(ctxObj)
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_json')
  })

  it('returns 404 for an unknown tour id', async () => {
    const { env } = setupEnv()
    const res = await onRequestPut(
      makeCtx<'id'>({
        env,
        method: 'PUT',
        params: { id: '01HXAAAAAAAAAAAAAAAAAAAAAA' },
        body: { tourTasks: [] },
      }),
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/publish/tours/{id}/json (tour/E)', () => {
  it('returns the persisted tour file', async () => {
    const { env } = setupEnv()
    const id = await createDraftAndId(env)
    const tourFile = { tourTasks: [{ pauseSeconds: 5 }] }
    await onRequestPut(makeCtx<'id'>({ env, method: 'PUT', params: { id }, body: tourFile }))
    const res = await onRequestGet(makeCtx<'id'>({ env, method: 'GET', params: { id } }))
    expect(res.status).toBe(200)
    const body = await readJson<{ tourFile: unknown; tour: { id: string } }>(res)
    expect(body.tour.id).toBe(id)
    expect(body.tourFile).toEqual(tourFile)
  })

  it('returns an empty TourFile for a fresh draft (cold start)', async () => {
    // Edge case: row exists but no blob written yet (e.g. an
    // earlier deploy without the R2 binding seeded the row but
    // skipped the blob write). The GET should degrade to an
    // empty tour rather than 5xx so the dock can come up.
    const { env, bucket } = setupEnv()
    const id = await createDraftAndId(env)
    bucket.puts.delete(`tours/${id}/draft.json`)
    const res = await onRequestGet(makeCtx<'id'>({ env, method: 'GET', params: { id } }))
    expect(res.status).toBe(200)
    const body = await readJson<{ tourFile: unknown }>(res)
    expect(body.tourFile).toEqual({ tourTasks: [] })
  })

  it('returns 404 for an unknown tour id', async () => {
    const { env } = setupEnv()
    const res = await onRequestGet(
      makeCtx<'id'>({
        env,
        method: 'GET',
        params: { id: '01HXAAAAAAAAAAAAAAAAAAAAAA' },
      }),
    )
    expect(res.status).toBe(404)
  })
})
