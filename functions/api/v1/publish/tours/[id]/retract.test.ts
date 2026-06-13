/**
 * Wire-level tests for POST /api/v1/publish/tours/{id}/retract.
 * Phase 3pt/G follow-up — retract a published tour without
 * deleting it, so it disappears from the public list but the
 * immutable R2 snapshot stays put for federation peers.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost as retract } from './retract'
import { onRequestPost as publish } from './publish'
import { onRequestPost as createDraft } from '../draft'
import { onRequestPut as putJson } from './json'
import { asD1, makeKV, seedFixtures } from '../../../_lib/test-helpers'
import type { PublisherRow } from '../../../_lib/publisher-store'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
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
      ADMIN.id,
      ADMIN.email,
      ADMIN.display_name,
      ADMIN.role,
      ADMIN.is_admin,
      ADMIN.status,
      ADMIN.created_at,
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
  method: 'POST' | 'PUT'
  params: Record<string, string>
  body?: unknown
  path?: string
}) {
  const url = `https://localhost${opts.path ?? `/api/v1/publish/tours/${opts.params.id}/retract`}`
  const headers = new Headers()
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json')
  const init: RequestInit = { method: opts.method, headers }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    request: new Request(url, init),
    env: opts.env,
    params: opts.params as { [K in P]: string | string[] },
    data: { publisher: ADMIN },
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
    data: { publisher: ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/tours/draft',
  } as unknown as Parameters<PagesFunction>[0])
  const body = await readJson<{ tour: { id: string } }>(draftRes)
  return body.tour.id
}

async function publishOne(env: Record<string, unknown>, id: string): Promise<void> {
  await putJson(
    makeCtx<'id'>({
      env,
      method: 'PUT',
      params: { id },
      body: { tourTasks: [{ pauseSeconds: 1 }] },
    }),
  )
  await publish(makeCtx<'id'>({ env, method: 'POST', params: { id } }))
}

describe('POST /api/v1/publish/tours/{id}/retract', () => {
  it('stamps retracted_at on a published tour and leaves the R2 snapshot alone', async () => {
    const { env, bucket, sqlite } = setupEnv()
    const id = await createDraftAndId(env)
    await publishOne(env, id)
    const beforeKeys = [...bucket.puts.keys()]
    const res = await retract(makeCtx<'id'>({ env, method: 'POST', params: { id } }))
    expect(res.status).toBe(200)
    const body = await readJson<{
      tour: { id: string; retracted_at: string | null; published_at: string | null }
    }>(res)
    expect(body.tour.retracted_at).toBeTruthy()
    expect(body.tour.published_at).toBeTruthy()
    // Snapshot unchanged — retract does not purge R2.
    expect([...bucket.puts.keys()].sort()).toEqual(beforeKeys.sort())
    // DB reflects the new state.
    const row = sqlite
      .prepare('SELECT retracted_at, published_at FROM tours WHERE id = ?')
      .get(id) as { retracted_at: string | null; published_at: string | null }
    expect(row.retracted_at).toBeTruthy()
    expect(row.published_at).toBeTruthy()
  })

  it('returns 404 for an unknown tour id', async () => {
    const { env } = setupEnv()
    const res = await retract(
      makeCtx<'id'>({
        env,
        method: 'POST',
        params: { id: '01HXAAAAAAAAAAAAAAAAAAAAAA' },
      }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 not_published when the row was never published', async () => {
    const { env } = setupEnv()
    const id = await createDraftAndId(env)
    const res = await retract(makeCtx<'id'>({ env, method: 'POST', params: { id } }))
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('not_published')
  })

  it('returns 409 already_retracted on a second retract', async () => {
    const { env } = setupEnv()
    const id = await createDraftAndId(env)
    await publishOne(env, id)
    await retract(makeCtx<'id'>({ env, method: 'POST', params: { id } }))
    const res = await retract(makeCtx<'id'>({ env, method: 'POST', params: { id } }))
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('already_retracted')
  })

  it('republishing a retracted tour clears retracted_at and lifts it back', async () => {
    const { env, sqlite } = setupEnv()
    const id = await createDraftAndId(env)
    await publishOne(env, id)
    await retract(makeCtx<'id'>({ env, method: 'POST', params: { id } }))
    // Republish.
    await publish(makeCtx<'id'>({ env, method: 'POST', params: { id } }))
    const row = sqlite
      .prepare('SELECT retracted_at, published_at FROM tours WHERE id = ?')
      .get(id) as { retracted_at: string | null; published_at: string | null }
    expect(row.retracted_at).toBeNull()
    expect(row.published_at).toBeTruthy()
  })
})
