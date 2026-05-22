/**
 * Wire-level tests for POST /api/v1/publish/tours/draft.
 * Phase 3pt/E — the new draft-creation endpoint the publisher
 * portal's "New tour" button calls. Should mint a tour row +
 * write an empty TourFile blob to R2 in one shot.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost } from './draft'
import { asD1, makeKV, seedFixtures } from '../../_lib/test-helpers'
import type { PublisherRow } from '../../_lib/publisher-store'

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

function ctx(opts: { env: Record<string, unknown>; body?: unknown }) {
  const url = 'https://localhost/api/v1/publish/tours/draft'
  const headers = new Headers()
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json')
  const init: RequestInit = { method: 'POST', headers }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    request: new Request(url, init),
    env: opts.env,
    params: {} as Record<string, never>,
    data: { publisher: STAFF },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<PagesFunction>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('POST /api/v1/publish/tours/draft (tour/E)', () => {
  it('mints a row + seeds an empty TourFile in R2', async () => {
    const { env, bucket, sqlite } = setupEnv()
    const res = await onRequestPost(ctx({ env }))
    expect(res.status).toBe(201)
    const body = await readJson<{ tour: { id: string; tour_json_ref: string; title: string } }>(
      res,
    )
    expect(body.tour.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(body.tour.tour_json_ref).toBe(`r2:tours/${body.tour.id}/draft.json`)
    // Auto-derived title.
    expect(body.tour.title).toMatch(/Untitled tour /)
    // R2 blob seeded with the empty TourFile shape.
    const blob = bucket.puts.get(`tours/${body.tour.id}/draft.json`)
    expect(blob).toBeTruthy()
    expect(JSON.parse(blob!)).toEqual({ tourTasks: [] })
    // Row exists in D1.
    const row = sqlite
      .prepare('SELECT id, slug, tour_json_ref FROM tours WHERE id = ?')
      .get(body.tour.id) as { id: string; slug: string; tour_json_ref: string }
    expect(row.tour_json_ref).toBe(`r2:tours/${body.tour.id}/draft.json`)
  })

  it('honours a title override from the body', async () => {
    const { env } = setupEnv()
    const res = await onRequestPost(ctx({ env, body: { title: 'Hurricane Tour' } }))
    expect(res.status).toBe(201)
    const body = await readJson<{ tour: { title: string; slug: string } }>(res)
    expect(body.tour.title).toBe('Hurricane Tour')
    expect(body.tour.slug).toBe('hurricane-tour')
  })

  it('returns 400 with validation errors when the title override is too short', async () => {
    // Phase 3pt-review/H — pre-fix the draft endpoint accepted
    // any caller-supplied title, even strings the rename PUT
    // (validateTitle) would refuse later. Now mirrored so the
    // draft row can never be created in a state the renames
    // can't recover. Copilot discussion_r3291171383.
    const { env } = setupEnv()
    const res = await onRequestPost(ctx({ env, body: { title: 'ab' } }))
    expect(res.status).toBe(400)
    const body = await readJson<{ errors: Array<{ field: string; code: string }> }>(res)
    expect(body.errors[0]?.field).toBe('title')
    expect(body.errors[0]?.code).toBe('too_short')
  })

  it('returns 400 on malformed JSON body', async () => {
    const { env } = setupEnv()
    const ctxObj = ctx({ env })
    // Override the body with raw non-JSON text.
    const headers = new Headers({ 'Content-Type': 'application/json' })
    ;(ctxObj as { request: Request }).request = new Request(
      'https://localhost/api/v1/publish/tours/draft',
      { method: 'POST', headers, body: '{not json' },
    )
    const res = await onRequestPost(ctxObj)
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_json')
  })

  it('still works when CATALOG_R2 is unbound (skips the seed write)', async () => {
    // Local-dev path: no R2 binding configured. The autosave PUT
    // will create the object on first save, so dropping the seed
    // is acceptable rather than failing the create.
    const { env, bucket } = setupEnv()
    delete (env as { CATALOG_R2?: unknown }).CATALOG_R2
    const res = await onRequestPost(ctx({ env }))
    expect(res.status).toBe(201)
    // No write happened (bucket isn't even bound, so nothing
    // landed in `puts`).
    expect(bucket.puts.size).toBe(0)
  })
})
