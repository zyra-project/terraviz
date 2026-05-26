/**
 * Catalog Timeline view — UI mount + SVG wiring.
 *
 * Phase 4 §6.8 of `docs/WEB_CATALOG_FEATURES_PLAN.md`. The pure
 * data transform lives in `src/services/catalogTimeline.ts`; this
 * module owns the SVG canvas, the d3 axis + brush, the row
 * rendering, and the in-chart legend.
 *
 * Lazy-loaded — `browseUI.ts` imports `createCatalogTimeline` only
 * when the user first toggles into Timeline view, so the default
 * Cards path pays nothing for the d3 chunk. Mirrors the cytoscape
 * pattern in `catalogGraphUI.ts`.
 *
 * Library choice: `d3-scale` + `d3-axis` + `d3-brush` +
 * `d3-selection` — ~30 KB gzipped vs. ~150 KB for vis-timeline.
 * Documented in `package.json`'s commit and in the §6.8 plan.
 * The chip-rail's dual-thumb year-range slider (a §6.1 follow-up)
 * will consume the same `d3-brush` import, so the dep earns its
 * keep across multiple surfaces.
 *
 * Layout:
 *
 *   .browse-timeline-host (flex column)
 *     .browse-timeline-toolbar      (legend + brush summary)
 *     .browse-timeline-chart        (flex 1, overflow-y auto)
 *       .browse-timeline-axis       (sticky top, axis + brush)
 *       .browse-timeline-rows-wrap  (rows SVG, scrolls within chart)
 *     .browse-timeline-footnote     (conditional undated callout)
 *     .browse-timeline-empty        (no-rows fallback)
 *
 * The axis reads left → right even in RTL locales (calendar time
 * is left-to-right by convention; flipping it would surprise the
 * reader). Documented inline in the CSS file.
 */

import { axisBottom } from 'd3-axis'
import { brushX, type D3BrushEvent } from 'd3-brush'
import { scaleLinear } from 'd3-scale'
import { select, type Selection } from 'd3-selection'

import {
  buildTimeline,
  type Timeline,
  type TimelineRow,
} from '../services/catalogTimeline'
import { type FilterState } from '../services/datasetFilter'
import type { Dataset } from '../types'
import { emit } from '../analytics'
import { escapeHtml, escapeAttr } from './domUtils'
import { plural, t } from '../i18n'
import { formatNumber } from '../i18n/format'

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Left gutter for dataset titles. Wide enough for ~28 chars at the
 *  body font size; longer titles truncate with an SVG <title>
 *  hover-tooltip for the full label. */
const GUTTER_PX = 200
/** Top axis band (axis ticks + labels). */
const AXIS_HEIGHT_PX = 40
/** Top brush band — sits above the axis ticks, drives the
 *  `dataCoverageYear` range filter. */
const BRUSH_HEIGHT_PX = 24
/** Padding inside the axis SVG around its content. Adds breathing
 *  room so first/last tick labels don't clip at the chart edge. */
const AXIS_HPADDING_PX = 12

/** Row height tiers from the plan §6.8 — adapt to the result set
 *  so 30 rows read comfortably AND 520 rows fit on one screen
 *  scroll. */
const ROW_HEIGHT_COMFORTABLE = 24
const ROW_HEIGHT_MEDIUM = 16
const ROW_HEIGHT_DENSE = 12
/** Below this row count, render at the comfortable height. */
const ROW_COUNT_COMFORTABLE = 100
/** Between this and `ROW_COUNT_COMFORTABLE`, render at the medium
 *  height; above, switch to dense. */
const ROW_COUNT_MEDIUM = 500

/** Minimum pixel width for a single-point / instantaneous row so
 *  the bar is still visible at any zoom level. */
const MIN_BAR_WIDTH_PX = 3
/** Radius of the real-time trailing-edge marker dot, in pixels. */
const REALTIME_MARKER_RADIUS_PX = 4

/** Per-minute throttle budget for `catalog_timeline_brush_applied`.
 *  Matches `camera_settled` and `catalog_graph_node_clicked` so an
 *  aggressive scrubbing session can't flood the queue from this
 *  surface either. */
const BRUSH_EMIT_MAX_PER_MINUTE = 30
const BRUSH_EMIT_WINDOW_MS = 60_000

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface CatalogTimelineCallbacks {
  /**
   * Brush gesture committed a new time range. `range` is `null`
   * when the user cleared the brush (the parent removes the
   * `dataCoverageYear` predicate); otherwise it's `{min, max}`
   * in years.
   *
   * Goes through the same `setFacet('dataCoverageYear', ...)`
   * mutation path the chip rail's range inputs use, so brush +
   * chip stay agreement-by-construction.
   */
  onBrushChange: (range: { min: number; max: number } | null) => void
  /**
   * Click on a row — surface the dataset's card with metadata
   * expanded. Same shape as Graph view's dataset-node click
   * (PR #137) so the two views read as one interaction system.
   */
  onPreviewDataset: (datasetId: string) => void
}

export interface CatalogTimelineUpdate {
  datasets: readonly Dataset[]
  filterState: FilterState
  /** Free-text portion of the search query (prefix tokens are
   *  already merged into filterState by the caller). */
  searchQuery: string
}

export interface CatalogTimelineController {
  /** Re-render with the current dataset / filter state. */
  update: (input: CatalogTimelineUpdate) => void
  /** Tear down DOM + d3 listeners. Currently not invoked by
   *  `browseUI.ts` (it leaves the canvas mounted across toggles)
   *  but exported for parity with `catalogGraphUI.ts`. */
  destroy: () => void
}

// ---------------------------------------------------------------------------
// Module entry
// ---------------------------------------------------------------------------

/**
 * Build the in-DOM chrome and a fresh d3 binding. Caller passes
 * the host container — typically `<div id="browse-timeline">`
 * from `index.html`. Returns a controller exposing `update` and
 * `destroy`.
 *
 * The host element's children are replaced; callers should pass
 * an empty container (or accept that previous contents are
 * cleared).
 */
export function createCatalogTimeline(
  host: HTMLElement,
  callbacks: CatalogTimelineCallbacks,
): CatalogTimelineController {
  host.innerHTML = ''
  host.classList.add('browse-timeline-host')

  // --- Toolbar: legend + clear-brush button ---
  // Legend swatches resolve their hue via CSS custom properties on
  // the `.browse-timeline-legend-dot-*` rules — same approach as
  // the Graph view legend.
  const toolbar = document.createElement('div')
  toolbar.className = 'browse-timeline-toolbar'
  toolbar.innerHTML = `
    <div class="browse-timeline-legend" aria-hidden="true">
      <span class="browse-timeline-legend-dot browse-timeline-legend-dot-coverage"></span>${escapeHtml(t('browse.timeline.legend.coverage'))}
      <span class="browse-timeline-legend-dot browse-timeline-legend-dot-realtime"></span>${escapeHtml(t('browse.timeline.legend.realtime'))}
    </div>
    <div class="browse-timeline-brush-summary" aria-live="polite"></div>
    <button type="button"
            class="browse-timeline-brush-clear hidden"
            aria-label="${escapeAttr(t('browse.timeline.brush.clear.aria'))}">
      ${escapeHtml(t('browse.timeline.brush.clear'))}
    </button>
  `

  const chart = document.createElement('div')
  chart.className = 'browse-timeline-chart'

  // Axis container (sticky top within the chart's scrollable area).
  const axisWrap = document.createElement('div')
  axisWrap.className = 'browse-timeline-axis'
  axisWrap.setAttribute('role', 'group')
  axisWrap.setAttribute('aria-label', t('browse.timeline.brush.aria'))

  // Pure layout wrapper — the `role="list"` lives on the inner
  // rows SVG (where the `<g>` listitem children actually attach).
  // Stacking another list role here would nest list semantics and
  // confuse assistive tech.
  const rowsWrap = document.createElement('div')
  rowsWrap.className = 'browse-timeline-rows-wrap'

  const empty = document.createElement('div')
  empty.className = 'browse-timeline-empty hidden'
  empty.setAttribute('role', 'status')
  empty.textContent = t('browse.timeline.empty')

  const footnote = document.createElement('div')
  footnote.className = 'browse-timeline-footnote hidden'
  footnote.setAttribute('role', 'note')

  chart.appendChild(axisWrap)
  chart.appendChild(rowsWrap)

  host.appendChild(toolbar)
  host.appendChild(chart)
  host.appendChild(empty)
  host.appendChild(footnote)

  // --- d3 selections ---

  const axisSvg = select(axisWrap)
    .append('svg')
    .attr('class', 'browse-timeline-axis-svg')
    .attr('role', 'img')
    .attr('aria-hidden', 'true')
  const brushGroup = axisSvg.append('g').attr('class', 'browse-timeline-brush')
  // Discoverability hint — a low-opacity "↔ Drag to filter by year"
  // label sitting inside the brush band. Without this the brush
  // area reads as empty chart space; PR #138 review feedback was
  // that users didn't realise it was interactive. The label
  // disappears once a selection exists (the selection rect IS the
  // affordance from then on); CSS handles the toggle via the
  // `browse-timeline-has-brush` class set in `syncBrushFromFilterState`.
  const brushHint = axisSvg
    .append('text')
    .attr('class', 'browse-timeline-brush-hint')
    .attr('text-anchor', 'middle')
    .attr('dy', '0.35em')
    .attr('aria-hidden', 'true')
    .text(t('browse.timeline.brush.hint'))
  const axisGroup = axisSvg.append('g').attr('class', 'browse-timeline-axis-ticks')
  const nowMarker = axisSvg
    .append('line')
    .attr('class', 'browse-timeline-now-marker')
    .attr('y1', BRUSH_HEIGHT_PX)
    .attr('y2', AXIS_HEIGHT_PX + BRUSH_HEIGHT_PX)
    .attr('aria-hidden', 'true')

  const rowsSvg = select(rowsWrap)
    .append('svg')
    .attr('class', 'browse-timeline-rows-svg')
    .attr('role', 'list')
    .attr('aria-label', t('browse.timeline.region.aria', { count: 0 }))

  // Brush summary + clear button.
  const brushSummary = toolbar.querySelector('.browse-timeline-brush-summary') as HTMLElement
  const brushClearBtn = toolbar.querySelector('.browse-timeline-brush-clear') as HTMLButtonElement

  // --- State carried across update() calls ---
  let lastInput: CatalogTimelineUpdate | null = null
  // Rolling timestamps for the per-minute brush-emit throttle. Same
  // shape as `camera.ts` and the graph view's node-click budget.
  const brushEmits: number[] = []
  // Width of the axis SVG (excluding the gutter). Re-measured on
  // every update because the host can resize when the panel is
  // expanded / the viewport changes.
  let chartWidth = 0
  // Flag the next brush event as programmatic so the controller
  // doesn't loop the user-input → filterState → update → brush.move
  // cascade into a callback emit. d3-brush's `event.sourceEvent` is
  // null when `brush.move` is called programmatically, but we also
  // keep this flag for double safety against synthesized events.
  let programmaticBrush = false

  const xScale = scaleLinear()
  // Build the brush once; its extent is updated on every render.
  const brush = brushX<unknown>()
    .on('end', (event: D3BrushEvent<unknown>) => {
      // Only react to user-driven gestures — programmatic moves and
      // in-flight drags are ignored. The `'end'` filter alone would
      // cover the drag-in-progress case; the sourceEvent check guards
      // against the brush.move() we run to sync from filterState.
      if (programmaticBrush) return
      if (event.sourceEvent == null) return
      if (!event.selection) {
        callbacks.onBrushChange(null)
        return
      }
      const [x0, x1] = event.selection as [number, number]
      // A truly-degenerate pixel selection (user clicked the axis
      // without dragging) emits `end` with `x0 ≈ x1`; treat that as
      // a clear so the user isn't trapped with a filter they didn't
      // mean to set. The threshold has to be smaller than one
      // year's worth of pixels at typical chart widths so a
      // deliberate single-year brush still survives — a few-pixel
      // floor is enough.
      if (Math.abs(x1 - x0) < 2) {
        callbacks.onBrushChange(null)
        return
      }
      // The `dataCoverageYear` predicate is INCLUSIVE on both ends
      // (see the `range` overlap test in datasetFilter.ts), so a
      // drag from xScale(2020) to xScale(2021) — visually covering
      // year 2020 — must produce `{min: 2020, max: 2020}`, not
      // `{min: 2020, max: 2021}` (which would widen to 2020+2021).
      // Floor the left edge; ceil-then-subtract-1 the right edge.
      // A degenerate drag inside a single year (x0, x1 both inside
      // 2020) still survives — floor=2020, ceil-1=2020.
      const minYear = Math.floor(xScale.invert(x0))
      const maxYear = Math.ceil(xScale.invert(x1)) - 1
      if (maxYear < minYear) {
        callbacks.onBrushChange(null)
        return
      }
      emitBrushApplied(minYear, maxYear)
      callbacks.onBrushChange({ min: minYear, max: maxYear })
    })

  /**
   * Emit `catalog_timeline_brush_applied` if the per-minute throttle
   * allows. Tier B (gated at the emitter level). Carries integer
   * years only — the brush has no free-text payload. Throttling
   * mirrors `camera.ts` so a rapid back-and-forth scrub
   * sequence can't burn the session's analytics budget.
   */
  function emitBrushApplied(startYear: number, endYear: number): void {
    const now = Date.now()
    const cutoff = now - BRUSH_EMIT_WINDOW_MS
    while (brushEmits.length > 0 && brushEmits[0] < cutoff) brushEmits.shift()
    if (brushEmits.length >= BRUSH_EMIT_MAX_PER_MINUTE) return
    brushEmits.push(now)
    emit({
      event_type: 'catalog_timeline_brush_applied',
      start_year: startYear,
      end_year: endYear,
    })
  }

  function rowHeightFor(rowCount: number): number {
    if (rowCount <= ROW_COUNT_COMFORTABLE) return ROW_HEIGHT_COMFORTABLE
    if (rowCount <= ROW_COUNT_MEDIUM) return ROW_HEIGHT_MEDIUM
    return ROW_HEIGHT_DENSE
  }

  function measureChartWidth(): number {
    // The chart's available width minus the gutter and the two
    // padding bands. `clientWidth` reads layout — only called
    // inside the `update()` flow which is already pulled off the
    // hot path by the chip-rail re-render coalescing.
    const total = chart.clientWidth
    if (total <= 0) {
      // Initial mount: the chart hasn't laid out yet. Fall back to
      // a reasonable default so the first render isn't pixel-zero.
      return 600
    }
    return Math.max(100, total - GUTTER_PX - AXIS_HPADDING_PX * 2)
  }

  function rebuild(): void {
    if (!lastInput) return
    const timeline = buildTimeline(
      lastInput.datasets,
      lastInput.filterState,
      lastInput.searchQuery,
    )

    // --- Empty state handling ---
    if (timeline.rows.length === 0) {
      empty.classList.remove('hidden')
      chart.classList.add('hidden')
      // Even when the canvas is empty, show the undated footnote
      // (if any) so the user understands why nothing is rendering.
      updateFootnote(timeline)
      // Keep the brush summary + clear-range affordance visible
      // when an active range predicate caused the empty state. A
      // user who brushed too narrowly (e.g. 1970–1980 against a
      // catalog whose visible rows all post-date 2000) needs the
      // most direct escape hatch — without the clear button they'd
      // have to navigate to Cards view to drop the filter. The
      // brush canvas itself stays hidden; just the toolbar
      // affordance persists.
      const rangePredicate = lastInput.filterState.dataCoverageYear
      if (rangePredicate?.kind === 'range' && (rangePredicate.min != null || rangePredicate.max != null)) {
        const min = rangePredicate.min ?? rangePredicate.max!
        const max = rangePredicate.max ?? rangePredicate.min!
        brushSummary.textContent = t('browse.timeline.brush.summary', {
          start: formatNumber(Math.min(min, max)),
          end: formatNumber(Math.max(min, max)),
        })
        brushClearBtn.classList.remove('hidden')
      } else {
        brushSummary.textContent = ''
        brushClearBtn.classList.add('hidden')
      }
      return
    }
    empty.classList.add('hidden')
    chart.classList.remove('hidden')

    // --- x-scale + axis ---
    chartWidth = measureChartWidth()
    const domain = timeline.domain!
    xScale.domain([domain.min, domain.max]).range([0, chartWidth])

    const axisWidthTotal = chartWidth + AXIS_HPADDING_PX * 2
    const axisSvgWidth = GUTTER_PX + axisWidthTotal
    axisSvg
      .attr('width', axisSvgWidth)
      .attr('height', AXIS_HEIGHT_PX + BRUSH_HEIGHT_PX)
    // Position the inner axis group AFTER the gutter so labels in
    // the rows align with the axis ticks above them.
    axisGroup.attr(
      'transform',
      `translate(${GUTTER_PX + AXIS_HPADDING_PX}, ${BRUSH_HEIGHT_PX})`,
    )
    brushGroup.attr(
      'transform',
      `translate(${GUTTER_PX + AXIS_HPADDING_PX}, 0)`,
    )
    // Centre the discoverability hint inside the brush band.
    brushHint
      .attr('x', GUTTER_PX + AXIS_HPADDING_PX + chartWidth / 2)
      .attr('y', BRUSH_HEIGHT_PX / 2)

    // Generate explicit integer-year tick values so a sub-year
    // domain (or a fractional d3 tick generation) doesn't render
    // duplicate "2024 | 2024" labels rounded from 2023.8 + 2024.2.
    // Aim for ~one tick per 80 px; step up to whole-year multiples
    // when the domain is too wide to fit all years.
    const tickCount = Math.max(2, Math.floor(chartWidth / 80))
    const tickMin = Math.ceil(domain.min)
    const tickMax = Math.floor(domain.max)
    const yearSpan = Math.max(1, tickMax - tickMin)
    const tickStep = Math.max(1, Math.ceil(yearSpan / tickCount))
    const tickValues: number[] = []
    for (let y = tickMin; y <= tickMax; y += tickStep) tickValues.push(y)
    const axisRender = axisBottom(xScale)
      .tickValues(tickValues)
      .tickFormat((d) => formatNumber(d as number))
    axisGroup.call(axisRender as never)

    // Brush extent — the brush is drawn over the axis band only,
    // not over the rows area below. Axis-only brushing keeps row
    // clicks unambiguous (clicking on a bar is a row preview, not
    // a brush gesture).
    brush.extent([
      [0, 0],
      [chartWidth, BRUSH_HEIGHT_PX],
    ])
    brushGroup.call(brush as never)

    // Sync brush selection from filterState.dataCoverageYear if
    // present. The flag suppresses the resulting `'end'` callback —
    // see the `programmaticBrush` declaration.
    syncBrushFromFilterState(lastInput.filterState, domain)

    // Now-marker: vertical line at "now" so the user can read
    // where real-time data terminates. Skipped if `now` falls
    // outside the visible domain.
    const nowYear = new Date().getUTCFullYear() + (new Date().getUTCMonth() / 12)
    if (nowYear >= domain.min && nowYear <= domain.max) {
      const nowX = GUTTER_PX + AXIS_HPADDING_PX + xScale(nowYear)
      nowMarker
        .attr('x1', nowX)
        .attr('x2', nowX)
        .style('display', '')
    } else {
      nowMarker.style('display', 'none')
    }

    // --- Rows SVG ---
    const rowHeight = rowHeightFor(timeline.rows.length)
    const rowsHeight = timeline.rows.length * rowHeight
    rowsSvg
      .attr('width', axisSvgWidth)
      .attr('height', rowsHeight)
      .attr(
        'aria-label',
        t('browse.timeline.region.aria', {
          count: formatNumber(timeline.rows.length),
        }),
      )

    renderRows(timeline.rows, rowHeight)
    updateFootnote(timeline)
  }

  /**
   * Render dataset rows into the rows SVG. Uses d3-style join
   * with manual key matching on `datasetId` so existing row DOM
   * survives filter changes (cheaper than re-emit + re-mount).
   */
  function renderRows(rows: readonly TimelineRow[], rowHeight: number): void {
    type RowSelection = Selection<SVGGElement, TimelineRow, SVGSVGElement, unknown>
    const rowGroups = rowsSvg
      .selectAll<SVGGElement, TimelineRow>('g.browse-timeline-row')
      .data(rows, (d) => d.datasetId)

    rowGroups.exit().remove()

    const enter = rowGroups
      .enter()
      .append('g')
      .attr('class', 'browse-timeline-row')
      .attr('role', 'listitem')
      .attr('tabindex', 0)
      .on('click', (_event, d) => {
        callbacks.onPreviewDataset(d.datasetId)
      })
      .on('keydown', (event, d) => {
        const ke = event as KeyboardEvent
        if (ke.key === 'Enter' || ke.key === ' ') {
          ke.preventDefault()
          callbacks.onPreviewDataset(d.datasetId)
        }
      })

    // Label (in the left gutter). SVG <text> doesn't truncate
    // natively; we set the text content to a char-truncated
    // string and add a <title> for full-text hover.
    enter
      .append('text')
      .attr('class', 'browse-timeline-row-label')
      .attr('x', GUTTER_PX - 8)
      .attr('text-anchor', 'end')
      .attr('dy', '0.35em')
    enter.append('title')
    enter.append('rect').attr('class', 'browse-timeline-bar')
    enter.append('circle').attr('class', 'browse-timeline-realtime-marker')

    const merged = enter.merge(rowGroups as RowSelection)

    merged.attr('transform', (_d, i) => `translate(0, ${i * rowHeight})`)
    merged.attr('aria-label', (d) =>
      // Floor both ends — inclusive-year semantics, the same the
      // predicate engine uses for `dataCoverageYear`. A row whose
      // data runs 2020.1 → 2024.8 reads as "coverage 2020 to 2024"
      // (truthful — the data exists in 2020 and in 2024, just not
      // throughout either). Rounding 2024.8 → 2025 would announce
      // a year of coverage that doesn't exist.
      t('browse.timeline.row.aria', {
        title: d.title,
        start: formatNumber(Math.floor(d.start)),
        end: formatNumber(Math.floor(d.end)),
      }),
    )

    // Truncate label to fit the gutter — naive char-count truncation
    // works well for body-text glyphs at our font size. Hover
    // tooltip reveals the full title.
    const maxLabelChars = Math.max(8, Math.floor((GUTTER_PX - 16) / 7))
    merged
      .select<SVGTextElement>('text.browse-timeline-row-label')
      .attr('y', rowHeight / 2)
      .text((d) =>
        d.title.length > maxLabelChars
          ? d.title.slice(0, maxLabelChars - 1) + '…'
          : d.title,
      )
    merged.select<SVGTitleElement>('title').text((d) => d.title)

    // Bar: x = scale(start) + gutter + axisPad ; width = max(
    // MIN_BAR_WIDTH_PX, scale(end) - scale(start)). Each row carries
    // its facet-group class so the CSS rule applies the right hue
    // via `--facet-color-*`.
    merged
      .select<SVGRectElement>('rect.browse-timeline-bar')
      .attr('x', (d) => GUTTER_PX + AXIS_HPADDING_PX + xScale(d.start))
      .attr('y', 2)
      .attr('height', Math.max(2, rowHeight - 4))
      .attr('width', (d) => {
        const span = xScale(d.end) - xScale(d.start)
        return Math.max(MIN_BAR_WIDTH_PX, span)
      })
      .attr('data-group', (d) => d.group)

    // Real-time marker at the trailing edge — green dot anchored
    // to the bar's right end. Hidden via `display:none` for non-
    // real-time rows so the empty `<circle>` doesn't render.
    merged
      .select<SVGCircleElement>('circle.browse-timeline-realtime-marker')
      .attr('cx', (d) => GUTTER_PX + AXIS_HPADDING_PX + xScale(d.end))
      .attr('cy', rowHeight / 2)
      .attr('r', REALTIME_MARKER_RADIUS_PX)
      .style('display', (d) => (d.isRealtime ? '' : 'none'))
  }

  function syncBrushFromFilterState(
    filterState: FilterState,
    domain: { min: number; max: number },
  ): void {
    const predicate = filterState.dataCoverageYear
    if (predicate?.kind === 'range' && (predicate.min != null || predicate.max != null)) {
      const rawMin = predicate.min ?? domain.min
      const rawMax = predicate.max ?? domain.max
      // Normalise inverted ranges (`min > max`, possible via a
      // hand-edited URL or a malformed external write) so a swap
      // doesn't reach `brush.move` with `x0 > x1` and confuse the
      // d3 renderer. The resolver itself tolerates either order
      // (it overlap-tests against the dataset interval), so a
      // visible swap here matches the engine's lenient stance.
      const min = Math.min(rawMin, rawMax)
      const max = Math.max(rawMin, rawMax)
      // Clamp to the visible domain so a brush rendered with stale
      // bounds doesn't extend off the canvas.
      const clampedMin = Math.max(domain.min, min)
      const clampedMax = Math.min(domain.max, max)
      const x0 = xScale(clampedMin)
      const x1 = xScale(clampedMax)
      programmaticBrush = true
      brushGroup.call(brush.move as never, [x0, x1])
      programmaticBrush = false
      // Announce the clamped years (what the brush actually shows)
      // rather than the raw predicate values — if the user has a
      // predicate of 1850–2100 against a visible domain of
      // 1900–2050, the brush draws 1900–2050 and the summary should
      // say the same to avoid the visual vs. text disagreement.
      // Floor both ends — inclusive-year semantics. The clamped
      // values may be fractional after `Math.max(domain.min, ...)`
      // pulls them onto a fractional domain edge; rounding would
      // announce a year that the data doesn't actually start in.
      brushSummary.textContent = t('browse.timeline.brush.summary', {
        start: formatNumber(Math.floor(clampedMin)),
        end: formatNumber(Math.floor(clampedMax)),
      })
      brushClearBtn.classList.remove('hidden')
      // Hide the "↔ Drag to filter by year" hint — the selection
      // rect itself is now the affordance and the hint would just
      // crowd it.
      axisSvg.classed('browse-timeline-has-brush', true)
    } else {
      programmaticBrush = true
      brushGroup.call(brush.move as never, null)
      programmaticBrush = false
      brushSummary.textContent = ''
      brushClearBtn.classList.add('hidden')
      axisSvg.classed('browse-timeline-has-brush', false)
    }
  }

  function updateFootnote(timeline: Timeline): void {
    if (timeline.undatedCount === 0) {
      footnote.classList.add('hidden')
      footnote.textContent = ''
      return
    }
    footnote.classList.remove('hidden')
    footnote.textContent = plural(
      timeline.undatedCount,
      {
        one: 'browse.timeline.undatedFootnote.one',
        other: 'browse.timeline.undatedFootnote.other',
      },
      { count: formatNumber(timeline.undatedCount) },
    )
  }

  // --- Toolbar wiring ---
  brushClearBtn.addEventListener('click', () => {
    callbacks.onBrushChange(null)
  })

  // --- Window resize handling ---
  // The d3 scale's range maps domain → pixel space; if the host
  // resizes (e.g. user expanded the browse overlay) the scale
  // needs to follow. ResizeObserver fires asynchronously so this
  // doesn't fight an in-progress layout pass.
  //
  // Feature-detect — the same guard pattern `chatUI.ts` and
  // `playbackController.ts` use. Tauri's older iOS webviews and a
  // handful of headless environments (some test harnesses) lack
  // ResizeObserver entirely; we fall back to a window-level
  // `resize` listener so the timeline still reflows on viewport
  // change, just at a coarser granularity (no host-only resizes
  // detected without an observer).
  let resizeObserver: ResizeObserver | null = null
  let resizeListener: (() => void) | null = null
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (lastInput) rebuild()
    })
    resizeObserver.observe(host)
  } else if (typeof window !== 'undefined') {
    resizeListener = () => { if (lastInput) rebuild() }
    window.addEventListener('resize', resizeListener)
  }

  return {
    update(input: CatalogTimelineUpdate) {
      lastInput = input
      rebuild()
    },
    destroy() {
      resizeObserver?.disconnect()
      if (resizeListener && typeof window !== 'undefined') {
        window.removeEventListener('resize', resizeListener)
      }
      host.innerHTML = ''
    },
  }
}
