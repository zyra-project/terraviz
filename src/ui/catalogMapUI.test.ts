/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { resetForTests, __peek } from '../analytics/emitter'
import { setTier } from '../analytics/config'
import type { Dataset } from '../types'

// Mock the MapRenderer module so the second MapLibre instance
// doesn't try to mount inside happy-dom (no WebGL, no canvas
// pixel pushing). The mock exposes the small surface
// `catalogMapUI` consumes — `init`, `getMap`, `dispose`,
// `getProjection` — and returns a stub `map` whose handlers
// land in vi.fn so tests can assert on them.
const mapStub = vi.hoisted(() => {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  const layerHandlers: Record<string, Record<string, Array<(...args: unknown[]) => void>>> = {}
  const dispose = vi.fn()
  const setData = vi.fn()
  const map = {
    on: vi.fn((event: string, arg2?: string | ((...a: unknown[]) => void), arg3?: (...a: unknown[]) => void) => {
      if (typeof arg2 === 'string' && typeof arg3 === 'function') {
        ;(layerHandlers[arg2] ||= {})[event] ||= []
        layerHandlers[arg2][event].push(arg3)
      } else if (typeof arg2 === 'function') {
        ;(handlers[event] ||= []).push(arg2)
      }
    }),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    getSource: vi.fn(() => ({ setData })),
    getCanvas: vi.fn(() => {
      // Return a minimal DOM element the draw-rectangle wiring can
      // attach listeners to. happy-dom provides addEventListener +
      // getBoundingClientRect.
      return document.createElement('div')
    }),
    unproject: vi.fn(([x, y]: [number, number]) => ({ lat: y, lng: x })),
    resize: vi.fn(),
    boxZoom: { disable: vi.fn() },
    dragPan: { disable: vi.fn(), enable: vi.fn() },
    scrollZoom: { disable: vi.fn(), enable: vi.fn() },
    touchZoomRotate: { disable: vi.fn(), enable: vi.fn() },
  }
  return { map, dispose, setData, handlers, layerHandlers }
})

vi.mock('../services/mapRenderer', () => ({
  MapRenderer: class {
    init(): void {}
    getMap(): unknown {
      return mapStub.map
    }
    getProjection(): string {
      return 'mercator'
    }
    dispose(): void {
      mapStub.dispose()
    }
  },
}))

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'd1',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data.mp4',
    tags: ['Water'],
    startTime: '2020-01-01',
    endTime: '2024-01-01',
    boundingBox: { n: 45, s: -45, e: 90, w: -90 },
    ...overrides,
  }
}

describe('createCatalogMap', () => {
  beforeEach(async () => {
    // Drain any lazy `import('./catalogMapUI')` from earlier tests
    // so their analytics emits don't leak across boundaries (same
    // pattern as the browseUI + catalogTimelineUI suites).
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    resetForTests()
    setTier('research')
    document.body.innerHTML = '<div id="host"></div>'
    if (typeof globalThis.ResizeObserver === 'undefined') {
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
        class { observe(): void {} disconnect(): void {} unobserve(): void {} }
    }
    // Re-import the mock state between tests so handlers don't
    // leak from one mount to the next.
    Object.keys(mapStub.handlers).forEach(k => delete mapStub.handlers[k])
    Object.keys(mapStub.layerHandlers).forEach(k => delete mapStub.layerHandlers[k])
    mapStub.setData.mockClear()
  })

  it('mounts the host container with toolbar + canvas + tooltip + empty fallback', async () => {
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    expect(host.classList.contains('browse-map-host')).toBe(true)
    expect(host.querySelector('.browse-map-toolbar')).not.toBeNull()
    expect(host.querySelector('.browse-map-canvas')).not.toBeNull()
    expect(host.querySelector('.browse-map-tooltip')).not.toBeNull()
    expect(host.querySelector('.browse-map-empty')).not.toBeNull()
    expect(host.querySelector('.browse-map-footnote')).not.toBeNull()
    expect(host.querySelector('.browse-map-include-global-input')).not.toBeNull()
    expect(host.querySelector('.browse-map-draw-toggle')).not.toBeNull()
    controller.destroy()
  })

  it('renders overlays for filtered datasets with a boundingBox once the map loads', async () => {
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [makeDataset({ id: 'd1' })],
      filterState: {},
      searchQuery: '',
    })
    // The map's `load` handler triggers setupBboxLayers + the first
    // rebuild. Fire it manually since the stub doesn't load async.
    for (const h of mapStub.handlers.load ?? []) h()
    expect(mapStub.setData).toHaveBeenCalled()
    const lastCall = mapStub.setData.mock.calls.at(-1)
    const featureCollection = lastCall?.[0] as { features: unknown[] }
    expect(featureCollection.features).toHaveLength(1)
    controller.destroy()
  })

  it('shows the empty state when no datasets survive filtering', async () => {
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [makeDataset({ id: 'd1', boundingBox: undefined })],
      filterState: {},
      searchQuery: '',
    })
    for (const h of mapStub.handlers.load ?? []) h()
    const empty = host.querySelector('.browse-map-empty') as HTMLElement | null
    expect(empty).not.toBeNull()
    expect(empty!.classList.contains('hidden')).toBe(false)
    // Footnote should call out the undated dataset.
    const footnote = host.querySelector('.browse-map-footnote') as HTMLElement | null
    expect(footnote!.classList.contains('hidden')).toBe(false)
    expect(footnote!.textContent).toMatch(/no geographic coverage/i)
    controller.destroy()
  })

  it('footers the hidden-globals count when global bboxes are suppressed', async () => {
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [
        makeDataset({ id: 'global', boundingBox: { n: 90, s: -90, e: 180, w: -180 } }),
        makeDataset({ id: 'regional', boundingBox: { n: 30, s: -30, e: 60, w: -60 } }),
      ],
      filterState: {},
      searchQuery: '',
    })
    for (const h of mapStub.handlers.load ?? []) h()
    const footnote = host.querySelector('.browse-map-footnote') as HTMLElement | null
    expect(footnote!.classList.contains('hidden')).toBe(false)
    expect(footnote!.textContent).toMatch(/1 global dataset hidden/i)
    controller.destroy()
  })

  it('toggling include-global surfaces global bboxes when a regional bbox exists alongside', async () => {
    // With at least one regional bbox present, the auto-flip
    // safety-net does NOT fire (`bboxes.length > 0` after the
    // default `includeGlobal: false` render). The user-driven
    // toggle then takes over.
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [
        makeDataset({ id: 'regional', boundingBox: { n: 30, s: -30, e: 60, w: -60 } }),
        makeDataset({ id: 'global', boundingBox: { n: 90, s: -90, e: 180, w: -180 } }),
      ],
      filterState: {},
      searchQuery: '',
    })
    for (const h of mapStub.handlers.load ?? []) h()
    // Default — global hidden, regional visible.
    const first = mapStub.setData.mock.calls.at(-1)?.[0] as { features: unknown[] }
    expect(first.features).toHaveLength(1)

    // Toggle on — both surface.
    const checkbox = host.querySelector<HTMLInputElement>('.browse-map-include-global-input')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))
    const second = mapStub.setData.mock.calls.at(-1)?.[0] as { features: unknown[] }
    expect(second.features).toHaveLength(2)
    controller.destroy()
  })

  it('auto-flips include-global on first render when every match is global (v1 catalog-shape concession)', async () => {
    // The SOS catalog is overwhelmingly worldwide today; defaulting
    // `includeGlobal: false` would produce a blank canvas on first
    // open. The controller's one-shot auto-flip surfaces the global
    // bboxes instead, so the user immediately sees a populated map.
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [
        makeDataset({ id: 'g1', boundingBox: { n: 90, s: -90, e: 180, w: -180 } }),
        makeDataset({ id: 'g2', boundingBox: { n: 90, s: -90, e: 180, w: -180 } }),
      ],
      filterState: {},
      searchQuery: '',
    })
    for (const h of mapStub.handlers.load ?? []) h()
    // Auto-flipped — both global bboxes surfaced.
    const last = mapStub.setData.mock.calls.at(-1)?.[0] as { features: unknown[] }
    expect(last.features).toHaveLength(2)
    // The checkbox state reflects the auto-flip so the user can
    // see (and reverse) what happened.
    const checkbox = host.querySelector<HTMLInputElement>('.browse-map-include-global-input')!
    expect(checkbox.checked).toBe(true)
    controller.destroy()
  })

  it('clear-region button calls onRegionChange(null)', async () => {
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const onRegionChange = vi.fn()
    const controller = createCatalogMap(host, {
      onRegionChange,
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [makeDataset({ id: 'd1' })],
      filterState: {
        geographicRegion: { kind: 'bbox', n: 40, s: -40, e: 30, w: -30 },
      },
      searchQuery: '',
    })
    for (const h of mapStub.handlers.load ?? []) h()
    const clearBtn = host.querySelector<HTMLButtonElement>('.browse-map-clear-region')!
    expect(clearBtn.classList.contains('hidden')).toBe(false)
    clearBtn.click()
    expect(onRegionChange).toHaveBeenCalledWith(null)
    controller.destroy()
  })

  it('toggling Draw region updates aria-pressed on the toggle button', async () => {
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    const drawBtn = host.querySelector<HTMLButtonElement>('.browse-map-draw-toggle')!
    expect(drawBtn.getAttribute('aria-pressed')).toBe('false')
    drawBtn.click()
    expect(drawBtn.getAttribute('aria-pressed')).toBe('true')
    expect(drawBtn.classList.contains('active')).toBe(true)
    drawBtn.click()
    expect(drawBtn.getAttribute('aria-pressed')).toBe('false')
    controller.destroy()
  })

  it('clicking a bbox layer invokes the preview callback with the dataset id', async () => {
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const onPreviewDataset = vi.fn()
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset,
    })
    controller.update({
      datasets: [makeDataset({ id: 'click-me' })],
      filterState: {},
      searchQuery: '',
    })
    for (const h of mapStub.handlers.load ?? []) h()
    // Simulate the layer-bound click handler the controller wired
    // up at setupBboxLayers.
    const clickHandlers = mapStub.layerHandlers['catalog-map-bboxes-fill']?.click ?? []
    expect(clickHandlers.length).toBeGreaterThan(0)
    for (const h of clickHandlers) {
      h({ features: [{ properties: { datasetId: 'click-me' } }] })
    }
    expect(onPreviewDataset).toHaveBeenCalledWith('click-me')
    controller.destroy()
  })

  // The full draw-rectangle gesture (mousedown → mousemove → mouseup,
  // with `unproject` mapping into geographic coords) is exercised
  // end-to-end only with a real WebGL canvas — happy-dom plus the
  // stubbed MapLibre instance can't synthesise the full event chain
  // with believable pixel-to-LngLat values. The toggle assertions
  // above cover the mode plumbing without the gesture; the
  // `catalog_map_region_drawn` emit on a real draw is covered via
  // the manual smoke checklist in the PR description. Marked `skip`
  // so the suite doesn't claim coverage it doesn't actually run.
  it.skip('emits catalog_map_region_drawn when the draw handler completes (needs real browser)', () => {
    expect(__peek()).toEqual([])
  })
})
