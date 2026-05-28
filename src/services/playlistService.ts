/**
 * Playlist service — CRUD over user-curated dataset sequences,
 * persisted to localStorage. Pure module; no DOM, no network.
 *
 * Storage shape (localStorage key `sos-playlists.v1`):
 *
 *   [
 *     {
 *       "id": "pl-1716832041000",
 *       "name": "My favourites",
 *       "createdAt": "2026-05-27T12:00:00.000Z",
 *       "datasets": [
 *         { "datasetId": "INTERNAL_FOO", "durationSec": 30 },
 *         { "datasetId": "INTERNAL_BAR" }
 *       ]
 *     }
 *   ]
 *
 * Versioned key (`.v1`) so a future schema change can ignore stale
 * values rather than throwing. Sanitisation on load is conservative:
 * anything that doesn't match the expected shape is dropped silently.
 * The user-facing risk of a malformed entry is small (the entry just
 * vanishes); the alternative — surfacing a parse error to the user
 * — would be hostile when the most common cause is them clearing
 * site data or a browser-extension stomping on localStorage.
 *
 * Subscribe via `onPlaylistsChange(cb)` for live updates — the UI
 * panel re-renders on every write and the play-state machine
 * notices the active playlist's entries changing under it.
 *
 * Implementation notes for testing:
 *  - All writes flow through `persist()` which dispatches a single
 *    `CHANGE_EVENT` on the window. `notify()` fires synchronously
 *    so tests can assert state immediately after a write.
 *  - In-memory `playlists` cache is the source of truth between
 *    writes. `loadPlaylists()` returns a deep copy so callers can't
 *    mutate it accidentally. We re-read from localStorage on first
 *    access only — subsequent calls hit the cache.
 *  - The 1 MB size cap (see `IMPORT_MAX_BYTES`) defends import only.
 *    The live write path can technically push past that, but a
 *    user-driven flow that fills a single playlist with 30+ entries
 *    is still well under 100 KB.
 */

import { logger } from '../utils/logger'

/** localStorage key. Versioned to allow future schema migrations. */
export const PLAYLIST_STORAGE_KEY = 'sos-playlists.v1'

/** Default per-entry display duration in seconds when omitted. */
export const DEFAULT_ENTRY_DURATION_SEC = 30

/** Hard cap on incoming import JSON size (bytes). */
export const IMPORT_MAX_BYTES = 1_000_000

/** Maximum length of a playlist name. Longer values are truncated. */
export const PLAYLIST_NAME_MAX_LEN = 120

/** A single dataset within a playlist. */
export interface PlaylistEntry {
  datasetId: string
  /** Display duration in seconds. Omit to fall back to
   *  `DEFAULT_ENTRY_DURATION_SEC`. Ignored when `pauseForInput`
   *  is true — the entry then waits for an explicit skip. */
  durationSec?: number
  /** When true, the playlist pins this entry until the user clicks
   *  the transport's "next in playlist" button. Mirrors the tour
   *  engine's `pauseForInput` semantics for playlists. */
  pauseForInput?: boolean
}

/** A user-curated sequence of datasets. */
export interface Playlist {
  id: string
  name: string
  /** ISO-8601 timestamp set on first create. Not updated on edit. */
  createdAt: string
  datasets: PlaylistEntry[]
  /** When true, end-of-list wraps back to index 0 instead of
   *  stopping. Manual skip-next at the last entry also wraps. */
  loop?: boolean
}

/** Event dispatched on every successful mutation. */
const CHANGE_EVENT = 'sos-playlists:change'

const target: EventTarget =
  typeof window === 'undefined' ? new EventTarget() : window

/** In-memory cache. `null` means "not yet loaded from localStorage". */
let cache: Playlist[] | null = null

/**
 * Validate + coerce a raw value into a `Playlist`. Returns `null`
 * when the value can't be salvaged. Defensive against arbitrary
 * shapes — anything that hits this is either user-supplied (import)
 * or a corrupted localStorage write.
 */
function sanitizePlaylist(raw: unknown): Playlist | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : null
  const name = typeof r.name === 'string' ? r.name.slice(0, PLAYLIST_NAME_MAX_LEN) : null
  const createdAt = typeof r.createdAt === 'string' ? r.createdAt : null
  if (!id || name == null || !createdAt) return null

  const datasetsRaw = Array.isArray(r.datasets) ? r.datasets : []
  const datasets: PlaylistEntry[] = []
  for (const item of datasetsRaw) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    if (typeof it.datasetId !== 'string' || it.datasetId.length === 0) continue
    const entry: PlaylistEntry = { datasetId: it.datasetId }
    if (typeof it.durationSec === 'number' && Number.isFinite(it.durationSec) && it.durationSec > 0) {
      entry.durationSec = it.durationSec
    }
    if (it.pauseForInput === true) entry.pauseForInput = true
    datasets.push(entry)
  }

  const out: Playlist = { id, name, createdAt, datasets }
  if (r.loop === true) out.loop = true
  return out
}

/** Read raw localStorage and coerce to an array of valid Playlists. */
function readFromStorage(): Playlist[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(PLAYLIST_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: Playlist[] = []
    for (const item of parsed) {
      const p = sanitizePlaylist(item)
      if (p) out.push(p)
    }
    return out
  } catch (err) {
    logger.warn('[playlist] Failed to read playlists from localStorage:', err)
    return []
  }
}

/** Best-effort persist; logs and continues on quota / disabled-storage. */
function persist(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(cache ?? []))
  } catch (err) {
    logger.warn('[playlist] Failed to persist playlists:', err)
  }
  notify()
}

function notify(): void {
  target.dispatchEvent(new Event(CHANGE_EVENT))
}

function ensureLoaded(): Playlist[] {
  if (cache == null) cache = readFromStorage()
  return cache
}

/** Return a deep copy of all playlists. Cheap — playlists are tiny. */
export function loadPlaylists(): Playlist[] {
  const list = ensureLoaded()
  return list.map((p) => ({ ...p, datasets: p.datasets.map((e) => ({ ...e })) }))
}

/** Fetch a single playlist by id, or `null` if not found. */
export function getPlaylist(id: string): Playlist | null {
  const list = ensureLoaded()
  const found = list.find((p) => p.id === id)
  if (!found) return null
  return { ...found, datasets: found.datasets.map((e) => ({ ...e })) }
}

/**
 * Create a new playlist with the given name. Trims whitespace,
 * clamps to `PLAYLIST_NAME_MAX_LEN`. Returns the created Playlist.
 */
export function createPlaylist(name: string): Playlist {
  const list = ensureLoaded()
  const trimmed = name.trim().slice(0, PLAYLIST_NAME_MAX_LEN)
  const playlist: Playlist = {
    id: generatePlaylistId(),
    name: trimmed,
    createdAt: new Date().toISOString(),
    datasets: [],
  }
  list.push(playlist)
  persist()
  return { ...playlist, datasets: [] }
}

/**
 * Upsert a playlist by id. Used by import + by rename/reorder
 * operations that build a full new object. Sanitises on write so a
 * caller can't smuggle invalid shapes into the cache.
 */
export function savePlaylist(playlist: Playlist): void {
  const sanitized = sanitizePlaylist(playlist)
  if (!sanitized) {
    logger.warn('[playlist] savePlaylist: invalid shape, ignoring')
    return
  }
  const list = ensureLoaded()
  const idx = list.findIndex((p) => p.id === sanitized.id)
  if (idx === -1) {
    list.push(sanitized)
  } else {
    list[idx] = sanitized
  }
  persist()
}

/** Delete a playlist by id. No-op if not found. */
export function deletePlaylist(id: string): void {
  const list = ensureLoaded()
  const idx = list.findIndex((p) => p.id === id)
  if (idx === -1) return
  list.splice(idx, 1)
  persist()
}

/** Rename a playlist. No-op if not found or the name is empty after trim. */
export function renamePlaylist(id: string, name: string): void {
  const list = ensureLoaded()
  const target = list.find((p) => p.id === id)
  if (!target) return
  const trimmed = name.trim().slice(0, PLAYLIST_NAME_MAX_LEN)
  if (trimmed.length === 0) return
  target.name = trimmed
  persist()
}

/**
 * Append a dataset to a playlist. Idempotent: re-adding an existing
 * datasetId is a no-op (the original entry — including its
 * `durationSec` and `pauseForInput` — is preserved).
 *
 * New entries default to `pauseForInput: true` — the most common
 * playlist authoring intent is "I want to walk through these
 * datasets at my own pace" rather than "auto-advance after 30 s
 * each." The default can still be toggled off in the manager.
 */
export function addToPlaylist(id: string, datasetId: string): void {
  if (!datasetId) return
  const list = ensureLoaded()
  const target = list.find((p) => p.id === id)
  if (!target) return
  if (target.datasets.some((e) => e.datasetId === datasetId)) return
  target.datasets.push({ datasetId, pauseForInput: true })
  persist()
}

/** Remove an entry at the given index. No-op for out-of-range indices. */
export function removeFromPlaylist(id: string, index: number): void {
  const list = ensureLoaded()
  const target = list.find((p) => p.id === id)
  if (!target) return
  if (index < 0 || index >= target.datasets.length) return
  target.datasets.splice(index, 1)
  persist()
}

/**
 * Move an entry from `fromIndex` to `toIndex`. Both indices are
 * clamped to the [0, length-1] range so a drag past the edge
 * doesn't no-op. No-op if the playlist doesn't exist or the move is
 * a self-move.
 */
export function reorderPlaylist(id: string, fromIndex: number, toIndex: number): void {
  const list = ensureLoaded()
  const target = list.find((p) => p.id === id)
  if (!target) return
  const len = target.datasets.length
  if (len < 2) return
  const from = Math.max(0, Math.min(len - 1, fromIndex))
  const to = Math.max(0, Math.min(len - 1, toIndex))
  if (from === to) return
  const [entry] = target.datasets.splice(from, 1)
  target.datasets.splice(to, 0, entry)
  persist()
}

/**
 * Set the per-entry display duration. Passing `undefined` clears the
 * override so the entry falls back to `DEFAULT_ENTRY_DURATION_SEC`.
 * Non-positive or non-finite values are rejected.
 */
export function setEntryDuration(id: string, index: number, durationSec: number | undefined): void {
  const list = ensureLoaded()
  const target = list.find((p) => p.id === id)
  if (!target) return
  if (index < 0 || index >= target.datasets.length) return
  if (durationSec === undefined) {
    delete target.datasets[index].durationSec
  } else if (Number.isFinite(durationSec) && durationSec > 0) {
    target.datasets[index].durationSec = durationSec
  } else {
    return
  }
  persist()
}

/**
 * Effective duration for an entry — `durationSec` when set, else
 * `DEFAULT_ENTRY_DURATION_SEC`.
 */
export function effectiveDuration(entry: PlaylistEntry): number {
  return entry.durationSec ?? DEFAULT_ENTRY_DURATION_SEC
}

/**
 * Toggle the per-entry pause-for-input flag. When true the playlist
 * pins this entry until the user clicks the transport's
 * skip-next button.
 */
export function setEntryPauseForInput(id: string, index: number, value: boolean): void {
  const list = ensureLoaded()
  const target = list.find((p) => p.id === id)
  if (!target) return
  if (index < 0 || index >= target.datasets.length) return
  if (value) {
    target.datasets[index].pauseForInput = true
  } else {
    delete target.datasets[index].pauseForInput
  }
  persist()
}

/** Toggle the playlist-level loop flag. When true, end-of-list
 *  wraps back to index 0 instead of stopping. */
export function setPlaylistLoop(id: string, value: boolean): void {
  const list = ensureLoaded()
  const target = list.find((p) => p.id === id)
  if (!target) return
  if (value) {
    target.loop = true
  } else {
    delete target.loop
  }
  persist()
}

/**
 * Replace all playlists with the supplied array. Used by the
 * import flow. Each item is sanitised; invalid items are skipped.
 * IDs are NOT regenerated — if the imported file collides with an
 * existing playlist id, the imported value wins (last-write).
 *
 * Set `merge: true` to additively merge instead of replace; in that
 * case a colliding id keeps the existing playlist and the imported
 * one is appended under a fresh id.
 */
export function importPlaylists(
  raw: unknown,
  opts: { merge?: boolean } = {},
): { imported: number; skipped: number } {
  if (!Array.isArray(raw)) return { imported: 0, skipped: 0 }
  const sanitized: Playlist[] = []
  let skipped = 0
  for (const item of raw) {
    const p = sanitizePlaylist(item)
    if (p) sanitized.push(p)
    else skipped++
  }
  if (opts.merge) {
    const list = ensureLoaded()
    const existingIds = new Set(list.map((p) => p.id))
    for (const incoming of sanitized) {
      if (existingIds.has(incoming.id)) {
        // Loop to dodge the (unlikely but possible) case where a
        // freshly generated id collides with one we just added —
        // generatePlaylistId mixes 4 hex chars over Date.now(), so
        // back-to-back inserts share the timestamp half.
        let nextId = generatePlaylistId()
        while (existingIds.has(nextId)) nextId = generatePlaylistId()
        existingIds.add(nextId)
        list.push({ ...incoming, id: nextId })
      } else {
        existingIds.add(incoming.id)
        list.push(incoming)
      }
    }
  } else {
    cache = sanitized
  }
  persist()
  return { imported: sanitized.length, skipped }
}

/** Build the JSON blob the export button hands to the browser. */
export function exportPlaylistsJson(): string {
  return JSON.stringify(loadPlaylists(), null, 2)
}

/**
 * Subscribe to playlist-state changes. Returns an unsubscribe
 * callback. Fires synchronously on the same tick as the mutation.
 */
export function onPlaylistsChange(listener: () => void): () => void {
  const handler = () => listener()
  target.addEventListener(CHANGE_EVENT, handler)
  return () => target.removeEventListener(CHANGE_EVENT, handler)
}

/** Stable-ish id generator. Date.now() + 4 random hex chars dodges
 *  the once-per-millisecond collision window. */
function generatePlaylistId(): string {
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return `pl-${Date.now()}-${rand}`
}

/** Test-only — flush the in-memory cache so the next read re-loads
 *  from localStorage. Paired with `localStorage.clear()` in beforeEach. */
export function resetPlaylistsForTests(): void {
  cache = null
}
