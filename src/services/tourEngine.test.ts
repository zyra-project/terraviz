import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TourFile, TourCallbacks, GlobeRenderer } from '../types'

// Mock the tourUI module — no DOM in test environment
vi.mock('../ui/tourUI', () => ({
  showTourTextBox: vi.fn(),
  hideTourTextBox: vi.fn(),
  hideAllTourTextBoxes: vi.fn(),
  updateTourProgress: vi.fn(),
  showTourImage: vi.fn(),
  hideTourImage: vi.fn(),
  hideAllTourImages: vi.fn(),
  showTourVideo: vi.fn(),
  hideTourVideo: vi.fn(),
  hideAllTourVideos: vi.fn(),
  showTourPopup: vi.fn(),
  hideTourPopup: vi.fn(),
  hideAllTourPopups: vi.fn(),
  showTourQuestion: vi.fn(),
  hideAllTourQuestions: vi.fn(),
  showTourControls: vi.fn(),
  hideTourControls: vi.fn(),
  updateTourPlayState: vi.fn(),
  showTourLegend: vi.fn(),
  hideTourLegend: vi.fn(),
}))

// Mock logger to suppress output
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Mock device capability
vi.mock('../utils/deviceCapability', () => ({
  getCloudTextureUrl: () => 'https://example.com/clouds.jpg',
}))

import { TourEngine } from './tourEngine'

// --- Helpers ---

function makeRenderer(): GlobeRenderer {
  return {
    flyTo: vi.fn(() => Promise.resolve()),
    toggleAutoRotate: vi.fn(() => true),
    updateTexture: vi.fn(),
    setVideoTexture: vi.fn(() => ({ needsUpdate: false, dispose: vi.fn() })),
    setLatLngCallbacks: vi.fn(),
    setCanvasDescription: vi.fn(),
    loadDefaultEarthMaterials: vi.fn(() => Promise.resolve()),
    removeNightLights: vi.fn(),
    enableSunLighting: vi.fn(),
    disableSunLighting: vi.fn(),
    loadCloudOverlay: vi.fn(() => Promise.resolve()),
    removeCloudOverlay: vi.fn(),
    dispose: vi.fn(),
    toggleLabels: vi.fn(() => true),
    toggleBoundaries: vi.fn(() => true),
    addMarker: vi.fn(() => null),
    clearMarkers: vi.fn(),
    setRotationRate: vi.fn(),
  }
}

function makeCallbacks(overrides: Partial<TourCallbacks> = {}): TourCallbacks {
  const renderer = makeRenderer()
  return {
    loadDataset: vi.fn(() => Promise.resolve()),
    unloadAllDatasets: vi.fn(() => Promise.resolve()),
    unloadDatasetAt: vi.fn(() => Promise.resolve()),
    setEnvView: vi.fn(() => Promise.resolve()),
    getRenderer: vi.fn(() => renderer),
    togglePlayPause: vi.fn(),
    isPlaying: vi.fn(() => false),
    setPlaybackRate: vi.fn(),
    onTourEnd: vi.fn(),
    onStop: vi.fn(),
    announce: vi.fn(),
    resolveMediaUrl: vi.fn((f: string) => `https://base/${f}`),
    ...overrides,
  }
}

function makeTour(tasks: any[]): TourFile {
  return { tourTasks: tasks }
}

/**
 * Flush the microtask queue so the async engine loop can advance.
 * Uses Promise.resolve() chains (not setTimeout) to avoid
 * interference with vi.useFakeTimers().
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

// --- Tests ---

describe('TourEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('basic lifecycle', () => {
    it('starts in stopped state', () => {
      const engine = new TourEngine(makeTour([]), makeCallbacks())
      expect(engine.state).toBe('stopped')
      expect(engine.currentIndex).toBe(0)
      expect(engine.totalSteps).toBe(0)
    })

    it('completes an empty tour immediately', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([]), cb)
      await engine.play()
      expect(engine.state).toBe('stopped')
      expect(cb.onTourEnd).toHaveBeenCalledOnce()
    })

    it('plays through instant tasks sequentially', async () => {
      const renderer = makeRenderer()
      const cb = makeCallbacks({ getRenderer: () => renderer })
      const engine = new TourEngine(makeTour([
        { envShowDayNightLighting: 'on' },
        { setGlobeRotationRate: 0.5 },
      ]), cb)

      await engine.play()
      expect(engine.state).toBe('stopped')
      expect(cb.onTourEnd).toHaveBeenCalledOnce()
      expect(renderer.enableSunLighting).toHaveBeenCalled()
      expect(renderer.setRotationRate).toHaveBeenCalledWith(0.5)
    })
  })

  describe('pauseForInput', () => {
    it('pauses the tour and resumes on play()', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { envShowDayNightLighting: 'on' },
        { pauseForInput: '' },
        { setGlobeRotationRate: 0.5 },
      ]), cb)

      // Start — should pause at step 1
      const playPromise = engine.play()
      await flush()

      expect(engine.state).toBe('paused')
      expect(engine.currentIndex).toBe(1)
      expect(cb.announce).toHaveBeenCalledWith('Tour paused — press play to continue')

      // Resume
      await engine.play()
      await playPromise

      expect(engine.state).toBe('stopped')
      expect(cb.onTourEnd).toHaveBeenCalledOnce()
    })
  })

  describe('pauseSeconds / pauseSec', () => {
    it('resumes after timeout', async () => {
      vi.useFakeTimers()
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { pauseSec: 2 },
      ]), cb)

      const playPromise = engine.play()
      await vi.advanceTimersByTimeAsync(2000)
      await playPromise

      expect(engine.state).toBe('stopped')
      expect(cb.onTourEnd).toHaveBeenCalledOnce()
    })

    it('can be skipped via next()', async () => {
      vi.useFakeTimers()
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { pauseSec: 10 },
        { setGlobeRotationRate: 1.0 },
      ]), cb)

      const playPromise = engine.play()
      // Let the engine reach the pauseSec task
      await vi.advanceTimersByTimeAsync(0)

      // Skip the 10-second pause
      engine.next()
      await vi.advanceTimersByTimeAsync(0)
      await playPromise

      expect(engine.state).toBe('stopped')
      expect(cb.onTourEnd).toHaveBeenCalledOnce()
    })
  })

  describe('next()', () => {
    it('advances past a pauseForInput', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { pauseForInput: '' },
        { envShowDayNightLighting: 'on' },
        { pauseForInput: '' },
      ]), cb)

      const playPromise = engine.play()
      await flush()
      expect(engine.state).toBe('paused')
      expect(engine.currentIndex).toBe(0)

      // Skip to next
      engine.next()
      await flush()

      // Should now be paused at step 2
      expect(engine.state).toBe('paused')
      expect(engine.currentIndex).toBe(2)

      // Finish
      await engine.play()
      await playPromise
      expect(cb.onTourEnd).toHaveBeenCalledOnce()
    })
  })

  describe('prev()', () => {
    it('replays from the previous segment start', async () => {
      const renderer = makeRenderer()
      const cb = makeCallbacks({ getRenderer: () => renderer })
      const engine = new TourEngine(makeTour([
        { envShowDayNightLighting: 'on' },
        { pauseForInput: '' },
        { envShowClouds: 'on' },
        { pauseForInput: '' },
      ]), cb)

      const playPromise = engine.play()
      await flush()
      // Paused at step 1
      expect(engine.currentIndex).toBe(1)

      // Resume to second pause
      engine.play()
      await flush()
      // Paused at step 3
      expect(engine.currentIndex).toBe(3)

      // Go back — should replay from step 0 (segment before first pause)
      engine.prev()
      await flush()
      // Should be paused at step 1 again
      expect(engine.currentIndex).toBe(1)
      expect(engine.state).toBe('paused')

      // Finish the tour — resume past the second pause, then let it
      // run to completion.
      engine.play()
      await flush()
      engine.play()
      await playPromise
      expect(cb.onTourEnd).toHaveBeenCalledOnce()
    })
  })

  describe('stop()', () => {
    it('stops a playing tour', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { pauseForInput: '' },
        { envShowDayNightLighting: 'on' },
      ]), cb)

      engine.play()
      await flush()
      expect(engine.state).toBe('paused')

      engine.stop()
      expect(engine.state).toBe('stopped')
      // stop() does NOT call onTourEnd — caller handles cleanup
      expect(cb.onTourEnd).not.toHaveBeenCalled()
    })

    it('resets rotation rate to 0 when the tour modified it', async () => {
      const renderer = makeRenderer()
      const cb = makeCallbacks({ getRenderer: () => renderer })
      const engine = new TourEngine(makeTour([
        { setGlobeRotationRate: 0.5 },
        { pauseForInput: '' },
      ]), cb)

      engine.play()
      await flush()
      expect(engine.state).toBe('paused')
      expect(renderer.setRotationRate).toHaveBeenCalledWith(0.5)

      engine.stop()
      expect(renderer.setRotationRate).toHaveBeenLastCalledWith(0)
    })

    it('leaves rotation rate alone when the tour never touched it', async () => {
      const renderer = makeRenderer()
      const cb = makeCallbacks({ getRenderer: () => renderer })
      const engine = new TourEngine(makeTour([
        { pauseForInput: '' },
      ]), cb)

      engine.play()
      await flush()
      engine.stop()
      expect(renderer.setRotationRate).not.toHaveBeenCalled()
    })

    it('resets rotation rate after a natural tour completion too', async () => {
      const renderer = makeRenderer()
      const cb = makeCallbacks({ getRenderer: () => renderer })
      const engine = new TourEngine(makeTour([
        { setGlobeRotationRate: 0.5 },
      ]), cb)

      await engine.play()
      expect(cb.onTourEnd).toHaveBeenCalledOnce()
      expect(renderer.setRotationRate).toHaveBeenLastCalledWith(0)
    })
  })

  describe('task dispatch', () => {
    it('dispatches flyTo to renderer', async () => {
      const renderer = makeRenderer()
      const cb = makeCallbacks({ getRenderer: () => renderer })
      const engine = new TourEngine(makeTour([
        { flyTo: { lat: 40, lon: -105, altmi: 500, animated: true } },
      ]), cb)

      await engine.play()
      expect(renderer.flyTo).toHaveBeenCalledWith(40, -105, 500 * 1.60934 * 0.2)
    })

    it('dispatches loadDataset to callback', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { loadDataset: { id: 'TEST_123' } },
      ]), cb)

      await engine.play()
      // Phase 3 extended loadDataset to pass an options object with
      // the routed slot (defaulting to 0 when no worldIndex).
      expect(cb.loadDataset).toHaveBeenCalledWith('TEST_123', { slot: 0 })
    })

    it('dispatches unloadAllDatasets to callback', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { unloadAllDatasets: '' },
      ]), cb)

      await engine.play()
      expect(cb.unloadAllDatasets).toHaveBeenCalledOnce()
    })

    it('dispatches datasetAnimation with frameRate', async () => {
      const cb = makeCallbacks({ isPlaying: vi.fn(() => false) })
      const engine = new TourEngine(makeTour([
        { datasetAnimation: { animation: 'on', frameRate: '5 fps' } },
      ]), cb)

      await engine.play()
      expect(cb.setPlaybackRate).toHaveBeenCalledWith(expect.closeTo(5 / 30, 3))
      expect(cb.togglePlayPause).toHaveBeenCalledOnce()
    })

    it('dispatches worldBorder object format', async () => {
      const renderer = makeRenderer()
      const cb = makeCallbacks({ getRenderer: () => renderer })
      const engine = new TourEngine(makeTour([
        { worldBorder: { worldBorders: 'on', worldBorderColor: 'black' } },
      ]), cb)

      await engine.play()
      expect(renderer.toggleBoundaries).toHaveBeenCalledWith(true)
      expect(renderer.toggleLabels).toHaveBeenCalledWith(true)
    })

    it('dispatches envShowWorldBorder string format', async () => {
      const renderer = makeRenderer()
      const cb = makeCallbacks({ getRenderer: () => renderer })
      const engine = new TourEngine(makeTour([
        { envShowWorldBorder: 'off' },
      ]), cb)

      await engine.play()
      expect(renderer.toggleBoundaries).toHaveBeenCalledWith(false)
    })

    it('handles resetCameraAndZoomOut alias', async () => {
      const renderer = makeRenderer()
      // The renderer needs a getMap method for resetCameraZoomOut
      ;(renderer as any).getMap = vi.fn(() => ({
        once: (_: string, cb: () => void) => cb(),
        flyTo: vi.fn(),
      }))
      const cb = makeCallbacks({ getRenderer: () => renderer })
      const engine = new TourEngine(makeTour([
        { resetCameraAndZoomOut: '' },
      ]), cb)

      await engine.play()
      expect((renderer as any).getMap).toHaveBeenCalled()
    })

    it('handles tourPlayerWindow alias', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { tourPlayerWindow: 'off' },
      ]), cb)

      await engine.play()
      // Should not throw — tourPlayerWindow is a valid task
      expect(engine.state).toBe('stopped')
    })

    it('skips unknown tasks gracefully', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { unknownTask: 'whatever' } as any,
      ]), cb)

      await engine.play()
      expect(engine.state).toBe('stopped')
      expect(cb.onTourEnd).toHaveBeenCalledOnce()
    })
  })

  describe('loopToBeginning', () => {
    it('restarts the tour from the beginning', async () => {
      const renderer = makeRenderer()
      const cb = makeCallbacks({ getRenderer: () => renderer })
      // Use a counter to break out of the loop on second pass
      let passCount = 0
      const originalEnableSun = renderer.enableSunLighting as ReturnType<typeof vi.fn>
      originalEnableSun.mockImplementation(() => {
        passCount++
        if (passCount >= 2) {
          // Stop the engine on second pass to avoid infinite loop
          engine.stop()
        }
      })

      const engine = new TourEngine(makeTour([
        { envShowDayNightLighting: 'on' },
        { loopToBeginning: '' },
      ]), cb)

      await engine.play()
      expect(passCount).toBe(2)
    })
  })

  describe('addPlacemark / hidePlacemark', () => {
    it('adds and removes placemarks via renderer', async () => {
      const marker = { remove: vi.fn() }
      const renderer = makeRenderer()
      ;(renderer.addMarker as ReturnType<typeof vi.fn>).mockReturnValue(marker)
      const cb = makeCallbacks({ getRenderer: () => renderer })

      const engine = new TourEngine(makeTour([
        { addPlacemark: { placemarkID: 'p1', lat: 10, lon: 20, name: 'Test' } },
        { hidePlacemark: 'p1' },
      ]), cb)

      await engine.play()
      expect(renderer.addMarker).toHaveBeenCalledWith(10, 20, 'Test')
      expect(marker.remove).toHaveBeenCalledOnce()
    })

    it('clears all placemarks on stop', async () => {
      const marker = { remove: vi.fn() }
      const renderer = makeRenderer()
      ;(renderer.addMarker as ReturnType<typeof vi.fn>).mockReturnValue(marker)
      const cb = makeCallbacks({ getRenderer: () => renderer })

      const engine = new TourEngine(makeTour([
        { addPlacemark: { placemarkID: 'p1', lat: 10, lon: 20 } },
        { pauseForInput: '' },
      ]), cb)

      engine.play()
      await flush()
      engine.stop()
      expect(marker.remove).toHaveBeenCalledOnce()
    })
  })

  describe('concurrent safety', () => {
    it('play() is idempotent when already playing', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { pauseForInput: '' },
      ]), cb)

      engine.play()
      await flush()
      expect(engine.state).toBe('paused')

      // Resume
      engine.play()
      // Call play again while already playing — should be a no-op
      engine.play()
      await flush()

      // Should still complete normally
      expect(cb.onTourEnd).toHaveBeenCalledOnce()
    })
  })

  // ────────────────────────────────────────────────────────────
  // Phase 3 — setEnvView, worldIndex routing, unloadDataset
  // ────────────────────────────────────────────────────────────

  describe('setEnvView', () => {
    it('parses "1globe" and calls setEnvView callback with layout 1', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { setEnvView: '1globe' },
      ]), cb)
      await engine.play()

      expect(cb.setEnvView).toHaveBeenCalledWith({ layout: '1' })
    })

    it('parses "2globes" to layout "2h"', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { setEnvView: '2globes' },
      ]), cb)
      await engine.play()

      expect(cb.setEnvView).toHaveBeenCalledWith({ layout: '2h' })
    })

    it('parses "4globes" to layout "4"', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { setEnvView: '4globes' },
      ]), cb)
      await engine.play()

      expect(cb.setEnvView).toHaveBeenCalledWith({ layout: '4' })
    })

    it('parses GLOBE / SPHERE aliases case-insensitively', async () => {
      const cb1 = makeCallbacks()
      new TourEngine(makeTour([{ setEnvView: 'GLOBE' }]), cb1).play()
      await flush()
      expect(cb1.setEnvView).toHaveBeenCalledWith({ layout: '1' })

      const cb2 = makeCallbacks()
      new TourEngine(makeTour([{ setEnvView: 'sphere' }]), cb2).play()
      await flush()
      expect(cb2.setEnvView).toHaveBeenCalledWith({ layout: '1' })
    })

    it('remaps legacy flat view names to single-globe', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { setEnvView: 'FLAT_4' },
      ]), cb)
      await engine.play()

      expect(cb.setEnvView).toHaveBeenCalledWith({ layout: '1' })
    })

    it('defaults to single-globe on unknown view names', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { setEnvView: 'bogus_view_value' },
      ]), cb)
      await engine.play()

      expect(cb.setEnvView).toHaveBeenCalledWith({ layout: '1' })
    })
  })

  describe('loadDataset with worldIndex routing', () => {
    it('translates worldIndex 1 to slot 0', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { loadDataset: { id: 'ID_A', datasetID: 'a', worldIndex: 1 } },
      ]), cb)
      await engine.play()

      expect(cb.loadDataset).toHaveBeenCalledWith('ID_A', { slot: 0 })
    })

    it('translates worldIndex 2 to slot 1', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { loadDataset: { id: 'ID_B', datasetID: 'b', worldIndex: 2 } },
      ]), cb)
      await engine.play()

      expect(cb.loadDataset).toHaveBeenCalledWith('ID_B', { slot: 1 })
    })

    it('defaults to slot 0 when worldIndex is omitted', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { loadDataset: { id: 'ID_C' } },
      ]), cb)
      await engine.play()

      expect(cb.loadDataset).toHaveBeenCalledWith('ID_C', { slot: 0 })
    })

    it('clamps negative or zero worldIndex to slot 0', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { loadDataset: { id: 'ID_D', worldIndex: 0 } },
        { loadDataset: { id: 'ID_E', worldIndex: -3 } },
      ]), cb)
      await engine.play()

      expect(cb.loadDataset).toHaveBeenNthCalledWith(1, 'ID_D', { slot: 0 })
      expect(cb.loadDataset).toHaveBeenNthCalledWith(2, 'ID_E', { slot: 0 })
    })
  })

  describe('unloadDataset by handle', () => {
    it('looks up a datasetID handle and calls unloadDatasetAt with the recorded slot', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { loadDataset: { id: 'ID_F', datasetID: 'foo', worldIndex: 2 } },
        { unloadDataset: 'foo' },
      ]), cb)
      await engine.play()

      expect(cb.unloadDatasetAt).toHaveBeenCalledWith(1)
    })

    it('is a no-op on unknown handles (warns and skips)', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { unloadDataset: 'never_loaded' },
      ]), cb)
      await engine.play()

      expect(cb.unloadDatasetAt).not.toHaveBeenCalled()
    })

    it('removes the handle from the map after unload so subsequent lookups miss', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { loadDataset: { id: 'ID_G', datasetID: 'bar', worldIndex: 1 } },
        { unloadDataset: 'bar' },
        { unloadDataset: 'bar' }, // second call should be a no-op
      ]), cb)
      await engine.play()

      expect(cb.unloadDatasetAt).toHaveBeenCalledTimes(1)
    })

    it('unloadAllDatasets clears the handle map', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { loadDataset: { id: 'ID_H', datasetID: 'baz', worldIndex: 1 } },
        { unloadAllDatasets: '' },
        { unloadDataset: 'baz' }, // should miss — map was cleared
      ]), cb)
      await engine.play()

      expect(cb.unloadAllDatasets).toHaveBeenCalledTimes(1)
      expect(cb.unloadDatasetAt).not.toHaveBeenCalled()
    })
  })

  describe('full setEnvView round-trip sequence', () => {
    it('exercises the reference tour flow: load → setEnvView 2globes → load into slot 2 → unloadAll → setEnvView 1globe', async () => {
      const cb = makeCallbacks()
      const engine = new TourEngine(makeTour([
        { loadDataset: { id: 'ID_I', datasetID: 'd1', worldIndex: 1 } },
        { setEnvView: '2globes' },
        { loadDataset: { id: 'ID_J', datasetID: 'd2', worldIndex: 2 } },
        { unloadAllDatasets: '' },
        { setEnvView: '1globe' },
      ]), cb)
      await engine.play()

      expect(cb.loadDataset).toHaveBeenNthCalledWith(1, 'ID_I', { slot: 0 })
      expect(cb.setEnvView).toHaveBeenNthCalledWith(1, { layout: '2h' })
      expect(cb.loadDataset).toHaveBeenNthCalledWith(2, 'ID_J', { slot: 1 })
      expect(cb.unloadAllDatasets).toHaveBeenCalledTimes(1)
      expect(cb.setEnvView).toHaveBeenNthCalledWith(2, { layout: '1' })
    })
  })
})
