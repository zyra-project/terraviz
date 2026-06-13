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

export interface OutcomesRollupRow {
  day: string
  environment: string
  event_type: string
  value: string
  count: number
}

export interface ErrorsRollupRow {
  day: string
  environment: string
  category: string
  source: string
  code: string
  message_class: string
  count: number
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

export interface PerfRollupRow {
  day: string
  environment: string
  surface: string
  renderer: string
  samples: number
  fps_sum: number
  frame_p95_sum: number
  jsheap_sum: number
  jsheap_samples: number
}

export interface OrbitRollupRow {
  day: string
  environment: string
  model: string
  turns: number
  rounds_sum: number
  input_tokens_sum: number
  output_tokens_sum: number
  duration_ms_sum: number
}

export interface QuizRollupRow {
  day: string
  environment: string
  tour_id: string
  question_id: string
  answered: number
  correct: number
  response_ms_sum: number
}

export interface DimensionRollupRow {
  day: string
  environment: string
  metric: string
  key: string
  count: number
  value_sum: number
}

export interface DayRollups {
  daily: DailyRollupRow[]
  dataset: DatasetRollupRow[]
  spatial: SpatialRollupRow[]
  errors: ErrorsRollupRow[]
  outcomes: OutcomesRollupRow[]
  perf: PerfRollupRow[]
  orbit: OrbitRollupRow[]
  quiz: QuizRollupRow[]
  dimensions: DimensionRollupRow[]
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

/** Per-event-type numeric fields summed (weighted) into
 * `analytics_daily.metrics` as `<field>_sum`. Sums compose across
 * groups and days — unlike percentiles — so the dashboard can show
 * totals and true averages (Σvisible / Σsessions) over any range. */
const DAILY_SUM_FIELDS: Record<string, readonly string[]> = {
  session_end: ['duration_ms', 'visible_ms'],
}

/** Low-cardinality dimensions kept per day in
 * `analytics_outcomes_daily` for completion funnels. */
const OUTCOME_FIELDS: Record<string, string> = {
  tour_ended: 'outcome',
  vr_session_started: 'mode',
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

/** Cap on the camera-footprint radius. Bounds the splat to ~25×50
 * cells at high latitudes — keeps the export's CPU cost sane while
 * still letting a zoomed-out view read as a broad wash. */
export const MAX_FOOTPRINT_DEG = 6

/**
 * Camera-attention footprint radius, derived from zoom (the
 * altitude proxy `camera_settled` already carries). In web-mercator
 * terms the visible span halves with each zoom level, so the
 * radius is `90° / 2^zoom`: a zoomed-out globe (z≈0–3) diffuses
 * over a wide cap (clamped to MAX_FOOTPRINT_DEG), a zoomed-in view
 * (z≳7.5) concentrates into a single 0.5° cell. VR/AR sessions
 * report a scale-derived zoom with the same semantics.
 */
export function footprintRadiusDeg(zoom: number): number {
  if (!Number.isFinite(zoom)) return SPATIAL_BIN_DEG
  const raw = 90 / Math.pow(2, Math.max(zoom, 0))
  return Math.min(Math.max(raw, SPATIAL_BIN_DEG), MAX_FOOTPRINT_DEG)
}

/** Wrap a bin-aligned longitude into [-180, 180). Stays on-grid
 * because 360 is a multiple of the bin size. */
function wrapLonBin(lon: number): number {
  let v = lon
  while (v >= 180) v -= 360
  while (v < -180) v += 360
  return Math.round(v * 1e6) / 1e6
}

/**
 * Distribute one event's weight over the bins inside its footprint.
 * Linear-cone kernel (full weight at the center, tapering to zero
 * at the radius), normalized so the cell weights sum to `weight` —
 * total attention mass is conserved, so a diffuse high-altitude
 * view and a concentrated low-altitude one contribute equally to
 * the day's totals, just spread differently. The longitudinal
 * radius is widened by 1/cos(lat) so the footprint stays roughly
 * circular on the ground instead of pinching near the poles.
 */
export function splatFootprint(
  lat: number,
  lon: number,
  radiusDeg: number,
  weight: number,
): Array<{ latBin: number; lonBin: number; w: number }> {
  if (radiusDeg <= SPATIAL_BIN_DEG) {
    return [{ latBin: binCoord(lat), lonBin: wrapLonBin(binCoord(lon)), w: weight }]
  }
  const latRadius = radiusDeg
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.2)
  const lonRadius = radiusDeg / cosLat

  const cells: Array<{ latBin: number; lonBin: number; k: number }> = []
  const latStart = binCoord(lat - latRadius)
  const lonStart = binCoord(lon - lonRadius)
  const latSteps = Math.ceil((2 * latRadius) / SPATIAL_BIN_DEG) + 1
  const lonSteps = Math.ceil((2 * lonRadius) / SPATIAL_BIN_DEG) + 1
  for (let i = 0; i <= latSteps; i++) {
    const latBin = Math.round((latStart + i * SPATIAL_BIN_DEG) * 1e6) / 1e6
    if (latBin < -90 || latBin >= 90) continue
    const latCenter = latBin + SPATIAL_BIN_DEG / 2
    for (let j = 0; j <= lonSteps; j++) {
      const lonBin = lonStart + j * SPATIAL_BIN_DEG
      const lonCenter = lonBin + SPATIAL_BIN_DEG / 2
      const d = Math.hypot((latCenter - lat) / latRadius, (lonCenter - lon) / lonRadius)
      if (d > 1) continue
      cells.push({ latBin, lonBin: wrapLonBin(lonBin), k: 1 - d })
    }
  }
  if (cells.length === 0) {
    return [{ latBin: binCoord(lat), lonBin: wrapLonBin(binCoord(lon)), w: weight }]
  }
  const norm = cells.reduce((n, c) => n + c.k, 0)
  return cells.map(({ latBin, lonBin, k }) => ({ latBin, lonBin, w: (weight * k) / norm }))
}

function num(fields: Record<string, string | number | boolean>, key: string): number {
  const v = fields[key]
  return typeof v === 'number' ? v : 0
}

function str(fields: Record<string, string | number | boolean>, key: string): string {
  const v = fields[key]
  return typeof v === 'string' ? v : ''
}

function bool(fields: Record<string, string | number | boolean>, key: string): boolean {
  return fields[key] === true
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
      sums: Record<string, number>
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
  // analytics_errors_daily
  const errors = new Map<string, ErrorsRollupRow>()
  // analytics_outcomes_daily
  const outcomes = new Map<string, OutcomesRollupRow>()
  // analytics_perf_daily
  const perf = new Map<string, PerfRollupRow>()
  // analytics_orbit_daily
  const orbit = new Map<string, OrbitRollupRow>()
  // analytics_quiz_daily
  const quiz = new Map<string, QuizRollupRow>()
  // analytics_dimension_daily
  const dimensions = new Map<string, DimensionRollupRow>()
  /** Accumulate one generic dimension row (count [+ value_sum]). */
  const addDimension = (environment: string, metric: string, key: string, w: number, valueAdd = 0): void => {
    const dimKey = [environment, metric, key].join(' ')
    const entry = dimensions.get(dimKey)
    if (entry) {
      entry.count += w
      entry.value_sum += valueAdd
    } else {
      dimensions.set(dimKey, { day, environment, metric, key, count: w, value_sum: valueAdd })
    }
  }

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
        sums: {},
      }
      daily.set(dailyKey, dailyEntry)
    }
    dailyEntry.row.events_count += w
    if (row.session_id) dailyEntry.sessions.add(row.session_id)
    const metricField = DAILY_METRIC_FIELDS[row.event_type]
    if (metricField) dailyEntry.samples.push(num(row.fields, metricField))
    for (const sumField of DAILY_SUM_FIELDS[row.event_type] ?? []) {
      dailyEntry.sums[`${sumField}_sum`] = (dailyEntry.sums[`${sumField}_sum`] ?? 0) + num(row.fields, sumField) * w
    }

    if (row.internal) continue // dataset/spatial/errors rollups: real users only

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

    const outcomeField = OUTCOME_FIELDS[row.event_type]
    if (outcomeField) {
      const value = str(row.fields, outcomeField)
      if (value !== '') {
        const key = [row.environment, row.event_type, value].join('\u0000')
        const entry = outcomes.get(key)
        if (entry) {
          entry.count += w
        } else {
          outcomes.set(key, { day, environment: row.environment, event_type: row.event_type, value, count: w })
        }
      }
    }

    if (row.event_type === 'error') {
      // Breakdown dimensions for the dashboard's errors table.
      // `error_detail` (the Tier B sibling carrying stacks) is
      // deliberately excluded — it duplicates the `error` emit and
      // counting both would double-report. Weight is the row's
      // sample interval, matching the analytics_daily errors count
      // (count_in_batch dedupes repeats within one batch; treating
      // it as a multiplier would diverge from the tile's number).
      const key = [row.environment, str(row.fields, 'category'), str(row.fields, 'source'), str(row.fields, 'code'), str(row.fields, 'message_class')].join('\u0000')
      const entry = errors.get(key)
      if (entry) {
        entry.count += w
      } else {
        errors.set(key, {
          day,
          environment: row.environment,
          category: str(row.fields, 'category'),
          source: str(row.fields, 'source'),
          code: str(row.fields, 'code'),
          message_class: str(row.fields, 'message_class'),
          count: w,
        })
      }
    }

    if (row.event_type === 'camera_settled' || row.event_type === 'map_click') {
      const isCamera = row.event_type === 'camera_settled'
      const lat = num(row.fields, isCamera ? 'center_lat' : 'lat')
      const lon = num(row.fields, isCamera ? 'center_lon' : 'lon')
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        const layerId = isCamera ? str(row.fields, 'layer_id') : ''
        const projection = isCamera ? str(row.fields, 'projection') : ''
        // Camera attention covers the visible area, not a point:
        // diffuse the weight over a zoom-derived footprint (wide and
        // faint when zoomed out, one concentrated cell when zoomed
        // in). Clicks are precise — always a single cell.
        const radius = isCamera ? footprintRadiusDeg(num(row.fields, 'zoom')) : SPATIAL_BIN_DEG
        for (const cell of splatFootprint(lat, lon, radius, w)) {
          const key = [row.event_type, row.environment, layerId, projection, cell.latBin, cell.lonBin].join('\u0000')
          const entry = spatial.get(key)
          if (entry) {
            entry.hits += cell.w
          } else {
            spatial.set(key, {
              day,
              event_type: row.event_type,
              environment: row.environment,
              layer_id: layerId,
              projection,
              lat_bin: cell.latBin,
              lon_bin: cell.lonBin,
              hits: cell.w,
            })
          }
        }
      }
    }

    // --- Phase E coverage rollups ---

    if (row.event_type === 'perf_sample') {
      const key = [row.environment, str(row.fields, 'surface'), str(row.fields, 'webgl_renderer_hash')].join(' ')
      const jsheap = num(row.fields, 'jsheap_mb')
      const entry = perf.get(key)
      if (entry) {
        entry.samples += w
        entry.fps_sum += num(row.fields, 'fps_median_10s') * w
        entry.frame_p95_sum += num(row.fields, 'frame_time_p95_ms') * w
        if (jsheap > 0) {
          entry.jsheap_sum += jsheap * w
          entry.jsheap_samples += w
        }
      } else {
        perf.set(key, {
          day,
          environment: row.environment,
          surface: str(row.fields, 'surface'),
          renderer: str(row.fields, 'webgl_renderer_hash'),
          samples: w,
          fps_sum: num(row.fields, 'fps_median_10s') * w,
          frame_p95_sum: num(row.fields, 'frame_time_p95_ms') * w,
          jsheap_sum: jsheap > 0 ? jsheap * w : 0,
          jsheap_samples: jsheap > 0 ? w : 0,
        })
      }
    }

    // Orbit cost — assistant-side turns only (user turns would
    // double-count the conversation).
    if (row.event_type === 'orbit_turn' && str(row.fields, 'turn_role') === 'assistant') {
      const model = str(row.fields, 'model')
      const key = [row.environment, model].join(' ')
      const entry = orbit.get(key)
      if (entry) {
        entry.turns += w
        entry.rounds_sum += num(row.fields, 'turn_rounds') * w
        entry.input_tokens_sum += num(row.fields, 'input_tokens') * w
        entry.output_tokens_sum += num(row.fields, 'output_tokens') * w
        entry.duration_ms_sum += num(row.fields, 'duration_ms') * w
      } else {
        orbit.set(key, {
          day,
          environment: row.environment,
          model,
          turns: w,
          rounds_sum: num(row.fields, 'turn_rounds') * w,
          input_tokens_sum: num(row.fields, 'input_tokens') * w,
          output_tokens_sum: num(row.fields, 'output_tokens') * w,
          duration_ms_sum: num(row.fields, 'duration_ms') * w,
        })
      }
    }

    if (row.event_type === 'tour_question_answered') {
      const tourId = str(row.fields, 'tour_id')
      const questionId = str(row.fields, 'question_id')
      const key = [row.environment, tourId, questionId].join(' ')
      const correct = bool(row.fields, 'was_correct') ? w : 0
      const entry = quiz.get(key)
      if (entry) {
        entry.answered += w
        entry.correct += correct
        entry.response_ms_sum += num(row.fields, 'response_ms') * w
      } else {
        quiz.set(key, {
          day,
          environment: row.environment,
          tour_id: tourId,
          question_id: questionId,
          answered: w,
          correct,
          response_ms_sum: num(row.fields, 'response_ms') * w,
        })
      }
    }

    // Generic dimension mixes.
    if (row.event_type === 'session_start') {
      const os = str(row.fields, 'os')
      if (os) addDimension(row.environment, 'os', os, w)
    } else if (row.event_type === 'map_click') {
      const hitKind = str(row.fields, 'hit_kind')
      if (hitKind) addDimension(row.environment, 'click_kind', hitKind, w)
    } else if (row.event_type === 'browse_search') {
      const queryHash = str(row.fields, 'query_hash')
      if (queryHash) {
        addDimension(row.environment, 'search', queryHash, w, num(row.fields, 'query_length') * w)
        if (str(row.fields, 'result_count_bucket') === '0') {
          addDimension(row.environment, 'search_zero', queryHash, w)
        }
      }
    } else if (row.event_type === 'dwell') {
      const target = str(row.fields, 'view_target')
      if (target) addDimension(row.environment, 'dwell', target, w, num(row.fields, 'duration_ms') * w)
    } else if (row.event_type === 'vr_interaction') {
      const gesture = str(row.fields, 'gesture')
      if (gesture) addDimension(row.environment, 'vr_gesture', gesture, w, num(row.fields, 'magnitude') * w)
    } else if (row.event_type === 'orbit_correction') {
      const signal = str(row.fields, 'signal')
      if (signal) addDimension(row.environment, 'orbit_correction', signal, w)
    } else if (row.event_type === 'orbit_load_followed') {
      const path = str(row.fields, 'path')
      if (path) addDimension(row.environment, 'orbit_follow', path, w, num(row.fields, 'latency_ms') * w)
    }
  }

  return {
    daily: [...daily.values()].map(({ row, sessions, samples, sums }) => {
      const metrics: Record<string, number> = { ...sums }
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
    errors: [...errors.values()],
    outcomes: [...outcomes.values()],
    perf: [...perf.values()],
    orbit: [...orbit.values()],
    quiz: [...quiz.values()],
    dimensions: [...dimensions.values()],
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
    db.prepare(`DELETE FROM analytics_errors_daily WHERE day = ?`).bind(day),
    db.prepare(`DELETE FROM analytics_outcomes_daily WHERE day = ?`).bind(day),
    db.prepare(`DELETE FROM analytics_perf_daily WHERE day = ?`).bind(day),
    db.prepare(`DELETE FROM analytics_orbit_daily WHERE day = ?`).bind(day),
    db.prepare(`DELETE FROM analytics_quiz_daily WHERE day = ?`).bind(day),
    db.prepare(`DELETE FROM analytics_dimension_daily WHERE day = ?`).bind(day),
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
  const insertErrors = `INSERT INTO analytics_errors_daily
    (day, environment, category, source, code, message_class, count)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  for (const r of rollups.errors) {
    stmts.push(
      db
        .prepare(insertErrors)
        .bind(r.day, r.environment, r.category, r.source, r.code, r.message_class, r.count),
    )
  }
  const insertOutcomes = `INSERT INTO analytics_outcomes_daily
    (day, environment, event_type, value, count)
    VALUES (?, ?, ?, ?, ?)`
  for (const r of rollups.outcomes) {
    stmts.push(
      db.prepare(insertOutcomes).bind(r.day, r.environment, r.event_type, r.value, r.count),
    )
  }
  const insertPerf = `INSERT INTO analytics_perf_daily
    (day, environment, surface, renderer, samples, fps_sum, frame_p95_sum, jsheap_sum, jsheap_samples)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  for (const r of rollups.perf) {
    stmts.push(
      db
        .prepare(insertPerf)
        .bind(r.day, r.environment, r.surface, r.renderer, r.samples, r.fps_sum, r.frame_p95_sum, r.jsheap_sum, r.jsheap_samples),
    )
  }
  const insertOrbit = `INSERT INTO analytics_orbit_daily
    (day, environment, model, turns, rounds_sum, input_tokens_sum, output_tokens_sum, duration_ms_sum)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  for (const r of rollups.orbit) {
    stmts.push(
      db
        .prepare(insertOrbit)
        .bind(r.day, r.environment, r.model, r.turns, r.rounds_sum, r.input_tokens_sum, r.output_tokens_sum, r.duration_ms_sum),
    )
  }
  const insertQuiz = `INSERT INTO analytics_quiz_daily
    (day, environment, tour_id, question_id, answered, correct, response_ms_sum)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  for (const r of rollups.quiz) {
    stmts.push(
      db
        .prepare(insertQuiz)
        .bind(r.day, r.environment, r.tour_id, r.question_id, r.answered, r.correct, r.response_ms_sum),
    )
  }
  const insertDimension = `INSERT INTO analytics_dimension_daily
    (day, environment, metric, key, count, value_sum)
    VALUES (?, ?, ?, ?, ?, ?)`
  for (const r of rollups.dimensions) {
    stmts.push(
      db.prepare(insertDimension).bind(r.day, r.environment, r.metric, r.key, r.count, r.value_sum),
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
