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
import type { GlobeRenderer, MapViewContext, VideoTextureHandle } from '../types'
import { getSunPosition } from '../utils/time'
import { logger } from '../utils/logger'
import { isMobile } from '../utils/deviceCapability'
import { preloadLowZoomTiles } from './tilePreloader'

// --- GIBS tile endpoints (proxied through Cloudflare edge for caching) ---
const BLUE_MARBLE_TILES = [
  '/api/tile/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg'
]
const BLACK_MARBLE_TILES = [
  '/api/tile/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'
]
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
 * Globe style with NASA GIBS raster tiles and OpenFreeMap vector labels/boundaries.
 * Labels and boundaries are hidden by default and can be toggled.
 */
function createGlobeStyle(): StyleSpecification {
  const initSun = getSunPosition(new Date())
  return {
    version: 8,
    name: 'sos-globe',
    projection: { type: 'globe' },
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

/** MapLibre-based globe renderer. */
export class MapRenderer implements GlobeRenderer {
  private map: MaplibreMap | null = null
  private container: HTMLElement | null = null
  private autoRotateInterval: number | null = null
  private autoRotating = false
  private earthLayer: EarthTileLayerControl | null = null
  private pendingTexture: HTMLCanvasElement | HTMLImageElement | null = null
  private pendingVideo: HTMLVideoElement | null = null

  /**
   * Initialize the MapLibre map inside the given container element.
   * The container must already be in the DOM with non-zero dimensions.
   */
  init(container: HTMLElement): void {
    this.container = container

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

    // MapLibre needs a wrapper div — it manages its own canvas internally.
    const mapDiv = document.createElement('div')
    mapDiv.id = 'maplibre-container'
    mapDiv.style.width = '100%'
    mapDiv.style.height = '100%'
    mapDiv.style.background = '#000'
    // Insert before the #ui div so it sits behind UI overlays in z-order
    const uiDiv = container.querySelector('#ui')
    if (uiDiv) {
      container.insertBefore(mapDiv, uiDiv)
    } else {
      container.appendChild(mapDiv)
    }

    this.map = new maplibregl.Map({
      container: mapDiv,
      style: createGlobeStyle(),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      attributionControl: { compact: true },
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
    canvas.id = 'globe-canvas'

    // Add earth tile layer (2d — renders below labels), then skybox layer
    // (3d — renders after everything, uses depth test for stars behind globe).
    // Move label layers above the earth tile layer so they aren't darkened.
    this.map.on('load', () => {
      logger.info('[MapRenderer] Map loaded with globe projection')

      // Collapse the compact attribution control so it doesn't cover the auto-rotate button
      const attrib = container.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact')
      attrib?.classList.remove('maplibregl-compact-show')

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

      // Apply any dataset texture/video that was buffered before the layer was ready
      if (this.pendingTexture) {
        this.earthLayer.setDatasetTexture(this.pendingTexture)
        this.pendingTexture = null
        try { this.map!.setLayoutProperty('blue-marble-layer', 'visibility', 'none') } catch { /* noop */ }
        try { this.map!.setLayoutProperty('black-marble-layer', 'visibility', 'none') } catch { /* noop */ }
      } else if (this.pendingVideo) {
        this.earthLayer.setDatasetVideo(this.pendingVideo)
        this.pendingVideo = null
        try { this.map!.setLayoutProperty('blue-marble-layer', 'visibility', 'none') } catch { /* noop */ }
        try { this.map!.setLayoutProperty('black-marble-layer', 'visibility', 'none') } catch { /* noop */ }
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
    })
  }

  /** Return the underlying MapLibre map instance. */
  getMap(): MaplibreMap | null {
    return this.map
  }

  /** Return the map canvas element for screenshot capture. */
  getCanvas(): HTMLCanvasElement | null {
    return this.map?.getCanvas() ?? null
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
    const rotate = () => {
      if (!this.map || !this.autoRotating) return
      const center = this.map.getCenter()
      this.map.easeTo({
        center: [center.lng - 30, center.lat],
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

  /** Register callbacks for cursor lat/lng display. */
  setLatLngCallbacks(
    onUpdate: (lat: number, lng: number) => void,
    onClear: () => void
  ): void {
    this.map?.on('mousemove', (e) => {
      onUpdate(e.lngLat.lat, e.lngLat.lng)
    })
    this.map?.on('mouseout', () => {
      onClear()
    })
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
  updateTexture(texture: HTMLCanvasElement | HTMLImageElement): void {
    if (!this.earthLayer) {
      // Buffer until the earth layer is created on map 'load'
      this.pendingTexture = texture
      this.pendingVideo = null
      return
    }
    this.earthLayer.setDatasetTexture(texture)
    // Hide the tile base layers when a dataset is active
    try { this.map?.setLayoutProperty('blue-marble-layer', 'visibility', 'none') } catch { /* noop */ }
    try { this.map?.setLayoutProperty('black-marble-layer', 'visibility', 'none') } catch { /* noop */ }
    logger.info('[MapRenderer] Dataset overlay set via custom layer sphere')
  }

  /**
   * Display an equirectangular video on the globe via custom layer sphere.
   * The render loop updates the texture from the video element each frame.
   * Returns a lightweight handle for playback controller compatibility.
   */
  setVideoTexture(video: HTMLVideoElement): VideoTextureHandle {
    if (this.earthLayer) {
      this.earthLayer.setDatasetVideo(video)
      try { this.map?.setLayoutProperty('blue-marble-layer', 'visibility', 'none') } catch { /* noop */ }
      try { this.map?.setLayoutProperty('black-marble-layer', 'visibility', 'none') } catch { /* noop */ }
      logger.info('[MapRenderer] Video dataset set via custom layer sphere')
    } else {
      // Buffer until the earth layer is created on map 'load'
      this.pendingVideo = video
      this.pendingTexture = null
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

  // --- Earth materials ---

  /** Wait for the earth tile layer's textures (night lights, specular, clouds) to load. */
  async loadDefaultEarthMaterials(onProgress?: (fraction: number) => void): Promise<void> {
    // Wait for earth layer to be created (it's added on map 'load')
    if (!this.earthLayer) {
      logger.debug('[MapRenderer] loadDefaultEarthMaterials: waiting for earth layer...')
      await new Promise<void>((resolve, reject) => {
        const start = Date.now()
        const check = () => {
          if (this.earthLayer) return resolve()
          if (!this.map || Date.now() - start > 10_000) {
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

  /** Remove the map and clean up resources. */
  dispose(): void {
    this.stopAutoRotate()
    if (this.map) {
      this.map.remove()
      this.map = null
    }
    // Remove the wrapper div
    const mapDiv = this.container?.querySelector('#maplibre-container')
    if (mapDiv) mapDiv.remove()
    this.container = null
  }
}
