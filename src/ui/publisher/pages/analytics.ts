/**
 * /publish/analytics — the operator analytics dashboard (Phase B of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`).
 *
 * Privileged-only (staff / admin / service), same client-side gate
 * as featured-hero (the API enforces 403 regardless). Data comes
 * from `GET /api/v1/publish/analytics` — typed sections over the
 * Phase A rollup tables; everything shown is a sample-weighted
 * estimate over complete UTC days through yesterday, external
 * traffic only.
 *
 * Four sections:
 *   - Overview      — sessions/events/errors per day, platform mix,
 *                     top countries.
 *   - Dataset       — top datasets by loads with trigger/source
 *     engagement      mixes, ≈p50/≈p95 load times, on-globe dwell.
 *   - Spatial       — a real MapLibre map with a `heatmap` layer
 *     attention       over the 0.5° rollup bins, filterable by
 *                     dataset / projection / signal. MapLibre is
 *                     lazy-imported on first render so the portal
 *                     chunk stays map-free for non-analytics visits;
 *                     the basemap is vendored Natural Earth land +
 *                     country borders drawn as flat grayscale fills
 *                     (no tile fetches — see LAND_GEOJSON_URL).
 *   - Tours, VR &   — per-day engagement series plus true outcomes:
 *     Orbit           tour completion rate + outcome mix
 *                     (analytics_outcomes_daily) and VR mode mix.
 *
 * Range / environment controls reload every section; the
 * spatial-only filters reload just the heatmap data.
 */

import { t } from '../../../i18n'
import { formatDate, formatNumber } from '../../../i18n/format'
import { publisherGet, handleSessionError, type PublisherApiResult } from '../api'
import { buildErrorCard } from '../components/error-card'
import { ROUTE_CHANGE_START_EVENT } from '../router'
import {
  csvExportButton,
  formatDurationMs,
  renderBarSeries,
  renderMixBar,
  renderStatTile,
  type CsvRow,
} from '../analytics-charts'


const ME_ENDPOINT = '/api/v1/publish/me'
const ANALYTICS_ENDPOINT = '/api/v1/publish/analytics'
/** Vendored Natural Earth 1:110m land polygons + admin-0 country
 * boundary lines (public domain), minified + coordinate-rounded —
 * ~54 KB gzipped combined, lazy-fetched only when the spatial
 * section renders. Drawn as a flat grayscale basemap (dark ocean,
 * gray land, slightly lighter country borders for geographic
 * context) so the heatmap's color ramp is the only color on the
 * map. No tile fetches at all — the heatmap works on bare
 * localhost dev too. */
const LAND_GEOJSON_URL = '/assets/ne_110m_land.geojson'
const BORDERS_GEOJSON_URL = '/assets/ne_110m_admin0_borders.geojson'
const OCEAN_COLOR = '#0b0e15'
const LAND_COLOR = '#3a4150'
const BORDER_COLOR = '#5a6374'
const RANGE_CHOICES = [7, 30, 90, 365] as const
const ENVIRONMENTS = ['production', 'preview'] as const

interface MeResponse {
  role: string
  is_admin: boolean
}

interface Envelope<T> {
  since_day: string
  through_day: string
  data: T
}

interface OverviewData {
  days: Array<{ day: string; sessions: number; events: number; errors: number; view_ms: number }>
  platforms: Record<string, number>
  operatingSystems: Record<string, number>
  countries: Array<{ country: string; sessions: number }>
  totals: { sessions: number; events: number; errors: number; view_ms: number }
}

interface DatasetsData {
  datasets: Array<{
    layer_id: string
    title: string | null
    loads: number
    trigger_mix: Record<string, number>
    source_mix: Record<string, number>
    load_ms_p50: number | null
    load_ms_p95: number | null
    dwell_ms_sum: number
  }>
}

interface SpatialData {
  layers: Array<{ id: string; title: string | null }>
  bins: Array<{ lat: number; lon: number; hits: number }>
  hitKinds: Record<string, number>
}

interface PerfData {
  rows: Array<{
    surface: string
    renderer: string
    samples: number
    avg_fps: number
    avg_frame_p95_ms: number
    avg_jsheap_mb: number | null
  }>
}

interface OrbitData {
  models: Array<{ model: string; turns: number; rounds: number; input_tokens: number; output_tokens: number }>
  days: Array<{ day: string; rounds: number; turns: number }>
  totals: { turns: number; rounds: number; input_tokens: number; output_tokens: number }
}

interface ResearchData {
  topSearches: Array<{ key: string; count: number; avg_length: number }>
  zeroSearches: Array<{ key: string; count: number }>
  dwell: Array<{ key: string; count: number; avg_ms: number }>
  gestures: Array<{ key: string; count: number; avg_magnitude: number }>
  corrections: Array<{ key: string; count: number }>
  followThrough: Array<{ key: string; count: number; avg_latency_ms: number }>
  worstQuestions: Array<{ tour_id: string; question_id: string; answered: number; correct_rate: number }>
}

interface ErrorsData {
  errors: Array<{
    category: string
    source: string
    code: string
    message_class: string
    count: number
  }>
}

interface FunnelData {
  days: Array<{
    day: string
    tours_started: number
    tours_ended: number
    vr_started: number
    orbit_turns: number
  }>
  outcomes: {
    tour_ended: Record<string, number>
    vr_session_started: Record<string, number>
  }
  toursStartedBySource: Record<string, number>
}

export interface AnalyticsPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

interface PageState {
  days: (typeof RANGE_CHOICES)[number]
  environment: (typeof ENVIRONMENTS)[number]
  spatialEvent: 'camera_settled' | 'map_click'
  /** undefined = all datasets, '' = default Earth, else a layer id. */
  spatialLayer: string | undefined
  /** undefined = all projections. */
  spatialProjection: string | undefined
}

function clientIsPrivileged(me: MeResponse): boolean {
  return me.is_admin === true || me.role === 'staff' || me.role === 'service'
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (HTMLElement | SVGElement | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const c of children) node.append(c)
  return node
}

/** Flatten a mix (`{browse: 12, orbit: 5}`) to a single CSV cell
 * (`browse:12;orbit:5`), descending by share — keeps the per-row
 * breakdown in one column rather than exploding into many. Values
 * are sample-weighted estimates, so they're rounded. */
function mixCell(mix: Record<string, number>): string {
  return Object.entries(mix)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${Math.round(v)}`)
    .join(';')
}

/** Locale-formatted chart axis labels for the envelope's range. */
function rangeOf(envelope: { since_day: string; through_day: string }): { start: string; end: string } {
  const formatDay = (day: string): string =>
    formatDate(new Date(`${day}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })
  return { start: formatDay(envelope.since_day), end: formatDay(envelope.through_day) }
}

function shell(...children: HTMLElement[]): HTMLElement {
  const main = el('main', { className: 'publisher-shell publisher-analytics' })
  main.append(...children)
  return main
}

export async function renderAnalyticsPage(
  mount: HTMLElement,
  options: AnalyticsPageOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn
  mount.replaceChildren(
    shell(el('p', { className: 'publisher-loading', textContent: t('publisher.analytics.loading') })),
  )

  const meRes = await publisherGet<MeResponse>(ME_ENDPOINT, { fetchFn })
  if (!meRes.ok) {
    if (meRes.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    const details = meRes.kind === 'server' ? { status: meRes.status, body: meRes.body } : {}
    mount.replaceChildren(shell(buildErrorCard(meRes.kind, details)))
    return
  }
  if (!clientIsPrivileged(meRes.data)) {
    mount.replaceChildren(
      shell(
        el('h1', { textContent: t('publisher.analytics.title') }),
        el('p', {
          className: 'publisher-hero-restricted',
          textContent: t('publisher.analytics.restricted'),
        }),
      ),
    )
    return
  }

  const state: PageState = {
    days: 30,
    environment: 'production',
    spatialEvent: 'camera_settled',
    spatialLayer: undefined,
    spatialProjection: undefined,
  }

  // One container per section so a slow/failed section never blocks
  // the others. The spatial section keeps its MapLibre instance
  // across filter changes (data-only updates) and rebuilds it on
  // range/environment changes (full section re-render).
  const overviewHost = el('section', { className: 'publisher-analytics-section' })
  const datasetsHost = el('section', { className: 'publisher-analytics-section' })
  const spatialHost = el('section', { className: 'publisher-analytics-section' })
  const funnelHost = el('section', { className: 'publisher-analytics-section' })
  const perfHost = el('section', { className: 'publisher-analytics-section' })
  const orbitHost = el('section', { className: 'publisher-analytics-section' })
  const researchHost = el('section', { className: 'publisher-analytics-section' })
  let heatmap: HeatmapHandle | null = null
  // The spatial section's DOM (including its export button) is built
  // once and updated data-only on filter changes, so the button's
  // export thunk reads the latest bins from here rather than closing
  // over the first load's data.
  let latestSpatialBins: SpatialData['bins'] = []

  // Dispose on SPA route transitions (same pattern as
  // dataset-detail's transcode polling): mark the render dead so
  // in-flight section loads stop touching the DOM, and tear down
  // the MapLibre instance + its listeners.
  let disposed = false
  const onRouteChange = (): void => {
    disposed = true
    window.removeEventListener(ROUTE_CHANGE_START_EVENT, onRouteChange)
    if (heatmap) {
      heatmap.destroy()
      heatmap = null
    }
  }
  window.addEventListener(ROUTE_CHANGE_START_EVENT, onRouteChange)

  const header = buildHeader(state, () => {
    if (heatmap) {
      heatmap.destroy()
      heatmap = null
    }
    void loadOverview()
    void loadDatasets()
    void loadSpatial()
    void loadFunnel()
    void loadPerf()
    void loadOrbit()
    void loadResearch()
  })

  mount.replaceChildren(
    shell(header, overviewHost, datasetsHost, spatialHost, funnelHost, perfHost, orbitHost, researchHost),
  )

  // Populate on first visit — the header's onChange only covers
  // subsequent control changes.
  void loadOverview()
  void loadDatasets()
  void loadSpatial()
  void loadFunnel()
  void loadPerf()
  void loadOrbit()
  void loadResearch()

  async function fetchSection<T>(query: string): Promise<PublisherApiResult<Envelope<T>>> {
    return publisherGet<Envelope<T>>(`${ANALYTICS_ENDPOINT}${query}`, { fetchFn })
  }

  function baseQuery(section: string): string {
    return `?section=${section}&days=${state.days}&environment=${state.environment}`
  }

  function sectionError(host: HTMLElement, title: string, res: { kind: 'session' | 'network' | 'not_found' | 'server'; status?: number; body?: string }): void {
    if (res.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
    }
    const details = res.kind === 'server' ? { status: res.status, body: res.body } : {}
    host.replaceChildren(sectionHeading(title), buildErrorCard(res.kind, details))
  }

  function sectionHeading(text: string): HTMLElement {
    return el('h2', { className: 'publisher-analytics-heading', textContent: text })
  }

  /** Heading row with an inline "Export CSV" button. `slug` becomes
   * the filename stem
   * (`terraviz-analytics-<slug>-<environment>-<days>d.csv`); the
   * `getRows` thunk runs at click time over the already-loaded data.
   * Used only on success renders — loading/empty/error states keep
   * the bare `sectionHeading`, since there's nothing to export. */
  function sectionHead(text: string, slug: string, getRows: () => CsvRow[]): HTMLElement {
    const filename = `terraviz-analytics-${slug}-${state.environment}-${state.days}d.csv`
    return el('div', { className: 'publisher-analytics-section-head' }, [
      sectionHeading(text),
      csvExportButton(t('publisher.analytics.exportCsv'), filename, getRows),
    ])
  }

  function emptyNote(): HTMLElement {
    return el('p', { className: 'publisher-analytics-empty', textContent: t('publisher.analytics.empty') })
  }

  async function loadOverview(): Promise<void> {
    const title = t('publisher.analytics.section.overview')
    overviewHost.replaceChildren(sectionHeading(title), loadingNote())
    const res = await fetchSection<OverviewData>(baseQuery('overview'))
    if (disposed) return
    if (!res.ok) return sectionError(overviewHost, title, res)
    const data = res.data.data

    const breakdownHost = el('div', { className: 'publisher-analytics-errors' })
    // Stable id so the errors tile can reference it via
    // aria-controls (WAI-ARIA disclosure pattern); the page mounts
    // at most one overview section, so a fixed id is safe.
    breakdownHost.id = 'publisher-analytics-errors-breakdown'
    breakdownHost.hidden = true
    const errorRate = data.totals.sessions > 0 ? data.totals.errors / data.totals.sessions : 0
    const tiles = el('div', { className: 'publisher-analytics-stats' }, [
      renderStatTile(t('publisher.analytics.overview.sessions'), formatNumber(Math.round(data.totals.sessions))),
      renderStatTile(
        t('publisher.analytics.overview.viewTime'),
        data.totals.view_ms > 0 ? formatDurationMs(data.totals.view_ms) : '—',
      ),
      renderStatTile(t('publisher.analytics.overview.events'), formatNumber(Math.round(data.totals.events))),
      buildErrorsTile(Math.round(data.totals.errors), breakdownHost),
      renderStatTile(
        t('publisher.analytics.overview.errorRate'),
        formatNumber(errorRate, { style: 'percent', maximumFractionDigits: 1 }),
      ),
    ])
    const range = rangeOf(res.data)
    // CSV column names are stable technical identifiers, not UI copy —
    // analysts import these downstream, so they stay English across
    // locales. i18n-exempt: machine-readable CSV header
    const overviewRows = (): CsvRow[] => [
      ['day', 'sessions', 'events', 'errors', 'view_minutes'],
      ...data.days.map(d => [
        d.day,
        Math.round(d.sessions),
        Math.round(d.events),
        Math.round(d.errors),
        Math.round(d.view_ms / 60_000),
      ]),
    ]
    const children: (HTMLElement | SVGElement)[] = [
      sectionHead(title, 'overview', overviewRows),
      tiles,
      breakdownHost,
    ]
    if (data.days.length === 0) {
      children.push(emptyNote())
    } else {
      children.push(
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.overview.sessionsPerDay') }),
        renderBarSeries(
          data.days.map(d => ({ label: d.day, value: d.sessions })),
          { ariaLabel: t('publisher.analytics.overview.sessionsPerDay'), range },
        ),
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.overview.viewTimePerDay') }),
        renderBarSeries(
          // Minutes, so tooltips read at human scale.
          data.days.map(d => ({ label: d.day, value: d.view_ms / 60_000 })),
          { ariaLabel: t('publisher.analytics.overview.viewTimePerDay'), range },
        ),
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.overview.platforms') }),
        renderMixBar(data.platforms, t('publisher.analytics.overview.platforms')),
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.overview.operatingSystems') }),
        renderMixBar(data.operatingSystems, t('publisher.analytics.overview.operatingSystems')),
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.overview.countries') }),
        countriesTable(data.countries),
      )
    }
    overviewHost.replaceChildren(...children)
  }

  /** The errors stat doubles as a disclosure button: first click
   * fetches the frequency-ordered breakdown into `host`, later
   * clicks toggle it. State resets whenever the overview reloads
   * (range/environment change), which also refreshes the table. */
  function buildErrorsTile(total: number, host: HTMLElement): HTMLElement {
    const tile = el('button', { className: 'publisher-analytics-stat publisher-analytics-stat-button', type: 'button' })
    tile.setAttribute('aria-expanded', 'false')
    tile.setAttribute('aria-controls', host.id)
    tile.append(
      el('span', { className: 'publisher-analytics-stat-label', textContent: t('publisher.analytics.overview.errors') }),
      el('span', { className: 'publisher-analytics-stat-value', textContent: formatNumber(total) }),
      el('span', { className: 'publisher-analytics-stat-hint', textContent: t('publisher.analytics.errors.expandHint') }),
    )
    let loaded = false
    tile.addEventListener('click', () => {
      const open = tile.getAttribute('aria-expanded') === 'true'
      tile.setAttribute('aria-expanded', String(!open))
      host.hidden = open
      if (!open && !loaded) {
        loaded = true
        void loadErrorsBreakdown(host)
      }
    })
    return tile
  }

  async function loadErrorsBreakdown(host: HTMLElement): Promise<void> {
    const title = t('publisher.analytics.errors.title')
    host.replaceChildren(loadingNote())
    const res = await fetchSection<ErrorsData>(baseQuery('errors'))
    if (disposed) return
    if (!res.ok) return sectionError(host, title, res)
    const rows = res.data.data.errors
    if (rows.length === 0) {
      host.replaceChildren(el('h3', { className: 'publisher-analytics-subheading', textContent: title }), emptyNote())
      return
    }
    const table = el('table', { className: 'publisher-analytics-table' })
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { textContent: t('publisher.analytics.errors.count') }),
          el('th', { textContent: t('publisher.analytics.errors.category') }),
          el('th', { textContent: t('publisher.analytics.errors.source') }),
          el('th', { textContent: t('publisher.analytics.errors.code') }),
          el('th', { textContent: t('publisher.analytics.errors.message') }),
        ]),
      ]),
    )
    const body = el('tbody')
    for (const row of rows) {
      body.append(
        el('tr', {}, [
          el('td', { textContent: formatNumber(Math.round(row.count)) }),
          // category/source/code are low-cardinality telemetry enums;
          // message_class is already sanitized at emit.
          el('td', { textContent: row.category }),
          el('td', { textContent: row.source }),
          el('td', { textContent: row.code || '—' }),
          el('td', { className: 'publisher-analytics-error-message', textContent: row.message_class || '—' }),
        ]),
      )
    }
    table.append(body)
    // i18n-exempt: machine-readable CSV header
    const errorRows = (): CsvRow[] => [
      ['count', 'category', 'source', 'code', 'message_class'],
      ...rows.map(r => [Math.round(r.count), r.category, r.source, r.code, r.message_class]),
    ]
    const head = el('div', { className: 'publisher-analytics-section-head' }, [
      el('h3', { className: 'publisher-analytics-subheading', textContent: title }),
      csvExportButton(
        t('publisher.analytics.exportCsv'),
        `terraviz-analytics-errors-${state.environment}-${state.days}d.csv`,
        errorRows,
      ),
    ])
    host.replaceChildren(
      head,
      table,
      el('p', { className: 'publisher-analytics-footnote', textContent: t('publisher.analytics.errors.orderNote') }),
    )
  }

  async function loadDatasets(): Promise<void> {
    const title = t('publisher.analytics.section.datasets')
    datasetsHost.replaceChildren(sectionHeading(title), loadingNote())
    const res = await fetchSection<DatasetsData>(baseQuery('datasets'))
    if (disposed) return
    if (!res.ok) return sectionError(datasetsHost, title, res)
    const rows = res.data.data.datasets
    if (rows.length === 0) {
      datasetsHost.replaceChildren(sectionHeading(title), emptyNote())
      return
    }
    // i18n-exempt: machine-readable CSV header
    const datasetRows = (): CsvRow[] => [
      ['layer_id', 'title', 'loads', 'trigger_mix', 'source_mix', 'load_ms_p50', 'load_ms_p95', 'dwell_ms_sum'],
      ...rows.map(r => [
        r.layer_id,
        r.title ?? '',
        Math.round(r.loads),
        mixCell(r.trigger_mix),
        mixCell(r.source_mix),
        r.load_ms_p50 != null ? Math.round(r.load_ms_p50) : '',
        r.load_ms_p95 != null ? Math.round(r.load_ms_p95) : '',
        Math.round(r.dwell_ms_sum),
      ]),
    ]
    datasetsHost.replaceChildren(
      sectionHead(title, 'datasets', datasetRows),
      datasetsTable(rows),
      el('p', { className: 'publisher-analytics-footnote', textContent: t('publisher.analytics.datasets.approxNote') }),
    )
  }

  async function loadSpatial(): Promise<void> {
    const title = t('publisher.analytics.section.spatial')
    if (!spatialHost.firstChild) {
      spatialHost.replaceChildren(sectionHeading(title), loadingNote())
    }
    const spatialParams =
      `&event=${encodeURIComponent(state.spatialEvent)}` +
      (state.spatialLayer !== undefined ? `&layer=${encodeURIComponent(state.spatialLayer)}` : '') +
      (state.spatialProjection !== undefined
        ? `&projection=${encodeURIComponent(state.spatialProjection)}`
        : '')
    const res = await fetchSection<SpatialData>(baseQuery('spatial') + spatialParams)
    if (disposed) return
    if (!res.ok) {
      // The error card replaces the section DOM — tear down any
      // mounted map so a later success rebuilds against a live
      // container instead of feeding bins to a detached one.
      if (heatmap) {
        heatmap.destroy()
        heatmap = null
      }
      return sectionError(spatialHost, title, res)
    }
    const data = res.data.data
    latestSpatialBins = data.bins

    if (heatmap) {
      heatmap.setBins(data.bins)
      const note = spatialHost.querySelector<HTMLElement>('.publisher-analytics-empty')
      if (note) note.hidden = data.bins.length > 0
      return
    }

    // i18n-exempt: machine-readable CSV header
    const spatialRows = (): CsvRow[] => [
      ['lat', 'lon', 'hits'],
      ...latestSpatialBins.map(b => [b.lat, b.lon, Math.round(b.hits)]),
    ]
    const controls = spatialControls(data.layers, state, () => void loadSpatial())
    const mapContainer = el('div', { className: 'publisher-analytics-map' })
    mapContainer.setAttribute('role', 'img')
    mapContainer.setAttribute('aria-label', t('publisher.analytics.spatial.mapAria'))
    // Always present, toggled by data-only updates above.
    const note = emptyNote()
    note.hidden = data.bins.length > 0
    const hitKindBlock: HTMLElement[] =
      Object.keys(data.hitKinds).length > 0
        ? [
            el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.spatial.hitKinds') }),
            renderMixBar(data.hitKinds, t('publisher.analytics.spatial.hitKinds')),
          ]
        : []
    spatialHost.replaceChildren(
      sectionHead(title, 'spatial', spatialRows),
      controls,
      mapContainer,
      note,
      ...hitKindBlock,
    )
    const mounted = await mountHeatmap(mapContainer, data.bins)
    if (disposed) {
      // Navigated away while the dynamic import / map boot was in
      // flight — the route-change handler already ran, so this
      // late-created instance is ours to destroy.
      mounted.destroy()
      return
    }
    heatmap = mounted
  }

  async function loadFunnel(): Promise<void> {
    const title = t('publisher.analytics.section.funnel')
    funnelHost.replaceChildren(sectionHeading(title), loadingNote())
    const res = await fetchSection<FunnelData>(baseQuery('funnel'))
    if (disposed) return
    if (!res.ok) return sectionError(funnelHost, title, res)
    const range = rangeOf(res.data)
    const days = res.data.data.days
    if (days.length === 0) {
      funnelHost.replaceChildren(sectionHeading(title), emptyNote())
      return
    }
    const outcomes = res.data.data.outcomes
    const bySource = res.data.data.toursStartedBySource ?? {}
    const toursStarted = days.reduce((n, d) => n + d.tours_started, 0)
    // `runTourOnLoad` auto-tours auto-play to completion; the export
    // job excludes them from the outcomes rollup, so the denominator
    // must drop them too or the rate is understated. Subtract the
    // `auto` source bucket to get user-started tours.
    const autoStarted = bySource.auto ?? 0
    const userStarted = Math.max(0, toursStarted - autoStarted)
    const toursCompleted = outcomes.tour_ended.completed ?? 0
    const completionBlocks: HTMLElement[] = []
    if (toursStarted > 0 || Object.keys(outcomes.tour_ended).length > 0) {
      const tiles: HTMLElement[] = [
        renderStatTile(
          t('publisher.analytics.funnel.completionRate'),
          userStarted > 0
            ? formatNumber(toursCompleted / userStarted, { style: 'percent', maximumFractionDigits: 0 })
            : '—',
        ),
        renderStatTile(
          t('publisher.analytics.funnel.userStarted'),
          formatNumber(userStarted),
        ),
      ]
      if (autoStarted > 0) {
        tiles.push(
          renderStatTile(
            t('publisher.analytics.funnel.autoExcluded'),
            formatNumber(autoStarted),
          ),
        )
      }
      completionBlocks.push(
        el('div', { className: 'publisher-analytics-stats' }, tiles),
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.funnel.tourOutcomes') }),
        renderMixBar(outcomes.tour_ended, t('publisher.analytics.funnel.tourOutcomes')),
      )
    }
    if (Object.keys(outcomes.vr_session_started).length > 0) {
      completionBlocks.push(
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.funnel.vrModes') }),
        renderMixBar(outcomes.vr_session_started, t('publisher.analytics.funnel.vrModes')),
      )
    }
    const series: Array<[string, (d: FunnelData['days'][number]) => number]> = [
      [t('publisher.analytics.funnel.toursStarted'), d => d.tours_started],
      [t('publisher.analytics.funnel.toursEnded'), d => d.tours_ended],
      [t('publisher.analytics.funnel.vrSessions'), d => d.vr_started],
      [t('publisher.analytics.funnel.orbitTurns'), d => d.orbit_turns],
    ]
    const blocks = series.map(([label, pick]) =>
      el('div', { className: 'publisher-analytics-funnel-block' }, [
        el('h3', { className: 'publisher-analytics-subheading', textContent: label }),
        renderBarSeries(
          days.map(d => ({ label: d.day, value: pick(d) })),
          { height: 56, ariaLabel: label, range },
        ),
      ]),
    )
    // i18n-exempt: machine-readable CSV header
    const funnelRows = (): CsvRow[] => [
      ['day', 'tours_started', 'tours_ended', 'vr_started', 'orbit_turns'],
      ...days.map(d => [d.day, d.tours_started, d.tours_ended, d.vr_started, d.orbit_turns]),
    ]
    funnelHost.replaceChildren(
      sectionHead(title, 'funnel', funnelRows),
      ...completionBlocks,
      el('div', { className: 'publisher-analytics-funnel' }, blocks),
    )
  }

  async function loadPerf(): Promise<void> {
    const title = t('publisher.analytics.section.perf')
    perfHost.replaceChildren(sectionHeading(title), loadingNote())
    const res = await fetchSection<PerfData>(baseQuery('perf'))
    if (disposed) return
    if (!res.ok) return sectionError(perfHost, title, res)
    const rows = res.data.data.rows
    if (rows.length === 0) {
      perfHost.replaceChildren(sectionHeading(title), emptyNote())
      return
    }
    const table = el('table', { className: 'publisher-analytics-table' })
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { textContent: t('publisher.analytics.perf.surface') }),
          el('th', { textContent: t('publisher.analytics.perf.renderer') }),
          el('th', { textContent: t('publisher.analytics.perf.fps') }),
          el('th', { textContent: t('publisher.analytics.perf.frameP95') }),
          el('th', { textContent: t('publisher.analytics.perf.jsheap') }),
          el('th', { textContent: t('publisher.analytics.perf.samples') }),
        ]),
      ]),
    )
    const body = el('tbody')
    for (const r of rows) {
      body.append(
        el('tr', {}, [
          el('td', { textContent: r.surface }),
          el('td', { className: 'publisher-analytics-dataset-id', textContent: r.renderer }),
          el('td', { textContent: formatNumber(Math.round(r.avg_fps)) }),
          el('td', { textContent: `${formatNumber(Math.round(r.avg_frame_p95_ms))} ms` }), // i18n-exempt: unit abbreviation
          el('td', { textContent: r.avg_jsheap_mb != null ? `${formatNumber(Math.round(r.avg_jsheap_mb))} MB` : '—' }), // i18n-exempt: unit abbreviation
          el('td', { textContent: formatNumber(Math.round(r.samples)) }),
        ]),
      )
    }
    table.append(body)
    // i18n-exempt: machine-readable CSV header
    const perfRows = (): CsvRow[] => [
      ['surface', 'renderer', 'samples', 'avg_fps', 'avg_frame_p95_ms', 'avg_jsheap_mb'],
      ...rows.map(r => [
        r.surface,
        r.renderer,
        Math.round(r.samples),
        Math.round(r.avg_fps),
        Math.round(r.avg_frame_p95_ms),
        r.avg_jsheap_mb != null ? Math.round(r.avg_jsheap_mb) : '',
      ]),
    ]
    perfHost.replaceChildren(
      sectionHead(title, 'perf', perfRows),
      table,
      el('p', { className: 'publisher-analytics-footnote', textContent: t('publisher.analytics.perf.note') }),
    )
  }

  async function loadOrbit(): Promise<void> {
    const title = t('publisher.analytics.section.orbit')
    orbitHost.replaceChildren(sectionHeading(title), loadingNote())
    const res = await fetchSection<OrbitData>(baseQuery('orbit'))
    if (disposed) return
    if (!res.ok) return sectionError(orbitHost, title, res)
    const { models, days, totals } = res.data.data
    if (models.length === 0) {
      orbitHost.replaceChildren(
        sectionHeading(title),
        el('p', { className: 'publisher-analytics-empty', textContent: t('publisher.analytics.orbit.empty') }),
      )
      return
    }
    const range = rangeOf(res.data)
    const tiles = el('div', { className: 'publisher-analytics-stats' }, [
      renderStatTile(t('publisher.analytics.orbit.rounds'), formatNumber(Math.round(totals.rounds))),
      renderStatTile(t('publisher.analytics.orbit.turns'), formatNumber(Math.round(totals.turns))),
      renderStatTile(t('publisher.analytics.orbit.inputTokens'), formatNumber(Math.round(totals.input_tokens))),
      renderStatTile(t('publisher.analytics.orbit.outputTokens'), formatNumber(Math.round(totals.output_tokens))),
    ])
    const table = el('table', { className: 'publisher-analytics-table' })
    table.append(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { textContent: t('publisher.analytics.orbit.model') }),
          el('th', { textContent: t('publisher.analytics.orbit.rounds') }),
          el('th', { textContent: t('publisher.analytics.orbit.turns') }),
          el('th', { textContent: t('publisher.analytics.orbit.inputTokens') }),
          el('th', { textContent: t('publisher.analytics.orbit.outputTokens') }),
        ]),
      ]),
    )
    const body = el('tbody')
    for (const m of models) {
      body.append(
        el('tr', {}, [
          el('td', { className: 'publisher-analytics-dataset-id', textContent: m.model }),
          el('td', { textContent: formatNumber(Math.round(m.rounds)) }),
          el('td', { textContent: formatNumber(Math.round(m.turns)) }),
          el('td', { textContent: formatNumber(Math.round(m.input_tokens)) }),
          el('td', { textContent: formatNumber(Math.round(m.output_tokens)) }),
        ]),
      )
    }
    table.append(body)
    // i18n-exempt: machine-readable CSV header
    const orbitRows = (): CsvRow[] => [
      ['model', 'rounds', 'turns', 'input_tokens', 'output_tokens'],
      ...models.map(m => [m.model, Math.round(m.rounds), Math.round(m.turns), Math.round(m.input_tokens), Math.round(m.output_tokens)]),
    ]
    const children: (HTMLElement | SVGElement)[] = [sectionHead(title, 'orbit', orbitRows), tiles, table]
    if (days.length > 0) {
      children.push(
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.orbit.roundsPerDay') }),
        renderBarSeries(
          days.map(d => ({ label: d.day, value: d.rounds })),
          { ariaLabel: t('publisher.analytics.orbit.roundsPerDay'), range },
        ),
      )
    }
    children.push(el('p', { className: 'publisher-analytics-footnote', textContent: t('publisher.analytics.tierBNote') }))
    orbitHost.replaceChildren(...children)
  }

  async function loadResearch(): Promise<void> {
    const title = t('publisher.analytics.section.research')
    researchHost.replaceChildren(sectionHeading(title), loadingNote())
    const res = await fetchSection<ResearchData>(baseQuery('research'))
    if (disposed) return
    if (!res.ok) return sectionError(researchHost, title, res)
    const d = res.data.data
    const empty =
      d.topSearches.length === 0 &&
      d.zeroSearches.length === 0 &&
      d.dwell.length === 0 &&
      d.gestures.length === 0 &&
      d.corrections.length === 0 &&
      d.followThrough.length === 0 &&
      d.worstQuestions.length === 0
    if (empty) {
      researchHost.replaceChildren(
        sectionHeading(title),
        el('p', { className: 'publisher-analytics-empty', textContent: t('publisher.analytics.research.empty') }),
      )
      return
    }
    // One CSV across the section's sub-tables, keyed by a `group`
    // column; the `detail` column carries each group's extra measure
    // (avg length / dwell ms / magnitude / latency ms), blank where
    // none. Questions flatten to key=`tour_id/question_id`,
    // count=answered, detail=correct_rate.
    // i18n-exempt: machine-readable CSV header
    const researchRows = (): CsvRow[] => {
      const rows: CsvRow[] = [['group', 'key', 'count', 'detail']]
      for (const r of d.topSearches) rows.push(['top_search', r.key, Math.round(r.count), Math.round(r.avg_length)])
      for (const r of d.zeroSearches) rows.push(['zero_search', r.key, Math.round(r.count), ''])
      for (const r of d.dwell) rows.push(['dwell', r.key, Math.round(r.count), Math.round(r.avg_ms)])
      for (const r of d.gestures) rows.push(['gesture', r.key, Math.round(r.count), r.avg_magnitude])
      for (const r of d.corrections) rows.push(['correction', r.key, Math.round(r.count), ''])
      for (const r of d.followThrough) rows.push(['follow_through', r.key, Math.round(r.count), Math.round(r.avg_latency_ms)])
      for (const q of d.worstQuestions) rows.push(['question', `${q.tour_id}/${q.question_id}`, Math.round(q.answered), q.correct_rate])
      return rows
    }
    const children: HTMLElement[] = [sectionHead(title, 'research', researchRows)]
    const keyValueTable = <R extends { key: string; count: number }>(
      label: string,
      rows: R[],
      extraHeader?: string,
      extra?: (r: R) => string,
    ): void => {
      if (rows.length === 0) return
      const table = el('table', { className: 'publisher-analytics-table' })
      const head = [
        el('th', { textContent: t('publisher.analytics.research.key') }),
        el('th', { textContent: t('publisher.analytics.research.count') }),
      ]
      if (extraHeader) head.push(el('th', { textContent: extraHeader }))
      table.append(el('thead', {}, [el('tr', {}, head)]))
      const body = el('tbody')
      for (const r of rows) {
        const cells = [
          // Keys are hashed queries / enum values — verbatim.
          // i18n-exempt: technical identifier
          el('td', { className: 'publisher-analytics-dataset-id', textContent: r.key }),
          el('td', { textContent: formatNumber(Math.round(r.count)) }),
        ]
        if (extra) cells.push(el('td', { textContent: extra(r) }))
        body.append(el('tr', {}, cells))
      }
      table.append(body)
      children.push(el('h3', { className: 'publisher-analytics-subheading', textContent: label }), table)
    }

    keyValueTable(
      t('publisher.analytics.research.topSearches'),
      d.topSearches,
      t('publisher.analytics.research.avgLength'),
      r => formatNumber(Math.round(r.avg_length)),
    )
    keyValueTable(t('publisher.analytics.research.zeroSearches'), d.zeroSearches)
    keyValueTable(
      t('publisher.analytics.research.dwell'),
      d.dwell,
      t('publisher.analytics.research.avgDwell'),
      r => formatDurationMs(r.avg_ms),
    )
    keyValueTable(
      t('publisher.analytics.research.gestures'),
      d.gestures,
      t('publisher.analytics.research.avgMagnitude'),
      r => formatNumber(r.avg_magnitude, { maximumFractionDigits: 2 }),
    )
    keyValueTable(t('publisher.analytics.research.corrections'), d.corrections)
    keyValueTable(
      t('publisher.analytics.research.followThrough'),
      d.followThrough,
      t('publisher.analytics.research.avgLatency'),
      r => `${formatNumber(Math.round(r.avg_latency_ms))} ms`, // i18n-exempt: unit abbreviation
    )

    if (d.worstQuestions.length > 0) {
      const table = el('table', { className: 'publisher-analytics-table' })
      table.append(
        el('thead', {}, [
          el('tr', {}, [
            el('th', { textContent: t('publisher.analytics.research.tour') }),
            el('th', { textContent: t('publisher.analytics.research.question') }),
            el('th', { textContent: t('publisher.analytics.research.answered') }),
            el('th', { textContent: t('publisher.analytics.research.correctRate') }),
          ]),
        ]),
      )
      const body = el('tbody')
      for (const q of d.worstQuestions) {
        body.append(
          el('tr', {}, [
            el('td', { className: 'publisher-analytics-dataset-id', textContent: q.tour_id }),
            el('td', { className: 'publisher-analytics-dataset-id', textContent: q.question_id }),
            el('td', { textContent: formatNumber(Math.round(q.answered)) }),
            el('td', { textContent: formatNumber(q.correct_rate, { style: 'percent', maximumFractionDigits: 0 }) }),
          ]),
        )
      }
      table.append(body)
      children.push(
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.research.worstQuestions') }),
        table,
      )
    }
    children.push(el('p', { className: 'publisher-analytics-footnote', textContent: t('publisher.analytics.tierBNote') }))
    researchHost.replaceChildren(...children)
  }

  function loadingNote(): HTMLElement {
    return el('p', { className: 'publisher-loading', textContent: t('publisher.analytics.loading') })
  }

  function countriesTable(countries: OverviewData['countries']): HTMLElement {
    const table = el('table', { className: 'publisher-analytics-table' })
    const head = el('tr', {}, [
      el('th', { textContent: t('publisher.analytics.overview.country') }),
      el('th', { textContent: t('publisher.analytics.overview.sessions') }),
    ])
    table.append(el('thead', {}, [head]))
    const body = el('tbody')
    for (const row of countries) {
      body.append(
        el('tr', {}, [
          el('td', { textContent: row.country }),
          el('td', { textContent: formatNumber(Math.round(row.sessions)) }),
        ]),
      )
    }
    table.append(body)
    return table
  }

  function datasetsTable(rows: DatasetsData['datasets']): HTMLElement {
    const table = el('table', { className: 'publisher-analytics-table' })
    const head = el('tr', {}, [
      el('th', { textContent: t('publisher.analytics.datasets.dataset') }),
      el('th', { textContent: t('publisher.analytics.datasets.loads') }),
      el('th', { textContent: t('publisher.analytics.datasets.triggers') }),
      el('th', { textContent: t('publisher.analytics.datasets.sources') }),
      el('th', { textContent: t('publisher.analytics.datasets.loadP50') }),
      el('th', { textContent: t('publisher.analytics.datasets.loadP95') }),
      el('th', { textContent: t('publisher.analytics.datasets.dwell') }),
    ])
    table.append(el('thead', {}, [head]))
    const body = el('tbody')
    for (const row of rows) {
      // The catalog title is the identity humans read; the raw
      // telemetry id survives only as a hover tooltip for the rare
      // correlate-with-AE/rollup-tables debugging need. Rows whose
      // id resolves to no catalog title show the id itself — it's
      // the only identifier they have.
      const nameCell = el('td', { className: 'publisher-analytics-dataset' }, [
        el('span', {
          className: row.title ? 'publisher-analytics-dataset-title' : 'publisher-analytics-dataset-id',
          textContent: row.title ?? row.layer_id,
        }),
      ])
      nameCell.title = row.layer_id
      body.append(
        el('tr', {}, [
          nameCell,
          el('td', { textContent: formatNumber(Math.round(row.loads)) }),
          el('td', {}, [renderMixBar(row.trigger_mix, t('publisher.analytics.datasets.triggers'))]),
          el('td', {}, [renderMixBar(row.source_mix, t('publisher.analytics.datasets.sources'))]),
          el('td', { textContent: row.load_ms_p50 != null ? `${formatNumber(Math.round(row.load_ms_p50))} ms` : '—' }), // i18n-exempt: unit abbreviation
          el('td', { textContent: row.load_ms_p95 != null ? `${formatNumber(Math.round(row.load_ms_p95))} ms` : '—' }), // i18n-exempt: unit abbreviation
          el('td', { textContent: row.dwell_ms_sum > 0 ? formatDurationMs(row.dwell_ms_sum) : '—' }),
        ]),
      )
    }
    table.append(body)
    return table
  }
}

// --- Header controls -------------------------------------------------

function buildHeader(state: PageState, onChange: () => void): HTMLElement {
  const heading = document.createElement('h1')
  heading.textContent = t('publisher.analytics.title')

  const note = document.createElement('p')
  note.className = 'publisher-analytics-freshness'
  note.textContent = t('publisher.analytics.freshness')

  const controls = document.createElement('div')
  controls.className = 'publisher-analytics-controls'

  const rangeSelect = labeledSelect(
    t('publisher.analytics.controls.range'),
    RANGE_CHOICES.map(d => ({
      value: String(d),
      label: t('publisher.analytics.controls.rangeDays', { days: String(d) }),
    })),
    String(state.days),
    value => {
      state.days = parseInt(value, 10) as PageState['days']
      onChange()
    },
  )
  const envSelect = labeledSelect(
    t('publisher.analytics.controls.environment'),
    [
      { value: 'production', label: t('publisher.analytics.env.production') },
      { value: 'preview', label: t('publisher.analytics.env.preview') },
    ],
    state.environment,
    value => {
      state.environment = value as PageState['environment']
      onChange()
    },
  )
  controls.append(rangeSelect, envSelect)

  const header = document.createElement('header')
  header.className = 'publisher-analytics-header'
  header.append(heading, note, controls)
  return header
}

function spatialControls(
  layers: Array<{ id: string; title: string | null }>,
  state: PageState,
  onChange: () => void,
): HTMLElement {
  const host = document.createElement('div')
  host.className = 'publisher-analytics-controls'

  host.append(
    labeledSelect(
      t('publisher.analytics.spatial.event'),
      [
        { value: 'camera_settled', label: t('publisher.analytics.spatial.eventCamera') },
        { value: 'map_click', label: t('publisher.analytics.spatial.eventClicks') },
      ],
      state.spatialEvent,
      value => {
        state.spatialEvent = value as PageState['spatialEvent']
        onChange()
      },
    ),
    labeledSelect(
      t('publisher.analytics.spatial.dataset'),
      [
        { value: '*', label: t('publisher.analytics.spatial.allDatasets') },
        { value: '', label: t('publisher.analytics.spatial.defaultEarth') },
        ...layers
          .filter(layer => layer.id !== '')
          .map(layer => ({ value: layer.id, label: layer.title ?? layer.id })),
      ],
      state.spatialLayer ?? '*',
      value => {
        state.spatialLayer = value === '*' ? undefined : value
        onChange()
      },
    ),
    labeledSelect(
      t('publisher.analytics.spatial.projection'),
      [
        { value: '*', label: t('publisher.analytics.spatial.allProjections') },
        { value: 'globe', label: t('publisher.analytics.spatial.projGlobe') },
        { value: 'mercator', label: t('publisher.analytics.spatial.projMercator') },
        { value: 'vr', label: t('publisher.analytics.spatial.projVr') },
        { value: 'ar', label: t('publisher.analytics.spatial.projAr') },
      ],
      state.spatialProjection ?? '*',
      value => {
        state.spatialProjection = value === '*' ? undefined : value
        onChange()
      },
    ),
  )
  return host
}

function labeledSelect(
  labelText: string,
  optionDefs: Array<{ value: string; label: string }>,
  selected: string,
  onChange: (value: string) => void,
): HTMLElement {
  const label = document.createElement('label')
  label.className = 'publisher-analytics-control'
  const caption = document.createElement('span')
  caption.textContent = labelText
  const select = document.createElement('select')
  for (const def of optionDefs) {
    const option = document.createElement('option')
    option.value = def.value
    option.textContent = def.label
    if (def.value === selected) option.selected = true
    select.appendChild(option)
  }
  select.addEventListener('change', () => onChange(select.value))
  label.append(caption, select)
  return label
}

// --- MapLibre heatmap -------------------------------------------------

interface HeatmapHandle {
  setBins(bins: SpatialData['bins']): void
  destroy(): void
}

function binsToGeoJson(bins: SpatialData['bins']): GeoJSON.FeatureCollection {
  const max = Math.max(...bins.map(b => b.hits), 1)
  return {
    type: 'FeatureCollection',
    features: bins.map(b => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        // Bin values are the cell's south-west corner; render at
        // the cell center.
        coordinates: [b.lon + 0.25, b.lat + 0.25],
      },
      properties: { weight: b.hits / max },
    })),
  }
}

async function mountHeatmap(container: HTMLElement, bins: SpatialData['bins']): Promise<HeatmapHandle> {
  const [{ default: maplibregl }] = await Promise.all([
    import('maplibre-gl'),
    // Vite injects the stylesheet on dynamic import; the portal CSS
    // bundle stays map-free until this section first renders.
    import('maplibre-gl/dist/maplibre-gl.css'),
  ])

  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        land: { type: 'geojson', data: LAND_GEOJSON_URL },
        borders: { type: 'geojson', data: BORDERS_GEOJSON_URL },
      },
      layers: [
        { id: 'ocean', type: 'background', paint: { 'background-color': OCEAN_COLOR } },
        { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': LAND_COLOR } },
        {
          id: 'borders',
          type: 'line',
          source: 'borders',
          paint: { 'line-color': BORDER_COLOR, 'line-width': 0.6 },
        },
      ],
    },
    center: [0, 20],
    zoom: 0.9,
    attributionControl: false,
  })

  // `setBins` before the map's `load` event would be a silent no-op
  // (the GeoJSON source doesn't exist yet) — keep the latest bins
  // and apply them when the source is created.
  let latestBins = bins
  let sourceReady = false

  map.on('load', () => {
    map.addSource('attention', { type: 'geojson', data: binsToGeoJson(latestBins) })
    map.addLayer({
      id: 'attention-heat',
      type: 'heatmap',
      source: 'attention',
      paint: {
        'heatmap-weight': ['get', 'weight'],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.8, 8, 2],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 8, 4, 22, 8, 44],
        'heatmap-opacity': 0.85,
      },
    })
    sourceReady = true
  })

  return {
    setBins(next) {
      latestBins = next
      if (!sourceReady) return
      const source = map.getSource('attention')
      if (source && 'setData' in source) {
        ;(source as { setData(data: GeoJSON.FeatureCollection): void }).setData(binsToGeoJson(next))
      }
    },
    destroy() {
      map.remove()
    },
  }
}
