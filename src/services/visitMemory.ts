/**
 * Visit memory — a local-only log of which datasets the user has
 * opened, persisted to localStorage. Powers the "Continue exploring"
 * row, the "new since your last visit" badge, and the Recently-viewed
 * facet chip (Phase 7 §9.2 of `docs/WEB_CATALOG_FEATURES_PLAN.md`).
 *
 * PRIVACY: this data never leaves the device. There is no telemetry
 * echo, no server sync, no federation. Clearing site data removes it.
 * The privacy boundary is a hard requirement of the feature — see
 * `docs/PRIVACY.md` and the Tools → Privacy panel.
 *
 * Storage shape:
 *
 *   localStorage `terraviz.visits.v1`:
 *     { "<datasetId>": { firstVisit, lastVisit, viewSeconds }, … }
 *
 *   localStorage `terraviz.lastSession`:
 *     "2026-05-28T12:00:00.000Z"   // ISO timestamp of prior session end
 *
 * Versioned key (`.v1`) so a future schema change drops and re-creates
 * rather than migrating — these are convenience caches, not load-bearing
 * state. `lastSession` is intentionally un-versioned (it's a single
 * timestamp; a shape change can just ignore a non-ISO value).
 *
 * Mirrors `playlistService.ts`'s idioms: an in-memory cache that is the
 * source of truth between writes, conservative sanitisation on load
 * (anything malformed is dropped silently), best-effort persistence that
 * survives a throwing/quota-full localStorage, and an `onVisitsChange`
 * listener that fires synchronously on every mutation so the UI can
 * re-render immediately.
 *
 * LRU bound: at most {@link VISITS_LRU_CAP} entries. A new entry that
 * would exceed the cap evicts the least-recently-touched (oldest
 * `lastVisit`) entries first.
 */

import { logger } from '../utils/logger'
import type { Dataset } from '../types'

/** localStorage key for the per-dataset visit log. Versioned. */
export const VISITS_STORAGE_KEY = 'terraviz.visits.v1'

/** localStorage key for the previous session-end timestamp. */
export const LAST_SESSION_STORAGE_KEY = 'terraviz.lastSession'

/** Hard cap on stored visit entries to bound localStorage growth. */
export const VISITS_LRU_CAP = 200

/** A single dataset's visit record. Timestamps are ISO-8601 strings. */
export interface VisitEntry {
  /** ISO timestamp of the first time this dataset's info panel opened. */
  firstVisit: string
  /** ISO timestamp of the most recent open. Drives recency ordering
   *  and LRU eviction. */
  lastVisit: string
  /** Total visible reading time accrued across every session, in
   *  seconds. May be fractional — durations come from the dwell
   *  handle's millisecond `elapsed()` divided by 1000, and are
   *  summed rather than rounded per-add so repeated short reads
   *  don't lose precision to rounding. Consumers that want a whole
   *  number should round at the point of display. */
  viewSeconds: number
}

/** The whole visit log, keyed by dataset id. */
export type VisitMap = Record<string, VisitEntry>

/** Event dispatched on every successful mutation. */
const CHANGE_EVENT = 'terraviz-visits:change'

const target: EventTarget =
  typeof window === 'undefined' ? new EventTarget() : window

/** In-memory cache. `null` means "not yet loaded from localStorage". */
let cache: VisitMap | null = null

/**
 * Validate + coerce a raw value into a {@link VisitEntry}. Returns
 * `null` when the value can't be salvaged. Defensive against arbitrary
 * shapes — anything that hits this is a corrupted localStorage write.
 */
function sanitizeEntry(raw: unknown): VisitEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const firstVisit = typeof r.firstVisit === 'string' && r.firstVisit.length > 0 ? r.firstVisit : null
  const lastVisit = typeof r.lastVisit === 'string' && r.lastVisit.length > 0 ? r.lastVisit : null
  if (!firstVisit || !lastVisit) return null
  const viewSeconds =
    typeof r.viewSeconds === 'number' && Number.isFinite(r.viewSeconds) && r.viewSeconds >= 0
      ? r.viewSeconds
      : 0
  return { firstVisit, lastVisit, viewSeconds }
}

/** Read raw localStorage and coerce to a valid VisitMap. */
function readFromStorage(): VisitMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(VISITS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: VisitMap = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!id) continue
      const entry = sanitizeEntry(value)
      if (entry) out[id] = entry
    }
    return out
  } catch (err) {
    logger.warn('[visits] Failed to read visit memory from localStorage:', err)
    return {}
  }
}

/** Best-effort persist; logs and continues on quota / disabled-storage. */
function persist(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(VISITS_STORAGE_KEY, JSON.stringify(cache ?? {}))
  } catch (err) {
    logger.warn('[visits] Failed to persist visit memory:', err)
  }
  notify()
}

function notify(): void {
  target.dispatchEvent(new Event(CHANGE_EVENT))
}

function ensureLoaded(): VisitMap {
  if (cache == null) cache = readFromStorage()
  return cache
}

/**
 * Evict least-recently-touched entries until the map is within the
 * LRU cap. Eviction orders by `lastVisit` ascending (oldest first).
 * Mutates the supplied map in place.
 */
function enforceLruCap(map: VisitMap): void {
  const ids = Object.keys(map)
  if (ids.length <= VISITS_LRU_CAP) return
  ids.sort((a, b) => map[a].lastVisit.localeCompare(map[b].lastVisit))
  const overflow = ids.length - VISITS_LRU_CAP
  for (let i = 0; i < overflow; i++) {
    delete map[ids[i]]
  }
}

/**
 * Record a visit to `datasetId`. Sets `firstVisit` on the first call,
 * bumps `lastVisit` to now on every call, and leaves `viewSeconds`
 * untouched (that accumulates separately via {@link addViewSeconds}).
 * No-op for an empty id. Enforces the LRU cap after insertion.
 */
export function recordVisit(datasetId: string): void {
  if (!datasetId) return
  const map = ensureLoaded()
  const now = new Date().toISOString()
  const existing = map[datasetId]
  if (existing) {
    existing.lastVisit = now
  } else {
    map[datasetId] = { firstVisit: now, lastVisit: now, viewSeconds: 0 }
  }
  enforceLruCap(map)
  persist()
}

/**
 * Add `seconds` of visible reading time to `datasetId`'s running
 * total. Accumulates across sessions. Creates the entry if the dataset
 * hasn't been recorded yet (defensive — the panel-open path normally
 * calls {@link recordVisit} first). Bumps `lastVisit` so a long read
 * keeps the entry fresh against the LRU. Non-positive or non-finite
 * durations are ignored.
 */
export function addViewSeconds(datasetId: string, seconds: number): void {
  if (!datasetId) return
  if (!Number.isFinite(seconds) || seconds <= 0) return
  const map = ensureLoaded()
  const now = new Date().toISOString()
  const existing = map[datasetId]
  if (existing) {
    existing.viewSeconds += seconds
    existing.lastVisit = now
  } else {
    map[datasetId] = { firstVisit: now, lastVisit: now, viewSeconds: seconds }
  }
  enforceLruCap(map)
  persist()
}

/** Return a deep copy of the whole visit log. */
export function loadVisits(): VisitMap {
  const map = ensureLoaded()
  const out: VisitMap = {}
  for (const [id, entry] of Object.entries(map)) out[id] = { ...entry }
  return out
}

/** The set of dataset ids the user has visited. Used by the
 *  Recently-viewed facet predicate. */
export function getVisitedIds(): Set<string> {
  return new Set(Object.keys(ensureLoaded()))
}

/**
 * The `n` most-recently-visited dataset ids, newest first. Returns
 * fewer than `n` when the log is smaller. `n` defaults to 3 (the
 * Continue-exploring row's cap).
 */
export function getRecent(n = 3): string[] {
  const map = ensureLoaded()
  return Object.keys(map)
    .sort((a, b) => map[b].lastVisit.localeCompare(map[a].lastVisit))
    .slice(0, Math.max(0, n))
}

/**
 * Count catalog entries added since `since` (an ISO timestamp, or
 * `null`). Fail-closed: a dataset with no parseable `enriched.dateAdded`
 * never counts, and a `null`/unparseable `since` yields 0 (a first-ever
 * visitor has no "last visit" to measure against, so nothing is "new").
 * Hidden datasets are excluded to match the browse surface.
 */
export function countNewSince(datasets: readonly Dataset[], since: string | null): number {
  if (!since) return 0
  const sinceMs = Date.parse(since)
  if (!Number.isFinite(sinceMs)) return 0
  let count = 0
  for (const d of datasets) {
    if (d.isHidden) continue
    const added = d.enriched?.dateAdded
    if (!added) continue
    const addedMs = Date.parse(added)
    if (!Number.isFinite(addedMs)) continue
    if (addedMs > sinceMs) count++
  }
  return count
}

/**
 * Read the previous session-end timestamp, or `null` if none is
 * stored / the stored value isn't a parseable ISO date. Consumed by
 * the new-since badge (§9.2) and the returning-user Orbit greeting
 * trigger (§9.3).
 */
export function getLastSession(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LAST_SESSION_STORAGE_KEY)
    if (!raw) return null
    return Number.isFinite(Date.parse(raw)) ? raw : null
  } catch (err) {
    logger.warn('[visits] Failed to read lastSession from localStorage:', err)
    return null
  }
}

/**
 * Write the session-end timestamp. Called from the pagehide handler in
 * `main.ts` alongside the analytics flush — a synchronous localStorage
 * write, which is permitted from `pagehide` (unlike `sendBeacon`).
 * Defaults to now; accepts an explicit ISO string for tests.
 * Best-effort: a throwing localStorage is swallowed.
 */
export function writeLastSession(iso: string = new Date().toISOString()): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, iso)
  } catch (err) {
    logger.warn('[visits] Failed to persist lastSession:', err)
  }
}

/**
 * Subscribe to visit-log changes. Returns an unsubscribe callback.
 * Fires synchronously on the same tick as the mutation.
 */
export function onVisitsChange(listener: () => void): () => void {
  const handler = () => listener()
  target.addEventListener(CHANGE_EVENT, handler)
  return () => target.removeEventListener(CHANGE_EVENT, handler)
}

/** Test-only — flush the in-memory cache so the next read re-loads
 *  from localStorage. Paired with `localStorage.clear()` in beforeEach. */
export function resetVisitsForTests(): void {
  cache = null
}
