/**
 * Analytics dashboard query layer — Phase B of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`.
 *
 * Read-side companion to `analytics-export.ts`: shapes the D1
 * rollup tables (migration 0019) into the section payloads the
 * `/publish/analytics` page renders. Served by
 * `functions/api/v1/publish/analytics.ts`.
 *
 * v1 deliberately reads **rollups only** (complete days through
 * yesterday, refreshed by the nightly export). A live-AE overlay
 * for "today so far" is sketched in the plan doc but deferred —
 * the rollups answer every historical question, and the page
 * labels its freshness honestly.
 *
 * Semantics inherited from the export job:
 *   - counts are sample-weighted estimates (floats);
 *   - `internal` (staff) traffic is excluded everywhere — the
 *     dataset/spatial rollups never contained it, and the daily
 *     rollup is filtered to `internal = 0` here;
 *   - per-dataset p50/p95 are *loads-weighted averages of daily
 *     percentiles* — a labelled approximation (percentiles don't
 *     compose across days without raw samples).
 */

export interface AnalyticsFilters {
  /** Inclusive first day, 'YYYY-MM-DD' UTC. */
  sinceDay: string
  environment: string
}

export interface OverviewDay {
  day: string
  sessions: number
  events: number
  errors: number
  /** Idle-tab-aware total view time (Σ session_end.visible_ms).
   * 0 for days whose sessions predate the visible_ms field. */
  view_ms: number
}

export interface OverviewData {
  days: OverviewDay[]
  platforms: Record<string, number>
  countries: Array<{ country: string; sessions: number }>
  totals: { sessions: number; events: number; errors: number; view_ms: number }
}

export interface DatasetEngagementRow {
  layer_id: string
  /** Catalog title, resolved via `datasets.id` or `datasets.legacy_id`
   * (telemetry `layer_id`s predating the catalog cutover carry the
   * legacy SOS id). `null` when the id no longer resolves — the page
   * falls back to showing the raw id. */
  title: string | null
  loads: number
  trigger_mix: Record<string, number>
  source_mix: Record<string, number>
  load_ms_p50: number | null
  load_ms_p95: number | null
  dwell_ms_sum: number
}

export interface SpatialData {
  /** Distinct camera-settled layer ids in range — feeds the page's
   * dataset filter ('' = default Earth view, title null). */
  layers: Array<{ id: string; title: string | null }>
  bins: Array<{ lat: number; lon: number; hits: number }>
}

export interface ErrorBreakdownRow {
  category: string
  source: string
  code: string
  message_class: string
  count: number
}

export interface FunnelDay {
  day: string
  tours_started: number
  tours_ended: number
  vr_started: number
  orbit_turns: number
}

export interface FunnelOutcomes {
  /** tour_ended counts by outcome (completed | abandoned | error). */
  tour_ended: Record<string, number>
  /** vr_session_started counts by mode (ar | vr). */
  vr_session_started: Record<string, number>
}

const TOP_COUNTRIES = 12
const TOP_DATASETS = 25
/** 0.5° world grid is ≤ ~260k cells; real data is far sparser, but
 * cap the response so a pathological range can't balloon it. */
const MAX_SPATIAL_BINS = 20_000

/**
 * Resolve telemetry `layer_id`s to catalog titles. A layer id can be
 * a catalog id (`DS…`) or — for events emitted against the legacy
 * SOS snapshot — a `legacy_id` like `INTERNAL_SOS_768`; both columns
 * are matched. Ids that resolve nowhere map to nothing and the
 * caller surfaces the raw id.
 */
async function resolveTitles(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  const lookup = ids.filter(id => id !== '')
  const titles = new Map<string, string>()
  if (lookup.length === 0) return titles
  const placeholders = lookup.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT id, legacy_id, title FROM datasets
        WHERE id IN (${placeholders}) OR legacy_id IN (${placeholders})`,
    )
    .bind(...lookup, ...lookup)
    .all<{ id: string; legacy_id: string | null; title: string }>()
  for (const row of rows.results ?? []) {
    titles.set(row.id, row.title)
    if (row.legacy_id) titles.set(row.legacy_id, row.title)
  }
  return titles
}

export async function queryOverview(db: D1Database, f: AnalyticsFilters): Promise<OverviewData> {
  const days = await db
    .prepare(
      `SELECT day,
              SUM(CASE WHEN event_type = 'session_start' THEN sessions_count ELSE 0 END) AS sessions,
              SUM(events_count) AS events,
              SUM(CASE WHEN event_type = 'error' THEN events_count ELSE 0 END) AS errors
         FROM analytics_daily
        WHERE day >= ? AND environment = ? AND internal = 0
        GROUP BY day ORDER BY day`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ day: string; sessions: number; events: number; errors: number }>()

  const platforms = await db
    .prepare(
      `SELECT platform, SUM(sessions_count) AS sessions
         FROM analytics_daily
        WHERE day >= ? AND environment = ? AND internal = 0
          AND event_type = 'session_start' AND platform != ''
        GROUP BY platform`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ platform: string; sessions: number }>()

  const countries = await db
    .prepare(
      `SELECT country, SUM(sessions_count) AS sessions
         FROM analytics_daily
        WHERE day >= ? AND environment = ? AND internal = 0
          AND event_type = 'session_start'
        GROUP BY country ORDER BY sessions DESC LIMIT ${TOP_COUNTRIES}`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ country: string; sessions: number }>()

  // View time lives in the session_end groups' metrics JSON
  // (visible_ms_sum) — summed per day in TS since the column is a
  // JSON blob keyed by group.
  const viewRows = await db
    .prepare(
      `SELECT day, metrics FROM analytics_daily
        WHERE day >= ? AND environment = ? AND internal = 0
          AND event_type = 'session_end'`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ day: string; metrics: string }>()
  const viewByDay = new Map<string, number>()
  for (const row of viewRows.results ?? []) {
    const visible = safeJson(row.metrics).visible_ms_sum ?? 0
    viewByDay.set(row.day, (viewByDay.get(row.day) ?? 0) + visible)
  }

  const dayRows = (days.results ?? []).map(d => ({ ...d, view_ms: viewByDay.get(d.day) ?? 0 }))
  return {
    days: dayRows,
    platforms: Object.fromEntries((platforms.results ?? []).map(r => [r.platform, r.sessions])),
    countries: countries.results ?? [],
    totals: {
      sessions: dayRows.reduce((n, d) => n + d.sessions, 0),
      events: dayRows.reduce((n, d) => n + d.events, 0),
      errors: dayRows.reduce((n, d) => n + d.errors, 0),
      view_ms: dayRows.reduce((n, d) => n + d.view_ms, 0),
    },
  }
}

export async function queryDatasets(
  db: D1Database,
  f: AnalyticsFilters,
): Promise<{ datasets: DatasetEngagementRow[] }> {
  // Pass 1: rank datasets by total loads (cheap aggregate).
  const top = await db
    .prepare(
      `SELECT layer_id, SUM(loads) AS loads
         FROM analytics_dataset_daily
        WHERE day >= ? AND environment = ?
        GROUP BY layer_id ORDER BY loads DESC LIMIT ${TOP_DATASETS}`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ layer_id: string; loads: number }>()
  const ids = (top.results ?? []).map(r => r.layer_id)
  if (ids.length === 0) return { datasets: [] }

  // Pass 2: per-day rows for just those datasets — the JSON mix
  // columns have to be merged in TS.
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT layer_id, loads, trigger_mix, source_mix, load_ms_p50, load_ms_p95, dwell_ms_sum
         FROM analytics_dataset_daily
        WHERE day >= ? AND environment = ? AND layer_id IN (${placeholders})`,
    )
    .bind(f.sinceDay, f.environment, ...ids)
    .all<{
      layer_id: string
      loads: number
      trigger_mix: string
      source_mix: string
      load_ms_p50: number | null
      load_ms_p95: number | null
      dwell_ms_sum: number | null
    }>()

  const titles = await resolveTitles(db, ids)

  const byId = new Map<string, DatasetEngagementRow & { _p50Weight: number; _p95Weight: number; _p50Sum: number; _p95Sum: number }>()
  for (const row of rows.results ?? []) {
    let entry = byId.get(row.layer_id)
    if (!entry) {
      entry = {
        layer_id: row.layer_id,
        title: titles.get(row.layer_id) ?? null,
        loads: 0,
        trigger_mix: {},
        source_mix: {},
        load_ms_p50: null,
        load_ms_p95: null,
        dwell_ms_sum: 0,
        _p50Weight: 0,
        _p95Weight: 0,
        _p50Sum: 0,
        _p95Sum: 0,
      }
      byId.set(row.layer_id, entry)
    }
    entry.loads += row.loads
    entry.dwell_ms_sum += row.dwell_ms_sum ?? 0
    for (const [k, v] of Object.entries(safeJson(row.trigger_mix))) {
      entry.trigger_mix[k] = (entry.trigger_mix[k] ?? 0) + v
    }
    for (const [k, v] of Object.entries(safeJson(row.source_mix))) {
      entry.source_mix[k] = (entry.source_mix[k] ?? 0) + v
    }
    if (row.load_ms_p50 != null && row.loads > 0) {
      entry._p50Sum += row.load_ms_p50 * row.loads
      entry._p50Weight += row.loads
    }
    if (row.load_ms_p95 != null && row.loads > 0) {
      entry._p95Sum += row.load_ms_p95 * row.loads
      entry._p95Weight += row.loads
    }
  }

  const datasets = ids
    .map(id => byId.get(id))
    .filter((e): e is NonNullable<typeof e> => e != null)
    .map(({ _p50Weight, _p95Weight, _p50Sum, _p95Sum, ...rest }) => ({
      ...rest,
      load_ms_p50: _p50Weight > 0 ? _p50Sum / _p50Weight : null,
      load_ms_p95: _p95Weight > 0 ? _p95Sum / _p95Weight : null,
    }))
  return { datasets }
}

export interface SpatialFilters {
  /** 'camera_settled' (default) or 'map_click'. */
  event: string
  /** Dataset filter: undefined = all, '' = default Earth only. */
  layer?: string
  /** 'globe' | 'mercator' | 'vr' | 'ar'; undefined = all. */
  projection?: string
}

export async function querySpatial(
  db: D1Database,
  f: AnalyticsFilters,
  s: SpatialFilters,
): Promise<SpatialData> {
  const layers = await db
    .prepare(
      `SELECT DISTINCT layer_id FROM analytics_spatial_daily
        WHERE day >= ? AND environment = ? AND event_type = 'camera_settled'
        ORDER BY layer_id`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ layer_id: string }>()

  const conditions = ['day >= ?', 'environment = ?', 'event_type = ?']
  const binds: unknown[] = [f.sinceDay, f.environment, s.event]
  if (s.layer !== undefined) {
    conditions.push('layer_id = ?')
    binds.push(s.layer)
  }
  if (s.projection !== undefined) {
    conditions.push('projection = ?')
    binds.push(s.projection)
  }
  const bins = await db
    .prepare(
      `SELECT lat_bin AS lat, lon_bin AS lon, SUM(hits) AS hits
         FROM analytics_spatial_daily
        WHERE ${conditions.join(' AND ')}
        GROUP BY lat_bin, lon_bin
        ORDER BY hits DESC LIMIT ${MAX_SPATIAL_BINS}`,
    )
    .bind(...binds)
    .all<{ lat: number; lon: number; hits: number }>()

  const layerIds = (layers.results ?? []).map(r => r.layer_id)
  const titles = await resolveTitles(db, layerIds)
  return {
    layers: layerIds.map(id => ({ id, title: titles.get(id) ?? null })),
    bins: bins.results ?? [],
  }
}

/** Frequency-ordered error breakdown over the range — backs the
 * expandable table behind the Overview section's errors tile.
 * Telemetry has no severity field; category/source are the closest
 * grouping, and the ordering is by sample-weighted count. */
export async function queryErrors(
  db: D1Database,
  f: AnalyticsFilters,
): Promise<{ errors: ErrorBreakdownRow[] }> {
  const rows = await db
    .prepare(
      `SELECT category, source, code, message_class, SUM(count) AS count
         FROM analytics_errors_daily
        WHERE day >= ? AND environment = ?
        GROUP BY category, source, code, message_class
        ORDER BY count DESC LIMIT 100`,
    )
    .bind(f.sinceDay, f.environment)
    .all<ErrorBreakdownRow>()
  return { errors: rows.results ?? [] }
}

export async function queryFunnel(
  db: D1Database,
  f: AnalyticsFilters,
): Promise<{ days: FunnelDay[]; outcomes: FunnelOutcomes }> {
  const rows = await db
    .prepare(
      `SELECT day,
              SUM(CASE WHEN event_type = 'tour_started' THEN events_count ELSE 0 END) AS tours_started,
              SUM(CASE WHEN event_type = 'tour_ended' THEN events_count ELSE 0 END) AS tours_ended,
              SUM(CASE WHEN event_type = 'vr_session_started' THEN events_count ELSE 0 END) AS vr_started,
              SUM(CASE WHEN event_type = 'orbit_turn' THEN events_count ELSE 0 END) AS orbit_turns
         FROM analytics_daily
        WHERE day >= ? AND environment = ? AND internal = 0
          AND event_type IN ('tour_started', 'tour_ended', 'vr_session_started', 'orbit_turn')
        GROUP BY day ORDER BY day`,
    )
    .bind(f.sinceDay, f.environment)
    .all<FunnelDay>()

  const outcomeRows = await db
    .prepare(
      `SELECT event_type, value, SUM(count) AS count
         FROM analytics_outcomes_daily
        WHERE day >= ? AND environment = ?
        GROUP BY event_type, value`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ event_type: string; value: string; count: number }>()
  const outcomes: FunnelOutcomes = { tour_ended: {}, vr_session_started: {} }
  for (const row of outcomeRows.results ?? []) {
    if (row.event_type === 'tour_ended') outcomes.tour_ended[row.value] = row.count
    else if (row.event_type === 'vr_session_started') outcomes.vr_session_started[row.value] = row.count
  }
  return { days: rows.results ?? [], outcomes }
}

function safeJson(text: string): Record<string, number> {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
      }
      return out
    }
  } catch {
    // Malformed JSON in a rollup row — treat as empty rather than
    // failing the whole section.
  }
  return {}
}
