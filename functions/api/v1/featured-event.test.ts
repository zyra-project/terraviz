/**
 * Wire-level tests for GET /api/v1/featured-event — the public read of
 * the event that headlines the "Right now" hero.
 *
 * Coverage: 503 when unbound; `{ event: null }` when nothing qualifies;
 * the assembled event+dataset shape for an approved event with an
 * approved visible link; and the KV read-through cache.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet as featuredEventGet } from './featured-event'
import { asD1, makeKV, seedFixtures } from './_lib/test-helpers'
import {
  insertCurrentEvent,
  upsertEventDatasetLink,
  setEventStatus,
  setLinkStatus,
  FEATURED_EVENT_CACHE_KEY,
} from './_lib/events-store'

const DS_0 = 'DS000' + 'A'.repeat(21)

function setupEnv() {
  const sqlite = seedFixtures({ count: 1 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('PUB1', 'curator@test.local', 'Curator', 'admin', 1, 'active', '2026-01-01T00:00:00.000Z')
  const kv = makeKV()
  return { sqlite, kv, env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv } }
}

function ctx(env: Record<string, unknown>) {
  return {
    request: new Request('https://localhost/api/v1/featured-event', { method: 'GET' }),
    env,
    params: {} as Record<string, string | string[]>,
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/featured-event',
  } as unknown as Parameters<typeof featuredEventGet>[0]
}

async function seedApproved(env: { CATALOG_DB: D1Database }) {
  const { id } = await insertCurrentEvent(env.CATALOG_DB, {
    originNode: 'NODE000',
    title: 'Storm now',
    sourceName: 'NOAA',
    sourceUrl: 'https://example.gov/storm',
    publishedAt: new Date().toISOString(),
  })
  await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_0, matchScore: 0.9 })
  await setEventStatus(env.CATALOG_DB, id, 'approved', 'PUB1')
  await setLinkStatus(env.CATALOG_DB, id, DS_0, 'approved', 'PUB1')
  return id
}

describe('GET /api/v1/featured-event', () => {
  it('503 when CATALOG_DB is unbound', async () => {
    const res = await featuredEventGet(ctx({}))
    expect(res.status).toBe(503)
  })

  it('returns { event: null } when nothing qualifies', async () => {
    const { env } = setupEnv()
    const res = await featuredEventGet(ctx(env))
    expect(res.status).toBe(200)
    expect(JSON.parse(await res.text())).toEqual({ event: null })
  })

  it('returns the approved event paired with its dataset', async () => {
    const { env } = setupEnv()
    const id = await seedApproved(env)
    const res = await featuredEventGet(ctx(env))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { event: { id: string; datasetId: string; datasetTitle: string; source: { name: string } } | null }
    expect(body.event?.id).toBe(id)
    expect(body.event?.datasetId).toBe(DS_0)
    expect(body.event?.datasetTitle).toBe('Test Dataset 0')
    expect(body.event?.source.name).toBe('NOAA')
  })

  it('serves a cached body on the second call (X-Cache HIT)', async () => {
    const { env, kv } = setupEnv()
    await seedApproved(env)
    await featuredEventGet(ctx(env))
    expect(kv._store.has(FEATURED_EVENT_CACHE_KEY)).toBe(true)
    const res2 = await featuredEventGet(ctx(env))
    expect(res2.headers.get('X-Cache')).toBe('HIT')
  })
})
