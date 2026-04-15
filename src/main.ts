/**
 * Main application entry point
 *
 * Load a dataset via URL query param: ?dataset=INTERNAL_SOS_768
 * No dataset param = just the default Earth globe
 */

import { MapRenderer } from './services/mapRenderer'
import { ViewportManager, type ViewLayout } from './services/viewportManager'

// CSS entry point — all component styles imported in dependency order.
// Vite bundles these into a single <link> in the production build.
import './styles/index.css'

import { HLSService } from './services/hlsService'
import { dataService } from './services/dataService'
import { formatDate, videoTimeToDate, dateToVideoTime, isSubDailyPeriod, getSunPosition, inferDisplayInterval } from './utils/time'
import { logger } from './utils/logger'
import type { AppState, VideoTextureHandle, TourFile, Dataset } from './types'

// Extracted modules
import { showBrowseUI, hideBrowseUI, collapseBrowseUI } from './ui/browseUI'
import { initDownloadUI } from './ui/downloadUI'
import { updateMapControlsPosition } from './ui/mapControlsUI'
import { initToolsMenu, syncToolsMenuState, syncToolsMenuLayout, pulseBrowseButton } from './ui/toolsMenuUI'
import { initChatUI, openChat, openChatSettings, notifyDatasetChanged, showChatTrigger, hideChatTrigger, closeChat, flushPendingGlobeActions } from './ui/chatUI'
import { loadViewPreferences, saveViewPreferences, type ViewPreferences } from './utils/viewPreferences'
import { initHelpUI, setActiveDataset as setHelpActiveDataset } from './ui/helpUI'
import {
  createPlaybackState, startPlaybackLoop, stopPlaybackLoop,
  togglePlayPause, rewind, fastForward, stepFrame, onScrub,
  updatePlayButton, toggleCaptions, resetPlaybackState, initPlaybackPositioning,
  seekToDate,
  type PlaybackState,
} from './ui/playbackController'
import {
  loadImageDataset, loadVideoDataset, displayDatasetInfo,
} from './services/datasetLoader'
import { TourEngine } from './services/tourEngine'
import { showTourControls, hideTourControls, hideAllTourTextBoxes, hideAllTourImages, hideAllTourVideos, hideAllTourPopups, hideAllTourQuestions } from './ui/tourUI'
import { initLegendForDataset, clearLegendCache, loadConfig } from './services/docentService'
import { isMobile, IS_MOBILE_NATIVE, getCloudTextureUrl } from './utils/deviceCapability'
import { initDeepLinks } from './services/deepLinkService'
import { initVrButton } from './ui/vrButton'

// Phase 5: set a body class so CSS can target mobile-native adaptations
// (larger touch targets, bottom sheets, etc.) without JS per-component.
if (IS_MOBILE_NATIVE) {
  document.body.classList.add('mobile-native')
}

// --- App constants ---
const CLOUD_TEXTURE_URL = getCloudTextureUrl()
const EARTH_TEXTURE_WEIGHT = 0.8
const CLOUD_TEXTURE_WEIGHT = 0.2
const LOADING_BASE_PROGRESS = 20
const LOADING_TEXTURE_RANGE = 70
const LOADING_HIDE_DELAY_MS = 300

/**
 * Root application class that boots the WebGL globe, loads datasets,
 * and orchestrates all UI subsystems (browse panel, chat, playback controls).
 *
 * Lifecycle: constructed once on DOMContentLoaded, then {@link initialize}
 * fetches the dataset catalog and either displays the default Earth or
 * loads a dataset specified by the `?dataset=` URL parameter.
 */
/**
 * Per-panel dataset + video state. Length is kept in sync with the
 * viewport count by onLayoutChange callbacks from ViewportManager.
 * Slot 0 is always the first panel; the primary index (which slot
 * drives the playback transport UI) lives inside ViewportManager.
 */
interface PanelState {
  dataset: Dataset | null
  hlsService: HLSService | null
  videoTexture: VideoTextureHandle | null
}

function createPanelState(): PanelState {
  return { dataset: null, hlsService: null, videoTexture: null }
}

class InteractiveSphere {
  private appState: AppState = {
    datasets: [],
    currentDataset: null,
    isLoading: false,
    error: null,
    timeLabel: '--',
    isPlaying: false,
    currentFrame: 0,
    totalFrames: 0
  }

  private readonly isMobile = isMobile()

  private viewports: ViewportManager = new ViewportManager()

  /** Per-panel dataset state (one entry per active viewport). */
  private panelStates: PanelState[] = []

  /** Listener attached to the primary video for sibling sync. */
  private primaryVideoSyncListeners: Array<{ event: string; handler: EventListener }> = []
  private primaryVideoSyncTarget: HTMLVideoElement | null = null
  /** Interval ID for the periodic drift-correction timer. */
  private driftCheckInterval: ReturnType<typeof setInterval> | null = null

  /**
   * Convenience getter returning the primary viewport's renderer.
   * Most call sites operate on a single "the renderer" for the
   * primary panel; per-slot operations go through `this.viewports`
   * and `this.panelStates` directly.
   */
  private get renderer(): MapRenderer | null {
    return this.viewports.getPrimary()
  }

  /** Primary panel's HLS service, if any. */
  private get hlsService(): HLSService | null {
    return this.panelStates[this.viewports.getPrimaryIndex()]?.hlsService ?? null
  }

  /** Primary panel's video texture, if any. */
  private get videoTexture(): VideoTextureHandle | null {
    return this.panelStates[this.viewports.getPrimaryIndex()]?.videoTexture ?? null
  }

  private playback: PlaybackState = createPlaybackState()
  private loadingHideTimer: ReturnType<typeof setTimeout> | null = null
  private loadGeneration = 0 // guards against concurrent dataset loads
  private tourEngine: TourEngine | null = null
  private tourIsStandalone = false // true when tour was loaded as a tour/json dataset (not runTourOnLoad)

  /** Persisted view preferences: info panel + legend visibility. */
  private viewPrefs: ViewPreferences = loadViewPreferences()

  /**
   * Which slot's dataset the info panel currently displays.
   *
   * - `null` → follow the primary. The info panel re-renders whenever
   *   the primary changes.
   * - A slot index → "pinned" to that slot. The user explicitly picked
   *   a non-primary dataset from the picker dropdown. Resets to null
   *   whenever the primary changes (via `onViewportPrimaryChange`) so
   *   a fresh promotion doesn't silently keep pointing at an old slot.
   */
  private infoDisplayOverride: number | null = null

  /** True once the info-selector change handler has been wired. */
  private infoSelectorWired = false

  /**
   * Boot the application: create the WebGL renderer, fetch the dataset
   * catalog, and either load a URL-specified dataset or show the default
   * Earth with the browse panel.
   */
  async initialize(): Promise<void> {
    try {
      this.setLoading(true)
      this.setLoadingStatus('Starting up\u2026', 5)

      if (!this.checkWebGLSupport()) return

      const container = document.getElementById('container')
      if (!container) throw new Error('Container element not found')
      const mapGrid = document.getElementById('map-grid')
      if (!mapGrid) throw new Error('Map grid element not found')

      this.setLoadingStatus('Creating renderer\u2026', 15)
      const initialLayout = this.getInitialLayoutFromUrl()
      this.viewports.init(mapGrid, initialLayout, {
        onLayoutChange: (newCount, oldCount) => this.onViewportLayoutChange(newCount, oldCount),
        onPrimaryChange: (newIdx, oldIdx) => this.onViewportPrimaryChange(newIdx, oldIdx),
      })
      // Parallel per-panel dataset state, one entry per viewport.
      this.panelStates = Array.from({ length: this.viewports.getPanelCount() }, createPanelState)
      const primary = this.viewports.getPrimary()
      if (!primary) throw new Error('Viewport manager failed to create a primary renderer')
      initToolsMenu(this.viewports, {
        onSetLayout: (layout) => this.viewports.setLayout(layout),
        onOpenBrowse: () => this.openBrowsePanel(),
        onOpenOrbitSettings: () => openChatSettings(),
        onToggleDatasetInfo: (visible) => this.setDatasetInfoVisible(visible),
        onToggleLegend: (visible) => this.setLegendVisible(visible),
        announce: (msg) => this.announce(msg),
        getCurrentDataset: () => this.appState.currentDataset ?? null,
      })
      // Apply persisted view prefs to the toolbar button state now
      // that the toolbar exists.
      syncToolsMenuState({
        datasetInfo: this.viewPrefs.infoPanelVisible,
        legend: this.viewPrefs.legendVisible,
      })
      initDownloadUI().catch(err => logger.warn('[App] Download UI init failed:', err))
      initHelpUI()
      logger.info('[App] Using MapLibre renderer (layout: %s)', initialLayout)

      // Wire up lat/lng display (bind to primary; secondary panels don't
      // update the display — it follows the primary's mousemove)
      const latlngEl = document.getElementById('latlng-display')
      if (latlngEl) {
        primary.setLatLngCallbacks(
          (lat: number, lng: number) => {
            const ns = lat >= 0 ? 'N' : 'S'
            const ew = lng >= 0 ? 'E' : 'W'
            latlngEl.textContent = `${Math.abs(lat).toFixed(1)}° ${ns}, ${Math.abs(lng).toFixed(1)}° ${ew}`
            latlngEl.classList.remove('hidden')
          },
          () => {
            latlngEl.classList.add('hidden')
          }
        )
      }

      // Fetch datasets, then load from URL if specified
      this.setLoadingStatus('Loading datasets\u2026', 30)
      await this.loadDatasets()

      // Initialize digital docent chat (available on all views)
      this.initChat()

      // Enter VR button — feature-gated internally; hides itself on
      // non-WebXR browsers and warm-loads Three.js in the background
      // on devices that can enter VR.
      void this.initVrButton()

      const datasetId = this.getDatasetIdFromUrl()
      if (datasetId) {
        this.setLoadingStatus('Loading dataset\u2026', 50)
        await this.loadDataset(datasetId)
        this.setLoading(false)
        showChatTrigger()
        // In multi-viewport mode, pre-render the browse panel in its
        // collapsed state so users can slide it open to load datasets
        // into the remaining panels, and pulse the Browse button so
        // they notice where to click. In single-view mode we don't —
        // the URL-specified dataset is the only thing the user wanted.
        if (this.viewports.getPanelCount() > 1) {
          showBrowseUI(this.appState.datasets, {
            onSelectDataset: (id) => this.selectDatasetFromBrowse(id),
            announce: (msg) => this.announce(msg),
            isMobile: this.isMobile,
            onOpenChat: (query) => this.openChatWithQuery(query),
          })
          collapseBrowseUI()
          pulseBrowseButton()
        }
      } else {
        this.setLoadingStatus('Loading Earth textures\u2026', 20)
        const cloudUrl = CLOUD_TEXTURE_URL

        let earthFraction = 0
        let cloudFraction = 0
        const updateProgress = () => {
          const combined = earthFraction * EARTH_TEXTURE_WEIGHT + cloudFraction * CLOUD_TEXTURE_WEIGHT
          this.setLoadingStatus('Loading Earth textures\u2026', LOADING_BASE_PROGRESS + Math.round(combined * LOADING_TEXTURE_RANGE))
        }
        // Earth materials are a visual enhancement (day/night, clouds,
        // specular) — if loading them times out or fails (common in
        // multi-viewport mode on mobile when 4 WebGL contexts compete
        // for bandwidth), the base tiles still render fine. Don't let
        // the failure abort the init flow and block the browse panel.
        try {
          await Promise.all([
            primary.loadDefaultEarthMaterials((f: number) => { earthFraction = f; updateProgress() }),
            primary.loadCloudOverlay(cloudUrl, (f: number) => { cloudFraction = f; updateProgress() })
          ])
          const sun = getSunPosition(new Date())
          primary.enableSunLighting(sun.lat, sun.lng)
        } catch (err) {
          logger.warn('[App] Earth material loading failed — continuing without day/night overlay:', err)
        }

        this.setLoading(false)
        // Render the browse panel (populates category filters and
        // dataset cards) then decide whether to leave it visible.
        // On mobile (≤768px) the panel is full-width and would hide
        // the globe entirely — start closed on that breakpoint and
        // pulse the Browse button briefly so users notice where
        // datasets live. Desktop keeps the existing side-panel UX.
        showBrowseUI(this.appState.datasets, {
          onSelectDataset: (id) => this.selectDatasetFromBrowse(id),
          announce: (msg) => this.announce(msg),
          isMobile: this.isMobile,
          onOpenChat: (query) => this.openChatWithQuery(query),
        })
        if (window.matchMedia('(max-width: 768px)').matches) {
          hideBrowseUI()
        }
        pulseBrowseButton()
      }
    } catch (error) {
      this.setLoading(false)
      this.setError(error instanceof Error ? error.message : 'Unknown error')
    }

    // Phase 5: listen for deep links unconditionally so the app can
    // load a dataset when opened from an external URL at any time,
    // not just when a ?dataset= query param is present at startup.
    initDeepLinks((id) => {
      this.loadDataset(id)
    })
  }

  /** Extract the `dataset` query parameter from the current URL. */
  private getDatasetIdFromUrl(): string | null {
    const params = new URLSearchParams(window.location.search)
    return params.get('dataset')
  }

  /**
   * Read the initial viewport layout from the `?setview=` query param.
   * Phase 1 defaults to `'1'` (single globe); the param is a dev flag
   * for smoke-testing multi-viewport before the layout picker ships.
   * Unknown values fall back to single-view.
   */
  private getInitialLayoutFromUrl(): ViewLayout {
    const raw = new URLSearchParams(window.location.search).get('setview')
    if (raw === '1' || raw === '2h' || raw === '2v' || raw === '4') return raw
    // Legacy shorthand: ?setview=2 → 2h, ?setview=4 → 4
    if (raw === '2') return '2h'
    return '1'
  }

  /** Fetch the dataset catalog from the data service and store in app state. */
  private async loadDatasets(): Promise<void> {
    const datasets = await dataService.fetchDatasets()
    this.appState.datasets = datasets
  }

  /** Load a dataset by ID onto the globe, tearing down any previous video stream first. Uses a generation counter to safely ignore superseded loads. */
  private async loadDataset(datasetId: string): Promise<void> {
    const gen = this.loadGeneration
    logger.debug('[App] loadDataset start:', datasetId)
    stopPlaybackLoop(this.playback)
    this.appState.isPlaying = false
    resetPlaybackState(this.playback)

    // Stop any active tour (but don't trigger full goHome — let the new load proceed)
    this.stopTour()

    // Tear down the previous video *before* starting the new load so the old
    // HLS stream stops downloading and the old MediaSource is released. Two
    // concurrent HLS.js instances fight over bandwidth and can exhaust the
    // browser's MediaSource / SourceBuffer limits, stalling the new load.
    this.cleanupPanelVideo()

    this.renderer?.removeCloudOverlay()
    this.renderer?.removeNightLights()
    this.renderer?.disableSunLighting()

    try {
      await this.displayDataset(datasetId, gen)
      if (gen !== this.loadGeneration) {
        logger.debug('[App] loadDataset superseded:', datasetId)
        this.cleanupVideo()
        return
      }
      this.showHomeButton()
      logger.debug('[App] loadDataset complete:', datasetId)
    } catch (error) {
      // Clear the loading overlay on the primary panel regardless of
      // whether the load was superseded or genuinely failed.
      this.viewports.setPanelLoading(this.viewports.getPrimaryIndex(), false)
      if (gen !== this.loadGeneration) {
        logger.debug('[App] loadDataset superseded (error ignored):', datasetId)
        this.cleanupVideo()
        return
      }
      logger.debug('[App] loadDataset failed:', datasetId, error)
      // Clean up any partially-created resources from the failed load
      this.cleanupVideo()
      this.setError(error instanceof Error ? error.message : 'Failed to load dataset')
    }
  }

  /** Resolve, render, and apply a dataset (image or video) to the sphere. */
  private async displayDataset(datasetId: string, gen: number): Promise<void> {
    const dataset = dataService.getDatasetById(datasetId)
    if (!dataset) throw new Error(`Dataset not found: ${datasetId}`)

    this.appState.currentDataset = dataset
    // Record on the primary panel's state so onPrimaryChange later
    // knows what's loaded where.
    const primaryIdx = this.viewports.getPrimaryIndex()
    if (this.panelStates[primaryIdx]) {
      this.panelStates[primaryIdx].dataset = dataset
    }

    logger.info('[App] Loading dataset:', {
      id: dataset.id,
      title: dataset.title,
      format: dataset.format,
      hasTimeData: !!(dataset.startTime && dataset.endTime)
    })

    // Loading a new dataset into the primary resets any picker
    // override — the user probably wants to see their fresh load.
    this.infoDisplayOverride = null
    this.renderInfoPanel()
    this.refreshPanelLegends()

    if (!this.renderer) throw new Error('Renderer not initialized')

    const loaderCallbacks = {
      showPlaybackControls: (show: boolean) => this.showPlaybackControls(show),
      showTimeLabel: (show: boolean) => this.showTimeLabel(show),
    }

    // Show a per-panel loading overlay so the user sees "Loading…"
    // instead of the confusing Blue Marble intermediate state.
    this.viewports.setPanelLoading(primaryIdx, true, `Loading ${dataset.title}\u2026`)

    if (dataset.format === 'tour/json') {
      this.viewports.setPanelLoading(primaryIdx, false)
      this.tourIsStandalone = true
      await this.startTour(dataset.dataLink, gen)
      return
    } else if (dataService.isImageDataset(dataset)) {
      await loadImageDataset(dataset, this.renderer, this.appState, this.isMobile, loaderCallbacks)
      this.viewports.setPanelLoading(primaryIdx, false)
      if (gen !== this.loadGeneration) return
    } else if (dataService.isVideoDataset(dataset)) {
      const result = await loadVideoDataset(
        dataset, this.renderer, this.appState, this.isMobile, this.playback, loaderCallbacks
      )
      this.viewports.setPanelLoading(primaryIdx, false)
      // If a newer load started while we were awaiting, discard these results.
      // Don't dispose videoTexture here — setVideoTexture already placed it on
      // the sphere material, so the next load's setVideoTexture will replace it.
      if (gen !== this.loadGeneration) {
        result.hlsService.destroy()
        return
      }
      this.storePanelVideoResult(this.viewports.getPrimaryIndex(), result)
      this.attachPrimaryVideoSync()
      this.doStartPlaybackLoop()
    } else {
      throw new Error(`Unsupported format: ${dataset.format}`)
    }

    // Fetch and cache the legend image; generate a text description for non-vision mode.
    initLegendForDataset(dataset, loadConfig())

    // Auto-start a tour if the dataset has one associated via runTourOnLoad.
    // Skip if a tour is already running (the tour engine triggered this load).
    // Failures are silently logged — the tour is optional, the dataset already loaded.
    if (dataset.runTourOnLoad && gen === this.loadGeneration && !this.tourEngine) {
      const ref = dataset.runTourOnLoad
      try {
        if (ref.startsWith('http://') || ref.startsWith('https://') || ref.endsWith('.json')) {
          logger.info('[App] Auto-starting tour from runTourOnLoad URL:', ref)
          await this.startTour(ref, gen)
        } else {
          const tourDataset = dataService.getDatasetById(ref)
          if (tourDataset && tourDataset.format === 'tour/json') {
            logger.info('[App] Auto-starting tour from runTourOnLoad dataset:', tourDataset.id)
            await this.startTour(tourDataset.dataLink, gen)
          } else {
            logger.warn('[App] runTourOnLoad references unknown dataset:', ref)
          }
        }
      } catch (err) {
        logger.warn('[App] runTourOnLoad failed (tour is optional):', err)
      }
    }
  }

  /** Start the requestAnimationFrame playback loop that syncs the scrubber, time label, and auto-loop. */
  private doStartPlaybackLoop(): void {
    startPlaybackLoop(
      this.playback,
      this.hlsService,
      this.videoTexture,
      this.appState,
      (time) => this.updateVideoTimeLabel(time),
      () => this.renderer?.getMap()?.triggerRepaint(),
    )
  }

  /**
   * Load a dataset on behalf of the tour engine.
   * Unlike loadDataset(), this does NOT stop the active tour and does NOT
   * trigger runTourOnLoad — the tour engine is managing the flow.
   */
  private async loadDatasetForTour(datasetId: string, slot?: number): Promise<void> {
    const targetSlot = slot ?? this.viewports.getPrimaryIndex()
    const isPrimarySlot = targetSlot === this.viewports.getPrimaryIndex()
    const targetRenderer = this.viewports.getRendererAt(targetSlot)
    logger.debug('[App] loadDatasetForTour:', datasetId, 'slot:', targetSlot)

    if (!targetRenderer) {
      logger.warn('[App] Tour loadDataset: slot renderer missing:', targetSlot)
      return
    }

    const dataset = dataService.getDatasetById(datasetId)
    if (!dataset) {
      logger.warn('[App] Tour loadDataset: dataset not found, skipping:', datasetId)
      return
    }

    // Skip re-loading if this specific panel already has this dataset
    if (this.panelStates[targetSlot]?.dataset?.id === datasetId) {
      logger.debug('[App] Tour loadDataset: already loaded in slot, skipping:', datasetId, targetSlot)
      return
    }

    // Primary slot owns the shared playback state — reset it before
    // tearing down the previous stream. Non-primary slot loads don't
    // touch playback at all.
    if (isPrimarySlot) {
      stopPlaybackLoop(this.playback)
      this.appState.isPlaying = false
      resetPlaybackState(this.playback)
    }

    // Tear down the previous video/HLS on THIS slot
    this.cleanupPanelVideo(targetSlot)

    targetRenderer.removeCloudOverlay?.()
    targetRenderer.removeNightLights?.()
    targetRenderer.disableSunLighting?.()

    if (isPrimarySlot) {
      this.appState.currentDataset = dataset
    }
    if (this.panelStates[targetSlot]) {
      this.panelStates[targetSlot].dataset = dataset
    }
    this.infoDisplayOverride = null
    this.renderInfoPanel()
    this.refreshPanelLegends()

    // On small screens, hide the info panel during tours to reduce clutter
    if (window.innerWidth <= 768) {
      document.getElementById('info-panel')?.classList.add('hidden')
    }

    // Show playback controls so users can scrub through time-series data
    const tourLoaderCallbacks = {
      showPlaybackControls: (show: boolean) => this.showPlaybackControls(show),
      showTimeLabel: (show: boolean) => this.showTimeLabel(show),
    }

    // Per-panel loading indicator so the user sees "Loading…" on the
    // target globe instead of a confusing Blue Marble intermediate.
    this.viewports.setPanelLoading(targetSlot, true, `Loading ${dataset.title}\u2026`)

    if (dataService.isImageDataset(dataset)) {
      await loadImageDataset(
        dataset, targetRenderer, this.appState, this.isMobile, tourLoaderCallbacks,
        { isPrimary: isPrimarySlot },
      )
    } else if (dataService.isVideoDataset(dataset)) {
      const result = await loadVideoDataset(
        dataset, targetRenderer, this.appState, this.isMobile, this.playback, tourLoaderCallbacks,
        { isPrimary: isPrimarySlot },
      )
      this.storePanelVideoResult(targetSlot, result)
      if (isPrimarySlot) {
        this.attachPrimaryVideoSync()
        this.doStartPlaybackLoop()
      }
    }

    this.viewports.setPanelLoading(targetSlot, false)
    initLegendForDataset(dataset, loadConfig())
    // No runTourOnLoad check — the tour engine is in control
  }

  /** Reset the globe to default Earth for a tour — like goHome but keeps UI clean (no browse panel). */
  private async unloadForTour(): Promise<void> {
    await this.unloadAllPanels()
    clearLegendCache()
    this.appState.currentDataset = null
    this.showPlaybackControls(false)
    this.showTimeLabel(false)
    const infoPanel = document.getElementById('info-panel')
    if (infoPanel) {
      infoPanel.classList.add('hidden')
      infoPanel.classList.remove('expanded')
    }

    if (this.renderer) {
      await this.renderer.loadDefaultEarthMaterials()
      const sun = getSunPosition(new Date())
      this.renderer.enableSunLighting(sun.lat, sun.lng)
    }
  }

  /** Fetch a tour JSON file and start the tour engine. */
  private async startTour(dataLink: string, gen: number): Promise<void> {
    // Stop any previous tour
    this.stopTour()

    const resp = await fetch(dataLink)
    if (!resp.ok) throw new Error(`Failed to fetch tour: ${resp.status}`)
    const tourFile: TourFile = await resp.json()

    if (gen !== this.loadGeneration) return

    // Use the final response URL as the base for resolving relative media paths.
    // This handles redirects and ensures relative URLs work even when dataLink
    // is a relative path (e.g. /assets/test-tour.json).
    const tourBaseUrl = resp.url || new URL(dataLink, window.location.href).toString()

    this.tourEngine = new TourEngine(tourFile, {
      loadDataset: async (id, opts) => {
        await this.loadDatasetForTour(id, opts?.slot)
      },
      unloadAllDatasets: async () => {
        await this.unloadForTour()
      },
      unloadDatasetAt: async (slot) => {
        await this.unloadPanelDataset(slot)
      },
      setEnvView: async ({ layout }) => {
        this.viewports.setLayout(layout)
      },
      getRenderer: () => this.renderer!,
      getAllRenderers: () => this.viewports.getAll(),
      togglePlayPause: () => {
        togglePlayPause(this.hlsService, this.appState, (m) => this.announce(m))
      },
      isPlaying: () => this.appState.isPlaying,
      setPlaybackRate: (rate) => {
        if (this.hlsService) this.hlsService.playbackRate = rate
      },
      onTourEnd: () => this.endTour(),
      onStop: () => this.stopTour(),
      announce: (msg) => this.announce(msg),
      resolveMediaUrl: (filename) => {
        try {
          return new URL(filename, tourBaseUrl).toString()
        } catch {
          return filename
        }
      },
    })

    showTourControls(this.tourEngine, () => this.stopTour())
    this.showPlaybackControls(false)
    hideBrowseUI()
    closeChat()
    document.body.classList.add('tour-active')

    // On small screens, hide non-essential UI and shift globe up
    if (window.innerWidth <= 768) {
      document.getElementById('map-controls')?.classList.add('hidden')
      document.getElementById('info-panel')?.classList.add('hidden')
    }

    void this.tourEngine.play()
  }

  /** Called when the tour finishes naturally (not via stop button). */
  private endTour(): void {
    const wasStandalone = this.tourIsStandalone
    this.cleanupTourOverlays()
    this.tourEngine = null
    this.tourIsStandalone = false
    this.announce('Tour ended')

    if (wasStandalone) {
      // Standalone tour (tour/json dataset) — return home so user isn't stuck
      void this.goHome()
    } else {
      // runTourOnLoad tour — stay on the current dataset, restore playback UI
      this.restorePostTourUI()
    }
  }

  /** Stop any active tour without triggering goHome. */
  private stopTour(): void {
    if (this.tourEngine) {
      this.tourEngine.stop()
      this.tourEngine = null
      this.tourIsStandalone = false
      this.cleanupTourOverlays()
      this.restorePostTourUI()
    }
  }

  /** Restore playback/time UI after a tour ends, based on the current dataset. */
  private restorePostTourUI(): void {
    const dataset = this.appState.currentDataset
    if (dataset && dataService.isVideoDataset(dataset)) {
      this.showPlaybackControls(true)
      if (this.hlsService) {
        updatePlayButton(this.hlsService.paused)
      }
    }
    // Restore UI hidden during tour
    document.getElementById('map-controls')?.classList.remove('hidden')
    document.body.classList.remove('tour-active')
  }

  /** Remove all tour UI elements. */
  private cleanupTourOverlays(): void {
    hideTourControls()
    hideAllTourTextBoxes()
    hideAllTourImages()
    hideAllTourVideos()
    hideAllTourPopups()
    hideAllTourQuestions()
  }

  /** Map the current video playback time to a real-world date and update the time label. */
  private updateVideoTimeLabel(videoTime: number): void {
    const dataset = this.appState.currentDataset
    if (!dataset) return

    if (dataset.startTime && dataset.endTime) {
      const start = new Date(dataset.startTime)
      const end = new Date(dataset.endTime)
      const videoDuration = this.hlsService?.duration ?? 1
      const snapMs = this.playback.displayInterval?.intervalMs
      const currentDate = videoTimeToDate(videoTime, videoDuration, start, end, snapMs)
      const showTime = dataset.period
        ? isSubDailyPeriod(dataset.period)
        : (this.playback.displayInterval?.showTime ?? false)
      this.appState.timeLabel = formatDate(currentDate, showTime)
      this.showTimeLabel(true)
    } else {
      this.showTimeLabel(false)
    }
  }

  /** Show or hide the time label overlay and update its text from app state. */
  private showTimeLabel(show: boolean): void {
    const timeLabel = document.getElementById('time-label')
    const timeDisplay = document.getElementById('time-display')
    if (timeLabel && timeDisplay) {
      if (show) {
        timeDisplay.textContent = this.appState.timeLabel
        timeLabel.classList.remove('hidden')
        const scrubber = document.getElementById('scrubber')
        if (scrubber) scrubber.setAttribute('aria-valuetext', this.appState.timeLabel)
      } else {
        timeLabel.classList.add('hidden')
      }
    }
  }

  // --- UI helpers ---

  /** Toggle visibility of the playback transport controls. */
  private showPlaybackControls(show: boolean): void {
    const controls = document.getElementById('playback-controls')
    if (controls) {
      controls.classList.toggle('hidden', !show)
    }
    updateMapControlsPosition()
  }

  /**
   * Toggle dataset info panel visibility. Persists the choice and
   * updates the DOM immediately. When the info panel is the only
   * place showing the legend (single-view with legend prefs on), the
   * legend moves to a floating element in the primary panel.
   */
  private setDatasetInfoVisible(visible: boolean): void {
    this.viewPrefs.infoPanelVisible = visible
    saveViewPreferences(this.viewPrefs)
    this.applyDatasetInfoVisibility()
    this.refreshPanelLegends()
  }

  /** Toggle legend visibility. Persists and refreshes per-panel legends. */
  private setLegendVisible(visible: boolean): void {
    this.viewPrefs.legendVisible = visible
    saveViewPreferences(this.viewPrefs)
    this.refreshPanelLegends()
    // Also hide/show the in-info-panel legend thumbnail since it
    // lives inside the info panel body.
    const legendThumb = document.querySelector('.info-legend-thumb') as HTMLElement | null
    if (legendThumb) {
      legendThumb.style.display = visible ? '' : 'none'
    }
  }

  /** Apply the current infoPanelVisible preference to the DOM. */
  private applyDatasetInfoVisibility(): void {
    const panel = document.getElementById('info-panel')
    if (!panel) return
    const hasDataset = !!this.appState.currentDataset
    // When no dataset is loaded, the info panel is hidden regardless —
    // the preference only matters when there's content to show.
    if (!hasDataset) {
      panel.classList.add('hidden')
      return
    }
    panel.classList.toggle('hidden', !this.viewPrefs.infoPanelVisible)
  }

  /**
   * Which slot's dataset the info panel is currently displaying —
   * the override if set, otherwise the primary. Returns -1 if no
   * panel has a loaded dataset.
   */
  private getInfoDisplayIndex(): number {
    if (
      this.infoDisplayOverride !== null &&
      this.panelStates[this.infoDisplayOverride]?.dataset
    ) {
      return this.infoDisplayOverride
    }
    const primaryIdx = this.viewports.getPrimaryIndex()
    if (this.panelStates[primaryIdx]?.dataset) return primaryIdx
    // Fall back to the first slot with a loaded dataset so the info
    // panel isn't blank when the primary happens to be empty.
    for (let i = 0; i < this.panelStates.length; i++) {
      if (this.panelStates[i]?.dataset) return i
    }
    return -1
  }

  /**
   * Render the info panel for whichever slot `getInfoDisplayIndex`
   * points at, repopulate the picker dropdown with all loaded
   * datasets, and show/hide the picker based on how many are loaded.
   *
   * Call after: dataset load/unload, primary change, layout change,
   * info-panel-visibility toggle. Idempotent — safe to call
   * repeatedly.
   */
  private renderInfoPanel(): void {
    const idx = this.getInfoDisplayIndex()
    const dataset = idx >= 0 ? this.panelStates[idx]?.dataset ?? null : null

    if (!dataset) {
      // Nothing to show — hide the whole panel.
      document.getElementById('info-panel')?.classList.add('hidden')
      return
    }

    // Render the currently-selected dataset into the info panel body.
    displayDatasetInfo(dataset, this.appState.datasets, (id) => this.loadDataset(id))

    // Repopulate the picker with every loaded dataset (in panel order)
    // and wire the change handler once.
    const picker = document.getElementById('info-panel-picker')
    const select = document.getElementById('info-selector') as HTMLSelectElement | null
    if (!picker || !select) return

    const entries: Array<{ slot: number; label: string }> = []
    for (let slot = 0; slot < this.panelStates.length; slot++) {
      const d = this.panelStates[slot]?.dataset
      if (!d) continue
      const label = this.panelStates.length > 1
        ? `Panel ${slot + 1}: ${d.title}`
        : d.title
      entries.push({ slot, label })
    }

    // Only show the picker when there's a choice to make.
    if (entries.length > 1) {
      picker.classList.remove('hidden')
      // Rebuild options only if the set changed — a naive innerHTML
      // rewrite would lose focus if the user is mid-interaction.
      const wantSignature = entries.map(e => `${e.slot}:${e.label}`).join('|')
      if (select.dataset.signature !== wantSignature) {
        select.innerHTML = ''
        for (const e of entries) {
          const opt = document.createElement('option')
          opt.value = String(e.slot)
          opt.textContent = e.label
          select.appendChild(opt)
        }
        select.dataset.signature = wantSignature
      }
      select.value = String(idx)
    } else {
      picker.classList.add('hidden')
    }

    if (!this.infoSelectorWired) {
      this.infoSelectorWired = true
      select.addEventListener('click', (ev) => { ev.stopPropagation() })
      select.addEventListener('change', () => {
        const newSlot = parseInt(select.value, 10)
        if (Number.isFinite(newSlot)) {
          this.infoDisplayOverride = newSlot
          this.renderInfoPanel()
        }
      })
    }

    // Now that the body has content, apply the user's visibility
    // preference — the panel may still be hidden if they toggled it
    // off in Tools.
    this.applyDatasetInfoVisibility()
  }

  /**
   * Rebuild the floating per-panel legends from the current
   * panelStates array + view prefs. Called after any change that
   * affects whether legends should be visible or which dataset each
   * panel is showing:
   *
   * - Legend toggle flipped
   * - Info panel toggle flipped (legend may move in/out of the info panel)
   * - A dataset loaded/unloaded in any panel
   * - Layout changed (panels added/removed)
   * - Primary changed (floating legend vs info-panel thumbnail split)
   */
  private refreshPanelLegends(): void {
    const legendOn = this.viewPrefs.legendVisible
    const infoOn = this.viewPrefs.infoPanelVisible
    const isMultiView = this.viewports.getPanelCount() > 1
    const primaryIdx = this.viewports.getPrimaryIndex()

    for (let slot = 0; slot < this.panelStates.length; slot++) {
      const panel = this.panelStates[slot]
      const dataset = panel?.dataset ?? null
      const legendLink = dataset?.legendLink ?? null

      // Decide whether this panel gets a floating legend:
      // - Off entirely if the Legend toggle is off
      // - Off if the panel has no dataset or no legendLink
      // - Off for the primary in single-view mode when the info
      //   panel is visible (the info panel holds the legend there)
      // - On otherwise
      let showFloating = legendOn && !!legendLink
      if (showFloating && !isMultiView && slot === primaryIdx && infoOn) {
        showFloating = false
      }

      if (showFloating && legendLink && dataset) {
        this.viewports.setPanelLegend(slot, legendLink, {
          title: dataset.title,
          onClick: () => this.openLegendModal(legendLink, dataset.title),
        })
      } else {
        this.viewports.setPanelLegend(slot, null)
      }
    }
  }

  /** Open the full-size legend modal for a dataset. Mirrors the
   *  legend click handler inside datasetLoader's info panel so the
   *  floating legends and the info-panel thumbnail use the same UI. */
  private openLegendModal(src: string, title: string): void {
    let overlay = document.getElementById('legend-modal-overlay')
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'legend-modal-overlay'
      overlay.className = 'legend-modal-overlay'
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.innerHTML = `<img class="legend-modal-img" alt="Legend"><button class="legend-modal-close" aria-label="Close legend">&times;</button>`
      const closeModal = () => overlay!.classList.add('hidden')
      overlay.querySelector('.legend-modal-close')!.addEventListener('click', (e) => {
        e.stopPropagation()
        closeModal()
      })
      overlay.addEventListener('click', closeModal)
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overlay!.classList.contains('hidden')) closeModal()
      })
      document.body.appendChild(overlay)
    }
    const img = overlay.querySelector('img') as HTMLImageElement
    img.src = src
    img.alt = `${title} legend`
    overlay.setAttribute('aria-label', `${title} legend`)
    overlay.classList.remove('hidden')
  }

  private dismissBrowseAfterLoad(): void {
    if (this.viewports.getPanelCount() > 1) {
      collapseBrowseUI()
    } else {
      hideBrowseUI()
    }
  }

  /**
   * Open (or re-open) the dataset browse panel. Called by the
   * Browse button in the map-controls toolbar. Handles all three
   * states the panel can be in: hidden (initial), collapsed (after
   * a previous multi-view load), or already visible (no-op).
   */
  private openBrowsePanel(): void {
    const overlay = document.getElementById('browse-overlay')
    // Only call showBrowseUI once — it wires event listeners on
    // category chips, search input, etc. Re-calling it after a
    // hideBrowseUI() would duplicate those listeners.
    if (!overlay || overlay.dataset.browseInitialized !== 'true') {
      showBrowseUI(this.appState.datasets, {
        onSelectDataset: (id) => this.selectDatasetFromBrowse(id),
        announce: (msg) => this.announce(msg),
        isMobile: this.isMobile,
        onOpenChat: (query) => this.openChatWithQuery(query),
      })
      // Mark as initialized so subsequent opens skip showBrowseUI.
      const el = overlay ?? document.getElementById('browse-overlay')
      if (el) el.dataset.browseInitialized = 'true'
      return
    }
    // Already rendered — either collapsed or fully visible. Remove
    // the collapsed class either way and ensure `browse-open` is
    // set so other UI can react.
    overlay.classList.remove('collapsed')
    overlay.classList.remove('hidden')
    document.body.classList.add('browse-open')
  }

  /** Detect WebGL support. If unavailable, display troubleshooting instructions and return false. */
  private checkWebGLSupport(): boolean {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (gl) return true

    const screen = document.getElementById('loading-screen')
    if (screen) {
      screen.innerHTML = `
        <div style="max-width:480px;padding:2rem;text-align:center;color:#e0e0e0;font-family:system-ui,sans-serif;">
          <div style="font-size:2.5rem;margin-bottom:0.75rem;" aria-hidden="true">&#x1F30D;</div>
          <h1 style="font-size:1.1rem;margin:0 0 0.75rem;color:#fff;">WebGL is not available</h1>
          <p style="font-size:0.8rem;line-height:1.5;color:#aaa;margin:0 0 1.25rem;">
            This application requires WebGL to render the interactive globe.
            Your browser's GPU acceleration appears to be disabled.
          </p>
          <details style="text-align:left;font-size:0.75rem;color:#999;line-height:1.6;">
            <summary style="cursor:pointer;color:#4da6ff;margin-bottom:0.5rem;">How to fix this</summary>
            <ol style="padding-left:1.25rem;margin:0;">
              <li>Open <strong style="color:#fff;">chrome://flags</strong> in your address bar</li>
              <li>Search for <strong style="color:#fff;">Override software rendering list</strong></li>
              <li>Set it to <strong style="color:#fff;">Enabled</strong> and relaunch Chrome</li>
            </ol>
            <p style="margin:0.75rem 0 0.25rem;color:#888;">Alternatively, launch Chrome from the terminal with:</p>
            <code style="display:block;background:#1a1a2e;padding:0.5rem 0.75rem;border-radius:4px;color:#4da6ff;font-size:0.7rem;overflow-x:auto;">
              google-chrome --enable-webgl --ignore-gpu-blocklist
            </code>
            <p style="margin:0.75rem 0 0;color:#888;">
              If the problem persists, check <strong style="color:#fff;">chrome://gpu</strong>
              for driver issues. Installing or updating your GPU drivers
              (e.g. <code style="color:#ccc;">sudo apt install nvidia-driver-xxx</code>
              or <code style="color:#ccc;">mesa-utils</code>) usually resolves this.
            </p>
          </details>
        </div>`
      screen.style.display = 'flex'
      screen.style.alignItems = 'center'
      screen.style.justifyContent = 'center'
      screen.classList.remove('fade-out')
    }
    return false
  }

  /** Set the loading state. When false, fades out the loading screen with a short delay. */
  private setLoading(isLoading: boolean): void {
    this.appState.isLoading = isLoading
    if (!isLoading) {
      const screen = document.getElementById('loading-screen')
      if (screen) {
        screen.setAttribute('aria-busy', 'false')
        this.setLoadingStatus('Ready', 100)
        this.loadingHideTimer = setTimeout(() => {
          this.loadingHideTimer = null
          screen.style.opacity = ''
          screen.classList.add('fade-out')
          screen.addEventListener('transitionend', () => {
            if (screen.classList.contains('fade-out')) {
              screen.style.display = 'none'
            }
          }, { once: true })
        }, LOADING_HIDE_DELAY_MS)
      }
    }
  }

  /** Update the loading screen status message and progress bar. */
  private setLoadingStatus(message: string, progress?: number): void {
    const statusEl = document.getElementById('loading-status')
    if (statusEl) statusEl.textContent = message
    if (progress !== undefined) {
      const track = document.querySelector('.loading-progress-track')
      if (track) track.setAttribute('aria-valuenow', String(Math.round(progress)))
      const fill = document.getElementById('loading-progress-fill')
      if (fill) (fill as HTMLElement).style.width = `${progress}%`
    }
  }

  /** Display an error message in the error banner and log it. */
  private setError(error: string): void {
    this.appState.error = error
    const errorEl = document.getElementById('error-message')
    if (errorEl) {
      const textEl = document.getElementById('error-text')
      if (textEl) textEl.textContent = error
      errorEl.classList.toggle('hidden', !error)
      const dismissBtn = document.getElementById('error-dismiss')
      if (dismissBtn) {
        dismissBtn.onclick = () => {
          errorEl.classList.add('hidden')
          this.appState.error = null
        }
      }
    }
    logger.error('[App] Error:', error)
  }

  /** Push a message to the ARIA live region for screen reader announcements. */
  private announce(message: string): void {
    const el = document.getElementById('a11y-announcer')
    if (el) {
      el.textContent = ''
      requestAnimationFrame(() => { el.textContent = message })
    }
  }

  /**
   * Wire the Enter VR button. The button hides itself on browsers
   * without WebXR, so calling this unconditionally is safe — the
   * Three.js chunk only downloads on devices that advertise
   * `immersive-vr` support (see src/ui/vrButton.ts). VR mode always
   * uses the primary panel's dataset; in multi-globe layouts the
   * other panels keep rendering in 2D behind the scenes.
   *
   * Both image and video datasets are supported: image datasets
   * resolve to a static URL that vrScene loads via Three.js'
   * TextureLoader (browser HTTP cache hits when the 2D loader has
   * already fetched the same URL); video datasets reuse the
   * existing HLS `<video>` element directly.
   */
  private async initVrButton(): Promise<void> {
    await initVrButton({
      getDatasetTexture: () => {
        const ds = this.appState.currentDataset
        if (!ds) return null
        if (dataService.isImageDataset(ds)) {
          return { kind: 'image', url: ds.dataLink }
        }
        const video = this.hlsService?.getVideo()
        if (video) return { kind: 'video', element: video }
        return null
      },
      getDatasetTitle: () => this.appState.currentDataset?.title ?? null,
      hasVideoDataset: () => {
        const ds = this.appState.currentDataset
        return !!ds && dataService.isVideoDataset(ds)
      },
      isPlaying: () => this.appState.isPlaying,
      togglePlayPause: () => togglePlayPause(
        this.hlsService, this.appState, (m) => this.announce(m),
      ),
      onSessionEnd: () => {
        this.announce('Exited VR')
      },
    })
  }

  /** Initialize the Orbit chat panel and wire playback positioning observers. */
  private initChat(): void {
    initPlaybackPositioning()
    initChatUI({
      onLoadDataset: (id) => { void this.selectDatasetFromChat(id) },
      onFlyTo: (lat, lon, altitude) => { void this.renderer?.flyTo(lat, lon, altitude) },
      onSetTime: (isoDate) => seekToDate(isoDate, this.hlsService, this.appState, this.playback),
      onFitBounds: (bounds, _label) => { this.renderer?.fitBounds(bounds) },
      onAddMarker: (lat, lng, label) => { this.renderer?.addMarker(lat, lng, label) },
      onToggleLabels: (visible) => {
        for (const r of this.viewports.getAll()) { r.toggleLabels?.(visible); r.toggleBoundaries?.(visible) }
      },
      onHighlightRegion: (geojson, _label) => { this.renderer?.highlightRegion(geojson) },
      getMapViewContext: () => this.renderer?.getViewContext() ?? null,
      getDatasets: () => this.appState.datasets,
      getCurrentDataset: () => this.appState.currentDataset,
      announce: (msg) => this.announce(msg),
      onOpenBrowse: () => this.openBrowsePanel(),
    })
  }

  /** Open the chat panel and optionally pre-fill the input with a query string. */
  private openChatWithQuery(query?: string): void {
    openChat()
    if (query) {
      const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
      if (input) {
        input.value = query
        input.style.height = 'auto'
        input.style.height = Math.min(input.scrollHeight, 96) + 'px'
      }
    }
  }


  /** Load a dataset selected via the chat panel, updating URL and notifying chat of the change. */
  private async selectDatasetFromChat(id: string): Promise<void> {
    const gen = ++this.loadGeneration
    logger.debug('[App] selectDatasetFromChat:', id, 'gen:', gen)
    this.dismissBrowseAfterLoad()
    this.announce('Loading dataset\u2026')
    this.showLoadingScreen('Loading dataset\u2026', 20)
    window.history.pushState({}, '', `?dataset=${encodeURIComponent(id)}`)
    await this.loadDataset(id)
    if (gen !== this.loadGeneration) {
      logger.debug('[App] selectDatasetFromChat superseded:', id, 'gen:', gen, 'current:', this.loadGeneration)
      return
    }
    this.setLoading(false)
    showChatTrigger()
    const dataset = this.appState.currentDataset
    if (dataset) {
      this.announce(`Loaded dataset: ${dataset.title}`)
      this.renderer?.setCanvasDescription(`3D globe showing ${dataset.title}`)
      notifyDatasetChanged(dataset)
      setHelpActiveDataset(dataset.id)
      // Flush deferred globe-control actions (fly-to, set-time) now that the dataset is loaded
      flushPendingGlobeActions()
    }
  }

  /**
   * Called by ViewportManager when a setLayout adds/removes panels.
   * Resizes our parallel panelStates array to match, disposing any
   * videos in slots that are going away, and seeds newly-created
   * panels with the current map-controls toolbar state (labels,
   * borders, terrain) so they start in sync with the primary.
   */
  private onViewportLayoutChange(newCount: number, oldCount: number): void {
    if (newCount < oldCount) {
      // Tear down slots that are being removed
      for (let i = newCount; i < oldCount; i++) {
        const panel = this.panelStates[i]
        if (!panel) continue
        if (panel.videoTexture) { panel.videoTexture.dispose() }
        if (panel.hlsService) { panel.hlsService.destroy() }
      }
      this.panelStates.length = newCount
    } else {
      // Add fresh empty slots for new panels
      while (this.panelStates.length < newCount) {
        this.panelStates.push(createPanelState())
      }
      // Seed the new viewports with the current toolbar state so
      // they visually match the primary's labels/borders/terrain.
      // We read state from the DOM button classes rather than
      // querying a renderer, since the new renderers may still be
      // mid-style-load when this fires. MapLibre queues layer
      // operations internally until the style is ready, so
      // dispatching the toggle now is safe.
      const labelsActive = document.getElementById('tools-menu-labels')?.classList.contains('active') ?? false
      const bordersActive = document.getElementById('tools-menu-borders')?.classList.contains('active') ?? false
      const terrainActive = document.getElementById('tools-menu-terrain')?.classList.contains('active') ?? false
      for (let i = oldCount; i < newCount; i++) {
        const newRenderer = this.viewports.getRendererAt(i)
        if (!newRenderer) continue
        const map = newRenderer.getMap()
        const applyOverlayState = () => {
          newRenderer.toggleLabels?.(labelsActive)
          newRenderer.toggleBoundaries?.(bordersActive)
          if (terrainActive) newRenderer.toggleTerrain?.(true)
        }
        if (map && map.isStyleLoaded()) {
          applyOverlayState()
        } else {
          map?.once('load', applyOverlayState)
        }
      }
    }
    // Layout change can affect whether a panel's legend is a
    // floating element vs inside the info panel, and the set of
    // available datasets in the info-panel picker — refresh both.
    // Also clear any picker override if the pinned slot just
    // vanished on a shrink.
    if (
      this.infoDisplayOverride !== null &&
      this.infoDisplayOverride >= newCount
    ) {
      this.infoDisplayOverride = null
    }
    this.refreshPanelLegends()
    this.renderInfoPanel()
    syncToolsMenuLayout(this.viewports.getLayout())
  }

  /**
   * Called by ViewportManager when the primary index changes (user
   * clicked a non-primary panel's indicator badge). Rewires the
   * singular UI — info panel, playback controls, video sync, URL —
   * to the new primary's dataset.
   */
  private onViewportPrimaryChange(newIndex: number, _oldIndex: number): void {
    logger.debug('[App] Primary panel changed:', _oldIndex, '→', newIndex)
    const newPrimaryPanel = this.panelStates[newIndex]
    const newDataset = newPrimaryPanel?.dataset ?? null

    // Rewire video sync to the new primary's video (if any)
    this.detachPrimaryVideoSync()
    stopPlaybackLoop(this.playback)

    // Update the shared appState + info panel. Promoting a different
    // panel clears any picker override so the info panel follows the
    // new primary instead of silently pointing at a stale slot.
    this.appState.currentDataset = newDataset
    this.infoDisplayOverride = null
    if (newDataset) {
      this.renderInfoPanel()
      window.history.replaceState({}, '', `?dataset=${encodeURIComponent(newDataset.id)}`)
      notifyDatasetChanged(newDataset)
      setHelpActiveDataset(newDataset.id)
      this.renderer?.setCanvasDescription(`3D globe showing ${newDataset.title}`)
    } else {
      const infoPanel = document.getElementById('info-panel')
      if (infoPanel) infoPanel.classList.add('hidden')
      window.history.replaceState({}, '', window.location.pathname)
      notifyDatasetChanged(null)
      setHelpActiveDataset(null)
      this.renderer?.setCanvasDescription('Interactive 3D globe showing Earth')
    }
    // Legend placement depends on primary (single-view uses the
    // info panel's thumbnail for the primary; multi-view always
    // uses per-panel floating legends). Refresh so the primary's
    // legend moves to the correct surface.
    this.refreshPanelLegends()

    // Rewire playback controls based on the new primary's video state
    const isVideo = newDataset && dataService.isVideoDataset(newDataset) && newPrimaryPanel?.hlsService
    const hasTemporalRange = Boolean(newDataset?.startTime && newDataset?.endTime)
    if (isVideo) {
      this.showPlaybackControls(true)
      this.showTimeLabel(hasTemporalRange)
      updatePlayButton(newPrimaryPanel!.hlsService!.paused)
      // Recompute the display interval for the new primary's temporal
      // range so scrubber snapping and time label formatting are correct.
      if (hasTemporalRange && newPrimaryPanel!.hlsService) {
        const start = new Date(newDataset!.startTime!)
        const end = new Date(newDataset!.endTime!)
        const videoDuration = newPrimaryPanel!.hlsService!.duration ?? 1
        this.playback.displayInterval = inferDisplayInterval(start, end, videoDuration)
      }
      this.attachPrimaryVideoSync()
      this.doStartPlaybackLoop()
    } else {
      this.showPlaybackControls(false)
      if (!hasTemporalRange) {
        this.showTimeLabel(false)
      }
    }
    this.announce(newDataset ? `Active panel: ${newDataset.title}` : `Panel ${newIndex + 1} active`)
  }

  /**
   * Store a video-load result into a specific panel's state.
   * Assumes the slot exists (callers must validate the index).
   */
  private storePanelVideoResult(
    slot: number,
    result: { hlsService: HLSService; videoTexture: VideoTextureHandle },
  ): void {
    const panel = this.panelStates[slot]
    if (!panel) return
    panel.hlsService = result.hlsService
    panel.videoTexture = result.videoTexture
  }

  /**
   * Sibling video sync — seek-once-then-free-run strategy.
   *
   * The previous implementation listened to every `timeupdate` event
   * (~4 per second) and seeked every sibling's `currentTime` on each
   * tick. That caused constant decoder interruption (16+ seeks/sec
   * with 4 panels), manifesting as visible jitter and pauses.
   *
   * New approach:
   *
   *   - **On play**: seek every sibling to match the primary's
   *     real-world date, then call `play()` on all of them at once.
   *     After that, the browser's internal media clock keeps them
   *     naturally in sync without any seeking.
   *
   *   - **On pause**: pause all siblings. No seek — they're already
   *     at the right position from the play-sync.
   *
   *   - **On seeked** (user scrubbed the transport): re-compute
   *     target times, seek siblings, then resume play if the primary
   *     is playing.
   *
   *   - **Periodic drift check** (every 5 seconds): if any sibling
   *     has drifted more than 1.0s from the primary's date-mapped
   *     position, seek just that sibling. This catches slow decoder
   *     drift without the constant-seek jitter. The 1.0s threshold
   *     is generous — 0.3s was too tight and triggered on normal
   *     inter-decoder variance.
   *
   * This reduces seeking from ~16/sec to essentially 0 during normal
   * playback, with a soft correction every 5s only when needed.
   */
  private attachPrimaryVideoSync(): void {
    this.detachPrimaryVideoSync()
    const primaryIdx = this.viewports.getPrimaryIndex()
    const primaryPanel = this.panelStates[primaryIdx]
    const primaryHls = primaryPanel?.hlsService
    const primaryVideo = primaryHls?.getVideo?.() ?? null
    if (!primaryVideo) return

    /**
     * Seek every sibling to the primary's current date-mapped
     * position, update out-of-range indicators, and optionally
     * mirror the primary's play/pause state.
     *
     * @param mirrorPlayState If true, also play/pause siblings
     * to match the primary. On periodic drift checks we skip this
     * (they're already playing/paused) to avoid re-triggering
     * play() on videos that are fine.
     */
    const seekSiblingsToDate = (mirrorPlayState: boolean) => {
      const pIdx = this.viewports.getPrimaryIndex()
      const pPanel = this.panelStates[pIdx]
      const pDataset = pPanel?.dataset

      let primaryDate: Date | null = null
      if (pDataset?.startTime && pDataset.endTime && primaryVideo.duration > 0) {
        primaryDate = videoTimeToDate(
          primaryVideo.currentTime,
          primaryVideo.duration,
          new Date(pDataset.startTime),
          new Date(pDataset.endTime),
        )
      }

      for (let i = 0; i < this.panelStates.length; i++) {
        if (i === pIdx) continue
        const sibPanel = this.panelStates[i]
        const sibHls = sibPanel?.hlsService
        const sibVideo = sibHls?.getVideo?.() ?? null
        if (!sibVideo || sibVideo.readyState < 2) continue

        const sibDataset = sibPanel?.dataset
        const sibHasRange = !!(sibDataset?.startTime && sibDataset.endTime && sibVideo.duration > 0)

        if (primaryDate && sibHasRange) {
          const { videoTime: targetTime, position } = dateToVideoTime(
            primaryDate,
            sibVideo.duration,
            new Date(sibDataset!.startTime!),
            new Date(sibDataset!.endTime!),
          )

          // Match the sibling's playback speed so it advances through
          // real-world time at the same pace as the primary, even if
          // the two videos have different durations (e.g. daily vs
          // weekly frames). Without this, a shorter sibling finishes
          // its entire date range while the primary is still early in
          // its timeline, causing constant drift corrections.
          const primaryRangeMs = new Date(pDataset!.endTime!).getTime() - new Date(pDataset!.startTime!).getTime()
          const sibRangeMs = new Date(sibDataset!.endTime!).getTime() - new Date(sibDataset!.startTime!).getTime()
          if (primaryRangeMs > 0 && sibRangeMs > 0) {
            // rate = (sib video seconds per real-world ms) / (primary video seconds per real-world ms)
            // Simplifies to: (sibDuration / sibRangeMs) / (primaryDuration / primaryRangeMs)
            const rate = (sibVideo.duration / sibRangeMs) / (primaryVideo.duration / primaryRangeMs)
            // Clamp to browser limits (typically 0.0625–16×)
            sibVideo.playbackRate = Math.max(0.0625, Math.min(16, rate))
          }

          if (position === 'inside') {
            this.viewports.setOutOfRange(i, false)
            sibVideo.currentTime = targetTime
            if (mirrorPlayState) {
              if (primaryVideo.paused && !sibVideo.paused) {
                sibVideo.pause()
              } else if (!primaryVideo.paused && sibVideo.paused) {
                sibVideo.play().catch(() => { /* autoplay blocked */ })
              }
            }
          } else {
            this.viewports.setOutOfRange(i, true)
            sibVideo.currentTime = targetTime
            if (!sibVideo.paused) sibVideo.pause()
          }
        } else {
          this.viewports.setOutOfRange(i, false)
          if (mirrorPlayState) {
            if (primaryVideo.paused && !sibVideo.paused) {
              sibVideo.pause()
            } else if (!primaryVideo.paused && sibVideo.paused) {
              sibVideo.play().catch(() => { /* autoplay blocked */ })
            }
          }
        }

        const sibTex = sibPanel?.videoTexture
        if (sibTex) sibTex.needsUpdate = true
      }
    }

    /**
     * Periodic drift correction — only seeks siblings that have
     * drifted beyond the threshold. Much cheaper than constant-seek
     * because most of the time no sibling needs correction.
     */
    const DRIFT_THRESHOLD_S = 1.0
    const DRIFT_CHECK_MS = 5000

    const driftCheck = () => {
      if (primaryVideo.paused) return

      const pIdx = this.viewports.getPrimaryIndex()
      const pPanel = this.panelStates[pIdx]
      const pDataset = pPanel?.dataset

      let primaryDate: Date | null = null
      if (pDataset?.startTime && pDataset.endTime && primaryVideo.duration > 0) {
        primaryDate = videoTimeToDate(
          primaryVideo.currentTime,
          primaryVideo.duration,
          new Date(pDataset.startTime),
          new Date(pDataset.endTime),
        )
      }
      if (!primaryDate) return

      for (let i = 0; i < this.panelStates.length; i++) {
        if (i === pIdx) continue
        const sibPanel = this.panelStates[i]
        const sibVideo = sibPanel?.hlsService?.getVideo?.() ?? null
        if (!sibVideo || sibVideo.readyState < 2 || sibVideo.paused) continue

        const sibDataset = sibPanel?.dataset
        if (!sibDataset?.startTime || !sibDataset.endTime || sibVideo.duration <= 0) continue

        const { videoTime: targetTime, position } = dateToVideoTime(
          primaryDate,
          sibVideo.duration,
          new Date(sibDataset.startTime),
          new Date(sibDataset.endTime),
        )

        if (position === 'inside' && Math.abs(sibVideo.currentTime - targetTime) > DRIFT_THRESHOLD_S) {
          logger.debug(`[App] Drift correction: panel ${i} off by ${(sibVideo.currentTime - targetTime).toFixed(1)}s`)
          sibVideo.currentTime = targetTime
        }
      }
    }

    // --- Wire event listeners ---

    const onPlay = () => seekSiblingsToDate(true)
    const onPause = () => {
      for (let i = 0; i < this.panelStates.length; i++) {
        if (i === this.viewports.getPrimaryIndex()) continue
        const sibVideo = this.panelStates[i]?.hlsService?.getVideo?.() ?? null
        if (sibVideo && !sibVideo.paused) sibVideo.pause()
      }
    }
    const onSeeked = () => seekSiblingsToDate(true)

    primaryVideo.addEventListener('play', onPlay)
    primaryVideo.addEventListener('pause', onPause)
    primaryVideo.addEventListener('seeked', onSeeked)
    this.primaryVideoSyncListeners.push(
      { event: 'play', handler: onPlay as EventListener },
      { event: 'pause', handler: onPause as EventListener },
      { event: 'seeked', handler: onSeeked as EventListener },
    )
    this.primaryVideoSyncTarget = primaryVideo

    // Start the periodic drift checker
    this.driftCheckInterval = setInterval(driftCheck, DRIFT_CHECK_MS)

    // Run once immediately so siblings reflect the primary's current
    // state without waiting for a user action.
    seekSiblingsToDate(true)
  }

  /**
   * Detach all sibling-sync listeners from the previous primary video,
   * stop the drift-check timer, and clear any lingering out-of-range
   * state from siblings.
   */
  private detachPrimaryVideoSync(): void {
    if (this.driftCheckInterval !== null) {
      clearInterval(this.driftCheckInterval)
      this.driftCheckInterval = null
    }
    const target = this.primaryVideoSyncTarget
    if (target) {
      for (const { event, handler } of this.primaryVideoSyncListeners) {
        target.removeEventListener(event, handler)
      }
    }
    this.primaryVideoSyncListeners = []
    this.primaryVideoSyncTarget = null
    // Reset sibling playback rates to 1.0 so videos don't stay at
    // the adjusted speed after sync is torn down.
    for (let i = 0; i < this.panelStates.length; i++) {
      this.viewports.setOutOfRange(i, false)
      const sibVideo = this.panelStates[i]?.hlsService?.getVideo?.() ?? null
      if (sibVideo) sibVideo.playbackRate = 1.0
    }
  }

  /**
   * Dispose the video texture and HLS service for a specific panel.
   * If `slot` is omitted, operates on the primary panel (common case
   * for single-viewport flows like goHome / loadDataset teardown).
   *
   * When tearing down the primary, also resets the shared playback
   * state; non-primary slots don't touch that state.
   */
  private cleanupPanelVideo(slot?: number): void {
    const targetSlot = slot ?? this.viewports.getPrimaryIndex()
    const panel = this.panelStates[targetSlot]
    if (!panel) return

    const isPrimary = targetSlot === this.viewports.getPrimaryIndex()
    if (isPrimary) {
      this.detachPrimaryVideoSync()
      stopPlaybackLoop(this.playback)
    }

    if (panel.videoTexture) {
      panel.videoTexture.dispose()
      panel.videoTexture = null
    }
    if (panel.hlsService) {
      panel.hlsService.destroy()
      panel.hlsService = null
    }

    if (isPrimary) {
      this.appState.isPlaying = false
      resetPlaybackState(this.playback)
    }
  }

  /**
   * Legacy alias for `cleanupPanelVideo(primarySlot)`. Kept so
   * existing call sites that mean "clean up the video that's
   * currently playing" stay readable.
   */
  private cleanupVideo(): void {
    this.cleanupPanelVideo()
  }

  /**
   * Tear down datasets in every panel — used by goHome and unloadForTour.
   * Clears dataset + hls + video texture per slot and resets shared
   * Delegates to the per-panel unload path so every slot gets the
   * same dataset/video teardown AND renderer reset (back to default
   * Earth materials) behavior.
   */
  private async unloadAllPanels(): Promise<void> {
    this.detachPrimaryVideoSync()
    stopPlaybackLoop(this.playback)
    this.appState.isPlaying = false
    resetPlaybackState(this.playback)
    for (let slot = 0; slot < this.panelStates.length; slot++) {
      await this.unloadPanelDataset(slot)
    }
    this.infoDisplayOverride = null
    this.refreshPanelLegends()
    this.renderInfoPanel()
  }

  /**
   * Unload a single panel's dataset — video, texture, metadata.
   * Called by the tour engine's `unloadDataset` task after it
   * resolves a local `datasetID` handle to a slot. Keeps the rest
   * of the panels intact, unlike `unloadAllPanels`.
   *
   * When the target slot is the primary, also tears down the shared
   * playback state. Non-primary slots leave the playback UI alone.
   */
  private async unloadPanelDataset(slot: number): Promise<void> {
    const panel = this.panelStates[slot]
    if (!panel) return
    const isPrimarySlot = slot === this.viewports.getPrimaryIndex()

    // Clean the video stream, texture, and (if primary) the shared
    // playback state. cleanupPanelVideo handles both.
    this.cleanupPanelVideo(slot)

    // Clear the dataset reference and reset the base earth on that
    // specific panel's renderer so it doesn't keep showing a stale
    // texture.
    panel.dataset = null
    const renderer = this.viewports.getRendererAt(slot)
    if (renderer) {
      renderer.removeCloudOverlay?.()
      renderer.removeNightLights?.()
      renderer.disableSunLighting?.()
      try {
        await renderer.loadDefaultEarthMaterials?.()
        const sun = getSunPosition(new Date())
        renderer.enableSunLighting?.(sun.lat, sun.lng)
      } catch (err) {
        logger.warn('[App] Earth material reload after unload failed:', err)
      }
    }

    // If we just cleared the currently-displayed slot in the info
    // panel, drop the override so renderInfoPanel picks a new target.
    if (this.infoDisplayOverride === slot) {
      this.infoDisplayOverride = null
    }

    // Reflect the clear in the primary UI if applicable.
    if (isPrimarySlot) {
      this.appState.currentDataset = null
    }

    this.refreshPanelLegends()
    this.renderInfoPanel()
  }

  // --- Event listeners ---

  /** Wire up all DOM event listeners: transport controls, keyboard shortcuts, scrubber, mute. */
  setupEventListeners(): void {
    document.getElementById('home-btn')?.addEventListener('click', () => this.goHome())

    // Browse panel opens via the Tools menu's Browse button (see
    // openBrowsePanel). No standalone peek-out toggle tab.

    // Transport controls — delegate to playback module
    document.getElementById('rewind-btn')?.addEventListener('click', () =>
      rewind(this.hlsService, this.appState, this.playback, (m) => this.announce(m)))
    document.getElementById('step-back-btn')?.addEventListener('click', () =>
      stepFrame(-1, this.hlsService, this.appState, this.playback, (m) => this.announce(m)))
    document.getElementById('play-btn')?.addEventListener('click', () =>
      togglePlayPause(this.hlsService, this.appState, (m) => this.announce(m)))
    document.getElementById('step-fwd-btn')?.addEventListener('click', () =>
      stepFrame(1, this.hlsService, this.appState, this.playback, (m) => this.announce(m)))
    document.getElementById('ff-btn')?.addEventListener('click', () =>
      fastForward(this.hlsService, this.appState, this.playback, (m) => this.announce(m)))
    document.getElementById('cc-btn')?.addEventListener('click', () =>
      toggleCaptions(this.playback))

    // Mute/unmute toggle
    const muteBtn = document.getElementById('mute-btn')
    if (muteBtn) {
      muteBtn.addEventListener('click', () => {
        const video = this.hlsService?.video
        if (!video) return
        video.muted = !video.muted
        muteBtn.textContent = video.muted ? '\u{1F507}\uFE0E' : '\u{1F50A}\uFE0E'
        muteBtn.setAttribute('aria-label', video.muted ? 'Unmute audio' : 'Mute audio')
        muteBtn.style.color = video.muted ? '#aaa' : '#4da6ff'
        muteBtn.style.borderColor = video.muted ? '#555' : '#4da6ff'
      })
    }

    // Auto-rotate lives inside the Tools menu now — see toolsMenuUI.ts.

    // Scrubber
    const scrubber = document.getElementById('scrubber') as HTMLInputElement
    if (scrubber) {
      scrubber.addEventListener('input', () => {
        onScrub(parseInt(scrubber.value, 10), this.hlsService, this.playback)
      })
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const browseOverlay = document.getElementById('browse-overlay')
      if (browseOverlay && !browseOverlay.classList.contains('hidden') && browseOverlay.contains(e.target as Node)) return

      if (e.code === 'Space') {
        e.preventDefault()
        togglePlayPause(this.hlsService, this.appState, (m) => this.announce(m))
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        stepFrame(-1, this.hlsService, this.appState, this.playback, (m) => this.announce(m))
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        stepFrame(1, this.hlsService, this.appState, this.playback, (m) => this.announce(m))
      } else if (e.code === 'Home') {
        e.preventDefault()
        rewind(this.hlsService, this.appState, this.playback, (m) => this.announce(m))
      } else if (e.code === 'End') {
        e.preventDefault()
        fastForward(this.hlsService, this.appState, this.playback, (m) => this.announce(m))
      }
    })
  }

  // --- Navigation ---

  /** Load a dataset selected via the browse panel, updating URL and shifting focus to playback controls. */
  private async selectDatasetFromBrowse(id: string): Promise<void> {
    const gen = ++this.loadGeneration
    this.dismissBrowseAfterLoad()
    closeChat()
    this.announce('Loading dataset\u2026')
    this.showLoadingScreen('Loading dataset\u2026', 20)
    window.history.pushState({}, '', `?dataset=${encodeURIComponent(id)}`)
    await this.loadDataset(id)
    if (gen !== this.loadGeneration) return // a newer load superseded this one
    this.setLoading(false)
    showChatTrigger()
    const dataset = this.appState.currentDataset
    if (dataset) {
      this.announce(`Loaded dataset: ${dataset.title}`)
      this.renderer?.setCanvasDescription(`3D globe showing ${dataset.title}`)
      notifyDatasetChanged(dataset)
      setHelpActiveDataset(dataset.id)
    }
    const playBtn = document.getElementById('play-btn')
    const infoHeader = document.getElementById('info-header')
    if (playBtn && !playBtn.closest('.hidden')) {
      playBtn.focus()
    } else if (infoHeader) {
      infoHeader.focus()
    }
  }

  /** Re-show the loading screen with a fade-in if it was hidden, cancelling any pending hide timer. */
  private showLoadingScreen(message = 'Loading dataset\u2026', progress = 0): void {
    if (this.loadingHideTimer !== null) {
      clearTimeout(this.loadingHideTimer)
      this.loadingHideTimer = null
    }
    const screen = document.getElementById('loading-screen')
    if (!screen) return
    screen.classList.remove('fade-out')

    const wasHidden = screen.style.display === 'none'
    screen.style.display = 'flex'
    if (wasHidden) {
      screen.style.opacity = '0'
      void screen.offsetHeight
      screen.style.transition = 'opacity 0.3s ease'
      screen.style.opacity = '1'
      screen.addEventListener('transitionend', () => {
        screen.style.transition = ''
        screen.style.opacity = ''
      }, { once: true })
    } else {
      screen.style.opacity = ''
    }
    this.setLoadingStatus(message, progress)
  }

  /** Show the home navigation button. */
  private showHomeButton(): void {
    document.getElementById('home-btn')?.classList.remove('hidden')
  }

  /** Hide the home navigation button. */
  private hideHomeButton(): void {
    document.getElementById('home-btn')?.classList.add('hidden')
  }

  /** Navigate back to the default Earth view: tear down every panel's dataset, reload Earth materials, and re-show the browse panel. */
  private async goHome(): Promise<void> {
    this.stopTour()
    await this.unloadAllPanels()
    clearLegendCache()
    this.appState.currentDataset = null
    this.showPlaybackControls(false)
    this.showTimeLabel(false)
    document.getElementById('info-panel')?.classList.add('hidden')
    this.hideHomeButton()
    // Reset overlays that tours may have turned on. In multi-view
    // mode we fan out across every panel so siblings don't keep
    // stale labels/borders after home.
    for (const r of this.viewports.getAll()) {
      r.toggleLabels?.(false)
      r.toggleBoundaries?.(false)
    }
    syncToolsMenuState({ labels: false, borders: false, terrain: false, autoRotate: false })
    window.history.pushState({}, '', window.location.pathname)

    this.showLoadingScreen('Loading Earth\u2026', 20)
    if (this.renderer) {
      const cloudUrl = CLOUD_TEXTURE_URL
      let earthFraction = 0
      let cloudFraction = 0
      const updateProgress = () => {
        const combined = earthFraction * EARTH_TEXTURE_WEIGHT + cloudFraction * CLOUD_TEXTURE_WEIGHT
        this.setLoadingStatus('Loading Earth\u2026', LOADING_BASE_PROGRESS + Math.round(combined * LOADING_TEXTURE_RANGE))
      }
      await Promise.all([
        this.renderer.loadDefaultEarthMaterials((f: number) => { earthFraction = f; updateProgress() }),
        this.renderer.loadCloudOverlay(cloudUrl, (f: number) => { cloudFraction = f; updateProgress() })
      ])
      const sun = getSunPosition(new Date())
      this.renderer.enableSunLighting(sun.lat, sun.lng)
    }
    this.setLoading(false)
    hideChatTrigger()
    closeChat()
    showBrowseUI(this.appState.datasets, {
      onSelectDataset: (id) => this.selectDatasetFromBrowse(id),
      announce: (msg) => this.announce(msg),
      isMobile: this.isMobile,
      onOpenChat: (query) => this.openChatWithQuery(query),
    })
    this.renderer?.setCanvasDescription('Interactive 3D globe showing Earth')
    notifyDatasetChanged(null)
    setHelpActiveDataset(null)
  }

  /**
   * Load a tour from a URL — exposed for console testing.
   * Usage: window.app.playTour('/assets/test-tour.json')
   */
  async playTour(url: string): Promise<void> {
    const gen = ++this.loadGeneration
    this.tourIsStandalone = true
    await this.startTour(url, gen)
  }

  /**
   * Synchronously release video/HLS resources across all panels
   * without the async Earth-material reload that `unloadAllPanels`
   * performs. Used by `dispose()` where the renderers are about to
   * be torn down and awaiting async work is neither necessary nor
   * safe.
   */
  private teardownAllPanelResources(): void {
    this.detachPrimaryVideoSync()
    stopPlaybackLoop(this.playback)
    this.appState.isPlaying = false
    resetPlaybackState(this.playback)
    for (const panel of this.panelStates) {
      if (panel.videoTexture) { panel.videoTexture.dispose(); panel.videoTexture = null }
      if (panel.hlsService) { panel.hlsService.destroy(); panel.hlsService = null }
      panel.dataset = null
    }
  }

  /** Clean up all resources: video streams, textures, and every viewport renderer. */
  dispose(): void {
    this.teardownAllPanelResources()
    this.viewports.dispose()
    this.panelStates = []
  }
}

// Register service worker for tile caching (cache-first strategy for GIBS tiles).
// Skip in Tauri desktop app — tile caching is handled by the Rust backend.
if ('serviceWorker' in navigator && !(window as any).__TAURI__) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    logger.warn('[SW] Registration failed:', err)
  })
}

// Check for app updates on launch (Tauri desktop only).
// Runs in the background after the app is fully loaded — non-blocking.
async function checkForUpdates(): Promise<void> {
  if (!(window as any).__TAURI__) return
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (update) {
      logger.info(`[Updater] Update available: ${update.version}`)
      // download + install; the plugin shows a native confirmation dialog
      // because "dialog: true" is set in tauri.conf.json
      await update.downloadAndInstall()
    }
  } catch (err) {
    logger.warn('[Updater] Update check failed:', err)
  }
}

// Initialize app on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  const app = new InteractiveSphere()
  app.setupEventListeners()
  await app.initialize()

  ;(window as any).app = app

  // Non-blocking update check after app is ready
  checkForUpdates()
})
