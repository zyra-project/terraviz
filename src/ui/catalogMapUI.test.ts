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
  // `setData` is the bbox source's spy (kept named `setData` so the
  // existing overlay assertions read unchanged); `eventsSetData` is
  // the separate current-events source. `getSource` dispatches by id.
  const setData = vi.fn()
  const eventsSetData = vi.fn()
  // Stable canvas across calls within a single controller's lifetime
  // so tests can grab a reference and synthesise mousedown events
  // against it. Reset in beforeEach.
  let canvasEl: HTMLDivElement | null = null
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
    getSource: vi.fn((id: string) =>
      id === 'catalog-map-events' ? { setData: eventsSetData } : { setData },
    ),
    getCanvas: vi.fn(() => {
      // Memoised so the controller's `const mapCanvas = map.getCanvas()`
      // returns the same element on every subsequent call (cursor
      // style updates, getBoundingClientRect, etc.). Tests reach into
      // mapStub.canvas() to dispatch events on this same instance.
      if (!canvasEl) canvasEl = document.createElement('div')
      return canvasEl
    }),
    unproject: vi.fn(([x, y]: [number, number]) => ({ lat: y, lng: x })),
    resize: vi.fn(),
    boxZoom: { disable: vi.fn() },
    dragPan: { disable: vi.fn(), enable: vi.fn() },
    scrollZoom: { disable: vi.fn(), enable: vi.fn() },
    touchZoomRotate: { disable: vi.fn(), enable: vi.fn() },
  }
  return {
    map,
    dispose,
    setData,
    eventsSetData,
    handlers,
    layerHandlers,
    canvas: () => canvasEl,
    resetCanvas: () => { canvasEl = null },
  }
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
    mapStub.eventsSetData.mockClear()
    mapStub.resetCanvas()
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

  it('commits the bbox + invokes onRegionChange after a mousedown→mousemove→mouseup drag', async () => {
    // Regression test for the live-testing bug where the rectangle
    // visually vanished on mouseup with no resulting region filter.
    // Root cause: the mouseup handler called `cleanupDraw()` (which
    // nulls `drawStart`) BEFORE passing `drawStart` into
    // `lngLatPairToBbox`, throwing a TypeError on null.lat that
    // silently swallowed the rest of the handler — including the
    // `onRegionChange` callback that commits the predicate. The
    // exception path also skipped the analytics emit and the
    // setDrawMode(false) exit. TS narrowing held at the top-of-
    // function check, so `tsc --noEmit` didn't catch it.
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const onRegionChange = vi.fn()
    const controller = createCatalogMap(host, {
      onRegionChange,
      onPreviewDataset: vi.fn(),
    })
    for (const h of mapStub.handlers.load ?? []) h()

    // Enable draw mode via the toolbar button — same path the user
    // takes; exercises the mode wiring end-to-end.
    const drawBtn = host.querySelector<HTMLButtonElement>('.browse-map-draw-toggle')!
    drawBtn.click()
    expect(drawBtn.getAttribute('aria-pressed')).toBe('true')

    const mapCanvas = mapStub.canvas()!
    // happy-dom returns zeros for an unattached element's
    // getBoundingClientRect, so clientX/Y are equivalent to
    // canvas-local x/y for our purposes. The mock's `unproject`
    // returns `{lat: y, lng: x}`, so a drag from (50, 20) to
    // (120, 80) should commit bounds n=80, s=20, e=120, w=50.
    mapCanvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 50, clientY: 20 }))
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 120, clientY: 80 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 80 }))

    expect(onRegionChange).toHaveBeenCalledWith({ n: 80, s: 20, e: 120, w: 50 })
    // Draw mode auto-exits after a successful commit so the user
    // can resume panning without a second click.
    expect(drawBtn.getAttribute('aria-pressed')).toBe('false')
    controller.destroy()
  })

  it('renders a current-event point feature into the events source', async () => {
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [makeDataset({ id: 'linked' })],
      filterState: {},
      searchQuery: '',
      events: [
        {
          eventId: 'evt1',
          title: 'Marine heatwave',
          source: { name: 'NOAA', url: 'https://example.gov/heat' },
          occurredStart: '2024-06-01',
          geometry: { point: { lat: 20, lon: -40 } },
          linkedDatasetIds: ['linked'],
        },
      ],
    })
    for (const h of mapStub.handlers.load ?? []) h()
    // The events source got its own setData call with one point feature.
    const lastEvents = mapStub.eventsSetData.mock.calls.at(-1)?.[0] as { features: GeoJSON.Feature[] }
    expect(lastEvents.features).toHaveLength(1)
    expect(lastEvents.features[0].geometry.type).toBe('Point')
    expect(lastEvents.features[0].properties?.datasetId).toBe('linked')
    controller.destroy()
  })

  it('clicking an event point layer previews the first linked dataset', async () => {
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const onPreviewDataset = vi.fn()
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset,
    })
    controller.update({
      datasets: [makeDataset({ id: 'linked' })],
      filterState: {},
      searchQuery: '',
      events: [
        {
          eventId: 'evt1',
          title: 'Marine heatwave',
          source: { name: 'NOAA', url: 'https://example.gov/heat' },
          occurredStart: '2024-06-01',
          geometry: { point: { lat: 20, lon: -40 } },
          linkedDatasetIds: ['linked'],
        },
      ],
    })
    for (const h of mapStub.handlers.load ?? []) h()
    const clickHandlers = mapStub.layerHandlers['catalog-map-events-point']?.click ?? []
    expect(clickHandlers.length).toBeGreaterThan(0)
    for (const h of clickHandlers) {
      h({ features: [{ properties: { datasetId: 'linked' } }] })
    }
    expect(onPreviewDataset).toHaveBeenCalledWith('linked')
    controller.destroy()
  })

  it('drops a region-only event (no bbox/point) from the events source', async () => {
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const controller = createCatalogMap(host, {
      onRegionChange: vi.fn(),
      onPreviewDataset: vi.fn(),
    })
    controller.update({
      datasets: [makeDataset({ id: 'linked' })],
      filterState: {},
      searchQuery: '',
      events: [
        {
          eventId: 'evt-region',
          title: 'Region-only event',
          source: { name: 'NOAA', url: 'https://example.gov/x' },
          occurredStart: '2024-06-01',
          geometry: { regionName: 'Pacific Ocean' },
          linkedDatasetIds: ['linked'],
        },
      ],
    })
    for (const h of mapStub.handlers.load ?? []) h()
    const lastEvents = mapStub.eventsSetData.mock.calls.at(-1)?.[0] as { features: GeoJSON.Feature[] }
    expect(lastEvents.features).toHaveLength(0)
    controller.destroy()
  })

  it('clears the region on a degenerate (< 4 px) drag', async () => {
    // The single-click-as-clear convention mirrors the Timeline
    // brush — accidentally tapping the canvas while in Draw mode
    // shouldn't commit a 0×0 bbox; it clears any active region
    // instead.
    const { createCatalogMap } = await import('./catalogMapUI')
    const host = document.getElementById('host')!
    const onRegionChange = vi.fn()
    const controller = createCatalogMap(host, {
      onRegionChange,
      onPreviewDataset: vi.fn(),
    })
    for (const h of mapStub.handlers.load ?? []) h()
    const drawBtn = host.querySelector<HTMLButtonElement>('.browse-map-draw-toggle')!
    drawBtn.click()
    const mapCanvas = mapStub.canvas()!
    mapCanvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 50, clientY: 50 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 51, clientY: 51 }))
    expect(onRegionChange).toHaveBeenCalledWith(null)
    controller.destroy()
  })
})
