/**
 * Map Controls UI — floating toolbar for MapLibre overlay toggles.
 *
 * Provides direct buttons for labels, boundaries, terrain, clearing
 * markers/highlights, and a Browse button that opens the dataset
 * list overlay. When the `?setview=` dev flag is present, also
 * renders a layout picker (1/2h/2v/4) for multi-viewport testing.
 */

import type { MapRenderer } from '../services/mapRenderer'
import type { ViewLayout } from '../services/viewportManager'

/** Options passed from the app shell to wire additional callbacks. */
export interface MapControlsCallbacks {
  /** Multi-viewport: user picked a layout from the picker. */
  onSetLayout?: (layout: ViewLayout) => void
  /** User clicked Browse — open the dataset list. */
  onOpenBrowse?: () => void
}

/** Show the map controls toolbar and wire events to the MapRenderer.
 *  Idempotent — safe to call multiple times (skips if already initialized). */
export function initMapControls(
  renderer: MapRenderer,
  callbacks: MapControlsCallbacks = {},
): void {
  const { onSetLayout, onOpenBrowse } = callbacks
  const container = document.getElementById('map-controls')
  if (!container || container.dataset.initialized) return
  container.dataset.initialized = 'true'

  // The layout picker is a dev-only affordance until multi-viewport
  // has real per-panel datasets. Show it when the URL carries
  // `?setview=1` (or any non-empty setview value).
  const setViewDev = new URLSearchParams(window.location.search).has('setview')

  // Build the buttons
  const layoutPickerHtml = setViewDev
    ? `
    <span class="map-ctrl-sep" aria-hidden="true"></span>
    <button type="button" class="map-ctrl-btn map-ctrl-layout active" id="map-ctrl-layout-1" title="Single globe" aria-label="Single globe" aria-pressed="true">1</button>
    <button type="button" class="map-ctrl-btn map-ctrl-layout" id="map-ctrl-layout-2h" title="Two globes side-by-side" aria-label="Two globes side-by-side" aria-pressed="false">2&#x2194;</button>
    <button type="button" class="map-ctrl-btn map-ctrl-layout" id="map-ctrl-layout-2v" title="Two globes stacked" aria-label="Two globes stacked" aria-pressed="false">2&#x2195;</button>
    <button type="button" class="map-ctrl-btn map-ctrl-layout" id="map-ctrl-layout-4" title="Four globes in a grid" aria-label="Four globes in a grid" aria-pressed="false">4</button>
  `
    : ''

  // Browse button is always rendered so the dataset list is
  // discoverable even after the browse panel has been dismissed.
  // In single-view mode it's a convenience; in multi-view it's
  // essential — the peek-out toggle tab on the browse panel was
  // hard to find and sometimes sat off-screen depending on the
  // viewport width. This button is the durable affordance.
  container.innerHTML = `
    <button type="button" class="map-ctrl-btn" id="map-ctrl-browse" title="Browse datasets" aria-label="Browse datasets">Browse</button>
    <button type="button" class="map-ctrl-btn" id="map-ctrl-labels" title="Toggle geographic labels" aria-label="Toggle geographic labels" aria-pressed="false">Labels</button>
    <button type="button" class="map-ctrl-btn" id="map-ctrl-borders" title="Toggle country borders" aria-label="Toggle country borders" aria-pressed="false">Borders</button>
    <button type="button" class="map-ctrl-btn" id="map-ctrl-terrain" title="Toggle 3D terrain" aria-label="Toggle 3D terrain" aria-pressed="false">Terrain</button>
    <button type="button" class="map-ctrl-btn" id="map-ctrl-clear" title="Clear markers &amp; highlights" aria-label="Clear markers and highlights">Clear</button>
    ${layoutPickerHtml}
  `

  // Show the toolbar
  container.classList.remove('hidden')

  // Wire toggle buttons
  const browseBtn = document.getElementById('map-ctrl-browse')!
  const labelsBtn = document.getElementById('map-ctrl-labels')!
  const bordersBtn = document.getElementById('map-ctrl-borders')!
  const terrainBtn = document.getElementById('map-ctrl-terrain')!
  const clearBtn = document.getElementById('map-ctrl-clear')!

  browseBtn.addEventListener('click', () => {
    onOpenBrowse?.()
  })

  // Wire layout picker (only when dev flag is set)
  if (setViewDev && onSetLayout) {
    const layouts: ViewLayout[] = ['1', '2h', '2v', '4']
    const layoutBtns = new Map<ViewLayout, HTMLButtonElement>()
    for (const l of layouts) {
      const btn = document.getElementById(`map-ctrl-layout-${l}`) as HTMLButtonElement | null
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
      })
    }
  }

  labelsBtn.addEventListener('click', () => {
    const shown = renderer.toggleLabels()
    labelsBtn.classList.toggle('active', shown)
    labelsBtn.setAttribute('aria-pressed', String(shown))
  })

  bordersBtn.addEventListener('click', () => {
    const shown = renderer.toggleBoundaries()
    bordersBtn.classList.toggle('active', shown)
    bordersBtn.setAttribute('aria-pressed', String(shown))
  })

  terrainBtn.addEventListener('click', () => {
    const enabled = renderer.toggleTerrain()
    terrainBtn.classList.toggle('active', enabled)
    terrainBtn.setAttribute('aria-pressed', String(enabled))
  })

  clearBtn.addEventListener('click', () => {
    renderer.clearMarkers()
    renderer.clearHighlights()
  })

  // Re-position on window resize in case playback controls change height
  const onResize = () => updateMapControlsPosition()
  window.addEventListener('resize', onResize)
}

/**
 * Sync map control button states to match the actual renderer state.
 * Call this after tours or goHome change labels/borders/terrain
 * without going through the UI buttons.
 */
export function syncMapControlState(labels: boolean, borders: boolean): void {
  const labelsBtn = document.getElementById('map-ctrl-labels')
  const bordersBtn = document.getElementById('map-ctrl-borders')
  if (labelsBtn) {
    labelsBtn.classList.toggle('active', labels)
    labelsBtn.setAttribute('aria-pressed', String(labels))
  }
  if (bordersBtn) {
    bordersBtn.classList.toggle('active', borders)
    bordersBtn.setAttribute('aria-pressed', String(borders))
  }
}

/**
 * Update the position of the map controls to sit above the playback controls
 * or auto-rotate button, whichever is visible.
 */
export function updateMapControlsPosition(): void {
  const mapControls = document.getElementById('map-controls')
  if (!mapControls || mapControls.classList.contains('hidden')) return

  const playback = document.getElementById('playback-controls')
  const standalone = document.getElementById('auto-rotate-standalone')

  // Calculate offset: sit above whichever bottom-right element is visible
  if (playback && !playback.classList.contains('hidden')) {
    const height = playback.offsetHeight
    mapControls.style.bottom = `${height + 16}px`
  } else if (standalone && !standalone.classList.contains('hidden')) {
    mapControls.style.bottom = '3.2rem'
  } else {
    mapControls.style.bottom = '0.75rem'
  }
}
