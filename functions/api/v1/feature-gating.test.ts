// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The off-behavior matrix for per-node feature toggles — one place
 * that pins down what every gated surface serves while its feature
 * is disabled (`src/types/node-features.ts`):
 *
 *   - Public reads answer soft-empty 200s (`no-store`) so the SPA
 *     degrades without error banners — and the gate runs BEFORE each
 *     handler's KV cache read, so a still-warm cached body is never
 *     served while the feature is off.
 *   - `GET /api/v1/blog/:slug` is the one page-like exception: 404,
 *     indistinguishable from an unknown slug.
 *   - Cross-feature couplings: a blog post drops its event citation /
 *     companion-tour reference when those features are off; blog
 *     generation rejects an eventId / includeTour selection with
 *     field errors; the event→tour generator needs `tours`.
 *   - The cron-invoked refresh / due handlers no-op with a 200 so
 *     their GitHub Actions stay green.
 *   - The public feedback writes soft-accept and drop.
 *
 * Per-handler happy paths live in each handler's own test file; this
 * file only covers the toggle-off behaviors.
 */

import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { asD1, makeCtx, makeKV, seedFixtures } from './_lib/test-helpers'
import { defaultFeatures, type FeatureMap } from '../../../src/types/node-features'
import { onRequestGet as getEvents } from './events'
import { onRequestGet as getDatasetEvents } from './datasets/[id]/events'
import { onRequestGet as getFeaturedEvent } from './featured-event'
import { onRequestGet as getFeaturedHero } from './featured-hero'
import { onRequestGet as getBlogList } from './blog'
import { onRequestGet as getBlogPost } from './blog/[slug]'
import { onRequestGet as getTours } from './tours'
import { onRequestPost as postRefresh } from './publish/events/refresh'
import { onRequestGet as getDue } from './publish/workflows/due'
import { onRequestPost as postBlogGenerate } from './publish/blog/generate'
import { onRequestPost as postEventTour } from './publish/events/[id]/tour'
import { onRequestPost as postFeedback } from '../feedback'
import { onRequestPost as postGeneralFeedback } from '../general-feedback'
import { EVENTS_LIST_CACHE_KEY, FEATURED_EVENT_CACHE_KEY } from './_lib/events-store'
import { BLOG_LIST_CACHE_KEY } from './_lib/blog-store'
import { HERO_CACHE_KEY } from './_lib/hero-override-store'
import type { PublisherRow } from './_lib/publisher-store'

const TS = '2026-07-01T00:00:00.000Z'
const DS0 = 'DS000' + 'A'.repeat(21)

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: TS,
}

function setup(off: Partial<FeatureMap>) {
  const sqlite = seedFixtures({ count: 1 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, TS)
  sqlite
    .prepare(
      `INSERT INTO node_settings (id, features_json, updated_by, updated_at)
       VALUES (1, ?, ?, ?)`,
    )
    .run(JSON.stringify({ ...defaultFeatures(), ...off }), ADMIN.id, TS)
  const kv = makeKV()
  const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv, MOCK_R2: 'true' }
  return { sqlite, kv, env }
}

function insertApprovedEvent(sqlite: Database.Database, id = 'EV1'): void {
  sqlite
    .prepare(
      `INSERT INTO current_events
         (id, origin_node, title, source_name, source_url, status, created_at, updated_at)
       VALUES (?, 'NODE000', 'Big Storm', 'NOAA', 'https://noaa.example/storm', 'approved', ?, ?)`,
    )
    .run(id, TS, TS)
}

function insertPublishedPost(sqlite: Database.Database, opts: { eventId?: string } = {}): void {
  sqlite
    .prepare(
      `INSERT INTO blog_posts
         (id, slug, title, body_md, dataset_ids, event_id, author_id, status,
          created_at, updated_at, published_at)
       VALUES ('BP1', 'storm-post', 'Storm Post', 'Body.', ?, ?, ?, 'published', ?, ?, ?)`,
    )
    .run(JSON.stringify([DS0]), opts.eventId ?? null, ADMIN.id, TS, TS, TS)
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

function publishCtx(opts: {
  env: Record<string, unknown>
  url: string
  method?: string
  params?: Record<string, string>
  body?: unknown
}) {
  const init: RequestInit = { method: opts.method ?? 'POST', headers: new Headers() }
  if (opts.body !== undefined) {
    ;(init.headers as Headers).set('Content-Type', 'application/json')
    init.body = JSON.stringify(opts.body)
  }
  return {
    request: new Request(opts.url, init),
    env: opts.env,
    params: opts.params ?? {},
    data: { publisher: ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(opts.url).pathname,
  }
}

describe('public reads while their feature is off', () => {
  it('GET /api/v1/events → { events: [] }, no-store, ignoring a warm cache', async () => {
    const { env, kv } = setup({ events: false })
    kv._store.set(EVENTS_LIST_CACHE_KEY, JSON.stringify({ events: [{ id: 'cached' }] }))
    const res = await getEvents(makeCtx({ env, url: 'https://test.local/api/v1/events' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await readJson<{ events: unknown[] }>(res)).events).toEqual([])
  })

  it('GET /api/v1/datasets/:id/events → { events: [] }, no-store', async () => {
    const { env } = setup({ events: false })
    const res = await getDatasetEvents(
      makeCtx<'id'>({ env, url: `https://test.local/api/v1/datasets/${DS0}/events`, params: { id: DS0 } }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await readJson<{ events: unknown[] }>(res)).events).toEqual([])
  })

  it('GET /api/v1/featured-event → { event: null }, ignoring a warm cache', async () => {
    const { env, kv } = setup({ events: false })
    kv._store.set(FEATURED_EVENT_CACHE_KEY, JSON.stringify({ event: { id: 'cached' } }))
    const res = await getFeaturedEvent(makeCtx({ env, url: 'https://test.local/api/v1/featured-event' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await readJson<{ event: unknown }>(res)).event).toBeNull()
  })

  it('GET /api/v1/featured-hero → { hero: null }, ignoring a warm cache', async () => {
    const { env, kv } = setup({ hero: false })
    kv._store.set(HERO_CACHE_KEY, JSON.stringify({ hero: { datasetId: 'cached' } }))
    const res = await getFeaturedHero(makeCtx({ env, url: 'https://test.local/api/v1/featured-hero' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await readJson<{ hero: unknown }>(res)).hero).toBeNull()
  })

  it('GET /api/v1/blog → { posts: [] }, ignoring a warm cache', async () => {
    const { env, kv, sqlite } = setup({ blog: false })
    insertPublishedPost(sqlite)
    kv._store.set(BLOG_LIST_CACHE_KEY, JSON.stringify({ posts: [{ slug: 'cached' }] }))
    const res = await getBlogList(makeCtx({ env, url: 'https://test.local/api/v1/blog' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await readJson<{ posts: unknown[] }>(res)).posts).toEqual([])
  })

  it('GET /api/v1/blog/:slug → 404, indistinguishable from an unknown slug', async () => {
    const { env, sqlite } = setup({ blog: false })
    insertPublishedPost(sqlite)
    const res = await getBlogPost(
      makeCtx<'slug'>({ env, url: 'https://test.local/api/v1/blog/storm-post', params: { slug: 'storm-post' } }),
    )
    expect(res.status).toBe(404)
    expect((await readJson<{ error: string }>(res)).error).toBe('not_found')
  })

  it('GET /api/v1/tours → empty page, no-store', async () => {
    const { env } = setup({ tours: false })
    const res = await getTours(makeCtx({ env, url: 'https://test.local/api/v1/tours' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await readJson<{ tours: unknown[]; next_cursor: unknown }>(res)
    expect(body.tours).toEqual([])
    expect(body.next_cursor).toBeNull()
  })
})

describe('cross-feature couplings', () => {
  it('a published post drops its event citation while events is off', async () => {
    const { env, sqlite } = setup({ events: false })
    insertApprovedEvent(sqlite)
    insertPublishedPost(sqlite, { eventId: 'EV1' })
    const res = await getBlogPost(
      makeCtx<'slug'>({ env, url: 'https://test.local/api/v1/blog/storm-post', params: { slug: 'storm-post' } }),
    )
    expect(res.status).toBe(200)
    const { post } = await readJson<{ post: { title: string; event: unknown; datasets: unknown[] } }>(res)
    expect(post.title).toBe('Storm Post')
    expect(post.event).toBeNull()
    expect(post.datasets).toHaveLength(1)
  })

  it('the same post keeps its citation while events is on', async () => {
    const { env, sqlite } = setup({})
    insertApprovedEvent(sqlite)
    insertPublishedPost(sqlite, { eventId: 'EV1' })
    const res = await getBlogPost(
      makeCtx<'slug'>({ env, url: 'https://test.local/api/v1/blog/storm-post', params: { slug: 'storm-post' } }),
    )
    const { post } = await readJson<{ post: { event: { id: string } | null } }>(res)
    expect(post.event?.id).toBe('EV1')
  })

  it('blog generate rejects an eventId while events is off, includeTour while tours is off', async () => {
    const { env } = setup({ events: false, tours: false })
    const res = await postBlogGenerate(
      publishCtx({
        env,
        url: 'https://localhost/api/v1/publish/blog/generate',
        body: { datasetIds: [DS0], eventId: 'EV1', includeTour: true },
      }) as unknown as Parameters<typeof postBlogGenerate>[0],
    )
    expect(res.status).toBe(400)
    const { errors } = await readJson<{ errors: Array<{ field: string; code: string }> }>(res)
    expect(errors.map(e => e.field)).toEqual(expect.arrayContaining(['eventId', 'includeTour']))
    expect(errors.every(e => e.code === 'feature_disabled')).toBe(true)
  })

  it('event→tour generation needs the tours feature', async () => {
    const { env, sqlite } = setup({ tours: false })
    insertApprovedEvent(sqlite)
    const res = await postEventTour(
      publishCtx({
        env,
        url: 'https://localhost/api/v1/publish/events/EV1/tour',
        params: { id: 'EV1' },
      }) as unknown as Parameters<typeof postEventTour>[0],
    )
    expect(res.status).toBe(403)
    const body = await readJson<{ error: string; feature: string }>(res)
    expect(body.error).toBe('feature_disabled')
    expect(body.feature).toBe('tours')
  })
})

describe('cron-invoked handlers no-op with a 200', () => {
  it('POST /publish/events/refresh → no-op summary with skipped flag', async () => {
    const { env } = setup({ events: false })
    const res = await postRefresh(
      publishCtx({ env, url: 'https://localhost/api/v1/publish/events/refresh' }) as unknown as Parameters<
        typeof postRefresh
      >[0],
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ created: number; feeds: unknown[]; skipped?: string }>(res)
    expect(body.created).toBe(0)
    expect(body.feeds).toEqual([])
    expect(body.skipped).toBe('feature_disabled')
  })

  it('GET /publish/workflows/due → empty due list', async () => {
    const { env } = setup({ workflows: false })
    const res = await getDue(
      publishCtx({ env, url: 'https://localhost/api/v1/publish/workflows/due', method: 'GET' }) as unknown as Parameters<
        typeof getDue
      >[0],
    )
    expect(res.status).toBe(200)
    expect((await readJson<{ workflows: unknown[] }>(res)).workflows).toEqual([])
  })
})

describe('public feedback writes soft-accept and drop while feedback is off', () => {
  /** A D1 stand-in that fails the test if any query runs — proves the
   *  gate dropped the submission before the write. */
  function throwingDb(writes: { count: number }): D1Database {
    return new Proxy(
      {},
      {
        get() {
          return () => {
            writes.count++
            throw new Error('feedback write must not run while feedback is off')
          }
        },
      },
    ) as unknown as D1Database
  }

  /** `Origin` is a forbidden request header in Node's undici and gets
   *  silently dropped from a real Request, so fake the request object
   *  (same idiom as `ingest.test.ts`). */
  function fakeFeedbackCtx(env: Record<string, unknown>, url: string, body: unknown) {
    const headers = new Map<string, string>([
      ['origin', 'http://localhost:5173'],
      ['content-type', 'application/json'],
    ])
    const bodyText = JSON.stringify(body)
    const request = {
      method: 'POST',
      url,
      headers: {
        get: (name: string) => headers.get(name.toLowerCase()) ?? null,
        has: (name: string) => headers.has(name.toLowerCase()),
      },
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText),
    }
    return {
      request: request as unknown as Request,
      env,
      params: {},
      data: {},
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: new URL(url).pathname,
    }
  }

  it('POST /api/feedback → { ok: true } and no row', async () => {
    const { env } = setup({ feedback: false })
    const writes = { count: 0 }
    const ctx = fakeFeedbackCtx(
      { ...env, FEEDBACK_DB: throwingDb(writes) },
      'http://localhost:5173/api/feedback',
      {
        rating: 'thumbs-up',
        comment: '',
        messageId: 'm1',
        messages: [],
        datasetId: null,
        timestamp: 1751328000000,
      },
    )
    const res = await postFeedback(ctx as unknown as Parameters<typeof postFeedback>[0])
    expect(res.status).toBe(200)
    expect((await readJson<{ ok: boolean }>(res)).ok).toBe(true)
    expect(writes.count).toBe(0)
  })

  it('POST /api/general-feedback → { ok: true } and no row', async () => {
    const { env } = setup({ feedback: false })
    const writes = { count: 0 }
    const ctx = fakeFeedbackCtx(
      { ...env, FEEDBACK_DB: throwingDb(writes) },
      'http://localhost:5173/api/general-feedback',
      { kind: 'bug', message: 'Something broke.' },
    )
    const res = await postGeneralFeedback(ctx as unknown as Parameters<typeof postGeneralFeedback>[0])
    expect(res.status).toBe(200)
    expect((await readJson<{ ok: boolean }>(res)).ok).toBe(true)
    expect(writes.count).toBe(0)
  })
})
