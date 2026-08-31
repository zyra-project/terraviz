// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for the feed-connector CRUD surface —
 * GET/POST /api/v1/publish/feeds and POST/DELETE /api/v1/publish/feeds/:id.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet as feedsGet, onRequestPost as feedsPost, parseCreateFeed } from './feeds'
import { onRequestPost as feedPatch, onRequestDelete as feedDelete } from './feeds/[id]'
import { asD1, seedFixtures } from '../_lib/test-helpers'
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
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUBLISHER', email: 'c@e', role: 'publisher', is_admin: 0 }

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  return { sqlite, env: { CATALOG_DB: asD1(sqlite) } }
}

function ctx(opts: {
  env: Record<string, unknown>
  publisher?: PublisherRow
  method?: string
  body?: unknown
  id?: string
}) {
  return {
    request: new Request('https://localhost/api/v1/publish/feeds', {
      method: opts.method ?? 'GET',
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    env: opts.env,
    params: (opts.id ? { id: opts.id } : {}) as Record<string, string | string[]>,
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/feeds',
  } as unknown as Parameters<typeof feedsGet>[0]
}

function auditCount(sqlite: ReturnType<typeof seedFixtures>, action: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = ?`).get(action) as { n: number }
  return row.n
}

describe('parseCreateFeed', () => {
  it('accepts a valid rss create and defaults enabled', () => {
    const parsed = parseCreateFeed({ kind: 'rss', label: 'BBC Science', url: 'https://feeds.example/rss.xml' })
    expect(parsed).toMatchObject({ ok: true, value: { kind: 'rss', enabled: true, category: null } })
  })

  it('rejects an unknown kind, a missing label, and a non-http url', () => {
    const parsed = parseCreateFeed({ kind: 'gopher', label: '', url: 'ftp://x' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors.map(e => e.field).sort()).toEqual(['kind', 'label', 'url'])
    }
  })
})

describe('GET /api/v1/publish/feeds', () => {
  it('403 for a publisher-role account, 503 unbound', async () => {
    const { env } = setupEnv()
    expect((await feedsGet(ctx({ env, publisher: PUBLISHER }))).status).toBe(403)
    expect((await feedsGet(ctx({ env: {} }))).status).toBe(503)
  })

  it('lists the migration-seeded EONET connector', async () => {
    const { env } = setupEnv()
    const res = await feedsGet(ctx({ env }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { feeds: Array<{ id: string; kind: string; enabled: boolean }> }
    expect(body.feeds).toEqual([
      expect.objectContaining({ id: 'FEED_EONET_DEFAULT', kind: 'eonet', enabled: true }),
    ])
  })
})

describe('POST /api/v1/publish/feeds', () => {
  it('creates a connector, audits, and returns it', async () => {
    const { env, sqlite } = setupEnv()
    const res = await feedsPost(
      ctx({
        env,
        method: 'POST',
        body: { kind: 'rss', label: 'Guardian Environment', url: 'https://www.example.org/environment/rss', category: 'news' },
      }),
    )
    expect(res.status).toBe(201)
    const body = JSON.parse(await res.text()) as { feed: { id: string; kind: string; category: string | null } }
    expect(body.feed).toMatchObject({ kind: 'rss', category: 'news' })
    expect(auditCount(sqlite, 'feed.created')).toBe(1)
  })

  it('400s a validation failure with field errors', async () => {
    const { env } = setupEnv()
    const res = await feedsPost(ctx({ env, method: 'POST', body: { kind: 'rss', label: 'X', url: 'not-a-url' } }))
    expect(res.status).toBe(400)
    const body = JSON.parse(await res.text()) as { errors: Array<{ field: string }> }
    expect(body.errors.map(e => e.field)).toEqual(['url'])
  })
})

describe('POST /api/v1/publish/feeds/:id', () => {
  it('disables and re-enables a connector, audited', async () => {
    const { env, sqlite } = setupEnv()
    const off = await feedPatch(ctx({ env, method: 'POST', id: 'FEED_EONET_DEFAULT', body: { enabled: false } }))
    expect(off.status).toBe(200)
    expect((JSON.parse(await off.text()) as { feed: { enabled: boolean } }).feed.enabled).toBe(false)
    const on = await feedPatch(ctx({ env, method: 'POST', id: 'FEED_EONET_DEFAULT', body: { enabled: true } }))
    expect((JSON.parse(await on.text()) as { feed: { enabled: boolean } }).feed.enabled).toBe(true)
    expect(auditCount(sqlite, 'feed.updated')).toBe(2)
  })

  it('400s an empty patch or a bad url; 404s an unknown id', async () => {
    const { env } = setupEnv()
    expect((await feedPatch(ctx({ env, method: 'POST', id: 'FEED_EONET_DEFAULT', body: {} }))).status).toBe(400)
    expect(
      (await feedPatch(ctx({ env, method: 'POST', id: 'FEED_EONET_DEFAULT', body: { url: 'javascript:x' } }))).status,
    ).toBe(400)
    expect((await feedPatch(ctx({ env, method: 'POST', id: 'NOPE', body: { enabled: false } }))).status).toBe(404)
  })

  it('an explicit category: null clears the category', async () => {
    const { env } = setupEnv()
    const res = await feedPatch(ctx({ env, method: 'POST', id: 'FEED_EONET_DEFAULT', body: { category: null } }))
    expect(res.status).toBe(200)
    expect((JSON.parse(await res.text()) as { feed: { category: string | null } }).feed.category).toBeNull()
  })

  it('enforces the create route\'s length bounds on patch', async () => {
    const { env } = setupEnv()
    const longLabel = 'x'.repeat(121)
    expect(
      (await feedPatch(ctx({ env, method: 'POST', id: 'FEED_EONET_DEFAULT', body: { label: longLabel } }))).status,
    ).toBe(400)
    const longUrl = `https://example.org/${'x'.repeat(2100)}`
    expect(
      (await feedPatch(ctx({ env, method: 'POST', id: 'FEED_EONET_DEFAULT', body: { url: longUrl } }))).status,
    ).toBe(400)
  })
})

describe('DELETE /api/v1/publish/feeds/:id', () => {
  it('deletes once, audits, then 404s', async () => {
    const { env, sqlite } = setupEnv()
    const res = await feedDelete(ctx({ env, method: 'DELETE', id: 'FEED_EONET_DEFAULT' }))
    expect(res.status).toBe(200)
    expect(auditCount(sqlite, 'feed.deleted')).toBe(1)
    expect((await feedDelete(ctx({ env, method: 'DELETE', id: 'FEED_EONET_DEFAULT' }))).status).toBe(404)
  })
})
