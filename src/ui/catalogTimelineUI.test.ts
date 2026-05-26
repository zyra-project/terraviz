/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { resetForTests, __peek } from '../analytics/emitter'
import { setTier } from '../analytics/config'
import type { Dataset } from '../types'

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'd1',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data.mp4',
    tags: ['Water'],
    startTime: '2020-01-01',
    endTime: '2024-01-01',
    ...overrides,
  }
}

describe('createCatalogTimeline', () => {
  beforeEach(async () => {
    // Drain the lazy `import('./catalogTimelineUI')` from any earlier
    // test so its analytics emits don't leak across boundaries (same
    // pattern as the browseUI suite around the graph lazy load).
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    resetForTests()
    setTier('research')
    document.body.innerHTML = '<div id="host"></div>'
    // d3-brush relies on ResizeObserver to detect when the host
    // resizes. happy-dom doesn't ship one by default; stub it.
    if (typeof globalThis.ResizeObserver === 'undefined') {
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
        class { observe(): void {} disconnect(): void {} unobserve(): void {} }
    }
  })

  it('mounts the host container with toolbar + chart + empty fallback', async () => {
    const { createCatalogTimeline } = await import('./catalogTimelineUI')
    const host = document.getElementById('host')!
    const controller = createCatalogTimeline(host, {
      onBrushChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [makeDataset({ id: 'd1' })],
      filterState: {},
      searchQuery: '',
    })
    expect(host.classList.contains('browse-timeline-host')).toBe(true)
    expect(host.querySelector('.browse-timeline-toolbar')).not.toBeNull()
    expect(host.querySelector('.browse-timeline-chart')).not.toBeNull()
    // One row rendered for the single dataset.
    expect(host.querySelectorAll('g.browse-timeline-row')).toHaveLength(1)
    controller.destroy()
  })

  it('shows the empty state when no rows survive filtering', async () => {
    const { createCatalogTimeline } = await import('./catalogTimelineUI')
    const host = document.getElementById('host')!
    const controller = createCatalogTimeline(host, {
      onBrushChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [makeDataset({ id: 'd1', startTime: undefined, endTime: undefined })],
      filterState: {},
      searchQuery: '',
    })
    const empty = host.querySelector('.browse-timeline-empty') as HTMLElement | null
    expect(empty).not.toBeNull()
    expect(empty!.classList.contains('hidden')).toBe(false)
    // Footnote should call out the undated dataset.
    const footnote = host.querySelector('.browse-timeline-footnote') as HTMLElement | null
    expect(footnote!.classList.contains('hidden')).toBe(false)
    expect(footnote!.textContent).toMatch(/no temporal coverage/i)
    controller.destroy()
  })

  it('invokes the row preview callback on row click', async () => {
    const { createCatalogTimeline } = await import('./catalogTimelineUI')
    const host = document.getElementById('host')!
    const onPreviewDataset = vi.fn()
    const controller = createCatalogTimeline(host, {
      onBrushChange: vi.fn(),
      onPreviewDataset,
    })
    controller.update({
      datasets: [
        makeDataset({ id: 'click-me', startTime: '2020-01-01', endTime: '2024-01-01' }),
      ],
      filterState: {},
      searchQuery: '',
    })
    const row = host.querySelector<SVGGElement>('g.browse-timeline-row')!
    // d3's `.on('click', ...)` listens to native DOM events; dispatch
    // one so the handler fires.
    row.dispatchEvent(new Event('click', { bubbles: true }))
    expect(onPreviewDataset).toHaveBeenCalledWith('click-me')
    controller.destroy()
  })

  it('clear-range button calls onBrushChange(null)', async () => {
    const { createCatalogTimeline } = await import('./catalogTimelineUI')
    const host = document.getElementById('host')!
    const onBrushChange = vi.fn()
    const controller = createCatalogTimeline(host, {
      onBrushChange,
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [makeDataset({ id: 'd1' })],
      filterState: {
        dataCoverageYear: { kind: 'range', min: 2020, max: 2024 },
      },
      searchQuery: '',
    })
    const clearBtn = host.querySelector<HTMLButtonElement>('.browse-timeline-brush-clear')!
    // The summary should render the active range; clear button is visible.
    expect(clearBtn.classList.contains('hidden')).toBe(false)
    clearBtn.click()
    expect(onBrushChange).toHaveBeenCalledWith(null)
    controller.destroy()
  })

  it('renders the real-time marker only on tagged rows', async () => {
    const { createCatalogTimeline } = await import('./catalogTimelineUI')
    const host = document.getElementById('host')!
    const controller = createCatalogTimeline(host, {
      onBrushChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [
        makeDataset({ id: 'rt', tags: ['Water', 'Real-Time'] }),
        makeDataset({ id: 'static', tags: ['Water'] }),
      ],
      filterState: {},
      searchQuery: '',
    })
    const markers = host.querySelectorAll<SVGCircleElement>(
      'circle.browse-timeline-realtime-marker',
    )
    expect(markers).toHaveLength(2)
    // One visible (real-time), one display:none (static).
    const visible = Array.from(markers).filter(m => m.style.display !== 'none')
    expect(visible).toHaveLength(1)
    controller.destroy()
  })

  // The brush gesture itself (d3-brush's pointer-event chain) needs
  // a real browser to fire — synthesising the full PointerEvent
  // sequence under happy-dom is brittle. The clear-range path above
  // exercises the same `onBrushChange` callback wiring without the
  // gesture; the throttled analytics emit on a real brush release
  // is covered end-to-end via the manual smoke checklist in the PR
  // description. Marked `skip` so the suite doesn't claim coverage
  // it doesn't actually run.
  it.skip('emits catalog_timeline_brush_applied when the brush handler fires (needs real browser)', () => {
    expect(__peek()).toEqual([])
  })
})
