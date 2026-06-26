/**
 * `current_events` + `event_dataset_links` data access.
 *
 * The storage layer for the Current Events ↔ Real-Time Data feature
 * (see `docs/CURRENT_EVENTS_PLAN.md` and
 * `migrations/catalog/0024_current_events.sql`). A current event is a
 * reputable, cited record — news / authoritative-org reporting — that
 * *annotates* the datasets it relates to; `event_dataset_links` holds
 * the proposed/approved links to those datasets.
 *
 * SOURCE-AGNOSTIC. This module makes no assumption about where events
 * come from: a row carries generic provenance (`source_name` /
 * `source_url` / `published_at`) plus a `feed_id` discriminator naming
 * whichever connector produced it (null for a manually-entered event).
 * Which feed — if any — a node ingests is a separate, node-configurable
 * decision made by the (later) ingestion slice; relevance always
 * derives from matching events against *this node's* own catalog.
 *
 * Pure data access, mirroring `hero-override-store.ts` /
 * `catalog-store.ts`: the curator gate (`status`) and window/freshness
 * evaluation live in the route/application layer, not here. Inputs are
 * assumed already validated by their callers; this module mints ids +
 * timestamps and persists rows. No KV/cache/route wiring — that arrives
 * with the public read route in a later slice.
 */

import { newUlid } from './ulid'

/** KV key the public `GET /api/v1/featured-event` caches under. Shared
 *  with the review route so an approve/reject can bust it for immediate
 *  effect (the 60 s TTL is the backstop). */
export const FEATURED_EVENT_CACHE_KEY = 'featured-event:v1'

/** KV key the public `GET /api/v1/events` list caches under (the catalog
 *  Map/Timeline overlays). Busted alongside the featured-event key. */
export const EVENTS_LIST_CACHE_KEY = 'events-list:v1'

/** How recent an approved event must be to headline the hero — by its
 *  published / occurred date. Keeps the "Right now" surface honest:
 *  a curator-approved event ages out rather than lingering as "now". */
export const FEATURED_EVENT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** Best-effort bust of the public event caches (hero + catalog list)
 *  after a review changes event/link status. Swallows errors — a missed
 *  bust just waits out the TTL. */
export async function bustFeaturedEventCache(kv: KVNamespace | undefined): Promise<void> {
  if (!kv) return
  try {
    await kv.delete(FEATURED_EVENT_CACHE_KEY)
    await kv.delete(EVENTS_LIST_CACHE_KEY)
  } catch {
    // TTL is the backstop.
  }
}

/** Curator-gated lifecycle of a current event. Only `approved` events
 *  are ever surfaced to end-users. */
export type CurrentEventStatus = 'proposed' | 'approved' | 'rejected' | 'expired'

/** Per-link lifecycle. A link is `approved` independently of its event
 *  so a curator can accept some dataset matches and reject others. */
export type EventLinkStatus = 'proposed' | 'approved' | 'rejected'

/** A NSWE bounding box in degrees — same convention as
 *  `Dataset.boundingBox` / the `datasets.bbox_*` columns. */
export interface EventBoundingBox {
  n: number
  s: number
  w: number
  e: number
}

/** Event geometry. Any subset may be present; the matcher decides how
 *  to use them. */
export interface EventGeometry {
  boundingBox?: EventBoundingBox
  point?: { lat: number; lon: number }
  regionName?: string
}

/** The `current_events` row as stored (snake_case). */
export interface CurrentEventRow {
  id: string
  origin_node: string
  title: string
  summary: string | null
  source_name: string
  source_url: string
  published_at: string | null
  feed_id: string | null
  external_id: string | null
  occurred_start: string | null
  occurred_end: string | null
  bbox_n: number | null
  bbox_s: number | null
  bbox_w: number | null
  bbox_e: number | null
  point_lat: number | null
  point_lon: number | null
  region_name: string | null
  status: CurrentEventStatus
  created_at: string
  updated_at: string
  reviewed_at: string | null
  reviewed_by: string | null
}

/** The `event_dataset_links` row as stored (snake_case). */
export interface EventDatasetLinkRow {
  event_id: string
  dataset_id: string
  match_score: number | null
  signals_json: string | null
  status: EventLinkStatus
  created_at: string
  approved_at: string | null
  approved_by: string | null
}

/** Per-event decoration vocabulary. `categories` collapses to a
 *  per-facet array, matching the dataset wire shape. */
export interface EventDecorations {
  categories: Record<string, string[]>
  keywords: string[]
}

/** The public (camelCase) event shape consumers will read. */
export interface CurrentEventPublic {
  id: string
  originNode: string
  title: string
  summary?: string
  source: { name: string; url: string; publishedAt?: string }
  feedId?: string
  occurredStart?: string
  occurredEnd?: string
  geometry: EventGeometry
  categories: Record<string, string[]>
  keywords: string[]
  status: CurrentEventStatus
  createdAt: string
  updatedAt: string
  reviewedAt?: string
  reviewedBy?: string
}

/** Fields a caller supplies to {@link insertCurrentEvent}. The store
 *  mints `id`, `created_at`, `updated_at`, and defaults `status`. */
export interface NewCurrentEvent {
  originNode: string
  title: string
  summary?: string | null
  sourceName: string
  sourceUrl: string
  publishedAt?: string | null
  feedId?: string | null
  /** The feed item's stable id; with `feedId`, the dedupe key. */
  externalId?: string | null
  occurredStart?: string | null
  occurredEnd?: string | null
  geometry?: EventGeometry
  categories?: Record<string, string[]>
  keywords?: string[]
  /** Initial status; defaults to `proposed` (the ingestion path). */
  status?: CurrentEventStatus
}

/** Fields a caller supplies to {@link upsertEventDatasetLink}. */
export interface NewEventDatasetLink {
  eventId: string
  datasetId: string
  matchScore?: number | null
  /** The per-signal breakdown ({ geo, temporal, semantic }); serialized
   *  to `signals_json`. */
  signals?: unknown
  status?: EventLinkStatus
}

const EVENT_COLUMNS = `id, origin_node, title, summary, source_name, source_url,
  published_at, feed_id, external_id, occurred_start, occurred_end,
  bbox_n, bbox_s, bbox_w, bbox_e, point_lat, point_lon, region_name,
  status, created_at, updated_at, reviewed_at, reviewed_by`

const LINK_COLUMNS = `event_id, dataset_id, match_score, signals_json,
  status, created_at, approved_at, approved_by`

/** Max bind variables per chunked `IN (…)` query — mirrors
 *  `catalog-store.ts`'s `D1_BIND_BATCH`. */
const EVENT_BIND_BATCH = 80

/**
 * Insert a new current event (plus its category/keyword decorations).
 * Mints a ULID and the created/updated timestamps; defaults `status` to
 * `proposed`. Returns the stored row.
 */
export async function insertCurrentEvent(
  db: D1Database,
  input: NewCurrentEvent,
  now: string = new Date().toISOString(),
): Promise<CurrentEventRow> {
  const id = newUlid()
  const bbox = input.geometry?.boundingBox
  const point = input.geometry?.point
  const row: CurrentEventRow = {
    id,
    origin_node: input.originNode,
    title: input.title,
    summary: input.summary ?? null,
    source_name: input.sourceName,
    source_url: input.sourceUrl,
    published_at: input.publishedAt ?? null,
    feed_id: input.feedId ?? null,
    external_id: input.externalId ?? null,
    occurred_start: input.occurredStart ?? null,
    occurred_end: input.occurredEnd ?? null,
    bbox_n: bbox?.n ?? null,
    bbox_s: bbox?.s ?? null,
    bbox_w: bbox?.w ?? null,
    bbox_e: bbox?.e ?? null,
    point_lat: point?.lat ?? null,
    point_lon: point?.lon ?? null,
    region_name: input.geometry?.regionName ?? null,
    status: input.status ?? 'proposed',
    created_at: now,
    updated_at: now,
    reviewed_at: null,
    reviewed_by: null,
  }

  await db
    .prepare(
      `INSERT INTO current_events (${EVENT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.origin_node,
      row.title,
      row.summary,
      row.source_name,
      row.source_url,
      row.published_at,
      row.feed_id,
      row.external_id,
      row.occurred_start,
      row.occurred_end,
      row.bbox_n,
      row.bbox_s,
      row.bbox_w,
      row.bbox_e,
      row.point_lat,
      row.point_lon,
      row.region_name,
      row.status,
      row.created_at,
      row.updated_at,
      row.reviewed_at,
      row.reviewed_by,
    )
    .run()

  await writeEventDecorations(db, id, input.categories, input.keywords)
  return row
}

/** Insert the category/keyword decoration rows for an event. */
async function writeEventDecorations(
  db: D1Database,
  eventId: string,
  categories: Record<string, string[]> | undefined,
  keywords: string[] | undefined,
): Promise<void> {
  for (const [facet, values] of Object.entries(categories ?? {})) {
    for (const value of values) {
      await db
        .prepare(`INSERT INTO event_categories (event_id, facet, value) VALUES (?, ?, ?)`)
        .bind(eventId, facet, value)
        .run()
    }
  }
  for (const keyword of keywords ?? []) {
    await db
      .prepare(`INSERT INTO event_keywords (event_id, keyword) VALUES (?, ?)`)
      .bind(eventId, keyword)
      .run()
  }
}

/** Fetch a single event by id, or null when absent. */
export async function getCurrentEvent(
  db: D1Database,
  id: string,
): Promise<CurrentEventRow | null> {
  const row = await db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM current_events WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<CurrentEventRow>()
  return row ?? null
}

/** Find an ingested event by its feed dedupe key, or null. */
export async function findEventByExternal(
  db: D1Database,
  feedId: string,
  externalId: string,
): Promise<CurrentEventRow | null> {
  const row = await db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM current_events WHERE feed_id = ? AND external_id = ? LIMIT 1`)
    .bind(feedId, externalId)
    .first<CurrentEventRow>()
  return row ?? null
}

/**
 * Refresh a previously-ingested event's content (title / summary /
 * provenance / time / geometry / decorations) without touching its
 * curator status, review audit, or dedupe key. Lets a feed re-run
 * update an open event without resurrecting a rejected one.
 */
export async function updateCurrentEventContent(
  db: D1Database,
  id: string,
  input: NewCurrentEvent,
  now: string = new Date().toISOString(),
): Promise<void> {
  const bbox = input.geometry?.boundingBox
  const point = input.geometry?.point
  await db
    .prepare(
      `UPDATE current_events
          SET title = ?, summary = ?, source_name = ?, source_url = ?, published_at = ?,
              occurred_start = ?, occurred_end = ?,
              bbox_n = ?, bbox_s = ?, bbox_w = ?, bbox_e = ?, point_lat = ?, point_lon = ?,
              region_name = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      input.title,
      input.summary ?? null,
      input.sourceName,
      input.sourceUrl,
      input.publishedAt ?? null,
      input.occurredStart ?? null,
      input.occurredEnd ?? null,
      bbox?.n ?? null,
      bbox?.s ?? null,
      bbox?.w ?? null,
      bbox?.e ?? null,
      point?.lat ?? null,
      point?.lon ?? null,
      input.geometry?.regionName ?? null,
      now,
      id,
    )
    .run()

  await db.prepare(`DELETE FROM event_categories WHERE event_id = ?`).bind(id).run()
  await db.prepare(`DELETE FROM event_keywords WHERE event_id = ?`).bind(id).run()
  await writeEventDecorations(db, id, input.categories, input.keywords)
}

/** List events, newest first, optionally filtered by status. */
export async function listCurrentEvents(
  db: D1Database,
  opts: { status?: CurrentEventStatus; limit?: number } = {},
): Promise<CurrentEventRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500))
  const where = opts.status ? `WHERE status = ?` : ''
  const stmt = db.prepare(
    `SELECT ${EVENT_COLUMNS} FROM current_events
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
  )
  const bound = opts.status ? stmt.bind(opts.status, limit) : stmt.bind(limit)
  const res = await bound.all<CurrentEventRow>()
  return res.results ?? []
}

/**
 * Transition an event's curator status, stamping the audit fields
 * (`reviewed_at` / `reviewed_by`) and `updated_at`. No-op result is the
 * caller's concern; this issues the UPDATE unconditionally.
 */
export async function setEventStatus(
  db: D1Database,
  id: string,
  status: CurrentEventStatus,
  reviewerId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE current_events
          SET status = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(status, now, reviewerId, now, id)
    .run()
}

/** Read an event's category/keyword decorations. */
export async function getEventDecorations(
  db: D1Database,
  eventId: string,
): Promise<EventDecorations> {
  const catRes = await db
    .prepare(`SELECT facet, value FROM event_categories WHERE event_id = ? ORDER BY facet, value`)
    .bind(eventId)
    .all<{ facet: string; value: string }>()
  const kwRes = await db
    .prepare(`SELECT keyword FROM event_keywords WHERE event_id = ? ORDER BY keyword`)
    .bind(eventId)
    .all<{ keyword: string }>()

  const categories: Record<string, string[]> = {}
  for (const { facet, value } of catRes.results ?? []) {
    ;(categories[facet] ??= []).push(value)
  }
  return { categories, keywords: (kwRes.results ?? []).map(r => r.keyword) }
}

/**
 * Insert or update an event→dataset link. The matcher writes `proposed`
 * links with a score + per-signal breakdown; re-running it on an ingest
 * refresh refreshes `match_score` / `signals_json` but **preserves the
 * existing `status`** (and its approval audit) — a curator's
 * approve/reject decision survives the 6-hourly re-run rather than being
 * demoted back to `proposed`. The `status` argument therefore only
 * applies to a brand-new link (insert), which defaults to `proposed`;
 * status transitions go through {@link setLinkStatus}.
 */
export async function upsertEventDatasetLink(
  db: D1Database,
  input: NewEventDatasetLink,
  now: string = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event_dataset_links (${LINK_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, dataset_id) DO UPDATE SET
         match_score  = excluded.match_score,
         signals_json = excluded.signals_json`,
    )
    .bind(
      input.eventId,
      input.datasetId,
      input.matchScore ?? null,
      input.signals === undefined ? null : JSON.stringify(input.signals),
      input.status ?? 'proposed',
      now,
      null,
      null,
    )
    .run()
}

/** List the links for an event, optionally filtered by status. */
export async function listLinksForEvent(
  db: D1Database,
  eventId: string,
  opts: { status?: EventLinkStatus } = {},
): Promise<EventDatasetLinkRow[]> {
  const where = opts.status ? `WHERE event_id = ? AND status = ?` : `WHERE event_id = ?`
  const stmt = db.prepare(
    `SELECT ${LINK_COLUMNS} FROM event_dataset_links ${where} ORDER BY match_score DESC`,
  )
  const bound = opts.status ? stmt.bind(eventId, opts.status) : stmt.bind(eventId)
  const res = await bound.all<EventDatasetLinkRow>()
  return res.results ?? []
}

/**
 * Bulk version of {@link listLinksForEvent} for the review queue: fetch
 * the links for many events in a few chunked `IN (…)` queries instead of
 * one per event (avoids an N+1 over the queue). Returns a map keyed by
 * event id; each list is score-ordered.
 */
export async function listLinksForEvents(
  db: D1Database,
  eventIds: readonly string[],
): Promise<Map<string, EventDatasetLinkRow[]>> {
  const out = new Map<string, EventDatasetLinkRow[]>()
  for (const id of eventIds) out.set(id, [])
  for (let i = 0; i < eventIds.length; i += EVENT_BIND_BATCH) {
    const chunk = eventIds.slice(i, i + EVENT_BIND_BATCH)
    const ph = chunk.map(() => '?').join(', ')
    const res = await db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM event_dataset_links
          WHERE event_id IN (${ph}) ORDER BY match_score DESC`,
      )
      .bind(...chunk)
      .all<EventDatasetLinkRow>()
    for (const row of res.results ?? []) out.get(row.event_id)?.push(row)
  }
  return out
}

/**
 * Bulk version of {@link getEventDecorations} for the review queue —
 * category + keyword decorations for many events in two chunked queries
 * each, keyed by event id.
 */
export async function getDecorationsForEvents(
  db: D1Database,
  eventIds: readonly string[],
): Promise<Map<string, EventDecorations>> {
  const out = new Map<string, EventDecorations>()
  for (const id of eventIds) out.set(id, { categories: {}, keywords: [] })
  for (let i = 0; i < eventIds.length; i += EVENT_BIND_BATCH) {
    const chunk = eventIds.slice(i, i + EVENT_BIND_BATCH)
    const ph = chunk.map(() => '?').join(', ')
    const catRes = await db
      .prepare(
        `SELECT event_id, facet, value FROM event_categories
          WHERE event_id IN (${ph}) ORDER BY facet, value`,
      )
      .bind(...chunk)
      .all<{ event_id: string; facet: string; value: string }>()
    for (const { event_id, facet, value } of catRes.results ?? []) {
      const dec = out.get(event_id)
      if (dec) (dec.categories[facet] ??= []).push(value)
    }
    const kwRes = await db
      .prepare(
        `SELECT event_id, keyword FROM event_keywords
          WHERE event_id IN (${ph}) ORDER BY keyword`,
      )
      .bind(...chunk)
      .all<{ event_id: string; keyword: string }>()
    for (const { event_id, keyword } of kwRes.results ?? []) {
      out.get(event_id)?.keywords.push(keyword)
    }
  }
  return out
}

/**
 * Reverse lookup: the links pointing at a dataset, optionally filtered
 * by status. The read path behind the future per-dataset "In the news"
 * panel (callers pass `status: 'approved'`).
 */
export async function listLinksForDataset(
  db: D1Database,
  datasetId: string,
  opts: { status?: EventLinkStatus } = {},
): Promise<EventDatasetLinkRow[]> {
  const where = opts.status ? `WHERE dataset_id = ? AND status = ?` : `WHERE dataset_id = ?`
  const stmt = db.prepare(
    `SELECT ${LINK_COLUMNS} FROM event_dataset_links ${where} ORDER BY match_score DESC`,
  )
  const bound = opts.status ? stmt.bind(datasetId, opts.status) : stmt.bind(datasetId)
  const res = await bound.all<EventDatasetLinkRow>()
  return res.results ?? []
}

/**
 * Transition a single link's status, stamping the approval audit
 * (`approved_at` / `approved_by`) when moving to `approved` and clearing
 * it otherwise.
 */
export async function setLinkStatus(
  db: D1Database,
  eventId: string,
  datasetId: string,
  status: EventLinkStatus,
  approverId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  const approvedAt = status === 'approved' ? now : null
  const approvedBy = status === 'approved' ? approverId : null
  await db
    .prepare(
      `UPDATE event_dataset_links
          SET status = ?, approved_at = ?, approved_by = ?
        WHERE event_id = ? AND dataset_id = ?`,
    )
    .bind(status, approvedAt, approvedBy, eventId, datasetId)
    .run()
}

/** Extract the {@link EventGeometry} subset present on a stored row. */
function geometryFromRow(row: CurrentEventRow): EventGeometry {
  const geometry: EventGeometry = {}
  if (
    row.bbox_n != null &&
    row.bbox_s != null &&
    row.bbox_w != null &&
    row.bbox_e != null
  ) {
    geometry.boundingBox = { n: row.bbox_n, s: row.bbox_s, w: row.bbox_w, e: row.bbox_e }
  }
  if (row.point_lat != null && row.point_lon != null) {
    geometry.point = { lat: row.point_lat, lon: row.point_lon }
  }
  if (row.region_name) geometry.regionName = row.region_name
  return geometry
}

/** Shape a stored event row (+ optional decorations) into the public
 *  payload. */
export function toPublicEvent(
  row: CurrentEventRow,
  decorations: EventDecorations = { categories: {}, keywords: [] },
): CurrentEventPublic {
  const geometry = geometryFromRow(row)

  const out: CurrentEventPublic = {
    id: row.id,
    originNode: row.origin_node,
    title: row.title,
    source: { name: row.source_name, url: row.source_url },
    geometry,
    categories: decorations.categories,
    keywords: decorations.keywords,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.summary) out.summary = row.summary
  if (row.published_at) out.source.publishedAt = row.published_at
  if (row.feed_id) out.feedId = row.feed_id
  if (row.occurred_start) out.occurredStart = row.occurred_start
  if (row.occurred_end) out.occurredEnd = row.occurred_end
  if (row.reviewed_at) out.reviewedAt = row.reviewed_at
  if (row.reviewed_by) out.reviewedBy = row.reviewed_by
  return out
}

/** A row from {@link getFeaturedEvent}: the event joined to its chosen
 *  approved, visible dataset link. */
export interface FeaturedEventRow {
  id: string
  title: string
  summary: string | null
  source_name: string
  source_url: string
  published_at: string | null
  occurred_start: string | null
  occurred_end: string | null
  dataset_id: string
  dataset_title: string
  match_score: number | null
}

/** The public (camelCase) shape the hero surface reads. */
export interface FeaturedEventPublic {
  id: string
  title: string
  summary?: string
  source: { name: string; url: string; publishedAt?: string }
  occurredStart?: string
  occurredEnd?: string
  datasetId: string
  datasetTitle: string
}

/**
 * The single event that should headline the "Right now" hero: the
 * freshest **approved** event that has an **approved** link to a
 * published, visible dataset, within {@link FEATURED_EVENT_MAX_AGE_MS}
 * of `now`. Freshness is the event's published date, falling back to its
 * occurred-start then created-at. Returns null when nothing qualifies.
 *
 * One row, one query — the join filters to approved+visible so the
 * client never has to re-check, and ordering picks the freshest event
 * then its best-scoring link. ISO-8601 UTC timestamps compare
 * lexicographically, so the string cutoff is a valid recency gate.
 */
export async function getFeaturedEvent(
  db: D1Database,
  opts: { now?: number; maxAgeMs?: number } = {},
): Promise<FeaturedEventRow | null> {
  const now = opts.now ?? Date.now()
  const cutoff = new Date(now - (opts.maxAgeMs ?? FEATURED_EVENT_MAX_AGE_MS)).toISOString()
  const row = await db
    .prepare(
      `SELECT e.id, e.title, e.summary, e.source_name, e.source_url, e.published_at,
              e.occurred_start, e.occurred_end,
              l.dataset_id AS dataset_id, d.title AS dataset_title, l.match_score AS match_score
         FROM current_events e
         JOIN event_dataset_links l ON l.event_id = e.id AND l.status = 'approved'
         JOIN datasets d ON d.id = l.dataset_id
        WHERE e.status = 'approved'
          AND d.published_at IS NOT NULL AND d.is_hidden = 0 AND d.retracted_at IS NULL
          AND COALESCE(e.published_at, e.occurred_start, e.created_at) >= ?
        ORDER BY COALESCE(e.published_at, e.occurred_start, e.created_at) DESC,
                 l.match_score DESC
        LIMIT 1`,
    )
    .bind(cutoff)
    .first<FeaturedEventRow>()
  return row ?? null
}

/** Shape a featured-event row into its public payload. */
export function toPublicFeaturedEvent(row: FeaturedEventRow): FeaturedEventPublic {
  const out: FeaturedEventPublic = {
    id: row.id,
    title: row.title,
    source: { name: row.source_name, url: row.source_url },
    datasetId: row.dataset_id,
    datasetTitle: row.dataset_title,
  }
  if (row.summary) out.summary = row.summary
  if (row.published_at) out.source.publishedAt = row.published_at
  if (row.occurred_start) out.occurredStart = row.occurred_start
  if (row.occurred_end) out.occurredEnd = row.occurred_end
  return out
}

/** One approved event for the public catalog overlays (Map/Timeline):
 *  enough to plot it in space + time, cite it, and click through to a
 *  dataset. `datasetIds` are the event's APPROVED links to published,
 *  visible datasets only — so the overlay never points at hidden data. */
export interface PublicEventListItem {
  id: string
  title: string
  summary?: string
  source: { name: string; url: string; publishedAt?: string }
  occurredStart?: string
  occurredEnd?: string
  geometry: EventGeometry
  datasetIds: string[]
}

/** Resolve, per event, the dataset ids of its APPROVED links to
 *  published/visible datasets — chunked `IN (…)`, score-ordered. */
async function approvedVisibleLinksForEvents(
  db: D1Database,
  eventIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const id of eventIds) out.set(id, [])
  for (let i = 0; i < eventIds.length; i += EVENT_BIND_BATCH) {
    const chunk = eventIds.slice(i, i + EVENT_BIND_BATCH)
    const ph = chunk.map(() => '?').join(', ')
    const res = await db
      .prepare(
        `SELECT l.event_id AS event_id, l.dataset_id AS dataset_id
           FROM event_dataset_links l
           JOIN datasets d ON d.id = l.dataset_id
          WHERE l.event_id IN (${ph})
            AND l.status = 'approved'
            AND d.published_at IS NOT NULL AND d.is_hidden = 0 AND d.retracted_at IS NULL
          ORDER BY l.match_score DESC`,
      )
      .bind(...chunk)
      .all<{ event_id: string; dataset_id: string }>()
    for (const r of res.results ?? []) out.get(r.event_id)?.push(r.dataset_id)
  }
  return out
}

/**
 * The approved events for the public catalog overlays: each `approved`
 * event within {@link FEATURED_EVENT_MAX_AGE_MS} that has at least one
 * `approved` link to a published, visible dataset. Mirrors
 * {@link getFeaturedEvent}'s gating (approved event + approved link +
 * visible dataset + recency) but returns the full set, each carrying its
 * visible linked dataset ids. Events whose only links are to hidden/
 * unapproved datasets are dropped entirely.
 */
export async function listPublicEvents(
  db: D1Database,
  opts: { now?: number; maxAgeMs?: number; limit?: number } = {},
): Promise<PublicEventListItem[]> {
  const now = opts.now ?? Date.now()
  const cutoff = new Date(now - (opts.maxAgeMs ?? FEATURED_EVENT_MAX_AGE_MS)).toISOString()
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500))

  const res = await db
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM current_events
        WHERE status = 'approved'
          AND COALESCE(published_at, occurred_start, created_at) >= ?
        ORDER BY COALESCE(published_at, occurred_start, created_at) DESC
        LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<CurrentEventRow>()
  const rows = res.results ?? []
  if (rows.length === 0) return []

  const linksByEvent = await approvedVisibleLinksForEvents(db, rows.map(r => r.id))

  const out: PublicEventListItem[] = []
  for (const row of rows) {
    const datasetIds = linksByEvent.get(row.id) ?? []
    if (datasetIds.length === 0) continue // no visible, approved dataset → not surfaceable
    const item: PublicEventListItem = {
      id: row.id,
      title: row.title,
      source: { name: row.source_name, url: row.source_url },
      geometry: geometryFromRow(row),
      datasetIds,
    }
    if (row.summary) item.summary = row.summary
    if (row.published_at) item.source.publishedAt = row.published_at
    if (row.occurred_start) item.occurredStart = row.occurred_start
    if (row.occurred_end) item.occurredEnd = row.occurred_end
    out.push(item)
  }
  return out
}
