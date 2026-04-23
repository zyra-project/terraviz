/**
 * Tools Menu UI — single wrench-icon button plus a collapsible popover
 * that hosts every map-related toggle, the viewport layout picker,
 * the Clear action, and an entry point to Orbit settings.
 *
 * Replaces the previous horizontal `#map-controls` toolbar which was
 * growing past the bottom-right corner once the layout picker shipped,
 * and consolidates the previously standalone `#auto-rotate-standalone`
 * button and the Orbit settings entry point into one place.
 *
 * Layout:
 *
 *   [🧭 Browse]  [⚙️ Tools]      ← two small buttons, always visible
 *
 * When the Tools button is clicked, a popover slides in above it:
 *
 *   ┌─ Tools ─────────── ✕ ┐
 *   │ View                  │
 *   │  [ ] Labels           │
 *   │  [ ] Borders          │
 *   │  [ ] Terrain          │
 *   │  [ ] Auto-rotate      │
 *   │ Layout                │
 *   │  (1) (2↔) (2↕) (4)    │
 *   │ Actions               │
 *   │  [ Clear markers ]    │
 *   │ Orbit                 │
 *   │  [ Settings… ]        │
 *   └───────────────────────┘
 *
 * Toggle actions fan out across every viewport in the current
 * ViewportManager so overlay state stays synchronised across panels.
 * The Browse and Tools buttons sit on top of MapLibre, so they
 * receive clicks before the map. The popover uses `pointer-events:
 * auto` on itself and the map-grid remains the only thing under
 * `pointer-events: none` regions.
 */

import type { ViewportManager, ViewLayout } from '../services/viewportManager'
import { updateMapControlsPosition } from './mapControlsUI'
import { setBordersVisible } from '../utils/viewPreferences'

/**
 * Runtime Tauri-shell detection — matches the same `__TAURI__`
 * sentinel the rest of the code keys off of. Read fresh inside
 * initToolsMenu rather than cached at module load so tests can
 * toggle `window.__TAURI__` between cases.
 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__
}

/** Callbacks the tools menu fires out into the rest of the app. */
export interface ToolsMenuCallbacks {
  /** Multi-viewport: user picked a layout from the picker. */
  onSetLayout?: (layout: ViewLayout) => void
  /** User clicked Browse — open the dataset list. */
  onOpenBrowse?: () => void
  /** User clicked Orbit settings — open the chat settings dialog. */
  onOpenOrbitSettings?: () => void
  /** User toggled dataset info visibility. */
  onToggleDatasetInfo?: (visible: boolean) => void
  /** User toggled legend visibility. */
  onToggleLegend?: (visible: boolean) => void
  /** Announce something for screen readers. */
  announce?: (message: string) => void
  /** Get the currently loaded dataset (used by the Share action). */
  getCurrentDataset: () => { id: string; title: string } | null
}

/** Open/close state for the popover. Tracked here because DOM tests
 *  need a deterministic way to introspect it. */
let isOpen = false

/** Set up the tools menu inside `#map-controls`, replacing whatever
 *  is there. Idempotent — re-calling rebuilds the DOM so init can be
 *  driven from tests as well as the app boot path. */
export function initToolsMenu(
  viewports: ViewportManager,
  callbacks: ToolsMenuCallbacks = { getCurrentDataset: () => null },
): void {
  const container = document.getElementById('map-controls')
  if (!container) return

  // Reset open state whenever we rebuild — matters for tests that
  // call initToolsMenu multiple times and for main.ts init flows
  // that re-run on hot-reload. Without this the module-level flag
  // leaks between invocations.
  isOpen = false

  const gateMeetOrbit = isTauri()

  const { onSetLayout, onOpenBrowse, onOpenOrbitSettings, onToggleDatasetInfo, onToggleLegend, announce } = callbacks
  const currentLayout = viewports.getLayout()

  container.classList.remove('hidden')
  container.classList.add('tools-menu-host')
  container.innerHTML = `
    <button type="button" class="tools-menu-btn tools-menu-browse" id="tools-menu-browse" title="Browse datasets" aria-label="Browse datasets">
      <span class="tools-menu-btn-icon" aria-hidden="true">&#x1F5C2;&#xFE0E;</span>
      <span class="tools-menu-btn-label">Browse</span>
    </button>
    <button type="button" class="tools-menu-btn tools-menu-toggle" id="tools-menu-toggle" title="Tools and settings" aria-label="Tools and settings" aria-expanded="false" aria-haspopup="true">
      <span class="tools-menu-btn-icon" aria-hidden="true">&#x1F527;&#xFE0E;</span>
    </button>
    <div id="tools-menu-popover" class="tools-menu-popover hidden" role="dialog" aria-modal="false" aria-label="Tools and settings">
      <div class="tools-menu-popover-header">
        <span class="tools-menu-popover-title">Tools</span>
        <button type="button" class="tools-menu-close" id="tools-menu-close" aria-label="Close tools">&#x2715;</button>
      </div>
      <section class="tools-menu-section" aria-label="View toggles">
        <h4 class="tools-menu-section-title">View</h4>
        <button type="button" class="tools-menu-item" id="tools-menu-labels" aria-pressed="false">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">Labels</span>
        </button>
        <button type="button" class="tools-menu-item" id="tools-menu-borders" aria-pressed="false">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">Borders</span>
        </button>
        <button type="button" class="tools-menu-item" id="tools-menu-terrain" aria-pressed="false">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">3D terrain</span>
        </button>
        <button type="button" class="tools-menu-item" id="tools-menu-autorotate" aria-pressed="false">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">Auto-rotate</span>
        </button>
        <div class="tools-menu-subsep" aria-hidden="true"></div>
        <button type="button" class="tools-menu-item active" id="tools-menu-info" aria-pressed="true">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">Dataset info</span>
        </button>
        <button type="button" class="tools-menu-item active" id="tools-menu-legend" aria-pressed="true">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">Legend</span>
        </button>
      </section>
      <section class="tools-menu-section" aria-label="Layout">
        <h4 class="tools-menu-section-title">Layout</h4>
        <div class="tools-menu-layout-row" role="radiogroup" aria-label="Globe layout">
          <button type="button" class="tools-menu-layout-btn${currentLayout === '1' ? ' active' : ''}" id="tools-menu-layout-1" aria-pressed="${currentLayout === '1'}" title="Single globe">1</button>
          <button type="button" class="tools-menu-layout-btn${currentLayout === '2h' ? ' active' : ''}" id="tools-menu-layout-2h" aria-pressed="${currentLayout === '2h'}" title="Two globes side-by-side">2&#x2194;</button>
          <button type="button" class="tools-menu-layout-btn${currentLayout === '2v' ? ' active' : ''}" id="tools-menu-layout-2v" aria-pressed="${currentLayout === '2v'}" title="Two globes stacked">2&#x2195;</button>
          <button type="button" class="tools-menu-layout-btn${currentLayout === '4' ? ' active' : ''}" id="tools-menu-layout-4" aria-pressed="${currentLayout === '4'}" title="Four globes in a grid">4</button>
        </div>
      </section>
      <section class="tools-menu-section" aria-label="Actions">
        <h4 class="tools-menu-section-title">Actions</h4>
        <button type="button" class="tools-menu-item" id="tools-menu-clear">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">Clear markers &amp; highlights</span>
        </button>
        <button type="button" class="tools-menu-item" id="tools-menu-share">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">Share dataset&hellip;</span>
        </button>
      </section>
      <section class="tools-menu-section" aria-label="Orbit">
        <h4 class="tools-menu-section-title">Orbit</h4>
        <button type="button" class="tools-menu-item" id="tools-menu-orbit-settings">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">Orbit settings&hellip;</span>
        </button>
        ${gateMeetOrbit ? '' : `
        <a class="tools-menu-item tools-menu-item-link" id="tools-menu-meet-orbit" href="/orbit" target="_blank" rel="noopener">
          <span class="tools-menu-item-check" aria-hidden="true"></span>
          <span class="tools-menu-item-label">Meet Orbit&nbsp;&rarr;</span>
        </a>`}
      </section>
    </div>
  `

  const browseBtn = document.getElementById('tools-menu-browse') as HTMLButtonElement
  const toggleBtn = document.getElementById('tools-menu-toggle') as HTMLButtonElement
  const closeBtn = document.getElementById('tools-menu-close') as HTMLButtonElement

  browseBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    closePopover()
    onOpenBrowse?.()
  })

  toggleBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (isOpen) {
      closePopover()
    } else {
      openPopover()
    }
  })

  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    closePopover()
  })

  // Outside click closes the popover. We look up #map-controls
  // inside the handler rather than closing over the `container`
  // reference so re-init flows (tests, hot reload) don't leave
  // stale listeners pointing at detached DOM nodes.
  if (!document.body.dataset.toolsMenuListenersWired) {
    document.body.dataset.toolsMenuListenersWired = 'true'
    document.addEventListener('click', (ev) => {
      if (!isOpen) return
      const target = ev.target as Node | null
      if (!target) return
      const host = document.getElementById('map-controls')
      if (host && host.contains(target)) return
      closePopover()
    })
    // Escape closes the popover. Stop propagation so other handlers
    // (tour engine, chat) don't interpret the same keypress.
    document.addEventListener('keydown', (ev) => {
      if (!isOpen) return
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        closePopover()
        const toggle = document.getElementById('tools-menu-toggle') as HTMLButtonElement | null
        toggle?.focus()
      }
    })
    // Keep the Tools bar positioned above the playback transport
    // on window resize / orientation change.
    window.addEventListener('resize', updateMapControlsPosition)
  }

  // --- View toggles ---

  const labelsBtn = document.getElementById('tools-menu-labels') as HTMLButtonElement
  const bordersBtn = document.getElementById('tools-menu-borders') as HTMLButtonElement
  const terrainBtn = document.getElementById('tools-menu-terrain') as HTMLButtonElement
  const autoRotateBtn = document.getElementById('tools-menu-autorotate') as HTMLButtonElement
  const infoBtn = document.getElementById('tools-menu-info') as HTMLButtonElement
  const legendBtn = document.getElementById('tools-menu-legend') as HTMLButtonElement
  const clearBtn = document.getElementById('tools-menu-clear') as HTMLButtonElement
  const shareBtn = document.getElementById('tools-menu-share') as HTMLButtonElement
  const orbitSettingsBtn = document.getElementById('tools-menu-orbit-settings') as HTMLButtonElement
  const meetOrbitLink = document.getElementById('tools-menu-meet-orbit') as HTMLAnchorElement | null

  // Meet Orbit is a plain anchor with target="_blank" — native
  // navigation handles opening the character page. We just close
  // the popover so the main app goes back to its normal state and
  // announce for screen readers. No-op when Meet Orbit is gated off
  // (desktop build).
  meetOrbitLink?.addEventListener('click', () => {
    closePopover()
    announce?.('Opening Orbit character page in new tab')
  })

  labelsBtn.addEventListener('click', () => {
    // Target state is derived from the button class, not from any
    // renderer's reported state — newly-created siblings may still
    // be loading their style when the click fires. MapLibre queues
    // layer operations internally until the style is ready.
    const next = !labelsBtn.classList.contains('active')
    for (const r of viewports.getAll()) r.toggleLabels?.(next)
    setButtonState(labelsBtn, next)
    announce?.(next ? 'Labels on' : 'Labels off')
  })

  bordersBtn.addEventListener('click', () => {
    const next = !bordersBtn.classList.contains('active')
    for (const r of viewports.getAll()) r.toggleBoundaries?.(next)
    // Mirror to the shared preference so VR's per-frame poll picks
    // the same state up on its next frame. 2D-only sessions never
    // hit that getter, so the cost is just a localStorage write.
    setBordersVisible(next)
    setButtonState(bordersBtn, next)
    announce?.(next ? 'Borders on' : 'Borders off')
  })

  terrainBtn.addEventListener('click', () => {
    const next = !terrainBtn.classList.contains('active')
    for (const r of viewports.getAll()) {
      // toggleTerrain is not on the GlobeRenderer interface yet — cast
      // through the underlying MapRenderer which implements it.
      ;(r as unknown as { toggleTerrain?: (v: boolean) => void }).toggleTerrain?.(next)
    }
    setButtonState(terrainBtn, next)
    announce?.(next ? '3D terrain on' : '3D terrain off')
  })

  autoRotateBtn.addEventListener('click', () => {
    // Auto-rotate is primary-only — MapLibre's easeTo is per-map and
    // the camera sync mirrors the primary's motion to siblings, so
    // auto-rotating the primary automatically spins them all.
    const primary = viewports.getPrimary()
    if (!primary) return
    const next = primary.toggleAutoRotate()
    setButtonState(autoRotateBtn, next)
    announce?.(next ? 'Auto-rotation enabled' : 'Auto-rotation disabled')
  })

  infoBtn.addEventListener('click', () => {
    const next = !infoBtn.classList.contains('active')
    setButtonState(infoBtn, next)
    onToggleDatasetInfo?.(next)
    announce?.(next ? 'Dataset info shown' : 'Dataset info hidden')
  })

  legendBtn.addEventListener('click', () => {
    const next = !legendBtn.classList.contains('active')
    setButtonState(legendBtn, next)
    onToggleLegend?.(next)
    announce?.(next ? 'Legend shown' : 'Legend hidden')
  })

  clearBtn.addEventListener('click', () => {
    for (const r of viewports.getAll()) {
      r.clearMarkers?.()
      ;(r as unknown as { clearHighlights?: () => void }).clearHighlights?.()
    }
    announce?.('Markers and highlights cleared')
  })

  shareBtn.addEventListener('click', async () => {
    closePopover()
    const dataset = callbacks.getCurrentDataset?.()
    if (!dataset) {
      announce?.('No dataset loaded to share')
      return
    }
    const { shareDataset, buildDatasetShareUrl } = await import('../services/shareService')
    const shared = await shareDataset({
      title: dataset.title,
      text: `Check out "${dataset.title}" on Terraviz`,
      url: buildDatasetShareUrl(dataset.id),
    })
    if (shared) announce?.('Dataset shared')
  })

  orbitSettingsBtn.addEventListener('click', () => {
    closePopover()
    onOpenOrbitSettings?.()
  })

  // --- Layout picker (dev flag only) ---

  if (onSetLayout) {
    const layouts: ViewLayout[] = ['1', '2h', '2v', '4']
    const layoutBtns = new Map<ViewLayout, HTMLButtonElement>()
    for (const l of layouts) {
      const btn = document.getElementById(`tools-menu-layout-${l}`) as HTMLButtonElement | null
      if (btn) layoutBtns.set(l, btn)
    }
    for (const [layout, btn] of layoutBtns) {
      btn.addEventListener('click', () => {
        onSetLayout(layout)
        for (const [l, b] of layoutBtns) {
          const active = l === layout
          b.classList.toggle('active', active)
          b.setAttribute('aria-pressed', String(active))
        }
        announce?.(`Layout: ${layoutLabel(layout)}`)
      })
    }
  }

}

/** Open the popover and focus its close button for keyboard users. */
function openPopover(): void {
  const popover = document.getElementById('tools-menu-popover')
  const toggle = document.getElementById('tools-menu-toggle')
  if (!popover || !toggle) return
  popover.classList.remove('hidden')
  toggle.setAttribute('aria-expanded', 'true')
  isOpen = true
  const close = document.getElementById('tools-menu-close') as HTMLButtonElement | null
  close?.focus()
}

/** Close the popover. */
function closePopover(): void {
  const popover = document.getElementById('tools-menu-popover')
  const toggle = document.getElementById('tools-menu-toggle')
  if (!popover || !toggle) return
  popover.classList.add('hidden')
  toggle.setAttribute('aria-expanded', 'false')
  isOpen = false
}

/** Whether the popover is currently open — used by tests. */
export function isToolsMenuOpen(): boolean {
  return isOpen
}

/**
 * Briefly pulse the Browse button to draw the user's attention.
 * Called by main.ts after init on mobile (where the browse panel
 * starts closed so the globe is visible) so first-time users notice
 * where datasets live.
 *
 * The animation is a gentle halo that radiates outward for ~1.2s
 * per cycle and runs two cycles total. Tapping the button cancels
 * the animation immediately so the pulse doesn't keep drawing
 * attention after the user has already engaged. Respects
 * `prefers-reduced-motion` — users who've opted out see no
 * animation, just the button in its normal state.
 */
export function pulseBrowseButton(): void {
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return
  }
  const btn = document.getElementById('tools-menu-browse')
  if (!btn) return
  btn.classList.add('pulse-attention')
  const clearPulse = () => {
    btn.classList.remove('pulse-attention')
    btn.removeEventListener('click', clearPulse)
  }
  // Clear when the animation finishes naturally (2 cycles × 1.2s)
  window.setTimeout(clearPulse, 2600)
  // Or immediately if the user taps the button before it finishes
  btn.addEventListener('click', clearPulse, { once: true })
}

/** Sync a toggle button's `.active` class + aria-pressed to a bool. */
function setButtonState(btn: HTMLElement, active: boolean): void {
  btn.classList.toggle('active', active)
  btn.setAttribute('aria-pressed', String(active))
}

/**
 * Sync the toolbar button states to explicit values. Called by
 * main.ts after tours, goHome, layout changes, or when loading
 * persisted view preferences so the toolbar reflects the actual
 * renderer + preferences state.
 */
export function syncToolsMenuState(state: {
  labels?: boolean
  borders?: boolean
  terrain?: boolean
  autoRotate?: boolean
  datasetInfo?: boolean
  legend?: boolean
}): void {
  if (state.labels !== undefined) {
    const btn = document.getElementById('tools-menu-labels')
    if (btn) setButtonState(btn, state.labels)
  }
  if (state.borders !== undefined) {
    const btn = document.getElementById('tools-menu-borders')
    if (btn) setButtonState(btn, state.borders)
  }
  if (state.terrain !== undefined) {
    const btn = document.getElementById('tools-menu-terrain')
    if (btn) setButtonState(btn, state.terrain)
  }
  if (state.autoRotate !== undefined) {
    const btn = document.getElementById('tools-menu-autorotate')
    if (btn) setButtonState(btn, state.autoRotate)
  }
  if (state.datasetInfo !== undefined) {
    const btn = document.getElementById('tools-menu-info')
    if (btn) setButtonState(btn, state.datasetInfo)
  }
  if (state.legend !== undefined) {
    const btn = document.getElementById('tools-menu-legend')
    if (btn) setButtonState(btn, state.legend)
  }
}

/**
 * Sync the layout picker buttons to the given layout. Called by
 * main.ts when a layout change comes from a non-UI path (tours,
 * URL init, `setEnvView` API) so the picker buttons stay in sync.
 */
export function syncToolsMenuLayout(layout: ViewLayout): void {
  const layouts: ViewLayout[] = ['1', '2h', '2v', '4']
  for (const l of layouts) {
    const btn = document.getElementById(`tools-menu-layout-${l}`)
    if (btn) {
      const active = l === layout
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', String(active))
    }
  }
}

/** Human-readable label for a layout value, used in announcements. */
function layoutLabel(layout: ViewLayout): string {
  switch (layout) {
    case '1': return 'Single globe'
    case '2h': return 'Two globes side-by-side'
    case '2v': return 'Two globes stacked'
    case '4': return 'Four globes'
  }
}
