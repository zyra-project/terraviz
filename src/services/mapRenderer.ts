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
const DEFAULT_ZOOM = 1.0

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
        paint: { 'background-color': '#000000' },
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
    container.appendChild(mapDiv)

    this.map = new maplibregl.Map({
      container: mapDiv,
      style: createGlobeStyle(),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: false,
      preserveDrawingBuffer: true, // needed for captureViewContext / toDataURL
      maxPitch: 85,
    } as maplibregl.MapOptions)

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

  /** Fly the camera to a geographic location. */
  flyTo(lat: number, lon: number, zoom?: number): void {
    this.map?.flyTo({
      center: [lon, lat],
      zoom: zoom ?? this.map.getZoom(),
      duration: 2500,
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
   * Display an equirectangular image on the globe via MapLibre ImageSource.
   *
   * Tests two bound variants:
   *  - Standard Mercator bounds (+/-85°) — safe but may leave polar gaps
   *  - Full geographic bounds (+/-90°) — ideal if globe projection supports it
   *
   * Falls back to +/-85 if +/-90 throws.
   */
  updateTexture(texture: HTMLCanvasElement | HTMLImageElement): void {
    if (!this.map) return

    // Convert to a data URL if it's a canvas/image element
    let imageUrl: string
    if (texture instanceof HTMLCanvasElement) {
      imageUrl = texture.toDataURL('image/png')
    } else {
      // HTMLImageElement — use its src directly
      imageUrl = texture.src
    }

    // Remove previous dataset overlay if any
    this.removeDatasetOverlay()

    // Try full-globe bounds first (±90°), fall back to Mercator-safe (±85°)
    const fullBounds: [[number, number], [number, number], [number, number], [number, number]] =
      [[-180, 90], [180, 90], [180, -90], [-180, -90]]
    const safeBounds: [[number, number], [number, number], [number, number], [number, number]] =
      [[-180, 85], [180, 85], [180, -85], [-180, -85]]

    let bounds = fullBounds
    try {
      this.map.addSource('dataset-overlay', {
        type: 'image',
        url: imageUrl,
        coordinates: bounds,
      })
    } catch (e) {
      console.warn('[MapRenderer] ±90° bounds failed, falling back to ±85°:', e)
      bounds = safeBounds
      try { this.map.removeSource('dataset-overlay') } catch { /* noop */ }
      this.map.addSource('dataset-overlay', {
        type: 'image',
        url: imageUrl,
        coordinates: bounds,
      })
    }

    this.map.addLayer({
      id: 'dataset-overlay-layer',
      type: 'raster',
      source: 'dataset-overlay',
      paint: { 'raster-opacity': 1 },
    })

    // Hide the Blue Marble base layer when a dataset is active
    this.map.setLayoutProperty('blue-marble-layer', 'visibility', 'none')

    console.info('[MapRenderer] Image overlay added with bounds:', bounds)
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

  /** Remove the current dataset overlay source and layer. */
  private removeDatasetOverlay(): void {
    if (!this.map) return
    try {
      if (this.map.getLayer('dataset-overlay-layer')) {
        this.map.removeLayer('dataset-overlay-layer')
      }
      if (this.map.getSource('dataset-overlay')) {
        this.map.removeSource('dataset-overlay')
      }
    } catch { /* source/layer may not exist */ }

    // Restore Blue Marble base
    try {
      this.map.setLayoutProperty('blue-marble-layer', 'visibility', 'visible')
    } catch { /* noop */ }
  }

  // --- Earth material stubs (Phase 1) ---

  /** Wait for the earth tile layer's textures (night lights, specular, clouds) to load. */
  async loadDefaultEarthMaterials(onProgress?: (fraction: number) => void): Promise<void> {
    // Wait for earth layer to be created (it's added on map 'load')
    if (!this.earthLayer) {
      await new Promise<void>(resolve => {
        const check = () => {
          if (this.earthLayer) resolve()
          else setTimeout(check, 50)
        }
        check()
      })
    }
    onProgress?.(0.2)
    await this.earthLayer!.ready
    onProgress?.(1)
  }

  /** Hide earth effects (day/night, city lights, specular, clouds) when a dataset is active. */
  removeNightLights(): void {
    this.earthLayer?.setVisible(false)
  }

  /** Update sun direction and re-show the earth tile layer. */
  enableSunLighting(lat: number, lng: number): void {
    this.earthLayer?.setVisible(true)
    this.earthLayer?.setSunPosition(lat, lng)
  }

  /** Clear sun override — reverts to real-time sun position. */
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
