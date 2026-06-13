/**
 * Unit tests for the analytics SVG chart helpers. DOM-only (no
 * MapLibre) — the heavier page wiring is covered by type-check and
 * the endpoint tests; these pin the pure rendering math.
 */

import { describe, expect, it } from 'vitest'
import {
  buildCsv,
  formatDurationMs,
  renderBarSeries,
  renderMixBar,
  renderStatTile,
} from './analytics-charts'

describe('renderBarSeries', () => {
  it('scales bars to the series max and tooltips label + value', () => {
    const svg = renderBarSeries(
      [
        { label: '2026-06-09', value: 5 },
        { label: '2026-06-10', value: 10 },
      ],
      { ariaLabel: 'Sessions per day', height: 100 },
    )
    const rects = svg.querySelectorAll('rect')
    expect(rects).toHaveLength(2)
    const h0 = parseFloat(rects[0].getAttribute('height')!)
    const h1 = parseFloat(rects[1].getAttribute('height')!)
    expect(h1).toBeCloseTo(96) // height - 4 padding
    expect(h0).toBeCloseTo(h1 / 2)
    expect(rects[1].querySelector('title')?.textContent).toContain('2026-06-10')
    expect(svg.getAttribute('aria-label')).toBe('Sessions per day')
  })

  it('draws Y-axis gridlines + value ticks (0 / mid / max)', () => {
    const svg = renderBarSeries(
      [
        { label: 'a', value: 0 },
        { label: 'b', value: 10 },
      ],
      { ariaLabel: 'x', height: 100 },
    )
    expect(svg.querySelectorAll('line.publisher-analytics-gridline')).toHaveLength(3)
    const ticks = [...svg.querySelectorAll('text.publisher-analytics-ytick')].map(t => t.textContent)
    // Max (10), mid (5), and 0 are all labelled.
    expect(ticks).toContain('10')
    expect(ticks).toContain('5')
    expect(ticks).toContain('0')
  })

  it('insets bars past the Y-axis gutter', () => {
    const svg = renderBarSeries([{ label: 'a', value: 1 }], { ariaLabel: 'x' })
    const x = parseFloat(svg.querySelector('rect')!.getAttribute('x')!)
    expect(x).toBeGreaterThanOrEqual(40) // Y_AXIS_GUTTER
  })

  it('renders a valid empty SVG for an empty series', () => {
    const svg = renderBarSeries([], { ariaLabel: 'empty' })
    expect(svg.querySelectorAll('rect')).toHaveLength(0)
  })

  it('keeps zero values at zero height but positives visible', () => {
    const svg = renderBarSeries(
      [
        { label: 'a', value: 0 },
        { label: 'b', value: 1000 },
        { label: 'c', value: 1 },
      ],
      { ariaLabel: 'x' },
    )
    const heights = [...svg.querySelectorAll('rect')].map(r => parseFloat(r.getAttribute('height')!))
    expect(heights[0]).toBe(0)
    expect(heights[2]).toBeGreaterThanOrEqual(2) // minimum visible sliver
  })
})

describe('renderBarSeries range labels', () => {
  it('renders start/end axis labels when a range is supplied', () => {
    const svg = renderBarSeries(
      [{ label: 'a', value: 1 }, { label: 'b', value: 2 }],
      { ariaLabel: 'x', range: { start: 'Mar 14, 2026', end: 'Jun 11, 2026' } },
    )
    const labels = [...svg.querySelectorAll('text.publisher-analytics-axis')].map(t => t.textContent)
    expect(labels).toEqual(['Mar 14, 2026', 'Jun 11, 2026'])
  })

  it('omits axis labels for an empty series', () => {
    const svg = renderBarSeries([], { ariaLabel: 'x', range: { start: 'a', end: 'b' } })
    expect(svg.querySelectorAll('text')).toHaveLength(0)
  })
})

describe('renderMixBar', () => {
  it('renders descending segments summing to 100% with a legend', () => {
    const host = renderMixBar({ browse: 1, orbit: 3 }, 'Triggers')
    const segments = [...host.querySelectorAll('.publisher-analytics-mix-segment')] as HTMLElement[]
    expect(segments).toHaveLength(2)
    // Descending share: orbit (75%) first.
    expect(segments[0].title).toContain('orbit')
    expect(segments[0].style.inlineSize).toBe('75.00%')
    const legendItems = [...host.querySelectorAll('li')].map(li => li.textContent)
    expect(legendItems[0]).toContain('orbit')
    expect(legendItems[0]).toContain('75%')
  })

  it('renders nothing for an all-zero mix', () => {
    const host = renderMixBar({ a: 0 }, 'x')
    expect(host.childElementCount).toBe(0)
  })

  it('never injects markup from keys', () => {
    const host = renderMixBar({ '<img src=x onerror=1>': 2 }, 'x')
    expect(host.querySelector('img')).toBeNull()
  })
})

describe('renderStatTile', () => {
  it('renders label and value as text', () => {
    const tile = renderStatTile('Sessions', '1,234')
    expect(tile.querySelector('.publisher-analytics-stat-label')?.textContent).toBe('Sessions')
    expect(tile.querySelector('.publisher-analytics-stat-value')?.textContent).toBe('1,234')
  })
})

describe('buildCsv', () => {
  it('joins rows with CRLF and comma-separates cells', () => {
    expect(buildCsv([['a', 'b'], [1, 2]])).toBe('a,b\r\n1,2')
  })

  it('quotes cells containing commas, quotes, or newlines', () => {
    expect(buildCsv([['a,b', 'c"d', 'e\nf']])).toBe('"a,b","c""d","e\nf"')
  })

  it('renders null / undefined as empty fields', () => {
    expect(buildCsv([[null, undefined, 0]])).toBe(',,0')
  })
})

describe('formatDurationMs', () => {
  it('picks the largest sensible unit', () => {
    expect(formatDurationMs(55_000)).toBe('55 s')
    expect(formatDurationMs(38 * 60_000)).toBe('38 m')
    expect(formatDurationMs(4 * 3_600_000 + 12 * 60_000)).toBe('4 h 12 m')
  })
})
