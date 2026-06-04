/**
 * Hero service — picks the single "Right now" hero candidate for the
 * catalog landing surface (Phase 7 §9.1 of
 * `docs/WEB_CATALOG_FEATURES_PLAN.md`).
 *
 * Selection pipeline, highest priority first:
 *
 *   1. Curator override — a valid, in-window entry in the static
 *      `public/featured-now.json` file whose `datasetId` resolves to
 *      a visible catalog row.
 *   2. Auto-derived — a real-time-tagged dataset whose `endTime` is
 *      within the last 24 h (the freshest one wins).
 *   3. null — nothing newsworthy. The panel hides entirely; the
 *      catalog never performs liveliness it doesn't have.
 *
 * The override file's `window: { start, end }` is MANDATORY. An
 * override with no window (or a malformed / expired / not-yet-active
 * window) is ignored and the pipeline falls through to auto-derived.
 * This is deliberate: operators must set an end date so a pinned hero
 * can't silently go stale. The file is a plain static asset updated
 * via PR — there is no CMS, admin endpoint, or KV binding.
 *
 * Pure-ish module: no DOM, no analytics, no localStorage. The only
 * side effect is a polite fetch of the override file, cached in-memory
 * for {@link OVERRIDE_CACHE_MS}.
 */

import type { Dataset } from '../types'
import { logger } from '../utils/logger'

/** How long an auto-derived real-time dataset stays "live" after its
 *  `endTime` (24 h, per the plan's auto-derive rule). */
export const AUTO_DERIVE_WINDOW_MS = 24 * 60 * 60 * 1000

/** In-memory cache lifetime for `featured-now.json`. Polite — the
 *  file changes at most a few times a week, so a 5-minute cache keeps
 *  catalog opens cheap without serving a stale override for long. */
export const OVERRIDE_CACHE_MS = 5 * 60 * 1000

/** In-memory cache lifetime for the backend hero endpoint. Shorter
 *  than the static-file cache (60 s vs 5 min) because the whole point
 *  of the admin store is a seconds-not-minutes "Right now" loop —
 *  matches the endpoint's own KV TTL. */
export const BACKEND_CACHE_MS = 60 * 1000

/** The `Real-Time` tag that flags a dataset as auto-derive-eligible. */
export const REAL_TIME_TAG = 'Real-Time'

/** Where the curator override lives. Resolved against the app's base
 *  URL so a sub-path deploy still finds it. */
function overrideUrl(): string {
  const base = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
    ? import.meta.env.BASE_URL
    : '/'
  return `${base}featured-now.json`
}

/** The publisher-backend hero endpoint (Phase A of the hero-admin
 *  track). Operator-writable; read first, with the static file as the
 *  fallback floor for static-only deploys. */
function backendUrl(): string {
  const base = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
    ? import.meta.env.BASE_URL
    : '/'
  return `${base}api/v1/featured-hero`
}

/** The mandatory activation window on a curator override. */
export interface HeroWindow {
  /** ISO-8601 timestamp — the override is inert before this. */
  start: string
  /** ISO-8601 timestamp — the override expires after this. */
  end: string
}

/** Shape of `public/featured-now.json` when an override is set. */
export interface HeroOverride {
  datasetId: string
  window: HeroWindow
  /** Optional curator headline shown instead of the dataset title. */
  headline?: string
}

/** The resolved hero, ready for the UI to render. */
export interface HeroCandidate {
  dataset: Dataset
  /** Curator headline (override only); UI falls back to the title. */
  headline?: string
  /** How this candidate was chosen — for the UI's accent + analytics
   *  in a future v2 (no telemetry in v1). */
  source: 'override' | 'auto'
}

/** In-memory override cache. `fetchedAt = 0` means "never fetched". */
let overrideCache: { value: HeroOverride | null; fetchedAt: number } = {
  value: null,
  fetchedAt: 0,
}

/** In-memory cache for the backend hero endpoint. Separate from the
 *  static-file cache (shorter TTL). */
let backendCache: { value: HeroOverride | null; fetchedAt: number } = {
  value: null,
  fetchedAt: 0,
}

/**
 * Resolve the hero candidate for `datasets`. Returns null when
 * nothing qualifies (the UI hides the panel). `now` is injectable
 * for tests; defaults to the wall clock.
 *
 * Override resolution is **backend-first, static-file-fallback**: the
 * operator-writable `/api/v1/featured-hero` endpoint is consulted
 * first, and only when it has no override (or is unreachable / not
 * deployed) does the static `featured-now.json` apply. The endpoint is
 * authoritative when it has a pin — the file is a floor for
 * static-only deploys, not a second curation layer to merge.
 *
 * Every fetch is best-effort — a missing/malformed source falls
 * through to the next, so a deploy without the backend (or without
 * the file) degrades to the auto pipeline instead of breaking the
 * catalog.
 */
export async function getHeroCandidate(
  datasets: readonly Dataset[],
  opts: { now?: number; signal?: AbortSignal } = {},
): Promise<HeroCandidate | null> {
  const now = opts.now ?? Date.now()

  const override =
    (await fetchBackendOverride(opts.signal)) ?? (await fetchOverride(opts.signal))
  if (override) {
    const inWindow = windowIsActive(override.window, now)
    if (inWindow) {
      const dataset = datasets.find(d => d.id === override.datasetId && !d.isHidden)
      if (dataset) {
        return { dataset, headline: override.headline, source: 'override' }
      }
      // A configured override that points at a missing/hidden row is a
      // curator error — log it but don't let it suppress the auto pick.
      logger.warn('[hero] featured-now override datasetId did not resolve:', override.datasetId)
    }
  }

  const auto = pickAutoDerived(datasets, now)
  return auto ? { dataset: auto, source: 'auto' } : null
}

/**
 * Auto-derive: the freshest real-time dataset whose `endTime` is
 * within the last {@link AUTO_DERIVE_WINDOW_MS}. Hidden rows and rows
 * without a parseable `endTime` are skipped. Exported for testing.
 */
export function pickAutoDerived(datasets: readonly Dataset[], now: number): Dataset | null {
  let best: Dataset | null = null
  let bestEnd = -Infinity
  for (const d of datasets) {
    if (d.isHidden) continue
    if (!(d.tags ?? []).includes(REAL_TIME_TAG)) continue
    const end = d.endTime ? Date.parse(d.endTime) : NaN
    if (!Number.isFinite(end)) continue
    if (end <= now - AUTO_DERIVE_WINDOW_MS) continue // older than 24 h
    if (end > bestEnd) {
      best = d
      bestEnd = end
    }
  }
  return best
}

/** True when `now` falls inside `[start, end]`. Both bounds must be
 *  present and parseable — a half-specified window is treated as
 *  inactive (fail-closed), so a curator typo can't pin a hero
 *  indefinitely. Exported for testing. */
export function windowIsActive(window: HeroWindow | undefined, now: number): boolean {
  if (!window) return false
  const start = Date.parse(window.start)
  const end = Date.parse(window.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  return now >= start && now <= end
}

/** Validate + coerce a raw parsed JSON value into a {@link HeroOverride},
 *  or null when it isn't a usable override (including the empty stub
 *  `{}`). The mandatory `window.start` / `window.end` strings are the
 *  gate. Exported for testing. */
export function sanitizeOverride(raw: unknown): HeroOverride | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.datasetId !== 'string' || r.datasetId.length === 0) return null
  const w = r.window
  if (!w || typeof w !== 'object') return null
  const win = w as Record<string, unknown>
  if (typeof win.start !== 'string' || typeof win.end !== 'string') return null
  const out: HeroOverride = {
    datasetId: r.datasetId,
    window: { start: win.start, end: win.end },
  }
  if (typeof r.headline === 'string' && r.headline.length > 0) out.headline = r.headline
  return out
}

/** Fetch + cache the override file. Returns null on any failure
 *  (missing file, network error, malformed JSON, empty stub). */
async function fetchOverride(signal?: AbortSignal): Promise<HeroOverride | null> {
  const fresh = Date.now() - overrideCache.fetchedAt < OVERRIDE_CACHE_MS
  if (fresh && overrideCache.fetchedAt !== 0) return overrideCache.value
  try {
    const res = await fetch(overrideUrl(), { signal })
    if (!res.ok) {
      overrideCache = { value: null, fetchedAt: Date.now() }
      return null
    }
    const parsed: unknown = await res.json()
    const value = sanitizeOverride(parsed)
    overrideCache = { value, fetchedAt: Date.now() }
    return value
  } catch (err) {
    // AbortError is expected when the catalog closes mid-fetch — don't
    // poison the cache with it, just bail.
    if ((err as { name?: string })?.name !== 'AbortError') {
      logger.warn('[hero] Failed to fetch featured-now.json:', err)
      overrideCache = { value: null, fetchedAt: Date.now() }
    }
    return null
  }
}

/**
 * Fetch + cache the backend hero override. Returns null on any
 * non-success (no pin set, missing `CATALOG_DB` → 503, network error,
 * malformed body) so the caller falls through to the static file. The
 * endpoint returns `{ hero: { datasetId, window, headline? } | null }`;
 * the raw override is re-sanitised here defensively.
 */
async function fetchBackendOverride(signal?: AbortSignal): Promise<HeroOverride | null> {
  const fresh = Date.now() - backendCache.fetchedAt < BACKEND_CACHE_MS
  if (fresh && backendCache.fetchedAt !== 0) return backendCache.value
  try {
    const res = await fetch(backendUrl(), { signal })
    if (!res.ok) {
      backendCache = { value: null, fetchedAt: Date.now() }
      return null
    }
    const parsed = (await res.json()) as { hero?: unknown }
    const value = sanitizeOverride(parsed?.hero)
    backendCache = { value, fetchedAt: Date.now() }
    return value
  } catch (err) {
    // AbortError is expected when the catalog closes mid-fetch — don't
    // poison the cache with it, just bail.
    if ((err as { name?: string })?.name !== 'AbortError') {
      logger.warn('[hero] Failed to fetch /api/v1/featured-hero:', err)
      backendCache = { value: null, fetchedAt: Date.now() }
    }
    return null
  }
}

/** Test-only — clear both override caches so the next call re-fetches. */
export function resetHeroCacheForTests(): void {
  overrideCache = { value: null, fetchedAt: 0 }
  backendCache = { value: null, fetchedAt: 0 }
}
