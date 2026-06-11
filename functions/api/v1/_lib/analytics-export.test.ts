/**
 * Tests for the analytics export job (Phase A of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`):
 *
 *   - `computeRollups` aggregation math — sample weighting, session
 *     counting, platform stamping, internal-traffic exclusion from
 *     the dataset/spatial rollups, trigger/source mixes, dwell
 *     sums, percentile metrics, 0.5° spatial binning (including
 *     negative coordinates).
 *   - `exportDay` end-to-end against a mocked AE SQL API, an
 *     in-memory R2, and the real migrated D1 façade — archive key,
 *     gzip NDJSON content, rollup rows landed, idempotent re-run.
 *   - The route handler — config/privilege gating, ?day validation,
 *     bookmark walk + monotonic advance, partial-failure 502.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addDays,
  advanceBookmark,
  archiveKeyFor,
  computeRollups,
  exportDay,
  gzipNdjson,
  isValidDay,
  readBookmark,
  yesterdayUtc,
} from './analytics-export'
import type { DecodedEventRow } from './analytics-layouts'
import { onRequestPost as exportPost, MAX_DAYS_PER_RUN } from '../publish/analytics-export'
import { asD1, seedFixtures } from './test-helpers'
import type { PublisherRow } from './publisher-store'

const DAY = '2026-06-10'

function decoded(partial: Partial<DecodedEventRow> & { event_type: string }): DecodedEventRow {
  return {
    timestamp: `${DAY} 12:00:00`,
    environment: 'production',
    country: 'US',
    internal: false,
    session_id: 'sess-1',
    sample_interval: 1,
    layout: 'named',
    fields: {},
    ...partial,
  }
}

async function gunzipLines(bytes: Uint8Array): Promise<string[]> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  const text = await new Response(stream).text()
  return text.split('\n').filter((l) => l.length > 0)
}

describe('day arithmetic', () => {
  it('validates and advances YYYY-MM-DD days in UTC', () => {
    expect(isValidDay('2026-06-10')).toBe(true)
    expect(isValidDay('2026-6-10')).toBe(false)
    expect(isValidDay('2026-02-30')).toBe(false)
    expect(isValidDay('yesterday')).toBe(false)
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(yesterdayUtc(new Date('2026-06-11T00:30:00Z'))).toBe('2026-06-10')
  })

  it('builds the day-partitioned archive key', () => {
    expect(archiveKeyFor('2026-06-10')).toBe('events/v1/2026/06/10.ndjson.gz')
  })
})

describe('computeRollups', () => {
  it('weights event counts by sample_interval and counts distinct sessions', () => {
    const rollups = computeRollups(
      [
        decoded({ event_type: 'browse_opened', session_id: 'a', sample_interval: 4 }),
        decoded({ event_type: 'browse_opened', session_id: 'a' }),
        decoded({ event_type: 'browse_opened', session_id: 'b' }),
      ],
      DAY,
    )
    expect(rollups.daily).toHaveLength(1)
    expect(rollups.daily[0].events_count).toBe(6)
    expect(rollups.daily[0].sessions_count).toBe(2)
    expect(rollups.daily[0].platform).toBe('')
  })

  it('splits daily groups by envelope dimensions and stamps platform from session_start', () => {
    const rollups = computeRollups(
      [
        decoded({ event_type: 'session_start', fields: { platform: 'web' } }),
        decoded({ event_type: 'session_start', fields: { platform: 'desktop' } }),
        decoded({ event_type: 'session_start', fields: { platform: 'web' }, internal: true }),
        decoded({ event_type: 'session_start', fields: { platform: 'web' }, country: 'JP' }),
      ],
      DAY,
    )
    expect(rollups.daily).toHaveLength(4)
    const web = rollups.daily.find((r) => r.platform === 'web' && r.internal === 0 && r.country === 'US')
    expect(web?.events_count).toBe(1)
  })

  it('computes p50/p95 metrics for configured event types', () => {
    const rows = [100, 200, 300, 400, 1000].map((load_ms) =>
      decoded({ event_type: 'layer_loaded', fields: { layer_id: 'DS1', trigger: 'browse', layer_source: 'hls', load_ms } }),
    )
    const rollups = computeRollups(rows, DAY)
    const metrics = JSON.parse(rollups.daily[0].metrics) as Record<string, number>
    expect(metrics.load_ms_p50).toBe(300)
    expect(metrics.load_ms_p95).toBeCloseTo(880, 0)
  })

  it('aggregates dataset engagement with trigger/source mixes and dwell sums', () => {
    const rollups = computeRollups(
      [
        decoded({ event_type: 'layer_loaded', fields: { layer_id: 'DS1', trigger: 'browse', layer_source: 'hls', load_ms: 100 } }),
        decoded({ event_type: 'layer_loaded', fields: { layer_id: 'DS1', trigger: 'orbit', layer_source: 'cache', load_ms: 50 }, sample_interval: 2 }),
        decoded({ event_type: 'layer_unloaded', fields: { layer_id: 'DS1', dwell_ms: 60_000 } }),
        // Internal traffic — excluded from dataset rollups entirely.
        decoded({ event_type: 'layer_loaded', fields: { layer_id: 'DS1', trigger: 'url', layer_source: 'image', load_ms: 1 }, internal: true }),
      ],
      DAY,
    )
    expect(rollups.dataset).toHaveLength(1)
    const ds = rollups.dataset[0]
    expect(ds.layer_id).toBe('DS1')
    expect(ds.loads).toBe(3)
    expect(JSON.parse(ds.trigger_mix)).toEqual({ browse: 1, orbit: 2 })
    expect(JSON.parse(ds.source_mix)).toEqual({ hls: 1, cache: 2 })
    expect(ds.dwell_ms_sum).toBe(60_000)
    expect(ds.load_ms_p50).toBe(75)
  })

  it('bins spatial events at 0.5 degrees, keyed by dataset and projection', () => {
    const rollups = computeRollups(
      [
        decoded({ event_type: 'camera_settled', fields: { center_lat: 39.739, center_lon: -104.99, layer_id: 'DS1', projection: 'globe' } }),
        decoded({ event_type: 'camera_settled', fields: { center_lat: 39.9, center_lon: -104.7, layer_id: 'DS1', projection: 'globe' }, sample_interval: 3 }),
        decoded({ event_type: 'camera_settled', fields: { center_lat: 39.739, center_lon: -104.99, layer_id: 'DS1', projection: 'vr' } }),
        decoded({ event_type: 'map_click', fields: { lat: 35.011, lon: 135.768, hit_kind: 'surface' } }),
        // Internal — excluded.
        decoded({ event_type: 'camera_settled', fields: { center_lat: 1, center_lon: 1, layer_id: '', projection: 'globe' }, internal: true }),
        // Garbage coordinates — skipped.
        decoded({ event_type: 'map_click', fields: { lat: 999, lon: 0 } }),
      ],
      DAY,
    )
    expect(rollups.spatial).toHaveLength(3)
    const denver = rollups.spatial.find((r) => r.projection === 'globe' && r.layer_id === 'DS1')
    expect(denver).toMatchObject({ lat_bin: 39.5, lon_bin: -105, hits: 4 })
    const gaze = rollups.spatial.find((r) => r.projection === 'vr')
    expect(gaze?.hits).toBe(1)
    const click = rollups.spatial.find((r) => r.event_type === 'map_click')
    expect(click).toMatchObject({ lat_bin: 35, lon_bin: 135.5, layer_id: '', projection: '' })
  })
})

// --- exportDay end-to-end ---

interface FakeR2Store {
  objects: Map<string, Uint8Array>
  bucket: R2Bucket
}

function makeR2(): FakeR2Store {
  const objects = new Map<string, Uint8Array>()
  const bucket = {
    put: async (key: string, value: ArrayBuffer | Uint8Array) => {
      objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value))
      return {} as R2Object
    },
  } as unknown as R2Bucket
  return { objects, bucket }
}

/** AE SQL rows for a `layer_loaded` (positional layout: blob5
 * layer_id, blob6 layer_source, blob7 slot_index, blob8 trigger;
 * double1 client_offset_ms, double2 load_ms). */
function aeLayerLoadedRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    timestamp: `${DAY} 12:34:56`,
    _sample_interval: 1,
    index1: 'sess-1',
    blob1: 'layer_loaded',
    blob2: 'production',
    blob3: 'US',
    blob4: 'false',
    blob5: 'DS1',
    blob6: 'hls',
    blob7: '0',
    blob8: 'browse',
    double1: 5000,
    double2: 1234,
    ...overrides,
  }
}

function mockAeFetch(rowsByHour: Record<number, Record<string, unknown>[]>): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const sql = String(init?.body ?? '')
    const hourMatch = /timestamp >= toDateTime\('\d{4}-\d{2}-\d{2} (\d{2}):00:00'\)/.exec(sql)
    const hour = hourMatch ? parseInt(hourMatch[1], 10) : -1
    return new Response(JSON.stringify({ data: rowsByHour[hour] ?? [] }), { status: 200 })
  }) as typeof fetch
}

function makeDb() {
  return asD1(seedFixtures({ count: 0 }))
}

const SQL_CFG = { accountId: 'acct', token: 'tok' }

describe('exportDay', () => {
  it('archives decoded NDJSON to R2 and lands rollups in D1', async () => {
    const db = makeDb()
    const r2 = makeR2()
    const summary = await exportDay({
      db,
      r2: r2.bucket,
      sql: SQL_CFG,
      day: DAY,
      fetchImpl: mockAeFetch({ 12: [aeLayerLoadedRow(), aeLayerLoadedRow({ index1: 'sess-2', double2: 100 })] }),
    })

    expect(summary).toMatchObject({ day: DAY, rows: 2, unknownRows: 0, truncatedChunks: 0 })
    expect(summary.archiveKey).toBe('events/v1/2026/06/10.ndjson.gz')

    const lines = await gunzipLines(r2.objects.get(summary.archiveKey)!)
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]) as DecodedEventRow
    expect(first.event_type).toBe('layer_loaded')
    expect(first.layout).toBe('named')
    expect(first.fields).toMatchObject({ layer_id: 'DS1', trigger: 'browse', load_ms: 1234 })

    const daily = await db
      .prepare(`SELECT events_count, sessions_count FROM analytics_daily WHERE day = ? AND event_type = 'layer_loaded'`)
      .bind(DAY)
      .first<{ events_count: number; sessions_count: number }>()
    expect(daily).toMatchObject({ events_count: 2, sessions_count: 2 })

    const dataset = await db
      .prepare(`SELECT loads, load_ms_p50 FROM analytics_dataset_daily WHERE day = ? AND layer_id = 'DS1'`)
      .bind(DAY)
      .first<{ loads: number; load_ms_p50: number }>()
    expect(dataset).toMatchObject({ loads: 2, load_ms_p50: 667 })
  })

  it('is idempotent — a re-export replaces the day rather than accumulating', async () => {
    const db = makeDb()
    const r2 = makeR2()
    const fetchImpl = mockAeFetch({ 12: [aeLayerLoadedRow()] })
    await exportDay({ db, r2: r2.bucket, sql: SQL_CFG, day: DAY, fetchImpl })
    await exportDay({ db, r2: r2.bucket, sql: SQL_CFG, day: DAY, fetchImpl })

    const row = await db
      .prepare(`SELECT COUNT(*) AS n, SUM(events_count) AS total FROM analytics_daily WHERE day = ?`)
      .bind(DAY)
      .first<{ n: number; total: number }>()
    expect(row).toMatchObject({ n: 1, total: 1 })
  })

  it('throws on an AE SQL error without touching storage', async () => {
    const db = makeDb()
    const r2 = makeR2()
    const failingFetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
    await expect(
      exportDay({ db, r2: r2.bucket, sql: SQL_CFG, day: DAY, fetchImpl: failingFetch }),
    ).rejects.toThrow(/AE SQL query failed \(500\)/)
    expect(r2.objects.size).toBe(0)
  })
})

describe('bookmark', () => {
  it('advances monotonically and never rewinds', async () => {
    const db = makeDb()
    expect(await readBookmark(db)).toBeNull()
    await advanceBookmark(db, '2026-06-10')
    expect(await readBookmark(db)).toBe('2026-06-10')
    await advanceBookmark(db, '2026-06-12')
    expect(await readBookmark(db)).toBe('2026-06-12')
    await advanceBookmark(db, '2026-06-01')
    expect(await readBookmark(db)).toBe('2026-06-12')
  })
})

describe('gzipNdjson', () => {
  it('round-trips lines through gzip', async () => {
    const lines = ['{"a":1}', '{"b":2}']
    expect(await gunzipLines(await gzipNdjson(lines))).toEqual(lines)
  })

  it('produces a valid empty archive for a day with no rows', async () => {
    expect(await gunzipLines(await gzipNdjson([]))).toEqual([])
  })
})

// --- Route handler ---

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

function setupRouteEnv() {
  const sqlite = seedFixtures({ count: 0 })
  for (const p of [STAFF, COMMUNITY]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  const r2 = makeR2()
  return {
    sqlite,
    r2,
    env: {
      CATALOG_DB: asD1(sqlite),
      ANALYTICS_R2: r2.bucket,
      CF_ACCOUNT_ID: 'acct',
      ANALYTICS_SQL_TOKEN: 'tok',
    },
  }
}

function ctx(opts: { env: Record<string, unknown>; publisher?: PublisherRow; query?: string }) {
  return {
    request: new Request(`https://localhost/api/v1/publish/analytics-export${opts.query ?? ''}`, { method: 'POST' }),
    env: opts.env,
    params: {},
    data: { publisher: opts.publisher ?? STAFF },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/analytics-export',
  } as unknown as Parameters<typeof exportPost>[0]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/v1/publish/analytics-export', () => {
  it('503s with the missing pieces named when unconfigured', async () => {
    const { env } = setupRouteEnv()
    const response = await exportPost(ctx({ env: { CATALOG_DB: env.CATALOG_DB } }))
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string; message: string }
    expect(body.error).toBe('export_unconfigured')
    expect(body.message).toContain('ANALYTICS_R2')
    expect(body.message).toContain('CF_ACCOUNT_ID')
    expect(body.message).not.toContain('CATALOG_DB')
  })

  it('403s for community publishers', async () => {
    const { env } = setupRouteEnv()
    const response = await exportPost(ctx({ env, publisher: COMMUNITY }))
    expect(response.status).toBe(403)
  })

  it('400s on a malformed or future ?day', async () => {
    const { env } = setupRouteEnv()
    vi.stubGlobal('fetch', mockAeFetch({}))
    for (const query of ['?day=tomorrow', `?day=${addDays(yesterdayUtc(), 1)}`]) {
      const response = await exportPost(ctx({ env, query }))
      expect(response.status, query).toBe(400)
    }
  })

  it('walks the bookmark through yesterday and records an audit row', async () => {
    const { env, sqlite } = setupRouteEnv()
    vi.stubGlobal('fetch', mockAeFetch({ 12: [aeLayerLoadedRow()] }))
    const yesterday = yesterdayUtc()
    await advanceBookmark(env.CATALOG_DB, addDays(yesterday, -3))

    const response = await exportPost(ctx({ env }))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { exported: ExportDaySummaryShape[] }
    expect(body.exported.map(d => d.day)).toEqual([
      addDays(yesterday, -2),
      addDays(yesterday, -1),
      yesterday,
    ])
    expect(await readBookmark(env.CATALOG_DB)).toBe(yesterday)

    const audit = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'analytics.export'`)
      .get() as { n: number }
    expect(audit.n).toBe(1)

    // Caught up — the next tick is a no-op.
    const second = await exportPost(ctx({ env }))
    expect(((await second.json()) as { exported: unknown[] }).exported).toEqual([])
  })

  it('caps a long catch-up at MAX_DAYS_PER_RUN', async () => {
    const { env } = setupRouteEnv()
    vi.stubGlobal('fetch', mockAeFetch({}))
    const yesterday = yesterdayUtc()
    await advanceBookmark(env.CATALOG_DB, addDays(yesterday, -30))

    const response = await exportPost(ctx({ env }))
    const body = (await response.json()) as { exported: ExportDaySummaryShape[] }
    expect(body.exported).toHaveLength(MAX_DAYS_PER_RUN)
    expect(await readBookmark(env.CATALOG_DB)).toBe(addDays(yesterday, -30 + MAX_DAYS_PER_RUN))
  })

  it('does not move the bookmark on an explicit ?day re-export', async () => {
    const { env } = setupRouteEnv()
    vi.stubGlobal('fetch', mockAeFetch({ 12: [aeLayerLoadedRow()] }))
    const yesterday = yesterdayUtc()
    await advanceBookmark(env.CATALOG_DB, yesterday)

    const response = await exportPost(ctx({ env, query: `?day=${addDays(yesterday, -10)}` }))
    expect(response.status).toBe(200)
    expect(await readBookmark(env.CATALOG_DB)).toBe(yesterday)
  })

  it('502s with partial progress preserved when AE fails mid-run', async () => {
    const { env } = setupRouteEnv()
    const yesterday = yesterdayUtc()
    await advanceBookmark(env.CATALOG_DB, addDays(yesterday, -2))
    // First day's 24 hourly queries succeed; then AE starts failing.
    let calls = 0
    vi.stubGlobal('fetch', (async () => {
      calls++
      if (calls <= 24) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      return new Response('upstream sad', { status: 500 })
    }) as typeof fetch)

    const response = await exportPost(ctx({ env }))
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string; day: string; exported: ExportDaySummaryShape[] }
    expect(body.error).toBe('export_failed')
    expect(body.day).toBe(yesterday)
    expect(body.exported.map(d => d.day)).toEqual([addDays(yesterday, -1)])
    // Bookmark kept the completed day, so the retry resumes there.
    expect(await readBookmark(env.CATALOG_DB)).toBe(addDays(yesterday, -1))
  })
})

interface ExportDaySummaryShape {
  day: string
}
