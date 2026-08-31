// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for the video-source registry surface:
 * GET/POST /video-sources, POST/DELETE /video-sources/:id,
 * POST /video-sources/refresh, and GET /video-suggest.
 */

import { describe, expect, it, vi } from 'vitest'
import { onRequestGet as listGet, onRequestPost as createPost, parseCreateVideoSource } from './video-sources'
import { onRequestPost as patchPost, onRequestDelete as del } from './video-sources/[id]'
import { onRequestPost as refreshPost } from './video-sources/refresh'
import { onRequestGet as suggestGet } from './video-suggest'
import { asD1, seedFixtures } from '../../_lib/test-helpers'
import type { PublisherRow } from '../../_lib/publisher-store'

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
const READONLY: PublisherRow = { ...ADMIN, id: 'PUB-RO', role: 'readonly', is_admin: 0 }

function setupEnv(extra: Record<string, unknown> = {}) {
  const sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  return { sqlite, env: { CATALOG_DB: asD1(sqlite), MOCK_AI: 'true', ...extra } }
}

const SITEMAP = `<?xml version="1.0"?>
<urlset xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
  <url><loc>https://ot.example/coral.html</loc><video:video>
    <video:title>Coral Bleaching</video:title>
    <video:description>Warming seas stress reefs and cause coral bleaching.</video:description>
    <video:content_loc>https://ot.example/coral.mp4</video:content_loc>
    <video:thumbnail_loc>https://ot.example/coral.jpg</video:thumbnail_loc>
  </video:video></url>
</urlset>`

function stubFetch(map: Record<string, string>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const body = map[String(input)]
    return body === undefined ? new Response('nf', { status: 404 }) : new Response(body, { status: 200 })
  })
}

function ctx(opts: {
  env: Record<string, unknown>
  publisher?: PublisherRow
  method?: string
  body?: unknown
  id?: string
  url?: string
}) {
  return {
    request: new Request(opts.url ?? 'https://localhost/api/v1/publish/media/video-sources', {
      method: opts.method ?? 'GET',
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    env: opts.env,
    params: (opts.id ? { id: opts.id } : {}) as Record<string, string | string[]>,
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/media/video-sources',
  } as unknown as Parameters<typeof listGet>[0]
}

async function bodyOf(res: Response): Promise<any> {
  return JSON.parse(await res.text())
}

describe('parseCreateVideoSource', () => {
  it('accepts a valid create and defaults enabled', () => {
    const parsed = parseCreateVideoSource({ label: 'NOAA Ocean Today', url: 'https://oceantoday.noaa.gov/videositemap.xml' })
    expect(parsed).toMatchObject({ ok: true, value: { enabled: true, attribution: null } })
  })
  it('rejects a missing label and a non-http url', () => {
    const parsed = parseCreateVideoSource({ label: '', url: 'ftp://x' })
    expect(parsed.ok).toBe(false)
  })
})

describe('video-sources CRUD', () => {
  it('non-privileged callers are refused', async () => {
    const { env } = setupEnv()
    const res = await listGet(ctx({ env, publisher: READONLY }))
    expect(res.status).toBe(403)
  })

  it('create → list round-trips, rejects a duplicate URL', async () => {
    const { env } = setupEnv()
    const create = await createPost(ctx({ env, method: 'POST', body: { label: 'OT', url: 'https://ot.example/s.xml' } }))
    expect(create.status).toBe(201)
    const list = await bodyOf(await listGet(ctx({ env })))
    expect(list.sources).toHaveLength(1)
    const dup = await createPost(ctx({ env, method: 'POST', body: { label: 'OT2', url: 'https://ot.example/s.xml' } }))
    expect(dup.status).toBe(409)
  })

  it('patch pauses and delete removes', async () => {
    const { env } = setupEnv()
    const created = await bodyOf(await createPost(ctx({ env, method: 'POST', body: { label: 'OT', url: 'https://ot.example/s.xml' } })))
    const id = created.source.id
    const patched = await bodyOf(await patchPost(ctx({ env, method: 'POST', id, body: { enabled: false } })))
    expect(patched.source.enabled).toBe(false)
    const removed = await del(ctx({ env, method: 'DELETE', id }))
    expect(removed.status).toBe(200)
    const list = await bodyOf(await listGet(ctx({ env })))
    expect(list.sources).toHaveLength(0)
  })
})

describe('refresh + suggest', () => {
  it('refresh indexes an enabled source, then suggest ranks it', async () => {
    const { env } = setupEnv()
    // Register a source pointing at our stubbed sitemap.
    await createPost(ctx({ env, method: 'POST', body: { label: 'NOAA Ocean Today', url: 'https://ot.example/s.xml', attribution: 'NOAA Ocean Today' } }))
    // Stub global fetch for the refresh route (it uses runtime fetch).
    const orig = globalThis.fetch
    globalThis.fetch = stubFetch({ 'https://ot.example/s.xml': SITEMAP }) as unknown as typeof fetch
    try {
      const refreshed = await bodyOf(await refreshPost(ctx({ env, method: 'POST' })))
      expect(refreshed).toMatchObject({ indexed: 1, embedded: 1 })
    } finally {
      globalThis.fetch = orig
    }
    // Suggest for a coral story.
    const res = await suggestGet(ctx({ env, url: 'https://localhost/api/v1/publish/media/video-suggest?q=coral%20reef%20bleaching%20warming%20seas&minScore=-1' }))
    const body = await bodyOf(res)
    expect(body.videos).toHaveLength(1)
    expect(body.videos[0]).toMatchObject({
      title: 'Coral Bleaching',
      contentUrl: 'https://ot.example/coral.mp4',
      attribution: 'NOAA Ocean Today',
    })
  })

  it('suggest is empty (never errors) when AI is unconfigured', async () => {
    const { env } = setupEnv()
    delete (env as Record<string, unknown>).MOCK_AI
    const res = await suggestGet(ctx({ env, url: 'https://localhost/x?q=coral' }))
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).videos).toEqual([])
  })

  it('suggest refuses a non-privileged caller', async () => {
    const { env } = setupEnv()
    const res = await suggestGet(ctx({ env, publisher: READONLY, url: 'https://localhost/x?q=coral' }))
    expect(res.status).toBe(403)
  })
})
