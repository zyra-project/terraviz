import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Tests for ViewportManager.
 *
 * MapRenderer pulls in MapLibre which requires WebGL — not available
 * in happy-dom. We mock it with a minimal fake whose `getMap()` returns
 * an EventEmitter-ish stub we can drive directly. That gives us enough
 * to verify layout transitions, camera mirroring, and the re-entrancy
 * guard without booting a real map.
 *
 * Everything the mock factory needs is declared inside `vi.hoisted()`
 * so it's available at the time vitest hoists the `vi.mock()` call
 * above ordinary module-level declarations.
 */

// ---------------------------------------------------------------------------
// Hoisted fakes (shared between the vi.mock factory and the tests)
// ---------------------------------------------------------------------------

const { FakeMapRenderer, mockState } = vi.hoisted(() => {
  class FakeMap {
    camera = {
      center: { lng: 0, lat: 0 },
      zoom: 2.3,
      bearing: 0,
      pitch: 0,
    }
    moveListeners: Array<() => void> = []

    on(event: string, cb: () => void): FakeMap {
      if (event === 'move') this.moveListeners.push(cb)
      return this
    }
    off(event: string, cb: () => void): FakeMap {
      if (event === 'move') {
        this.moveListeners = this.moveListeners.filter((l) => l !== cb)
      }
      return this
    }
    once(_event: string, _cb: () => void): FakeMap {
      return this
    }
    getCenter() { return this.camera.center }
    getZoom() { return this.camera.zoom }
    getBearing() { return this.camera.bearing }
    getPitch() { return this.camera.pitch }
    jumpTo(state: {
      center?: { lng: number; lat: number }
      zoom?: number
      bearing?: number
      pitch?: number
    }) {
      if (state.center) this.camera.center = state.center
      if (typeof state.zoom === 'number') this.camera.zoom = state.zoom
      if (typeof state.bearing === 'number') this.camera.bearing = state.bearing
      if (typeof state.pitch === 'number') this.camera.pitch = state.pitch
      // jumpTo fires 'move' — real-world behaviour that
      // ViewportManager's syncLock must guard against.
      for (const cb of this.moveListeners) cb()
    }
    resize() {}
    remove() {}
  }

  class FakeMapRenderer {
    _map = new FakeMap()
    init(_container: HTMLElement, _options?: { canvasId?: string }) {
      // no-op
    }
    getMap(): FakeMap { return this._map }
    dispose() {}
  }

  const mockState = { activeRenderer: null as FakeMapRenderer | null }
  return { FakeMapRenderer, mockState }
})

// Type alias for FakeMapRenderer instances — the class binding from
// `vi.hoisted()` is a value, not a type, so use `InstanceType` for casts.
type FakeMapRendererInstance = InstanceType<typeof FakeMapRenderer>

// ---------------------------------------------------------------------------
// Mock mapRenderer module
// ---------------------------------------------------------------------------

vi.mock('./mapRenderer', () => ({
  MapRenderer: FakeMapRenderer,
  setActiveMapRenderer: vi.fn((r: FakeMapRendererInstance | null) => {
    mockState.activeRenderer = r
  }),
  getActiveMapRenderer: vi.fn(() => mockState.activeRenderer),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { ViewportManager, clampLayoutToPanelBudget } from './viewportManager'
import { setActiveMapRenderer } from './mapRenderer'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeGrid(): HTMLDivElement {
  const grid = document.createElement('div')
  grid.id = 'map-grid'
  document.body.appendChild(grid)
  return grid
}

beforeEach(() => {
  document.body.innerHTML = ''
  mockState.activeRenderer = null
  ;(setActiveMapRenderer as unknown as ReturnType<typeof vi.fn>).mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// init & layout
// ---------------------------------------------------------------------------

describe('ViewportManager.init', () => {
  it('creates one viewport for layout "1"', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '1')

    expect(vm.getLayout()).toBe('1')
    expect(vm.getAll()).toHaveLength(1)
    expect(grid.querySelectorAll('.map-viewport')).toHaveLength(1)
    vm.dispose()
  })

  it('creates two viewports for layout "2h"', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    expect(vm.getAll()).toHaveLength(2)
    expect(grid.querySelectorAll('.map-viewport')).toHaveLength(2)
    expect(grid.style.gridTemplate).toContain('1fr 1fr')
    vm.dispose()
  })

  it('creates four viewports for layout "4"', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')

    expect(vm.getAll()).toHaveLength(4)
    expect(grid.querySelectorAll('.map-viewport')).toHaveLength(4)
    vm.dispose()
  })

  it('sets data-layout on the grid element', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2v')

    expect(grid.getAttribute('data-layout')).toBe('2v')
    vm.dispose()
  })

  it('registers the primary renderer via setActiveMapRenderer', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '1')

    expect(setActiveMapRenderer).toHaveBeenCalled()
    expect(vm.getPrimary()).not.toBeNull()
    vm.dispose()
  })
})

describe('ViewportManager.setLayout', () => {
  it('adds viewports when growing from 1 to 4', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '1')
    expect(vm.getAll()).toHaveLength(1)

    vm.setLayout('4')
    expect(vm.getAll()).toHaveLength(4)
    expect(grid.querySelectorAll('.map-viewport')).toHaveLength(4)
    expect(vm.getLayout()).toBe('4')
    vm.dispose()
  })

  it('removes viewports when shrinking from 4 to 1', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')
    expect(vm.getAll()).toHaveLength(4)

    vm.setLayout('1')
    expect(vm.getAll()).toHaveLength(1)
    expect(grid.querySelectorAll('.map-viewport')).toHaveLength(1)
    vm.dispose()
  })

  it('is a no-op when the layout is already current', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')
    const rendererBefore = vm.getPrimary()

    vm.setLayout('2h')
    expect(vm.getPrimary()).toBe(rendererBefore)
    vm.dispose()
  })

  it('clamps primaryIndex when shrinking past the current primary', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')
    vm.promoteToPrimary(3)
    expect(vm.getPrimaryIndex()).toBe(3)

    vm.setLayout('1')
    expect(vm.getPrimaryIndex()).toBe(0)
    vm.dispose()
  })
})

// ---------------------------------------------------------------------------
// Camera sync
// ---------------------------------------------------------------------------

describe('ViewportManager camera sync', () => {
  it('mirrors camera state from source to all siblings', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')

    const all = vm.getAll()
    const source = (all[0] as unknown as FakeMapRendererInstance).getMap()

    // Move the source — jumpTo fires 'move' on itself, ViewportManager
    // mirrors to siblings.
    source.jumpTo({ center: { lng: 42, lat: -17 }, zoom: 5.5, bearing: 30, pitch: 45 })

    for (let i = 1; i < all.length; i++) {
      const sib = (all[i] as unknown as FakeMapRendererInstance).getMap()
      expect(sib.getCenter()).toEqual({ lng: 42, lat: -17 })
      expect(sib.getZoom()).toBe(5.5)
      expect(sib.getBearing()).toBe(30)
      expect(sib.getPitch()).toBe(45)
    }
    vm.dispose()
  })

  it('does not recurse on sibling jumpTo events (syncLock re-entrancy guard)', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    const all = vm.getAll()
    const sourceMap = (all[0] as unknown as FakeMapRendererInstance).getMap()
    const siblingMap = (all[1] as unknown as FakeMapRendererInstance).getMap()

    // Count how many times sibling.jumpTo is called during a single
    // source move. Without the syncLock it would recurse and fire
    // many times (or stack-overflow). With the guard it should fire
    // exactly once.
    const origJumpTo = siblingMap.jumpTo.bind(siblingMap)
    const spy = vi.fn((state: Parameters<typeof origJumpTo>[0]) => origJumpTo(state))
    siblingMap.jumpTo = spy

    sourceMap.jumpTo({ center: { lng: 10, lat: 20 }, zoom: 4, bearing: 0, pitch: 0 })

    expect(spy).toHaveBeenCalledTimes(1)
    vm.dispose()
  })

  it('is a no-op in single-viewport mode', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '1')

    const source = (vm.getAll()[0] as unknown as FakeMapRendererInstance).getMap()
    // Should not throw — no siblings to mirror to
    expect(() => source.jumpTo({ center: { lng: 1, lat: 2 }, zoom: 3, bearing: 0, pitch: 0 }))
      .not.toThrow()
    vm.dispose()
  })
})

// ---------------------------------------------------------------------------
// Primary management
// ---------------------------------------------------------------------------

describe('ViewportManager.promoteToPrimary', () => {
  it('updates primaryIndex and the active renderer slot', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')
    const initialCalls = (setActiveMapRenderer as unknown as ReturnType<typeof vi.fn>).mock.calls.length

    vm.promoteToPrimary(1)
    expect(vm.getPrimaryIndex()).toBe(1)
    expect((setActiveMapRenderer as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(initialCalls)
    vm.dispose()
  })

  it('warns and ignores out-of-range indices', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.promoteToPrimary(99)
    expect(vm.getPrimaryIndex()).toBe(0)
    vm.dispose()
  })

  it('is a no-op when promoting the current primary', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')
    const before = (setActiveMapRenderer as unknown as ReturnType<typeof vi.fn>).mock.calls.length

    vm.promoteToPrimary(0)
    expect((setActiveMapRenderer as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before)
    vm.dispose()
  })
})

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

describe('ViewportManager callbacks', () => {
  it('fires onLayoutChange when panel count grows', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    const onLayoutChange = vi.fn()
    vm.init(grid, '1', { onLayoutChange })
    expect(onLayoutChange).not.toHaveBeenCalled()

    vm.setLayout('4')
    expect(onLayoutChange).toHaveBeenCalledWith(4, 1)
    vm.dispose()
  })

  it('fires onLayoutChange when panel count shrinks', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    const onLayoutChange = vi.fn()
    vm.init(grid, '4', { onLayoutChange })

    vm.setLayout('2h')
    expect(onLayoutChange).toHaveBeenCalledWith(2, 4)
    vm.dispose()
  })

  it('does not fire onLayoutChange when count stays the same', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    const onLayoutChange = vi.fn()
    vm.init(grid, '2h', { onLayoutChange })

    vm.setLayout('2v')
    expect(onLayoutChange).not.toHaveBeenCalled()
    vm.dispose()
  })

  it('fires onPrimaryChange on promoteToPrimary', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    const onPrimaryChange = vi.fn()
    vm.init(grid, '2h', { onPrimaryChange })
    expect(onPrimaryChange).not.toHaveBeenCalled()

    vm.promoteToPrimary(1)
    expect(onPrimaryChange).toHaveBeenCalledWith(1, 0)
    vm.dispose()
  })

  it('fires onPrimaryChange when setLayout clamps the primary', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    const onPrimaryChange = vi.fn()
    vm.init(grid, '4', { onPrimaryChange })
    vm.promoteToPrimary(3)
    onPrimaryChange.mockClear()

    vm.setLayout('1')
    expect(onPrimaryChange).toHaveBeenCalledWith(0, 3)
    vm.dispose()
  })
})

// ---------------------------------------------------------------------------
// Primary indicator UI
// ---------------------------------------------------------------------------

describe('ViewportManager primary indicator', () => {
  it('creates a numbered indicator button per panel', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')

    const indicators = grid.querySelectorAll('.viewport-indicator')
    expect(indicators).toHaveLength(4)
    expect(indicators[0].textContent).toBe('1')
    expect(indicators[3].textContent).toBe('4')
    vm.dispose()
  })

  it('marks only the primary panel with is-primary class', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')

    const primaryPanels = grid.querySelectorAll('.map-viewport.is-primary')
    expect(primaryPanels).toHaveLength(1)
    expect((primaryPanels[0] as HTMLElement).dataset.viewportIndex).toBe('0')
    vm.dispose()
  })

  it('hides indicator buttons in single-viewport mode', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '1')

    const indicator = grid.querySelector('.viewport-indicator') as HTMLElement
    expect(indicator.style.display).toBe('none')
    vm.dispose()
  })

  it('shows indicator buttons in multi-viewport mode', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    const indicators = grid.querySelectorAll('.viewport-indicator') as NodeListOf<HTMLElement>
    for (const ind of indicators) {
      expect(ind.style.display).not.toBe('none')
    }
    vm.dispose()
  })

  it('promotes to primary when a non-primary indicator is clicked', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')
    expect(vm.getPrimaryIndex()).toBe(0)

    const indicators = grid.querySelectorAll('.viewport-indicator')
    ;(indicators[1] as HTMLButtonElement).click()

    expect(vm.getPrimaryIndex()).toBe(1)
    vm.dispose()
  })

  it('moves the is-primary class after promoteToPrimary', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.promoteToPrimary(1)
    const primaryPanels = grid.querySelectorAll('.map-viewport.is-primary')
    expect(primaryPanels).toHaveLength(1)
    expect((primaryPanels[0] as HTMLElement).dataset.viewportIndex).toBe('1')
    vm.dispose()
  })

  it('toggles indicator is-primary state after layout change clamps primary', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')
    vm.promoteToPrimary(3)

    vm.setLayout('1')
    const indicator = grid.querySelector('.viewport-indicator') as HTMLElement
    expect(indicator.classList.contains('is-primary')).toBe(true)
    // Single-view: hidden anyway
    expect(indicator.style.display).toBe('none')
    vm.dispose()
  })
})

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

describe('ViewportManager.dispose', () => {
  it('removes all viewport DOM nodes and clears the active slot', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')
    expect(grid.querySelectorAll('.map-viewport')).toHaveLength(4)

    vm.dispose()
    expect(grid.querySelectorAll('.map-viewport')).toHaveLength(0)
    expect(setActiveMapRenderer).toHaveBeenLastCalledWith(null)
  })
})

// ---------------------------------------------------------------------------
// clampLayoutToPanelBudget — the phone video-decode cap (terraviz#230)
// ---------------------------------------------------------------------------

describe('clampLayoutToPanelBudget', () => {
  it('passes a layout the budget already covers straight through', () => {
    expect(clampLayoutToPanelBudget('4', 4, false)).toBe('4')
    expect(clampLayoutToPanelBudget('2h', 2, false)).toBe('2h')
    expect(clampLayoutToPanelBudget('1', 2, true)).toBe('1')
  })

  it('reduces four globes to two when the budget is two', () => {
    // The crash case: a tour asks for four without knowing the device.
    expect(clampLayoutToPanelBudget('4', 2, true)).toBe('2v')
    expect(clampLayoutToPanelBudget('4', 2, false)).toBe('2h')
  })

  it('stacks on a portrait phone and splits side-by-side in landscape', () => {
    // Orientation decides whether two panels are usable at all: stacked
    // in portrait gives each globe the full width, where side-by-side
    // would leave it under 200px.
    expect(clampLayoutToPanelBudget('4', 2, true)).toBe('2v')
    expect(clampLayoutToPanelBudget('4', 2, false)).toBe('2h')
  })

  it('falls to a single globe when even two are too many', () => {
    expect(clampLayoutToPanelBudget('4', 1, true)).toBe('1')
    expect(clampLayoutToPanelBudget('2v', 1, false)).toBe('1')
  })

  it('never reduces a two-panel layout under a two-panel budget', () => {
    // Both 2h and 2v cost two decoders, so neither should be rewritten
    // into the other just because the budget is exactly two.
    expect(clampLayoutToPanelBudget('2v', 2, false)).toBe('2v')
    expect(clampLayoutToPanelBudget('2h', 2, true)).toBe('2h')
  })
})

// ---------------------------------------------------------------------------
// setPanelTimeNotice
// ---------------------------------------------------------------------------

describe('ViewportManager.setPanelTimeNotice', () => {
  it('mounts a notice naming the date the panel is actually showing', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.setPanelTimeNotice(1, 'Mar 2, 2026')

    const notices = grid.querySelectorAll('.panel-time-notice')
    expect(notices).toHaveLength(1)
    // The date has to survive into the rendered text — the whole point
    // is telling the viewer which moment this panel is on instead.
    expect(notices[0].textContent).toContain('Mar 2, 2026')
    expect(notices[0].getAttribute('role')).toBe('status')
    vm.dispose()
  })

  it('reuses the element and rewrites the date on a later call', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.setPanelTimeNotice(1, 'Mar 2, 2026')
    vm.setPanelTimeNotice(1, 'Mar 3, 2026')

    expect(grid.querySelectorAll('.panel-time-notice')).toHaveLength(1)
    expect(grid.querySelector('.panel-time-notice')!.textContent).toContain('Mar 3, 2026')
    vm.dispose()
  })

  it('hides on null without discarding the element', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.setPanelTimeNotice(1, 'Mar 2, 2026')
    vm.setPanelTimeNotice(1, null)

    const notice = grid.querySelector('.panel-time-notice')!
    expect(notice.classList.contains('hidden')).toBe(true)
    vm.dispose()
  })

  it('is inert for a slot that does not exist', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '1')

    // Teardown clears notices across every slot the previous layout had,
    // so this is reached routinely rather than exceptionally.
    expect(() => vm.setPanelTimeNotice(3, null)).not.toThrow()
    expect(() => vm.setPanelTimeNotice(3, 'Mar 2, 2026')).not.toThrow()
    expect(grid.querySelectorAll('.panel-time-notice')).toHaveLength(0)
    vm.dispose()
  })
})

// ---------------------------------------------------------------------------
// setPanelLegend
// ---------------------------------------------------------------------------

describe('ViewportManager.setPanelLegend', () => {
  it('creates a .panel-legend button on first call with a legendLink', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.setPanelLegend(0, 'https://example.com/legend.png', { title: 'Chlorophyll' })

    const legend = grid.querySelectorAll('.panel-legend')
    expect(legend).toHaveLength(1)
    const img = legend[0].querySelector('img') as HTMLImageElement
    expect(img.src).toBe('https://example.com/legend.png')
    expect((legend[0] as HTMLButtonElement).getAttribute('aria-label')).toContain('Chlorophyll')
    vm.dispose()
  })

  it('reuses the same element on subsequent calls and updates the src', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.setPanelLegend(0, 'https://example.com/first.png')
    vm.setPanelLegend(0, 'https://example.com/second.png')

    const legends = grid.querySelectorAll('.panel-legend')
    expect(legends).toHaveLength(1)
    const img = legends[0].querySelector('img') as HTMLImageElement
    expect(img.src).toBe('https://example.com/second.png')
    vm.dispose()
  })

  it('hides the legend element when called with null', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.setPanelLegend(0, 'https://example.com/legend.png')
    const legend = grid.querySelector('.panel-legend') as HTMLElement
    expect(legend.classList.contains('hidden')).toBe(false)

    vm.setPanelLegend(0, null)
    expect(legend.classList.contains('hidden')).toBe(true)
    vm.dispose()
  })

  it('is a no-op when called with null and no legend exists', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    expect(() => vm.setPanelLegend(0, null)).not.toThrow()
    expect(grid.querySelectorAll('.panel-legend')).toHaveLength(0)
    vm.dispose()
  })

  it('invokes the onClick callback when the legend button is clicked', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    const onClick = vi.fn()
    vm.setPanelLegend(0, 'https://example.com/legend.png', { onClick })

    const legend = grid.querySelector('.panel-legend') as HTMLButtonElement
    legend.click()
    expect(onClick).toHaveBeenCalledTimes(1)
    vm.dispose()
  })

  it('uses the latest onClick handler after a second setPanelLegend call', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    vm.setPanelLegend(0, 'https://example.com/a.png', { onClick: firstHandler })
    vm.setPanelLegend(0, 'https://example.com/b.png', { onClick: secondHandler })

    const legend = grid.querySelector('.panel-legend') as HTMLButtonElement
    legend.click()
    expect(firstHandler).not.toHaveBeenCalled()
    expect(secondHandler).toHaveBeenCalledTimes(1)
    vm.dispose()
  })

  it('is a no-op for out-of-range slot indices', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    expect(() => vm.setPanelLegend(99, 'https://example.com/legend.png')).not.toThrow()
    expect(grid.querySelectorAll('.panel-legend')).toHaveLength(0)
    vm.dispose()
  })

  it('setAllLegendsVisible(false) hides every rendered legend', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')

    vm.setPanelLegend(0, 'https://example.com/a.png')
    vm.setPanelLegend(1, 'https://example.com/b.png')
    vm.setPanelLegend(2, 'https://example.com/c.png')

    vm.setAllLegendsVisible(false)
    for (const el of grid.querySelectorAll('.panel-legend')) {
      expect((el as HTMLElement).classList.contains('hidden')).toBe(true)
    }
    vm.dispose()
  })

  it('setAllLegendsVisible(true) shows only legends with a src', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')

    vm.setPanelLegend(0, 'https://example.com/a.png')
    // Panel 1 has no legend ever set — no element created
    vm.setAllLegendsVisible(true)
    const legend0 = grid.querySelectorAll('[data-viewport-index="0"] .panel-legend')[0] as HTMLElement
    expect(legend0.classList.contains('hidden')).toBe(false)
    vm.dispose()
  })
})

// ---------------------------------------------------------------------------
// The live panel budget (terraviz#230)
//
// `clampLayoutToPanelBudget` above is pure and tested in isolation. These
// cover the part that actually prevents the crash: that the manager
// consults the budget on both entry points a four-globe request can
// arrive through — `init` for a deep link, `setLayout` for a tour. Every
// other test in this file runs at the default desktop size, where the
// clamp is a no-op, so removing either call site would leave the pure
// tests passing and the tab crashing.
// ---------------------------------------------------------------------------

describe('ViewportManager panel budget', () => {
  const spies: Array<{ mockRestore(): void }> = []

  function stubViewport(width: number, height: number): void {
    spies.push(vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width))
    spies.push(vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(height))
  }

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore()
  })

  it('boots a deep-linked four-globe layout as two stacked on a portrait phone', () => {
    stubViewport(393, 852)
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')

    expect(vm.getLayout()).toBe('2v')
    expect(vm.getAll()).toHaveLength(2)
    expect(grid.querySelectorAll('.map-viewport')).toHaveLength(2)
    vm.dispose()
  })

  it('boots it as two side-by-side on the same phone rotated', () => {
    stubViewport(852, 393)
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')

    expect(vm.getLayout()).toBe('2h')
    expect(vm.getAll()).toHaveLength(2)
    vm.dispose()
  })

  it('reduces a tour four-globe request to two', () => {
    // The reported crash path: the tour asks for four without knowing
    // what it is running on.
    stubViewport(393, 852)
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '1')
    vm.setLayout('4', 'tour')

    expect(vm.getLayout()).toBe('2v')
    expect(vm.getAll()).toHaveLength(2)
    expect(grid.querySelectorAll('.map-viewport')).toHaveLength(2)
    vm.dispose()
  })

  it('honours four globes on a desktop through both paths', () => {
    stubViewport(1440, 900)
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '4')
    expect(vm.getAll()).toHaveLength(4)
    vm.dispose()

    const grid2 = makeGrid()
    const vm2 = new ViewportManager()
    vm2.init(grid2, '1')
    vm2.setLayout('4', 'tour')
    expect(vm2.getLayout()).toBe('4')
    expect(vm2.getAll()).toHaveLength(4)
    vm2.dispose()
  })
})

// ---------------------------------------------------------------------------
// Panel notices — a failed stream outranks a time mismatch
// ---------------------------------------------------------------------------

describe('ViewportManager panel notices', () => {
  it('shows the stream notice in place of a time mismatch', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.setPanelTimeNotice(1, 'Aug 5, 2026')
    const notice = grid.querySelectorAll('.map-viewport')[1].querySelector('.panel-time-notice')!
    expect(notice.textContent).toContain('Aug 5, 2026')

    // The failure explains the mismatch; showing the symptom over the
    // cause would be a downgrade.
    vm.setPanelStreamNotice(1, true)
    expect(notice.textContent).not.toContain('Aug 5, 2026')
    expect(notice.classList.contains('hidden')).toBe(false)
    vm.dispose()
  })

  it('keeps the stream notice when the time notice is cleared', () => {
    // A dead stream does not come back to life because the transport moved.
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.setPanelStreamNotice(1, true)
    vm.setPanelTimeNotice(1, null)

    const notice = grid.querySelectorAll('.map-viewport')[1].querySelector('.panel-time-notice')!
    expect(notice.classList.contains('hidden')).toBe(false)
    vm.dispose()
  })

  it('falls back to the time mismatch once the stream notice clears', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.setPanelTimeNotice(1, 'Aug 5, 2026')
    vm.setPanelStreamNotice(1, true)
    vm.setPanelStreamNotice(1, false)

    const notice = grid.querySelectorAll('.map-viewport')[1].querySelector('.panel-time-notice')!
    expect(notice.textContent).toContain('Aug 5, 2026')
    vm.dispose()
  })

  it('hides the notice when neither cause is active', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '2h')

    vm.setPanelStreamNotice(1, true)
    vm.setPanelStreamNotice(1, false)

    const notice = grid.querySelectorAll('.map-viewport')[1].querySelector('.panel-time-notice')!
    expect(notice.classList.contains('hidden')).toBe(true)
    vm.dispose()
  })

  it('is inert for a slot that does not exist', () => {
    const grid = makeGrid()
    const vm = new ViewportManager()
    vm.init(grid, '1')
    expect(() => vm.setPanelStreamNotice(3, true)).not.toThrow()
    vm.dispose()
  })
})
