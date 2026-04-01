/**
 * MapLibre GL JS globe renderer — Phase 0 spike.
 *
 * Wraps MapLibre with globe projection, NASA GIBS Blue Marble + Black Marble
 * raster tile sources, and a minimal dark style. Intended to coexist with the
 * existing Three.js SphereRenderer behind a renderer toggle.
 */

import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Map as MaplibreMap, StyleSpecification, CustomLayerInterface } from 'maplibre-gl'
import * as THREE from 'three'
import { createEarthTileLayer, computeSunLightPosition, type EarthTileLayerControl } from './earthTileLayer'
import { getSunPosition } from '../utils/time'

// --- GIBS tile endpoints ---
const BLUE_MARBLE_TILES = [
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg'
]
const BLACK_MARBLE_TILES = [
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlackMarble_2016/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'
]
const GIBS_MAX_ZOOM = 8

// --- Default camera ---
const DEFAULT_CENTER: [number, number] = [0, 20]
const DEFAULT_ZOOM = 1.8
// Zoom limits: ~0.5 shows the full globe, ~8 is the max detail for GIBS tiles
const MIN_ZOOM = 0.5
const MAX_ZOOM = 8
// Approximate conversion: Three.js camera.z [1.15, 3.6] → MapLibre zoom [8, 0.5]
// altitude (km) → zoom: Earth radius ≈ 6371 km, each zoom level halves the view
const EARTH_RADIUS_KM = 6371

/**
 * Minimal dark globe style with NASA GIBS Blue Marble and Black Marble tiles.
 * Black Marble is hidden by default — it will be used by the day/night blend
 * custom layer in Phase 1.
 */
function createGlobeStyle(): StyleSpecification {
  const initSun = getSunPosition(new Date())
  return {
    version: 8,
    name: 'sos-globe',
    projection: { type: 'globe' },
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
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#000000', 'background-opacity': 0 },
      },
      {
        id: 'blue-marble-layer',
        type: 'raster',
        source: 'blue-marble',
        paint: { 'raster-opacity': 1 },
      },
      {
        id: 'black-marble-layer',
        type: 'raster',
        source: 'black-marble',
        paint: { 'raster-opacity': 0 },
        layout: { visibility: 'none' },
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
 * MapLibre-based globe renderer.
 *
 * Spike A validates: globe projection, GIBS tile loading, basic interaction,
 * and coexistence with the existing Three.js renderer.
 */
export class MapRenderer {
  private map: MaplibreMap | null = null
  private container: HTMLElement | null = null
  private autoRotateInterval: number | null = null
  private autoRotating = false
  private earthLayer: EarthTileLayerControl | null = null

  /**
   * Initialize the MapLibre map inside the given container element.
   * The container must already be in the DOM with non-zero dimensions.
   */
  init(container: HTMLElement): void {
    this.container = container

    // MapLibre needs a wrapper div — the Three.js renderer appends a canvas
    // directly, but MapLibre manages its own canvas internally.
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
      attributionControl: false,
      preserveDrawingBuffer: true, // needed for captureViewContext / toDataURL
      maxPitch: 85,
    } as maplibregl.MapOptions)

    // Double-click resets to default view (Three.js behavior) instead of zoom in
    this.map.doubleClickZoom.disable()
    this.map.on('dblclick', () => {
      this.map?.flyTo({
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        bearing: 0,
        pitch: 0,
        duration: 2000,
      })
    })

    // Accessibility
    const canvas = this.map.getCanvas()
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', 'Interactive 3D globe visualization')
    canvas.id = 'globe-canvas'

    // Add earth tile layer (day/night, city lights, specular, clouds)
    this.map.on('load', () => {
      console.info('[MapRenderer] Map loaded with globe projection')
      this.earthLayer = createEarthTileLayer()
      this.map!.addLayer(this.earthLayer.layer as unknown as maplibregl.LayerSpecification)
      console.info('[MapRenderer] Earth tile layer added')
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

  private startAutoRotate(): void {
    this.stopAutoRotate()
    // Use easeTo with a long duration to smoothly rotate the bearing.
    // Re-trigger every 10 seconds to keep it going.
    const rotate = () => {
      if (!this.map || !this.autoRotating) return
      const currentBearing = this.map.getBearing()
      this.map.easeTo({
        bearing: currentBearing - 30,
        duration: 10000,
        easing: (t: number) => t, // linear
      })
    }
    rotate()
    this.autoRotateInterval = window.setInterval(rotate, 10000)

    // Stop auto-rotate on user interaction
    const stopOnInteraction = () => {
      if (this.autoRotating) {
        this.autoRotating = false
        this.stopAutoRotate()
      }
      this.map?.off('mousedown', stopOnInteraction)
      this.map?.off('touchstart', stopOnInteraction)
    }
    this.map?.on('mousedown', stopOnInteraction)
    this.map?.on('touchstart', stopOnInteraction)
  }

  private stopAutoRotate(): void {
    if (this.autoRotateInterval !== null) {
      clearInterval(this.autoRotateInterval)
      this.autoRotateInterval = null
    }
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
    if (!this.earthLayer) return
    this.earthLayer.setDatasetTexture(texture)
    // Hide the Blue Marble base layer when a dataset is active
    try { this.map?.setLayoutProperty('blue-marble-layer', 'visibility', 'none') } catch { /* noop */ }
    console.info('[MapRenderer] Dataset overlay set via custom layer sphere')
  }

  /**
   * Display a video on the globe via MapLibre VideoSource.
   * Returns a THREE.VideoTexture for playback controller compatibility.
   */
  setVideoTexture(video: HTMLVideoElement): THREE.VideoTexture {
    if (!this.map) {
      return new THREE.VideoTexture(video)
    }

    // Remove previous overlay
    this.removeDatasetOverlay()

    const bounds: [[number, number], [number, number], [number, number], [number, number]] =
      [[-180, 85], [180, 85], [180, -85], [-180, -85]]

    this.map.addSource('dataset-overlay', {
      type: 'video',
      urls: [video.src || video.currentSrc],
      coordinates: bounds,
    })

    this.map.addLayer({
      id: 'dataset-overlay-layer',
      type: 'raster',
      source: 'dataset-overlay',
      paint: { 'raster-opacity': 1 },
    })

    this.map.setLayoutProperty('blue-marble-layer', 'visibility', 'none')

    console.info('[MapRenderer] Video overlay added')

    // Return a VideoTexture for playback controller compatibility
    return new THREE.VideoTexture(video)
  }

  /** Remove the current dataset overlay. */
  private removeDatasetOverlay(): void {
    this.earthLayer?.clearDatasetTexture()
    // Restore Blue Marble base
    try {
      this.map?.setLayoutProperty('blue-marble-layer', 'visibility', 'visible')
    } catch { /* noop */ }
  }

  // --- Earth material stubs (Phase 1) ---

  /** Wait for the earth tile layer's textures (night lights, specular, clouds) to load. */
  async loadDefaultEarthMaterials(onProgress?: (fraction: number) => void): Promise<void> {
    // Wait for earth layer to be created (it's added on map 'load')
    if (!this.earthLayer) {
      console.debug('[MapRenderer] loadDefaultEarthMaterials: waiting for earth layer...')
      await new Promise<void>(resolve => {
        const check = () => {
          if (this.earthLayer) resolve()
          else setTimeout(check, 50)
        }
        check()
      })
    }
    console.debug('[MapRenderer] loadDefaultEarthMaterials: earth layer found, waiting for textures...')
    onProgress?.(0.2)
    await this.earthLayer!.ready
    console.debug('[MapRenderer] loadDefaultEarthMaterials: textures ready')
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
    // Restore Blue Marble base (may have been hidden for dataset overlay)
    try { this.map?.setLayoutProperty('blue-marble-layer', 'visibility', 'visible') } catch { /* noop */ }
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

  /** Clear sun override — does NOT re-show the layer (that's enableSunLighting's job). */
  disableSunLighting(): void {
    // Just clear the override; don't re-show the earth layer.
    // enableSunLighting() will restore visibility when returning to the default view.
  }

  /** Clouds are loaded by the earth tile layer automatically. Report complete. */
  async loadCloudOverlay(_url: string, _onProgress?: (fraction: number) => void): Promise<void> {
    _onProgress?.(1)
  }

  /** Cloud removal is handled by the earth tile layer. */
  removeCloudOverlay(): void {
    // Phase 1
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
