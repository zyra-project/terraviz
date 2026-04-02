/**
 * Map Controls UI — floating toolbar for MapLibre overlay toggles.
 *
 * Provides direct buttons for labels, boundaries, terrain, and clearing
 * markers/highlights without needing the chat. Only shown when the
 * MapLibre renderer backend is active.
 */

import type { MapRenderer } from '../services/mapRenderer'

/** Show the map controls toolbar and wire events to the MapRenderer. */
export function initMapControls(renderer: MapRenderer): void {
  const container = document.getElementById('map-controls')
  if (!container) return

  // Build the buttons
  container.innerHTML = `
    <button class="map-ctrl-btn" id="map-ctrl-labels" title="Toggle geographic labels" aria-label="Toggle geographic labels" aria-pressed="false">Labels</button>
    <button class="map-ctrl-btn" id="map-ctrl-borders" title="Toggle country borders" aria-label="Toggle country borders" aria-pressed="false">Borders</button>
    <button class="map-ctrl-btn" id="map-ctrl-terrain" title="Toggle 3D terrain" aria-label="Toggle 3D terrain" aria-pressed="false">Terrain</button>
    <button class="map-ctrl-btn" id="map-ctrl-clear" title="Clear markers &amp; highlights" aria-label="Clear markers and highlights">Clear</button>
  `

  // Show the toolbar
  container.classList.remove('hidden')

  // Wire toggle buttons
  const labelsBtn = document.getElementById('map-ctrl-labels')!
  const bordersBtn = document.getElementById('map-ctrl-borders')!
  const terrainBtn = document.getElementById('map-ctrl-terrain')!
  const clearBtn = document.getElementById('map-ctrl-clear')!

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
