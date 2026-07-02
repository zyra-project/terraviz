/**
 * Client for the public approved-events list (`GET /api/v1/events`) — the
 * data behind the catalog Map / Timeline event overlays
 * (`docs/CURRENT_EVENTS_PLAN.md` §6.3).
 *
 * Mirrors `heroService`'s featured-event fetch: a plain `fetch` off
 * `BASE_URL`, a 60 s in-memory cache (matching the endpoint's KV TTL), and
 * a sanitize step that drops any event whose `source.url` isn't http(s)
 * (the views render it as a clickable link, so this blocks a
 * `javascript:`/`data:` XSS vector — defense-in-depth; the backend also
 * validates on ingest). Degrades to `[]` on any failure so the catalog
 * never breaks.
 */

import { logger } from '../utils/logger'

/** In-memory cache lifetime — matches the endpoint's 60 s KV TTL. */
export const EVENTS_LIST_CACHE_MS = 60 * 1000

export interface EventGeometry {
  boundingBox?: { n: number; s: number; w: number; e: number }
  point?: { lat: number; lon: number }
  regionName?: string
}

/** One approved event as the catalog overlays consume it. */
export interface PublicEvent {
  id: string
  title: string
  summary?: string
  source: { name: string; url: string; publishedAt?: string }
  occurredStart?: string
  occurredEnd?: string
  geometry: EventGeometry
  datasetIds: string[]
}

let cache: { value: PublicEvent[]; fetchedAt: number } = { value: [], fetchedAt: 0 }

function eventsUrl(): string {
  const base = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL ? import.meta.env.BASE_URL : '/'
  return `${base}api/v1/events`
}

/** True for an http(s) URL — see module header. */
function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function asGeometry(raw: unknown): EventGeometry {
  const g: EventGeometry = {}
  if (!raw || typeof raw !== 'object') return g
  const r = raw as Record<string, unknown>
  const bb = r.boundingBox
  if (bb && typeof bb === 'object') {
    const b = bb as Record<string, unknown>
    const { n, s, w, e } = b
    if (typeof n === 'number' && typeof s === 'number' && typeof w === 'number' && typeof e === 'number') {
      g.boundingBox = { n, s, w, e }
    }
  }
  const pt = r.point
  if (pt && typeof pt === 'object') {
    const p = pt as Record<string, unknown>
    if (typeof p.lat === 'number' && typeof p.lon === 'number') g.point = { lat: p.lat, lon: p.lon }
  }
  if (typeof r.regionName === 'string' && r.regionName.length > 0) g.regionName = r.regionName
  return g
}

/** Validate + coerce one raw event, or null when it's unusable (bad
 *  source url, missing title/id, no dataset ids). Exported for testing. */
export function sanitizePublicEvent(raw: unknown): PublicEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (typeof r.title !== 'string' || r.title.length === 0) return null
  const s = r.source
  if (!s || typeof s !== 'object') return null
  const src = s as Record<string, unknown>
  if (typeof src.name !== 'string' || typeof src.url !== 'string') return null
  if (!isHttpUrl(src.url)) return null
  const datasetIds = Array.isArray(r.datasetIds)
    ? r.datasetIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : []
  if (datasetIds.length === 0) return null // nothing to click through to

  const out: PublicEvent = {
    id: r.id,
    title: r.title,
    source: { name: src.name, url: src.url },
    geometry: asGeometry(r.geometry),
    datasetIds,
  }
  if (typeof r.summary === 'string' && r.summary.length > 0) out.summary = r.summary
  if (typeof src.publishedAt === 'string' && src.publishedAt.length > 0) out.source.publishedAt = src.publishedAt
  if (typeof r.occurredStart === 'string' && r.occurredStart.length > 0) out.occurredStart = r.occurredStart
  if (typeof r.occurredEnd === 'string' && r.occurredEnd.length > 0) out.occurredEnd = r.occurredEnd
  return out
}

/** Reset the in-memory cache (tests only). */
export function resetEventsCacheForTests(): void {
  cache = { value: [], fetchedAt: 0 }
}

/**
 * Fetch + cache the approved current events. Returns `[]` on any
 * non-success (empty list, 503, network error, malformed body) so the
 * catalog views simply render no overlay rather than breaking.
 */
export async function fetchApprovedEvents(signal?: AbortSignal): Promise<PublicEvent[]> {
  const fresh = Date.now() - cache.fetchedAt < EVENTS_LIST_CACHE_MS
  if (fresh && cache.fetchedAt !== 0) return cache.value
  try {
    const res = await fetch(eventsUrl(), { signal })
    if (!res.ok) {
      cache = { value: [], fetchedAt: Date.now() }
      return []
    }
    const parsed = (await res.json()) as { events?: unknown }
    const list = Array.isArray(parsed?.events) ? parsed.events : []
    const value = list.map(sanitizePublicEvent).filter((e): e is PublicEvent => e !== null)
    cache = { value, fetchedAt: Date.now() }
    return value
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AbortError') {
      logger.warn('[events] Failed to fetch /api/v1/events:', err)
      cache = { value: [], fetchedAt: Date.now() }
    }
    return []
  }
}

/** Per-dataset "In the news" cache — keyed by dataset id, 60 s TTL. */
const perDatasetCache = new Map<string, { value: PublicEvent[]; fetchedAt: number }>()

function datasetEventsUrl(datasetId: string): string {
  const base = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL ? import.meta.env.BASE_URL : '/'
  return `${base}api/v1/datasets/${encodeURIComponent(datasetId)}/events`
}

/** Reset the per-dataset cache (tests only). */
export function resetDatasetEventsCacheForTests(): void {
  perDatasetCache.clear()
}

/**
 * Fetch + cache the approved current events that relate to one dataset
 * (`GET /api/v1/datasets/:id/events`) — the info panel's "In the news"
 * section. Same sanitize + degrade-to-`[]` contract as
 * {@link fetchApprovedEvents}; a per-dataset 60 s in-memory cache so
 * reopening the same dataset doesn't refetch.
 */
export async function fetchEventsForDataset(datasetId: string, signal?: AbortSignal): Promise<PublicEvent[]> {
  const cached = perDatasetCache.get(datasetId)
  if (cached && Date.now() - cached.fetchedAt < EVENTS_LIST_CACHE_MS) return cached.value
  try {
    const res = await fetch(datasetEventsUrl(datasetId), { signal })
    if (!res.ok) {
      perDatasetCache.set(datasetId, { value: [], fetchedAt: Date.now() })
      return []
    }
    const parsed = (await res.json()) as { events?: unknown }
    const list = Array.isArray(parsed?.events) ? parsed.events : []
    const value = list.map(sanitizePublicEvent).filter((e): e is PublicEvent => e !== null)
    perDatasetCache.set(datasetId, { value, fetchedAt: Date.now() })
    return value
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AbortError') {
      logger.warn('[events] Failed to fetch dataset events:', err)
      perDatasetCache.set(datasetId, { value: [], fetchedAt: Date.now() })
    }
    return []
  }
}
