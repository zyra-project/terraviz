/**
 * MapLibre GL JS globe renderer.
 *
 * Wraps MapLibre with globe projection, NASA GIBS Blue Marble + Black Marble
 * raster tile sources, day/night custom layer, and vector labels/boundaries.
 */

import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

import type { Map as MaplibreMap, StyleSpecification, CustomLayerInterface } from 'maplibre-gl'
import { createEarthTileLayer, computeSunLightPosition, type EarthTileLayerControl } from './earthTileLayer'
import { isEarthBody } from './datasetOverlayOptions'
import type {
  Dataset,
  DatasetOverlayOptions,
  GlobeRenderer,
  MapViewContext,
  VideoTextureHandle,
} from '../types'
import { setDatasetCreditsSource } from '../ui/creditsPanel'
import { getSharedLumaSampler, type LumaSnapshot } from './glLumaSampler'
import { DEFAULT_DISPLAY, type ColorScaleDisplay } from './colorScaleDisplay'
import { contourSetToGeoJson, type ContourLevel } from './datasetContours'
import { boundsRing, greatCirclePath, type TransectEndpoints } from './datasetStats'
import type { ColorScale } from '../types/color-scale'
import {
  probeDatasetValue,
  type ProbeReading,
  type ProbeSource,
} from './datasetProbe'
import { getSunPosition } from '../utils/time'
import { logger } from '../utils/logger'
import { isMobile } from '../utils/deviceCapability'
import { preloadLowZoomTiles } from './tilePreloader'
import { emitCameraSettled, emit, reportError } from '../analytics'

/** Screen-space slack, in CSS pixels, for the "is the pointer on the
 *  sphere?" round-trip test. Generous enough to survive projection
 *  rounding at the limb, tight enough to exclude the empty corners. */
const ON_GLOBE_TOLERANCE_PX = 2

// --- Tauri desktop: route tiles through Rust cache via IPC ---
const IS_TAURI = !!(window as any).__TAURI__

// Lazy-load the public invoke API instead of using __TAURI_INTERNALS__
const tauriInvokeReady: Promise<((cmd: string, args: Record<string, unknown>) => Promise<unknown>) | null> = IS_TAURI
  ? import('@tauri-apps/api/core').then(m => m.invoke as (cmd: string, args: Record<string, unknown>) => Promise<unknown>)
    .catch(() => null)
  : Promise.resolve(null)

/** On web, returns the template unchanged. On Tauri, swaps to tauritile:// protocol. */
function getTileUrls(template: string): string[] {
  if (IS_TAURI) {
    return [template.replace('/api/tile/', 'tauritile://')]
  }
  return [template]
}

if (IS_TAURI) {
  // Register the protocol immediately — the invoke function is resolved
  // lazily inside the handler (tiles aren't requested until the map loads).
  maplibregl.addProtocol('tauritile', async (params: { url: string }) => {
    const invoke = await tauriInvokeReady
    if (!invoke) throw new Error('Tauri invoke not available')
    const tilePath = params.url.replace('tauritile://', '')
    try {
      const b64: string = await invoke('get_tile', { tilePath }) as string
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return { data: bytes.buffer }
    } catch (err) {
      logger.warn('[Tiles] IPC error for', tilePath, err)
      reportError('tile', err)
      throw err
    }
  })
  logger.info('[Tiles] Registered tauritile:// protocol for Rust tile cache')
}

// --- GIBS tile endpoints ---
const BLUE_MARBLE_TILES = getTileUrls(
  '/api/tile/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg'
)
const BLACK_MARBLE_TILES = getTileUrls(
  '/api/tile/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'
)
const GIBS_MAX_ZOOM = 8

// --- Default camera ---
const DEFAULT_CENTER: [number, number] = [-95, 38]
const DEFAULT_ZOOM = 2.3
// Zoom limits: ~0.5 shows the full globe, ~8 is the max detail for GIBS tiles
const MIN_ZOOM = 0.5
const MAX_ZOOM = 8
// Approximate conversion: Three.js camera.z [1.15, 3.6] → MapLibre zoom [8, 0.5]
// altitude (km) → zoom: Earth radius ≈ 6371 km, each zoom level halves the view
const EARTH_RADIUS_KM = 6371

// --- OpenFreeMap vector tile endpoints (OpenMapTiles schema) ---
const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf'

// --- Terrain DEM tile source ---
const TERRAIN_DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

/**
 * MapLibre projection used by the renderer. The main globe stays on
 * `'globe'` (the default and historical behaviour); the catalog
 * Map view (§6.9) opts into `'mercator'` for a flat world map. Both
 * share the same GIBS raster sources so no new tile fetches are
 * introduced when the second renderer mounts. */
export type MapRendererProjection = 'globe' | 'mercator'

/**
 * Style factory. The base style is shared between the two projections;
 * only the `projection.type` differs. Keeping a single factory avoids
 * drift between the day/night layer ordering, the GIBS attribution,
 * and the sky / light defaults across the two surfaces.
 *
 * @param projection — `'globe'` for the main 3D globe, `'mercator'`
 *  for the §6.9 catalog Map view. Defaults to `'globe'` for
 *  backwards-compatible call sites.
 */
function createGlobeStyle(projection: MapRendererProjection = 'globe'): StyleSpecification {
  const initSun = getSunPosition(new Date())
  return {
    version: 8,
    name: 'sos-globe',
    projection: { type: projection },
    glyphs: GLYPHS_URL,
    sources: {
      'blue-marble': {
        type: 'raster',
        tiles: BLUE_MARBLE_TILES,
        tileSize: 256,
        maxzoom: GIBS_MAX_ZOOM,
        attribution: 'NASA Blue Marble',
      },
      'black-marble': {
        type: 'raster',
        tiles: BLACK_MARBLE_TILES,
        tileSize: 256,
        maxzoom: GIBS_MAX_ZOOM,
        attribution: 'NASA Black Marble',
      },
      'openmaptiles': {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution: '© OpenMapTiles © OpenStreetMap',
      },
      'terrain-dem': {
        type: 'raster-dem',
        tiles: [TERRAIN_DEM_URL],
        tileSize: 256,
        maxzoom: 14,
        encoding: 'terrarium',
        attribution: 'Mapzen Terrain',
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#000000', 'background-opacity': 0 },
      },
      {
        id: 'black-marble-layer',
        type: 'raster',
        source: 'black-marble',
        paint: { 'raster-opacity': 1 },
      },
      {
        id: 'blue-marble-layer',
        type: 'raster',
        source: 'blue-marble',
        paint: { 'raster-opacity': 1 },
      },
      // --- Vector layers (hidden by default, toggle-able) ---
      {
        id: 'coastline-halo',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'water',
        filter: ['==', 'class', 'ocean'],
        layout: { visibility: 'none' },
        paint: {
          'line-color': 'rgba(0, 0, 0, 0.5)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 2, 5, 4, 8, 5],
        },
      },
      {
        id: 'coastline',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'water',
        filter: ['==', 'class', 'ocean'],
        layout: { visibility: 'none' },
        paint: {
          'line-color': 'rgba(255, 255, 255, 0.7)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 5, 1.5, 8, 2],
        },
      },
      {
        id: 'boundaries-halo',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'boundary',
        filter: ['all', ['==', 'admin_level', 2], ['!=', 'maritime', 1]],
        layout: { visibility: 'none' },
        paint: {
          'line-color': 'rgba(0, 0, 0, 0.6)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 2.5, 5, 5, 8, 6],
        },
      },
      {
        id: 'boundaries',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'boundary',
        filter: ['all', ['==', 'admin_level', 2], ['!=', 'maritime', 1]],
        layout: { visibility: 'none' },
        paint: {
          'line-color': 'rgba(255, 255, 255, 0.85)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.8, 5, 2, 8, 3],
        },
      },
      {
        id: 'country-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        filter: ['==', 'class', 'country'],
        layout: {
          visibility: 'none',
          'text-field': '{name:latin}',
          'text-font': ['Open Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 5, 16, 8, 20],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.1,
          'text-max-width': 8,
          'text-pitch-alignment': 'map',
          'text-rotation-alignment': 'map',
        },
        paint: {
          'text-color': 'rgba(255, 255, 255, 0.85)',
          'text-halo-color': 'rgba(0, 0, 0, 0.7)',
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'city-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        filter: ['all', ['==', 'class', 'city'], ['>=', 'rank', 1], ['<=', 'rank', 6]],
        layout: {
          visibility: 'none',
          'text-field': '{name:latin}',
          'text-font': ['Open Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 9, 6, 13, 8, 16],
          'text-max-width': 8,
          'text-pitch-alignment': 'map',
          'text-rotation-alignment': 'map',
        },
        paint: {
          'text-color': 'rgba(220, 220, 255, 0.8)',
          'text-halo-color': 'rgba(0, 0, 0, 0.6)',
          'text-halo-width': 1,
        },
      },
      {
        id: 'ocean-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'water_name',
        filter: ['==', '$type', 'Point'],
        layout: {
          visibility: 'none',
          'text-field': '{name:latin}',
          'text-font': ['Open Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 5, 14],
          'text-letter-spacing': 0.2,
          'text-max-width': 10,
          'text-pitch-alignment': 'map',
          'text-rotation-alignment': 'map',
        },
        paint: {
          'text-color': 'rgba(150, 200, 255, 0.6)',
          'text-halo-color': 'rgba(0, 0, 0, 0.5)',
          'text-halo-width': 1,
        },
      },
    ],
    sky: {
      'atmosphere-blend': [
        'interpolate',
        ['linear'],
        ['zoom'],
        0, 1,
        5, 1,
        7, 0,
      ],
    },
    // Initialize light to current sun position so there's no flash of
    // incorrect lighting before the earth tile layer's onAdd fires.
    light: {
      anchor: 'map',
      position: computeSunLightPosition(initSun.lat, initSun.lng),
    },
  }
}

/**
 * Module-level reference to the "active" (primary) MapRenderer instance.
 *
 * In single-viewport mode this is the only renderer. In multi-viewport mode
 * (ViewportManager) this points at whichever panel is currently primary.
 * ViewportManager is responsible for calling setActiveMapRenderer() whenever
 * the primary changes.
 *
 * Used by screenshotService so screenshot consumers (vision flow, feedback
 * form) can drive a proper triggerRepaint + once('render') cycle rather than
 * fighting the WebGL drawing-buffer preservation quirks on their own.
 */
let activeRenderer: MapRenderer | null = null

/** Get the currently active (primary) MapRenderer, if any. */
export function getActiveMapRenderer(): MapRenderer | null {
  return activeRenderer
}

/** Set the active (primary) MapRenderer. Called by ViewportManager. */
export function setActiveMapRenderer(renderer: MapRenderer | null): void {
  activeRenderer = renderer
}

/** Max dimension for a captured screenshot — keeps payload small. */
const SCREENSHOT_MAX_SIZE = 512

/** MapLibre-based globe renderer. */
export class MapRenderer implements GlobeRenderer {
  private map: MaplibreMap | null = null
  /** Detaches the lat/lng pointer handlers, so a second
   *  `setLatLngCallbacks` replaces rather than stacks them. */
  private latLngUnsubscribe: (() => void) | null = null
  /** The currently displayed dataset frame source, kept so the hover
   *  probe can read one texel out of it. */
  /** Viewing state for data-encoded datasets, re-applied whenever the
   *  earth layer is (re)created so a display chosen before the first
   *  dataset loaded is not lost. */
  private colorScaleDisplay: ColorScaleDisplay = DEFAULT_DISPLAY
  private probeSource: ProbeSource | null = null
  private probeOptions: DatasetOverlayOptions | null = null
  /** 1x1 scratch canvas the probe draws into. Created once; a fresh
   *  canvas per pointer event would allocate on every mouse move. */
  private container: HTMLElement | null = null
  private canvasId: string = 'globe-canvas'
  /** Projection requested at init time. Stays `'globe'` for the
   *  main app; the catalog Map view (§6.9) opts into `'mercator'`.
   *  Reported via `getProjection()` so analytics / debug surfaces
   *  can distinguish the two MapRenderer instances when both are
   *  mounted in the same session. */
  private projection: MapRendererProjection = 'globe'
  private autoRotateInterval: number | null = null
  private autoRotating = false
  private rotationRate = 1.0 // 1.0 = default (30° per 10s)
  private earthLayer: EarthTileLayerControl | null = null
  private pendingTexture: HTMLCanvasElement | HTMLImageElement | null = null
  private pendingVideo: HTMLVideoElement | null = null
  /** Phase 3e: dataset overlay options buffered alongside the pending
   * texture/video so the eventual setDatasetTexture / setDatasetVideo
   * call gets the same per-dataset hints (bbox / lonOrigin /
   * isFlippedInY / celestialBody) the caller passed at request time. */
  private pendingDatasetOptions: DatasetOverlayOptions | null = null
  /** 0-based slot index for this renderer within its ViewportManager.
   * Reported on `camera_settled` / `map_click` so downstream queries
   * can separate primary vs secondary-panel activity. Defaults to 0
   * for single-viewport flows. */
  private slotIndex: number = 0
  /** Telemetry-only — returns the dataset id currently loaded in
   * this renderer's slot. Forwarded into `camera_settled` so
   * dashboards can split spatial-attention heatmaps by dataset
   * without a session-scoped join. Null when no dataset is loaded
   * (panel shows the default Earth). Caller-provided so MapRenderer
   * doesn't need to know about main.ts's panel-state model. */
  private getLayerId: (() => string | null) | null = null

  /**
   * Initialize the MapLibre map inside the given container element.
   * The container element is used directly as MapLibre's parent — the
   * caller is responsible for sizing and placing it in the DOM tree.
   *
   * In single-viewport mode (`main.ts`) the container is typically a
   * dedicated `<div class="map-viewport">` inside `#map-grid`. In
   * multi-viewport mode ViewportManager creates one such div per
   * panel. MapRenderer no longer creates its own wrapper.
   *
   * @param options.canvasId ID to set on the WebGL canvas element.
   * Defaults to `'globe-canvas'` for single-viewport backward compat;
   * ViewportManager passes unique IDs per panel to avoid DOM collisions.
   */
  init(
    container: HTMLElement,
    options?: {
      canvasId?: string
      slotIndex?: number
      getLayerId?: () => string | null
      /** MapLibre projection. Defaults to `'globe'` for the main
       *  3D globe; the §6.9 catalog Map view passes `'mercator'`
       *  for a flat world map. */
      projection?: MapRendererProjection
    },
  ): void {
    this.container = container
    this.canvasId = options?.canvasId ?? 'globe-canvas'
    this.slotIndex = options?.slotIndex ?? 0
    this.getLayerId = options?.getLayerId ?? null
    this.projection = options?.projection ?? 'globe'

    // Inject dark popup styles (idempotent — skips if already present)
    if (!document.getElementById('sos-popup-style')) {
      const style = document.createElement('style')
      style.id = 'sos-popup-style'
      style.textContent = `
        .sos-popup .maplibregl-popup-content {
          background: rgba(13,13,18,0.92);
          backdrop-filter: blur(12px);
          padding: 0;
          border-radius: 6px;
          box-shadow: 0 2px 12px rgba(0,0,0,0.5);
        }
        .sos-popup .maplibregl-popup-tip {
          border-top-color: rgba(13,13,18,0.92);
        }
        .sos-popup .maplibregl-popup-close-button {
          color: #aaa;
          font-size: 16px;
          padding: 2px 6px;
        }
      `
      document.head.appendChild(style)
    }

    this.map = new maplibregl.Map({
      container,
      style: createGlobeStyle(this.projection),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      // Stock attribution control disabled — Tools → Credits is
      // now the canonical surface for both basemap and dataset
      // attributions, sourced from `map.getStyle().sources[…].attribution`.
      // See src/ui/creditsPanel.ts for the design.
      attributionControl: false,
      preserveDrawingBuffer: true, // needed for captureViewContext / toDataURL
      maxPitch: 85,
      maxTileCacheSize: isMobile() ? 750 : 2000,
    } as maplibregl.MapOptions)

    // Double-click/double-tap resets to default view instead of zoom in
    this.map.doubleClickZoom.disable()
    const resetView = () => {
      this.map?.flyTo({
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        bearing: 0,
        pitch: 0,
        duration: 2000,
      })
    }
    this.map.on('dblclick', resetView)

    // Emit `camera_settled` after every user-driven move ends.
    // MapLibre fires `moveend` on every drag release, wheel stop,
    // and `flyTo` completion — good enough for "user parked the
    // camera here". The shared throttle in analytics/camera.ts
    // caps the emit rate to ≤ 30/min per session across 2D + VR.
    this.map.on('moveend', () => {
      if (!this.map) return
      // Skip moves driven by auto-rotate: it sweeps the centre
      // longitude on a timer (`easeTo` every 10s), and each ease
      // completion is a `moveend`. Those are globe spin, not
      // attention — emitting them paints a spurious latitude-wide
      // band of bins across the spatial heatmap. User interaction
      // clears `autoRotating` (mousedown/touchstart) before any
      // real move, so genuine settles still emit.
      if (this.autoRotating) return
      const center = this.map.getCenter()
      emitCameraSettled({
        slot_index: String(this.slotIndex),
        projection: this.projection,
        center_lat: center.lat,
        center_lon: center.lng,
        zoom: this.map.getZoom(),
        bearing: this.map.getBearing(),
        pitch: this.map.getPitch(),
        layer_id: this.getLayerId?.() ?? '',
      })
    })

    // Emit `map_click` on every single-click (not double-click,
    // which resets the view). Classification for now is simply
    // "surface" — marker / region hit-tests land in later commits
    // once dataset overlays expose layer ids.
    this.map.on('click', (e) => {
      // Query rendered features at the click point. The global
      // `click` event doesn't attach a features array — pull it
      // via queryRenderedFeatures. MapLibre returns layer-ordered
      // hits; the top-most is the visible one.
      const features = this.map?.queryRenderedFeatures(e.point) ?? []
      const top = features[0]
      const hitKind: 'surface' | 'marker' | 'feature' | 'region' = top ? 'feature' : 'surface'
      emit({
        event_type: 'map_click',
        slot_index: String(this.slotIndex),
        hit_kind: hitKind,
        hit_id: top?.id != null ? String(top.id) : '',
        lat: Math.round(e.lngLat.lat * 1000) / 1000,
        lon: Math.round(e.lngLat.lng * 1000) / 1000,
        zoom: Math.round(this.map!.getZoom() * 100) / 100,
      })
    })

    // Double-tap detection for touch (dblclick doesn't fire on touch devices)
    let lastTap = 0
    this.map.on('touchend', (e) => {
      // Only single-finger taps count as double-tap
      if (e.originalEvent.touches.length > 0) return
      const now = Date.now()
      if (now - lastTap < 350) {
        e.preventDefault()
        resetView()
        lastTap = 0
      } else {
        lastTap = now
      }
    })

    // Accessibility
    const canvas = this.map.getCanvas()
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', 'Interactive 3D globe visualization')
    canvas.id = this.canvasId

    // Add earth tile layer (2d — renders below labels), then skybox layer
    // (3d — renders after everything, uses depth test for stars behind globe).
    // Move label layers above the earth tile layer so they aren't darkened.
    //
    // `load` is the right signal and stays the primary one, but it is
    // not a *guaranteed* one: see `buildGlobeLayers` for why there is a
    // deadline behind it.
    this.map.on('load', () => this.buildGlobeLayers(container, 'load'))
    this.styleDeadline = setTimeout(
      () => this.buildGlobeLayers(container, 'deadline'),
      MapRenderer.STYLE_READY_DEADLINE_MS,
    )
  }

  /**
   * Longest we wait for MapLibre's `load` before building the globe's
   * own layers anyway.
   *
   * Generous, because the happy path must never take this branch on a
   * merely-slow connection — `load` firing at eight seconds is fine and
   * common, and building early would only add a redundant code path to
   * every session.
   */
  private static readonly STYLE_READY_DEADLINE_MS = 8_000

  private globeLayersBuilt = false
  private styleDeadline: ReturnType<typeof setTimeout> | null = null

  /**
   * Build the earth tile layer, the capture layer and the skybox, and
   * flush any dataset texture buffered before they existed.
   *
   * **Why this is not simply the `load` handler.** MapLibre fires `load`
   * only once *every source in the style* reports loaded, and the style
   * declares `openmaptiles` by TileJSON `url` — a network fetch to
   * OpenFreeMap that must resolve before the map is considered loaded.
   * That source exists for the labels and boundaries overlays, which are
   * **off by default** and live behind a Tools toggle. So a slow or
   * unreachable third-party basemap host could hold the globe's own
   * layers hostage indefinitely: no earth layer, so a dataset already
   * fetched and decoded sat in `pendingTexture` forever, and the globe
   * showed bare raster tiles with no day/night, no atmosphere, and — for
   * a data-encoded row — no probe source and therefore no value readout
   * and no Analyze panel. An optional decoration must not be able to
   * cost the visitor the thing they actually asked for.
   *
   * Observed in the visual-report harness, where OpenFreeMap is
   * unreachable: `load` never fired, and a data-encoded scene reported
   * "no dataset carrying values" against a globe that had one.
   *
   * The deadline path is safe because `addLayer` needs only the style
   * *parsed*, not every source *loaded*. This renderer hands MapLibre a
   * style **object** in the `Map` constructor (`style:
   * createGlobeStyle(...)`), so there is no style-document fetch to wait
   * on — construction applies it and MapLibre's internal loaded flag,
   * the one `addLayer` checks, is set from there. `Map#loaded()` is the
   * separate question of whether every *source* has finished, and that
   * is exactly the wait being bypassed.
   *
   * Runs once; whichever trigger arrives first wins.
   */
  private buildGlobeLayers(container: HTMLElement, trigger: 'load' | 'deadline'): void {
    if (this.globeLayersBuilt || !this.map) return
    this.globeLayersBuilt = true
    if (this.styleDeadline) {
      clearTimeout(this.styleDeadline)
      this.styleDeadline = null
    }
    if (trigger === 'deadline') {
      logger.warn(
        '[MapRenderer] Map `load` did not fire within ' +
          `${MapRenderer.STYLE_READY_DEADLINE_MS}ms — a style source is still ` +
          'pending. Building the globe layers anyway so the dataset is not ' +
          'held up by the basemap.',
      )
    }
    logger.info(`[MapRenderer] Map loaded with ${this.projection} projection`)

    // Collapse the compact attribution control so it doesn't cover the auto-rotate button
    const attrib = container.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact')
    attrib?.classList.remove('maplibregl-compact-show')

    // The earth tile layer (day/night sphere shader, atmospheric
    // glow) and the skybox are 3D effects designed for globe
    // projection — they paint a textured Earth sphere + a
    // starfield over the basemap. In mercator they'd draw the
    // sphere on top of the flat raster tiles and obliterate the
    // basemap; the §6.9 catalog Map view explicitly wants the
    // raw flat GIBS composite as its basemap. Skipping the
    // custom layers entirely in mercator keeps the surface a
    // clean Blue/Black Marble raster — which is what the Map
    // view's bbox overlays need to read against.
    if (this.projection === 'mercator') {
      // Preload still runs so the GIBS HTTP cache warms for the
      // main globe even when the Map view mounts first.
      if (isMobile()) {
        this.map!.once('idle', () => preloadLowZoomTiles())
      } else {
        preloadLowZoomTiles()
      }
      return
    }

    this.earthLayer = createEarthTileLayer()

    // Layer order: black-marble → [capture] → blue-marble → [earth-tile] → labels → [skybox]
    // Insert capture layer between Black Marble and Blue Marble
    this.map!.addLayer(
      this.earthLayer.captureLayer as unknown as maplibregl.LayerSpecification,
      'blue-marble-layer',
    )
    // Insert main earth effects layer after Blue Marble (at end of 2d layers)
    this.map!.addLayer(this.earthLayer.layer as unknown as maplibregl.LayerSpecification)

    // Move label/boundary layers above the earth tile layer
    for (const id of this.allOverlayLayerIds) {
      try { this.map!.moveLayer(id) } catch { /* layer may not exist */ }
    }

    // Add skybox as a separate 3d layer (renders after all 2d layers)
    this.map!.addLayer(this.earthLayer.skyboxLayer as unknown as maplibregl.LayerSpecification)

    // Re-apply the viewing transform before the buffered dataset, so
    // the LUT is already correct on the layer's first build rather
    // than being rebuilt a frame later — otherwise a globe restored
    // with a non-default palette flashes the publisher's ramp first.
    this.earthLayer.setColorScaleDisplay(this.colorScaleDisplay)

    // Apply any dataset texture/video that was buffered before the
    // layer was ready.
    //
    // The probe source is assigned here as well as on the direct
    // path. It used to be set only on the direct path, so a dataset
    // that finished loading *before* the layers were built — a fast
    // local asset, a warm cache, a fixtured scene — reached the globe
    // with no probe source at all. The value readout then reported
    // nothing for that dataset and looked exactly like a dataset with
    // nothing to report, for the rest of its life on screen.
    if (this.pendingTexture) {
      const opts = this.pendingDatasetOptions ?? undefined
      this.earthLayer.setDatasetTexture(this.pendingTexture, opts)
      this.probeSource = this.pendingTexture
      this.probeOptions = opts ?? null
      this.pendingTexture = null
      this.pendingDatasetOptions = null
      this.applyBaseLayerVisibility(opts)
    } else if (this.pendingVideo) {
      const opts = this.pendingDatasetOptions ?? undefined
      this.earthLayer.setDatasetVideo(this.pendingVideo, opts)
      this.probeSource = this.pendingVideo
      this.probeOptions = opts ?? null
      this.pendingVideo = null
      this.pendingDatasetOptions = null
      this.applyBaseLayerVisibility(opts)
    }

    logger.info('[MapRenderer] Earth tile + capture + skybox layers added, labels moved above')

    // Preload low-zoom tiles into browser/SW cache.
    // Mobile: wait for 'idle' (initial viewport tiles rendered) to avoid bandwidth contention.
    // Desktop: start immediately after layer setup.
    if (isMobile()) {
      this.map!.once('idle', () => preloadLowZoomTiles())
    } else {
      preloadLowZoomTiles()
    }
  }

  /** Return the underlying MapLibre map instance. */
  getMap(): MaplibreMap | null {
    return this.map
  }

  /** Return the projection this renderer was initialised with.
   *  Internal callers (the `moveend` → `emitCameraSettled` path
   *  on this class) read it to stamp the projection on telemetry;
   *  debug surfaces can also use it to distinguish the main globe
   *  from the §6.9 catalog Map view's mercator instance when both
   *  are mounted in the same session. The Map view's antimeridian
   *  polygon construction reads `MapBboxOverlay.crossesAntimeridian`
   *  on each bbox instead — the renderer-wide projection isn't
   *  the right signal there. */
  getProjection(): MapRendererProjection {
    return this.projection
  }

  /**
   * Register or clear the dataset-credits phantom source on this
   * panel's map. Pass a Dataset to set the credit; pass null to
   * clear it (after unload). The phantom source carries no
   * features and no layers reference it — it exists only to feed
   * its `attribution` string into MapLibre's source-attribution
   * pipeline so the Tools → Credits panel can read it back.
   *
   * See src/ui/creditsPanel.ts for the full design + composition
   * rules. Idempotent — calling with the same dataset twice is a
   * no-op beyond the redundant remove/add.
   */
  setDatasetCredits(dataset: Dataset | null): void {
    setDatasetCreditsSource(this.map, dataset)
  }

  /** Return the map canvas element for screenshot capture. */
  getCanvas(): HTMLCanvasElement | null {
    return this.map?.getCanvas() ?? null
  }

  /**
   * Force MapLibre to render a fresh frame and resolve once the render
   * event fires. Used as a prelude to screenshot capture so the WebGL
   * drawing buffer is guaranteed to be populated when we read pixels.
   *
   * Falls back to a short timeout if the render event never fires
   * (map hidden, disposed, or otherwise quiescent) so screenshot
   * callers don't hang forever.
   */
  async triggerFreshRender(): Promise<void> {
    const map = this.map
    if (!map) return
    const RENDER_WAIT_TIMEOUT_MS = 1000
    await new Promise<void>((resolve) => {
      let settled = false
      const timeoutId = window.setTimeout(() => {
        if (settled) return
        settled = true
        resolve()
      }, RENDER_WAIT_TIMEOUT_MS)
      map.once('render', () => {
        if (settled) return
        settled = true
        window.clearTimeout(timeoutId)
        resolve()
      })
      map.triggerRepaint()
    })
  }

  /**
   * Capture the current globe view as a JPEG data URL.
   *
   * A naive `canvas.toDataURL()` is unreliable on MapLibre — even with
   * `preserveDrawingBuffer: true`, the WebGL drawing buffer can be
   * cleared between frames when the map is idle, producing a black
   * image. We force a fresh repaint and wait for MapLibre to finish
   * rendering before reading pixels.
   *
   * @param options.maxSize Max dimension (px) on the longer edge of the
   * output image. Defaults to SCREENSHOT_MAX_SIZE (512) for the vision
   * flow. Pass `Infinity` (or a very large number) to skip the
   * downsample step — useful when compositing into a larger capture.
   *
   * Returns null if the map isn't initialized or the capture fails.
   */
  async captureScreenshot(options?: { maxSize?: number }): Promise<string | null> {
    const map = this.map
    if (!map) return null
    const maxSize = options?.maxSize ?? SCREENSHOT_MAX_SIZE
    try {
      await this.triggerFreshRender()
      const canvas = map.getCanvas()
      const { width, height } = canvas
      const scale = Math.min(1, maxSize / Math.max(width, height))
      if (scale < 1) {
        const offscreen = document.createElement('canvas')
        offscreen.width = Math.round(width * scale)
        offscreen.height = Math.round(height * scale)
        const ctx = offscreen.getContext('2d')
        if (!ctx) return canvas.toDataURL('image/jpeg', 0.6)
        ctx.drawImage(canvas, 0, 0, offscreen.width, offscreen.height)
        return offscreen.toDataURL('image/jpeg', 0.6)
      }
      return canvas.toDataURL('image/jpeg', 0.6)
    } catch (err) {
      logger.warn('[MapRenderer] captureScreenshot failed:', err)
      return null
    }
  }

  // --- Navigation ---

  /**
   * Fly the camera to a geographic location.
   * The third parameter is altitude in km (matching Three.js convention).
   * It's converted to a MapLibre zoom level.
   */
  flyTo(lat: number, lon: number, altitude?: number): Promise<void> {
    if (!this.map) return Promise.resolve()

    let zoom = this.map.getZoom()
    if (altitude !== undefined) {
      // Convert altitude (km) to MapLibre zoom level
      // At zoom 0, the view covers ~40,000 km. Each zoom level halves the view.
      // altitude ≈ EARTH_RADIUS_KM * 2 / 2^zoom → zoom ≈ log2(EARTH_RADIUS_KM * 2 / altitude)
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
        Math.log2(EARTH_RADIUS_KM * 2 / Math.max(altitude, 1))))
    }

    return new Promise<void>(resolve => {
      this.map!.once('moveend', () => resolve())
      this.map!.flyTo({
        center: [lon, lat],
        zoom,
        duration: 2500,
      })
    })
  }

  /**
   * Fly the camera to fit a bounding box.
   * bounds: [west, south, east, north] in degrees.
   */
  fitBounds(bounds: [number, number, number, number], options?: { padding?: number; duration?: number }): void {
    let [west, south, east, north] = bounds
    // Normalize antimeridian-crossing bounds (west > east) by wrapping east
    if (west > east) east += 360
    this.map?.fitBounds(
      [[west, south], [east, north]],
      {
        padding: options?.padding ?? 50,
        duration: options?.duration ?? 2500,
      },
    )
  }

  // --- Label & boundary layer toggles ---

  private readonly allOverlayLayerIds = ['coastline-halo', 'coastline', 'boundaries-halo', 'boundaries', 'country-labels', 'city-labels', 'ocean-labels']
  private readonly labelOnlyIds = ['country-labels', 'city-labels', 'ocean-labels']
  private readonly boundaryOnlyIds = ['coastline-halo', 'coastline', 'boundaries-halo', 'boundaries']

  /** Show or hide label layers only (country, city, ocean names). */
  toggleLabels(visible?: boolean): boolean {
    if (!this.map || !this.map.isStyleLoaded()) return false
    let firstLayer: string | undefined
    try { firstLayer = this.map.getLayoutProperty('country-labels', 'visibility') } catch { /* style not ready */ }
    const show = visible ?? (firstLayer === 'none' || firstLayer === undefined)
    const vis = show ? 'visible' : 'none'
    for (const id of this.labelOnlyIds) {
      try { this.map.setLayoutProperty(id, 'visibility', vis) } catch { /* noop */ }
    }
    return show
  }

  /** Show or hide boundary + coastline lines. */
  toggleBoundaries(visible?: boolean): boolean {
    if (!this.map || !this.map.isStyleLoaded()) return false
    let current: string | undefined
    try { current = this.map.getLayoutProperty('boundaries', 'visibility') } catch { /* style not ready */ }
    const show = visible ?? (current === 'none' || current === undefined)
    const vis = show ? 'visible' : 'none'
    for (const id of this.boundaryOnlyIds) {
      try { this.map.setLayoutProperty(id, 'visibility', vis) } catch { /* noop */ }
    }
    return show
  }

  // --- Markers & popups ---

  private markers: maplibregl.Marker[] = []

  /** Add a marker at the given coordinates with an optional popup label.
   *  The popup opens automatically so the label is immediately visible. */
  addMarker(lat: number, lng: number, label?: string): maplibregl.Marker | null {
    if (!this.map) return null
    const marker = new maplibregl.Marker({ color: '#4da6ff' })
      .setLngLat([lng, lat])
    if (label) {
      const popupContent = document.createElement('div')
      popupContent.style.cssText = 'color:#fff;background:rgba(13,13,18,0.92);padding:6px 10px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;'
      popupContent.textContent = label
      marker.setPopup(new maplibregl.Popup({ offset: 25, className: 'sos-popup' }).setDOMContent(popupContent))
    }
    marker.addTo(this.map)
    // Auto-open popup so label is immediately visible
    if (label) marker.togglePopup()
    this.markers.push(marker)
    return marker
  }

  /** Remove all markers from the map. */
  clearMarkers(): void {
    for (const m of this.markers) m.remove()
    this.markers = []
  }

  // --- 3D Terrain ---

  private terrainEnabled = false

  /** Toggle 3D terrain elevation. Useful for topography/geology datasets. */
  toggleTerrain(enabled?: boolean): boolean {
    if (!this.map || !this.map.isStyleLoaded()) return false
    this.terrainEnabled = enabled ?? !this.terrainEnabled
    const exaggeration = 5
    if (this.terrainEnabled) {
      this.map.setTerrain({ source: 'terrain-dem', exaggeration })
      this.earthLayer?.setTerrainExaggeration(exaggeration)
    } else {
      this.map.setTerrain(null as any)
      this.earthLayer?.setTerrainExaggeration(0)
    }
    return this.terrainEnabled
  }

  /** Toggle auto-rotation and return the new state. */
  toggleAutoRotate(): boolean {
    this.autoRotating = !this.autoRotating
    if (this.autoRotating) {
      this.startAutoRotate()
    } else {
      this.stopAutoRotate()
    }
    return this.autoRotating
  }

  /**
   * Set the globe rotation rate. 0 = stop, 1.0 = default (30°/10s), 2.0 = double speed.
   * Starts rotation if rate > 0 and not already rotating; stops if rate is 0.
   */
  setRotationRate(rate: number): void {
    this.rotationRate = Math.max(0, Math.min(2, rate))
    if (this.rotationRate > 0) {
      if (!this.autoRotating) {
        this.autoRotating = true
        this.startAutoRotate()
      } else {
        // Restart with new rate
        this.startAutoRotate()
      }
    } else {
      this.autoRotating = false
      this.stopAutoRotate()
    }
  }

  private stopOnInteraction = () => {
    if (this.autoRotating) {
      this.autoRotating = false
      this.stopAutoRotate()
    }
  }

  private startAutoRotate(): void {
    this.stopAutoRotate()
    // Shift the center longitude to rotate around the polar axis (west-to-east).
    // This avoids the wobble caused by bearing rotation on a tilted globe.
    const degreesPerCycle = 30 * this.rotationRate
    const rotate = () => {
      if (!this.map || !this.autoRotating) return
      const center = this.map.getCenter()
      this.map.easeTo({
        center: [center.lng - degreesPerCycle, center.lat],
        duration: 10000,
        easing: (t: number) => t, // linear
      })
    }
    rotate()
    this.autoRotateInterval = window.setInterval(rotate, 10000)

    // Stop auto-rotate on user interaction
    this.map?.on('mousedown', this.stopOnInteraction)
    this.map?.on('touchstart', this.stopOnInteraction)
  }

  private stopAutoRotate(): void {
    if (this.autoRotateInterval !== null) {
      clearInterval(this.autoRotateInterval)
      this.autoRotateInterval = null
    }
    this.map?.off('mousedown', this.stopOnInteraction)
    this.map?.off('touchstart', this.stopOnInteraction)
    this.map?.stop() // cancel any in-flight easeTo
  }

  // --- Lat/lng tracking ---

  /**
   * Register callbacks for the cursor lat/lng display (and, for a
   * data-encoded dataset, the value readout that hangs off it).
   *
   * Three fixes over the original, all of which the data-encoded
   * readout made visible by giving the callback something more
   * consequential to say than a coordinate:
   *
   *   - Previous handlers are removed first. This used to stack a
   *     new pair on every call, so a second invocation drove the
   *     display twice per pointer event.
   *   - `touchmove` alongside `mousemove`, so a touch drag reports
   *     too. These are the events MapLibre actually fires; it has no
   *     `pointermove`/`pointerout`, and `Evented.on` accepts an
   *     unknown name without complaint, so registering those bound a
   *     handler that could never run. There is no touch equivalent of
   *     `mouseout` in play deliberately: a finger has no hover state,
   *     and clearing on lift would erase the reading at the moment it
   *     became readable.
   *   - Off-globe returns nothing. MapLibre's `e.lngLat` unprojects
   *     even where the sphere isn't, so the corners of the viewport
   *     used to report a coordinate for empty space.
   */
  setLatLngCallbacks(
    onUpdate: (lat: number, lng: number) => void,
    onClear: () => void
  ): void {
    const map = this.map
    if (!map) return
    this.clearLatLngCallbacks()

    const move = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (!this.isPointerOnGlobe(e)) {
        onClear()
        return
      }
      onUpdate(e.lngLat.lat, e.lngLat.lng)
    }
    const out = () => onClear()
    map.on('mousemove', move)
    map.on('touchmove', move)
    map.on('mouseout', out)
    this.latLngUnsubscribe = () => {
      map.off('mousemove', move)
      map.off('touchmove', move)
      map.off('mouseout', out)
    }
  }

  /**
   * Apply a palette / stretch / threshold transform to a data-encoded
   * dataset on this globe.
   *
   * A viewing decision, not a data one: the LUT the shader samples is
   * rebuilt and nothing else moves. `probeValueAt` keeps reporting the
   * same physical value under the same pixel, which is the invariant
   * `colorScaleDisplay` exists to protect — see its docstring.
   *
   * Buffered when the earth layer has not been created yet, the same
   * way `updateTexture` buffers, so a display chosen before the first
   * dataset finishes loading is not silently dropped.
   */
  setColorScaleDisplay(display: ColorScaleDisplay): void {
    this.colorScaleDisplay = display
    this.earthLayer?.setColorScaleDisplay(display)
  }

  /** The transform currently applied to this globe. */
  getColorScaleDisplay(): ColorScaleDisplay {
    return this.colorScaleDisplay
  }

  /**
   * Everything the statistics reducers need for the currently displayed
   * frame, or `null` when there is nothing to compute over.
   *
   * All-or-nothing on purpose: a snapshot without its scale is a grid of
   * meaningless bytes, and a scale without the bbox would put every
   * texel at the wrong latitude. Handing back one object means a caller
   * cannot pair a frame with the previous dataset's metadata.
   *
   * **Not for pointer handlers.** This reads the whole frame — see
   * `GlLumaSampler.snapshot`. Call it from an explicit user action.
   */
  analysisFrame(): {
    snapshot: LumaSnapshot
    scale: ColorScale
    options: DatasetOverlayOptions
  } | null {
    const options = this.probeOptions
    if (!this.probeSource || !options?.colorScale) return null
    const sampler = getSharedLumaSampler()
    if (!sampler) return null
    const snapshot = sampler.snapshot(this.probeSource)
    if (!snapshot) return null
    return { snapshot, scale: options.colorScale, options }
  }

  /**
   * Identity of the frame currently on the globe.
   *
   * The *same* expression `glLumaSampler` keys its snapshot cache on, so
   * "this string changed" and "the sampler would read a different frame"
   * are the same statement by construction rather than by coincidence.
   *
   * Deliberately not the `#time-label` text: that is snapped to the
   * dataset's display interval, so several video frames can share one
   * label, and it is hidden entirely for a dataset without start/end
   * times — a watch built on it goes silently inert exactly when it is
   * most needed. Costs a property read; no readback, no upload.
   */
  currentFrameId(): string | null {
    const source = this.probeSource
    if (!source) return null
    return source instanceof HTMLVideoElement ? `${source.currentTime}` : 'static'
  }

  // --- Analysed-region outline (Analyze §A3) ---

  private regionOutlineId: string | null = null

  /**
   * Outline the box the Analyze panel is measuring.
   *
   * Outline only, with no fill. A wash over the region would tint the
   * very values being measured, and the whole discipline of the
   * data-encoded path is that nothing decorative changes what a colour
   * means. The box says *where*; the globe still says *what*.
   */
  showRegionOutline(bounds: { n: number; s: number; w: number; e: number }): void {
    this.clearRegionOutline()
    if (!this.map) return
    const ring = boundsRing(bounds).map((p): [number, number] => [p.lon, p.lat])
    this.regionOutlineId = this.highlightRegion(
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      } as GeoJSON.Feature,
      { color: '#4da6ff', opacity: 0 },
    )
  }

  clearRegionOutline(): void {
    if (!this.regionOutlineId) return
    this.removeHighlight(this.regionOutlineId)
    this.regionOutlineId = null
  }

  // --- Isolines (Analyze §A5) ---

  private contourId: string | null = null

  /**
   * Draw the contour set the Analyze panel extracted.
   *
   * Its own source and layer rather than `highlightRegion`, for two
   * reasons. `highlightRegion` paints one fixed colour, and a contour map
   * needs each line drawn at its own level's colour — which is a
   * data-driven `['get', 'color']` over one FeatureCollection, not a
   * source per level. And it always adds a `fill` layer, which over a
   * MultiLineString draws nothing and is pure weight.
   *
   * Line only, no fill, for the same reason `showRegionOutline` refuses
   * one: a wash over the enclosed region would tint the values being
   * measured, and on this path nothing decorative is allowed to change
   * what a colour means. A dark halo underneath keeps a pale line legible
   * over a pale part of the ramp — without it the lightest levels vanish
   * into exactly the region they are describing.
   *
   * The geometry arrives already split at the antimeridian; see
   * `datasetContours.splitAtSeam` for why drawing it unsplit puts a
   * stripe across the globe.
   */
  showContours(levels: ContourLevel[]): void {
    this.clearContours()
    if (!this.map || !this.map.isStyleLoaded() || !levels.length) return
    const data = contourSetToGeoJson(levels)
    if (!data.features.length) return

    const id = `contours-${++this.highlightCounter}`
    const sourceId = `${id}-source`
    this.map.addSource(sourceId, { type: 'geojson', data })
    this.map.addLayer({
      id: `${id}-halo`,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': 'rgba(0, 0, 0, 0.55)',
        'line-width': 3.5,
      },
    })
    this.map.addLayer({
      id: `${id}-line`,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.5,
      },
    })
    this.contourId = id
  }

  clearContours(): void {
    if (!this.contourId || !this.map) {
      this.contourId = null
      return
    }
    const id = this.contourId
    try { this.map.removeLayer(`${id}-line`) } catch { /* noop */ }
    try { this.map.removeLayer(`${id}-halo`) } catch { /* noop */ }
    try { this.map.removeSource(`${id}-source`) } catch { /* noop */ }
    this.contourId = null
  }

  // --- Transect picking (Analyze §A4) ---

  /** Vertices in the drawn line. Enough that the curve reads as smooth
   *  at any zoom without putting a meaningful number of points into a
   *  source that is redrawn on every drag frame. */
  private static readonly TRANSECT_LINE_VERTICES = 64

  private transectPoints: { lat: number; lon: number }[] = []
  private transectMarkers: maplibregl.Marker[] = []
  private transectLineId: string | null = null
  private transectUnsubscribe: (() => void) | null = null
  private transectOnChange: ((ends: TransectEndpoints | null) => void) | null = null

  /**
   * Arm two-point picking on the globe.
   *
   * `onChange` fires with the pair once the second point lands, again on
   * every drag of either endpoint, and with `null` when the transect is
   * cleared. Re-arming replaces any transect already on screen — one
   * line at a time, because two would need a legend to tell apart and
   * the panel only charts one.
   *
   * Dragging recomputes from a snapshot the caller already holds, so a
   * live drag costs a pure re-sample and no readback. That is why this
   * fires on `drag` rather than `dragend`.
   */
  beginTransect(onChange: (ends: TransectEndpoints | null) => void): void {
    if (!this.map) return
    this.clearTransect()
    this.transectOnChange = onChange
    const map = this.map
    const onClick = (e: maplibregl.MapMouseEvent): void => {
      this.transectPoints.push({ lat: e.lngLat.lat, lon: e.lngLat.lng })
      if (this.transectPoints.length === 1) {
        this.addTransectMarker(0)
        return
      }
      this.disarmTransectPicking()
      this.addTransectMarker(1)
      this.redrawTransectLine()
      this.emitTransect()
    }
    map.on('click', onClick)
    this.transectUnsubscribe = () => map.off('click', onClick)
  }

  /** How many points of the pair have been placed. Drives the panel's
   *  "click two points" instruction. */
  transectProgress(): number {
    return this.transectPoints.length
  }

  /** Remove the line, its endpoints, and any pending pick. */
  clearTransect(): void {
    this.disarmTransectPicking()
    for (const m of this.transectMarkers) m.remove()
    this.transectMarkers = []
    this.transectPoints = []
    if (this.transectLineId) {
      this.removeHighlight(this.transectLineId)
      this.transectLineId = null
    }
    const notify = this.transectOnChange
    this.transectOnChange = null
    notify?.(null)
  }

  private disarmTransectPicking(): void {
    this.transectUnsubscribe?.()
    this.transectUnsubscribe = null
  }

  private addTransectMarker(index: number): void {
    if (!this.map) return
    const p = this.transectPoints[index]
    const marker = new maplibregl.Marker({ color: '#ffd166', draggable: true })
      .setLngLat([p.lon, p.lat])
      .addTo(this.map)
    marker.on('drag', () => {
      const at = marker.getLngLat()
      this.transectPoints[index] = { lat: at.lat, lon: at.lng }
      this.redrawTransectLine()
      this.emitTransect()
    })
    this.transectMarkers[index] = marker
  }

  private emitTransect(): void {
    if (this.transectPoints.length < 2) return
    this.transectOnChange?.({ from: this.transectPoints[0], to: this.transectPoints[1] })
  }

  /**
   * Draw the line the samples are taken along.
   *
   * Densified rather than drawn as a two-point LineString: MapLibre
   * renders a segment as a straight line in projected space, which on a
   * globe is not the great circle the samples follow. A viewer
   * comparing the chart against the line has to be looking at the same
   * path, so the geometry is subdivided along the same spherical
   * interpolation `sampleTransect` uses.
   */
  private redrawTransectLine(): void {
    if (!this.map || this.transectPoints.length < 2) return
    if (this.transectLineId) {
      this.removeHighlight(this.transectLineId)
      this.transectLineId = null
    }
    const [from, to] = this.transectPoints
    const coords = greatCirclePath(from, to, MapRenderer.TRANSECT_LINE_VERTICES)
      .map((p): [number, number] => [p.lon, p.lat])
    this.transectLineId = this.highlightRegion(
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      } as GeoJSON.Feature,
      { color: '#ffd166' },
    )
  }

  /** The geographic box currently in view, for "analyse what I can
   *  see". Null when the map is not up yet. */
  visibleBounds(): { n: number; s: number; w: number; e: number } | null {
    if (!this.map) return null
    const b = this.map.getBounds()
    return { n: b.getNorth(), s: b.getSouth(), w: b.getWest(), e: b.getEast() }
  }

  /**
   * Read the dataset value under a geographic point, or `null` when
   * there is nothing meaningful to report — a picture dataset, a
   * point outside a regional dataset's box, or no decoded frame yet.
   *
   * Deliberately independent of `setColorScaleDisplay`: recolouring the
   * globe must never move this number.
   */
  probeValueAt(lat: number, lon: number): ProbeReading | null {
    if (!this.probeSource || !this.probeOptions?.colorScale) return null
    // Shared across every renderer on the page: one WebGL2 context
    // total rather than one per panel. `null` means no WebGL2, in
    // which case there is no globe either, so no readout is right.
    const sampler = getSharedLumaSampler()
    if (!sampler) return null
    return probeDatasetValue(
      lat, lon, this.probeSource, (s, uv) => sampler.sample(s, uv), this.probeOptions)
  }

  /** Detach the lat/lng handlers registered by `setLatLngCallbacks`. */
  clearLatLngCallbacks(): void {
    this.latLngUnsubscribe?.()
    this.latLngUnsubscribe = null
  }

  /**
   * Whether the pointer is actually over the globe.
   *
   * On a globe projection MapLibre still unprojects points in the
   * empty space around the sphere, so `e.lngLat` alone is not a test.
   * Re-projecting the returned coordinate and comparing against the
   * original screen point is: for a point off the sphere the round
   * trip does not come back where it started.
   */
  private isPointerOnGlobe(e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent): boolean {
    const map = this.map
    if (!map) return false
    try {
      const back = map.project(e.lngLat)
      const dx = back.x - e.point.x
      const dy = back.y - e.point.y
      return dx * dx + dy * dy < ON_GLOBE_TOLERANCE_PX * ON_GLOBE_TOLERANCE_PX
    } catch {
      return false
    }
  }

  // --- Custom layers (for Phase 1+) ---

  /** Add a custom layer (e.g. day/night blend, clouds). */
  addCustomLayer(layer: CustomLayerInterface, beforeId?: string): void {
    this.map?.addLayer(layer as unknown as maplibregl.LayerSpecification, beforeId)
  }

  // --- Canvas description ---

  /** Update the canvas ARIA label. */
  setCanvasDescription(text: string): void {
    this.map?.getCanvas().setAttribute('aria-label', text)
  }

  // --- Dataset overlays (Spike B) ---

  /**
   * Display an equirectangular image on the globe via custom layer sphere.
   * Uses proper equirectangular UV mapping — no Mercator distortion, full
   * pole coverage.
   */
  /**
   * Phase 3e: hide vs keep the base raster layers based on the
   * dataset's overlay options.
   *
   *   Earth + no bbox       hide (the dataset's full-equirectangular
   *                              projection covers every pixel)
   *   Earth + bbox          show (shader discards outside the box;
   *                              base tiles fill the rest of the globe)
   *   non-Earth (any case)  hide (Earth's blue/black marble are the
   *                              wrong textures for Mars / Moon / Sun /
   *                              etc.; we render the dataset on a
   *                              clean sphere until 3f bundles
   *                              per-body surface textures)
   *
   * Returns void; callers use it as a single source of truth for
   * "what should the base look like behind this dataset?". */
  private applyBaseLayerVisibility(options: DatasetOverlayOptions | undefined): void {
    const earth = isEarthBody(options?.celestialBody)
    const showBase = earth && Boolean(options?.boundingBox)
    const visibility = showBase ? 'visible' : 'none'
    try { this.map?.setLayoutProperty('blue-marble-layer', 'visibility', visibility) } catch { /* noop */ }
    try { this.map?.setLayoutProperty('black-marble-layer', 'visibility', visibility) } catch { /* noop */ }
  }

  updateTexture(
    texture: HTMLCanvasElement | HTMLImageElement,
    options?: DatasetOverlayOptions,
  ): void {
    if (!this.earthLayer) {
      // Buffer until the earth layer is created on map 'load'
      this.pendingTexture = texture
      this.pendingVideo = null
      this.pendingDatasetOptions = options ?? null
      return
    }
    this.earthLayer.setDatasetTexture(texture, options)
    this.probeSource = texture
    this.probeOptions = options ?? null
    this.applyBaseLayerVisibility(options)
    logger.info('[MapRenderer] Dataset overlay set via custom layer sphere')
  }

  /**
   * Display an equirectangular video on the globe via custom layer sphere.
   * The render loop updates the texture from the video element each frame.
   * Returns a lightweight handle for playback controller compatibility.
   */
  setVideoTexture(video: HTMLVideoElement, options?: DatasetOverlayOptions): VideoTextureHandle {
    if (this.earthLayer) {
      this.earthLayer.setDatasetVideo(video, options)
      this.probeSource = video
      this.probeOptions = options ?? null
      this.applyBaseLayerVisibility(options)
      logger.info('[MapRenderer] Video dataset set via custom layer sphere')
    } else {
      // Buffer until the earth layer is created on map 'load'
      this.pendingVideo = video
      this.pendingTexture = null
      this.pendingDatasetOptions = options ?? null
    }
    const earthLayer = this.earthLayer
    let pending = false
    return {
      get needsUpdate() { return pending },
      set needsUpdate(v: boolean) {
        pending = v
        if (v) { earthLayer?.requestVideoUpdate(); pending = false }
      },
      dispose() {},
    }
  }

  /**
   * Playhead of the frame currently in this panel's dataset texture, or
   * `null` when none has been uploaded.
   *
   * What the globe is *showing*, as opposed to what its video element
   * reports. The two diverge whenever an upload is skipped, which is
   * precisely the case a sibling-alignment check has to catch.
   */
  getUploadedFrameTime(): number | null {
    return this.earthLayer?.getUploadedFrameTime() ?? null
  }

  // --- Earth materials ---

  /** Wait for the earth tile layer's textures (night lights, specular, clouds) to load. */
  async loadDefaultEarthMaterials(onProgress?: (fraction: number) => void): Promise<void> {
    // Wait for earth layer to be created (it's added on map 'load')
    if (!this.earthLayer) {
      logger.debug('[MapRenderer] loadDefaultEarthMaterials: waiting for earth layer...')
      // Generous timeout: in multi-viewport mode four maps compete for
      // bandwidth and the primary's `load` event can take >10s on
      // mobile Safari. 30s keeps the poll bounded without being
      // fatal for slow connections.
      const EARTH_LAYER_TIMEOUT_MS = 30_000
      await new Promise<void>((resolve, reject) => {
        const start = Date.now()
        const check = () => {
          if (this.earthLayer) return resolve()
          if (!this.map || Date.now() - start > EARTH_LAYER_TIMEOUT_MS) {
            return reject(new Error('[MapRenderer] Timed out waiting for earth layer'))
          }
          setTimeout(check, 50)
        }
        check()
      })
    }
    logger.debug('[MapRenderer] loadDefaultEarthMaterials: earth layer found, waiting for textures...')
    onProgress?.(0.2)
    await this.earthLayer!.ready
    logger.debug('[MapRenderer] loadDefaultEarthMaterials: textures ready')
    onProgress?.(1)
  }

  /** Hide earth effects (day/night, city lights, specular, clouds) when a dataset is active. */
  removeNightLights(): void {
    this.earthLayer?.setVisible(false)
    // Also hide the atmosphere glow since it conflicts with dataset overlays
    try { this.map?.setSky({ 'atmosphere-blend': 0 }) } catch { /* noop */ }
  }

  /** Update sun direction and re-show the earth tile layer + atmosphere. */
  enableSunLighting(lat: number, lng: number): void {
    this.earthLayer?.clearDatasetTexture()
    this.probeSource = null
    this.probeOptions = null
    this.earthLayer?.setVisible(true)
    this.earthLayer?.setSunPosition(lat, lng)
    // Restore tile bases (may have been hidden for dataset overlay)
    try { this.map?.setLayoutProperty('blue-marble-layer', 'visibility', 'visible') } catch { /* noop */ }
    try { this.map?.setLayoutProperty('black-marble-layer', 'visibility', 'visible') } catch { /* noop */ }
    // Restore atmosphere glow (may have been hidden for dataset overlay)
    try {
      this.map?.setSky({
        'atmosphere-blend': [
          'interpolate', ['linear'], ['zoom'],
          0, 1, 5, 1, 7, 0,
        ] as any,
      })
    } catch { /* noop */ }
  }

  /** Clear sun override — reverts to real-time sun position.
   *  Does NOT re-show the earth layer; enableSunLighting() handles that. */
  disableSunLighting(): void {
    this.earthLayer?.clearSunOverride()
  }

  /** Clouds are loaded by the earth tile layer automatically. Report complete. */
  async loadCloudOverlay(_url: string, _onProgress?: (fraction: number) => void): Promise<void> {
    _onProgress?.(1)
  }

  /** Cloud removal is handled by the earth tile layer. */
  removeCloudOverlay(): void {
    // Phase 1
  }

  // --- View context for LLM ---

  /**
   * Query the current viewport state and visible geographic features.
   * Returns a structured object the LLM can use for richer context.
   */
  /** Extract unique feature names from a source layer, filtered to the viewport bounds.
   *  Only considers Point features to avoid false positives from off-screen geometry. */
  private queryNamesInBounds(sourceLayer: string, bounds: maplibregl.LngLatBounds, classFilter?: string): string[] {
    if (!this.map) return []
    const names: string[] = []
    const seen = new Set<string>()
    try {
      const features = this.map.querySourceFeatures('openmaptiles', { sourceLayer })
      for (const f of features) {
        // Only process Point features — LineString/Polygon can extend far off-screen
        if (f.geometry.type !== 'Point') continue
        if (classFilter && f.properties?.class !== classFilter) continue
        const name = (f.properties?.['name:latin'] ?? f.properties?.name) as string | undefined
        if (!name || seen.has(name)) continue
        const [lng, lat] = f.geometry.coordinates
        if (lat < bounds.getSouth() || lat > bounds.getNorth()) continue
        const w = bounds.getWest(), e = bounds.getEast()
        if (w <= e ? (lng < w || lng > e) : (lng < w && lng > e)) continue
        seen.add(name)
        names.push(name)
      }
    } catch { /* source may not be loaded yet */ }
    return names
  }

  getViewContext(): MapViewContext | null {
    if (!this.map) return null
    const center = this.map.getCenter()
    const bounds = this.map.getBounds()

    // Use querySourceFeatures so results are available regardless of label visibility
    const visibleCountries = this.queryNamesInBounds('place', bounds, 'country')
    const visibleOceans = this.queryNamesInBounds('water_name', bounds)

    return {
      center: { lat: center.lat, lng: center.lng },
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
      bounds: {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      },
      visibleCountries,
      visibleOceans,
    }
  }

  // --- GeoJSON region highlighting ---

  private highlightCounter = 0

  /**
   * Highlight a GeoJSON region on the map.
   * Returns the layer ID for later removal.
   */
  highlightRegion(geojson: GeoJSON.GeoJSON, options?: { color?: string; opacity?: number }): string | null {
    if (!this.map || !this.map.isStyleLoaded()) return null
    const id = `highlight-${++this.highlightCounter}`
    const sourceId = `${id}-source`
    this.map.addSource(sourceId, { type: 'geojson', data: geojson })
    this.map.addLayer({
      id: `${id}-fill`,
      type: 'fill',
      source: sourceId,
      paint: {
        'fill-color': options?.color ?? 'rgba(77, 166, 255, 0.3)',
        'fill-opacity': options?.opacity ?? 0.3,
      },
    })
    this.map.addLayer({
      id: `${id}-outline`,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': options?.color ?? '#4da6ff',
        'line-width': 2,
      },
    })
    return id
  }

  /** Remove a highlighted region by its ID. */
  removeHighlight(id: string): void {
    if (!this.map) return
    try { this.map.removeLayer(`${id}-fill`) } catch { /* noop */ }
    try { this.map.removeLayer(`${id}-outline`) } catch { /* noop */ }
    try { this.map.removeSource(`${id}-source`) } catch { /* noop */ }
  }

  /** Remove all highlighted regions. */
  clearHighlights(): void {
    if (!this.map) return
    for (let i = 1; i <= this.highlightCounter; i++) {
      this.removeHighlight(`highlight-${i}`)
    }
    this.highlightCounter = 0
  }

  // --- Disposal ---

  /**
   * Remove the map and clean up resources. MapLibre's `map.remove()`
   * tears down its internal DOM inside the caller-provided container,
   * but leaves the container element itself intact — ViewportManager
   * owns the container lifecycle.
   *
   * If this was the active (primary) renderer, clears the singleton
   * slot so screenshotService doesn't hand out a disposed reference.
   */
  dispose(): void {
    this.stopAutoRotate()
    // A panel can be torn down (a 4→1 layout change) before the style
    // ever settles, and a pending deadline would then build layers on a
    // removed map.
    if (this.styleDeadline) {
      clearTimeout(this.styleDeadline)
      this.styleDeadline = null
    }
    // Before map.remove(): the unsubscribe closures capture `map`, so
    // dropping the reference first would strand the handlers.
    this.clearLatLngCallbacks()
    this.clearTransect()
    this.clearRegionOutline()
    this.clearContours()
    // The probe sampler is page-shared and deliberately NOT disposed
    // here — other panels may still be using it, and tearing down its
    // context would take their readouts with it. Dropping the source
    // is enough: probeValueAt returns early without it.
    this.probeSource = null
    this.probeOptions = null
    if (this.map) {
      this.map.remove()
      this.map = null
    }
    this.container = null
    if (activeRenderer === this) {
      activeRenderer = null
    }
  }
}
