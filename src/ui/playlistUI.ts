/**
 * Playlist UI — manager panel + the small "Add to playlist"
 * popover surfaced from browse cards and the dataset info panel.
 *
 * Two surfaces live in this module:
 *
 *  1. The playlist manager — a floating panel listing every saved
 *     playlist. From here the user creates / renames / deletes a
 *     playlist, drags entries to reorder, edits per-entry duration,
 *     plays a playlist, and exports / imports JSON. Mirrors the
 *     shape of `downloadUI.ts` — same close-on-outside-click, same
 *     panel host idiom — so the UX is consistent.
 *
 *  2. The "Add to playlist" popover — a tiny floating list anchored
 *     under whichever button triggered it (browse card or info-
 *     panel "Add to playlist…" button). Lists existing playlists +
 *     a "New playlist…" option at the bottom.
 *
 * Both surfaces re-render on every `onPlaylistsChange` notification
 * so a write from one path (e.g. add-to-playlist from a browse card
 * while the manager is open) flows through to the other.
 *
 * Persistence-warning banner is shown at the top of the manager
 * panel — playlists are localStorage only and survive clear-site-
 * data only via the JSON export. The plan calls this out as a
 * known mitigation, not a fix; the banner makes it visible to
 * users.
 */

import {
  addToPlaylist,
  createPlaylist,
  DEFAULT_ENTRY_DURATION_SEC,
  deletePlaylist,
  effectiveDuration,
  exportPlaylistsJson,
  importPlaylists,
  IMPORT_MAX_BYTES,
  loadPlaylists,
  onPlaylistsChange,
  removeFromPlaylist,
  renamePlaylist,
  reorderPlaylist,
  setEntryDuration,
  setEntryPauseForInput,
  setPlaylistLoop,
  type Playlist,
} from '../services/playlistService'
import {
  getActive as getActivePlayback,
  onPlaybackChange,
  play as playPlaylist,
  skipNext as skipNextPlaylistEntry,
  stop as stopPlaylistPlayback,
} from '../services/playlistPlayback'
import { dataService } from '../services/dataService'
import { logger } from '../utils/logger'
import { plural, t, tAttr, tHtml } from '../i18n'
import { escapeAttr, escapeHtml } from './domUtils'

/** Callbacks the playlist UI fires out into the rest of the app. */
export interface PlaylistUICallbacks {
  /** Announce a status message via the global aria-live region. */
  announce?: (message: string) => void
}

let callbacks: PlaylistUICallbacks = {}
let managerOpen = false
let popoverAnchor: HTMLElement | null = null
/** Dataset id the popover is currently bound to. Captured at
 *  open time so re-renders (e.g. from `onPlaylistsChange`) can't
 *  pick up a stale or missing `data-dataset-id` if the caller's
 *  anchor element has since been re-rendered. */
let popoverDatasetId: string | null = null
let unsubPlaylists: (() => void) | null = null
let unsubPlayback: (() => void) | null = null
/** Which playlists the user has expanded in the manager. Session-
 *  only so the manager opens fresh each session — persisting
 *  expand/collapse adds little value compared with the cost of
 *  yet another localStorage key. The currently-playing playlist
 *  is auto-expanded by `renderManager` regardless of this set. */
const expandedPlaylistIds = new Set<string>()
/** Current name-substring filter, lower-cased. Empty = no filter. */
let managerSearchQuery = ''

/** Mount the playlist manager panel + global listeners. Idempotent. */
export function initPlaylistUI(cb: PlaylistUICallbacks = {}): void {
  callbacks = cb
  ensureManagerHost()

  // Re-render the manager + popover on any playlist mutation. Both
  // can be open at once (rare but plausible: tap "Add to playlist"
  // on a browse card while the manager is open) so both re-render.
  unsubPlaylists?.()
  unsubPlaylists = onPlaylistsChange(() => {
    if (managerOpen) renderManager()
    if (popoverAnchor && popoverDatasetId) {
      renderAddPopover(popoverAnchor, popoverDatasetId)
    }
  })

  // Re-render the manager when playback state changes (the Play
  // button on each row needs to flip to "Stop" while that playlist
  // is the active one). Also drive the floating Continue prompt
  // off the same channel — it's visible exactly when the active
  // entry is paused waiting for user input.
  unsubPlayback?.()
  unsubPlayback = onPlaybackChange(() => {
    if (managerOpen) renderManager()
    syncContinuePrompt()
  })
  ensureContinuePromptHost()
  syncContinuePrompt()

  // Outside-click closes the manager. Wired once. The capture-phase
  // listener records where each click originated *before* any
  // target-phase handlers can mutate the DOM (e.g. an in-panel
  // button that wipes panel.innerHTML on click — without the
  // capture sample, the bubble-phase containment check would see
  // the orphaned target as "outside" and close the panel).
  if (!document.body.dataset.playlistUiListenersWired) {
    document.body.dataset.playlistUiListenersWired = 'true'
    document.addEventListener('click', captureClickOrigin, true)
    document.addEventListener('click', handleDocumentClick)
    document.addEventListener('keydown', handleDocumentKeydown)
  }
}

// Module-level click-origin sentinels, written in capture phase and
// read in bubble phase. Reset to a known state at the top of every
// click so a stale value can't survive between events.
let lastClickStartedInPanel = false
let lastClickStartedInToolsMenu = false
let lastClickStartedInPopover = false
let lastClickStartedInPopoverAnchor = false

/** Tear down listeners. Called by tests. */
export function destroyPlaylistUI(): void {
  unsubPlaylists?.()
  unsubPlaylists = null
  unsubPlayback?.()
  unsubPlayback = null
  closeAddPopover()
  // Reset session-scoped UI state so a subsequent initPlaylistUI()
  // sees a fresh slate — matters for tests, not for production.
  expandedPlaylistIds.clear()
  managerSearchQuery = ''
}

// ─────────────────────────────────────────────────────────────────────
// Manager panel
// ─────────────────────────────────────────────────────────────────────

/** Open the playlist manager. Lazy-mounts on first call. */
export function openPlaylistManager(): void {
  ensureManagerHost()
  managerOpen = true
  const panel = document.getElementById('playlist-manager')
  panel?.classList.remove('hidden')
  renderManager()
  // Focus the close button so keyboard users have a sensible anchor.
  const closeBtn = document.getElementById('playlist-manager-close') as HTMLButtonElement | null
  closeBtn?.focus()
}

/** Close the playlist manager if open. */
export function closePlaylistManager(): void {
  if (!managerOpen) return
  managerOpen = false
  document.getElementById('playlist-manager')?.classList.add('hidden')
}

/** Whether the manager is currently visible — used by tests. */
export function isPlaylistManagerOpen(): boolean {
  return managerOpen
}

// ─────────────────────────────────────────────────────────────────────
// "Click to continue" floating prompt
// ─────────────────────────────────────────────────────────────────────

/** Build the floating Continue prompt host (idempotent). The
 *  element stays in the DOM after first mount and toggles its
 *  hidden class via `syncContinuePrompt`. */
function ensureContinuePromptHost(): void {
  if (document.getElementById('playlist-continue-prompt')) return
  const host = document.createElement('button')
  host.id = 'playlist-continue-prompt'
  host.type = 'button'
  host.className = 'hidden'
  host.setAttribute('aria-label', t('playlist.continue.aria'))
  host.innerHTML = `
    <span class="pl-continue-icon" aria-hidden="true">&#x25B6;&#xFE0E;</span>
    <span class="pl-continue-label">${escapeHtml(t('playlist.continue.label'))}</span>`
  host.addEventListener('click', () => {
    skipNextPlaylistEntry()
  })
  document.body.appendChild(host)
}

/** Show or hide the Continue prompt based on the active entry's
 *  `pauseForInput` flag. Called whenever playback state changes. */
function syncContinuePrompt(): void {
  const host = document.getElementById('playlist-continue-prompt')
  if (!host) return
  const state = getActivePlayback()
  const entry = state ? state.playlist.datasets[state.index] : null
  const visible = !!(state && entry?.pauseForInput && !state.paused)
  host.classList.toggle('hidden', !visible)
}

function ensureManagerHost(): void {
  if (document.getElementById('playlist-manager')) return
  const host = document.createElement('div')
  host.id = 'playlist-manager'
  host.className = 'hidden'
  host.setAttribute('role', 'dialog')
  host.setAttribute('aria-modal', 'false')
  host.setAttribute('aria-label', t('playlist.manager.title'))
  document.body.appendChild(host)
}

function renderManager(): void {
  const panel = document.getElementById('playlist-manager')
  if (!panel) return
  const playlists = loadPlaylists()
  const activePlayback = getActivePlayback()
  // Filter by case-insensitive substring; empty query = show all.
  // The actively-playing playlist always passes the filter so the
  // user can never accidentally type their way out of seeing the
  // row whose Stop button they need to reach.
  const q = managerSearchQuery.trim().toLowerCase()
  const filtered = q.length === 0
    ? playlists
    : playlists.filter((p) =>
        p.name.toLowerCase().includes(q) || p.id === activePlayback?.playlist.id)

  const searchHtml = playlists.length > 0
    ? `<div class="pl-mgr-search">
         <input type="search" id="playlist-manager-search"
           class="pl-mgr-search-input"
           placeholder="${tAttr('playlist.search.placeholder')}"
           aria-label="${tAttr('playlist.search.aria')}"
           value="${escapeAttr(managerSearchQuery)}">
       </div>`
    : ''

  let html = `
    <div class="pl-mgr-header">
      <span class="pl-mgr-title">${tHtml('playlist.manager.title')}</span>
      <button type="button" class="pl-mgr-close" id="playlist-manager-close"
        aria-label="${tAttr('playlist.manager.close.aria')}">&#x2715;</button>
    </div>
    <p class="pl-mgr-warning">${tHtml('playlist.persistence.warning')}</p>
    <div class="pl-mgr-actions">
      <button type="button" class="pl-mgr-btn" id="playlist-manager-new"
        aria-label="${tAttr('playlist.new.button.aria')}">${tHtml('playlist.new.button')}</button>
      <button type="button" class="pl-mgr-btn pl-mgr-btn-secondary" id="playlist-manager-export"
        ${playlists.length === 0 ? 'disabled' : ''}>${tHtml('playlist.export.label')}</button>
      <button type="button" class="pl-mgr-btn pl-mgr-btn-secondary" id="playlist-manager-import"
        >${tHtml('playlist.import.label')}</button>
      <input type="file" id="playlist-manager-import-input" accept="application/json,.json" hidden>
    </div>
    ${searchHtml}
  `

  if (playlists.length === 0) {
    html += `<div class="pl-mgr-empty">${tHtml('playlist.empty.message')}</div>`
  } else if (filtered.length === 0) {
    html += `<div class="pl-mgr-empty">${escapeHtml(t('playlist.search.empty', { query: managerSearchQuery }))}</div>`
  } else {
    html += `<ul class="pl-mgr-list" role="list">`
    for (const p of filtered) {
      const isActive = activePlayback?.playlist.id === p.id
      // The active playlist always expands so the user can see
      // what's playing without an extra click; otherwise we honour
      // the session-level expandedPlaylistIds set.
      const isExpanded = isActive || expandedPlaylistIds.has(p.id)
      html += renderPlaylistRow(p, isActive, isExpanded)
    }
    html += `</ul>`
  }

  panel.innerHTML = html

  wireManagerEvents(panel, activePlayback?.playlist.id ?? null)
}

function renderPlaylistRow(playlist: Playlist, isActive: boolean, isExpanded: boolean): string {
  const count = playlist.datasets.length
  const countLabel = plural(count,
    { one: 'browse.count.one', other: 'browse.count.other' },
    { count })
  const playButton = isActive
    ? `<button type="button" class="pl-mgr-row-play active" data-id="${escapeAttr(playlist.id)}"
        aria-label="${escapeAttr(t('playlist.stop.aria', { name: playlist.name }))}"
        >&#x25A0;</button>`
    : `<button type="button" class="pl-mgr-row-play" data-id="${escapeAttr(playlist.id)}"
        aria-label="${escapeAttr(t('playlist.play.aria', { name: playlist.name }))}"
        ${count === 0 ? 'disabled' : ''}>&#x25B6;</button>`

  let entriesHtml = ''
  if (count === 0) {
    entriesHtml = `<li class="pl-mgr-entry-empty">${tHtml('playlist.entry.empty')}</li>`
  } else {
    for (let i = 0; i < playlist.datasets.length; i++) {
      const entry = playlist.datasets[i]
      const dataset = dataService.getDatasetById(entry.datasetId)
      const title = dataset?.title ?? t('playlist.unknownDataset')
      const duration = entry.durationSec ?? ''
      const pauseChecked = entry.pauseForInput ? 'checked' : ''
      // Two mutually-exclusive modes:
      //  - pauseForInput: show only the "Wait for click" toggle so
      //    the user isn't distracted by a duration that would never
      //    apply.
      //  - timer-driven: show "Show for [n] sec" with the prefix +
      //    suffix making the unit obvious; the toggle sits next to
      //    it so the user can swap modes without scrubbing.
      const durationFieldHtml = entry.pauseForInput
        ? ''
        : `<label class="pl-mgr-entry-duration-field">
            <span class="pl-mgr-entry-duration-prefix">${tHtml('playlist.duration.prefix')}</span>
            <input type="number" min="1" step="1" class="pl-mgr-entry-duration"
              value="${escapeAttr(String(duration))}"
              placeholder="${escapeAttr(String(DEFAULT_ENTRY_DURATION_SEC))}"
              aria-label="${tAttr('playlist.duration.label')}"
              data-id="${escapeAttr(playlist.id)}" data-index="${i}">
            <span class="pl-mgr-entry-duration-suffix">${tHtml('playlist.duration.suffix')}</span>
          </label>`
      entriesHtml += `
        <li class="pl-mgr-entry" data-id="${escapeAttr(playlist.id)}" data-index="${i}">
          <span class="pl-mgr-entry-title">${escapeHtml(title)}</span>
          ${durationFieldHtml}
          <label class="pl-mgr-entry-pause" title="${escapeAttr(t('playlist.entry.pauseForInput.label'))}">
            <input type="checkbox" class="pl-mgr-entry-pause-input"
              data-id="${escapeAttr(playlist.id)}" data-index="${i}"
              aria-label="${escapeAttr(t('playlist.entry.pauseForInput.aria', { title }))}"
              ${pauseChecked}>
            <span aria-hidden="true">&#x23F8;&#xFE0E;</span>
            <span class="pl-mgr-toggle-label">${tHtml('playlist.entry.pauseForInput.label')}</span>
          </label>
          <button type="button" class="pl-mgr-entry-move pl-mgr-entry-move-up"
            data-id="${escapeAttr(playlist.id)}" data-index="${i}"
            aria-label="${escapeAttr(t('playlist.entry.moveUp.aria', { title }))}"
            ${i === 0 ? 'disabled' : ''}>&#x25B2;</button>
          <button type="button" class="pl-mgr-entry-move pl-mgr-entry-move-down"
            data-id="${escapeAttr(playlist.id)}" data-index="${i}"
            aria-label="${escapeAttr(t('playlist.entry.moveDown.aria', { title }))}"
            ${i === playlist.datasets.length - 1 ? 'disabled' : ''}>&#x25BC;</button>
          <button type="button" class="pl-mgr-entry-remove"
            data-id="${escapeAttr(playlist.id)}" data-index="${i}"
            aria-label="${escapeAttr(t('playlist.entry.remove.aria', { title }))}"
            >&#x2715;</button>
        </li>`
    }
  }

  const loopChecked = playlist.loop ? 'checked' : ''
  // Chevron points right when collapsed, down when expanded.
  const chevron = isExpanded ? '&#x25BE;' : '&#x25B8;'
  const expandLabel = isExpanded
    ? t('playlist.collapse.aria', { name: playlist.name })
    : t('playlist.expand.aria', { name: playlist.name })
  return `
    <li class="pl-mgr-row${isActive ? ' active' : ''}${isExpanded ? ' expanded' : ''}" data-id="${escapeAttr(playlist.id)}">
      <div class="pl-mgr-row-header">
        ${playButton}
        <button type="button" class="pl-mgr-row-toggle" data-id="${escapeAttr(playlist.id)}"
          aria-expanded="${isExpanded}"
          aria-label="${escapeAttr(expandLabel)}">
          <span class="pl-mgr-row-chevron" aria-hidden="true">${chevron}</span>
          <span class="pl-mgr-row-name-text">${escapeHtml(playlist.name)}</span>
        </button>
        <span class="pl-mgr-row-count">${escapeHtml(countLabel)}</span>
        <button type="button" class="pl-mgr-row-rename" data-id="${escapeAttr(playlist.id)}"
          aria-label="${escapeAttr(t('playlist.rename.aria', { name: playlist.name }))}"
          title="${escapeAttr(t('playlist.rename.aria', { name: playlist.name }))}">&#x270E;&#xFE0E;</button>
        <label class="pl-mgr-row-loop" title="${escapeAttr(t('playlist.loop.label'))}">
          <input type="checkbox" class="pl-mgr-row-loop-input"
            data-id="${escapeAttr(playlist.id)}"
            aria-label="${escapeAttr(t('playlist.loop.aria', { name: playlist.name }))}"
            ${loopChecked}>
          <span aria-hidden="true">&#x21BB;</span>
          <span class="pl-mgr-toggle-label">${tHtml('playlist.loop.label')}</span>
        </label>
        <button type="button" class="pl-mgr-row-delete" data-id="${escapeAttr(playlist.id)}"
          aria-label="${escapeAttr(t('playlist.delete.aria', { name: playlist.name }))}"
          >&#x1F5D1;&#xFE0E;</button>
      </div>
      ${isExpanded ? `<ul class="pl-mgr-entries" role="list">${entriesHtml}</ul>` : ''}
    </li>`
}

function wireManagerEvents(panel: HTMLElement, activePlaylistId: string | null): void {
  panel.querySelector<HTMLButtonElement>('#playlist-manager-close')
    ?.addEventListener('click', () => closePlaylistManager())

  const searchInput = panel.querySelector<HTMLInputElement>('#playlist-manager-search')
  if (searchInput) {
    // Re-render on every keystroke. The list is small (<100 rows in
    // any realistic case) and the input itself recovers its caret
    // via the focus restore below — so a full innerHTML replace is
    // cheaper than fine-grained DOM diffing.
    searchInput.addEventListener('input', () => {
      managerSearchQuery = searchInput.value
      renderManager()
      const refocused = document.getElementById('playlist-manager-search') as HTMLInputElement | null
      if (refocused) {
        refocused.focus()
        const end = refocused.value.length
        refocused.setSelectionRange(end, end)
      }
    })
  }

  panel.querySelector<HTMLButtonElement>('#playlist-manager-new')?.addEventListener('click', () => {
    const name = window.prompt(t('playlist.create.prompt'), t('playlist.create.defaultName'))
    if (name == null) return
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    createPlaylist(trimmed)
  })

  panel.querySelector<HTMLButtonElement>('#playlist-manager-export')?.addEventListener('click', () => {
    triggerExport()
  })

  panel.querySelector<HTMLButtonElement>('#playlist-manager-import')?.addEventListener('click', () => {
    const fileInput = panel.querySelector<HTMLInputElement>('#playlist-manager-import-input')
    fileInput?.click()
  })
  panel.querySelector<HTMLInputElement>('#playlist-manager-import-input')?.addEventListener('change', (ev) => {
    const input = ev.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) void handleImportFile(file)
    // Clear value so re-selecting the same file fires the change event.
    input.value = ''
  })

  // Per-row actions
  panel.querySelectorAll<HTMLButtonElement>('.pl-mgr-row-play').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      if (!id) return
      const target = loadPlaylists().find((p) => p.id === id)
      if (!target) return
      if (activePlaylistId === id) {
        stopPlaylistPlayback()
        callbacks.announce?.(t('playlist.stop.announce', { name: target.name }))
      } else {
        playPlaylist(target)
      }
    })
  })

  panel.querySelectorAll<HTMLButtonElement>('.pl-mgr-row-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      if (!id) return
      if (expandedPlaylistIds.has(id)) {
        expandedPlaylistIds.delete(id)
      } else {
        expandedPlaylistIds.add(id)
      }
      renderManager()
    })
  })

  panel.querySelectorAll<HTMLButtonElement>('.pl-mgr-row-rename').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      if (!id) return
      const current = loadPlaylists().find((p) => p.id === id)
      if (!current) return
      const next = window.prompt(t('playlist.rename.prompt'), current.name)
      if (next == null) return
      const trimmed = next.trim()
      if (trimmed.length === 0) return
      renamePlaylist(id, trimmed)
    })
  })

  panel.querySelectorAll<HTMLButtonElement>('.pl-mgr-row-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      if (!id) return
      const target = loadPlaylists().find((p) => p.id === id)
      if (!target) return
      const confirmed = window.confirm(t('playlist.delete.confirm', { name: target.name }))
      if (!confirmed) return
      if (activePlaylistId === id) stopPlaylistPlayback()
      deletePlaylist(id)
    })
  })

  // Per-entry actions
  panel.querySelectorAll<HTMLInputElement>('.pl-mgr-entry-duration').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.id
      const indexStr = input.dataset.index
      if (!id || indexStr == null) return
      const index = Number(indexStr)
      const raw = input.value.trim()
      if (raw === '') {
        setEntryDuration(id, index, undefined)
        return
      }
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        // Reject — re-render to revert the input.
        renderManager()
        return
      }
      setEntryDuration(id, index, Math.floor(parsed))
    })
  })

  panel.querySelectorAll<HTMLInputElement>('.pl-mgr-row-loop-input').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.id
      if (!id) return
      setPlaylistLoop(id, input.checked)
    })
  })

  panel.querySelectorAll<HTMLInputElement>('.pl-mgr-entry-pause-input').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.id
      const indexStr = input.dataset.index
      if (!id || indexStr == null) return
      setEntryPauseForInput(id, Number(indexStr), input.checked)
    })
  })

  panel.querySelectorAll<HTMLButtonElement>('.pl-mgr-entry-move-up').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      const indexStr = btn.dataset.index
      if (!id || indexStr == null) return
      const index = Number(indexStr)
      reorderPlaylist(id, index, index - 1)
    })
  })
  panel.querySelectorAll<HTMLButtonElement>('.pl-mgr-entry-move-down').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      const indexStr = btn.dataset.index
      if (!id || indexStr == null) return
      const index = Number(indexStr)
      reorderPlaylist(id, index, index + 1)
    })
  })
  panel.querySelectorAll<HTMLButtonElement>('.pl-mgr-entry-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      const indexStr = btn.dataset.index
      if (!id || indexStr == null) return
      removeFromPlaylist(id, Number(indexStr))
    })
  })
}

// ─────────────────────────────────────────────────────────────────────
// Export / Import
// ─────────────────────────────────────────────────────────────────────

function triggerExport(): void {
  const json = exportPlaylistsJson()
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = t('playlist.export.filename')
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // Browsers eventually GC the object URL but explicit release is
  // cheaper and avoids holding the blob beyond the moment the
  // download triggers.
  URL.revokeObjectURL(url)
}

/** Process an uploaded JSON file. Exported for tests so they can
 *  drive the import path without the synthetic file-input change
 *  event the harness can't fire cleanly. */
export async function handleImportFile(file: File): Promise<void> {
  if (file.size > IMPORT_MAX_BYTES) {
    callbacks.announce?.(t('playlist.import.error.tooBig'))
    window.alert(t('playlist.import.error.tooBig'))
    return
  }
  let text: string
  try {
    text = await file.text()
  } catch (err) {
    logger.warn('[playlist] Failed to read import file:', err)
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    callbacks.announce?.(t('playlist.import.error.invalidJson'))
    window.alert(t('playlist.import.error.invalidJson'))
    return
  }
  const result = importPlaylists(parsed, { merge: true })
  if (result.imported === 0) {
    callbacks.announce?.(t('playlist.import.error.noPlaylists'))
    window.alert(t('playlist.import.error.noPlaylists'))
    return
  }
  const msg = plural(result.imported,
    { one: 'playlist.import.success.one', other: 'playlist.import.success.other' },
    { count: result.imported })
  callbacks.announce?.(msg)
}

// ─────────────────────────────────────────────────────────────────────
// Add-to-playlist popover
// ─────────────────────────────────────────────────────────────────────

/**
 * Open the "Add to playlist" quick-pick popover anchored under the
 * given trigger element. Re-rendering an already-open popover (e.g.
 * a playlist gets created while it's open) is handled by
 * `onPlaylistsChange`.
 */
export function openAddToPlaylistPopover(datasetId: string, anchor: HTMLElement): void {
  if (!datasetId) return
  popoverAnchor = anchor
  popoverDatasetId = datasetId
  ensurePopoverHost()
  renderAddPopover(anchor, datasetId)
}

/** Close the add-to-playlist popover. Idempotent. */
export function closeAddPopover(): void {
  popoverAnchor = null
  popoverDatasetId = null
  const host = document.getElementById('playlist-add-popover')
  if (host) host.classList.add('hidden')
}

function ensurePopoverHost(): void {
  if (document.getElementById('playlist-add-popover')) return
  const host = document.createElement('div')
  host.id = 'playlist-add-popover'
  host.className = 'hidden'
  host.setAttribute('role', 'dialog')
  host.setAttribute('aria-modal', 'false')
  host.setAttribute('aria-label', t('playlist.add.popover.title'))
  document.body.appendChild(host)
}

function renderAddPopover(anchor: HTMLElement, datasetId: string): void {
  const host = document.getElementById('playlist-add-popover')
  if (!host) return
  if (!datasetId) {
    closeAddPopover()
    return
  }
  const playlists = loadPlaylists()

  let html = `
    <div class="pl-add-header">
      <span class="pl-add-title">${tHtml('playlist.add.popover.title')}</span>
      <button type="button" class="pl-add-close" id="playlist-add-close"
        aria-label="${tAttr('playlist.add.popover.close.aria')}">&#x2715;</button>
    </div>
    <ul class="pl-add-list" role="list">`
  if (playlists.length === 0) {
    html += `<li class="pl-add-empty">${tHtml('playlist.add.popover.empty')}</li>`
  } else {
    for (const p of playlists) {
      const alreadyIn = p.datasets.some((e) => e.datasetId === datasetId)
      html += `
        <li>
          <button type="button" class="pl-add-option" data-id="${escapeAttr(p.id)}"
            data-already-in="${alreadyIn ? '1' : '0'}">
            <span class="pl-add-option-name">${escapeHtml(p.name)}</span>
            ${alreadyIn ? `<span class="pl-add-option-check" aria-hidden="true">&#x2713;</span>` : ''}
          </button>
        </li>`
    }
  }
  html += `
    </ul>
    <button type="button" class="pl-add-new" id="playlist-add-new">${tHtml('playlist.add.popover.newOption')}</button>`

  host.innerHTML = html
  host.classList.remove('hidden')

  // Position the popover so it stays inside the viewport. Anchors
  // near the right edge of the screen (common — the browse panel
  // is right-anchored, so its "+" buttons sit close to the edge)
  // would otherwise push the popover off-screen. We measure the
  // popover after it's been made visible, then clamp.
  const margin = 8
  const rect = anchor.getBoundingClientRect()
  const popoverRect = host.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  // Vertical: prefer below the anchor; flip above when there isn't
  // room and the anchor is below the vertical midpoint.
  let top = rect.bottom + 6
  if (top + popoverRect.height > vh - margin) {
    const above = rect.top - popoverRect.height - 6
    top = above >= margin ? above : Math.max(margin, vh - popoverRect.height - margin)
  }

  // Horizontal: align the start edge to the anchor, then clamp so
  // the trailing edge stays inside the viewport. Visual-axis (not
  // logical-axis) coordinates here — `inset-inline-start` is what
  // we want in LTR but in RTL the popover should still hug the
  // anchor's start edge, which means measuring from the right.
  const isRtl = document.documentElement.dir === 'rtl'
  if (isRtl) {
    let right = vw - rect.right
    const maxRight = vw - popoverRect.width - margin
    right = Math.max(margin, Math.min(right, maxRight))
    host.style.insetInlineStart = ''
    host.style.right = `${Math.round(right)}px`
  } else {
    let left = rect.left
    const maxLeft = vw - popoverRect.width - margin
    left = Math.max(margin, Math.min(left, maxLeft))
    host.style.right = ''
    host.style.insetInlineStart = `${Math.round(left)}px`
  }
  host.style.top = `${Math.round(top)}px`

  host.querySelector<HTMLButtonElement>('#playlist-add-close')
    ?.addEventListener('click', () => closeAddPopover())

  host.querySelector<HTMLButtonElement>('#playlist-add-new')?.addEventListener('click', () => {
    const name = window.prompt(t('playlist.create.prompt'), t('playlist.create.defaultName'))
    if (name == null) return
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    const newPlaylist = createPlaylist(trimmed)
    addToPlaylist(newPlaylist.id, datasetId)
    const dataset = dataService.getDatasetById(datasetId)
    callbacks.announce?.(t('playlist.added.announce', {
      title: dataset?.title ?? datasetId,
      playlist: newPlaylist.name,
    }))
    closeAddPopover()
  })

  host.querySelectorAll<HTMLButtonElement>('.pl-add-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      if (!id) return
      const target = loadPlaylists().find((p) => p.id === id)
      if (!target) return
      const dataset = dataService.getDatasetById(datasetId)
      if (btn.dataset.alreadyIn === '1') {
        callbacks.announce?.(t('playlist.alreadyIn.announce', {
          title: dataset?.title ?? datasetId,
          playlist: target.name,
        }))
        closeAddPopover()
        return
      }
      addToPlaylist(id, datasetId)
      callbacks.announce?.(t('playlist.added.announce', {
        title: dataset?.title ?? datasetId,
        playlist: target.name,
      }))
      closeAddPopover()
    })
  })
}

/** Capture-phase sample of where the click originated. Runs before
 *  any in-panel handler can detach the target via a re-render. */
function captureClickOrigin(ev: MouseEvent): void {
  const target = ev.target as Node | null
  const panel = document.getElementById('playlist-manager')
  const toolsMenu = document.getElementById('map-controls')
  const popover = document.getElementById('playlist-add-popover')
  lastClickStartedInPanel = !!(panel && target && panel.contains(target))
  lastClickStartedInToolsMenu = !!(toolsMenu && target && toolsMenu.contains(target))
  lastClickStartedInPopover = !!(popover && target && popover.contains(target))
  lastClickStartedInPopoverAnchor = !!(popoverAnchor && target && popoverAnchor.contains(target))
}

function handleDocumentClick(_ev: MouseEvent): void {
  // Read the capture-phase determinations rather than re-checking
  // containment here — the target may have been detached from the
  // DOM during target-phase handlers (panel re-renders) and would
  // then read as "outside" everything.
  if (popoverAnchor && !lastClickStartedInPopover && !lastClickStartedInPopoverAnchor) {
    closeAddPopover()
  }
  if (managerOpen && !lastClickStartedInPanel && !lastClickStartedInToolsMenu) {
    closePlaylistManager()
  }
}

function handleDocumentKeydown(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape') return
  if (popoverAnchor) {
    closeAddPopover()
    return
  }
  if (managerOpen) {
    closePlaylistManager()
  }
}
