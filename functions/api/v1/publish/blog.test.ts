/**
 * Wire-level tests for the blog authoring + public read paths
 * (Phase 3d).
 *
 * Coverage: privileged gate on writes, create → publish → public
 * visibility end-to-end, slug allocation/uniqueness/stability, update
 * semantics, unpublish removing public visibility, per-slug 404 for
 * drafts, visibility-filtered dataset hydration, the approved-only
 * event citation, KV cache fill + bust, validation errors, and the
 * blog.* audit rows.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet as authorList, onRequestPost as createPost } from './blog'
import { onRequestGet as getOne, onRequestPut as updateOne, onRequestPost as transition } from './blog/[id]'
import { onRequestGet as publicList } from '../blog'
import { onRequestGet as publicPost } from '../blog/[slug]'
import { asD1, makeKV, seedFixtures } from '../_lib/test-helpers'
import { deriveBlogSlug } from '../_lib/blog-store'
import { insertCurrentEvent, setEventStatus } from '../_lib/events-store'
import type { PublisherRow } from '../_lib/publisher-store'

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
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUB', email: 'p@e', role: 'publisher', is_admin: 0 }

const DS_0 = 'DS000' + 'A'.repeat(21)
const DS_1 = 'DS001' + 'A'.repeat(21)

function setupEnv() {
  const sqlite = seedFixtures({ count: 2 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  return { sqlite, env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() } }
}

type Ctx = Parameters<PagesFunction>[0]

function ctx(opts: {
  env: Record<string, unknown>
  method?: string
  path?: string
  params?: Record<string, string>
  publisher?: PublisherRow
  body?: unknown
}): Ctx {
  const url = `https://localhost${opts.path ?? '/api/v1/publish/blog'}`
  const init: RequestInit = { method: opts.method ?? 'GET', headers: new Headers() }
  if (opts.body !== undefined) {
    ;(init.headers as Headers).set('Content-Type', 'application/json')
    init.body = JSON.stringify(opts.body)
  }
  return {
    request: new Request(url, init),
    env: opts.env,
    params: opts.params ?? {},
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Ctx
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

const VALID = {
  title: 'Watching the Gulf warm',
  summary: 'What three decades of SST say about this week.',
  bodyMd: '## The data\nSea-surface temperature has been rising.',
  datasetIds: [DS_0, DS_1],
}

async function createDraft(env: Record<string, unknown>, body: Record<string, unknown> = VALID) {
  const res = await createPost(ctx({ env, method: 'POST', body }))
  expect(res.status).toBe(201)
  return (await readJson<{ post: { id: string; slug: string } }>(res)).post
}

describe('blog authoring routes', () => {
  it('POST is 403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    const res = await createPost(ctx({ env, method: 'POST', publisher: PUBLISHER, body: VALID }))
    expect(res.status).toBe(403)
  })

  it('create derives a slug, stores the draft, and audits blog.create', async () => {
    const { env, sqlite } = setupEnv()
    const post = await createDraft(env)
    expect(post.slug).toBe('watching-the-gulf-warm')
    const audit = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'blog.create' AND subject_id = ?`)
      .get(post.id) as { n: number }
    expect(audit.n).toBe(1)
    // Authoring list shows the draft.
    const list = await authorList(ctx({ env }))
    const { posts } = await readJson<{ posts: Array<{ id: string; status: string }> }>(list)
    expect(posts.some(p => p.id === post.id && p.status === 'draft')).toBe(true)
  })

  it('slug collisions get a numeric suffix; edits never change the slug', async () => {
    const { env } = setupEnv()
    const a = await createDraft(env)
    const b = await createDraft(env)
    expect(a.slug).toBe('watching-the-gulf-warm')
    expect(b.slug).toBe('watching-the-gulf-warm-2')

    const res = await updateOne(
      ctx({ env, method: 'PUT', params: { id: a.id }, body: { ...VALID, title: 'A completely new title' } }),
    )
    expect(res.status).toBe(200)
    const { post } = await readJson<{ post: { slug: string; title: string } }>(res)
    expect(post.title).toBe('A completely new title')
    expect(post.slug).toBe('watching-the-gulf-warm')
  })

  it('suffixes collisions on max-length slugs without dropping the suffix', async () => {
    // Regression: slicing the composed candidate would drop the '-2'
    // on a 64-char slug and re-test the same candidate forever.
    const { env } = setupEnv()
    const longTitle = 'x'.repeat(80) // slugs to exactly 64 chars
    const a = await createDraft(env, { ...VALID, title: longTitle })
    const b = await createDraft(env, { ...VALID, title: longTitle })
    expect(a.slug).toHaveLength(64)
    expect(b.slug.endsWith('-2')).toBe(true)
    expect(b.slug.length).toBeLessThanOrEqual(64)
    expect(b.slug).not.toBe(a.slug)
  })

  it('400 with field errors for a missing title/body', async () => {
    const { env } = setupEnv()
    const res = await createPost(ctx({ env, method: 'POST', body: { summary: 'x' } }))
    expect(res.status).toBe(400)
    const { errors } = await readJson<{ errors: Array<{ field: string }> }>(res)
    expect(errors.some(e => e.field === 'title')).toBe(true)
    expect(errors.some(e => e.field === 'bodyMd')).toBe(true)
  })
})

describe('publish transition + public reads', () => {
  it('drafts are invisible publicly; publish surfaces them; unpublish removes them', async () => {
    const { env } = setupEnv()
    const post = await createDraft(env)

    // Draft: public list empty, slug 404s.
    let list = await publicList(ctx({ env, path: '/api/v1/blog' }))
    expect((await readJson<{ posts: unknown[] }>(list)).posts).toHaveLength(0)
    let one = await publicPost(ctx({ env, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    expect(one.status).toBe(404)

    // Publish → visible (KV busted so no stale empty list).
    const pub = await transition(ctx({ env, method: 'POST', params: { id: post.id }, body: { action: 'publish' } }))
    expect(pub.status).toBe(200)
    list = await publicList(ctx({ env, path: '/api/v1/blog' }))
    const { posts } = await readJson<{ posts: Array<{ slug: string; datasetCount: number }> }>(list)
    expect(posts).toHaveLength(1)
    expect(posts[0].slug).toBe(post.slug)
    expect(posts[0].datasetCount).toBe(2)

    one = await publicPost(ctx({ env, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    expect(one.status).toBe(200)
    const detail = await readJson<{ post: { bodyMd: string; datasets: Array<{ id: string }> } }>(one)
    expect(detail.post.bodyMd).toContain('Sea-surface temperature')
    expect(detail.post.datasets.map(d => d.id)).toEqual([DS_0, DS_1])

    // Unpublish → gone again (cache busted).
    await transition(ctx({ env, method: 'POST', params: { id: post.id }, body: { action: 'unpublish' } }))
    list = await publicList(ctx({ env, path: '/api/v1/blog' }))
    expect((await readJson<{ posts: unknown[] }>(list)).posts).toHaveLength(0)
    one = await publicPost(ctx({ env, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    expect(one.status).toBe(404)
  })

  it('hidden datasets are omitted from the public hydration', async () => {
    const { env, sqlite } = setupEnv()
    const post = await createDraft(env)
    await transition(ctx({ env, method: 'POST', params: { id: post.id }, body: { action: 'publish' } }))
    sqlite.prepare('UPDATE datasets SET is_hidden = 1 WHERE id = ?').run(DS_0)

    const one = await publicPost(ctx({ env, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    const detail = await readJson<{ post: { datasets: Array<{ id: string }> } }>(one)
    expect(detail.post.datasets.map(d => d.id)).toEqual([DS_1])
  })

  it('the cited event surfaces only while approved', async () => {
    const { env } = setupEnv()
    const ev = await insertCurrentEvent(env.CATALOG_DB, {
      originNode: 'NODE000',
      title: 'Gulf marine heatwave',
      sourceName: 'NOAA',
      sourceUrl: 'https://example.gov/heatwave',
    })
    const post = await createDraft(env, { ...VALID, eventId: ev.id })
    await transition(ctx({ env, method: 'POST', params: { id: post.id }, body: { action: 'publish' } }))

    // Proposed event → citation withheld.
    let one = await publicPost(ctx({ env, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    expect((await readJson<{ post: { event: unknown } }>(one)).post.event).toBeNull()

    // Approve → citation surfaces (bust the per-slug cache the prior
    // read filled by re-publishing, which busts on write).
    await setEventStatus(env.CATALOG_DB, ev.id, 'approved', ADMIN.id)
    await transition(ctx({ env, method: 'POST', params: { id: post.id }, body: { action: 'publish' } }))
    one = await publicPost(ctx({ env, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    const { post: detail } = await readJson<{ post: { event: { title: string; sourceUrl: string } | null } }>(one)
    expect(detail.event?.title).toBe('Gulf marine heatwave')
    expect(detail.event?.sourceUrl).toBe('https://example.gov/heatwave')
  })

  it('GET /publish/blog/:id returns drafts to authors; publish is idempotent on published_at', async () => {
    const { env } = setupEnv()
    const post = await createDraft(env)
    const one = await getOne(ctx({ env, params: { id: post.id } }))
    expect(one.status).toBe(200)

    const first = await transition(ctx({ env, method: 'POST', params: { id: post.id }, body: { action: 'publish' } }))
    const firstAt = (await readJson<{ post: { publishedAt: string } }>(first)).post.publishedAt
    const again = await transition(ctx({ env, method: 'POST', params: { id: post.id }, body: { action: 'publish' } }))
    const secondAt = (await readJson<{ post: { publishedAt: string } }>(again)).post.publishedAt
    expect(secondAt).toBe(firstAt)
  })
})

describe('public route hardening', () => {
  it('404s malformed slugs before touching KV or D1', async () => {
    const { env } = setupEnv()
    for (const bad of ['UPPER-case', 'x'.repeat(65), 'semi;colon', '..%2F..']) {
      const res = await publicPost(ctx({ env, path: '/api/v1/blog/x', params: { slug: bad } }))
      expect(res.status).toBe(404)
    }
  })

  it('treats a throwing KV as a cache miss and still serves from D1', async () => {
    const { env } = setupEnv()
    const post = await createDraft(env)
    await transition(ctx({ env, method: 'POST', params: { id: post.id }, body: { action: 'publish' } }))
    const throwingKv = {
      get: async () => { throw new Error('kv down') },
      put: async () => { throw new Error('kv down') },
      delete: async () => { throw new Error('kv down') },
    }
    const brokenEnv = { ...env, CATALOG_KV: throwingKv }
    const one = await publicPost(ctx({ env: brokenEnv, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    expect(one.status).toBe(200)
    const list = await publicList(ctx({ env: brokenEnv, path: '/api/v1/blog' }))
    expect(list.status).toBe(200)
    expect((await readJson<{ posts: unknown[] }>(list)).posts).toHaveLength(1)
  })
})

describe('deriveBlogSlug', () => {
  it('slugs titles and falls back safely', () => {
    expect(deriveBlogSlug('Watching the Gulf warm!')).toBe('watching-the-gulf-warm')
    expect(deriveBlogSlug('2026: a warm year')).toBe('post-2026-a-warm-year')
    expect(deriveBlogSlug('!!!')).toBe('post')
  })
})

describe('companion-tour linkage', () => {
  // Crockford ULID alphabet (no I, L, O, U).
  const TOUR_ID = 'TR000' + 'A'.repeat(21)

  function seedTour(
    sqlite: ReturnType<typeof seedFixtures>,
    opts: { published?: boolean; retracted?: boolean; visibility?: string } = {},
  ): void {
    sqlite
      .prepare(
        `INSERT INTO tours (id, slug, origin_node, title, tour_json_ref, visibility,
                            schema_version, created_at, updated_at, published_at, retracted_at, publisher_id)
         VALUES (?, 'companion-tour', 'NODE000', 'Companion', 'r2:tours/x/tour.json', ?,
                 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', ?, ?, NULL)`,
      )
      .run(
        TOUR_ID,
        opts.visibility ?? 'public',
        opts.published === false ? null : '2026-07-01T00:00:00.000Z',
        opts.retracted ? '2026-07-02T00:00:00.000Z' : null,
      )
  }

  it('tourId round-trips through create/read; garbage ids are rejected', async () => {
    const { env } = setupEnv()
    const post = await createDraft(env, { ...VALID, tourId: TOUR_ID })
    const res = await getOne(ctx({ env, params: { id: post.id } }))
    expect((await readJson<{ post: { tourId: string | null } }>(res)).post.tourId).toBe(TOUR_ID)

    const bad = await createPost(ctx({ env, method: 'POST', body: { ...VALID, tourId: 'not-a-ulid' } }))
    expect(bad.status).toBe(400)
    const { errors } = await readJson<{ errors: Array<{ field: string }> }>(bad)
    expect(errors.some(e => e.field === 'tourId')).toBe(true)
  })

  it('the public post surfaces the tour only while published + public + not retracted', async () => {
    const { env, sqlite } = setupEnv()
    const post = await createDraft(env, { ...VALID, tourId: TOUR_ID })
    await transition(ctx({ env, method: 'POST', params: { id: post.id }, body: { action: 'publish' } }))

    // No tours row at all (dangling id) → no tour on the wire.
    let res = await publicPost(ctx({ env, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    expect((await readJson<{ post: { tour: unknown } }>(res)).post.tour).toBeNull()

    // Draft tour → still gated. (Bust the per-slug KV cache between
    // reads — direct SQL changes don't flow through the write routes.)
    seedTour(sqlite, { published: false })
    ;(env.CATALOG_KV as unknown as { _store: Map<string, string> })._store.clear()
    res = await publicPost(ctx({ env, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    expect((await readJson<{ post: { tour: unknown } }>(res)).post.tour).toBeNull()

    // Published + public → playable.
    sqlite.prepare(`UPDATE tours SET published_at = '2026-07-01T00:00:00.000Z' WHERE id = ?`).run(TOUR_ID)
    ;(env.CATALOG_KV as unknown as { _store: Map<string, string> })._store.clear()
    res = await publicPost(ctx({ env, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    expect((await readJson<{ post: { tour: { id: string } | null } }>(res)).post.tour).toEqual({ id: TOUR_ID })

    // Retracted → gated again.
    sqlite.prepare(`UPDATE tours SET retracted_at = '2026-07-02T00:00:00.000Z' WHERE id = ?`).run(TOUR_ID)
    ;(env.CATALOG_KV as unknown as { _store: Map<string, string> })._store.clear()
    res = await publicPost(ctx({ env, path: `/api/v1/blog/${post.slug}`, params: { slug: post.slug } }))
    expect((await readJson<{ post: { tour: unknown } }>(res)).post.tour).toBeNull()
  })
})
