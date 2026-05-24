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

  const rowsWrap = document.createElement('div')
  rowsWrap.className = 'browse-timeline-rows-wrap'
  rowsWrap.setAttribute('role', 'list')

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
      const minYear = Math.round(xScale.invert(x0))
      const maxYear = Math.round(xScale.invert(x1))
      // Guard against a zero-width brush (e.g. user clicks but
      // doesn't drag) — d3 emits `end` with a tiny selection. Treat
      // a degenerate brush as a clear so the user isn't trapped
      // with a one-year-wide filter they didn't mean to set.
      if (maxYear <= minYear) {
        callbacks.onBrushChange(null)
        return
      }
      callbacks.onBrushChange({ min: minYear, max: maxYear })
    })

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
      brushClearBtn.classList.add('hidden')
      brushSummary.textContent = ''
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

    // Choose tick count based on chart width — d3-axis honours
    // `ticks(n)` as a hint, not a hard count. Roughly one tick
    // per 80 px keeps labels from colliding at most viewport
    // widths; we also format ticks as integer years.
    const tickCount = Math.max(2, Math.floor(chartWidth / 80))
    const axisRender = axisBottom(xScale)
      .ticks(tickCount)
      .tickFormat((d) => formatNumber(Math.round(d as number)))
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
      t('browse.timeline.row.aria', {
        title: d.title,
        start: formatNumber(Math.round(d.start)),
        end: formatNumber(Math.round(d.end)),
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
      const min = predicate.min ?? domain.min
      const max = predicate.max ?? domain.max
      // Clamp to the visible domain so a brush rendered with stale
      // bounds doesn't extend off the canvas.
      const x0 = xScale(Math.max(domain.min, min))
      const x1 = xScale(Math.min(domain.max, max))
      programmaticBrush = true
      brushGroup.call(brush.move as never, [x0, x1])
      programmaticBrush = false
      brushSummary.textContent = t('browse.timeline.brush.summary', {
        start: formatNumber(Math.round(min)),
        end: formatNumber(Math.round(max)),
      })
      brushClearBtn.classList.remove('hidden')
    } else {
      programmaticBrush = true
      brushGroup.call(brush.move as never, null)
      programmaticBrush = false
      brushSummary.textContent = ''
      brushClearBtn.classList.add('hidden')
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
  const resizeObserver = new ResizeObserver(() => {
    if (lastInput) rebuild()
  })
  resizeObserver.observe(host)

  return {
    update(input: CatalogTimelineUpdate) {
      lastInput = input
      rebuild()
    },
    destroy() {
      resizeObserver.disconnect()
      host.innerHTML = ''
    },
  }
}
