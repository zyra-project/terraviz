/**
 * Main application entry point
 *
 * Load a dataset via URL query param: ?dataset=INTERNAL_SOS_768
 * No dataset param = just the default Earth globe
 */

import * as THREE from 'three'
import { SphereRenderer } from './services/sphereRenderer'
import { HLSService } from './services/hlsService'
import { dataService } from './services/dataService'
import { formatDate, videoTimeToDate, isSubDailyPeriod, getSunPosition } from './utils/time'
import { logger } from './utils/logger'
import type { AppState } from './types'

// Extracted modules
import { showBrowseUI, hideBrowseUI } from './ui/browseUI'
import { initChatUI, notifyDatasetChanged } from './ui/chatUI'
import {
  createPlaybackState, startPlaybackLoop, stopPlaybackLoop,
  togglePlayPause, rewind, fastForward, stepFrame, onScrub,
  updatePlayButton, toggleCaptions, resetPlaybackState,
  type PlaybackState,
} from './ui/playbackController'
import {
  loadImageDataset, loadVideoDataset, displayDatasetInfo,
} from './services/datasetLoader'

// --- App constants ---
const SPHERE_SEGMENTS_MOBILE = 32
const SPHERE_SEGMENTS_DESKTOP = 64
const EARTH_TEXTURE_WEIGHT = 0.8
const CLOUD_TEXTURE_WEIGHT = 0.2
const LOADING_BASE_PROGRESS = 20
const LOADING_TEXTURE_RANGE = 70
const LOADING_HIDE_DELAY_MS = 300

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

  private readonly isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)

  private renderer: SphereRenderer | null = null
  private hlsService: HLSService | null = null
  private videoTexture: THREE.VideoTexture | null = null
  private playback: PlaybackState = createPlaybackState()
  private loadingHideTimer: ReturnType<typeof setTimeout> | null = null

  async initialize(): Promise<void> {
    try {
      this.setLoading(true)
      this.setLoadingStatus('Starting up\u2026', 5)

      if (!this.checkWebGLSupport()) return

      const container = document.getElementById('container')
      if (!container) throw new Error('Container element not found')

      this.setLoadingStatus('Creating renderer\u2026', 15)
      this.renderer = new SphereRenderer(container)
      const segments = this.isMobile ? SPHERE_SEGMENTS_MOBILE : SPHERE_SEGMENTS_DESKTOP
      this.renderer.createSphere({
        radius: 1,
        widthSegments: segments,
        heightSegments: segments
      })

      // Wire up lat/lng display
      const latlngEl = document.getElementById('latlng-display')
      if (latlngEl) {
        this.renderer.setLatLngCallbacks(
          (lat, lng) => {
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

      const datasetId = this.getDatasetIdFromUrl()
      if (datasetId) {
        this.setLoadingStatus('Loading Earth texture\u2026', 50)
        await this.loadDefaultTexture()
        this.setLoadingStatus('Loading dataset\u2026', 65)
        await this.loadDataset(datasetId)
        this.setLoading(false)
      } else {
        this.setLoadingStatus('Loading Earth textures\u2026', 20)
        const cloudUrl = 'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/clouds_8192.jpg'

        let earthFraction = 0
        let cloudFraction = 0
        const updateProgress = () => {
          const combined = earthFraction * EARTH_TEXTURE_WEIGHT + cloudFraction * CLOUD_TEXTURE_WEIGHT
          this.setLoadingStatus('Loading Earth textures\u2026', LOADING_BASE_PROGRESS + Math.round(combined * LOADING_TEXTURE_RANGE))
        }
        await Promise.all([
          this.renderer.loadDefaultEarthMaterials((f) => { earthFraction = f; updateProgress() }),
          this.renderer.loadCloudOverlay(cloudUrl, (f) => { cloudFraction = f; updateProgress() })
        ])

        const sun = getSunPosition(new Date())
        this.renderer.enableSunLighting(sun.lat, sun.lng)

        this.setLoading(false)
        showBrowseUI(this.appState.datasets, {
          onSelectDataset: (id) => this.selectDatasetFromBrowse(id),
          announce: (msg) => this.announce(msg),
          isMobile: this.isMobile,
        })
      }
    } catch (error) {
      this.setLoading(false)
      this.setError(error instanceof Error ? error.message : 'Unknown error')
    }
  }

  private getDatasetIdFromUrl(): string | null {
    const params = new URLSearchParams(window.location.search)
    return params.get('dataset')
  }

  private loadDefaultTexture(): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        this.renderer?.updateTexture(img)
        resolve()
      }
      img.onerror = () => {
        logger.warn('[App] Default Earth texture not found, using solid color')
        resolve()
      }
      img.src = '/assets/Earth_Diffuse_6K.jpg'
    })
  }

  private async loadDatasets(): Promise<void> {
    const datasets = await dataService.fetchDatasets()
    this.appState.datasets = datasets
  }

  private async loadDataset(datasetId: string): Promise<void> {
    try {
      const oldVideoTexture = this.videoTexture
      const oldHlsService = this.hlsService
      this.videoTexture = null
      this.hlsService = null
      stopPlaybackLoop(this.playback)
      this.appState.isPlaying = false
      resetPlaybackState(this.playback)

      this.renderer?.removeCloudOverlay()
      this.renderer?.removeNightLights()
      this.renderer?.disableSunLighting()
      await this.displayDataset(datasetId)
      this.showHomeButton()

      if (oldVideoTexture) oldVideoTexture.dispose()
      if (oldHlsService) oldHlsService.destroy()
    } catch (error) {
      this.setError(error instanceof Error ? error.message : 'Failed to load dataset')
    }
  }

  private async displayDataset(datasetId: string): Promise<void> {
    const dataset = dataService.getDatasetById(datasetId)
    if (!dataset) throw new Error(`Dataset not found: ${datasetId}`)

    this.appState.currentDataset = dataset

    logger.info('[App] Loading dataset:', {
      id: dataset.id,
      title: dataset.title,
      format: dataset.format,
      hasTimeData: !!(dataset.startTime && dataset.endTime)
    })

    displayDatasetInfo(dataset, this.appState.datasets, (id) => this.loadDataset(id))

    if (!this.renderer) throw new Error('Renderer not initialized')

    const loaderCallbacks = {
      showPlaybackControls: (show: boolean) => this.showPlaybackControls(show),
      showTimeLabel: (show: boolean) => this.showTimeLabel(show),
    }

    if (dataService.isImageDataset(dataset)) {
      await loadImageDataset(dataset, this.renderer, this.appState, this.isMobile, loaderCallbacks)
    } else if (dataService.isVideoDataset(dataset)) {
      const result = await loadVideoDataset(
        dataset, this.renderer, this.appState, this.isMobile, this.playback, loaderCallbacks
      )
      this.hlsService = result.hlsService
      this.videoTexture = result.videoTexture
      this.doStartPlaybackLoop()
    } else {
      throw new Error(`Unsupported format: ${dataset.format}`)
    }
  }

  private doStartPlaybackLoop(): void {
    startPlaybackLoop(
      this.playback,
      this.hlsService,
      this.videoTexture,
      this.appState,
      (time) => this.updateVideoTimeLabel(time),
    )
  }

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

  private showPlaybackControls(show: boolean): void {
    const controls = document.getElementById('playback-controls')
    const standalone = document.getElementById('auto-rotate-standalone')
    if (controls) {
      controls.classList.toggle('hidden', !show)
    }
    if (standalone) {
      standalone.classList.toggle('hidden', show)
    }
  }

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

  private announce(message: string): void {
    const el = document.getElementById('a11y-announcer')
    if (el) {
      el.textContent = ''
      requestAnimationFrame(() => { el.textContent = message })
    }
  }

  private initChat(): void {
    initChatUI({
      onLoadDataset: (id) => this.selectDatasetFromChat(id),
      getDatasets: () => this.appState.datasets,
      getCurrentDataset: () => this.appState.currentDataset,
      announce: (msg) => this.announce(msg),
    })
  }

  private async selectDatasetFromChat(id: string): Promise<void> {
    hideBrowseUI()
    this.announce('Loading dataset\u2026')
    this.showLoadingScreen('Loading dataset\u2026', 20)
    window.history.pushState({}, '', `?dataset=${encodeURIComponent(id)}`)
    await this.loadDataset(id)
    this.setLoading(false)
    const dataset = this.appState.currentDataset
    if (dataset) {
      this.announce(`Loaded dataset: ${dataset.title}`)
      this.renderer?.setCanvasDescription(`3D globe showing ${dataset.title}`)
      notifyDatasetChanged(dataset)
    }
  }

  private cleanupVideo(): void {
    stopPlaybackLoop(this.playback)
    if (this.videoTexture) {
      this.videoTexture.dispose()
      this.videoTexture = null
    }
    if (this.hlsService) {
      this.hlsService.destroy()
      this.hlsService = null
    }
    this.appState.isPlaying = false
    resetPlaybackState(this.playback)
  }

  // --- Event listeners ---

  setupEventListeners(): void {
    document.getElementById('home-btn')?.addEventListener('click', () => this.goHome())

    // Browse panel collapse/expand toggle
    const browseToggle = document.getElementById('browse-toggle')
    const browseOverlay = document.getElementById('browse-overlay')
    if (browseToggle && browseOverlay) {
      browseToggle.addEventListener('click', () => {
        const collapsed = browseOverlay.classList.toggle('collapsed')
        browseToggle.innerHTML = collapsed ? '&#9656;' : '&#9666;'
        browseToggle.setAttribute('aria-label', collapsed ? 'Open dataset browser' : 'Close dataset browser')
        browseToggle.setAttribute('aria-expanded', String(!collapsed))
        this.announce(collapsed ? 'Dataset browser closed' : 'Dataset browser opened')
        if (collapsed) {
          browseToggle.focus()
        } else {
          const searchInput = document.getElementById('browse-search') as HTMLInputElement | null
          if (searchInput && !this.isMobile) searchInput.focus()
        }
      })
    }

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

    // Auto-rotate
    const rotateBtns = [
      document.getElementById('auto-rotate-btn'),
      document.getElementById('auto-rotate-standalone')
    ].filter(Boolean) as HTMLElement[]
    for (const btn of rotateBtns) {
      btn.addEventListener('click', () => {
        if (!this.renderer) return
        const active = this.renderer.toggleAutoRotate()
        for (const b of rotateBtns) {
          b.style.color = active ? '#4da6ff' : '#aaa'
          b.style.borderColor = active ? '#4da6ff' : '#555'
        }
        this.announce(active ? 'Auto-rotation enabled' : 'Auto-rotation disabled')
      })
    }

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

  private async selectDatasetFromBrowse(id: string): Promise<void> {
    hideBrowseUI()
    this.announce('Loading dataset\u2026')
    this.showLoadingScreen('Loading dataset\u2026', 20)
    window.history.pushState({}, '', `?dataset=${encodeURIComponent(id)}`)
    await this.loadDataset(id)
    this.setLoading(false)
    const dataset = this.appState.currentDataset
    if (dataset) {
      this.announce(`Loaded dataset: ${dataset.title}`)
      this.renderer?.setCanvasDescription(`3D globe showing ${dataset.title}`)
      notifyDatasetChanged(dataset)
    }
    const playBtn = document.getElementById('play-btn')
    const infoHeader = document.getElementById('info-header')
    if (playBtn && !playBtn.closest('.hidden')) {
      playBtn.focus()
    } else if (infoHeader) {
      infoHeader.focus()
    }
  }

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

  private showHomeButton(): void {
    document.getElementById('home-btn')?.classList.remove('hidden')
  }

  private hideHomeButton(): void {
    document.getElementById('home-btn')?.classList.add('hidden')
  }

  private async goHome(): Promise<void> {
    this.cleanupVideo()
    this.appState.currentDataset = null
    this.showPlaybackControls(false)
    this.showTimeLabel(false)
    document.getElementById('info-panel')?.classList.add('hidden')
    this.hideHomeButton()
    window.history.pushState({}, '', window.location.pathname)

    this.showLoadingScreen('Loading Earth\u2026', 20)
    if (this.renderer) {
      const cloudUrl = 'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/clouds_8192.jpg'
      let earthFraction = 0
      let cloudFraction = 0
      const updateProgress = () => {
        const combined = earthFraction * EARTH_TEXTURE_WEIGHT + cloudFraction * CLOUD_TEXTURE_WEIGHT
        this.setLoadingStatus('Loading Earth\u2026', LOADING_BASE_PROGRESS + Math.round(combined * LOADING_TEXTURE_RANGE))
      }
      await Promise.all([
        this.renderer.loadDefaultEarthMaterials((f) => { earthFraction = f; updateProgress() }),
        this.renderer.loadCloudOverlay(cloudUrl, (f) => { cloudFraction = f; updateProgress() })
      ])
      const sun = getSunPosition(new Date())
      this.renderer.enableSunLighting(sun.lat, sun.lng)
    }
    this.setLoading(false)
    showBrowseUI(this.appState.datasets, {
      onSelectDataset: (id) => this.selectDatasetFromBrowse(id),
      announce: (msg) => this.announce(msg),
      isMobile: this.isMobile,
    })
    this.renderer?.setCanvasDescription('Interactive 3D globe showing Earth')
    notifyDatasetChanged(null)
  }

  dispose(): void {
    this.cleanupVideo()
    if (this.renderer) {
      this.renderer.dispose()
    }
  }
}

// Initialize app on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  const app = new InteractiveSphere()
  app.setupEventListeners()
  await app.initialize()

  ;(window as any).app = app
})
