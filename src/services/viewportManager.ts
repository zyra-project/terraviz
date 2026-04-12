/**
 * ViewportManager — orchestrates one or more synchronised MapRenderer
 * instances inside a CSS grid container.
 *
 * **Scope** — creates/destroys MapRenderer instances to match a target
 * layout (1, 2h, 2v, or 4 panels), wires each one's `move` event to
 * mirror camera state to every sibling, and tracks a "primary" index
 * that drives playback, screenshots, and the info panel.
 *
 * **Dataset-agnostic.** ViewportManager does not load or own datasets.
 * It exposes renderers via `getPrimary()` / `getRendererAt()`; callers
 * (main.ts) keep a parallel per-panel dataset state array and load
 * into the right renderer. ViewportManager fires `onPrimaryChange` and
 * `onLayoutChange` callbacks so callers can react.
 *
 * **Primary affordance.** Each non-primary panel gets a small pill
 * button ("1" / "2" / "3" / "4") in the top-left that, when clicked,
 * promotes that panel to primary. The primary panel's button is
 * styled differently and does nothing on click. The primary panel
 * also gets a subtle accent border.
 *
 * **Camera sync** uses `jumpTo` (not `easeTo`) on siblings so motion is
 * instantaneous and doesn't compound across panels. A `syncLock` flag
 * prevents the move event we dispatch on siblings from re-entering
 * the sync path — without it, every `jumpTo` would fire another
 * `move` and we'd recurse forever.
 *
 * The module-level `activeRenderer` singleton in mapRenderer.ts is
 * kept in sync via `setActiveMapRenderer()` so screenshotService
 * (which can't easily take a renderer argument) always captures the
 * primary.
 */

import { MapRenderer, setActiveMapRenderer } from './mapRenderer'
import { logger } from '../utils/logger'

/** Viewport layout identifier. */
export type ViewLayout = '1' | '2h' | '2v' | '4'

/** How many panels a given layout renders. */
const PANEL_COUNT: Record<ViewLayout, number> = {
  '1': 1,
  '2h': 2,
  '2v': 2,
  '4': 4,
}

/**
 * CSS `grid-template` shorthand for each layout. The number of columns
 * in the area strings MUST match the number of column sizes after `/`
 * or CSS grid falls back to implicit tracks and the visible area
 * shrinks (bug seen in Phase 2: `2v` was written as `"a" "b" / 1fr 1fr`
 * which only populated the left half of the container).
 */
const GRID_TEMPLATE: Record<ViewLayout, string> = {
  '1': '"a" / 1fr',
  '2h': '"a b" / 1fr 1fr',
  '2v': '"a" "b" / 1fr',
  '4': '"a b" "c d" / 1fr 1fr',
}

/** Callbacks fired by the manager so callers can keep parallel state. */
export interface ViewportManagerCallbacks {
  /**
   * Fired after a `setLayout` call that changed the panel count, with
   * the new count. Callers should resize their parallel per-panel
   * state arrays. Not fired on init — callers know the starting count.
   */
  onLayoutChange?(newCount: number, oldCount: number): void
  /**
   * Fired when `promoteToPrimary` changes the primary index, with
   * the new and previous indices. Callers should rewire UI bound to
   * "the current dataset" (info panel, playback controls, URL, etc.).
   */
  onPrimaryChange?(newIndex: number, oldIndex: number): void
}

/** One panel in the grid. */
interface Viewport {
  index: number
  container: HTMLDivElement
  renderer: MapRenderer
  indicator: HTMLButtonElement
  /** Floating per-panel legend element — lazily created the first
   *  time the panel needs one, and toggled via classList thereafter. */
  legend: HTMLButtonElement | null
  onMove: () => void
}

export class ViewportManager {
  private grid: HTMLElement | null = null
  private viewports: Viewport[] = []
  private layout: ViewLayout = '1'
  private primaryIndex = 0
  /** Re-entrancy guard for mirrored camera moves. */
  private syncLock = false
  private callbacks: ViewportManagerCallbacks = {}

  /**
   * Initialize the manager with a grid element and the starting layout.
   * Creates the initial set of panels and their MapRenderers.
   */
  init(
    grid: HTMLElement,
    initialLayout: ViewLayout = '1',
    callbacks: ViewportManagerCallbacks = {},
  ): void {
    this.grid = grid
    this.callbacks = callbacks
    this.applyGridTemplate(initialLayout)
    this.layout = initialLayout

    const count = PANEL_COUNT[initialLayout]
    for (let i = 0; i < count; i++) {
      this.addViewport(i)
    }
    this.refreshActiveRenderer()
    this.refreshPrimaryStyling()
  }

  /**
   * Change the layout. Adds or removes panels as needed, reusing
   * existing ones. Camera state is copied from the primary to any
   * newly-created panels so the visual transition is seamless.
   *
   * Fires `onLayoutChange` after the panels have been added/removed
   * so callers can resize their parallel per-panel state arrays.
   */
  setLayout(layout: ViewLayout): void {
    if (!this.grid) {
      logger.warn('[ViewportManager] setLayout called before init')
      return
    }
    if (layout === this.layout) return

    const targetCount = PANEL_COUNT[layout]
    const previousCount = this.viewports.length

    // Remove excess panels (back-to-front so indices stay stable)
    while (this.viewports.length > targetCount) {
      const vp = this.viewports.pop()!
      this.destroyViewport(vp)
    }

    this.applyGridTemplate(layout)
    this.layout = layout

    // Add new panels seeded from the primary's current camera state
    while (this.viewports.length < targetCount) {
      const idx = this.viewports.length
      this.addViewport(idx)
    }

    // Primary might have been removed — clamp
    const previousPrimary = this.primaryIndex
    if (this.primaryIndex >= this.viewports.length) {
      this.primaryIndex = 0
    }
    this.refreshActiveRenderer()
    this.refreshPrimaryStyling()
    this.resizeAll()

    if (previousCount !== targetCount) {
      this.callbacks.onLayoutChange?.(targetCount, previousCount)
    }
    if (previousPrimary !== this.primaryIndex) {
      this.callbacks.onPrimaryChange?.(this.primaryIndex, previousPrimary)
    }
  }

  /** Get the primary (drives playback/screenshots/info panel). */
  getPrimary(): MapRenderer | null {
    return this.viewports[this.primaryIndex]?.renderer ?? null
  }

  /** Get the renderer at a specific slot, or null if out of range. */
  getRendererAt(slot: number): MapRenderer | null {
    return this.viewports[slot]?.renderer ?? null
  }

  /** Get all current renderers in panel order. */
  getAll(): MapRenderer[] {
    return this.viewports.map(v => v.renderer)
  }

  /** Current layout. */
  getLayout(): ViewLayout {
    return this.layout
  }

  /** Current primary index. */
  getPrimaryIndex(): number {
    return this.primaryIndex
  }

  /** Number of active panels. */
  getPanelCount(): number {
    return this.viewports.length
  }

  /**
   * Mark a panel as primary. Updates the active-renderer singleton so
   * screenshot consumers pick up the change and fires `onPrimaryChange`
   * so callers can rewire bound UI.
   */
  promoteToPrimary(index: number): void {
    if (index < 0 || index >= this.viewports.length) {
      logger.warn(`[ViewportManager] promoteToPrimary: index ${index} out of range`)
      return
    }
    if (index === this.primaryIndex) return
    const previous = this.primaryIndex
    this.primaryIndex = index
    this.refreshActiveRenderer()
    this.refreshPrimaryStyling()
    this.callbacks.onPrimaryChange?.(this.primaryIndex, previous)
  }

  /** Resize all MapLibre instances — call after CSS grid changes. */
  resizeAll(): void {
    for (const vp of this.viewports) {
      vp.renderer.getMap()?.resize()
    }
  }

  /**
   * Mark a panel as outside the current temporal range (i.e. the
   * primary's real-world date doesn't overlap with this panel's
   * dataset). Adds `.out-of-range` to the panel container so CSS can
   * apply a visual indicator (dim overlay + label). Clears on
   * `isOutOfRange=false` or when the panel's renderer is destroyed.
   */
  setOutOfRange(slot: number, isOutOfRange: boolean): void {
    const vp = this.viewports[slot]
    if (!vp) return
    vp.container.classList.toggle('out-of-range', isOutOfRange)
  }

  /**
   * Mount, update, or clear the floating legend inside a panel.
   *
   * - `legendLink` non-null → render an <img> button showing the
   *   legend; clicking it invokes `onClick` so callers can open
   *   their full-size modal. The button is lazily created on first
   *   call and reused on subsequent calls.
   * - `legendLink` null → hide the legend element if it exists.
   *
   * The visible/hidden toggle is managed via a `.hidden` class so
   * the DOM + event listener persist across toggles — the caller
   * doesn't have to re-wire the click handler on every change.
   */
  setPanelLegend(
    slot: number,
    legendLink: string | null,
    options: { title?: string; onClick?: () => void } = {},
  ): void {
    const vp = this.viewports[slot]
    if (!vp) return

    if (!legendLink) {
      if (vp.legend) vp.legend.classList.add('hidden')
      return
    }

    if (!vp.legend) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'panel-legend'
      const img = document.createElement('img')
      img.alt = 'Dataset legend'
      btn.appendChild(img)
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const handler = (vp.legend as HTMLButtonElement & { _onClick?: () => void })._onClick
        handler?.()
      })
      vp.container.appendChild(btn)
      vp.legend = btn
    }

    const img = vp.legend.querySelector('img')
    if (img && img.src !== legendLink) {
      img.src = legendLink
    }
    if (options.title) {
      vp.legend.title = `${options.title} — tap to enlarge`
      vp.legend.setAttribute('aria-label', `${options.title} legend — tap to enlarge`)
    } else {
      vp.legend.title = 'Dataset legend — tap to enlarge'
      vp.legend.setAttribute('aria-label', 'Dataset legend — tap to enlarge')
    }
    // Stash the current click handler on the element so the single
    // stable click listener above can dispatch to the latest one.
    ;(vp.legend as HTMLButtonElement & { _onClick?: () => void })._onClick = options.onClick
    vp.legend.classList.remove('hidden')
  }

  /**
   * Show or hide a loading overlay on a specific panel. The overlay
   * is lazily created on first use and toggled via a `.hidden` class
   * thereafter. When `isLoading` is true, the panel shows a centered
   * spinner + optional message and the globe content dims behind it.
   * When false, the overlay is hidden and the panel is fully visible.
   */
  setPanelLoading(slot: number, isLoading: boolean, message?: string): void {
    const vp = this.viewports[slot]
    if (!vp) return

    let overlay = vp.container.querySelector('.panel-loading') as HTMLDivElement | null
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.className = 'panel-loading hidden'
      overlay.innerHTML = `
        <div class="panel-loading-spinner"></div>
        <span class="panel-loading-label">Loading\u2026</span>
      `
      vp.container.appendChild(overlay)
    }

    const label = overlay.querySelector('.panel-loading-label')
    if (label) label.textContent = message || 'Loading\u2026'

    overlay.classList.toggle('hidden', !isLoading)
  }

  /** Show/hide every panel's legend element without changing the
   *  underlying dataset binding. Used by the Legend toggle in Tools. */
  setAllLegendsVisible(visible: boolean): void {
    for (const vp of this.viewports) {
      if (!vp.legend) continue
      // Only show when the element has a loaded src — empty panels
      // shouldn't suddenly flash a legend frame.
      const img = vp.legend.querySelector('img') as HTMLImageElement | null
      const hasSrc = !!img?.src
      vp.legend.classList.toggle('hidden', !visible || !hasSrc)
    }
  }

  /** Dispose all viewports. */
  dispose(): void {
    for (const vp of this.viewports) {
      this.destroyViewport(vp)
    }
    this.viewports = []
    setActiveMapRenderer(null)
    this.grid = null
    this.callbacks = {}
  }

  // --- internals ---

  private applyGridTemplate(layout: ViewLayout): void {
    if (!this.grid) return
    this.grid.style.display = 'grid'
    // Explicit template with named areas so we can reliably assign
    // each panel to a grid cell via grid-area: a/b/c/d.
    this.grid.style.gridTemplate = GRID_TEMPLATE[layout]
    this.grid.setAttribute('data-layout', layout)
  }

  private addViewport(index: number): void {
    if (!this.grid) return

    const container = document.createElement('div')
    container.className = 'map-viewport'
    container.style.position = 'relative'
    container.style.width = '100%'
    container.style.height = '100%'
    container.style.background = '#000'
    container.style.overflow = 'hidden'
    container.setAttribute('data-viewport-index', String(index))
    // Assign to a named grid area — a/b/c/d in panel order.
    container.style.gridArea = String.fromCharCode('a'.charCodeAt(0) + index)
    this.grid.appendChild(container)

    const renderer = new MapRenderer()
    const canvasId = index === 0 ? 'globe-canvas' : `globe-canvas-${index}`
    renderer.init(container, { canvasId })

    // Primary-indicator pill: shown on every panel, numbered 1-based.
    // Click on a non-primary pill promotes that panel to primary. The
    // primary pill is styled as "active" and does nothing on click.
    // Hidden entirely when there's only one panel — no need for a
    // picker when there's nothing to pick.
    const indicator = document.createElement('button')
    indicator.type = 'button'
    indicator.className = 'viewport-indicator'
    indicator.textContent = String(index + 1)
    indicator.title = `Panel ${index + 1}`
    indicator.setAttribute('aria-label', `Switch to panel ${index + 1}`)
    indicator.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.promoteToPrimary(index)
    })
    container.appendChild(indicator)

    // If there's already a primary, copy its camera state so new panels
    // don't flash the default center before their first sync.
    const primary = this.viewports[this.primaryIndex]?.renderer.getMap()
    if (primary) {
      const map = renderer.getMap()
      if (map) {
        // Run after the new map's 'load' so the camera is definitely set
        map.once('load', () => {
          map.jumpTo({
            center: primary.getCenter(),
            zoom: primary.getZoom(),
            bearing: primary.getBearing(),
            pitch: primary.getPitch(),
          })
        })
      }
    }

    const onMove = () => this.syncCameras(index)
    renderer.getMap()?.on('move', onMove)

    this.viewports.push({ index, container, renderer, indicator, legend: null, onMove })
  }

  private destroyViewport(vp: Viewport): void {
    // Remove the move listener before disposing so dispose() doesn't
    // trigger a cascading sync while the renderer is being torn down.
    vp.renderer.getMap()?.off('move', vp.onMove)
    vp.renderer.dispose()
    vp.container.remove()
  }

  /**
   * Mirror the camera state from the source panel to every sibling.
   * Uses `jumpTo` (instantaneous) so siblings don't lag or animate,
   * and a re-entrancy guard so the mirrored `move` events don't
   * re-enter this function and recurse.
   */
  private syncCameras(sourceIdx: number): void {
    if (this.syncLock) return
    if (this.viewports.length <= 1) return

    const sourceMap = this.viewports[sourceIdx]?.renderer.getMap()
    if (!sourceMap) return

    const center = sourceMap.getCenter()
    const zoom = sourceMap.getZoom()
    const bearing = sourceMap.getBearing()
    const pitch = sourceMap.getPitch()

    this.syncLock = true
    try {
      for (let i = 0; i < this.viewports.length; i++) {
        if (i === sourceIdx) continue
        const siblingMap = this.viewports[i].renderer.getMap()
        if (!siblingMap) continue
        siblingMap.jumpTo({ center, zoom, bearing, pitch })
      }
    } finally {
      this.syncLock = false
    }
  }

  /** Update the module-level active-renderer slot to point at primary. */
  private refreshActiveRenderer(): void {
    const primary = this.viewports[this.primaryIndex]?.renderer ?? null
    setActiveMapRenderer(primary)
  }

  /**
   * Update `.is-primary` class + indicator state on every panel.
   * Hides the indicator entirely in single-viewport mode — there's
   * nothing to switch to.
   */
  private refreshPrimaryStyling(): void {
    const singleView = this.viewports.length <= 1
    for (const vp of this.viewports) {
      const isPrimary = vp.index === this.primaryIndex
      vp.container.classList.toggle('is-primary', isPrimary)
      vp.indicator.classList.toggle('is-primary', isPrimary)
      vp.indicator.setAttribute('aria-pressed', String(isPrimary))
      vp.indicator.style.display = singleView ? 'none' : ''
    }
  }
}
