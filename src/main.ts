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
import { formatDate, videoTimeToDate, isSubDailyPeriod, inferDisplayInterval, getSunPosition } from './utils/time'
import type { Dataset, AppState } from './types'

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
  private playbackUpdateId: number | null = null
  private scrubbing = false
  private displayInterval: { intervalMs: number; showTime: boolean } | null = null
  private loopPauseTimer: ReturnType<typeof setTimeout> | null = null

  async initialize(): Promise<void> {
    try {
      this.setLoading(true)

      const container = document.getElementById('container')
      if (!container) throw new Error('Container element not found')

      this.renderer = new SphereRenderer(container)
      const segments = this.isMobile ? 32 : 64
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
      await this.loadDatasets()

      const datasetId = this.getDatasetIdFromUrl()
      if (datasetId) {
        // Load a simple texture first, then replace with dataset
        await this.loadDefaultTexture()
        await this.loadDataset(datasetId)
      } else {
        // No dataset — load enhanced Earth with all maps
        await this.renderer.loadDefaultEarthMaterials()

        this.renderer.loadCloudOverlay(
          'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/clouds_8192.jpg'
        )

        // Position sun based on current UTC time
        const sun = getSunPosition(new Date())
        this.renderer.enableSunLighting(sun.lat, sun.lng)
      }

      this.setLoading(false)
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
        console.warn('[App] Default Earth texture not found, using solid color')
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
      this.cleanupVideo()
      this.renderer?.removeCloudOverlay()
      this.renderer?.removeNightLights()
      this.renderer?.disableSunLighting()
      await this.displayDataset(datasetId)
    } catch (error) {
      this.setError(error instanceof Error ? error.message : 'Failed to load dataset')
    }
  }

  private async displayDataset(datasetId: string): Promise<void> {
    const dataset = dataService.getDatasetById(datasetId)
    if (!dataset) throw new Error(`Dataset not found: ${datasetId}`)

    this.appState.currentDataset = dataset

    console.log('[App] Loading dataset:', {
      id: dataset.id,
      title: dataset.title,
      format: dataset.format,
      hasTimeData: !!(dataset.startTime && dataset.endTime)
    })

    this.displayDatasetInfo(dataset)

    if (dataService.isImageDataset(dataset)) {
      this.showPlaybackControls(false)
      await this.loadImageDataset(dataset)
    } else if (dataService.isVideoDataset(dataset)) {
      await this.loadVideoDataset(dataset)
    } else {
      throw new Error(`Unsupported format: ${dataset.format}`)
    }
  }

  private async loadImageDataset(dataset: Dataset): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image()

      img.onload = () => {
        if (!this.renderer) {
          reject(new Error('Renderer not initialized'))
          return
        }

        this.renderer.updateTexture(img)
        if (dataset.startTime) {
          const showTime = isSubDailyPeriod(dataset.period)
          this.appState.timeLabel = formatDate(new Date(dataset.startTime), showTime)
          this.showTimeLabel(true)
        } else {
          this.showTimeLabel(false)
        }

        console.log('[App] Image dataset loaded successfully')
        resolve()
      }

      img.onerror = () => {
        reject(new Error(`Failed to load image from ${dataset.dataLink}`))
      }

      img.crossOrigin = 'anonymous'
      img.src = dataset.dataLink
    })
  }

  private async loadVideoDataset(dataset: Dataset): Promise<void> {
    if (!this.renderer) throw new Error('Renderer not initialized')

    const vimeoId = dataService.extractVimeoId(dataset.dataLink)
    if (!vimeoId) throw new Error(`Could not extract Vimeo ID from: ${dataset.dataLink}`)

    this.hlsService = new HLSService()
    const manifest = await this.hlsService.fetchManifest(vimeoId)
    console.log('[App] Video manifest received:', { duration: manifest.duration, qualities: manifest.files.length })

    const video = this.hlsService.createVideo()

    try {
      await this.hlsService.loadStream(manifest.hls, video, this.isMobile)
    } catch (hlsError) {
      console.warn('[App] HLS failed, falling back to direct MP4:', hlsError)
      const mp4File = manifest.files.find(f => f.quality === '1080p')
        ?? manifest.files.find(f => f.quality === '720p')
        ?? manifest.files.find(f => f.width && f.link)
      if (!mp4File) throw new Error('No playable video source found')
      await this.hlsService.loadDirect(mp4File.link, video)
    }

    await new Promise<void>((resolve) => {
      const onCanPlay = () => {
        video.removeEventListener('canplay', onCanPlay)
        resolve()
      }
      if (video.readyState >= 3) {
        resolve()
      } else {
        video.addEventListener('canplay', onCanPlay)
      }
    })

    // Infer display interval from time range + video duration
    if (dataset.startTime && dataset.endTime) {
      const start = new Date(dataset.startTime)
      const end = new Date(dataset.endTime)
      this.displayInterval = inferDisplayInterval(start, end, video.duration)
      console.log('[App] Inferred display interval:', this.displayInterval)
    } else {
      this.displayInterval = null
    }

    // Force first frame decode before attaching to the sphere — keeps
    // the default Earth texture visible until we have real video data
    // instead of flashing a black ball.  Muted autoplay is allowed.
    try {
      await video.play()
      video.pause()
      video.currentTime = 0
    } catch {
      // Autoplay blocked — texture will update when user presses play
    }

    this.videoTexture = this.renderer.setVideoTexture(video)
    this.videoTexture.needsUpdate = true

    const scrubber = document.getElementById('scrubber') as HTMLInputElement
    if (scrubber) {
      scrubber.max = '1000'
      scrubber.value = '0'
    }

    this.updateVideoTimeLabel(0)
    this.showPlaybackControls(true)
    this.updatePlayButton(true)
    this.startPlaybackLoop()

    console.log('[App] Video dataset loaded, duration:', manifest.duration, 's')
  }

  private startPlaybackLoop(): void {
    this.stopPlaybackLoop()

    const loop = () => {
      if (this.hlsService && this.renderer) {
        const video = this.hlsService.getVideo()
        if (video && video.readyState >= 2) {
          // VideoTexture handles GPU uploads natively — just flag needsUpdate
          // when scrubbing a paused video so Three.js re-uploads the new frame.
          if (this.scrubbing && this.videoTexture) {
            this.videoTexture.needsUpdate = true
            this.scrubbing = false
          }

          // Auto-loop: pause at end, then restart after 2 seconds
          if (!video.paused && video.currentTime >= video.duration - 0.05 && !this.loopPauseTimer) {
            video.pause()
            this.loopPauseTimer = setTimeout(() => {
              this.loopPauseTimer = null
              if (this.hlsService && this.appState.isPlaying) {
                video.currentTime = 0
                video.play().catch(() => {})
              }
            }, 2000)
          }

          const scrubber = document.getElementById('scrubber') as HTMLInputElement
          if (scrubber && !scrubber.matches(':active')) {
            const fraction = video.duration > 0 ? video.currentTime / video.duration : 0
            scrubber.value = String(Math.round(fraction * 1000))
          }

          this.updateVideoTimeLabel(video.currentTime)
        }
      }

      this.playbackUpdateId = requestAnimationFrame(loop)
    }

    this.playbackUpdateId = requestAnimationFrame(loop)
  }

  private stopPlaybackLoop(): void {
    if (this.playbackUpdateId !== null) {
      cancelAnimationFrame(this.playbackUpdateId)
      this.playbackUpdateId = null
    }
  }

  private updateVideoTimeLabel(videoTime: number): void {
    const dataset = this.appState.currentDataset
    if (!dataset) return

    if (dataset.startTime && dataset.endTime) {
      const start = new Date(dataset.startTime)
      const end = new Date(dataset.endTime)
      const videoDuration = this.hlsService?.duration ?? 1
      const snapMs = this.displayInterval?.intervalMs
      const currentDate = videoTimeToDate(videoTime, videoDuration, start, end, snapMs)
      const showTime = dataset.period
        ? isSubDailyPeriod(dataset.period)
        : (this.displayInterval?.showTime ?? false)
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
      } else {
        timeLabel.classList.add('hidden')
      }
    }
  }

  // --- Playback controls ---

  private togglePlayPause(): void {
    if (!this.hlsService) return

    if (this.hlsService.paused) {
      this.hlsService.play()?.catch(e => {
        console.warn('[App] Play failed:', e)
        this.setError('Playback failed — try clicking play again')
      })
      this.appState.isPlaying = true
    } else {
      this.hlsService.pause()
      this.appState.isPlaying = false
    }
    this.updatePlayButton(this.hlsService.paused)
  }

  private rewind(): void {
    if (!this.hlsService) return
    this.hlsService.currentTime = 0
    this.hlsService.pause()
    this.appState.isPlaying = false
    this.updatePlayButton(true)
    this.scrubbing = true
  }

  private fastForward(): void {
    if (!this.hlsService) return
    const video = this.hlsService.getVideo()
    if (video && video.duration) {
      video.currentTime = Math.max(0, video.duration - 0.05)
      this.hlsService.pause()
      this.appState.isPlaying = false
      this.updatePlayButton(true)
      this.scrubbing = true
    }
  }

  private stepFrame(direction: 1 | -1): void {
    if (!this.hlsService) return
    const video = this.hlsService.getVideo()
    if (!video || !video.duration) return

    if (!video.paused) {
      this.hlsService.pause()
      this.appState.isPlaying = false
      this.updatePlayButton(true)
    }

    // Step by one display interval worth of video time, or 1 frame if no interval
    let step: number
    const dataset = this.appState.currentDataset
    if (this.displayInterval && dataset?.startTime && dataset?.endTime) {
      const totalMs = new Date(dataset.endTime).getTime() - new Date(dataset.startTime).getTime()
      step = (this.displayInterval.intervalMs / totalMs) * video.duration
    } else {
      step = 1 / 30
    }

    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + direction * step))
    this.scrubbing = true
  }

  private onScrub(value: number): void {
    if (!this.hlsService) return
    const fraction = value / 1000
    const video = this.hlsService.getVideo()
    if (video && video.duration) {
      video.currentTime = fraction * video.duration
      this.scrubbing = true
    }
  }

  private updatePlayButton(paused: boolean): void {
    const playBtn = document.getElementById('play-btn')
    if (playBtn) {
      playBtn.textContent = paused ? '▶' : '⏸'
    }
  }

  // --- UI helpers ---

  private displayDatasetInfo(dataset: Dataset): void {
    const infoPanel = document.getElementById('info-panel')
    const infoTitle = document.getElementById('info-title')
    const infoBody = document.getElementById('info-body')
    const infoHeader = document.getElementById('info-header')
    if (!infoPanel || !infoTitle || !infoBody || !infoHeader) return

    const e = dataset.enriched

    // Header — always visible
    infoTitle.textContent = dataset.title

    // Body content
    let html = ''

    // Source
    const source = e?.datasetDeveloper?.name || dataset.organization
    if (source) {
      html += `<p class="info-source">${source}</p>`
    }

    // Description
    const description = e?.description || dataset.abstractTxt
    if (description) {
      let text = description
      if (text.length > 600) {
        const cut = text.lastIndexOf('.', 600)
        text = text.substring(0, cut > 200 ? cut + 1 : 600) + '…'
      }
      html += `<p class="info-description">${text}</p>`
    }

    // Categories
    if (e?.categories) {
      const cats = Object.entries(e.categories)
        .map(([group, subs]) => subs.length ? `${group}: ${subs.join(', ')}` : group)
      html += `<p class="info-categories">${cats.join(' · ')}</p>`
    }

    // Keywords
    const keywords = e?.keywords || dataset.tags
    if (keywords && keywords.length > 0) {
      html += `<div class="info-keywords">`
      keywords.forEach(kw => {
        html += `<span class="info-keyword">${kw}</span>`
      })
      html += `</div>`
    }

    // Related datasets — clickable links that load into the sphere
    if (e?.relatedDatasets && e.relatedDatasets.length > 0) {
      html += `<p class="info-section-label">Related Datasets</p>`
      html += `<ul class="info-related">`
      e.relatedDatasets.forEach(rd => {
        // Find matching dataset ID by title
        const match = this.appState.datasets.find(d =>
          d.title.toLowerCase().replace(/\s*\(movie\)\s*/g, '').trim() ===
          rd.title.toLowerCase().trim()
        )
        if (match) {
          html += `<li><a href="?dataset=${encodeURIComponent(match.id)}" data-dataset-id="${match.id}">${rd.title}</a></li>`
        } else {
          html += `<li><span style="color: #777; font-size: 0.7rem;">${rd.title}</span></li>`
        }
      })
      html += `</ul>`
    }

    // Catalog link
    if (e?.catalogUrl) {
      html += `<p class="info-section-label">Source</p>`
      html += `<a href="${e.catalogUrl}" target="_blank" rel="noopener" class="info-catalog-link">View on NOAA SOS →</a>`
    }

    infoBody.innerHTML = html
    infoPanel.classList.remove('hidden')

    // Wire up related dataset links to load in-place
    infoBody.querySelectorAll('a[data-dataset-id]').forEach(link => {
      link.addEventListener('click', (ev) => {
        ev.preventDefault()
        const id = (link as HTMLElement).dataset.datasetId
        if (id) {
          window.history.pushState({}, '', `?dataset=${encodeURIComponent(id)}`)
          this.loadDataset(id)
        }
      })
    })

    // Toggle expand/collapse on header click
    infoHeader.onclick = () => {
      infoPanel.classList.toggle('expanded')
    }
  }

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

  private setLoading(isLoading: boolean): void {
    this.appState.isLoading = isLoading
  }

  private setError(error: string): void {
    this.appState.error = error
    const errorEl = document.getElementById('error-message')
    if (errorEl) {
      errorEl.textContent = error
      errorEl.classList.toggle('hidden', !error)
      setTimeout(() => {
        if (!errorEl.classList.contains('hidden')) {
          errorEl.classList.add('hidden')
        }
      }, 5000)
    }
    console.error('[App] Error:', error)
  }

  private cleanupVideo(): void {
    this.stopPlaybackLoop()
    if (this.videoTexture) {
      this.videoTexture.dispose()
      this.videoTexture = null
    }
    if (this.hlsService) {
      this.hlsService.destroy()
      this.hlsService = null
    }
    this.appState.isPlaying = false
    this.displayInterval = null
    if (this.loopPauseTimer) {
      clearTimeout(this.loopPauseTimer)
      this.loopPauseTimer = null
    }
  }

  setupEventListeners(): void {
    // Transport controls
    document.getElementById('rewind-btn')?.addEventListener('click', () => this.rewind())
    document.getElementById('step-back-btn')?.addEventListener('click', () => this.stepFrame(-1))
    document.getElementById('play-btn')?.addEventListener('click', () => this.togglePlayPause())
    document.getElementById('step-fwd-btn')?.addEventListener('click', () => this.stepFrame(1))
    document.getElementById('ff-btn')?.addEventListener('click', () => this.fastForward())

    // Auto-rotate (both inline and standalone buttons)
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
      })
    }

    // Scrubber
    const scrubber = document.getElementById('scrubber') as HTMLInputElement
    if (scrubber) {
      scrubber.addEventListener('input', () => {
        this.onScrub(parseInt(scrubber.value, 10))
      })
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return

      if (e.code === 'Space') {
        e.preventDefault()
        this.togglePlayPause()
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        this.stepFrame(-1)
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        this.stepFrame(1)
      } else if (e.code === 'Home') {
        e.preventDefault()
        this.rewind()
      } else if (e.code === 'End') {
        e.preventDefault()
        this.fastForward()
      }
    })
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
