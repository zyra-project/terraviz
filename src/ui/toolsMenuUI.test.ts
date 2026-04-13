import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Tests for the Tools menu UI — the gear-icon button + collapsible
 * popover that hosts view toggles, the layout picker, the Clear
 * action, and the Orbit settings entry point.
 *
 * No MapLibre dependency here, so we stub just the small slice of
 * ViewportManager that the menu talks to (getAll, getPrimary).
 */

import { initToolsMenu, syncToolsMenuState, isToolsMenuOpen, pulseBrowseButton } from './toolsMenuUI'

// ---------------------------------------------------------------------------
// Minimal ViewportManager stand-in
// ---------------------------------------------------------------------------

interface FakeRenderer {
  toggleLabels: ReturnType<typeof vi.fn>
  toggleBoundaries: ReturnType<typeof vi.fn>
  toggleTerrain: ReturnType<typeof vi.fn>
  toggleAutoRotate: ReturnType<typeof vi.fn>
  clearMarkers: ReturnType<typeof vi.fn>
  clearHighlights: ReturnType<typeof vi.fn>
}

function makeRenderer(): FakeRenderer {
  return {
    toggleLabels: vi.fn(),
    toggleBoundaries: vi.fn(),
    toggleTerrain: vi.fn(),
    toggleAutoRotate: vi.fn().mockReturnValue(true),
    clearMarkers: vi.fn(),
    clearHighlights: vi.fn(),
  }
}

function makeViewports(count: number): {
  getAll: ReturnType<typeof vi.fn>
  getPrimary: ReturnType<typeof vi.fn>
  getLayout: ReturnType<typeof vi.fn>
  renderers: FakeRenderer[]
} {
  const renderers = Array.from({ length: count }, () => makeRenderer())
  return {
    getAll: vi.fn(() => renderers),
    getPrimary: vi.fn(() => renderers[0]),
    getLayout: vi.fn(() => '1'),
    renderers,
  }
}

// ---------------------------------------------------------------------------
// DOM scaffolding
// ---------------------------------------------------------------------------

function setupDom(): void {
  document.body.innerHTML = `<div id="map-controls" class="hidden"></div>`
}

// Reset URL so the layout picker (gated behind ?setview=) stays off
// unless a test explicitly opts in.
function setUrl(search = ''): void {
  const url = new URL(`http://localhost/${search}`)
  Object.defineProperty(window, 'location', {
    value: url,
    writable: true,
  })
}

beforeEach(() => {
  setupDom()
  setUrl('')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Init + DOM structure
// ---------------------------------------------------------------------------

describe('initToolsMenu', () => {
  it('renders the Browse + Tools buttons inside #map-controls', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    const host = document.getElementById('map-controls')!
    expect(host.classList.contains('hidden')).toBe(false)
    expect(document.getElementById('tools-menu-browse')).toBeTruthy()
    expect(document.getElementById('tools-menu-toggle')).toBeTruthy()
  })

  it('renders the popover hidden initially', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    const popover = document.getElementById('tools-menu-popover')!
    expect(popover.classList.contains('hidden')).toBe(true)
    expect(isToolsMenuOpen()).toBe(false)
  })

  it('renders View section with labels/borders/terrain/auto-rotate', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    expect(document.getElementById('tools-menu-labels')).toBeTruthy()
    expect(document.getElementById('tools-menu-borders')).toBeTruthy()
    expect(document.getElementById('tools-menu-terrain')).toBeTruthy()
    expect(document.getElementById('tools-menu-autorotate')).toBeTruthy()
  })

  it('renders Clear + Orbit settings buttons', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    expect(document.getElementById('tools-menu-clear')).toBeTruthy()
    expect(document.getElementById('tools-menu-orbit-settings')).toBeTruthy()
  })

  it('always renders the layout picker', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    expect(document.getElementById('tools-menu-layout-1')).toBeTruthy()
    expect(document.getElementById('tools-menu-layout-2h')).toBeTruthy()
    expect(document.getElementById('tools-menu-layout-2v')).toBeTruthy()
    expect(document.getElementById('tools-menu-layout-4')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

describe('Tools menu open/close', () => {
  it('opens the popover when the Tools button is clicked', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    const toggle = document.getElementById('tools-menu-toggle') as HTMLButtonElement
    toggle.click()

    expect(isToolsMenuOpen()).toBe(true)
    expect(document.getElementById('tools-menu-popover')!.classList.contains('hidden')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('closes the popover when the Tools button is clicked a second time', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)
    const toggle = document.getElementById('tools-menu-toggle') as HTMLButtonElement
    toggle.click() // open
    toggle.click() // close

    expect(isToolsMenuOpen()).toBe(false)
    expect(document.getElementById('tools-menu-popover')!.classList.contains('hidden')).toBe(true)
  })

  it('closes the popover when the ✕ close button is clicked', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)
    ;(document.getElementById('tools-menu-toggle') as HTMLButtonElement).click()
    expect(isToolsMenuOpen()).toBe(true)

    ;(document.getElementById('tools-menu-close') as HTMLButtonElement).click()
    expect(isToolsMenuOpen()).toBe(false)
  })

  it('closes the popover on outside click', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)
    ;(document.getElementById('tools-menu-toggle') as HTMLButtonElement).click()
    expect(isToolsMenuOpen()).toBe(true)

    // Outside click — dispatch on body, outside #map-controls
    document.body.click()
    expect(isToolsMenuOpen()).toBe(false)
  })

  it('stays open on clicks inside the popover', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)
    ;(document.getElementById('tools-menu-toggle') as HTMLButtonElement).click()

    // Click inside the View section — not a toggle, just the header
    const section = document.querySelector('.tools-menu-section-title') as HTMLElement
    section.click()

    expect(isToolsMenuOpen()).toBe(true)
  })

  it('closes on Escape key', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)
    ;(document.getElementById('tools-menu-toggle') as HTMLButtonElement).click()
    expect(isToolsMenuOpen()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(isToolsMenuOpen()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Toggle fan-out across viewports
// ---------------------------------------------------------------------------

describe('Tools menu fan-out', () => {
  it('toggles labels on every viewport', () => {
    const vm = makeViewports(4)
    initToolsMenu(vm as any)

    ;(document.getElementById('tools-menu-labels') as HTMLButtonElement).click()

    for (const r of vm.renderers) {
      expect(r.toggleLabels).toHaveBeenCalledWith(true)
    }
  })

  it('toggles borders on every viewport', () => {
    const vm = makeViewports(4)
    initToolsMenu(vm as any)

    ;(document.getElementById('tools-menu-borders') as HTMLButtonElement).click()

    for (const r of vm.renderers) {
      expect(r.toggleBoundaries).toHaveBeenCalledWith(true)
    }
  })

  it('toggles terrain on every viewport', () => {
    const vm = makeViewports(2)
    initToolsMenu(vm as any)

    ;(document.getElementById('tools-menu-terrain') as HTMLButtonElement).click()

    for (const r of vm.renderers) {
      expect(r.toggleTerrain).toHaveBeenCalledWith(true)
    }
  })

  it('clears markers and highlights on every viewport', () => {
    const vm = makeViewports(4)
    initToolsMenu(vm as any)

    ;(document.getElementById('tools-menu-clear') as HTMLButtonElement).click()

    for (const r of vm.renderers) {
      expect(r.clearMarkers).toHaveBeenCalled()
      expect(r.clearHighlights).toHaveBeenCalled()
    }
  })

  it('auto-rotate calls the primary renderer only', () => {
    const vm = makeViewports(4)
    initToolsMenu(vm as any)

    ;(document.getElementById('tools-menu-autorotate') as HTMLButtonElement).click()

    expect(vm.renderers[0].toggleAutoRotate).toHaveBeenCalled()
    for (let i = 1; i < vm.renderers.length; i++) {
      expect(vm.renderers[i].toggleAutoRotate).not.toHaveBeenCalled()
    }
  })

  it('flips the labels button to active after a click', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    const btn = document.getElementById('tools-menu-labels') as HTMLButtonElement
    expect(btn.classList.contains('active')).toBe(false)

    btn.click()
    expect(btn.classList.contains('active')).toBe(true)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })

  it('toggles labels off on second click', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    const btn = document.getElementById('tools-menu-labels') as HTMLButtonElement
    btn.click() // on
    btn.click() // off

    expect(btn.classList.contains('active')).toBe(false)
    // Second call passes false
    const calls = vm.renderers[0].toggleLabels.mock.calls
    expect(calls[0]).toEqual([true])
    expect(calls[1]).toEqual([false])
  })
})

// ---------------------------------------------------------------------------
// Dataset info + Legend toggles
// ---------------------------------------------------------------------------

describe('Tools menu dataset info / legend toggles', () => {
  it('renders Dataset info and Legend items in the View section', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    expect(document.getElementById('tools-menu-info')).toBeTruthy()
    expect(document.getElementById('tools-menu-legend')).toBeTruthy()
  })

  it('calls onToggleDatasetInfo with the new state when clicked', () => {
    const vm = makeViewports(1)
    const onToggleDatasetInfo = vi.fn()
    initToolsMenu(vm as any, { onToggleDatasetInfo, getCurrentDataset: () => null })

    // Starts active (on), first click turns it off
    const btn = document.getElementById('tools-menu-info') as HTMLButtonElement
    btn.click()
    expect(onToggleDatasetInfo).toHaveBeenCalledWith(false)

    btn.click()
    expect(onToggleDatasetInfo).toHaveBeenLastCalledWith(true)
  })

  it('calls onToggleLegend with the new state when clicked', () => {
    const vm = makeViewports(1)
    const onToggleLegend = vi.fn()
    initToolsMenu(vm as any, { onToggleLegend, getCurrentDataset: () => null })

    // Starts active (on), first click turns it off
    const btn = document.getElementById('tools-menu-legend') as HTMLButtonElement
    btn.click()
    expect(onToggleLegend).toHaveBeenCalledWith(false)
  })

  it('syncToolsMenuState applies datasetInfo and legend flags', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)
    syncToolsMenuState({ datasetInfo: true, legend: false })

    const infoBtn = document.getElementById('tools-menu-info')!
    const legendBtn = document.getElementById('tools-menu-legend')!
    expect(infoBtn.classList.contains('active')).toBe(true)
    expect(legendBtn.classList.contains('active')).toBe(false)
  })

  it('announces the new state for screen readers', () => {
    const vm = makeViewports(1)
    const announce = vi.fn()
    initToolsMenu(vm as any, { announce, getCurrentDataset: () => null })

    // Both start active (on), so first click turns them off
    ;(document.getElementById('tools-menu-info') as HTMLButtonElement).click()
    expect(announce).toHaveBeenCalledWith('Dataset info hidden')

    ;(document.getElementById('tools-menu-legend') as HTMLButtonElement).click()
    expect(announce).toHaveBeenCalledWith('Legend hidden')
  })
})

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

describe('Tools menu callbacks', () => {
  it('calls onOpenBrowse when Browse button is clicked', () => {
    const vm = makeViewports(1)
    const onOpenBrowse = vi.fn()
    initToolsMenu(vm as any, { onOpenBrowse, getCurrentDataset: () => null })

    ;(document.getElementById('tools-menu-browse') as HTMLButtonElement).click()
    expect(onOpenBrowse).toHaveBeenCalledTimes(1)
  })

  it('calls onOpenOrbitSettings when Orbit settings button is clicked', () => {
    const vm = makeViewports(1)
    const onOpenOrbitSettings = vi.fn()
    initToolsMenu(vm as any, { onOpenOrbitSettings, getCurrentDataset: () => null })

    ;(document.getElementById('tools-menu-toggle') as HTMLButtonElement).click()
    ;(document.getElementById('tools-menu-orbit-settings') as HTMLButtonElement).click()

    expect(onOpenOrbitSettings).toHaveBeenCalledTimes(1)
    // Popover closes after opening settings
    expect(isToolsMenuOpen()).toBe(false)
  })

  it('calls onSetLayout and updates active layout button when picker is used', () => {
    const vm = makeViewports(1)
    const onSetLayout = vi.fn()
    initToolsMenu(vm as any, { onSetLayout, getCurrentDataset: () => null })

    ;(document.getElementById('tools-menu-layout-4') as HTMLButtonElement).click()

    expect(onSetLayout).toHaveBeenCalledWith('4')
    const layout4 = document.getElementById('tools-menu-layout-4')!
    const layout1 = document.getElementById('tools-menu-layout-1')!
    expect(layout4.classList.contains('active')).toBe(true)
    expect(layout1.classList.contains('active')).toBe(false)
  })

  it('calls announce on toggles and actions', () => {
    const vm = makeViewports(1)
    const announce = vi.fn()
    initToolsMenu(vm as any, { announce, getCurrentDataset: () => null })

    ;(document.getElementById('tools-menu-labels') as HTMLButtonElement).click()
    expect(announce).toHaveBeenCalledWith('Labels on')

    ;(document.getElementById('tools-menu-clear') as HTMLButtonElement).click()
    expect(announce).toHaveBeenCalledWith('Markers and highlights cleared')
  })
})

// ---------------------------------------------------------------------------
// pulseBrowseButton
// ---------------------------------------------------------------------------

describe('pulseBrowseButton', () => {
  beforeEach(() => {
    // Ensure matchMedia is stubbed so prefers-reduced-motion returns false
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia
  })

  it('adds the pulse-attention class to the Browse button', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    pulseBrowseButton()
    const btn = document.getElementById('tools-menu-browse')!
    expect(btn.classList.contains('pulse-attention')).toBe(true)
  })

  it('removes the pulse class after the animation duration elapses', () => {
    vi.useFakeTimers()
    try {
      const vm = makeViewports(1)
      initToolsMenu(vm as any)
      pulseBrowseButton()

      const btn = document.getElementById('tools-menu-browse')!
      expect(btn.classList.contains('pulse-attention')).toBe(true)

      vi.advanceTimersByTime(3000)
      expect(btn.classList.contains('pulse-attention')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the pulse immediately when the user clicks the button', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)
    pulseBrowseButton()

    const btn = document.getElementById('tools-menu-browse') as HTMLButtonElement
    expect(btn.classList.contains('pulse-attention')).toBe(true)

    btn.click()
    expect(btn.classList.contains('pulse-attention')).toBe(false)
  })

  it('skips the animation when prefers-reduced-motion is set', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia

    const vm = makeViewports(1)
    initToolsMenu(vm as any)
    pulseBrowseButton()

    const btn = document.getElementById('tools-menu-browse')!
    expect(btn.classList.contains('pulse-attention')).toBe(false)
  })

  it('is a no-op when the Browse button is not rendered', () => {
    // Don't call initToolsMenu — button doesn't exist yet
    expect(() => pulseBrowseButton()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// syncToolsMenuState
// ---------------------------------------------------------------------------

describe('syncToolsMenuState', () => {
  it('updates the labels button state', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    syncToolsMenuState({ labels: true })
    const btn = document.getElementById('tools-menu-labels')!
    expect(btn.classList.contains('active')).toBe(true)
    expect(btn.getAttribute('aria-pressed')).toBe('true')

    syncToolsMenuState({ labels: false })
    expect(btn.classList.contains('active')).toBe(false)
  })

  it('updates multiple buttons at once', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)

    syncToolsMenuState({ labels: true, borders: true, terrain: true, autoRotate: true })

    expect(document.getElementById('tools-menu-labels')!.classList.contains('active')).toBe(true)
    expect(document.getElementById('tools-menu-borders')!.classList.contains('active')).toBe(true)
    expect(document.getElementById('tools-menu-terrain')!.classList.contains('active')).toBe(true)
    expect(document.getElementById('tools-menu-autorotate')!.classList.contains('active')).toBe(true)
  })

  it('only updates explicitly-provided fields', () => {
    const vm = makeViewports(1)
    initToolsMenu(vm as any)
    syncToolsMenuState({ labels: true })

    // Now update only borders — labels should remain on
    syncToolsMenuState({ borders: true })
    expect(document.getElementById('tools-menu-labels')!.classList.contains('active')).toBe(true)
    expect(document.getElementById('tools-menu-borders')!.classList.contains('active')).toBe(true)
  })
})
