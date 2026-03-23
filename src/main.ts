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
  private captionTrack: TextTrack | null = null
  private displayInterval: { intervalMs: number; showTime: boolean } | null = null
  private loopPauseTimer: ReturnType<typeof setTimeout> | null = null
  private loadingHideTimer: ReturnType<typeof setTimeout> | null = null

  async initialize(): Promise<void> {
    try {
      this.setLoading(true)
      this.setLoadingStatus('Starting up\u2026', 5)

      const container = document.getElementById('container')
      if (!container) throw new Error('Container element not found')

      this.setLoadingStatus('Creating renderer\u2026', 15)
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
      this.setLoadingStatus('Loading datasets\u2026', 30)
      await this.loadDatasets()

      const datasetId = this.getDatasetIdFromUrl()
      if (datasetId) {
        // Load a simple texture first, then replace with dataset
        this.setLoadingStatus('Loading Earth texture\u2026', 50)
        await this.loadDefaultTexture()
        this.setLoadingStatus('Loading dataset\u2026', 65)
        await this.loadDataset(datasetId)
        this.setLoading(false)
      } else {
        // No dataset — load enhanced Earth, then show the browse UI on top
        this.setLoadingStatus('Loading Earth textures\u2026', 50)
        await this.renderer.loadDefaultEarthMaterials()

        this.setLoadingStatus('Adding atmosphere\u2026', 85)
        this.renderer.loadCloudOverlay(
          'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/clouds_8192.jpg'
        )

        // Position sun based on current UTC time
        const sun = getSunPosition(new Date())
        this.renderer.enableSunLighting(sun.lat, sun.lng)

        this.setLoading(false)
        this.showBrowseUI()
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
      this.showHomeButton()
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
    const url = dataset.dataLink
    const ext = url.match(/(\.\w+)$/)
    const base = ext ? url.slice(0, -ext[1].length) : url
    const suffix = ext ? ext[1] : ''

    // Pick resolution based on device capability
    const resolutions = this.isMobile ? ['_2048', '_1024'] : ['_4096', '_2048', '_1024']
    const candidates = [...resolutions.map(r => `${base}${r}${suffix}`), url]

    const img = await this.tryLoadImage(candidates)

    if (!this.renderer) throw new Error('Renderer not initialized')

    this.renderer.updateTexture(img)
    if (dataset.startTime) {
      const showTime = isSubDailyPeriod(dataset.period)
      this.appState.timeLabel = formatDate(new Date(dataset.startTime), showTime)
      this.showTimeLabel(true)
    } else {
      this.showTimeLabel(false)
    }

    console.log(`[App] Image dataset loaded successfully: ${img.src}`)
  }

  private tryLoadImage(urls: string[]): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      let index = 0

      const tryNext = () => {
        if (index >= urls.length) {
          reject(new Error(`Failed to load image, tried: ${urls.join(', ')}`))
          return
        }

        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => resolve(img)
        img.onerror = () => {
          index++
          tryNext()
        }
        img.src = urls[index]
      }

      tryNext()
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

    await new Promise<void>((resolve, reject) => {
      const onCanPlay = () => {
        video.removeEventListener('canplay', onCanPlay)
        resolve()
      }
      if (video.readyState >= 3) {
        resolve()
      } else {
        video.addEventListener('canplay', onCanPlay)
        // Guard against the video never becoming playable (e.g. HLS error
        // recovery loop on mobile).  20 s is generous — most streams load in
        // under 5 s on a decent connection.
        setTimeout(() => {
          video.removeEventListener('canplay', onCanPlay)
          reject(new Error('Video took too long to load — check your connection and try again'))
        }, 20000)
      }
    })

    // Show mute button only when the stream has audio
    const muteBtn = document.getElementById('mute-btn') as HTMLElement | null
    if (muteBtn) {
      muteBtn.style.display = this.hlsService.hasAudio ? '' : 'none'
    }

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
    // Wait for an actual decoded frame via requestVideoFrameCallback
    // (or a short timeout as fallback) before pausing.
    try {
      await video.play()
      await new Promise<void>((resolve) => {
        if ('requestVideoFrameCallback' in video) {
          (video as any).requestVideoFrameCallback(() => resolve())
        } else {
          setTimeout(resolve, 150)
        }
      })
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

    if (dataset.closedCaptionLink) {
      this.loadCaptions(video, dataset.closedCaptionLink)
    }

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

  // --- Closed captions ---

  private async loadCaptions(video: HTMLVideoElement, captionUrl: string): Promise<void> {
    try {
      // sos.noaa.gov blocks cross-origin requests; route through the existing proxy
      const fetchUrl = captionUrl.includes('sos.noaa.gov')
        ? `https://video-proxy.zyra-project.org/captions?url=${encodeURIComponent(captionUrl)}`
        : captionUrl

      const response = await fetch(fetchUrl)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const srt = await response.text()

      const cues = this.parseSRT(srt)
      if (cues.length === 0) {
        console.warn('[App] Caption file contained no parseable cues')
        return
      }

      const track = video.addTextTrack('captions', 'Closed Captions', 'en')
      track.mode = 'hidden'
      for (const cue of cues) {
        track.addCue(new VTTCue(cue.start, cue.end, cue.text))
      }

      track.addEventListener('cuechange', () => {
        const overlay = document.getElementById('caption-overlay')
        if (!overlay) return
        const activeCues = track.activeCues
        if (!activeCues || activeCues.length === 0 || track.mode !== 'showing') {
          overlay.textContent = ''
          overlay.style.display = 'none'
        } else {
          overlay.textContent = Array.from(activeCues).map(c => (c as VTTCue).text).join('\n')
          overlay.style.display = 'block'
        }
      })

      this.captionTrack = track

      const ccBtn = document.getElementById('cc-btn')
      if (ccBtn) ccBtn.classList.remove('hidden')

      console.log(`[App] Loaded ${cues.length} caption cues`)
    } catch (error) {
      console.warn('[App] Failed to load captions:', error)
    }
  }

  private parseSRT(srt: string): Array<{ start: number; end: number; text: string }> {
    const cues: Array<{ start: number; end: number; text: string }> = []
    const blocks = srt.trim().split(/\r?\n\s*\r?\n/)
    for (const block of blocks) {
      const lines = block.trim().split(/\r?\n/)
      let timingIdx = -1
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) { timingIdx = i; break }
      }
      if (timingIdx < 0) continue
      const parts = lines[timingIdx].split('-->')
      if (parts.length !== 2) continue
      const start = this.parseSRTTime(parts[0].trim())
      const end = this.parseSRTTime(parts[1].trim())
      const text = lines.slice(timingIdx + 1).join('\n').trim()
      if (text) cues.push({ start, end, text })
    }
    return cues
  }

  private parseSRTTime(t: string): number {
    const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
    if (!m) return 0
    return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000
  }

  private toggleCaptions(): void {
    if (!this.captionTrack) return
    const ccBtn = document.getElementById('cc-btn')
    const overlay = document.getElementById('caption-overlay')
    const turning = this.captionTrack.mode !== 'showing'
    this.captionTrack.mode = turning ? 'showing' : 'hidden'
    if (ccBtn) {
      ccBtn.style.color = turning ? '#4da6ff' : ''
      ccBtn.style.borderColor = turning ? '#4da6ff' : ''
    }
    if (!turning && overlay) {
      overlay.textContent = ''
      overlay.style.display = 'none'
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
        // Update scrubber accessible text with current time
        const scrubber = document.getElementById('scrubber')
        if (scrubber) scrubber.setAttribute('aria-valuetext', this.appState.timeLabel)
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
      playBtn.textContent = paused ? '\u25B6\uFE0E' : '\u23F8\uFE0E'
      playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause')
    }
    this.announce(paused ? 'Playback paused' : 'Playback started')
  }

  // --- Accessibility announcer ---

  private announce(message: string): void {
    const el = document.getElementById('a11y-announcer')
    if (el) {
      // Clear then set to ensure re-announcement of same message
      el.textContent = ''
      requestAnimationFrame(() => { el.textContent = message })
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

    // Legend image (inline thumbnail, click to enlarge)
    if (dataset.legendLink) {
      html += `<img src="${dataset.legendLink}" alt="Legend" class="info-legend-thumb" tabindex="0" role="button" aria-label="Enlarge legend">`
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

    // Wire up legend thumbnail to open modal
    const legendThumb = infoBody.querySelector('.info-legend-thumb') as HTMLElement | null
    if (legendThumb && dataset.legendLink) {
      const openLegendModal = () => {
        let overlay = document.getElementById('legend-modal-overlay')
        if (!overlay) {
          overlay = document.createElement('div')
          overlay.id = 'legend-modal-overlay'
          overlay.className = 'legend-modal-overlay'
          overlay.innerHTML = `<img class="legend-modal-img" alt="Legend">`
          overlay.addEventListener('click', () => overlay!.classList.add('hidden'))
          document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') overlay!.classList.add('hidden')
          })
          document.body.appendChild(overlay)
        }
        const img = overlay.querySelector('img')!
        img.src = dataset.legendLink!
        overlay.classList.remove('hidden')
      }
      legendThumb.addEventListener('click', openLegendModal)
      legendThumb.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLegendModal() }
      })
    }

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

    // Toggle expand/collapse on header click or keyboard
    const toggleInfoPanel = () => {
      const expanded = infoPanel.classList.toggle('expanded')
      infoHeader.setAttribute('aria-expanded', String(expanded))
    }
    infoHeader.onclick = toggleInfoPanel
    infoHeader.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggleInfoPanel()
      }
    })
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
    if (!isLoading) {
      const screen = document.getElementById('loading-screen')
      if (screen) {
        screen.setAttribute('aria-busy', 'false')
        this.setLoadingStatus('Ready', 100)
        // Brief pause so the "100%" fill is visible before fading
        this.loadingHideTimer = setTimeout(() => {
          this.loadingHideTimer = null
          screen.style.opacity = '' // clear any inline override before CSS class takes effect
          screen.classList.add('fade-out')
          screen.addEventListener('transitionend', () => {
            // Only hide if we're still faded out (not re-shown mid-transition)
            if (screen.classList.contains('fade-out')) {
              screen.style.display = 'none'
            }
          }, { once: true })
        }, 300)
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
    // Reset captions
    this.captionTrack = null
    const ccBtn = document.getElementById('cc-btn')
    if (ccBtn) {
      ccBtn.classList.add('hidden')
      ccBtn.style.color = ''
      ccBtn.style.borderColor = ''
    }
    const overlay = document.getElementById('caption-overlay')
    if (overlay) {
      overlay.textContent = ''
      overlay.style.display = 'none'
    }
  }

  setupEventListeners(): void {
    // Home button
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
        if (!collapsed) {
          const searchInput = document.getElementById('browse-search') as HTMLInputElement | null
          if (searchInput && !this.isMobile) searchInput.focus()
        }
      })
    }

    // Transport controls
    document.getElementById('rewind-btn')?.addEventListener('click', () => this.rewind())
    document.getElementById('step-back-btn')?.addEventListener('click', () => this.stepFrame(-1))
    document.getElementById('play-btn')?.addEventListener('click', () => this.togglePlayPause())
    document.getElementById('step-fwd-btn')?.addEventListener('click', () => this.stepFrame(1))
    document.getElementById('ff-btn')?.addEventListener('click', () => this.fastForward())
    document.getElementById('cc-btn')?.addEventListener('click', () => this.toggleCaptions())

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
        this.announce(active ? 'Auto-rotation enabled' : 'Auto-rotation disabled')
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
      // Don't intercept keyboard shortcuts when focus is on form elements or browse cards
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const browseOverlay = document.getElementById('browse-overlay')
      if (browseOverlay && !browseOverlay.classList.contains('hidden') && browseOverlay.contains(e.target as Node)) return

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

  // --- Browse UI ---

  private showBrowseUI(): void {
    const overlay = document.getElementById('browse-overlay')
    if (!overlay) return
    overlay.classList.remove('hidden')

    const datasets = this.appState.datasets
      .filter(d => !d.isHidden)
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.title.localeCompare(b.title))

    // Update search placeholder with actual count
    const searchEl = document.getElementById('browse-search') as HTMLInputElement | null
    if (searchEl) {
      searchEl.placeholder = `Search ${datasets.length} datasets\u2026`
    }

    // Collect unique category keys from both enriched metadata and S3 tags
    const catSet = new Set<string>()
    for (const d of datasets) {
      if (d.enriched?.categories) {
        Object.keys(d.enriched.categories).forEach(c => catSet.add(c))
      }
      if (d.tags) {
        d.tags.forEach(t => catSet.add(t))
      }
    }
    // Remove tags that aren't useful as browse filters
    catSet.delete('Movies')
    catSet.delete('Layers')
    catSet.delete('Tours')
    const categories = ['All', ...Array.from(catSet).sort()]

    let activeCategory = 'All'
    let searchQuery = ''

    // Render category chips
    const chipBar = document.getElementById('browse-category-bar')
    if (chipBar) {
      chipBar.innerHTML = categories
        .map(cat => `<button class="browse-chip${cat === 'All' ? ' active' : ''}" data-cat="${this.escapeAttr(cat)}" aria-pressed="${cat === 'All'}">${this.escapeHtml(cat)}</button>`)
        .join('')

      chipBar.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.browse-chip') as HTMLElement | null
        if (!btn) return
        activeCategory = btn.dataset.cat ?? 'All'
        chipBar.querySelectorAll('.browse-chip').forEach(c => {
          c.classList.remove('active')
          c.setAttribute('aria-pressed', 'false')
        })
        btn.classList.add('active')
        btn.setAttribute('aria-pressed', 'true')
        renderCards()
      })
    }

    // Search input
    const searchInput = document.getElementById('browse-search') as HTMLInputElement | null
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value.trim().toLowerCase()
        renderCards()
      })
      // Focus on desktop, skip on mobile to avoid keyboard pop-up
      if (!this.isMobile) {
        setTimeout(() => searchInput.focus(), 200)
      }
    }

    const renderCards = () => {
      const grid = document.getElementById('browse-grid')
      const countEl = document.getElementById('browse-count')
      if (!grid) return

      let filtered = datasets

      if (activeCategory !== 'All') {
        filtered = filtered.filter(d =>
          (d.enriched?.categories != null && activeCategory in d.enriched.categories) ||
          (d.tags != null && d.tags.includes(activeCategory))
        )
      }

      if (searchQuery) {
        filtered = filtered.filter(d => {
          const title = d.title.toLowerCase()
          const desc = (d.enriched?.description ?? d.abstractTxt ?? '').toLowerCase()
          const keywords = [...(d.enriched?.keywords ?? []), ...(d.tags ?? [])].join(' ').toLowerCase()
          const cats = Object.keys(d.enriched?.categories ?? {}).join(' ').toLowerCase()
          return title.includes(searchQuery) || desc.includes(searchQuery) ||
                 keywords.includes(searchQuery) || cats.includes(searchQuery)
        })
      }

      if (countEl) {
        countEl.textContent = `${filtered.length.toLocaleString()} dataset${filtered.length !== 1 ? 's' : ''}`
      }

      if (filtered.length === 0) {
        grid.innerHTML = '<div class="browse-no-results">No datasets match your search.</div>'
        return
      }

      grid.innerHTML = filtered.map(d => {
        const isVideo = dataService.isVideoDataset(d)
        const cats = d.enriched?.categories ? Object.keys(d.enriched.categories).slice(0, 3) : []
        const rawDesc = d.enriched?.description ?? d.abstractTxt ?? ''
        const shortDesc = rawDesc.length > 120 ? rawDesc.substring(0, 120).trim() + '\u2026' : rawDesc

        const catsHtml = cats.length
          ? `<div class="browse-card-cats">${cats.map(c => `<span class="browse-card-cat">${this.escapeHtml(c)}</span>`).join('')}</div>`
          : ''
        const shortDescHtml = shortDesc
          ? `<p class="browse-card-desc">${this.escapeHtml(shortDesc)}</p>`
          : ''

        // Expanded detail section
        const fullDescHtml = rawDesc
          ? `<div class="browse-card-full-desc">${this.escapeHtml(rawDesc)}</div>`
          : ''
        const org = d.organization
        const dev = d.enriched?.datasetDeveloper?.name
        const visDev = d.enriched?.visDeveloper?.name
        const dateAdded = d.enriched?.dateAdded
        const keywords = [...(d.enriched?.keywords ?? []), ...(d.tags ?? [])]
        const catalogUrl = d.enriched?.catalogUrl
        const timeRange = d.startTime && d.endTime
          ? `${new Date(d.startTime).toLocaleDateString()} \u2013 ${new Date(d.endTime).toLocaleDateString()}`
          : ''

        let metaHtml = ''
        if (org) metaHtml += `<div class="browse-card-meta"><strong>Source:</strong> ${this.escapeHtml(org)}</div>`
        if (dev) metaHtml += `<div class="browse-card-meta"><strong>Dataset developer:</strong> ${this.escapeHtml(dev)}</div>`
        if (visDev) metaHtml += `<div class="browse-card-meta"><strong>Visualization:</strong> ${this.escapeHtml(visDev)}</div>`
        if (timeRange) metaHtml += `<div class="browse-card-meta"><strong>Time range:</strong> ${timeRange}</div>`
        if (dateAdded) metaHtml += `<div class="browse-card-meta"><strong>Added:</strong> ${this.escapeHtml(dateAdded)}</div>`
        if (catalogUrl) metaHtml += `<div class="browse-card-meta"><a href="${this.escapeAttr(catalogUrl)}" target="_blank" rel="noopener" style="color: #4da6ff; text-decoration: none; font-size: 0.65rem;">View in SOS catalog \u2197</a></div>`

        const keywordsHtml = keywords.length
          ? `<div class="browse-card-keywords">${keywords.slice(0, 12).map(k => `<span class="browse-card-keyword">${this.escapeHtml(k)}</span>`).join('')}</div>`
          : ''

        const thumbHtml = d.thumbnailLink
          ? `<img class="browse-card-thumb" src="${this.escapeAttr(d.thumbnailLink)}" alt="${this.escapeAttr(d.title)} thumbnail" loading="lazy">`
          : ''

        return `<div class="browse-card" data-id="${this.escapeAttr(d.id)}" role="listitem" tabindex="0" aria-label="${this.escapeAttr(d.title)}" aria-expanded="false">
          ${thumbHtml}
          <div class="browse-card-body">
            <div class="browse-card-header">
              <span class="browse-card-title">${this.escapeHtml(d.title)}</span>
              <button class="browse-card-load" data-id="${this.escapeAttr(d.id)}" aria-label="Load ${this.escapeAttr(d.title)}">Load</button>
            </div>
            ${catsHtml}${shortDescHtml}
            <div class="browse-card-details">
              ${fullDescHtml}${metaHtml}${keywordsHtml}
            </div>
          </div>
        </div>`
      }).join('')

      // Wire up click + keyboard handlers — expand/collapse on card, load on button
      grid.querySelectorAll<HTMLElement>('.browse-card').forEach(card => {
        const toggleExpand = () => {
          const wasExpanded = card.classList.contains('expanded')
          grid.querySelectorAll<HTMLElement>('.browse-card.expanded').forEach(c => {
            c.classList.remove('expanded')
            c.setAttribute('aria-expanded', 'false')
          })
          if (!wasExpanded) {
            card.classList.add('expanded')
            card.setAttribute('aria-expanded', 'true')
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          }
        }

        card.addEventListener('click', (e) => {
          const loadBtn = (e.target as HTMLElement).closest('.browse-card-load') as HTMLElement | null
          if (loadBtn) {
            e.stopPropagation()
            const id = loadBtn.dataset.id
            if (id) this.selectDatasetFromBrowse(id)
            return
          }
          if ((e.target as HTMLElement).tagName === 'A') return
          toggleExpand()
        })

        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            // Don't toggle when focus is on the Load button (let it click naturally)
            if ((e.target as HTMLElement).closest('.browse-card-load')) return
            e.preventDefault()
            toggleExpand()
          }
        })
      })
    }

    renderCards()
  }

  private hideBrowseUI(): void {
    const overlay = document.getElementById('browse-overlay')
    overlay?.classList.add('hidden')
  }

  private async selectDatasetFromBrowse(id: string): Promise<void> {
    this.hideBrowseUI()
    this.announce('Loading dataset\u2026')
    this.showLoadingScreen('Loading dataset\u2026', 20)
    window.history.pushState({}, '', `?dataset=${encodeURIComponent(id)}`)
    await this.loadDataset(id)
    this.setLoading(false)
    // Announce and move focus to playback area
    const dataset = this.appState.currentDataset
    if (dataset) {
      this.announce(`Loaded dataset: ${dataset.title}`)
      this.renderer?.setCanvasDescription(`3D globe showing ${dataset.title}`)
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
    // Cancel any pending hide so the timer can't fade out a freshly-shown screen
    if (this.loadingHideTimer !== null) {
      clearTimeout(this.loadingHideTimer)
      this.loadingHideTimer = null
    }
    const screen = document.getElementById('loading-screen')
    if (!screen) return
    screen.style.display = 'flex'
    // Do NOT set opacity via inline style — it would override the CSS class rule
    // (#loading-screen.fade-out { opacity: 0 }) and prevent the transitionend
    // event from ever firing, leaving the loading screen stuck on screen.
    screen.style.opacity = ''
    screen.classList.remove('fade-out')
    this.setLoadingStatus(message, progress)
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  private escapeAttr(value: string): string {
    return value.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
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

    this.showLoadingScreen('Loading Earth\u2026', 30)
    if (this.renderer) {
      await this.renderer.loadDefaultEarthMaterials()
      this.setLoadingStatus('Adding atmosphere\u2026', 80)
      this.renderer.loadCloudOverlay(
        'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/clouds_8192.jpg'
      )
      const sun = getSunPosition(new Date())
      this.renderer.enableSunLighting(sun.lat, sun.lng)
    }
    this.setLoading(false)
    this.showBrowseUI()
    this.renderer?.setCanvasDescription('Interactive 3D globe showing Earth')
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
