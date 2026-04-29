/**
 * Wire-level tests for the publisher dataset endpoints.
 *
 * The middleware is tested separately, and `dataset-mutations.ts`
 * has its own coverage; this file only verifies that the route
 * handlers correctly delegate to those layers, return the right
 * status codes, and expose the right response shapes.
 *
 * To bypass the middleware, tests construct a context with
 * `data.publisher` already populated — that mirrors what the
 * middleware does when forwarding to a downstream handler.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet, onRequestPost } from './datasets'
import {
  onRequestGet as datasetGet,
  onRequestPut as datasetPut,
} from './datasets/[id]'
import { onRequestPost as datasetPublish } from './datasets/[id]/publish'
import { onRequestPost as datasetRetract } from './datasets/[id]/retract'
import { onRequestPost as datasetPreview } from './datasets/[id]/preview'
import { asD1, makeCtx, makeKV, seedFixtures } from '../_lib/test-helpers'
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

function ctxWithPublisher<P extends string = never>(opts: {
  env: Record<string, unknown>
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  params?: Record<string, string>
}) {
  const url = opts.url ?? 'https://localhost/api/v1/publish/datasets'
  const headers = new Headers(opts.headers ?? {})
  if (opts.body !== undefined) headers.set('Content-Type', 'application/json')
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
  }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  const request = new Request(url, init)
  return {
    request,
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

describe('POST /api/v1/publish/datasets', () => {
  it('returns 201 + Location for a valid body', async () => {
    const { env } = setupEnv()
    const res = await onRequestPost(
      ctxWithPublisher({ env, method: 'POST', body: { title: 'Hello world', format: 'video/mp4' } }),
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('location')).toMatch(/^\/api\/v1\/publish\/datasets\//)
    const body = await readJson<{ dataset: { id: string; slug: string } }>(res)
    expect(body.dataset.slug).toBe('hello-world')
  })

  it('returns 400 + structured errors for an invalid body', async () => {
    const { env } = setupEnv()
    const res = await onRequestPost(
      ctxWithPublisher({ env, method: 'POST', body: { title: 'a' } }),
    )
    expect(res.status).toBe(400)
    const body = await readJson<{ errors: Array<{ field: string; code: string }> }>(res)
    expect(body.errors.length).toBeGreaterThan(0)
  })

  it('returns 503 identity_missing when node_identity has not been provisioned', async () => {
    const { env, sqlite } = setupEnv()
    sqlite.prepare('DELETE FROM node_identity').run()
    const res = await onRequestPost(
      ctxWithPublisher({
        env,
        method: 'POST',
        body: { title: 'Hello world', format: 'video/mp4' },
      }),
    )
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('identity_missing')
  })

  it('returns 400 invalid_json on a non-JSON body', async () => {
    const { env } = setupEnv()
    const ctx = ctxWithPublisher({ env, method: 'POST' })
    // Replace request with a non-JSON body.
    const broken = new Request(ctx.request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    Object.defineProperty(ctx, 'request', { value: broken })
    const res = await onRequestPost(ctx)
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_json')
  })
})

describe('GET /api/v1/publish/datasets', () => {
  it('lists datasets with cursor pagination', async () => {
    const { env } = setupEnv()
    for (let i = 0; i < 3; i++) {
      await onRequestPost(
        ctxWithPublisher({
          env,
          method: 'POST',
          body: { title: `Dataset ${i}`, format: 'video/mp4' },
        }),
      )
    }
    const res = await onRequestGet(ctxWithPublisher({ env }))
    expect(res.status).toBe(200)
    const body = await readJson<{
      datasets: Array<{ title: string }>
      next_cursor: string | null
    }>(res)
    expect(body.datasets).toHaveLength(3)
  })

  it('rejects an unknown ?status value', async () => {
    const { env } = setupEnv()
    const res = await onRequestGet(
      ctxWithPublisher({ env, url: 'https://localhost/api/v1/publish/datasets?status=bogus' }),
    )
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_status')
  })
})

describe('GET / PUT /api/v1/publish/datasets/{id}', () => {
  async function seedOne() {
    const { env, sqlite } = setupEnv()
    const created = await onRequestPost(
      ctxWithPublisher({ env, method: 'POST', body: { title: 'Original', format: 'video/mp4' } }),
    )
    const body = await readJson<{ dataset: { id: string } }>(created)
    return { env, sqlite, id: body.dataset.id }
  }

  it('GET returns the row', async () => {
    const { env, id } = await seedOne()
    const res = await datasetGet(ctxWithPublisher<'id'>({ env, params: { id } }))
    expect(res.status).toBe(200)
    const body = await readJson<{ dataset: { id: string; title: string } }>(res)
    expect(body.dataset.id).toBe(id)
  })

  it('GET 404 for an unknown id', async () => {
    const { env } = await seedOne()
    const res = await datasetGet(ctxWithPublisher<'id'>({ env, params: { id: 'NOPE' } }))
    expect(res.status).toBe(404)
  })

  it('PUT patches the row', async () => {
    const { env, id } = await seedOne()
    const res = await datasetPut(
      ctxWithPublisher<'id'>({ env, method: 'PUT', body: { title: 'Renamed' }, params: { id } }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ dataset: { title: string } }>(res)
    expect(body.dataset.title).toBe('Renamed')
  })
})

describe('POST /api/v1/publish/datasets/{id}/publish', () => {
  async function seedReady() {
    const { env, sqlite } = setupEnv()
    const created = await onRequestPost(
      ctxWithPublisher({
        env,
        method: 'POST',
        body: {
          title: 'Ready to publish',
          format: 'video/mp4',
          data_ref: 'vimeo:1',
          license_spdx: 'CC-BY-4.0',
        },
      }),
    )
    const body = await readJson<{ dataset: { id: string } }>(created)
    return { env, sqlite, id: body.dataset.id }
  }

  it('flips a draft to published', async () => {
    const { env, id } = await seedReady()
    const res = await datasetPublish(
      ctxWithPublisher<'id'>({ env, method: 'POST', params: { id } }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ dataset: { published_at: string | null } }>(res)
    expect(body.dataset.published_at).not.toBeNull()
  })

  it('returns 400 with errors when the row is incomplete', async () => {
    const { env } = setupEnv()
    const created = await onRequestPost(
      ctxWithPublisher({
        env,
        method: 'POST',
        body: { title: 'Incomplete', format: 'video/mp4' },
      }),
    )
    const id = (await readJson<{ dataset: { id: string } }>(created)).dataset.id
    const res = await datasetPublish(
      ctxWithPublisher<'id'>({ env, method: 'POST', params: { id } }),
    )
    expect(res.status).toBe(400)
    const body = await readJson<{ errors: Array<{ field: string }> }>(res)
    expect(body.errors.length).toBeGreaterThan(0)
  })
})

describe('POST /api/v1/publish/datasets/{id}/retract', () => {
  it('stamps retracted_at', async () => {
    const { env } = setupEnv()
    const created = await onRequestPost(
      ctxWithPublisher({
        env,
        method: 'POST',
        body: { title: 'Will go away', format: 'video/mp4' },
      }),
    )
    const id = (await readJson<{ dataset: { id: string } }>(created)).dataset.id
    const res = await datasetRetract(
      ctxWithPublisher<'id'>({ env, method: 'POST', params: { id } }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ dataset: { retracted_at: string | null } }>(res)
    expect(body.dataset.retracted_at).not.toBeNull()
  })
})

describe('POST /api/v1/publish/datasets/{id}/preview', () => {
  it('returns a token + consumer URL', async () => {
    const { env } = setupEnv()
    const created = await onRequestPost(
      ctxWithPublisher({
        env,
        method: 'POST',
        body: { title: 'Preview me', format: 'video/mp4' },
      }),
    )
    const id = (await readJson<{ dataset: { id: string } }>(created)).dataset.id
    const res = await datasetPreview(
      ctxWithPublisher<'id'>({ env, method: 'POST', params: { id }, body: {} }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ token: string; url: string; expires_in: number }>(res)
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(body.url).toBe(`/api/v1/datasets/${id}/preview/${body.token}`)
    expect(body.expires_in).toBe(15 * 60)
  })

  it('rejects an out-of-range ttl_seconds', async () => {
    const { env } = setupEnv()
    const created = await onRequestPost(
      ctxWithPublisher({
        env,
        method: 'POST',
        body: { title: 'Preview me', format: 'video/mp4' },
      }),
    )
    const id = (await readJson<{ dataset: { id: string } }>(created)).dataset.id
    const res = await datasetPreview(
      ctxWithPublisher<'id'>({
        env,
        method: 'POST',
        params: { id },
        body: { ttl_seconds: 9_999_999 },
      }),
    )
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_ttl')
  })
})
