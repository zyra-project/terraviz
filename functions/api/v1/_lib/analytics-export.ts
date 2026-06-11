/**
 * Analytics export job core — Phase A of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`.
 *
 * Drains one UTC day of telemetry out of Workers Analytics Engine
 * (via the AE SQL API) before the 30–90 day retention window closes,
 * and lands it durably twice:
 *
 *   - **R2 raw archive** — `events/v1/YYYY/MM/DD.ndjson.gz`, one
 *     line per AE row, decoded into named fields by
 *     `analytics-layouts.ts` so the archive stays self-describing
 *     after the positional layout inevitably drifts.
 *   - **D1 rollups** — `analytics_daily`, `analytics_dataset_daily`,
 *     `analytics_spatial_daily` (migration 0019), the query source
 *     for the `/publish/analytics` dashboard's historical window.
 *
 * Counts are sample-weighted (`sum(_sample_interval)`) and therefore
 * estimates; percentiles are computed over the *sampled* values
 * unweighted (a deliberate approximation — AE sampling only kicks in
 * at volumes where the percentile of the sample is an acceptable
 * stand-in for the percentile of the population).
 *
 * Per-day work is idempotent: rollup writes are wrapped in a
 * delete-day-then-insert batch (one D1 transaction) and the R2
 * object is simply overwritten, so a cron retry or an operator
 * re-export converges on the same state.
 *
 * The route wrapper lives at
 * `functions/api/v1/publish/analytics-export.ts`.
 */

import { decodeAeRow, type DecodedEventRow } from './analytics-layouts'

export const DEFAULT_AE_DATASET = 'terraviz_events'
export const ARCHIVE_PREFIX = 'events/v1'
/** AE SQL API hard-caps result sets; we page by hour and treat a
 * full chunk as truncation (surfaced in the summary, not fatal). */
export const AE_CHUNK_LIMIT = 10_000
/** Spatial heatmap bin size in degrees (~55 km at the equator). */
export const SPATIAL_BIN_DEG = 0.5

export interface AeSqlConfig {
  accountId: string
  token: string
  /** AE dataset name; defaults to `terraviz_events`. */
  dataset?: string
}

export interface ExportDaySummary {
  day: string
  /** Decoded AE rows (pre-weighting). */
  rows: number
  /** Rows whose event_type had no layout (archived positionally). */
  unknownRows: number
  /** Hourly chunks that hit AE_CHUNK_LIMIT — possible data loss. */
  truncatedChunks: number
  archiveKey: string
  archiveBytes: number
}

// --- Day arithmetic ('YYYY-MM-DD', UTC) ---

export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const parsed = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function yesterdayUtc(now: Date = new Date()): string {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function archiveKeyFor(day: string): string {
  const [y, m, d] = day.split('-')
  return `${ARCHIVE_PREFIX}/${y}/${m}/${d}.ndjson.gz`
}

// --- AE SQL fetch ---

const AE_COLUMNS = [
  'timestamp',
  '_sample_interval',
  'index1',
  ...Array.from({ length: 20 }, (_, i) => `blob${i + 1}`),
  ...Array.from({ length: 20 }, (_, i) => `double${i + 1}`),
].join(', ')

function hourBounds(day: string, hour: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0')
  const from = `${day} ${pad(hour)}:00:00`
  const to = hour === 23 ? `${addDays(day, 1)} 00:00:00` : `${day} ${pad(hour + 1)}:00:00`
  return { from, to }
}

/**
 * Fetch and decode every AE row for one UTC day, paged as 24 hourly
 * queries (the AE SQL API has no OFFSET; hourly windows keep each
 * result under the row cap at any traffic level this app has seen).
 */
export async function fetchAeDayRows(
  cfg: AeSqlConfig,
  day: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ rows: DecodedEventRow[]; truncatedChunks: number }> {
  const dataset = cfg.dataset ?? DEFAULT_AE_DATASET
  // The dataset name is interpolated into the SQL string (the AE SQL
  // API has no bind parameters). It comes from operator config, but
  // constraining it to a bare identifier keeps a misconfigured (or
  // poisoned) env var from becoming arbitrary SQL.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dataset)) {
    throw new Error(`Invalid AE dataset name ${JSON.stringify(dataset)} — expected a bare identifier.`)
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/analytics_engine/sql`
  const rows: DecodedEventRow[] = []
  let truncatedChunks = 0

  for (let hour = 0; hour < 24; hour++) {
    const { from, to } = hourBounds(day, hour)
    const sql =
      `SELECT ${AE_COLUMNS} FROM ${dataset} ` +
      `WHERE timestamp >= toDateTime('${from}') AND timestamp < toDateTime('${to}') ` +
      `LIMIT ${AE_CHUNK_LIMIT}`
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'text/plain; charset=utf-8',
        Accept: 'application/json',
      },
      body: sql,
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new Error(`AE SQL query failed (${response.status}) for ${day} hour ${hour}: ${detail}`)
    }
    const payload = (await response.json()) as { data?: Record<string, unknown>[] }
    const chunk = payload.data ?? []
    if (chunk.length >= AE_CHUNK_LIMIT) truncatedChunks++
    for (const raw of chunk) rows.push(decodeAeRow(raw))
  }

  return { rows, truncatedChunks }
}

// --- Rollup computation ---

export interface DailyRollupRow {
  day: string
  event_type: string
  environment: string
  internal: number
  country: string
  platform: string
  events_count: number
  sessions_count: number
  metrics: string
}

export interface DatasetRollupRow {
  day: string
  layer_id: string
  environment: string
  loads: number
  trigger_mix: string
  source_mix: string
  load_ms_p50: number | null
  load_ms_p95: number | null
  dwell_ms_sum: number | null
}

export interface SpatialRollupRow {
  day: string
  event_type: string
  environment: string
  layer_id: string
  projection: string
  lat_bin: number
  lon_bin: number
  hits: number
}

export interface DayRollups {
  daily: DailyRollupRow[]
  dataset: DatasetRollupRow[]
  spatial: SpatialRollupRow[]
}

/** Per-event-type numeric field summarized as p50/p95 in
 * `analytics_daily.metrics`. */
const DAILY_METRIC_FIELDS: Record<string, string> = {
  layer_loaded: 'load_ms',
  session_end: 'duration_ms',
  tour_ended: 'duration_ms',
  vr_session_ended: 'duration_ms',
  perf_sample: 'frame_time_p95_ms',
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function binCoord(value: number): number {
  // Snap the floor result to 6 decimals to dodge float dust
  // (e.g. -105.00000000000001) — precision-independent of
  // SPATIAL_BIN_DEG, so changing the bin size can't silently
  // produce off-grid keys.
  return Math.round(Math.floor(value / SPATIAL_BIN_DEG) * SPATIAL_BIN_DEG * 1e6) / 1e6
}

function num(fields: Record<string, string | number | boolean>, key: string): number {
  const v = fields[key]
  return typeof v === 'number' ? v : 0
}

function str(fields: Record<string, string | number | boolean>, key: string): string {
  const v = fields[key]
  return typeof v === 'string' ? v : ''
}

/**
 * Aggregate one day of decoded rows into the three rollup shapes.
 *
 * `analytics_daily` keeps the `internal` dimension; the dataset and
 * spatial rollups *exclude* internal (staff) traffic entirely — they
 * exist to answer "what do real users engage with / look at", and
 * the dashboard's default filters would drop internal rows anyway.
 */
export function computeRollups(rows: DecodedEventRow[], day: string): DayRollups {
  // analytics_daily
  const daily = new Map<
    string,
    {
      row: Omit<DailyRollupRow, 'sessions_count' | 'metrics'>
      sessions: Set<string>
      samples: number[]
    }
  >()
  // analytics_dataset_daily
  const dataset = new Map<
    string,
    {
      row: Pick<DatasetRollupRow, 'day' | 'layer_id' | 'environment' | 'loads'>
      triggers: Record<string, number>
      sources: Record<string, number>
      loadSamples: number[]
      dwellSum: number | null
    }
  >()
  // analytics_spatial_daily
  const spatial = new Map<string, SpatialRollupRow>()

  for (const row of rows) {
    const w = row.sample_interval
    const platform = row.event_type === 'session_start' ? str(row.fields, 'platform') : ''

    const dailyKey = [row.event_type, row.environment, row.internal ? 1 : 0, row.country, platform].join('\u0000')
    let dailyEntry = daily.get(dailyKey)
    if (!dailyEntry) {
      dailyEntry = {
        row: {
          day,
          event_type: row.event_type,
          environment: row.environment,
          internal: row.internal ? 1 : 0,
          country: row.country,
          platform,
          events_count: 0,
        },
        sessions: new Set(),
        samples: [],
      }
      daily.set(dailyKey, dailyEntry)
    }
    dailyEntry.row.events_count += w
    if (row.session_id) dailyEntry.sessions.add(row.session_id)
    const metricField = DAILY_METRIC_FIELDS[row.event_type]
    if (metricField) dailyEntry.samples.push(num(row.fields, metricField))

    if (row.internal) continue // dataset + spatial rollups: real users only

    if (row.event_type === 'layer_loaded' || row.event_type === 'layer_unloaded') {
      const layerId = str(row.fields, 'layer_id')
      if (layerId !== '') {
        const key = [layerId, row.environment].join('\u0000')
        let entry = dataset.get(key)
        if (!entry) {
          entry = {
            row: { day, layer_id: layerId, environment: row.environment, loads: 0 },
            triggers: {},
            sources: {},
            loadSamples: [],
            dwellSum: null,
          }
          dataset.set(key, entry)
        }
        if (row.event_type === 'layer_loaded') {
          entry.row.loads += w
          const trigger = str(row.fields, 'trigger')
          if (trigger) entry.triggers[trigger] = (entry.triggers[trigger] ?? 0) + w
          const source = str(row.fields, 'layer_source')
          if (source) entry.sources[source] = (entry.sources[source] ?? 0) + w
          entry.loadSamples.push(num(row.fields, 'load_ms'))
        } else {
          entry.dwellSum = (entry.dwellSum ?? 0) + num(row.fields, 'dwell_ms') * w
        }
      }
    }

    if (row.event_type === 'camera_settled' || row.event_type === 'map_click') {
      const isCamera = row.event_type === 'camera_settled'
      const lat = num(row.fields, isCamera ? 'center_lat' : 'lat')
      const lon = num(row.fields, isCamera ? 'center_lon' : 'lon')
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        const layerId = isCamera ? str(row.fields, 'layer_id') : ''
        const projection = isCamera ? str(row.fields, 'projection') : ''
        const latBin = binCoord(lat)
        const lonBin = binCoord(lon)
        const key = [row.event_type, row.environment, layerId, projection, latBin, lonBin].join('\u0000')
        const entry = spatial.get(key)
        if (entry) {
          entry.hits += w
        } else {
          spatial.set(key, {
            day,
            event_type: row.event_type,
            environment: row.environment,
            layer_id: layerId,
            projection,
            lat_bin: latBin,
            lon_bin: lonBin,
            hits: w,
          })
        }
      }
    }
  }

  return {
    daily: [...daily.values()].map(({ row, sessions, samples }) => {
      const metrics: Record<string, number> = {}
      const metricField = DAILY_METRIC_FIELDS[row.event_type]
      if (metricField && samples.length > 0) {
        const sorted = [...samples].sort((a, b) => a - b)
        metrics[`${metricField}_p50`] = percentile(sorted, 0.5)
        metrics[`${metricField}_p95`] = percentile(sorted, 0.95)
      }
      return { ...row, sessions_count: sessions.size, metrics: JSON.stringify(metrics) }
    }),
    dataset: [...dataset.values()].map(({ row, triggers, sources, loadSamples, dwellSum }) => {
      const sorted = [...loadSamples].sort((a, b) => a - b)
      return {
        ...row,
        trigger_mix: JSON.stringify(triggers),
        source_mix: JSON.stringify(sources),
        load_ms_p50: sorted.length > 0 ? percentile(sorted, 0.5) : null,
        load_ms_p95: sorted.length > 0 ? percentile(sorted, 0.95) : null,
        dwell_ms_sum: dwellSum,
      }
    }),
    spatial: [...spatial.values()],
  }
}

// --- R2 archive ---

export async function gzipNdjson(lines: string[]): Promise<Uint8Array> {
  const text = lines.length > 0 ? lines.join('\n') + '\n' : ''
  const compressed = new Response(
    new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('gzip')),
  )
  return new Uint8Array(await compressed.arrayBuffer())
}

// --- D1 writes ---

export async function writeRollupsToD1(db: D1Database, day: string, rollups: DayRollups): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM analytics_daily WHERE day = ?`).bind(day),
    db.prepare(`DELETE FROM analytics_dataset_daily WHERE day = ?`).bind(day),
    db.prepare(`DELETE FROM analytics_spatial_daily WHERE day = ?`).bind(day),
  ]
  const insertDaily = `INSERT INTO analytics_daily
    (day, event_type, environment, internal, country, platform, events_count, sessions_count, metrics)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  for (const r of rollups.daily) {
    stmts.push(
      db
        .prepare(insertDaily)
        .bind(r.day, r.event_type, r.environment, r.internal, r.country, r.platform, r.events_count, r.sessions_count, r.metrics),
    )
  }
  const insertDataset = `INSERT INTO analytics_dataset_daily
    (day, layer_id, environment, loads, trigger_mix, source_mix, load_ms_p50, load_ms_p95, dwell_ms_sum)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  for (const r of rollups.dataset) {
    stmts.push(
      db
        .prepare(insertDataset)
        .bind(r.day, r.layer_id, r.environment, r.loads, r.trigger_mix, r.source_mix, r.load_ms_p50, r.load_ms_p95, r.dwell_ms_sum),
    )
  }
  const insertSpatial = `INSERT INTO analytics_spatial_daily
    (day, event_type, environment, layer_id, projection, lat_bin, lon_bin, hits)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  for (const r of rollups.spatial) {
    stmts.push(
      db
        .prepare(insertSpatial)
        .bind(r.day, r.event_type, r.environment, r.layer_id, r.projection, r.lat_bin, r.lon_bin, r.hits),
    )
  }
  await db.batch(stmts)
}

export async function readBookmark(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT last_day FROM analytics_export_state WHERE id = 1`)
    .first<{ last_day: string }>()
  return row?.last_day ?? null
}

/** Advance the bookmark (monotonic — never moves backwards, so an
 * operator re-export of an old day can't rewind the cron). */
export async function advanceBookmark(db: D1Database, day: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO analytics_export_state (id, last_day, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         last_day = excluded.last_day,
         updated_at = excluded.updated_at
       WHERE excluded.last_day > analytics_export_state.last_day`,
    )
    .bind(day, new Date().toISOString())
    .run()
}

// --- Orchestration ---

export interface ExportDayOptions {
  db: D1Database
  r2: R2Bucket
  sql: AeSqlConfig
  day: string
  fetchImpl?: typeof fetch
}

export async function exportDay(options: ExportDayOptions): Promise<ExportDaySummary> {
  const { rows, truncatedChunks } = await fetchAeDayRows(options.sql, options.day, options.fetchImpl)

  const archiveKey = archiveKeyFor(options.day)
  const bytes = await gzipNdjson(rows.map((r) => JSON.stringify(r)))
  await options.r2.put(archiveKey, bytes, {
    httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
  })

  await writeRollupsToD1(options.db, options.day, computeRollups(rows, options.day))

  return {
    day: options.day,
    rows: rows.length,
    unknownRows: rows.filter((r) => r.layout === 'unknown').length,
    truncatedChunks,
    archiveKey,
    archiveBytes: bytes.byteLength,
  }
}
