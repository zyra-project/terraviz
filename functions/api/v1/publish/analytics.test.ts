/**
 * Wire-level tests for GET /api/v1/publish/analytics (Phase B of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`).
 *
 * Coverage:
 *   - 503 when CATALOG_DB is unbound; 403 for community callers.
 *   - 400 on unknown section / days / environment / projection.
 *   - Section payloads computed from seeded rollup rows: overview
 *     day series + platform/country mixes + internal exclusion,
 *     dataset top-N with merged JSON mixes and loads-weighted
 *     percentile averages, spatial bin filtering by layer /
 *     projection / event, funnel day series.
 *   - The `days` range cuts old rows; KV caching round-trips.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet as analyticsGet } from './analytics'
import { addDays, yesterdayUtc } from '../_lib/analytics-export'
import { asD1, makeKV, seedFixtures } from '../_lib/test-helpers'
import type { PublisherRow } from '../_lib/publisher-store'

const STAFF: PublisherRow = {
  id: 'PUB-STAFF',
  email: 'staff@example.com',
  display_name: 'Staff',
  affiliation: null,
  org_id: null,
  role: 'staff',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const COMMUNITY: PublisherRow = { ...STAFF, id: 'PUB-COMM', email: 'c@e', role: 'community', is_admin: 0 }

// Seeded by `seedFixtures({ count: 2 })`: "Test Dataset 0/1".
const DS_A = 'DS000' + 'A'.repeat(21)
const DS_B = 'DS001' + 'A'.repeat(21)
/** Stamped as DS_B's legacy_id — telemetry that predates the catalog
 * cutover carries legacy SOS ids. */
const LEGACY = 'INTERNAL_SOS_768'

const YESTERDAY = yesterdayUtc()
const OLD_DAY = addDays(YESTERDAY, -40) // inside days=90, outside days=30

function setup() {
  const sqlite = seedFixtures({ count: 2 })
  sqlite.prepare(`UPDATE datasets SET legacy_id = ? WHERE id = ?`).run(LEGACY, DS_B)
  const insertDaily = sqlite.prepare(
    `INSERT INTO analytics_daily (day, event_type, environment, internal, country, platform, events_count, sessions_count, metrics)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  )
  // Yesterday, production, external traffic.
  insertDaily.run(YESTERDAY, 'session_start', 'production', 0, 'US', 'web', 10, 10)
  insertDaily.run(YESTERDAY, 'session_start', 'production', 0, 'JP', 'desktop', 4, 4)
  insertDaily.run(YESTERDAY, 'error', 'production', 0, 'US', '', 3, 2)
  insertDaily.run(YESTERDAY, 'tour_started', 'production', 0, 'US', '', 6, 3)
  insertDaily.run(YESTERDAY, 'tour_ended', 'production', 0, 'US', '', 4, 3)
  insertDaily.run(YESTERDAY, 'vr_session_started', 'production', 0, 'US', '', 2, 2)
  insertDaily.run(YESTERDAY, 'orbit_turn', 'production', 0, 'US', '', 20, 5)
  sqlite
    .prepare(
      `INSERT INTO analytics_daily (day, event_type, environment, internal, country, platform, events_count, sessions_count, metrics)
       VALUES (?, 'session_end', 'production', 0, 'US', '', 12, 12, ?)`,
    )
    .run(YESTERDAY, '{"duration_ms_sum":900000,"visible_ms_sum":600000,"duration_ms_p50":50000}')
  const insertOutcome = sqlite.prepare(
    `INSERT INTO analytics_outcomes_daily (day, environment, event_type, value, count)
     VALUES (?, ?, ?, ?, ?)`,
  )
  insertOutcome.run(YESTERDAY, 'production', 'tour_ended', 'completed', 3)
  insertOutcome.run(YESTERDAY, 'production', 'tour_ended', 'abandoned', 1)
  insertOutcome.run(YESTERDAY, 'production', 'vr_session_started', 'ar', 2)
  insertOutcome.run(YESTERDAY, 'preview', 'tour_ended', 'completed', 9)
  // Internal traffic — must be excluded.
  insertDaily.run(YESTERDAY, 'session_start', 'production', 1, 'US', 'web', 99, 99)
  // Preview environment — excluded under environment=production.
  insertDaily.run(YESTERDAY, 'session_start', 'preview', 0, 'US', 'web', 50, 50)
  // Old day — included at days=90, excluded at days=30... only if
  // OLD_DAY is actually older than 30 days, which it is (-40).
  insertDaily.run(OLD_DAY, 'session_start', 'production', 0, 'US', 'web', 7, 7)

  const insertDataset = sqlite.prepare(
    `INSERT INTO analytics_dataset_daily (day, layer_id, environment, loads, trigger_mix, source_mix, load_ms_p50, load_ms_p95, dwell_ms_sum)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertDataset.run(YESTERDAY, DS_A, 'production', 6, '{"browse":4,"orbit":2}', '{"hls":6}', 200, 900, 120000)
  insertDataset.run(addDays(YESTERDAY, -1), DS_A, 'production', 2, '{"tour":2}', '{"cache":2}', 400, 1100, null)
  insertDataset.run(YESTERDAY, LEGACY, 'production', 1, '{"url":1}', '{"image":1}', 50, 60, 5000)
  // A layer id that resolves to no catalog row — title stays null.
  insertDataset.run(YESTERDAY, 'DS_GONE', 'production', 0.5, '{}', '{}', null, null, null)

  const insertSpatial = sqlite.prepare(
    `INSERT INTO analytics_spatial_daily (day, event_type, environment, layer_id, projection, lat_bin, lon_bin, hits)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertSpatial.run(YESTERDAY, 'camera_settled', 'production', DS_A, 'globe', 39.5, -105, 4)
  insertSpatial.run(addDays(YESTERDAY, -1), 'camera_settled', 'production', DS_A, 'globe', 39.5, -105, 2)
  insertSpatial.run(YESTERDAY, 'camera_settled', 'production', DS_A, 'vr', 35, 135.5, 1)
  insertSpatial.run(YESTERDAY, 'camera_settled', 'production', '', 'globe', 0, 0, 9)
  insertSpatial.run(YESTERDAY, 'map_click', 'production', '', '', 51.5, 0, 3)

  for (const p of [STAFF, COMMUNITY]) {
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

function ctx(opts: { env: Record<string, unknown>; publisher?: PublisherRow; query: string }) {
  return {
    request: new Request(`https://localhost/api/v1/publish/analytics${opts.query}`, { method: 'GET' }),
    env: opts.env,
    params: {},
    data: { publisher: opts.publisher ?? STAFF },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/analytics',
  } as unknown as Parameters<typeof analyticsGet>[0]
}

async function getData<T>(env: Record<string, unknown>, query: string): Promise<T> {
  const response = await analyticsGet(ctx({ env, query }))
  expect(response.status).toBe(200)
  const body = (await response.json()) as { data: T }
  return body.data
}

describe('GET /api/v1/publish/analytics', () => {
  it('503s without CATALOG_DB and 403s for community callers', async () => {
    const { env } = setup()
    expect((await analyticsGet(ctx({ env: {}, query: '?section=overview' }))).status).toBe(503)
    expect(
      (await analyticsGet(ctx({ env, publisher: COMMUNITY, query: '?section=overview' }))).status,
    ).toBe(403)
  })

  it('400s on invalid parameters', async () => {
    const { env } = setup()
    for (const query of [
      '',
      '?section=sql',
      '?section=overview&days=14',
      '?section=overview&environment=staging',
      '?section=spatial&projection=cylindrical',
      '?section=spatial&event=dwell',
    ]) {
      expect((await analyticsGet(ctx({ env, query }))).status, query).toBe(400)
    }
  })

  it('overview: day series, mixes, totals — external production traffic only', async () => {
    const { env } = setup()
    const data = await getData<{
      days: Array<{ day: string; sessions: number; events: number; errors: number; view_ms: number }>
      platforms: Record<string, number>
      countries: Array<{ country: string; sessions: number }>
      totals: { sessions: number; events: number; errors: number; view_ms: number }
    }>(env, '?section=overview&days=90')

    expect(data.days.map(d => d.day)).toEqual([OLD_DAY, YESTERDAY])
    const yday = data.days[1]
    expect(yday.sessions).toBe(14) // 10 web + 4 desktop; internal 99 + preview 50 excluded
    expect(yday.errors).toBe(3)
    expect(yday.view_ms).toBe(600000) // from session_end metrics JSON
    expect(data.platforms).toEqual({ web: 17, desktop: 4 }) // includes OLD_DAY web 7
    expect(data.countries[0]).toEqual({ country: 'US', sessions: 17 })
    expect(data.totals.sessions).toBe(21)
    expect(data.totals.view_ms).toBe(600000)
  })

  it('overview: the days window excludes older rows', async () => {
    const { env } = setup()
    const data = await getData<{ days: Array<{ day: string }> }>(env, '?section=overview&days=30')
    expect(data.days.map(d => d.day)).toEqual([YESTERDAY])
  })

  it('datasets: merges JSON mixes and weights percentile averages by loads', async () => {
    const { env } = setup()
    const data = await getData<{
      datasets: Array<{
        layer_id: string
        title: string | null
        loads: number
        trigger_mix: Record<string, number>
        source_mix: Record<string, number>
        load_ms_p50: number | null
        dwell_ms_sum: number
      }>
    }>(env, '?section=datasets&days=30')

    expect(data.datasets.map(d => d.layer_id)).toEqual([DS_A, LEGACY, 'DS_GONE'])
    // Titles resolve via datasets.id, via legacy_id, or not at all.
    expect(data.datasets.map(d => d.title)).toEqual(['Test Dataset 0', 'Test Dataset 1', null])
    const ds1 = data.datasets[0]
    expect(ds1.loads).toBe(8)
    expect(ds1.trigger_mix).toEqual({ browse: 4, orbit: 2, tour: 2 })
    expect(ds1.source_mix).toEqual({ hls: 6, cache: 2 })
    // (200*6 + 400*2) / 8 = 250
    expect(ds1.load_ms_p50).toBe(250)
    expect(ds1.dwell_ms_sum).toBe(120000)
  })

  it('spatial: sums bins across days and filters by layer/projection/event', async () => {
    const { env } = setup()
    const all = await getData<{
      layers: Array<{ id: string; title: string | null }>
      bins: Array<{ lat: number; lon: number; hits: number }>
    }>(env, '?section=spatial&days=30')
    expect(all.layers).toEqual([
      { id: '', title: null },
      { id: DS_A, title: 'Test Dataset 0' },
    ])
    // camera_settled only (map_click excluded by default event).
    expect(all.bins).toHaveLength(3)
    expect(all.bins.find(b => b.lat === 39.5)?.hits).toBe(6) // 4 + 2 across days

    const ds1Globe = await getData<{ bins: unknown[] }>(
      env,
      `?section=spatial&days=30&layer=${DS_A}&projection=globe`,
    )
    expect(ds1Globe.bins).toHaveLength(1)

    const defaultEarth = await getData<{ bins: Array<{ hits: number }> }>(
      env,
      '?section=spatial&days=30&layer=',
    )
    expect(defaultEarth.bins).toHaveLength(1)
    expect(defaultEarth.bins[0].hits).toBe(9)

    const clicks = await getData<{ bins: Array<{ lat: number }> }>(
      env,
      '?section=spatial&days=30&event=map_click',
    )
    expect(clicks.bins).toEqual([{ lat: 51.5, lon: 0, hits: 3 }])
  })

  it('errors: frequency-ordered breakdown over the range', async () => {
    const { env, sqlite } = setup()
    const insertErrors = sqlite.prepare(
      `INSERT INTO analytics_errors_daily (day, environment, category, source, code, message_class, count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    insertErrors.run(YESTERDAY, 'production', 'hls', 'caught', '404', 'manifest fetch failed', 5)
    insertErrors.run(addDays(YESTERDAY, -1), 'production', 'hls', 'caught', '404', 'manifest fetch failed', 2)
    insertErrors.run(YESTERDAY, 'production', 'tile', 'caught', '500', 'tile error', 3)
    insertErrors.run(YESTERDAY, 'preview', 'llm', 'caught', '429', 'rate limited', 9)

    const data = await getData<{ errors: Array<Record<string, unknown>> }>(env, '?section=errors&days=30')
    expect(data.errors).toEqual([
      { category: 'hls', source: 'caught', code: '404', message_class: 'manifest fetch failed', count: 7 },
      { category: 'tile', source: 'caught', code: '500', message_class: 'tile error', count: 3 },
    ])
  })

  it('funnel: per-day tour / VR / orbit counts', async () => {
    const { env } = setup()
    const data = await getData<{
      days: Array<Record<string, unknown>>
      outcomes: { tour_ended: Record<string, number>; vr_session_started: Record<string, number> }
    }>(env, '?section=funnel&days=30')
    expect(data.days).toEqual([
      { day: YESTERDAY, tours_started: 6, tours_ended: 4, vr_started: 2, orbit_turns: 20 },
    ])
    // Preview-environment outcomes excluded under environment=production.
    expect(data.outcomes.tour_ended).toEqual({ completed: 3, abandoned: 1 })
    expect(data.outcomes.vr_session_started).toEqual({ ar: 2 })
  })

  it('serves the second identical request from KV', async () => {
    const { env, kv } = setup()
    const first = await analyticsGet(ctx({ env, query: '?section=overview&days=30' }))
    expect(first.headers.get('X-Cache')).toBe('miss')
    const second = await analyticsGet(ctx({ env, query: '?section=overview&days=30' }))
    expect(second.headers.get('X-Cache')).toBe('hit')
    expect(await second.json()).toEqual(await first.json())
    // Different filters miss again.
    const other = await analyticsGet(ctx({ env, query: '?section=overview&days=90' }))
    expect(other.headers.get('X-Cache')).toBe('miss')
    expect(kv._store.size).toBe(2)
  })
})
