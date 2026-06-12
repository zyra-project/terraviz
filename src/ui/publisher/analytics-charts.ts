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

/**
 * Vertical bar series — the workhorse for per-day time series.
 * Scales to the series max; each bar carries a `<title>` tooltip
 * with "label — value". Renders an empty-but-valid SVG for an
 * empty series (the page shows its own empty-state copy).
 */
export function renderBarSeries(
  points: BarPoint[],
  options: { height?: number; ariaLabel: string } = { ariaLabel: '' },
): SVGSVGElement {
  const height = options.height ?? 96
  const width = 480
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    class: 'publisher-analytics-bars',
  })
  svg.setAttribute('aria-label', options.ariaLabel)
  if (points.length === 0) return svg

  const max = Math.max(...points.map(p => p.value), 1)
  const step = width / points.length
  const barWidth = Math.max(1, Math.min(step - 2, 28))
  points.forEach((p, i) => {
    const h = Math.max(p.value > 0 ? 2 : 0, (p.value / max) * (height - 4))
    const rect = svgEl('rect', {
      x: i * step + (step - barWidth) / 2,
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

/** Compact human duration for dwell sums: "4 h 12 m", "38 m", "55 s". */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} s` // i18n-exempt: unit abbreviation
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} m` // i18n-exempt: unit abbreviation
  const hours = Math.floor(totalMinutes / 60)
  return `${formatNumber(hours)} h ${totalMinutes % 60} m` // i18n-exempt: unit abbreviation
}
