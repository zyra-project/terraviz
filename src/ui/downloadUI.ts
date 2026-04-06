/**
 * Download Manager UI — panel for viewing and managing offline datasets.
 *
 * Desktop-only (Tauri). Invisible on the web.
 */

import {
  isDownloadAvailable, listDownloads, deleteDownload, getDownloadsSize,
  formatBytes, onDownloadProgress, onDownloadComplete, onDownloadError,
  type DownloadedDataset, type DownloadProgress,
} from '../services/downloadService'
import { escapeHtml, escapeAttr } from './browseUI'
import { logger } from '../utils/logger'

let panelOpen = false
let unsubProgress: (() => void) | null = null
let unsubComplete: (() => void) | null = null
let unsubError: (() => void) | null = null

/** Initialize the download manager — add button to map controls and wire events. */
export async function initDownloadUI(): Promise<void> {
  if (!isDownloadAvailable()) return

  // Add a download manager button to the map controls toolbar
  const mapControls = document.getElementById('map-controls')
  if (mapControls) {
    const btn = document.createElement('button')
    btn.id = 'download-mgr-btn'
    btn.className = 'map-ctrl-btn'
    btn.title = 'Download Manager'
    btn.setAttribute('aria-label', 'Download manager')
    btn.innerHTML = '&#8615;'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      togglePanel()
    })
    mapControls.appendChild(btn)
  }

  // Close panel when clicking outside it
  document.addEventListener('click', (e) => {
    if (!panelOpen) return
    const panel = document.getElementById('download-manager')
    const btn = document.getElementById('download-mgr-btn')
    const target = e.target as HTMLElement
    if (panel?.contains(target) || btn?.contains(target)) return
    closeDownloadPanel()
  })

  // Subscribe to events
  unsubProgress = await onDownloadProgress(handleProgress)
  unsubComplete = await onDownloadComplete(handleComplete)
  unsubError = await onDownloadError(handleError)
}

function togglePanel(): void {
  panelOpen = !panelOpen
  const panel = document.getElementById('download-manager')
  if (!panel) return

  if (panelOpen) {
    panel.classList.remove('hidden')
    renderPanel()
  } else {
    panel.classList.add('hidden')
  }

  const btn = document.getElementById('download-mgr-btn')
  btn?.classList.toggle('active', panelOpen)
}

/** Close the panel if open. */
export function closeDownloadPanel(): void {
  if (panelOpen) togglePanel()
}

async function renderPanel(): Promise<void> {
  const panel = document.getElementById('download-manager')
  if (!panel) return

  const downloads = await listDownloads()
  const totalSize = await getDownloadsSize()

  if (downloads.length === 0) {
    panel.innerHTML = `
      <div class="dl-mgr-title">
        <span>Downloads</span>
      </div>
      <div class="dl-mgr-empty">No datasets downloaded yet.<br>Use the &#8615; button on a dataset card to download it for offline use.</div>
    `
    return
  }

  let html = `
    <div class="dl-mgr-title">
      <span>Downloads</span>
      <span class="dl-mgr-size">${formatBytes(totalSize)} total</span>
    </div>
  `

  for (const dl of downloads) {
    const thumbHtml = dl.thumbnail_file
      ? `<img class="dl-mgr-thumb" src="" alt="" data-dataset-id="${escapeAttr(dl.dataset_id)}" data-file="${escapeAttr(dl.thumbnail_file)}">`
      : ''

    html += `
      <div class="dl-mgr-item" data-id="${escapeAttr(dl.dataset_id)}">
        ${thumbHtml}
        <div class="dl-mgr-info">
          <div class="dl-mgr-name" title="${escapeAttr(dl.title)}">${escapeHtml(dl.title)}</div>
          <div class="dl-mgr-meta">${dl.kind} · ${formatBytes(dl.total_bytes)}</div>
        </div>
        <button class="dl-mgr-delete" data-id="${escapeAttr(dl.dataset_id)}" title="Delete download" aria-label="Delete ${escapeAttr(dl.title)}">&times;</button>
      </div>
    `
  }

  panel.innerHTML = html

  // Wire delete buttons
  panel.querySelectorAll<HTMLButtonElement>('.dl-mgr-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const id = btn.dataset.id
      if (!id) return
      await deleteDownload(id)
      // Update download button in browse grid if visible
      const browseBtn = document.querySelector(`.browse-card-download[data-id="${id}"]`) as HTMLButtonElement | null
      if (browseBtn) {
        browseBtn.classList.remove('downloaded', 'downloading')
        browseBtn.innerHTML = '&#8615;'
        browseBtn.title = 'Download for offline use'
      }
      renderPanel()
    })
  })
}

function handleProgress(progress: DownloadProgress): void {
  logger.debug('[Download] Progress:', progress.dataset_id, progress.phase)
  // Could update a progress bar in the panel here
}

function handleComplete(datasetId: string): void {
  logger.info('[Download] Complete:', datasetId)
  // Update browse card button
  const btn = document.querySelector(`.browse-card-download[data-id="${datasetId}"]`) as HTMLButtonElement | null
  if (btn) {
    btn.classList.remove('downloading')
    btn.classList.add('downloaded')
    btn.innerHTML = '&#10003;'
    btn.title = 'Downloaded'
  }
  // Refresh panel if open
  if (panelOpen) renderPanel()
}

function handleError(datasetId: string, error: string): void {
  logger.error('[Download] Error:', datasetId, error)
  // Reset browse card button
  const btn = document.querySelector(`.browse-card-download[data-id="${datasetId}"]`) as HTMLButtonElement | null
  if (btn) {
    btn.classList.remove('downloading')
    btn.innerHTML = '&#8615;'
    btn.title = `Download failed: ${error}`
  }
}

/** Clean up event listeners. */
export function destroyDownloadUI(): void {
  unsubProgress?.()
  unsubComplete?.()
  unsubError?.()
}
