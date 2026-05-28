/**
 * Download Dialog UI — §8.2 web-only zip-download panel.
 *
 * Floating panel (NOT modal) mirroring the playlist manager + desktop
 * download manager patterns. Opens anchored above the playback transport,
 * shows a checkbox per resolvable asset, an estimated size, the source-
 * of-truth note ("Downloaded as source MP4 from publisher upload" vs
 * "HLS adaptive video; downloaded as best-quality MP4 from Vimeo proxy"),
 * the 1 GB warning, the 1.5 GB hard cap, the progress bar during
 * download, and the cancel button.
 *
 * z-index 1200 — above the browse overlay (500), playlist manager
 * (1000), and Add-to-playlist popover (1100); below the error banner
 * (9000) so a hard error still wins.
 *
 * Web-only. The opening affordances (browse cards, info panel) gate
 * on `!IS_TAURI`; the desktop offline-cache path covers the desktop
 * use case.
 */

import type { Dataset } from '../types'
import type { ResolvedAsset, AssetKind, SourceOfTruth } from '../services/downloadService'
import { formatBytes } from '../services/downloadService'
import {
  buildZip,
  estimateZipSize,
  listDownloadableAssets,
  saveBlobAsDownload,
  ZIP_HARD_CAP_BYTES,
  ZIP_WARNING_BYTES,
  type ZipProgress,
} from '../services/zipDownloadService'
import { dataService } from '../services/dataService'
import { logger } from '../utils/logger'
import { t, tAttr, tHtml } from '../i18n'
import { escapeAttr, escapeHtml } from './domUtils'

/** Callbacks the dialog fires out into the rest of the app. */
export interface DownloadDialogCallbacks {
  /** Announce a status message via the global aria-live region. */
  announce?: (message: string) => void
}

let callbacks: DownloadDialogCallbacks = {}
let dialogOpen = false
let activeAbortController: AbortController | null = null
/** Which dataset id the dialog is currently bound to. */
let activeDatasetId: string | null = null
/** AssetKinds the user has checked. Resets to "all on" each open. */
let selectedKinds = new Set<AssetKind>()
/** Last-known resolved asset list — cached so re-renders during
 *  estimation / progress don't refetch the manifest. */
let resolvedAssets: ResolvedAsset[] = []
/** Last-known total estimate, rendered in the size line. -1 means
 *  "still estimating", 0 means "could not determine". */
let estimatedBytes = -1
let estimateSampled = false
/** Per-filename size map from the last estimate, used to render
 *  "Legend (12 KB)" rows next to each checkbox. */
let perAssetBytes = new Map<string, number>()
/** Set while a download is in flight; disables Start + re-renders
 *  the action row as Cancel. */
let downloading = false

/** Mount the dialog host + global listeners. Idempotent. */
export function initDownloadDialogUI(cb: DownloadDialogCallbacks = {}): void {
  callbacks = cb
  ensureDialogHost()

  if (!document.body.dataset.zipDownloadDialogWired) {
    document.body.dataset.zipDownloadDialogWired = 'true'
    document.addEventListener('click', captureClickOrigin, true)
    document.addEventListener('click', handleDocumentClick)
    document.addEventListener('keydown', handleDocumentKeydown)
  }
}

let lastClickStartedInDialog = false
let lastClickStartedInOpener = false
/** The browse card or info-panel button that opened the dialog. Used
 *  by the outside-click handler so clicking the opener twice doesn't
 *  immediately re-close.*/
let openerElement: HTMLElement | null = null

/** Tear down listeners + state. Called by tests. */
export function destroyDownloadDialogUI(): void {
  closeDownloadDialog()
  delete document.body.dataset.zipDownloadDialogWired
}

/** True iff the dialog is mounted and visible. */
export function isDownloadDialogOpen(): boolean {
  return dialogOpen
}

/**
 * Open the dialog for a given dataset. `opener` is the button the
 * user clicked; remembered so the outside-click handler treats a
 * second click on it as "still inside".
 *
 * If the dialog is already open for a different dataset the previous
 * state is reset; if it's open for the same dataset this is a no-op.
 */
export async function openDownloadDialog(datasetId: string, opener: HTMLElement | null): Promise<void> {
  if (dialogOpen && activeDatasetId === datasetId) return
  // Cancel any prior estimation / fetch when re-opening for a new
  // dataset so we don't overwrite the fresh dataset's state with a
  // late-arriving estimate for the previous one.
  activeAbortController?.abort()
  activeAbortController = null
  downloading = false

  ensureDialogHost()
  dialogOpen = true
  activeDatasetId = datasetId
  openerElement = opener
  selectedKinds.clear()
  resolvedAssets = []
  estimatedBytes = -1
  estimateSampled = false
  perAssetBytes = new Map()

  const panel = document.getElementById('zip-download-dialog')
  panel?.classList.remove('hidden')
  // Render an immediate "loading…" frame so the user sees something
  // while the manifest + HEAD probes run.
  renderDialog()

  const dataset = dataService.getDatasetById(datasetId)
  if (!dataset) {
    renderError(t('zip.error.datasetMissing'))
    return
  }

  try {
    const assets = await listDownloadableAssets(dataset, {
      includeFrames: !!dataset.frames,
    })
    // The dataset may have closed since the await; bail.
    if (!dialogOpen || activeDatasetId !== datasetId) return
    resolvedAssets = assets
    // Default-check everything. Renderer pairs each kind with its
    // own checkbox; frames are one combined row.
    for (const a of assets) selectedKinds.add(a.kind)
    selectedKinds.add('primary')
    // "metadata" — the manifest.json — is always included; not user-
    // selectable, so it doesn't appear in selectedKinds.
    renderDialog()

    // Kick off size estimation in the background. Aborts on close.
    activeAbortController = new AbortController()
    estimateZipSize(assets, { signal: activeAbortController.signal })
      .then((res) => {
        if (!dialogOpen || activeDatasetId !== datasetId) return
        estimatedBytes = res.bytes
        estimateSampled = res.sampled
        perAssetBytes = res.perAsset
        renderDialog()
      })
      .catch((err) => {
        if ((err as { name?: string })?.name === 'AbortError') return
        logger.warn('[zip-dialog] Estimate failed:', err)
        if (!dialogOpen || activeDatasetId !== datasetId) return
        estimatedBytes = 0
        renderDialog()
      })
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return
    if (!dialogOpen || activeDatasetId !== datasetId) return
    logger.warn('[zip-dialog] Failed to resolve assets:', err)
    const message = err instanceof Error ? err.message : String(err)
    renderError(message)
  }
}

/** Close the dialog + cancel any in-flight fetches. */
export function closeDownloadDialog(): void {
  activeAbortController?.abort()
  activeAbortController = null
  dialogOpen = false
  activeDatasetId = null
  openerElement = null
  downloading = false
  resolvedAssets = []
  selectedKinds.clear()
  estimatedBytes = -1
  estimateSampled = false
  perAssetBytes = new Map()
  document.getElementById('zip-download-dialog')?.classList.add('hidden')
}

function ensureDialogHost(): void {
  if (document.getElementById('zip-download-dialog')) return
  const host = document.createElement('div')
  host.id = 'zip-download-dialog'
  host.className = 'hidden'
  host.setAttribute('role', 'dialog')
  host.setAttribute('aria-modal', 'false')
  host.setAttribute('aria-label', tAttr('zip.dialog.title'))
  document.body.appendChild(host)
}

function renderDialog(): void {
  const panel = document.getElementById('zip-download-dialog')
  if (!panel || !activeDatasetId) return
  const dataset = dataService.getDatasetById(activeDatasetId)
  if (!dataset) {
    renderError(t('zip.error.datasetMissing'))
    return
  }

  // Source-of-truth note. The primary asset drives the note; users
  // care most about whether the main data is the original upload
  // or a transcode.
  const primary = resolvedAssets.find(a => a.kind === 'primary')
    ?? resolvedAssets.find(a => a.kind === 'frame')
  const sotNote = primary ? sourceOfTruthMessage(primary.sourceOfTruth) : ''

  const sizeRowHtml = renderSizeRow()
  const assetRowsHtml = renderAssetCheckboxes()
  const actionRowHtml = renderActionRow()
  const progressRowHtml = renderProgressRow()

  panel.innerHTML = `
    <div class="zip-dl-header">
      <span class="zip-dl-title">${tHtml('zip.dialog.title')}</span>
      <button type="button" class="zip-dl-close" id="zip-dl-close"
        aria-label="${tAttr('zip.dialog.close.aria')}">&#x2715;</button>
    </div>
    <p class="zip-dl-dataset">${escapeHtml(dataset.title)}</p>
    ${sotNote ? `<p class="zip-dl-source-note">${escapeHtml(sotNote)}</p>` : ''}
    ${assetRowsHtml}
    ${sizeRowHtml}
    ${progressRowHtml}
    ${actionRowHtml}
  `

  wireDialogEvents(panel)
}

function renderAssetCheckboxes(): string {
  if (resolvedAssets.length === 0) {
    return `<div class="zip-dl-loading">${tHtml('zip.dialog.loading')}</div>`
  }
  // Group frames into a single row — even with 8000 frames the user
  // ticks one checkbox, not 8000.
  const frames = resolvedAssets.filter(a => a.kind === 'frame')
  const nonFrames = resolvedAssets.filter(a => a.kind !== 'frame')

  const rows: string[] = []
  for (const a of nonFrames) {
    rows.push(renderAssetCheckbox(a.kind, assetLabel(a.kind), perAssetBytes.get(a.filename)))
  }
  if (frames.length > 0) {
    const totalFrameBytes = frames.reduce((s, a) => s + (perAssetBytes.get(a.filename) ?? 0), 0)
    rows.push(renderAssetCheckbox(
      'frame',
      t('zip.asset.frames', { count: frames.length }),
      totalFrameBytes > 0 ? totalFrameBytes : undefined,
    ))
  }
  // Manifest is always-on, non-toggleable; shown for clarity.
  rows.push(`<label class="zip-dl-asset-row disabled">
    <input type="checkbox" checked disabled>
    <span class="zip-dl-asset-name">${tHtml('zip.asset.manifest')}</span>
    <span class="zip-dl-asset-size">${tHtml('zip.size.alwaysIncluded')}</span>
  </label>`)
  return `<div class="zip-dl-assets" role="group" aria-label="${tAttr('zip.assets.aria')}">${rows.join('')}</div>`
}

function renderAssetCheckbox(kind: AssetKind, label: string, bytes: number | undefined): string {
  const checked = selectedKinds.has(kind) ? 'checked' : ''
  const sizeLabel = bytes !== undefined && bytes > 0
    ? formatBytes(bytes)
    : t('zip.size.unknown')
  return `<label class="zip-dl-asset-row">
    <input type="checkbox" data-kind="${escapeAttr(kind)}" ${checked}>
    <span class="zip-dl-asset-name">${escapeHtml(label)}</span>
    <span class="zip-dl-asset-size">${escapeHtml(sizeLabel)}</span>
  </label>`
}

function renderSizeRow(): string {
  if (estimatedBytes < 0) {
    return `<div class="zip-dl-size">${tHtml('zip.size.estimating')}</div>`
  }
  if (estimatedBytes === 0) {
    return `<div class="zip-dl-size">${tHtml('zip.size.unknown')}</div>`
  }
  const overCap = estimatedBytes > ZIP_HARD_CAP_BYTES
  const overWarn = estimatedBytes > ZIP_WARNING_BYTES
  const sizeFmt = formatBytes(estimatedBytes)
  const approx = estimateSampled ? t('zip.size.approxPrefix') + ' ' : ''
  let html = `<div class="zip-dl-size ${overCap ? 'over-cap' : overWarn ? 'over-warn' : ''}">`
  html += escapeHtml(t('zip.size.total', { size: approx + sizeFmt }))
  html += `</div>`
  if (overCap) {
    html += `<div class="zip-dl-warning">${escapeHtml(t('zip.size.overCap', { cap: formatBytes(ZIP_HARD_CAP_BYTES) }))}</div>`
  } else if (overWarn) {
    html += `<div class="zip-dl-warning">${escapeHtml(t('zip.size.overWarn', { warn: formatBytes(ZIP_WARNING_BYTES) }))}</div>`
  }
  return html
}

function renderActionRow(): string {
  if (downloading) {
    return `<div class="zip-dl-actions">
      <button type="button" class="zip-dl-btn-secondary" id="zip-dl-cancel">${tHtml('zip.action.cancel')}</button>
    </div>`
  }
  const disabled =
    resolvedAssets.length === 0 ||
    estimatedBytes < 0 ||
    estimatedBytes > ZIP_HARD_CAP_BYTES ||
    !hasAnySelection()
  return `<div class="zip-dl-actions">
    <button type="button" class="zip-dl-btn-primary" id="zip-dl-start"
      ${disabled ? 'disabled' : ''}>${tHtml('zip.action.start')}</button>
  </div>`
}

function renderProgressRow(): string {
  if (!downloading) return ''
  return `<div class="zip-dl-progress" aria-live="polite">
    <div class="zip-dl-progress-bar"><div class="zip-dl-progress-fill" id="zip-dl-progress-fill" style="width: 0%"></div></div>
    <div class="zip-dl-progress-label" id="zip-dl-progress-label">${tHtml('zip.progress.starting')}</div>
  </div>`
}

function renderError(message: string): void {
  const panel = document.getElementById('zip-download-dialog')
  if (!panel) return
  panel.innerHTML = `
    <div class="zip-dl-header">
      <span class="zip-dl-title">${tHtml('zip.dialog.title')}</span>
      <button type="button" class="zip-dl-close" id="zip-dl-close"
        aria-label="${tAttr('zip.dialog.close.aria')}">&#x2715;</button>
    </div>
    <p class="zip-dl-error">${escapeHtml(message)}</p>
  `
  panel.querySelector<HTMLButtonElement>('#zip-dl-close')?.addEventListener('click', closeDownloadDialog)
}

function wireDialogEvents(panel: HTMLElement): void {
  panel.querySelector<HTMLButtonElement>('#zip-dl-close')?.addEventListener('click', closeDownloadDialog)

  panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-kind]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const kind = cb.dataset.kind as AssetKind | undefined
      if (!kind) return
      if (cb.checked) selectedKinds.add(kind)
      else selectedKinds.delete(kind)
      // Re-render to enable/disable the Start button based on
      // whether anything's still selected.
      renderDialog()
    })
  })

  panel.querySelector<HTMLButtonElement>('#zip-dl-start')?.addEventListener('click', () => {
    void startDownload()
  })
  panel.querySelector<HTMLButtonElement>('#zip-dl-cancel')?.addEventListener('click', () => {
    activeAbortController?.abort()
  })
}

async function startDownload(): Promise<void> {
  if (!activeDatasetId) return
  const dataset = dataService.getDatasetById(activeDatasetId)
  if (!dataset) return
  // Filter the resolved list down to the kinds the user checked.
  // `frame` is collapsed into a single checkbox; ticking it includes
  // every individual frame entry.
  const assetsToZip = resolvedAssets.filter(a => selectedKinds.has(a.kind))
  if (assetsToZip.length === 0) return

  downloading = true
  activeAbortController = new AbortController()
  renderDialog()

  try {
    const result = await buildZip(dataset, assetsToZip, {
      signal: activeAbortController.signal,
      onProgress: handleProgress,
    })
    saveBlobAsDownload(result.blob, result.filename)
    const sizeLabel = formatBytes(result.bytesWritten)
    if (result.failures.length === 0) {
      callbacks.announce?.(t('zip.completed.announce', { filename: result.filename, size: sizeLabel }))
    } else {
      callbacks.announce?.(t('zip.completed.withFailures.announce', {
        filename: result.filename,
        size: sizeLabel,
        count: result.failures.length,
      }))
    }
    closeDownloadDialog()
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      callbacks.announce?.(t('zip.cancelled.announce'))
      closeDownloadDialog()
      return
    }
    logger.warn('[zip-dialog] Download failed:', err)
    const message = err instanceof Error ? err.message : String(err)
    downloading = false
    renderError(t('zip.error.downloadFailed', { reason: message }))
  }
}

function handleProgress(progress: ZipProgress): void {
  const fill = document.getElementById('zip-dl-progress-fill')
  const label = document.getElementById('zip-dl-progress-label')
  if (fill) fill.style.width = `${Math.round(progress.fraction * 100)}%`
  if (label) {
    let phaseLabel = ''
    switch (progress.phase) {
      case 'fetching':
        phaseLabel = progress.currentFile
          ? t('zip.progress.fetchingNamed', { file: progress.currentFile })
          : t('zip.progress.fetching')
        break
      case 'packaging':
        phaseLabel = t('zip.progress.packaging')
        break
      case 'done':
        phaseLabel = t('zip.progress.done')
        break
    }
    label.textContent = phaseLabel
  }
}

function hasAnySelection(): boolean {
  for (const a of resolvedAssets) {
    if (selectedKinds.has(a.kind)) return true
  }
  return false
}

function assetLabel(kind: AssetKind): string {
  switch (kind) {
    case 'primary': return t('zip.asset.primary')
    case 'legend': return t('zip.asset.legend')
    case 'caption': return t('zip.asset.caption')
    case 'thumbnail': return t('zip.asset.thumbnail')
    case 'colorTable': return t('zip.asset.colorTable')
    case 'frame': return t('zip.asset.frames', { count: 0 })
  }
}

function sourceOfTruthMessage(sot: SourceOfTruth): string {
  switch (sot) {
    case 'publisher': return t('zip.source.publisher')
    case 'vimeo': return t('zip.source.vimeo')
    case 'sos': return t('zip.source.sos')
    case 'external': return t('zip.source.external')
  }
}

function captureClickOrigin(ev: MouseEvent): void {
  const target = ev.target as Node | null
  const panel = document.getElementById('zip-download-dialog')
  lastClickStartedInDialog = !!(panel && target && panel.contains(target))
  lastClickStartedInOpener = !!(openerElement && target && openerElement.contains(target))
}

function handleDocumentClick(_ev: MouseEvent): void {
  if (!dialogOpen) return
  // Don't dismiss while a download is mid-flight — the user has to
  // explicitly hit Cancel so we never silently drop bytes.
  if (downloading) return
  if (!lastClickStartedInDialog && !lastClickStartedInOpener) {
    closeDownloadDialog()
  }
}

function handleDocumentKeydown(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape') return
  if (!dialogOpen) return
  if (downloading) {
    activeAbortController?.abort()
    return
  }
  closeDownloadDialog()
}

/** Test-only surface. Reset module state between tests. */
export function __resetDownloadDialogForTests(): void {
  closeDownloadDialog()
  callbacks = {}
}
