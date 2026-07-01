/**
 * A lightweight MapLibre **locator** for the Events detail pane
 * (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md` §7). It
 * renders a small non-interactive mercator map centred on the event,
 * with one accent marker — NOT the full globe `MapRenderer` (too heavy
 * for a 140px card). MapLibre's JS is **lazy-imported** so the publisher
 * chunk only pays for it when a curator actually opens an event with a
 * placeable geometry.
 *
 * Web-only: the portal lives behind Cloudflare Access on the Pages
 * deployment, which proxies `/api/tile/...` (the same GIBS Blue Marble
 * source the catalog map uses) — so no Tauri `tauritile://` path here.
 */

import type { StyleSpecification } from 'maplibre-gl'

/** GIBS Blue Marble raster — the same source `mapRenderer.ts` uses,
 *  via the deployment's `/api/tile` proxy. */
const BLUE_MARBLE_TILE =
  '/api/tile/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg'

const LOCATOR_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    'blue-marble': { type: 'raster', tiles: [BLUE_MARBLE_TILE], tileSize: 256, maxzoom: 8 },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0d0d12' } },
    { id: 'blue-marble', type: 'raster', source: 'blue-marble' },
  ],
}

/** Zoom for the locator — continental context around the marker. */
const LOCATOR_ZOOM = 2.6

/**
 * Mount a locator into `slot` centred on `point`. Returns a disposer
 * that removes the map (freeing its WebGL context) — the caller MUST
 * call it before discarding the slot, or when swapping the detail to
 * another event, so locators don't leak GL contexts across selections.
 * The map loads asynchronously (lazy MapLibre import); disposing before
 * it resolves cancels the mount.
 */
export function mountEventLocator(slot: HTMLElement, point: { lat: number; lon: number }): () => void {
  let disposed = false
  let remove: (() => void) | null = null

  // Lazy-import the JS *and* the stylesheet together (Vite injects the
  // CSS on dynamic import), so neither lands in the eager publisher chunk
  // even though this module is imported eagerly by events.ts.
  void Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl.css')])
    .then(([{ default: maplibregl }]) => {
      if (disposed) return
      const canvas = document.createElement('div')
      canvas.className = 'publisher-events-locator-canvas'
      // Insert behind the coordinates label (the slot's existing child).
      slot.insertBefore(canvas, slot.firstChild)

      const map = new maplibregl.Map({
        container: canvas,
        style: LOCATOR_STYLE,
        center: [point.lon, point.lat],
        zoom: LOCATOR_ZOOM,
        interactive: false,
        attributionControl: false,
      })
      const markerEl = document.createElement('div')
      markerEl.className = 'publisher-events-locator-marker'
      new maplibregl.Marker({ element: markerEl }).setLngLat([point.lon, point.lat]).addTo(map)

      remove = () => {
        map.remove()
        canvas.remove()
      }
    })
    .catch(() => {
      // Locator is decorative — a failed map load leaves the coordinates
      // text in place; never block the detail pane on it.
    })

  return () => {
    disposed = true
    remove?.()
    remove = null
  }
}
