/**
 * Wire-level tests for the hero-override write endpoints (§9.1 admin,
 * Phase B).
 *
 * Coverage:
 *   - PUT sets the singleton for admin; 403 for publisher.
 *   - PUT 400 for a missing/invalid window; 404 for an unknown dataset.
 *   - PUT writes a `hero.set` audit row and busts the KV cache.
 *   - PUT upserts (a second set replaces).
 *   - DELETE clears (204) + `hero.clear` audit + KV bust; 403 for
 *     publisher; idempotent when absent.
 *   - 503 when CATALOG_DB is unbound.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPut as heroPut, onRequestDelete as heroDelete } from './featured-hero'
import { asD1, makeKV, seedFixtures } from '../_lib/test-helpers'
import { getHeroOverride } from '../_lib/hero-override-store'
import { HERO_CACHE_KEY } from '../_lib/hero-override-store'
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

const DS_0 = 'DS000' + 'A'.repeat(21)
const DS_1 = 'DS001' + 'A'.repeat(21)

const WINDOW = { start: '2026-05-01T00:00:00.000Z', end: '2026-06-01T00:00:00.000Z' }

function setupEnv() {
  const sqlite = seedFixtures({ count: 2 })
  for (const p of [ADMIN, PUBLISHER]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  const kv = makeKV()
  return { sqlite, kv, env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv } }
}

function ctx(opts: {
  env: Record<string, unknown>
  publisher?: PublisherRow
  method?: string
  body?: unknown
  bodyText?: string
}) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const init: RequestInit = { method: opts.method ?? 'PUT', headers }
  if (opts.bodyText !== undefined) init.body = opts.bodyText
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    request: new Request('https://localhost/api/v1/publish/featured-hero', init),
    env: opts.env,
    params: {} as Record<string, string | string[]>,
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/featured-hero',
  } as unknown as Parameters<typeof heroPut>[0]
}

function auditCount(sqlite: ReturnType<typeof seedFixtures>, action: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = ?`).get(action) as { n: number }
  return row.n
}

describe('PUT /api/v1/publish/featured-hero', () => {
  it('403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    const res = await heroPut(ctx({ env, publisher: PUBLISHER, body: { dataset_id: DS_0, window: WINDOW } }))
    expect(res.status).toBe(403)
  })

  it('400 for a missing window', async () => {
    const { env } = setupEnv()
    const res = await heroPut(ctx({ env, body: { dataset_id: DS_0 } }))
    expect(res.status).toBe(400)
    const body = JSON.parse(await res.text()) as { errors: Array<{ field: string }> }
    expect(body.errors.some(e => e.field === 'window.start')).toBe(true)
  })

  it('404 for an unknown dataset', async () => {
    const { env } = setupEnv()
    const res = await heroPut(ctx({ env, body: { dataset_id: 'GHOST' + 'A'.repeat(21), window: WINDOW } }))
    expect(res.status).toBe(404)
  })

  it('sets the singleton, audits, and busts the KV cache', async () => {
    const { env, sqlite, kv } = setupEnv()
    kv._store.set(HERO_CACHE_KEY, 'stale')
    const res = await heroPut(ctx({ env, body: { dataset_id: DS_0, window: WINDOW, headline: 'Storm' } }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { hero: { datasetId: string; headline?: string } }
    expect(body.hero).toMatchObject({ datasetId: DS_0, headline: 'Storm' })
    expect((await getHeroOverride(asD1(sqlite)))?.dataset_id).toBe(DS_0)
    expect(auditCount(sqlite, 'hero.set')).toBe(1)
    expect(kv._store.has(HERO_CACHE_KEY)).toBe(false)
  })

  it('upserts — a second set replaces the first', async () => {
    const { env, sqlite } = setupEnv()
    await heroPut(ctx({ env, body: { dataset_id: DS_0, window: WINDOW } }))
    await heroPut(ctx({ env, body: { dataset_id: DS_1, window: WINDOW, headline: 'New' } }))
    const row = await getHeroOverride(asD1(sqlite))
    expect(row?.dataset_id).toBe(DS_1)
    expect(row?.headline).toBe('New')
  })

  it('503 when CATALOG_DB is unbound', async () => {
    const res = await heroPut(ctx({ env: {}, body: { dataset_id: DS_0, window: WINDOW } }))
    expect(res.status).toBe(503)
  })
})

describe('DELETE /api/v1/publish/featured-hero', () => {
  it('403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    const res = await heroDelete(ctx({ env, publisher: PUBLISHER, method: 'DELETE' }))
    expect(res.status).toBe(403)
  })

  it('clears the pin (204), audits, and busts the KV cache', async () => {
    const { env, sqlite, kv } = setupEnv()
    await heroPut(ctx({ env, body: { dataset_id: DS_0, window: WINDOW } }))
    kv._store.set(HERO_CACHE_KEY, 'stale')
    const res = await heroDelete(ctx({ env, method: 'DELETE' }))
    expect(res.status).toBe(204)
    expect(await getHeroOverride(asD1(sqlite))).toBeNull()
    expect(auditCount(sqlite, 'hero.clear')).toBe(1)
    expect(kv._store.has(HERO_CACHE_KEY)).toBe(false)
  })

  it('is idempotent when no pin is set (still 204)', async () => {
    const { env } = setupEnv()
    const res = await heroDelete(ctx({ env, method: 'DELETE' }))
    expect(res.status).toBe(204)
  })
})
