/**
 * Dataset loading — fetching, displaying info, and wiring up image/video datasets.
 *
 * Extracted from InteractiveSphere to isolate data-loading concerns.
 */

import { HLSService, type VideoProxyResponse } from './hlsService'
import { dataService } from './dataService'
import { apiFetch, isManifestUrl } from './catalogSource'
import { getDownload, getDownloadPath, isZipDownloadable } from './downloadService'
import type { Dataset, AppState, GlobeRenderer, VideoTextureHandle } from '../types'
import { overlayOptionsFromDataset } from './datasetOverlayOptions'
import { formatDate, isSubDailyPeriod, inferDisplayInterval } from '../utils/time'
import { logger } from '../utils/logger'
import { escapeHtml, escapeAttr } from '../ui/domUtils'
import { closeChat } from '../ui/chatUI'
import type { PlaybackState } from '../ui/playbackController'
import { updatePlayButton, loadCaptions } from '../ui/playbackController'
import { startDwell, type DwellHandle } from '../analytics'
import { addViewSeconds } from './visitMemory'
import { recommendRelated, normalizeTitle as normalizeRelatedTitle } from './relatedDatasets'
import { fetchSemanticRelatedIds, RELATED_DEFAULT_LIMIT } from './relatedDatasetsService'
import { openAddToPlaylistPopover } from '../ui/playlistUI'
import { openDownloadDialog } from '../ui/downloadDialogUI'
import { t, tAttr } from '../i18n'

/** Tier B dwell handle for the info panel — non-null while the
 * panel is expanded (collapsed = user can't read the body so it
 * doesn't count). One handle per displayed dataset; rebuilt on
 * dataset change. Tier-gated at emit time, wiring is unconditional. */
let infoPanelDwellHandle: DwellHandle | null = null
let infoPanelDwellDatasetId: string | null = null

/**
 * Stop the active info-panel dwell handle and credit its elapsed
 * (visibility-paused) time to visit memory's `viewSeconds` for the
 * dataset it was tracking. Phase 7 §9.2 piggybacks on the dwell
 * handle's lifecycle rather than running a parallel timer, so the
 * "only count while the document is visible" semantics come for free
 * (dwell pauses on tab-hide). Idempotent — a null handle is a no-op.
 *
 * Note: the dwell helper's own `pagehide` drain bypasses this wrapper,
 * so a session that ends with the panel still expanded loses that
 * final open segment's `viewSeconds`. That's an acceptable rounding
 * loss for a convenience cache; every collapse / dataset-change /
 * panel-rebuild commits cleanly.
 */
function commitInfoPanelDwell(): void {
  if (!infoPanelDwellHandle) return
  if (infoPanelDwellDatasetId) {
    addViewSeconds(infoPanelDwellDatasetId, infoPanelDwellHandle.elapsed() / 1000)
  }
  infoPanelDwellHandle.stop()
  infoPanelDwellHandle = null
  infoPanelDwellDatasetId = null
}

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
  /**
   * Phase 3pg/C — skip the legacy `_4096` / `_2048` / `_1024`
   * suffix-probing pass for image datasets. Set to `true` when
   * the caller knows the `dataLink` resolves to a single specific
   * image (the per-frame URL from `WireDataset.frames.urlTemplate`,
   * or any other directly-addressable image) so the loader doesn't
   * burn three network round-trips on 404s before falling back to
   * the actual URL. No effect on video datasets or on rows whose
   * `dataLink` is the manifest endpoint.
   */
  directImageUrl?: boolean
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
): Promise<HTMLImageElement> {
  const isPrimary = options.isPrimary ?? true
  const directImageUrl = options.directImageUrl ?? false

  // Check for offline-cached version first
  const dl = await getDownload(dataset.id)
  let img: HTMLImageElement
  if (dl) {
    const localPath = await getDownloadPath(dataset.id, dl.primary_file)
    if (localPath) {
      logger.info(`[App] Loading image from offline cache: ${localPath}`)
      img = await tryLoadImage([await localFileUrl(localPath)])
    } else {
      img = await loadImageFromNetwork(dataset, isMobile, directImageUrl)
    }
  } else {
    img = await loadImageFromNetwork(dataset, isMobile, directImageUrl)
  }

  renderer.updateTexture(img, overlayOptionsFromDataset(dataset))

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
  return img
}

/** Load an image from the network with progressive resolution fallback. */
async function loadImageFromNetwork(
  dataset: Dataset,
  isMobile: boolean,
  directImageUrl = false,
): Promise<HTMLImageElement> {
  // Node-mode: dataLink is `/api/v1/datasets/{id}/manifest`. The
  // manifest envelope already lists every variant; just fetch it,
  // sort by descending width, and try them in order. The legacy
  // suffix-mangling fallback isn't needed because the backend
  // synthesises the same ladder for `url:<href>` rows.
  if (isManifestUrl(dataset.dataLink)) {
    const res = await apiFetch(dataset.dataLink, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status} ${res.statusText}`)
    const manifest = (await res.json()) as {
      kind: 'image'
      variants: Array<{ width: number; url: string }>
      fallback: string
    }
    if (manifest.kind !== 'image') {
      throw new Error(`Manifest kind=${manifest.kind} for an image dataset is unexpected.`)
    }
    const sorted = [...manifest.variants].sort((a, b) => b.width - a.width)
    // Mobile devices skip the largest variant to keep MSE / decode
    // memory bounded; matches the legacy `_2048` / `_1024` strategy.
    const skipLargest = isMobile && sorted.length > 1
    const candidates = (skipLargest ? sorted.slice(1) : sorted).map(v => v.url)
    candidates.push(manifest.fallback)
    return tryLoadImage(candidates)
  }

  // Direct-image path (Phase 3pg/C frame loads): caller knows the
  // URL points at a single specific image, so skip the legacy
  // `_4096` / `_2048` / `_1024` suffix probing. Each suffix would
  // 404 against a per-frame R2 URL, adding three round-trips and
  // a noisy console of failed image loads before the actual URL
  // resolves.
  if (directImageUrl) {
    return tryLoadImage([dataset.dataLink])
  }

  // Legacy / direct-asset path: mangle the suffix as before.
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
    let manifest: VideoProxyResponse
    if (isManifestUrl(dataset.dataLink)) {
      // Node-mode: fetch the manifest envelope directly. The backend
      // (`functions/api/v1/datasets/[id]/manifest.ts`) returns a
      // shape that's structurally identical to `VideoProxyResponse`
      // for the fields the HLS path actually consumes (`hls`,
      // `files[]`, `duration`, `title`, `id`) MINUS `dash` and
      // PLUS a `kind: 'video' | 'image'` discriminator. Validate
      // `kind` first so an image dataset routed to the video loader
      // fails fast with a clear error rather than throwing at
      // `manifest.files.find(...)` later.
      const res = await apiFetch(dataset.dataLink, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status} ${res.statusText}`)
      const envelope = (await res.json()) as Omit<VideoProxyResponse, 'dash'> & {
        kind: 'video' | 'image'
      }
      if (envelope.kind !== 'video') {
        throw new Error(`Expected a video manifest; got kind=${envelope.kind}.`)
      }
      // Backfill `dash` so the type matches downstream consumers
      // that only read it via index-access; HLS.js never looks at
      // it, the desktop offline path doesn't either.
      manifest = { ...envelope, dash: '' }
    } else {
      const vimeoId = dataService.extractVimeoId(dataset.dataLink)
      if (!vimeoId) throw new Error(`Could not extract Vimeo ID from: ${dataset.dataLink}`)
      manifest = await hlsService.fetchManifest(vimeoId)
    }
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
  // Pass `period` and `frames.count` so the cadence matches the
  // imagery rather than the ms-per-frame estimate — fixes the
  // climate-dataset label-crawl bug (Plan §5.1).
  if (isPrimary) {
    if (dataset.startTime && dataset.endTime) {
      const start = new Date(dataset.startTime)
      const end = new Date(dataset.endTime)
      playbackState.displayInterval = inferDisplayInterval(start, end, video.duration, {
        period: dataset.period,
        frameCount: dataset.frames?.count,
      })
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

  const videoTexture = renderer.setVideoTexture(video, overlayOptionsFromDataset(dataset))
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

/**
 * Trim a description to the panel's collapsed-state cap, snapping
 * to the last sentence boundary so the ellipsis lands at a clean
 * stopping point. The full text remains available for the expand
 * affordance.
 */
function truncateDescription(text: string): string {
  if (text.length <= DESCRIPTION_MAX_LENGTH) return text
  const cut = text.lastIndexOf('.', DESCRIPTION_MAX_LENGTH)
  return text.substring(0, cut > DESCRIPTION_MIN_CUT ? cut + 1 : DESCRIPTION_MAX_LENGTH) + '…'
}

/**
 * Render one row of the Credits section. The value is wrapped in
 * an external link when `affiliationUrl` is present so the
 * affiliation institution is reachable in one click — the SOS
 * catalog itself does the same.
 */
function renderCreditRow(label: string, value: string, affiliationUrl?: string): string {
  const valueHtml = affiliationUrl
    ? `<a href="${escapeAttr(affiliationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`
    : escapeHtml(value)
  return `<div class="info-credit-row">`
    + `<dt class="info-credit-label">${escapeHtml(label)}</dt>`
    + `<dd class="info-credit-value">${valueHtml}</dd>`
    + `</div>`
}

/**
 * Build the related-datasets section. Combines the manually-curated
 * `EnrichedMetadata.relatedDatasets` (rendered first, in author
 * order) with algorithmic recommendations filling in up to the §4.2
 * cap. Returns an empty string when nothing surfaces.
 *
 * The algorithmic portion is either the pure lexical scorer from
 * `relatedDatasets.ts` (the default + offline fallback) or, when
 * `algorithmicOverride` is supplied, the semantic "more like this"
 * ordering from `relatedDatasetsService.ts` (`docs/CURRENT_EVENTS_PLAN.md`
 * Phase 3b). The override is filtered here against the same
 * manual/self/hidden exclusions the lexical path applies, so a swap is
 * apples-to-apples.
 *
 * Manual entries that don't resolve to a catalog row render as
 * grayed-out text (off-catalog references — preserved from the
 * pre-§4.2 behaviour so a curator's notes about external context
 * still show). Algorithmic recommendations always resolve, so they
 * always render as live links. The whole block is wrapped in
 * `.info-related-section` so the async semantic enhancement can replace
 * it in place.
 */
function renderRelatedDatasetsHtml(
  target: Dataset,
  datasets: Dataset[],
  algorithmicOverride: Dataset[] | null = null,
): string {
  const manual = target.enriched?.relatedDatasets ?? []
  const manualLinks: Array<{ label: string; match: Dataset | null }> = manual.map((rd) => {
    const wanted = normalizeRelatedTitle(rd.title)
    const match = datasets.find((d) => normalizeRelatedTitle(d.title) === wanted) ?? null
    return { label: rd.title, match }
  })

  const manualIds = new Set<string>()
  const manualTitles = new Set<string>()
  for (const entry of manualLinks) {
    if (entry.match) manualIds.add(entry.match.id)
    manualTitles.add(normalizeRelatedTitle(entry.label))
  }

  const algorithmic = algorithmicOverride
    ? algorithmicOverride.filter(d => d.id !== target.id && !manualIds.has(d.id) && !d.isHidden)
    : recommendRelated(target, datasets, manualIds, manualTitles)

  if (manualLinks.length === 0 && algorithmic.length === 0) return ''

  let html = `<div class="info-related-section">`
  html += `<p class="info-section-label">${escapeHtml(t('infoPanel.relatedDatasets'))}</p>`
  html += `<ul class="info-related">`
  for (const entry of manualLinks) {
    if (entry.match) {
      html += `<li><a href="?dataset=${encodeURIComponent(entry.match.id)}" data-dataset-id="${escapeAttr(entry.match.id)}">${escapeHtml(entry.label)}</a></li>`
    } else {
      html += `<li><span class="info-related-offcatalog">${escapeHtml(entry.label)}</span></li>`
    }
  }
  for (const candidate of algorithmic) {
    html += `<li><a href="?dataset=${encodeURIComponent(candidate.id)}" data-dataset-id="${escapeAttr(candidate.id)}">${escapeHtml(candidate.title)}</a></li>`
  }
  html += `</ul></div>`
  return html
}

/**
 * Wire related-dataset links within `scope` to load in-place. The URL
 * update preserves any existing `?catalog=true` flag (Phase 1 §3.2) so
 * a related-link click while in catalog mode keeps the catalog↔sphere
 * tab control visible — same contract as `selectDatasetFromBrowse` in
 * main.ts. Extracted so the async semantic enhancement can re-wire its
 * freshly-rendered links.
 */
function wireRelatedLinks(scope: ParentNode, onLoadDataset: (id: string) => void): void {
  scope.querySelectorAll('a[data-dataset-id]').forEach(link => {
    link.addEventListener('click', (ev) => {
      ev.preventDefault()
      const id = (link as HTMLElement).dataset.datasetId
      if (id) {
        const params = new URLSearchParams(window.location.search)
        params.set('dataset', id)
        window.history.pushState({}, '', `?${params.toString()}`)
        onLoadDataset(id)
      }
    })
  })
}

/**
 * Progressively enhance the related-datasets list with the semantic
 * "more like this" ordering. Renders nothing new on its own — the
 * lexical list is already on screen — and silently no-ops on any
 * backend failure / degraded response (the service returns `null`), so
 * the panel never regresses below the offline behaviour. On success it
 * replaces the `.info-related-section` block in place and re-wires the
 * new links.
 */
async function enhanceRelatedDatasets(
  infoBody: HTMLElement,
  dataset: Dataset,
  datasets: Dataset[],
  onLoadDataset: (id: string) => void,
): Promise<void> {
  const section = infoBody.querySelector('.info-related-section')
  if (!section) return // no related block rendered → nothing to enhance

  const ids = await fetchSemanticRelatedIds(dataset.id, RELATED_DEFAULT_LIMIT)
  if (!ids) return // degraded / empty / error → keep the lexical list

  const byId = new Map(datasets.map(d => [d.id, d]))
  const semantic = ids
    .map(id => byId.get(id))
    .filter((d): d is Dataset => d !== undefined)
  if (semantic.length === 0) return

  const newHtml = renderRelatedDatasetsHtml(dataset, datasets, semantic)
  if (!newHtml) return

  // The panel may have been re-rendered (a new dataset loaded) while
  // the fetch was in flight — only replace the section if it's still
  // attached to the live info body.
  if (!infoBody.contains(section)) return

  const tmp = document.createElement('div')
  tmp.innerHTML = newHtml
  const fresh = tmp.firstElementChild
  if (!fresh) return
  section.replaceWith(fresh)
  wireRelatedLinks(fresh, onLoadDataset)
}

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

  // If the panel is showing a different dataset from the one whose
  // dwell we're currently tracking, close out the previous dwell
  // before re-rendering. The new dataset's dwell starts fresh on
  // the next expand click.
  if (infoPanelDwellHandle && infoPanelDwellDatasetId !== dataset.id) {
    commitInfoPanelDwell()
  }

  const e = dataset.enriched

  infoTitle.textContent = dataset.title

  let html = ''

  // Top-of-panel source line — the organisation that owns / produced
  // the data, as a labelled row. Datasets where only `organization`
  // is populated still surface it; datasets where neither is set
  // omit the row entirely.
  if (dataset.organization) {
    html += `<p class="info-source">${escapeHtml(dataset.organization)}</p>`
  }

  // "Add to playlist" affordance — §8.1. Renders right under the
  // source line so it's visible without scrolling. `data-dataset-
  // id` is what the popover anchor handler reads to know which
  // dataset to attach.
  html += `<button type="button" class="add-to-playlist-btn info-add-to-playlist"`
    + ` data-dataset-id="${escapeAttr(dataset.id)}"`
    + ` aria-label="${escapeAttr(t('playlist.action.addToPlaylist.aria', { title: dataset.title }))}">`
    + escapeHtml(t('playlist.action.addToPlaylist'))
    + `</button>`

  // "Download as .zip" affordance — §8.2. Web-only; desktop offline
  // cache is the established path there. Same data-attribute idiom
  // the playlist button uses so a future refactor can lift the row
  // into a shared component. `isZipDownloadable` additionally
  // suppresses the button on datasets we know will fail today
  // (plain HLS-only videos post Phase 3 r2-hls migration) — widen
  // the check once issues #147 / #148 land.
  if (!IS_TAURI && isZipDownloadable(dataset)) {
    html += `<button type="button" class="add-to-playlist-btn info-zip-download"`
      + ` data-dataset-id="${escapeAttr(dataset.id)}"`
      + ` aria-label="${escapeAttr(t('zip.action.zipDownload.aria', { title: dataset.title }))}">`
      + escapeHtml(t('zip.action.zipDownload'))
      + `</button>`
  }

  // Description with show-more/show-less. The collapsed form is the
  // same 600-char snippet the panel has rendered for years; the
  // expanded form is the full text, scrollable inside the panel
  // body. `data-collapsed`/`data-full` carry the two variants so
  // the toggle handler can swap without re-rendering from source.
  const description = e?.description || dataset.abstractTxt
  if (description) {
    const collapsed = truncateDescription(description)
    const isTruncated = collapsed !== description
    if (isTruncated) {
      html += `<div class="info-description-wrap" data-truncated="true">`
      html += `<p class="info-description"`
        + ` data-collapsed="${escapeAttr(collapsed)}"`
        + ` data-full="${escapeAttr(description)}">${escapeHtml(collapsed)}</p>`
      html += `<button type="button" class="info-description-toggle" aria-expanded="false">${escapeHtml(t('infoPanel.description.showMore'))}</button>`
      html += `</div>`
    } else {
      html += `<p class="info-description">${escapeHtml(description)}</p>`
    }
  }

  if (dataset.legendLink) {
    html += `<img src="${dataset.legendLink}" alt="${escapeAttr(dataset.title)} legend" class="info-legend-thumb" tabindex="0" role="button" aria-label="Enlarge ${escapeAttr(dataset.title)} legend">`
  }

  if (e?.categories) {
    const cats = Object.entries(e.categories)
      .map(([group, subs]) => subs.length ? `${escapeHtml(group)}: ${subs.map(escapeHtml).join(', ')}` : escapeHtml(group))
    html += `<p class="info-categories">${cats.join(' · ')}</p>`
  }

  const keywords = e?.keywords || dataset.tags
  if (keywords && keywords.length > 0) {
    html += `<div class="info-keywords">`
    keywords.forEach(kw => {
      html += `<span class="info-keyword">${escapeHtml(kw)}</span>`
    })
    html += `</div>`
  }

  // "Captions available" indicator — disambiguates "this dataset
  // has no captions" from "captions failed to load" (Plan §5.2).
  // The CC button on the transport only appears after a successful
  // SRT fetch; this badge surfaces the *intent* unconditionally.
  if (dataset.closedCaptionLink) {
    html += `<p class="info-captions-badge">`
    html += `<span class="info-captions-badge-glyph" aria-hidden="true">CC</span>`
    html += escapeHtml(t('infoPanel.captionsAvailable'))
    html += `</p>`
  }

  // --- Credits section — Phase 2 §4.1 -----------------------------
  // Each row is independently conditional; the section header only
  // renders if at least one row will follow it. Affiliation URLs
  // wrap the name in an external link when present.
  const creditRows: string[] = []
  if (e?.datasetDeveloper?.name) {
    creditRows.push(renderCreditRow(
      t('infoPanel.developedBy'),
      e.datasetDeveloper.name,
      e.datasetDeveloper.affiliationUrl,
    ))
  }
  if (e?.visDeveloper?.name) {
    creditRows.push(renderCreditRow(
      t('infoPanel.visualizationBy'),
      e.visDeveloper.name,
      e.visDeveloper.affiliationUrl,
    ))
  }
  if (e?.dateAdded) {
    creditRows.push(renderCreditRow(t('infoPanel.dateAdded'), e.dateAdded))
  }
  if (creditRows.length > 0) {
    html += `<p class="info-section-label">${escapeHtml(t('infoPanel.section.credits'))}</p>`
    html += `<dl class="info-credits">${creditRows.join('')}</dl>`
  }

  // --- Related datasets — manual entries first, then algorithmic
  // recommendations to fill the list up to the §4.2 cap. ----------
  const relatedHtml = renderRelatedDatasetsHtml(dataset, datasets)
  if (relatedHtml) html += relatedHtml

  // --- Thumbnail + download link — Phase 2 §4.3 -------------------
  // Only when a separate thumbnail asset exists. The download link
  // is a plain `<a download>` — works on web today; the Tauri
  // download service path layers on in Phase 6 (§4.5 risk).
  if (dataset.thumbnailLink) {
    html += `<a href="${escapeAttr(dataset.thumbnailLink)}"`
      + ` download`
      + ` target="_blank" rel="noopener noreferrer"`
      + ` class="info-thumbnail-download"`
      + ` aria-label="${tAttr('infoPanel.thumbnail.download')}">`
    html += `<img src="${escapeAttr(dataset.thumbnailLink)}"`
      + ` alt="${escapeAttr(t('infoPanel.thumbnail.alt', { title: dataset.title }))}"`
      + ` class="info-thumbnail">`
    html += `<span class="info-thumbnail-download-label">${escapeHtml(t('infoPanel.thumbnail.download'))}</span>`
    html += `</a>`
  }

  // --- External catalog link --------------------------------------
  if (e?.catalogUrl) {
    html += `<p class="info-section-label">${escapeHtml(t('infoPanel.section.links'))}</p>`
    html += `<a href="${escapeAttr(e.catalogUrl)}" target="_blank" rel="noopener noreferrer" class="info-catalog-link">${escapeHtml(t('infoPanel.catalogLink'))}</a>`
  }

  infoBody.innerHTML = html
  infoPanel.classList.remove('hidden')

  // Wire the Add-to-playlist button to open the popover anchored
  // under the button itself. The popover module handles its own
  // outside-click / Escape close.
  const addBtn = infoBody.querySelector<HTMLButtonElement>('.info-add-to-playlist')
  if (addBtn) {
    addBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const id = addBtn.dataset.datasetId
      if (id) openAddToPlaylistPopover(id, addBtn)
    })
  }

  // Wire the info-panel zip-download button (web only) to open the
  // §8.2 download dialog. The dialog itself is opener-anchored so
  // re-clicking the button doesn't accidentally re-close.
  const zipBtn = infoBody.querySelector<HTMLButtonElement>('.info-zip-download')
  if (zipBtn) {
    zipBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const id = zipBtn.dataset.datasetId
      if (id) void openDownloadDialog(id, zipBtn)
    })
  }

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

  // Wire up related dataset links to load in-place (lexical list,
  // rendered synchronously above), then progressively enhance the list
  // with the semantic "more like this" ordering when the backend is
  // available (Phase 3b). The enhancement no-ops on any failure, so the
  // lexical list stands as the fallback.
  wireRelatedLinks(infoBody, onLoadDataset)
  void enhanceRelatedDatasets(infoBody, dataset, datasets, onLoadDataset)

  // Wire up the description show-more / show-less toggle.
  const descWrap = infoBody.querySelector('.info-description-wrap[data-truncated="true"]') as HTMLElement | null
  if (descWrap) {
    const descEl = descWrap.querySelector('.info-description') as HTMLElement | null
    const toggleBtn = descWrap.querySelector('.info-description-toggle') as HTMLButtonElement | null
    if (descEl && toggleBtn) {
      const collapsed = descEl.dataset.collapsed ?? ''
      const full = descEl.dataset.full ?? ''
      toggleBtn.addEventListener('click', () => {
        const expanded = toggleBtn.getAttribute('aria-expanded') === 'true'
        if (expanded) {
          descEl.textContent = collapsed
          toggleBtn.setAttribute('aria-expanded', 'false')
          toggleBtn.textContent = t('infoPanel.description.showMore')
        } else {
          descEl.textContent = full
          toggleBtn.setAttribute('aria-expanded', 'true')
          toggleBtn.textContent = t('infoPanel.description.showLess')
        }
      })
    }
  }

  // Toggle expand/collapse on header click or keyboard
  const toggleInfoPanel = () => {
    const expanded = infoPanel.classList.toggle('expanded')
    infoHeader.setAttribute('aria-expanded', String(expanded))
    // Close chat when expanding info — both can't be tall at the same time
    if (expanded) closeChat()
    // Tier B dwell — track time the panel is actually expanded
    // (collapsed reduces it to a one-line header, no body
    // reading is possible). Targets `dataset:<id>` so dashboards
    // can split per-dataset reading time without reaching for the
    // session-scoped layer_loaded join.
    if (expanded) {
      if (infoPanelDwellHandle) commitInfoPanelDwell()
      infoPanelDwellHandle = startDwell(`dataset:${dataset.id}`)
      infoPanelDwellDatasetId = dataset.id
      // §9.2 — the visit itself is recorded at dataset-load time (see
      // main.ts displayDataset). Expanding the info panel only accrues
      // viewSeconds, committed when the dwell handle closes.
    } else if (infoPanelDwellHandle) {
      commitInfoPanelDwell()
    }
  }
  infoHeader.onclick = toggleInfoPanel
  infoHeader.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleInfoPanel()
    }
  })
}
