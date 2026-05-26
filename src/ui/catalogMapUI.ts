/**
 * Catalog Map view — UI mount + MapLibre wiring.
 *
 * Phase 4 §6.9 of `docs/WEB_CATALOG_FEATURES_PLAN.md`. The pure
 * data transform lives in `src/services/catalogMap.ts`; this
 * module owns the second MapRenderer instance (mercator projection),
 * the bbox-overlay layer, the draw-rectangle gesture, the
 * include-globals toggle, and the hover / overlap tooltips.
 *
 * Lazy-loaded — `browseUI.ts` imports `createCatalogMap` only when
 * the user first toggles into Map view, so the default Cards path
 * pays nothing for the second MapRenderer instance. Mirrors the
 * cytoscape pattern in `catalogGraphUI.ts` and the d3 pattern in
 * `catalogTimelineUI.ts`.
 *
 * Library choice: reuse MapLibre at `projection: 'mercator'` (the
 * §6.9 plan's recommendation). MapLibre is already in the bundle
 * at ~200 KB gzipped; the GIBS Blue Marble + Black Marble tile
 * sources are already cached by `tilePreloader.ts`. **Zero new
 * library bytes**, **zero new tile-fetching code** — only the new
 * module code is the bundle cost.
 *
 * Layout:
 *
 *   .browse-map-host (flex column)
 *     .browse-map-toolbar      (legend + global toggle + draw-mode toggle)
 *     .browse-map-canvas       (flex 1, MapLibre mounts here)
 *     .browse-map-footnote     (conditional global-hidden / undated callouts)
 *     .browse-map-empty        (no-rows fallback)
 *
 * The mercator axis reads east-to-right and west-to-left regardless
 * of locale — that's a deliberate exception alongside the Timeline
 * axis (and matches the GSL Depot Explorer's Map tab). Geographic
 * orientation is a universal convention; flipping it would surprise
 * the reader.
 */

import type { LngLat, MapMouseEvent, GeoJSONSource } from 'maplibre-gl'

import {
  buildMap,
  type CatalogMap,
  type MapBboxOverlay,
} from '../services/catalogMap'
import { type FilterState } from '../services/datasetFilter'
import type { Dataset } from '../types'
import { emit } from '../analytics'
import { round } from '../analytics/camera'
import { MapRenderer } from '../services/mapRenderer'
import { escapeHtml, escapeAttr } from './domUtils'
import { plural, t } from '../i18n'
import { formatNumber } from '../i18n/format'

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Source + layer IDs for the bbox overlays. Module-local
 *  constants so the source / layer IDs stay in sync between
 *  `add`, `setData`, and tear-down call sites. */
const BBOX_SOURCE_ID = 'catalog-map-bboxes'
const BBOX_FILL_LAYER_ID = 'catalog-map-bboxes-fill'
const BBOX_OUTLINE_LAYER_ID = 'catalog-map-bboxes-outline'
const BBOX_REALTIME_LAYER_ID = 'catalog-map-bboxes-realtime'

/** Per-minute throttle budget for `catalog_map_region_drawn`. Same
 *  shape as `camera_settled` and `catalog_timeline_brush_applied`
 *  so a draw-spam session can't burn the session's analytics
 *  budget. */
const DRAW_EMIT_MAX_PER_MINUTE = 30
const DRAW_EMIT_WINDOW_MS = 60_000

/** Cap on dataset titles in the overlap tooltip — per the §6.9
 *  plan's "top 8 by relevance + N more" convention. */
const OVERLAP_TOOLTIP_TOP_N = 8

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface CatalogMapCallbacks {
  /**
   * Draw-rectangle gesture committed a new region. `bounds` is
   * `null` when the user cleared the region (e.g. the chip rail's
   * × button removed the predicate); otherwise it's the canonical
   * NSEW shape the `geographicRegion` predicate carries.
   *
   * Goes through the same `setFacet('geographicRegion', ...)`
   * mutation path the chip rail's range inputs and the Timeline
   * brush both use, so draw + chip stay agreement-by-construction.
   */
  onRegionChange: (bounds: { n: number; s: number; e: number; w: number } | null) => void
  /**
   * Click on a bbox — surface the dataset's card with metadata
   * expanded. Same shape as Graph view's dataset-node click and
   * Timeline view's row click so all three non-Cards views read
   * as one interaction system.
   */
  onPreviewDataset: (datasetId: string) => void
}

export interface CatalogMapUpdate {
  datasets: readonly Dataset[]
  filterState: FilterState
  /** Free-text portion of the search query (prefix tokens are
   *  already merged into filterState by the caller). */
  searchQuery: string
}

export interface CatalogMapController {
  /** Re-render with the current dataset / filter state. */
  update: (input: CatalogMapUpdate) => void
  /** Tear down the MapLibre instance + listeners. */
  destroy: () => void
}

// ---------------------------------------------------------------------------
// Bbox → GeoJSON polygon
// ---------------------------------------------------------------------------

/**
 * Convert a bbox overlay to a GeoJSON polygon. Antimeridian-crossing
 * boxes wrap east longitude past 180° (e.g. `e: -170, w: 170` →
 * polygon `[170, 170, 190, 190]`) so MapLibre renders the rectangle
 * continuously across the dateline instead of as two half-rectangles
 * pinned to the canvas edges.
 *
 * Coordinates are emitted in `[lon, lat]` order (GeoJSON convention,
 * NOT the Dataset's NSEW shape). Closed ring — last point repeats
 * the first.
 */
function bboxToPolygon(overlay: MapBboxOverlay): GeoJSON.Feature<GeoJSON.Polygon> {
  const { n, s, e, w } = overlay.bounds
  const east = overlay.crossesAntimeridian ? e + 360 : e
  return {
    type: 'Feature',
    properties: {
      datasetId: overlay.datasetId,
      title: overlay.title,
      n,
      s,
      e,
      w,
      isRealtime: overlay.isRealtime,
      crossesAntimeridian: overlay.crossesAntimeridian,
      global: overlay.global,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [w, s],
        [east, s],
        [east, n],
        [w, n],
        [w, s],
      ]],
    },
  }
}

// ---------------------------------------------------------------------------
// Module entry
// ---------------------------------------------------------------------------

/**
 * Build the in-DOM chrome, mount a mercator MapRenderer, and
 * return a controller exposing `update` and `destroy`.
 *
 * The host element's children are replaced; callers should pass
 * an empty container (or accept that previous contents are
 * cleared).
 */
export function createCatalogMap(
  host: HTMLElement,
  callbacks: CatalogMapCallbacks,
): CatalogMapController {
  host.innerHTML = ''
  host.classList.add('browse-map-host')

  // --- Toolbar: legend + global toggle + draw-mode toggle ---
  // Mirrors the Graph + Timeline toolbar shapes for a consistent
  // visual rhythm across the three non-Cards views.
  const toolbar = document.createElement('div')
  toolbar.className = 'browse-map-toolbar'
  toolbar.innerHTML = `
    <div class="browse-map-legend" aria-hidden="true">
      <span class="browse-map-legend-dot browse-map-legend-dot-coverage"></span>${escapeHtml(t('browse.map.legend.coverage'))}
      <span class="browse-map-legend-dot browse-map-legend-dot-realtime"></span>${escapeHtml(t('browse.map.legend.realtime'))}
    </div>
    <label class="browse-map-include-global">
      <input type="checkbox" class="browse-map-include-global-input" />
      ${escapeHtml(t('browse.map.includeGlobal.label'))}
    </label>
    <button type="button"
            class="browse-map-draw-toggle"
            aria-pressed="false"
            aria-label="${escapeAttr(t('browse.map.draw.aria'))}">
      ${escapeHtml(t('browse.map.draw.label'))}
    </button>
    <button type="button"
            class="browse-map-clear-region hidden"
            aria-label="${escapeAttr(t('browse.map.clearRegion.aria'))}">
      ${escapeHtml(t('browse.map.clearRegion.label'))}
    </button>
  `

  // Canvas — MapLibre mounts inside this div. The dedicated wrapper
  // lets us position the tooltip relatively without fighting
  // MapLibre's own DOM tree. `role="region"` + a live aria-label
  // updated from the rendered count (in `rebuild`) gives screen
  // readers context for the interactive map surface — same shape
  // catalogGraphUI uses for the graph canvas.
  const canvas = document.createElement('div')
  canvas.className = 'browse-map-canvas'
  canvas.setAttribute('role', 'region')
  canvas.setAttribute('aria-label', t('browse.map.region.aria', { count: 0 }))

  const tooltip = document.createElement('div')
  tooltip.className = 'browse-map-tooltip hidden'
  tooltip.setAttribute('role', 'tooltip')

  /**
   * Explanatory banner that surfaces above the canvas when the
   * visible result set is dominated by global bboxes. The SOS
   * catalog today is overwhelmingly worldwide (sea-surface temp,
   * atmospheric reanalysis, satellite imagery), so a Map view
   * without context would look broken — "what am I supposed to
   * see?" The banner names the situation so the user understands
   * the (near-)uniform colour wash is data shape, not a render bug.
   */
  const banner = document.createElement('div')
  banner.className = 'browse-map-banner hidden'
  banner.setAttribute('role', 'note')

  const empty = document.createElement('div')
  empty.className = 'browse-map-empty hidden'
  empty.setAttribute('role', 'status')
  empty.textContent = t('browse.map.empty')

  const footnote = document.createElement('div')
  footnote.className = 'browse-map-footnote hidden'
  footnote.setAttribute('role', 'note')

  host.appendChild(toolbar)
  host.appendChild(banner)
  host.appendChild(canvas)
  // Tooltip is appended INSIDE the canvas wrapper so its
  // `position: absolute` coordinates resolve against the canvas
  // origin — the renderTooltipAt() positioner uses MapLibre's
  // `e.point` which is canvas-relative pixels. Appending as a
  // sibling of canvas would offset the tooltip by the toolbar
  // height and the row gap.
  canvas.appendChild(tooltip)
  host.appendChild(empty)
  host.appendChild(footnote)

  // --- Toolbar wiring ---
  const includeGlobalInput = toolbar.querySelector('.browse-map-include-global-input') as HTMLInputElement
  const drawToggleBtn = toolbar.querySelector('.browse-map-draw-toggle') as HTMLButtonElement
  const clearRegionBtn = toolbar.querySelector('.browse-map-clear-region') as HTMLButtonElement

  // --- Mercator MapRenderer ---
  const renderer = new MapRenderer()
  renderer.init(canvas, {
    canvasId: 'browse-map-gl-canvas',
    projection: 'mercator',
  })
  const initialMap = renderer.getMap()
  if (!initialMap) {
    // Defensive: init() always sets the map synchronously in the
    // browser; this branch is for the off-chance of a future
    // refactor that defers it. Drop into a degraded "couldn't mount"
    // state instead of crashing.
    empty.textContent = t('browse.map.loadError')
    empty.classList.remove('hidden')
    canvas.classList.add('hidden')
    return {
      update: () => {},
      destroy: () => {
        renderer.dispose()
        host.innerHTML = ''
      },
    }
  }
  // Stable non-null reference for nested functions — TS narrows
  // `initialMap` within this block but not inside `setupBboxLayers`
  // / `rebuild` / event handlers defined further down.
  const map = initialMap

  // Disable MapLibre's box-zoom — Shift+drag would otherwise
  // zoom into a screen rectangle, which would collide with any
  // future "Shift+drag to draw a region" affordance and is also
  // disorienting at the Map view's wide-zoom-out home position.
  // Today the draw-rectangle gesture is reached via the explicit
  // "Draw region" mode toggle in the toolbar (Shift modifier
  // intentionally NOT wired — the plan picked an explicit mode
  // for discoverability over a hidden modifier). `setDrawMode`
  // additionally disables drag-pan + scroll-zoom while the mode
  // is active so the drag is unambiguous. Double-click resets
  // the camera; we leave that intact.
  map.boxZoom.disable()

  // --- State carried across update() calls ---
  let lastInput: CatalogMapUpdate | null = null
  let includeGlobal = false
  let drawMode = false
  let lastRendered: CatalogMap | null = null
  /**
   * One-shot auto-flip flag. When the controller first renders
   * and finds that *every* visible dataset has been suppressed
   * by `includeGlobal: false` (i.e. the catalog has only global
   * bboxes today and no regional ones), we flip the toggle on
   * so the canvas isn't empty on first open. This is a v1 reality
   * concession — the SOS catalog is overwhelmingly worldwide and
   * `wireToDataset` defaults missing bboxes to global, so the
   * default `includeGlobal: false` would produce a blank Map
   * surface for every user until publishers start adding regional
   * bboxes.
   *
   * Tracked so we only auto-flip once per mount: a deliberate
   * user-toggle back to "include global off" must stick across
   * subsequent rebuilds (chip-rail clicks etc.) without us
   * flipping it back on.
   */
  let hasAutoFlippedGlobal = false
  // Rolling timestamps for the per-minute draw-emit throttle. Same
  // shape as `camera.ts` and `catalogTimelineUI.ts`.
  const drawEmits: number[] = []
  // Draw-rectangle in-progress state. `start` is the geographic
  // origin of the drag; `box` is the DOM overlay rectangle we draw
  // while the user drags. Both null when no drag is in flight.
  let drawStart: LngLat | null = null
  let drawBox: HTMLDivElement | null = null
  let drawStartScreen: { x: number; y: number } | null = null

  // The map's `load` event fires asynchronously; everything that
  // touches the style waits for it. Pending updates queue up via
  // `lastInput` so the first call before `load` still renders.
  let mapReady = false
  map.on('load', () => {
    mapReady = true
    setupBboxLayers()
    if (lastInput) rebuild()
  })

  function setupBboxLayers(): void {
    // Single GeoJSON source for all bboxes. Empty FeatureCollection
    // at boot; `rebuild` calls `setData` with the live overlays.
    map.addSource(BBOX_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    // Fill layer — translucent teal matching the Graph + Timeline
    // category-content hue, so all three view-modes share one
    // visual taxonomy. Real-time rows get a green accent via the
    // third layer.
    //
    // Global bboxes use a near-transparent fill (0.015) so a stack
    // of N world-rectangles compounds to a barely-visible wash
    // instead of an opaque teal cage that obliterates the
    // basemap. The fill stays present (not filtered out) so
    // click+hover still hit-test on globals — clicking anywhere
    // inside a global bbox surfaces its tooltip / preview.
    // Regional bboxes use the normal 0.22 fill so they read as
    // distinct rectangles against the basemap.
    map.addLayer({
      id: BBOX_FILL_LAYER_ID,
      type: 'fill',
      source: BBOX_SOURCE_ID,
      paint: {
        'fill-color': cssVar('--facet-color-category-content', '#5cc8c8'),
        'fill-opacity': ['case', ['==', ['get', 'global'], true], 0.015, 0.22],
      },
    })
    // Outline layer — sharper border on every bbox (regional AND
    // global) so the user always reads a frame around the covered
    // area, even when the fill is suppressed for globals. Lower
    // opacity for globals so a stack of 20+ world-rectangles
    // doesn't blur the basemap into a teal cage.
    map.addLayer({
      id: BBOX_OUTLINE_LAYER_ID,
      type: 'line',
      source: BBOX_SOURCE_ID,
      paint: {
        'line-color': cssVar('--facet-color-category-content', '#5cc8c8'),
        // Global outlines are noticeably thinner + dimmer than
        // regional ones — a stack of N coincident world-rectangle
        // outlines at full weight would still draw a thick teal
        // border around the whole canvas. The data-driven `case`
        // expression keys off the `global` feature property the
        // pure transform stamps on each overlay.
        'line-width': ['case', ['==', ['get', 'global'], true], 0.6, 1.5],
        'line-opacity': ['case', ['==', ['get', 'global'], true], 0.25, 0.85],
      },
    })
    // Real-time accent — green border on the subset of bboxes
    // tagged real-time, mirroring the Timeline trailing-edge dot
    // (which uses `--color-success` for the same reason).
    map.addLayer({
      id: BBOX_REALTIME_LAYER_ID,
      type: 'line',
      source: BBOX_SOURCE_ID,
      filter: ['==', ['get', 'isRealtime'], true],
      paint: {
        'line-color': cssVar('--color-success', '#6dc96d'),
        'line-width': 2.5,
        'line-opacity': 0.95,
      },
    })

    // Click handler — preview the dataset's card. If the click
    // hits multiple overlapping bboxes the tooltip below lists
    // them all; the click action picks the top-most (MapLibre
    // returns layer-ordered hits).
    map.on('click', BBOX_FILL_LAYER_ID, (e) => {
      if (drawMode) return // draw mode owns the click
      const features = e.features ?? []
      if (features.length === 0) return
      const datasetId = features[0].properties?.datasetId as string | undefined
      if (datasetId) callbacks.onPreviewDataset(datasetId)
    })
    map.on('mouseenter', BBOX_FILL_LAYER_ID, () => {
      if (!drawMode) map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', BBOX_FILL_LAYER_ID, () => {
      if (!drawMode) map.getCanvas().style.cursor = ''
      tooltip.classList.add('hidden')
    })
    map.on('mousemove', BBOX_FILL_LAYER_ID, (e) => {
      if (drawMode) return
      renderTooltipAt(e)
    })
  }

  /**
   * Show the hover tooltip listing every bbox under the cursor.
   * Overlapping bboxes — common in the SOS catalog where multiple
   * sea-surface or atmospheric datasets share regional bounds —
   * surface as a single tooltip with the top N titles + a "+M more"
   * suffix. Top-N by feature order (MapLibre returns layer-ordered
   * hits, which roughly corresponds to source insertion order).
   */
  function renderTooltipAt(e: MapMouseEvent & { features?: GeoJSON.Feature[] }): void {
    const features = e.features ?? []
    if (features.length === 0) {
      tooltip.classList.add('hidden')
      return
    }
    const top = features.slice(0, OVERLAP_TOOLTIP_TOP_N)
    const remaining = features.length - top.length
    const titles = top.map(f => {
      const p = f.properties ?? {}
      const rt = (p.isRealtime as boolean | undefined) ? ` <span class="browse-map-tooltip-realtime">${escapeHtml(t('browse.map.tooltip.realtime'))}</span>` : ''
      const title = String(p.title ?? '')
      const bounds = `${formatLat(p.n as number)}, ${formatLon(p.w as number)} → ${formatLat(p.s as number)}, ${formatLon(p.e as number)}`
      return `<div class="browse-map-tooltip-row"><span class="browse-map-tooltip-title">${escapeHtml(title)}</span>${rt}<span class="browse-map-tooltip-bounds">${escapeHtml(bounds)}</span></div>`
    })
    const moreLine = remaining > 0
      ? `<div class="browse-map-tooltip-more">${escapeHtml(t('browse.map.tooltip.more', { count: formatNumber(remaining) }))}</div>`
      : ''
    tooltip.innerHTML = titles.join('') + moreLine
    // Position the tooltip near the cursor without falling off the
    // canvas edge. `e.point` is the canvas-relative pixel offset.
    const offset = 12
    const left = Math.min(e.point.x + offset, canvas.clientWidth - 260)
    const top_ = Math.min(e.point.y + offset, canvas.clientHeight - 80)
    tooltip.style.insetInlineStart = `${Math.max(8, left)}px`
    tooltip.style.insetBlockStart = `${Math.max(8, top_)}px`
    tooltip.classList.remove('hidden')
  }

  function formatLat(v: number): string {
    if (!Number.isFinite(v)) return ''
    const abs = Math.abs(v)
    return `${abs.toFixed(1)}°${v >= 0 ? 'N' : 'S'}`
  }
  function formatLon(v: number): string {
    if (!Number.isFinite(v)) return ''
    const abs = Math.abs(v)
    return `${abs.toFixed(1)}°${v >= 0 ? 'E' : 'W'}`
  }

  // --- Draw-rectangle gesture ---

  function setDrawMode(enabled: boolean): void {
    if (drawMode === enabled) return
    drawMode = enabled
    drawToggleBtn.setAttribute('aria-pressed', String(enabled))
    drawToggleBtn.classList.toggle('active', enabled)
    canvas.classList.toggle('browse-map-canvas-draw', enabled)
    // While drawing, drag-pan would fight the rectangle gesture.
    // Disable both pan + zoom so a touch-drag is unambiguous.
    if (enabled) {
      map.dragPan.disable()
      map.scrollZoom.disable()
      map.touchZoomRotate.disable()
      map.getCanvas().style.cursor = 'crosshair'
    } else {
      map.dragPan.enable()
      map.scrollZoom.enable()
      map.touchZoomRotate.enable()
      map.getCanvas().style.cursor = ''
      // Tear down any in-flight draw state — the user toggled out
      // mid-drag. Same cleanup the mouseup path runs.
      cleanupDraw()
    }
  }

  function cleanupDraw(): void {
    if (drawBox && drawBox.parentNode) {
      drawBox.parentNode.removeChild(drawBox)
    }
    drawBox = null
    drawStart = null
    drawStartScreen = null
  }

  // Capture mouse events on the MapLibre canvas during draw mode.
  // We use the underlying canvas's events rather than maplibregl's
  // delegated handlers so we can read raw screen coordinates AND
  // project them via `map.unproject` for the geographic bounds.
  const mapCanvas = map.getCanvas()
  function onDrawMouseDown(e: MouseEvent): void {
    if (!drawMode) return
    if (e.button !== 0) return
    e.preventDefault()
    const rect = mapCanvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    drawStartScreen = { x, y }
    drawStart = map.unproject([x, y])
    drawBox = document.createElement('div')
    drawBox.className = 'browse-map-draw-box'
    drawBox.style.insetInlineStart = `${x}px`
    drawBox.style.insetBlockStart = `${y}px`
    drawBox.style.width = '0px'
    drawBox.style.height = '0px'
    canvas.appendChild(drawBox)
  }
  function onDrawMouseMove(e: MouseEvent): void {
    if (!drawMode || !drawStart || !drawBox || !drawStartScreen) return
    const rect = mapCanvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const left = Math.min(x, drawStartScreen.x)
    const top = Math.min(y, drawStartScreen.y)
    const width = Math.abs(x - drawStartScreen.x)
    const height = Math.abs(y - drawStartScreen.y)
    drawBox.style.insetInlineStart = `${left}px`
    drawBox.style.insetBlockStart = `${top}px`
    drawBox.style.width = `${width}px`
    drawBox.style.height = `${height}px`
  }
  function onDrawMouseUp(e: MouseEvent): void {
    if (!drawMode || !drawStart || !drawStartScreen) {
      cleanupDraw()
      return
    }
    const rect = mapCanvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    // A degenerate drag (< 4 px movement in any axis) clears the
    // region instead of committing — same single-click-clears
    // convention the Timeline brush uses.
    if (Math.abs(x - drawStartScreen.x) < 4 && Math.abs(y - drawStartScreen.y) < 4) {
      cleanupDraw()
      callbacks.onRegionChange(null)
      return
    }
    const end = map.unproject([x, y])
    cleanupDraw()
    const bounds = lngLatPairToBbox(drawStart, end)
    drawStart = null
    drawStartScreen = null
    emitRegionDrawn(bounds)
    callbacks.onRegionChange(bounds)
    // Exit draw mode after a successful commit so the user can
    // immediately resume panning. They can re-enter draw mode for
    // a follow-up gesture; treating draw as a sticky mode would
    // surprise users who expect a one-shot rectangle.
    setDrawMode(false)
  }
  mapCanvas.addEventListener('mousedown', onDrawMouseDown)
  // mousemove + mouseup land on the window so a drag that escapes
  // the canvas still completes (otherwise releasing outside the
  // canvas would leave the draw box orphaned).
  window.addEventListener('mousemove', onDrawMouseMove)
  window.addEventListener('mouseup', onDrawMouseUp)

  drawToggleBtn.addEventListener('click', () => {
    setDrawMode(!drawMode)
  })
  clearRegionBtn.addEventListener('click', () => {
    callbacks.onRegionChange(null)
  })
  includeGlobalInput.addEventListener('change', () => {
    includeGlobal = includeGlobalInput.checked
    if (lastInput) rebuild()
  })

  /**
   * Emit `catalog_map_region_drawn` if the throttle budget allows.
   * Tier B (gated at the emitter level). Bounds round to 3
   * decimals — same precision `camera.ts` uses for lat/lon — so
   * the analytics surface doesn't leak high-resolution drag
   * positions.
   */
  function emitRegionDrawn(bounds: { n: number; s: number; e: number; w: number }): void {
    const now = Date.now()
    const cutoff = now - DRAW_EMIT_WINDOW_MS
    while (drawEmits.length > 0 && drawEmits[0] < cutoff) drawEmits.shift()
    if (drawEmits.length >= DRAW_EMIT_MAX_PER_MINUTE) return
    drawEmits.push(now)
    emit({
      event_type: 'catalog_map_region_drawn',
      north: round(bounds.n, 3),
      south: round(bounds.s, 3),
      east: round(bounds.e, 3),
      west: round(bounds.w, 3),
    })
  }

  function rebuild(): void {
    if (!lastInput || !mapReady) return
    let result = buildMap(
      lastInput.datasets,
      lastInput.filterState,
      lastInput.searchQuery,
      { includeGlobal },
    )

    // Auto-flip Include global on first render if the catalog has
    // only global bboxes and the user is about to see an empty
    // canvas. `bboxes.length === 0 && hiddenGlobalCount > 0`
    // implies `regionalCount === 0` (any regional row would have
    // surfaced even with includeGlobal=false), which is the v1
    // catalog-shape we're working around. One-shot: a user who
    // deliberately toggles back to "off" stays off.
    if (
      !hasAutoFlippedGlobal
      && !includeGlobal
      && result.bboxes.length === 0
      && result.hiddenGlobalCount > 0
    ) {
      hasAutoFlippedGlobal = true
      includeGlobal = true
      includeGlobalInput.checked = true
      result = buildMap(
        lastInput.datasets,
        lastInput.filterState,
        lastInput.searchQuery,
        { includeGlobal },
      )
    }

    lastRendered = result

    // Refresh the canvas's aria-label with the live overlay count
    // so screen readers hear the result-set size on every rebuild.
    // Uses `bboxes.length` (the visible count on the canvas) rather
    // than `filteredDatasetCount` (which counts hidden globals +
    // undated rows the user can't actually see).
    canvas.setAttribute(
      'aria-label',
      t('browse.map.region.aria', { count: formatNumber(result.bboxes.length) }),
    )

    // --- Empty state handling ---
    if (result.bboxes.length === 0) {
      empty.classList.remove('hidden')
      canvas.classList.add('hidden')
      // The all-global banner is meaningless when nothing is
      // rendered; clear it so it doesn't linger from a previous
      // populated rebuild.
      banner.classList.add('hidden')
      banner.textContent = ''
      // The empty-state message differentiates the three reasons
      // the canvas can be empty: (a) user filters excluded
      // everything, (b) all matches lack geographic coverage,
      // (c) all matches are global and the user toggled them off.
      // Without this split the message would always read as if
      // the chip rail were the culprit (the original v1 wording).
      if (result.undatedCount > 0 && result.hiddenGlobalCount === 0) {
        empty.textContent = t('browse.map.empty.allUndated')
      } else if (result.hiddenGlobalCount > 0 && result.undatedCount === 0) {
        empty.textContent = t('browse.map.empty.allGlobalHidden')
      } else {
        empty.textContent = t('browse.map.empty')
      }
      updateFootnote(result)
      // The geographicRegion predicate may have caused the empty
      // state — keep the clear-region affordance visible so the
      // user has an escape hatch without leaving Map view.
      syncClearRegionButton(lastInput.filterState)
      // Source still gets cleared so a subsequent rebuild starts
      // from a clean slate.
      const source = map.getSource(BBOX_SOURCE_ID) as GeoJSONSource | undefined
      source?.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    const wasHidden = empty.classList.contains('hidden') === false
    empty.classList.add('hidden')
    canvas.classList.remove('hidden')
    // Canvas was `display: none` in the empty branch — MapLibre's
    // WebGL canvas dimensions are stale after a visibility flip
    // (the host's ResizeObserver doesn't fire for a child's
    // visibility change), so the next render would draw at the
    // pre-hide size. `map.resize()` re-syncs the canvas to its
    // container before the source.setData below triggers a frame.
    if (wasHidden) map.resize()

    const features = result.bboxes.map(bboxToPolygon)
    const source = map.getSource(BBOX_SOURCE_ID) as GeoJSONSource | undefined
    source?.setData({ type: 'FeatureCollection', features })

    // Banner: surface an explanation when every visible bbox is
    // global. Without context the user sees a (near-)uniform
    // teal wash across the canvas and assumes the Map view is
    // broken; the banner names the data shape so the user
    // understands they're looking at "20 worldwide datasets"
    // rather than a render bug.
    const globalCount = result.bboxes.filter(b => b.global).length
    const regionalCount = result.bboxes.length - globalCount
    if (globalCount > 0 && regionalCount === 0) {
      banner.classList.remove('hidden')
      banner.textContent = plural(
        globalCount,
        {
          one: 'browse.map.banner.allGlobal.one',
          other: 'browse.map.banner.allGlobal.other',
        },
        { count: formatNumber(globalCount) },
      )
    } else {
      banner.classList.add('hidden')
      banner.textContent = ''
    }

    updateFootnote(result)
    syncClearRegionButton(lastInput.filterState)
  }

  function syncClearRegionButton(filterState: FilterState): void {
    const predicate = filterState.geographicRegion
    if (predicate?.kind === 'bbox') {
      clearRegionBtn.classList.remove('hidden')
    } else {
      clearRegionBtn.classList.add('hidden')
    }
  }

  function updateFootnote(result: CatalogMap): void {
    const parts: string[] = []
    if (result.hiddenGlobalCount > 0 && !includeGlobal) {
      parts.push(plural(
        result.hiddenGlobalCount,
        {
          one: 'browse.map.hiddenGlobalFootnote.one',
          other: 'browse.map.hiddenGlobalFootnote.other',
        },
        { count: formatNumber(result.hiddenGlobalCount) },
      ))
    }
    if (result.undatedCount > 0) {
      parts.push(plural(
        result.undatedCount,
        {
          one: 'browse.map.undatedFootnote.one',
          other: 'browse.map.undatedFootnote.other',
        },
        { count: formatNumber(result.undatedCount) },
      ))
    }
    if (parts.length === 0) {
      footnote.classList.add('hidden')
      footnote.textContent = ''
      return
    }
    footnote.classList.remove('hidden')
    footnote.textContent = parts.join(' · ')
  }

  // --- ResizeObserver — keep the MapLibre canvas in sync with the
  //     host's layout. Same pattern catalogTimelineUI uses; MapLibre
  //     needs an explicit `resize()` call when its container shifts.
  let resizeObserver: ResizeObserver | null = null
  let resizeListener: (() => void) | null = null
  const onResize = (): void => {
    if (mapReady) map.resize()
  }
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(host)
  } else if (typeof window !== 'undefined') {
    resizeListener = onResize
    window.addEventListener('resize', resizeListener)
  }

  void lastRendered // silence unused-variable warnings while diagnostic surfaces aren't wired

  return {
    update(input: CatalogMapUpdate) {
      lastInput = input
      rebuild()
    },
    destroy() {
      resizeObserver?.disconnect()
      if (resizeListener && typeof window !== 'undefined') {
        window.removeEventListener('resize', resizeListener)
      }
      mapCanvas.removeEventListener('mousedown', onDrawMouseDown)
      window.removeEventListener('mousemove', onDrawMouseMove)
      window.removeEventListener('mouseup', onDrawMouseUp)
      cleanupDraw()
      renderer.dispose()
      host.innerHTML = ''
    },
  }
}

/**
 * Convert two corner LngLat values from a draw drag into the
 * canonical NSEW bbox shape the `geographicRegion` predicate
 * carries.
 *
 * Both axes are normalised so the resulting bbox never wraps:
 * `n ≥ s` and `w ≤ e` always hold, regardless of drag direction.
 * `map.unproject` returns longitudes in the canonical -180..180
 * range, so a Pacific-spanning drag whose visual path crosses the
 * dateline will still land in this function as two longitudes in
 * the same -180..180 range — which can only produce a
 * non-wrapping bbox.
 *
 * v1 limitation: drawing an antimeridian-crossing predicate
 * (`w > e`) from the canvas is not supported. The resolver in
 * `datasetFilter.ts` handles `w > e` correctly for dataset
 * bboxes that are already encoded that way in the catalog, but
 * the draw surface produces only normalised bboxes today. A
 * Pacific-region filter is reachable via the URL form
 * (`?gr=n,s,e,w` with `w > e`) or, future-work, via a dedicated
 * draw mode that interprets a drag that exits the right edge of
 * the canvas as antimeridian-crossing.
 */
function lngLatPairToBbox(a: LngLat, b: LngLat): { n: number; s: number; e: number; w: number } {
  return {
    n: Math.max(a.lat, b.lat),
    s: Math.min(a.lat, b.lat),
    w: Math.min(a.lng, b.lng),
    e: Math.max(a.lng, b.lng),
  }
}

/** Resolve a CSS custom property against `:root` so MapLibre's
 *  paint properties (which can't read CSS variables at draw time)
 *  pick up the design system's source of truth. Mirrors the helper
 *  in `catalogGraphUI.ts`. */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = window.getComputedStyle(document.documentElement)
    .getPropertyValue(name).trim()
  return value || fallback
}
