/**
 * Wire-level tests for POST /api/v1/publish/events/refresh — the
 * on-demand ingestion pull.
 *
 * Coverage: privileged gate (403), 503 when CATALOG_DB is unbound, 502
 * when the feed is unreachable, a 200 success that creates events from
 * a stubbed EONET feed + writes the `event.refreshed` audit row, and
 * idempotency (a second pull refreshes rather than duplicates).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost as refreshPost } from './refresh'
import { asD1, seedFixtures } from '../../_lib/test-helpers'
import { listCurrentEvents } from '../../_lib/events-store'
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
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUBLISHER', email: 'c@e', role: 'publisher', is_admin: 0 }

function setupEnv() {
  const sqlite = seedFixtures({ count: 2 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  return { sqlite, env: { CATALOG_DB: asD1(sqlite) } }
}

function ctx(opts: { env: Record<string, unknown>; publisher?: PublisherRow }) {
  return {
    request: new Request('https://localhost/api/v1/publish/events/refresh', { method: 'POST' }),
    env: opts.env,
    params: {} as Record<string, string | string[]>,
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/events/refresh',
  } as unknown as Parameters<typeof refreshPost>[0]
}

function auditCount(sqlite: ReturnType<typeof seedFixtures>, action: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = ?`).get(action) as { n: number }
  return row.n
}

/** A minimal EONET v3 feed the pure mapper accepts: a stable id, a
 *  title, one geometry with coordinates, and a source url. */
const EONET_FEED = {
  events: [
    {
      id: 'EONET_1001',
      title: 'Wildfire — Example Ridge',
      description: 'A wildfire burning in the example range.',
      categories: [{ id: 'wildfires', title: 'Wildfires' }],
      sources: [{ id: 'IRWIN', url: 'https://eonet.gsfc.nasa.gov/events/EONET_1001' }],
      geometry: [{ date: '2026-06-25T00:00:00Z', type: 'Point', coordinates: [-120.5, 38.2] }],
    },
    {
      id: 'EONET_1002',
      title: 'Tropical Storm — Example Sea',
      sources: [{ id: 'NOAA', url: 'https://eonet.gsfc.nasa.gov/events/EONET_1002' }],
      geometry: [{ date: '2026-06-24T00:00:00Z', type: 'Point', coordinates: [-89, 29] }],
    },
  ],
}

/** Stub the global fetch the route uses to pull the feed. */
function stubFeed(value: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status: ok ? 200 : 502, json: async () => value }) as unknown as Response),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/v1/publish/events/refresh', () => {
  it('403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    stubFeed(EONET_FEED)
    const res = await refreshPost(ctx({ env, publisher: PUBLISHER }))
    expect(res.status).toBe(403)
  })

  it('503 when CATALOG_DB is unbound', async () => {
    stubFeed(EONET_FEED)
    const res = await refreshPost(ctx({ env: {} }))
    expect(res.status).toBe(503)
  })

  it('502 when the feed is unreachable', async () => {
    const { env } = setupEnv()
    stubFeed(null, false) // non-ok feed response
    const res = await refreshPost(ctx({ env }))
    expect(res.status).toBe(502)
    const body = JSON.parse(await res.text()) as { error: string }
    expect(body.error).toBe('feed_unavailable')
  })

  it('pulls the enabled connectors, creates proposed events, and audits the refresh', async () => {
    const { env, sqlite } = setupEnv()
    stubFeed(EONET_FEED)

    const res = await refreshPost(ctx({ env }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as {
      fetched: number
      mappable: number
      created: number
      refreshed: number
      failed: number
      feeds: Array<{ id: string; kind: string; created: number; error?: string }>
    }
    expect(body).toMatchObject({ fetched: 2, mappable: 2, created: 2, refreshed: 0, failed: 0 })
    // The migration-seeded EONET connector is the one enabled feed.
    expect(body.feeds).toHaveLength(1)
    expect(body.feeds[0]).toMatchObject({ id: 'FEED_EONET_DEFAULT', kind: 'eonet', created: 2 })

    const events = await listCurrentEvents(env.CATALOG_DB as Parameters<typeof listCurrentEvents>[0])
    expect(events).toHaveLength(2)
    expect(events.every(e => e.status === 'proposed')).toBe(true)
    expect(auditCount(sqlite, 'event.refreshed')).toBe(1)

    // Run bookkeeping recorded on the connector row.
    const row = sqlite
      .prepare(`SELECT last_run_status, last_run_error FROM feed_connectors WHERE id = ?`)
      .get('FEED_EONET_DEFAULT') as { last_run_status: string; last_run_error: string | null }
    expect(row).toMatchObject({ last_run_status: 'ok', last_run_error: null })
  })

  it('records the failure on the connector row when its feed is down', async () => {
    const { env, sqlite } = setupEnv()
    stubFeed(null, false)
    await refreshPost(ctx({ env }))
    const row = sqlite
      .prepare(`SELECT last_run_status, last_run_error FROM feed_connectors WHERE id = ?`)
      .get('FEED_EONET_DEFAULT') as { last_run_status: string; last_run_error: string | null }
    expect(row.last_run_status).toBe('error')
    expect(row.last_run_error).toContain('502')
  })

  it('skips a disabled connector (200 with zeros when none are enabled)', async () => {
    const { env, sqlite } = setupEnv()
    sqlite.prepare(`UPDATE feed_connectors SET enabled = 0 WHERE id = ?`).run('FEED_EONET_DEFAULT')
    stubFeed(EONET_FEED)
    const res = await refreshPost(ctx({ env }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { created: number; feeds: unknown[] }
    expect(body.created).toBe(0)
    expect(body.feeds).toHaveLength(0)
  })

  it('skips a connector of unknown kind with a recorded error, without failing the run', async () => {
    const { env, sqlite } = setupEnv()
    sqlite
      .prepare(
        `INSERT INTO feed_connectors (id, kind, label, url, category, enabled, created_at, updated_at)
         VALUES ('FEED_FUTURE', 'rss', 'Future feed', 'https://example.org/feed.xml', 'news', 1,
                 '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
      )
      .run()
    stubFeed(EONET_FEED)
    const res = await refreshPost(ctx({ env }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as {
      created: number
      feeds: Array<{ id: string; error?: string }>
    }
    // EONET still ingests; the unknown-kind row reports its error.
    expect(body.created).toBe(2)
    const future = body.feeds.find(f => f.id === 'FEED_FUTURE')
    expect(future?.error).toContain('unknown connector kind')
    const row = sqlite
      .prepare(`SELECT last_run_status FROM feed_connectors WHERE id = 'FEED_FUTURE'`)
      .get() as { last_run_status: string }
    expect(row.last_run_status).toBe('error')
  })

  it('is idempotent — a second pull refreshes instead of duplicating', async () => {
    const { env } = setupEnv()
    stubFeed(EONET_FEED)

    const first = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as { created: number }
    expect(first.created).toBe(2)

    const second = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as { created: number; refreshed: number }
    expect(second.created).toBe(0)
    expect(second.refreshed).toBe(2)

    const events = await listCurrentEvents(env.CATALOG_DB as Parameters<typeof listCurrentEvents>[0])
    expect(events).toHaveLength(2)
  })
})
