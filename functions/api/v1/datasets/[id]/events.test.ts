/**
 * Wire-level tests for GET /api/v1/datasets/{id}/events — the per-dataset
 * "In the news" list. (Gating logic is unit-tested against
 * `listApprovedEventsForDataset` in events-store.test.ts.)
 *
 * Coverage: 503 when unbound; `{ events: [] }` when a dataset has none;
 * the assembled shape + cache header for a dataset with an approved,
 * approved-linked event.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet as datasetEventsGet } from './events'
import { asD1, seedFixtures } from '../../_lib/test-helpers'
import {
  insertCurrentEvent,
  upsertEventDatasetLink,
  setEventStatus,
  setLinkStatus,
} from '../../_lib/events-store'

const DS_0 = 'DS000' + 'A'.repeat(21)
const DS_1 = 'DS001' + 'A'.repeat(21)

function setupEnv() {
  const sqlite = seedFixtures({ count: 2 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('PUB1', 'curator@test.local', 'Curator', 'admin', 1, 'active', '2026-01-01T00:00:00.000Z')
  return { sqlite, env: { CATALOG_DB: asD1(sqlite) } }
}

function ctx(env: Record<string, unknown>, id: string) {
  return {
    request: new Request(`https://localhost/api/v1/datasets/${id}/events`, { method: 'GET' }),
    env,
    params: { id },
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/v1/datasets/${id}/events`,
  } as unknown as Parameters<typeof datasetEventsGet>[0]
}

async function seedApprovedFor(env: { CATALOG_DB: D1Database }, datasetId: string): Promise<string> {
  const { id } = await insertCurrentEvent(env.CATALOG_DB, {
    originNode: 'NODE000',
    title: 'Storm now',
    sourceName: 'NOAA',
    sourceUrl: 'https://example.gov/storm',
    publishedAt: new Date().toISOString(),
    geometry: { point: { lat: 29, lon: -89 } },
  })
  await upsertEventDatasetLink(env.CATALOG_DB, { eventId: id, datasetId, matchScore: 0.9 })
  await setEventStatus(env.CATALOG_DB, id, 'approved', 'PUB1')
  await setLinkStatus(env.CATALOG_DB, id, datasetId, 'approved', 'PUB1')
  return id
}

describe('GET /api/v1/datasets/:id/events', () => {
  it('503 when CATALOG_DB is unbound', async () => {
    const res = await datasetEventsGet(ctx({}, DS_0))
    expect(res.status).toBe(503)
  })

  it('returns the approved events linked to the dataset', async () => {
    const { env } = setupEnv()
    const id = await seedApprovedFor(env, DS_0)
    const res = await datasetEventsGet(ctx(env, DS_0))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('max-age=60')
    const body = (await res.json()) as { events: Array<{ id: string; source: { name: string } }> }
    expect(body.events).toHaveLength(1)
    expect(body.events[0].id).toBe(id)
    expect(body.events[0].source.name).toBe('NOAA')
  })

  it('returns [] for a dataset with no approved events', async () => {
    const { env } = setupEnv()
    await seedApprovedFor(env, DS_0) // linked to DS_0 only
    const res = await datasetEventsGet(ctx(env, DS_1))
    expect(res.status).toBe(200)
    expect((await res.json() as { events: unknown[] }).events).toEqual([])
  })
})
