/**
 * Wire-level tests for GET /api/v1/events — the public list of approved
 * current events for the catalog Map/Timeline overlays.
 *
 * Coverage: 503 when unbound; `{ events: [] }` when nothing qualifies;
 * the assembled event shape (geometry + datasetIds + source) for an
 * approved event with an approved visible link; and the KV read-through
 * cache. (The gating logic is unit-tested against `listPublicEvents` in
 * events-store.test.ts.)
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet as eventsGet } from './events'
import { asD1, makeKV, seedFixtures } from './_lib/test-helpers'
import {
  insertCurrentEvent,
  upsertEventDatasetLink,
  setEventStatus,
  setLinkStatus,
  EVENTS_LIST_CACHE_KEY,
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
    request: new Request('https://localhost/api/v1/events', { method: 'GET' }),
    env,
    params: {} as Record<string, string | string[]>,
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/events',
  } as unknown as Parameters<typeof eventsGet>[0]
}

async function seedApproved(env: { CATALOG_DB: D1Database }) {
  const { id } = await insertCurrentEvent(env.CATALOG_DB, {
    originNode: 'NODE000',
    title: 'Storm now',
    sourceName: 'NOAA',
    sourceUrl: 'https://example.gov/storm',
    publishedAt: new Date().toISOString(),
    geometry: { point: { lat: 29, lon: -89 } },
  })
  await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId: DS_0, matchScore: 0.9 })
  await setEventStatus(env.CATALOG_DB, id, 'approved', 'PUB1')
  await setLinkStatus(env.CATALOG_DB, id, DS_0, 'approved', 'PUB1')
  return id
}

describe('GET /api/v1/events', () => {
  it('503 when CATALOG_DB is unbound', async () => {
    const res = await eventsGet(ctx({}))
    expect(res.status).toBe(503)
  })

  it('returns { events: [] } when nothing qualifies', async () => {
    const { env } = setupEnv()
    const res = await eventsGet(ctx(env))
    expect(res.status).toBe(200)
    expect(JSON.parse(await res.text())).toEqual({ events: [] })
  })

  it('returns the approved event with geometry, source, and dataset ids', async () => {
    const { env } = setupEnv()
    const id = await seedApproved(env)
    const res = await eventsGet(ctx(env))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as {
      events: Array<{ id: string; geometry: { point?: { lat: number; lon: number } }; datasetIds: string[]; source: { name: string } }>
    }
    expect(body.events).toHaveLength(1)
    expect(body.events[0].id).toBe(id)
    expect(body.events[0].geometry.point).toEqual({ lat: 29, lon: -89 })
    expect(body.events[0].datasetIds).toEqual([DS_0])
    expect(body.events[0].source.name).toBe('NOAA')
  })

  it('serves a cached body on the second call (X-Cache HIT)', async () => {
    const { env, kv } = setupEnv()
    await seedApproved(env)
    await eventsGet(ctx(env))
    expect(kv._store.has(EVENTS_LIST_CACHE_KEY)).toBe(true)
    const res2 = await eventsGet(ctx(env))
    expect(res2.headers.get('X-Cache')).toBe('HIT')
  })
})
