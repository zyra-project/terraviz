/**
 * Dataset loading — fetching, displaying info, and wiring up image/video datasets.
 *
 * Extracted from InteractiveSphere to isolate data-loading concerns.
 */

import { HLSService } from './hlsService'
import { dataService } from './dataService'
import { getDownload, getDownloadPath } from './downloadService'
import type { Dataset, AppState, GlobeRenderer, VideoTextureHandle } from '../types'
import { formatDate, isSubDailyPeriod, inferDisplayInterval } from '../utils/time'
import { logger } from '../utils/logger'
import { escapeHtml, escapeAttr } from '../ui/domUtils'
import { closeChat } from '../ui/chatUI'
import type { PlaybackState } from '../ui/playbackController'
import { updatePlayButton, loadCaptions } from '../ui/playbackController'

const IS_TAURI = !!(window as any).__TAURI__

/** Convert a local file path to a URL the webview can load. */
const convertFileSrcReady: Promise<((path: string) => string) | null> = IS_TAURI
  ? import('@tauri-apps/api/core')
      .then(m => m.convertFileSrc)
      .catch(() => null)
  : Promise.resolve(null)

async function localFileUrl(path: string): Promise<string> {
  const convert = await convertFileSrcReady
  return convert ? convert(path) : `asset://localhost/${path}`
}

// --- Dataset loader constants ---
const DESCRIPTION_MAX_LENGTH = 600
const DESCRIPTION_MIN_CUT = 200
const VIDEO_LOAD_TIMEOUT_MS = 20000
const FIRST_FRAME_FALLBACK_MS = 150
const SCRUBBER_MAX = '1000'

/** Callbacks the dataset loader uses to communicate with the main app. */
export interface DatasetLoaderCallbacks {
  showPlaybackControls: (show: boolean) => void
  showTimeLabel: (show: boolean) => void
}

/**
 * Options controlling which singular UI affordances a load call is
 * allowed to touch. Non-primary panel loads pass `isPrimary: false`
 * so they don't clobber the scrubber, mute button, playback controls,
 * time label, or appState fields that belong to the primary panel.
 */
export interface DatasetLoaderOptions {
  /** Whether this load is targeting the primary viewport. Default `true`. */
  isPrimary?: boolean
}

// --- Image loading ---

/** Load an image dataset onto the globe, trying progressively lower resolutions on mobile. */
export async function loadImageDataset(
  dataset: Dataset,
  renderer: GlobeRenderer,
  appState: AppState,
  isMobile: boolean,
  callbacks: DatasetLoaderCallbacks,
  options: DatasetLoaderOptions = {},
): Promise<void> {
  const isPrimary = options.isPrimary ?? true

  // Check for offline-cached version first
  const dl = await getDownload(dataset.id)
  let img: HTMLImageElement
  if (dl) {
    const localPath = await getDownloadPath(dataset.id, dl.primary_file)
    if (localPath) {
      logger.info(`[App] Loading image from offline cache: ${localPath}`)
      img = await tryLoadImage([await localFileUrl(localPath)])
    } else {
      img = await loadImageFromNetwork(dataset, isMobile)
    }
  } else {
    img = await loadImageFromNetwork(dataset, isMobile)
  }

  renderer.updateTexture(img)

  // Only the primary drives the singular time label and playback UI.
  if (isPrimary) {
    if (dataset.startTime) {
      const showTime = isSubDailyPeriod(dataset.period)
      appState.timeLabel = formatDate(new Date(dataset.startTime), showTime)
      callbacks.showTimeLabel(true)
    } else {
      callbacks.showTimeLabel(false)
    }
    callbacks.showPlaybackControls(false)
  }

  logger.info(`[App] Image dataset loaded successfully: ${img.src}`)
}

/** Load an image from the network with progressive resolution fallback. */
function loadImageFromNetwork(dataset: Dataset, isMobile: boolean): Promise<HTMLImageElement> {
  const url = dataset.dataLink
  const ext = url.match(/(\.\w+)$/)
  const base = ext ? url.slice(0, -ext[1].length) : url
  const suffix = ext ? ext[1] : ''

  const resolutions = isMobile ? ['_2048', '_1024'] : ['_4096', '_2048', '_1024']
  const candidates = [...resolutions.map(r => `${base}${r}${suffix}`), url]
  return tryLoadImage(candidates)
}

/** Try loading an image from a list of candidate URLs, falling back to the next on failure. */
function tryLoadImage(urls: string[]): Promise<HTMLImageElement> {
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

// --- Video loading ---

/** Load a video dataset via HLS streaming, set up the video texture, and configure playback controls. */
export async function loadVideoDataset(
  dataset: Dataset,
  renderer: GlobeRenderer,
  appState: AppState,
  isMobile: boolean,
  playbackState: PlaybackState,
  callbacks: DatasetLoaderCallbacks,
  options: DatasetLoaderOptions = {},
): Promise<{ hlsService: HLSService; videoTexture: VideoTextureHandle }> {
  const isPrimary = options.isPrimary ?? true
  const hlsService = new HLSService()
  const video = hlsService.createVideo()

  // Check for offline-cached version first
  const dl = await getDownload(dataset.id)
  const localVideoPath = dl ? await getDownloadPath(dataset.id, dl.primary_file) : null

  if (localVideoPath) {
    logger.info(`[App] Loading video from offline cache: ${localVideoPath}`)
    await hlsService.loadDirect(await localFileUrl(localVideoPath), video)
  } else {
    const vimeoId = dataService.extractVimeoId(dataset.dataLink)
    if (!vimeoId) throw new Error(`Could not extract Vimeo ID from: ${dataset.dataLink}`)

    const manifest = await hlsService.fetchManifest(vimeoId)
    logger.info('[App] Video manifest received:', { duration: manifest.duration, qualities: manifest.files.length })

    try {
      await hlsService.loadStream(manifest.hls, video, isMobile)
    } catch (hlsError) {
      logger.warn('[App] HLS failed, falling back to direct MP4:', hlsError)
      const mp4File = manifest.files.find(f => f.quality === '1080p')
        ?? manifest.files.find(f => f.quality === '720p')
        ?? manifest.files.find(f => f.width && f.link)
      if (!mp4File) throw new Error('No playable video source found')
      await hlsService.loadDirect(mp4File.link, video)
    }
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
      setTimeout(() => {
        video.removeEventListener('canplay', onCanPlay)
        reject(new Error('Video took too long to load — check your connection and try again'))
      }, VIDEO_LOAD_TIMEOUT_MS)
    }
  })

  // Infer display interval from time range + video duration.
  // Only the primary panel's load drives the shared playback state.
  if (isPrimary) {
    if (dataset.startTime && dataset.endTime) {
      const start = new Date(dataset.startTime)
      const end = new Date(dataset.endTime)
      playbackState.displayInterval = inferDisplayInterval(start, end, video.duration)
      logger.info('[App] Inferred display interval:', playbackState.displayInterval)
    } else {
      playbackState.displayInterval = null
    }
  }

  // Force first frame decode before attaching to the sphere
  try {
    await video.play()
    await new Promise<void>((resolve) => {
      if ('requestVideoFrameCallback' in video) {
        (video as any).requestVideoFrameCallback(() => resolve())
      } else {
        setTimeout(resolve, FIRST_FRAME_FALLBACK_MS)
      }
    })
    video.pause()
    video.currentTime = 0
  } catch {
    // Autoplay blocked — texture will update when user presses play
  }

  // Show mute button only when the stream has audio. Only the primary
  // drives the singular mute button visibility — non-primary videos
  // share the same mute control, so skip if we're not primary.
  // (The primary's hls service always wins the button.)
  if (isPrimary) {
    const muteBtn = document.getElementById('mute-btn') as HTMLElement | null
    if (muteBtn) {
      muteBtn.style.display = hlsService.hasAudio ? '' : 'none'
    }
  }

  const videoTexture = renderer.setVideoTexture(video)
  videoTexture.needsUpdate = true

  // Scrubber + playback transport are singular — primary only.
  if (isPrimary) {
    const scrubber = document.getElementById('scrubber') as HTMLInputElement
    if (scrubber) {
      scrubber.max = SCRUBBER_MAX
      scrubber.value = '0'
    }

    callbacks.showPlaybackControls(true)
    updatePlayButton(true)

    if (dataset.closedCaptionLink) {
      loadCaptions(video, dataset.closedCaptionLink, playbackState)
    }
  }

  logger.info('[App] Video dataset loaded, duration:', video.duration, 's')
  return { hlsService, videoTexture }
}

// --- Dataset info panel ---

/** Populate and display the dataset info panel with metadata, legend, related datasets, and event wiring. */
export function displayDatasetInfo(
  dataset: Dataset,
  datasets: Dataset[],
  onLoadDataset: (id: string) => void,
): void {
  const infoPanel = document.getElementById('info-panel')
  const infoTitle = document.getElementById('info-title')
  const infoBody = document.getElementById('info-body')
  const infoHeader = document.getElementById('info-header')
  if (!infoPanel || !infoTitle || !infoBody || !infoHeader) return

  const e = dataset.enriched

  infoTitle.textContent = dataset.title

  let html = ''

  const source = e?.datasetDeveloper?.name || dataset.organization
  if (source) {
    html += `<p class="info-source">${source}</p>`
  }

  const description = e?.description || dataset.abstractTxt
  if (description) {
    let text = description
    if (text.length > DESCRIPTION_MAX_LENGTH) {
      const cut = text.lastIndexOf('.', DESCRIPTION_MAX_LENGTH)
      text = text.substring(0, cut > DESCRIPTION_MIN_CUT ? cut + 1 : DESCRIPTION_MAX_LENGTH) + '…'
    }
    html += `<p class="info-description">${text}</p>`
  }

  if (dataset.legendLink) {
    html += `<img src="${dataset.legendLink}" alt="${escapeAttr(dataset.title)} legend" class="info-legend-thumb" tabindex="0" role="button" aria-label="Enlarge ${escapeAttr(dataset.title)} legend">`
  }

  if (e?.categories) {
    const cats = Object.entries(e.categories)
      .map(([group, subs]) => subs.length ? `${group}: ${subs.join(', ')}` : group)
    html += `<p class="info-categories">${cats.join(' · ')}</p>`
  }

  const keywords = e?.keywords || dataset.tags
  if (keywords && keywords.length > 0) {
    html += `<div class="info-keywords">`
    keywords.forEach(kw => {
      html += `<span class="info-keyword">${kw}</span>`
    })
    html += `</div>`
  }

  if (e?.relatedDatasets && e.relatedDatasets.length > 0) {
    html += `<p class="info-section-label">Related Datasets</p>`
    html += `<ul class="info-related">`
    e.relatedDatasets.forEach(rd => {
      const match = datasets.find(d =>
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
        overlay.setAttribute('role', 'dialog')
        overlay.setAttribute('aria-modal', 'true')
        overlay.setAttribute('aria-label', 'Legend')
        overlay.innerHTML = `<img class="legend-modal-img" alt="Legend"><button class="legend-modal-close" aria-label="Close legend">&times;</button>`
        const closeModal = () => {
          overlay!.classList.add('hidden')
          legendThumb.focus()
        }
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
      const img = overlay.querySelector('img')!
      img.src = dataset.legendLink!
      img.alt = `${dataset.title} legend`
      overlay.setAttribute('aria-label', `${dataset.title} legend`)
      overlay.classList.remove('hidden')
      // Move focus into the modal
      const closeBtn = overlay.querySelector('.legend-modal-close') as HTMLElement
      if (closeBtn) closeBtn.focus()
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
        onLoadDataset(id)
      }
    })
  })

  // Toggle expand/collapse on header click or keyboard
  const toggleInfoPanel = () => {
    const expanded = infoPanel.classList.toggle('expanded')
    infoHeader.setAttribute('aria-expanded', String(expanded))
    // Close chat when expanding info — both can't be tall at the same time
    if (expanded) closeChat()
  }
  infoHeader.onclick = toggleInfoPanel
  infoHeader.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleInfoPanel()
    }
  })
}
