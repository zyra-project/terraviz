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
  /** Sessions by OS family (from session_start; Phase E). */
  operatingSystems: Record<string, number>
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
  /** map_click hit-kind mix (surface / marker / feature / region). */
  hitKinds: Record<string, number>
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

const TOP_COUNTRIES = 20
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

  const osRows = await db
    .prepare(
      `SELECT key, SUM(count) AS sessions FROM analytics_dimension_daily
        WHERE day >= ? AND environment = ? AND metric = 'os'
        GROUP BY key`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ key: string; sessions: number }>()

  const dayRows = (days.results ?? []).map(d => ({ ...d, view_ms: viewByDay.get(d.day) ?? 0 }))
  return {
    days: dayRows,
    platforms: Object.fromEntries((platforms.results ?? []).map(r => [r.platform, r.sessions])),
    operatingSystems: Object.fromEntries((osRows.results ?? []).map(r => [r.key, r.sessions])),
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

  const hitKindRows = await db
    .prepare(
      `SELECT key, SUM(count) AS n FROM analytics_dimension_daily
        WHERE day >= ? AND environment = ? AND metric = 'click_kind'
        GROUP BY key`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ key: string; n: number }>()

  const layerIds = (layers.results ?? []).map(r => r.layer_id)
  const titles = await resolveTitles(db, layerIds)
  return {
    layers: layerIds.map(id => ({ id, title: titles.get(id) ?? null })),
    bins: bins.results ?? [],
    hitKinds: Object.fromEntries((hitKindRows.results ?? []).map(r => [r.key, r.n])),
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
): Promise<{
  days: FunnelDay[]
  outcomes: FunnelOutcomes
  /** tour_started counts by source (browse | orbit | deeplink |
   * auto), from the `tour_start` dimension. The `auto` bucket is
   * `runTourOnLoad` auto-tours, which the outcomes rollup excludes;
   * the page subtracts it to compute the user-started denominator. */
  toursStartedBySource: Record<string, number>
}> {
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

  const sourceRows = await db
    .prepare(
      `SELECT key, SUM(count) AS count
         FROM analytics_dimension_daily
        WHERE day >= ? AND environment = ? AND metric = 'tour_start'
        GROUP BY key`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ key: string; count: number }>()
  const toursStartedBySource: Record<string, number> = {}
  for (const row of sourceRows.results ?? []) toursStartedBySource[row.key] = row.count

  return { days: rows.results ?? [], outcomes, toursStartedBySource }
}

// --- Phase E sections ---

export interface PerfRow {
  surface: string
  renderer: string
  samples: number
  avg_fps: number
  avg_frame_p95_ms: number
  avg_jsheap_mb: number | null
}

/** Per-renderer/surface performance averages over the range, derived
 * from the weighted sums in analytics_perf_daily. */
export async function queryPerf(db: D1Database, f: AnalyticsFilters): Promise<{ rows: PerfRow[] }> {
  const rows = await db
    .prepare(
      `SELECT surface, renderer,
              SUM(samples) AS samples,
              SUM(fps_sum) AS fps_sum,
              SUM(frame_p95_sum) AS frame_p95_sum,
              SUM(jsheap_sum) AS jsheap_sum,
              SUM(jsheap_samples) AS jsheap_samples
         FROM analytics_perf_daily
        WHERE day >= ? AND environment = ?
        GROUP BY surface, renderer
        ORDER BY samples DESC LIMIT 50`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ surface: string; renderer: string; samples: number; fps_sum: number; frame_p95_sum: number; jsheap_sum: number; jsheap_samples: number }>()
  return {
    rows: (rows.results ?? []).map(r => ({
      surface: r.surface,
      renderer: r.renderer,
      samples: r.samples,
      avg_fps: r.samples > 0 ? r.fps_sum / r.samples : 0,
      avg_frame_p95_ms: r.samples > 0 ? r.frame_p95_sum / r.samples : 0,
      avg_jsheap_mb: r.jsheap_samples > 0 ? r.jsheap_sum / r.jsheap_samples : null,
    })),
  }
}

export interface OrbitModelRow {
  model: string
  turns: number
  rounds: number
  input_tokens: number
  output_tokens: number
}

export interface OrbitData {
  models: OrbitModelRow[]
  days: Array<{ day: string; rounds: number; turns: number }>
  totals: { turns: number; rounds: number; input_tokens: number; output_tokens: number }
}

/** Orbit LLM cost — by model + per-day round counts. Tier B, so
 * sparse unless users opt into Research mode. */
export async function queryOrbit(db: D1Database, f: AnalyticsFilters): Promise<OrbitData> {
  const models = await db
    .prepare(
      `SELECT model,
              SUM(turns) AS turns, SUM(rounds_sum) AS rounds,
              SUM(input_tokens_sum) AS input_tokens, SUM(output_tokens_sum) AS output_tokens
         FROM analytics_orbit_daily
        WHERE day >= ? AND environment = ?
        GROUP BY model ORDER BY rounds DESC LIMIT 25`,
    )
    .bind(f.sinceDay, f.environment)
    .all<OrbitModelRow>()
  const days = await db
    .prepare(
      `SELECT day, SUM(rounds_sum) AS rounds, SUM(turns) AS turns
         FROM analytics_orbit_daily
        WHERE day >= ? AND environment = ?
        GROUP BY day ORDER BY day`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ day: string; rounds: number; turns: number }>()
  // Totals are a separate full aggregate, not a reduce over the
  // top-25 `models` rows — otherwise the stat tiles undercount when
  // more than 25 models appear in range.
  const totalsRow = await db
    .prepare(
      `SELECT SUM(turns) AS turns, SUM(rounds_sum) AS rounds,
              SUM(input_tokens_sum) AS input_tokens, SUM(output_tokens_sum) AS output_tokens
         FROM analytics_orbit_daily
        WHERE day >= ? AND environment = ?`,
    )
    .bind(f.sinceDay, f.environment)
    .first<{ turns: number; rounds: number; input_tokens: number; output_tokens: number }>()
  return {
    models: models.results ?? [],
    days: days.results ?? [],
    totals: {
      turns: totalsRow?.turns ?? 0,
      rounds: totalsRow?.rounds ?? 0,
      input_tokens: totalsRow?.input_tokens ?? 0,
      output_tokens: totalsRow?.output_tokens ?? 0,
    },
  }
}

export interface ResearchData {
  topSearches: Array<{ key: string; count: number; avg_length: number }>
  zeroSearches: Array<{ key: string; count: number }>
  dwell: Array<{ key: string; count: number; avg_ms: number }>
  gestures: Array<{ key: string; count: number; avg_magnitude: number }>
  corrections: Array<{ key: string; count: number }>
  followThrough: Array<{ key: string; count: number; avg_latency_ms: number }>
  worstQuestions: Array<{ tour_id: string; question_id: string; answered: number; correct_rate: number }>
}

/** Tier-B research surface — the research.json dashboard ported.
 * Every sub-table reads the generic dimension rollup (or the quiz
 * rollup); all sparse unless users opt into Research mode. */
export async function queryResearch(db: D1Database, f: AnalyticsFilters): Promise<ResearchData> {
  const dim = async (metric: string, limit = 20) =>
    (
      await db
        .prepare(
          `SELECT key, SUM(count) AS count, SUM(value_sum) AS value_sum
             FROM analytics_dimension_daily
            WHERE day >= ? AND environment = ? AND metric = ?
            GROUP BY key ORDER BY count DESC LIMIT ${limit}`,
        )
        .bind(f.sinceDay, f.environment, metric)
        .all<{ key: string; count: number; value_sum: number }>()
    ).results ?? []

  const [searches, zeros, dwellRows, gestureRows, correctionRows, followRows] = await Promise.all([
    dim('search'),
    dim('search_zero'),
    dim('dwell'),
    dim('vr_gesture'),
    dim('orbit_correction'),
    dim('orbit_follow'),
  ])

  const quiz = await db
    .prepare(
      `SELECT tour_id, question_id, SUM(answered) AS answered, SUM(correct) AS correct
         FROM analytics_quiz_daily
        WHERE day >= ? AND environment = ?
        GROUP BY tour_id, question_id
        HAVING answered > 0
        ORDER BY (correct * 1.0 / answered) ASC, answered DESC LIMIT 20`,
    )
    .bind(f.sinceDay, f.environment)
    .all<{ tour_id: string; question_id: string; answered: number; correct: number }>()

  const avg = (count: number, sum: number) => (count > 0 ? sum / count : 0)
  return {
    topSearches: searches.map(r => ({ key: r.key, count: r.count, avg_length: avg(r.count, r.value_sum) })),
    zeroSearches: zeros.map(r => ({ key: r.key, count: r.count })),
    dwell: dwellRows.map(r => ({ key: r.key, count: r.count, avg_ms: avg(r.count, r.value_sum) })),
    gestures: gestureRows.map(r => ({ key: r.key, count: r.count, avg_magnitude: avg(r.count, r.value_sum) })),
    corrections: correctionRows.map(r => ({ key: r.key, count: r.count })),
    followThrough: followRows.map(r => ({ key: r.key, count: r.count, avg_latency_ms: avg(r.count, r.value_sum) })),
    worstQuestions: (quiz.results ?? []).map(r => ({
      tour_id: r.tour_id,
      question_id: r.question_id,
      answered: r.answered,
      correct_rate: r.answered > 0 ? r.correct / r.answered : 0,
    })),
  }
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
