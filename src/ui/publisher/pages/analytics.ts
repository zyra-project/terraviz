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
 *                     the basemap reuses the same `/api/tile/…` GIBS
 *                     proxy as the SPA (on bare localhost dev the
 *                     proxy is absent and the heatmap draws on a
 *                     dark background — acceptable).
 *   - Tours, VR &   — per-day engagement counts. (The rollups don't
 *     Orbit           split tour_ended by outcome; a true completion
 *                     funnel is an open question in the plan doc.)
 *
 * Range / environment controls reload every section; the
 * spatial-only filters reload just the heatmap data.
 */

import { t } from '../../../i18n'
import { formatNumber } from '../../../i18n/format'
import { publisherGet, handleSessionError, type PublisherApiResult } from '../api'
import { buildErrorCard } from '../components/error-card'
import {
  formatDurationMs,
  renderBarSeries,
  renderMixBar,
  renderStatTile,
} from '../analytics-charts'

const ME_ENDPOINT = '/api/v1/publish/me'
const ANALYTICS_ENDPOINT = '/api/v1/publish/analytics'
/** Same GIBS proxy path the SPA's basemap uses (`mapRenderer.ts`). */
const BASEMAP_TILES = '/api/tile/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'
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
  days: Array<{ day: string; sessions: number; events: number; errors: number }>
  platforms: Record<string, number>
  countries: Array<{ country: string; sessions: number }>
  totals: { sessions: number; events: number; errors: number }
}

interface DatasetsData {
  datasets: Array<{
    layer_id: string
    loads: number
    trigger_mix: Record<string, number>
    source_mix: Record<string, number>
    load_ms_p50: number | null
    load_ms_p95: number | null
    dwell_ms_sum: number
  }>
}

interface SpatialData {
  layers: string[]
  bins: Array<{ lat: number; lon: number; hits: number }>
}

interface FunnelData {
  days: Array<{
    day: string
    tours_started: number
    tours_ended: number
    vr_started: number
    orbit_turns: number
  }>
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
  let heatmap: HeatmapHandle | null = null

  const header = buildHeader(state, () => {
    if (heatmap) {
      heatmap.destroy()
      heatmap = null
    }
    void loadOverview()
    void loadDatasets()
    void loadSpatial()
    void loadFunnel()
  })

  mount.replaceChildren(shell(header, overviewHost, datasetsHost, spatialHost, funnelHost))

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

  function emptyNote(): HTMLElement {
    return el('p', { className: 'publisher-analytics-empty', textContent: t('publisher.analytics.empty') })
  }

  async function loadOverview(): Promise<void> {
    const title = t('publisher.analytics.section.overview')
    overviewHost.replaceChildren(sectionHeading(title), loadingNote())
    const res = await fetchSection<OverviewData>(baseQuery('overview'))
    if (!res.ok) return sectionError(overviewHost, title, res)
    const data = res.data.data

    const tiles = el('div', { className: 'publisher-analytics-stats' }, [
      renderStatTile(t('publisher.analytics.overview.sessions'), formatNumber(Math.round(data.totals.sessions))),
      renderStatTile(t('publisher.analytics.overview.events'), formatNumber(Math.round(data.totals.events))),
      renderStatTile(t('publisher.analytics.overview.errors'), formatNumber(Math.round(data.totals.errors))),
    ])
    const children: (HTMLElement | SVGElement)[] = [sectionHeading(title), tiles]
    if (data.days.length === 0) {
      children.push(emptyNote())
    } else {
      children.push(
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.overview.sessionsPerDay') }),
        renderBarSeries(
          data.days.map(d => ({ label: d.day, value: d.sessions })),
          { ariaLabel: t('publisher.analytics.overview.sessionsPerDay') },
        ),
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.overview.platforms') }),
        renderMixBar(data.platforms, t('publisher.analytics.overview.platforms')),
        el('h3', { className: 'publisher-analytics-subheading', textContent: t('publisher.analytics.overview.countries') }),
        countriesTable(data.countries),
      )
    }
    overviewHost.replaceChildren(...(children as HTMLElement[]))
  }

  async function loadDatasets(): Promise<void> {
    const title = t('publisher.analytics.section.datasets')
    datasetsHost.replaceChildren(sectionHeading(title), loadingNote())
    const res = await fetchSection<DatasetsData>(baseQuery('datasets'))
    if (!res.ok) return sectionError(datasetsHost, title, res)
    const rows = res.data.data.datasets
    if (rows.length === 0) {
      datasetsHost.replaceChildren(sectionHeading(title), emptyNote())
      return
    }
    datasetsHost.replaceChildren(
      sectionHeading(title),
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
      `&event=${state.spatialEvent}` +
      (state.spatialLayer !== undefined ? `&layer=${encodeURIComponent(state.spatialLayer)}` : '') +
      (state.spatialProjection !== undefined ? `&projection=${state.spatialProjection}` : '')
    const res = await fetchSection<SpatialData>(baseQuery('spatial') + spatialParams)
    if (!res.ok) return sectionError(spatialHost, title, res)
    const data = res.data.data

    if (heatmap) {
      heatmap.setBins(data.bins)
      return
    }

    const controls = spatialControls(data.layers, state, () => void loadSpatial())
    const mapContainer = el('div', { className: 'publisher-analytics-map' })
    mapContainer.setAttribute('role', 'img')
    mapContainer.setAttribute('aria-label', t('publisher.analytics.spatial.mapAria'))
    const empty = data.bins.length === 0 ? [emptyNote()] : []
    spatialHost.replaceChildren(sectionHeading(title), controls, mapContainer, ...empty)
    heatmap = await mountHeatmap(mapContainer, data.bins)
  }

  async function loadFunnel(): Promise<void> {
    const title = t('publisher.analytics.section.funnel')
    funnelHost.replaceChildren(sectionHeading(title), loadingNote())
    const res = await fetchSection<FunnelData>(baseQuery('funnel'))
    if (!res.ok) return sectionError(funnelHost, title, res)
    const days = res.data.data.days
    if (days.length === 0) {
      funnelHost.replaceChildren(sectionHeading(title), emptyNote())
      return
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
          { height: 56, ariaLabel: label },
        ),
      ]),
    )
    funnelHost.replaceChildren(
      sectionHeading(title),
      el('div', { className: 'publisher-analytics-funnel' }, blocks),
    )
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
      body.append(
        el('tr', {}, [
          el('td', { className: 'publisher-analytics-dataset-id', textContent: row.layer_id }),
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

function spatialControls(layers: string[], state: PageState, onChange: () => void): HTMLElement {
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
        ...layers.filter(id => id !== '').map(id => ({ value: id, label: id })),
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
        basemap: { type: 'raster', tiles: [BASEMAP_TILES], tileSize: 256, maxzoom: 8 },
      },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
    },
    center: [0, 20],
    zoom: 0.9,
    attributionControl: false,
  })

  map.on('load', () => {
    map.addSource('attention', { type: 'geojson', data: binsToGeoJson(bins) })
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
  })

  return {
    setBins(next) {
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
