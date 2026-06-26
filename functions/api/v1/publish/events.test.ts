/**
 * Wire-level tests for GET /api/v1/publish/events — the current-events
 * review queue.
 *
 * Coverage: privileged gate (403 for publisher), the assembled
 * event+links+title shape, the `?status` filter, 400 for a bad status,
 * and 503 when CATALOG_DB is unbound.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet as eventsGet, onRequestPost as eventsPost } from './events'
import { asD1, seedFixtures } from '../_lib/test-helpers'
import {
  insertCurrentEvent,
  upsertEventDatasetLink,
  setEventStatus,
  listCurrentEvents,
  listLinksForEvent,
  getEventDecorations,
} from '../_lib/events-store'
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
  return { sqlite, env: { CATALOG_DB: asD1(sqlite) } }
}

function ctx(opts: { env: Record<string, unknown>; publisher?: PublisherRow; url?: string }) {
  const url = opts.url ?? 'https://localhost/api/v1/publish/events'
  return {
    request: new Request(url, { method: 'GET' }),
    env: opts.env,
    params: {} as Record<string, string | string[]>,
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/events',
  } as unknown as Parameters<typeof eventsGet>[0]
}

const SAMPLE = {
  originNode: 'NODE000',
  title: 'Storm now',
  sourceName: 'NOAA',
  sourceUrl: 'https://example.gov/storm',
  occurredStart: '2026-06-25T12:00:00Z',
}

describe('GET /api/v1/publish/events', () => {
  it('403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    const res = await eventsGet(ctx({ env, publisher: PUBLISHER }))
    expect(res.status).toBe(403)
  })

  it('503 when CATALOG_DB is unbound', async () => {
    const res = await eventsGet(ctx({ env: {} }))
    expect(res.status).toBe(503)
  })

  it('400 for an invalid status', async () => {
    const { env } = setupEnv()
    const res = await eventsGet(ctx({ env, url: 'https://localhost/api/v1/publish/events?status=bogus' }))
    expect(res.status).toBe(400)
  })

  it('returns proposed events with their links + dataset titles', async () => {
    const { env } = setupEnv()
    const db = env.CATALOG_DB
    const { id } = await insertCurrentEvent(db, { ...SAMPLE, keywords: ['hurricane'] })
    await upsertEventDatasetLink(db, {
      eventId: id,
      datasetId: DS_0,
      matchScore: 0.9,
      signals: { geo: null, temporal: 1 },
    })

    const res = await eventsGet(ctx({ env }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as {
      events: Array<{
        id: string
        keywords: string[]
        links: Array<{ datasetId: string; datasetTitle: string | null; score: number; signals: unknown; status: string }>
      }>
    }
    expect(body.events).toHaveLength(1)
    expect(body.events[0].id).toBe(id)
    expect(body.events[0].keywords).toEqual(['hurricane'])
    expect(body.events[0].links).toHaveLength(1)
    expect(body.events[0].links[0]).toMatchObject({
      datasetId: DS_0,
      datasetTitle: 'Test Dataset 0',
      score: 0.9,
      signals: { geo: null, temporal: 1 },
      status: 'proposed',
    })
  })

  it('filters by status (approved excludes proposed)', async () => {
    const { env } = setupEnv()
    const db = env.CATALOG_DB
    const a = await insertCurrentEvent(db, { ...SAMPLE, title: 'approved one' })
    await insertCurrentEvent(db, { ...SAMPLE, title: 'proposed one' })
    await setEventStatus(db, a.id, 'approved', 'PUB-ADMIN')

    const res = await eventsGet(ctx({ env, url: 'https://localhost/api/v1/publish/events?status=approved' }))
    const body = JSON.parse(await res.text()) as { events: Array<{ title: string }> }
    expect(body.events.map(e => e.title)).toEqual(['approved one'])
  })

  it('status=all lists events of every status', async () => {
    const { env } = setupEnv()
    const db = env.CATALOG_DB
    const a = await insertCurrentEvent(db, { ...SAMPLE, title: 'approved one' })
    const r = await insertCurrentEvent(db, { ...SAMPLE, title: 'rejected one' })
    await insertCurrentEvent(db, { ...SAMPLE, title: 'proposed one' })
    await setEventStatus(db, a.id, 'approved', 'PUB-ADMIN')
    await setEventStatus(db, r.id, 'rejected', 'PUB-ADMIN')

    const res = await eventsGet(ctx({ env, url: 'https://localhost/api/v1/publish/events?status=all' }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { events: Array<{ title: string }> }
    expect(body.events.map(e => e.title).sort()).toEqual(['approved one', 'proposed one', 'rejected one'])
  })
})

function postCtx(opts: { env: Record<string, unknown>; publisher?: PublisherRow; body?: unknown }) {
  return {
    request: new Request('https://localhost/api/v1/publish/events', {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env: opts.env,
    params: {} as Record<string, string | string[]>,
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/events',
  } as unknown as Parameters<typeof eventsPost>[0]
}

const CREATE = {
  title: 'Hurricane Lena',
  source: { name: 'NASA EONET', url: 'https://eonet.gsfc.nasa.gov/events/EONET_6001', publishedAt: '2026-06-25T00:00:00Z' },
  feedId: 'eonet',
  externalId: 'EONET_6001',
  occurredStart: '2026-06-25T12:00:00Z',
  geometry: { point: { lat: 29, lon: -89 } },
  keywords: ['hurricane'],
}

describe('POST /api/v1/publish/events', () => {
  it('403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    const res = await eventsPost(postCtx({ env, publisher: PUBLISHER, body: CREATE }))
    expect(res.status).toBe(403)
  })

  it('400 when provenance is missing', async () => {
    const { env } = setupEnv()
    const res = await eventsPost(postCtx({ env, body: { title: 'x' } }))
    expect(res.status).toBe(400)
    const body = JSON.parse(await res.text()) as { errors: Array<{ field: string }> }
    expect(body.errors.some(e => e.field === 'source.url')).toBe(true)
  })

  it('creates a proposed event (201) and runs the matcher', async () => {
    const { env, sqlite } = setupEnv()
    // Make DS000 a live realtime dataset so the temporal matcher proposes
    // a link for an event occurring now.
    sqlite.prepare(`UPDATE datasets SET start_time = ?, period = ? WHERE id = ?`).run('2026-01-01T00:00:00Z', 'PT15M', DS_0)

    const res = await eventsPost(postCtx({ env, body: CREATE }))
    expect(res.status).toBe(201)
    const body = JSON.parse(await res.text()) as { created: boolean; event: { id: string; status: string }; links: Array<{ datasetId: string }> }
    expect(body.created).toBe(true)
    expect(body.event.status).toBe('proposed')
    expect(body.links.map(l => l.datasetId)).toContain(DS_0)

    // Persisted: the link is queryable from the store.
    const links = await listLinksForEvent(env.CATALOG_DB, body.event.id)
    expect(links.some(l => l.dataset_id === DS_0 && l.status === 'proposed')).toBe(true)
  })

  it('is idempotent on (feedId, externalId): a re-ingest updates, not duplicates', async () => {
    const { env } = setupEnv()
    const first = await eventsPost(postCtx({ env, body: CREATE }))
    expect(first.status).toBe(201)

    const second = await eventsPost(postCtx({ env, body: { ...CREATE, title: 'Hurricane Lena (updated)' } }))
    expect(second.status).toBe(200)
    const body = JSON.parse(await second.text()) as { created: boolean }
    expect(body.created).toBe(false)

    const all = await listCurrentEvents(env.CATALOG_DB)
    expect(all).toHaveLength(1)
    expect(all[0].title).toBe('Hurricane Lena (updated)')
  })

  it('persists published_at from source.publishedAt', async () => {
    const { env } = setupEnv()
    const res = await eventsPost(postCtx({ env, body: CREATE }))
    expect(res.status).toBe(201)
    const body = JSON.parse(await res.text()) as { event: { source: { publishedAt?: string } } }
    expect(body.event.source.publishedAt).toBe('2026-06-25T00:00:00Z')
  })

  it('400 for a non-http(s) source.url (no javascript:/data: citations)', async () => {
    const { env } = setupEnv()
    const res = await eventsPost(
      postCtx({ env, body: { ...CREATE, source: { name: 'X', url: 'javascript:alert(1)' } } }),
    )
    expect(res.status).toBe(400)
    const body = JSON.parse(await res.text()) as { errors: Array<{ field: string }> }
    expect(body.errors.some(e => e.field === 'source.url')).toBe(true)
  })

  it('drops malformed categories instead of persisting garbage', async () => {
    const { env } = setupEnv()
    const res = await eventsPost(
      postCtx({
        env,
        body: { ...CREATE, categories: { Theme: 'oops', Region: ['Atlantic', 7] }, keywords: ['hurricane', 9] },
      }),
    )
    expect(res.status).toBe(201)
    const body = JSON.parse(await res.text()) as { event: { id: string } }
    const dec = await getEventDecorations(env.CATALOG_DB, body.event.id)
    // "Theme: 'oops'" (non-array) dropped; "Region" keeps only the string.
    expect(dec.categories).toEqual({ Region: ['Atlantic'] })
    expect(dec.keywords).toEqual(['hurricane'])
  })
})
