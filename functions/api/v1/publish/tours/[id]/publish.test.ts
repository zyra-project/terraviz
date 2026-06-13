/**
 * Wire-level tests for POST /api/v1/publish/tours/{id}/publish.
 * Phase 3pt/G — the publish endpoint snapshots the draft JSON
 * to an immutable `tours/{id}/published/{publish_id}.json`
 * blob, flips the row's `tour_json_ref`, and stamps
 * `published_at`.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost } from './publish'
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
  const url = `https://localhost${opts.path ?? `/api/v1/publish/tours/${opts.params.id}/publish`}`
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

describe('POST /api/v1/publish/tours/{id}/publish (tour/G)', () => {
  it('snapshots the draft, flips tour_json_ref, stamps published_at', async () => {
    const { env, bucket, sqlite } = setupEnv()
    const id = await createDraftAndId(env)
    // Put a non-trivial tour file in the draft so we can verify
    // the published blob matches.
    const tourFile = { tourTasks: [{ pauseSeconds: 5 }, { loopToBeginning: '' }] }
    await putJson(
      makeCtx<'id'>({ env, method: 'PUT', params: { id }, body: tourFile }),
    )
    const res = await onRequestPost(
      makeCtx<'id'>({ env, method: 'POST', params: { id } }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{
      tour: { id: string; tour_json_ref: string; published_at: string | null }
      publish_id: string
    }>(res)
    expect(body.publish_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(body.tour.tour_json_ref).toBe(
      `r2:tours/${id}/published/${body.publish_id}.json`,
    )
    expect(body.tour.published_at).toBeTruthy()
    // The published blob matches the draft content.
    const publishedKey = `tours/${id}/published/${body.publish_id}.json`
    expect(JSON.parse(bucket.puts.get(publishedKey)!)).toEqual(tourFile)
    // Draft is still there — the publisher can keep editing.
    expect(bucket.puts.has(`tours/${id}/draft.json`)).toBe(true)
    // DB reflects the new state.
    const row = sqlite
      .prepare('SELECT tour_json_ref, published_at FROM tours WHERE id = ?')
      .get(id) as { tour_json_ref: string; published_at: string | null }
    expect(row.tour_json_ref).toBe(`r2:tours/${id}/published/${body.publish_id}.json`)
    expect(row.published_at).toBeTruthy()
  })

  it('republishing creates a new immutable snapshot with a fresh publish_id', async () => {
    const { env, bucket } = setupEnv()
    const id = await createDraftAndId(env)
    await putJson(
      makeCtx<'id'>({
        env,
        method: 'PUT',
        params: { id },
        body: { tourTasks: [{ pauseSeconds: 1 }] },
      }),
    )
    const first = await readJson<{ publish_id: string }>(
      await onRequestPost(makeCtx<'id'>({ env, method: 'POST', params: { id } })),
    )
    // Edit the draft and republish.
    await putJson(
      makeCtx<'id'>({
        env,
        method: 'PUT',
        params: { id },
        body: { tourTasks: [{ pauseSeconds: 2 }] },
      }),
    )
    const second = await readJson<{ publish_id: string }>(
      await onRequestPost(makeCtx<'id'>({ env, method: 'POST', params: { id } })),
    )
    expect(second.publish_id).not.toBe(first.publish_id)
    // Both published blobs still exist (immutable; federation
    // subscribers may have cached the prior ref).
    expect(bucket.puts.has(`tours/${id}/published/${first.publish_id}.json`)).toBe(true)
    expect(bucket.puts.has(`tours/${id}/published/${second.publish_id}.json`)).toBe(true)
  })

  it('returns 404 for an unknown tour id', async () => {
    const { env } = setupEnv()
    const res = await onRequestPost(
      makeCtx<'id'>({
        env,
        method: 'POST',
        params: { id: '01HXAAAAAAAAAAAAAAAAAAAAAA' },
      }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 503 draft_missing when the draft blob has been hand-deleted', async () => {
    const { env, bucket } = setupEnv()
    const id = await createDraftAndId(env)
    bucket.puts.delete(`tours/${id}/draft.json`)
    const res = await onRequestPost(
      makeCtx<'id'>({ env, method: 'POST', params: { id } }),
    )
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('draft_missing')
  })
})
