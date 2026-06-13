/**
 * Hand-rolled SVG chart helpers for the `/publish/analytics` tab
 * (Phase B of `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`).
 *
 * Same no-framework stance as the catalog Timeline view
 * (`src/ui/catalogTimelineUI.ts`): a handful of pure
 * element-builder functions, no charting library. Everything is
 * built with `createElement(NS)` + `textContent` — no innerHTML —
 * so data values can never carry markup into the page.
 *
 * Values rendered here are sample-weighted estimates (see the
 * rollup semantics in `analytics-export.ts`); the page carries the
 * "estimated" framing, these helpers just draw.
 */

import { formatNumber } from '../../i18n/format'

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

export interface BarPoint {
  /** Axis label (a day, a name). Shown in the hover tooltip. */
  label: string
  value: number
}

/** Plot-area width in viewBox units; the bars span this. */
const PLOT_WIDTH = 480
/** Left gutter reserved for the Y-axis value labels. */
const Y_AXIS_GUTTER = 40

/** Compact axis-tick value ("1.2K", "340", "0") in the active
 * locale — keeps the gutter narrow for large counts. */
function formatTick(value: number): string {
  return formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 })
}

/**
 * Vertical bar series — the workhorse for per-day time series.
 * Scales to the series max; each bar carries a `<title>` tooltip
 * with "label — value". A Y axis (0 / mid / max gridlines with
 * value labels in the left gutter) makes the magnitude legible
 * without hovering. Renders an empty-but-valid SVG for an empty
 * series (the page shows its own empty-state copy).
 */
export function renderBarSeries(
  points: BarPoint[],
  options: {
    height?: number
    ariaLabel: string
    /** Pre-formatted axis labels rendered under the bars' start and
     * end (the page formats the range days with the active locale).
     * The axis runs oldest→newest left-to-right regardless of text
     * direction — same deliberate exception as the catalog
     * Timeline's time axis. */
    range?: { start: string; end: string }
  } = { ariaLabel: '' },
): SVGSVGElement {
  const height = options.height ?? 96
  const axisHeight = options.range && points.length > 0 ? 16 : 0
  const totalWidth = Y_AXIS_GUTTER + PLOT_WIDTH
  const svg = svgEl('svg', {
    viewBox: `0 0 ${totalWidth} ${height + axisHeight}`,
    role: 'img',
    class: 'publisher-analytics-bars',
  })
  svg.setAttribute('aria-label', options.ariaLabel)
  if (points.length === 0) return svg

  const max = Math.max(...points.map(p => p.value), 1)
  // value → plot y. The bar of height `value/max·(height-4)` sits at
  // `height - h`, so value=max lands at y=4 and value=0 at y=height.
  const yFor = (value: number): number => height - (value / max) * (height - 4)

  // Y-axis gridlines + value labels at 0, mid, max. Drawn first so
  // the bars paint over them.
  for (const frac of [0, 0.5, 1]) {
    const value = max * frac
    const y = yFor(value)
    const line = svgEl('line', {
      x1: Y_AXIS_GUTTER,
      y1: y,
      x2: totalWidth,
      y2: y,
      class: 'publisher-analytics-gridline',
    })
    const label = svgEl('text', {
      x: Y_AXIS_GUTTER - 5,
      // Nudge the baseline so the text visually centers on the line,
      // clamped to stay inside the viewBox at the top and bottom.
      y: Math.min(height - 1, Math.max(8, y + 3)),
      'text-anchor': 'end',
      class: 'publisher-analytics-ytick',
    })
    label.textContent = formatTick(value)
    svg.append(line, label)
  }

  const step = PLOT_WIDTH / points.length
  const barWidth = Math.max(1, Math.min(step - 2, 28))
  points.forEach((p, i) => {
    const h = Math.max(p.value > 0 ? 2 : 0, (p.value / max) * (height - 4))
    const rect = svgEl('rect', {
      x: Y_AXIS_GUTTER + i * step + (step - barWidth) / 2,
      y: height - h,
      width: barWidth,
      height: h,
      rx: 1.5,
      class: 'publisher-analytics-bar',
    })
    const title = svgEl('title')
    title.textContent = `${p.label} — ${formatNumber(Math.round(p.value))}`
    rect.appendChild(title)
    svg.appendChild(rect)
  })
  if (options.range && axisHeight > 0) {
    const labelY = height + 12
    const start = svgEl('text', { x: Y_AXIS_GUTTER, y: labelY, 'text-anchor': 'start', class: 'publisher-analytics-axis' })
    start.textContent = options.range.start
    const end = svgEl('text', { x: totalWidth, y: labelY, 'text-anchor': 'end', class: 'publisher-analytics-axis' })
    end.textContent = options.range.end
    svg.append(start, end)
  }
  return svg
}

/**
 * Horizontal 100%-stacked mix bar + legend — platform mix, trigger
 * mix, source mix. Segment hues rotate through a fixed palette in
 * descending-share order so the biggest slice is always the first
 * color.
 */
export function renderMixBar(mix: Record<string, number>, ariaLabel: string): HTMLElement {
  const host = document.createElement('div')
  host.className = 'publisher-analytics-mix'
  const entries = Object.entries(mix)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  const total = entries.reduce((n, [, v]) => n + v, 0)
  if (total <= 0) return host

  const bar = document.createElement('div')
  bar.className = 'publisher-analytics-mix-bar'
  bar.setAttribute('role', 'img')
  bar.setAttribute('aria-label', ariaLabel)
  const legend = document.createElement('ul')
  legend.className = 'publisher-analytics-mix-legend'

  entries.forEach(([key, value], i) => {
    const share = value / total
    const segment = document.createElement('span')
    segment.className = `publisher-analytics-mix-segment publisher-analytics-hue-${i % 6}`
    segment.style.inlineSize = `${(share * 100).toFixed(2)}%`
    segment.title = `${key} — ${formatNumber(Math.round(value))} (${Math.round(share * 100)}%)`
    bar.appendChild(segment)

    const item = document.createElement('li')
    const swatch = document.createElement('span')
    swatch.className = `publisher-analytics-mix-swatch publisher-analytics-hue-${i % 6}`
    item.appendChild(swatch)
    // Mix keys are low-cardinality enum values from the telemetry
    // schema (web/desktop, browse/orbit/tour, hls/cache…) shown
    // verbatim. i18n-exempt: technical identifier
    item.appendChild(document.createTextNode(` ${key} · ${Math.round(share * 100)}%`))
    legend.appendChild(item)
  })

  host.appendChild(bar)
  host.appendChild(legend)
  return host
}

/** A big-number stat tile (label above, value below). */
export function renderStatTile(label: string, value: string): HTMLElement {
  const tile = document.createElement('div')
  tile.className = 'publisher-analytics-stat'
  const labelEl = document.createElement('span')
  labelEl.className = 'publisher-analytics-stat-label'
  labelEl.textContent = label
  const valueEl = document.createElement('span')
  valueEl.className = 'publisher-analytics-stat-value'
  valueEl.textContent = value
  tile.append(labelEl, valueEl)
  return tile
}

// --- CSV export -------------------------------------------------------

export type CsvCell = string | number | null | undefined
export type CsvRow = CsvCell[]

/** Serialize a cell, quoting only when it carries a comma, quote, or
 * newline (RFC 4180). `null`/`undefined` become an empty field. */
function csvCell(value: CsvCell): string {
  if (value == null) return ''
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Build an RFC-4180 CSV string (CRLF line endings) from rows. The
 * first row is conventionally the header. */
export function buildCsv(rows: readonly CsvRow[]): string {
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n')
}

/** Trigger a browser download of `rows` as a CSV file. No-op-safe in
 * environments without `URL.createObjectURL` (jsdom). */
export function downloadCsv(filename: string, rows: readonly CsvRow[]): void {
  const csv = buildCsv(rows)
  // BOM so Excel reads UTF-8 (hashed keys / country codes stay intact).
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  if (typeof URL.createObjectURL !== 'function') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  // Revoke on the next tick (same pattern as
  // zipDownloadService.saveBlobAsDownload / playlistUI) — revoking
  // synchronously can race the browser's download in some engines.
  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 0)
}

/** "Export CSV" button. The page passes a `getRows` thunk so the CSV
 * is built from the section's current data only when clicked. */
export function csvExportButton(label: string, filename: string, getRows: () => CsvRow[]): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'publisher-analytics-export'
  button.textContent = label
  button.addEventListener('click', () => downloadCsv(filename, getRows()))
  return button
}

/** Compact human duration for dwell sums: "4 h 12 m", "38 m", "55 s". */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} s` // i18n-exempt: unit abbreviation
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} m` // i18n-exempt: unit abbreviation
  const hours = Math.floor(totalMinutes / 60)
  return `${formatNumber(hours)} h ${totalMinutes % 60} m` // i18n-exempt: unit abbreviation
}
