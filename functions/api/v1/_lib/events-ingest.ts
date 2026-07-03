/**
 * Shared current-events ingestion logic — the parse + upsert + match
 * core used by both the create route (`POST /api/v1/publish/events`,
 * one body at a time, typically the importer/service token) and the
 * server-side refresh route (`POST /api/v1/publish/events/refresh`,
 * a whole feed at once). Centralised here so the two paths can't drift
 * (`docs/CURRENT_EVENTS_PLAN.md` §9).
 *
 * The validation is source-agnostic: provenance (title + source.name +
 * an http(s) source.url) is mandatory; geometry, feed dedupe keys, and
 * decorations are optional. A non-http(s) `source.url` is refused at
 * the door because the citation renders as a clickable link on public
 * surfaces.
 */

import { looksLikeUrl } from './validators'
import { runMatcherForEvent, type MatcherEnv } from './events-matcher'
import { enrichEventFields, type EnrichEnv, type InferredField } from './events-enrich'
import { fetchOgImage } from './og-image'
import {
  findEventByExternal,
  updateCurrentEventContent,
  insertCurrentEvent,
  upsertEventDatasetLink,
  type CurrentEventRow,
  type EventGeometry,
  type NewCurrentEvent,
} from './events-store'

export interface FieldError {
  field: string
  code: string
  message: string
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Coerce an untrusted `categories` value to `Record<string, string[]>`,
 *  dropping non-array facets and non-string entries. An ingestion
 *  surface should persist a clean shape (or nothing) rather than let a
 *  malformed payload write garbage decoration rows. */
export function sanitizeCategories(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string[]> = {}
  for (const [facet, values] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue
    const strs = values.filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (strs.length > 0) out[facet] = strs
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Max hand-picked dataset pairings accepted on create. A curator
 *  authoring an event by hand pairs a handful; the cap guards against a
 *  pathological payload writing thousands of link rows. */
export const MAX_MANUAL_DATASET_IDS = 50

/** Coerce an untrusted `datasetIds` value to a clean, deduped list of
 *  non-empty strings, capped at {@link MAX_MANUAL_DATASET_IDS}. These are
 *  hand-picked pairings from the new-event drawer, inserted as `proposed`
 *  links alongside the matcher's output. Invalid entries are dropped
 *  (lenient, like {@link sanitizeCategories}) rather than rejected. */
export function sanitizeDatasetIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const v of raw) {
    // Trim so whitespace-padded ids can't slip past dedupe / the FK check.
    if (typeof v === 'string') {
      const id = v.trim()
      if (id.length > 0) seen.add(id)
    }
    if (seen.size >= MAX_MANUAL_DATASET_IDS) break
  }
  return [...seen]
}

/** Parse a create body into a {@link NewCurrentEvent}. Provenance
 *  (title + source.name + source.url) is mandatory; everything else is
 *  optional. Geometry accepts any subset of bbox / point / region.
 *  `manualDatasetIds` carries the drawer's hand-picked pairings (empty
 *  for feed ingestion). The returned `originNode` is a placeholder — the
 *  caller overwrites it with the resolved node id via
 *  {@link resolveOriginNode}. */
export function parseCreate(
  raw: unknown,
): { ok: true; value: NewCurrentEvent; manualDatasetIds: string[] } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const title = asString(b.title)
  if (!title) errors.push({ field: 'title', code: 'required', message: '`title` is required.' })

  const src = (b.source && typeof b.source === 'object' ? b.source : {}) as Record<string, unknown>
  const sourceName = asString(src.name)
  const sourceUrl = asString(src.url)
  if (!sourceName) errors.push({ field: 'source.name', code: 'required', message: '`source.name` is required.' })
  if (!sourceUrl) {
    errors.push({ field: 'source.url', code: 'required', message: '`source.url` is required.' })
  } else if (!looksLikeUrl(sourceUrl)) {
    // The citation is rendered as a clickable link on public surfaces;
    // refuse non-http(s) schemes (javascript: / data:) at the door.
    errors.push({ field: 'source.url', code: 'invalid', message: '`source.url` must be an http(s) URL.' })
  }

  const geomRaw = (b.geometry && typeof b.geometry === 'object' ? b.geometry : {}) as Record<string, unknown>
  const geometry: EventGeometry = {}
  const bbox = (geomRaw.boundingBox && typeof geomRaw.boundingBox === 'object' ? geomRaw.boundingBox : null) as Record<string, unknown> | null
  if (bbox) {
    const n = asNumber(bbox.n), s = asNumber(bbox.s), w = asNumber(bbox.w), e = asNumber(bbox.e)
    if (n !== undefined && s !== undefined && w !== undefined && e !== undefined) {
      geometry.boundingBox = { n, s, w, e }
    }
  }
  const point = (geomRaw.point && typeof geomRaw.point === 'object' ? geomRaw.point : null) as Record<string, unknown> | null
  if (point) {
    const lat = asNumber(point.lat), lon = asNumber(point.lon)
    if (lat !== undefined && lon !== undefined) geometry.point = { lat, lon }
  }
  const regionName = asString(geomRaw.regionName)
  if (regionName) geometry.regionName = regionName

  const categories = sanitizeCategories(b.categories)
  const keywords = Array.isArray(b.keywords)
    ? (b.keywords as unknown[]).filter((k): k is string => typeof k === 'string' && k.length > 0)
    : undefined

  // The story's lead image (feed enclosure / media:content). Lenient
  // drop rather than a field error — a bad image URL shouldn't refuse
  // an otherwise valid event; it just arrives imageless. Same http(s)
  // guard as source.url, plus a length cap so a data:-adjacent
  // monster can't occupy the column.
  const imageRaw = asString(b.imageUrl)
  const imageUrl = imageRaw && looksLikeUrl(imageRaw) && imageRaw.length <= 2048 ? imageRaw : null

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      originNode: 'local', // overwritten with the node id in the handler
      title: title as string,
      summary: asString(b.summary) ?? null,
      sourceName: sourceName as string,
      sourceUrl: sourceUrl as string,
      publishedAt: asString(src.publishedAt) ?? null,
      feedId: asString(b.feedId) ?? null,
      externalId: asString(b.externalId) ?? null,
      occurredStart: asString(b.occurredStart) ?? null,
      occurredEnd: asString(b.occurredEnd) ?? null,
      geometry,
      categories,
      keywords,
      imageUrl,
    },
    manualDatasetIds: sanitizeDatasetIds(b.datasetIds),
  }
}

/** Resolve this node's id for `origin_node`, mirroring the dataset
 *  write path's `(SELECT node_id FROM node_identity LIMIT 1)`. */
export async function resolveOriginNode(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT node_id FROM node_identity LIMIT 1`).first<{ node_id: string }>()
  return row?.node_id ?? 'local'
}

export interface IngestOutcome {
  id: string
  created: boolean
  proposedLinks: number
  /** How many hand-picked pairings were actually inserted — i.e. after
   *  dropping ids that don't resolve to a visible, published dataset.
   *  May be fewer than the requested `datasetIds` if one was hidden /
   *  retracted between drawer load and save. */
  manualLinks: number
  /** True when slice-C enrichment filled at least one field on this
   *  event — surfaces in the refresh summary so an operator can tell
   *  "AI unbound/erroring" from "nothing needed filling". */
  enriched: boolean
}

export interface IngestOptions {
  /** Hand-picked dataset pairings from the new-event drawer, inserted as
   *  `proposed` links before the matcher runs. Filtered to real, visible
   *  datasets; unknown / hidden ids are silently dropped. */
  manualDatasetIds?: readonly string[]
  /** Workers AI + Vectorize bindings for the matcher's semantic signal
   *  and the slice-C date/location enrichment. Optional: when
   *  unconfigured the matcher runs pure lexical/temporal and enrichment
   *  is skipped. Callers pass `context.env`. */
  env?: MatcherEnv & EnrichEnv
  /** Shared mutable budget of AI enrichment calls across one caller's
   *  loop (the refresh route ingests up to 100 events per request; a
   *  bound keeps one refresh from stacking that many model calls).
   *  Omitted → each ingest may enrich (the single-event create path). */
  enrichBudget?: { remaining: number }
  /** Injectable fetch for the og:image fallback (task: story media) —
   *  routes pass the runtime fetch; omitted (tests, callers that don't
   *  want outbound article fetches) → the fallback is skipped. Spends
   *  the same `enrichBudget` units as the AI enrichment so a
   *  100-event refresh can't stack 100 article fetches. */
  ogFetch?: typeof fetch
}

/** Restrict an id list to datasets that exist and are publicly visible
 *  (mirrors the matcher's candidate filter). Guards the link FK and stops
 *  a manual pairing from pointing at a hidden/retracted dataset. Shared by
 *  the create path (`ingestEvent`) and the review route's "add dataset to
 *  an existing event" action. */
export async function filterVisibleDatasetIds(
  db: D1Database,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const res = await db
    .prepare(
      `SELECT id FROM datasets
        WHERE id IN (${placeholders})
          AND published_at IS NOT NULL
          AND is_hidden = 0
          AND retracted_at IS NULL`,
    )
    .bind(...ids)
    .all<{ id: string }>()
  return (res.results ?? []).map(r => r.id)
}

/** Fill a new event's missing occurred-date / location via Workers AI
 *  (slice C) — only when the AI binding is configured and the shared
 *  budget (if any) has headroom. Returns the input untouched on skip. */
async function withEnrichment(input: NewCurrentEvent, opts: IngestOptions): Promise<NewCurrentEvent> {
  if (!opts.env?.AI) return input
  if (opts.enrichBudget) {
    if (opts.enrichBudget.remaining <= 0) return input
    // Only spend budget when there is actually something to fill.
    if (input.occurredStart && (input.geometry?.boundingBox || input.geometry?.point || input.geometry?.regionName)) {
      return input
    }
    opts.enrichBudget.remaining--
  }
  const enriched = await enrichEventFields(opts.env, input)
  if (!enriched) return input
  const out: NewCurrentEvent = { ...input, inferredFields: enriched.inferred }
  if (enriched.occurredStart) out.occurredStart = enriched.occurredStart
  if (enriched.geometry) out.geometry = { ...input.geometry, ...enriched.geometry }
  return out
}

/** Fill a new event's missing lead image from the cited article's
 *  og:image (task: story media). Feed-provided images always win —
 *  this only runs when the item carried none. Returns the input
 *  untouched on skip or miss. */
async function withStoryImage(input: NewCurrentEvent, opts: IngestOptions): Promise<NewCurrentEvent> {
  if (input.imageUrl || !opts.ogFetch) return input
  if (opts.enrichBudget) {
    if (opts.enrichBudget.remaining <= 0) return input
    opts.enrichBudget.remaining--
  }
  const imageUrl = await fetchOgImage(input.sourceUrl, opts.ogFetch)
  return imageUrl ? { ...input, imageUrl } : input
}

/** On a feed re-ingest, keep previously AI-inferred values for fields
 *  the incoming body still lacks — otherwise the content refresh would
 *  null them out and the queue badge would lie. Source-provided values
 *  always win: a field the feed now supplies drops its inferred flag. */
function mergeInferred(input: NewCurrentEvent, existing: CurrentEventRow): NewCurrentEvent {
  let prior: string[] = []
  try {
    const parsed: unknown = existing.inferred_fields ? JSON.parse(existing.inferred_fields) : []
    if (Array.isArray(parsed)) prior = parsed.filter((f): f is string => typeof f === 'string')
  } catch {
    prior = []
  }
  if (prior.length === 0) return input

  const out: NewCurrentEvent = { ...input }
  const kept: InferredField[] = []
  if (prior.includes('occurredStart') && !input.occurredStart && existing.occurred_start) {
    out.occurredStart = existing.occurred_start
    kept.push('occurredStart')
  }
  const incomingHasGeometry = Boolean(
    input.geometry?.boundingBox || input.geometry?.point || input.geometry?.regionName,
  )
  if (prior.includes('geometry') && !incomingHasGeometry) {
    const geometry: EventGeometry = {}
    if (existing.bbox_n !== null && existing.bbox_s !== null && existing.bbox_w !== null && existing.bbox_e !== null) {
      geometry.boundingBox = { n: existing.bbox_n, s: existing.bbox_s, w: existing.bbox_w, e: existing.bbox_e }
    }
    if (existing.point_lat !== null && existing.point_lon !== null) {
      geometry.point = { lat: existing.point_lat, lon: existing.point_lon }
    }
    if (existing.region_name) geometry.regionName = existing.region_name
    if (geometry.boundingBox || geometry.point || geometry.regionName) {
      out.geometry = geometry
      kept.push('geometry')
    }
  }
  if (kept.length > 0) out.inferredFields = kept
  return out
}

/**
 * Upsert one parsed event and (re)propose its dataset links.
 *
 * Idempotent on the feed dedupe key `(feedId, externalId)`: when both
 * are present and a row already exists, the content is refreshed in
 * place rather than duplicated — and the existing `status` is left
 * untouched, so a curator-rejected event is never resurrected by a
 * re-ingest. Events without a feed key always insert (manual authoring).
 *
 * Hand-picked `manualDatasetIds` (drawer pairings) are inserted as
 * `proposed` links **before** the matcher runs, so any that also match
 * pick up real T/Ti/G signals (the matcher's `ON CONFLICT` refreshes the
 * score while preserving `status`), and manual-only pairings persist with
 * no automatic score.
 *
 * The matcher runs inline so the review queue is pre-populated. The
 * caller owns auditing and any cache invalidation.
 */
export async function ingestEvent(
  db: D1Database,
  input: NewCurrentEvent,
  opts: IngestOptions = {},
): Promise<IngestOutcome> {
  let id: string
  let created: boolean
  let enriched = false
  if (input.feedId && input.externalId) {
    const existing = await findEventByExternal(db, input.feedId, input.externalId)
    if (existing) {
      // Re-ingest: carry previously-inferred fields the source still
      // doesn't provide, so a 6-hourly refresh can't erase enrichment
      // (and doesn't pay for a fresh model call every cycle).
      const refreshed = mergeInferred(input, existing)
      // Same preservation for the story image: a feed item that never
      // carried one must not erase a previously og-fetched image.
      if (!refreshed.imageUrl && existing.image_url) refreshed.imageUrl = existing.image_url
      await updateCurrentEventContent(db, existing.id, refreshed)
      id = existing.id
      created = false
    } else {
      const prepared = await withStoryImage(await withEnrichment(input, opts), opts)
      enriched = prepared !== input
      id = (await insertCurrentEvent(db, prepared)).id
      created = true
    }
  } else {
    const prepared = await withStoryImage(await withEnrichment(input, opts), opts)
    enriched = prepared !== input
    id = (await insertCurrentEvent(db, prepared)).id
    created = true
  }

  // Seed the hand-picked pairings before the matcher so an overlapping
  // dataset's link is refreshed (not clobbered) with real signals.
  const manualIds = await filterVisibleDatasetIds(db, opts.manualDatasetIds ?? [])
  for (const datasetId of manualIds) {
    await upsertEventDatasetLink(db, { eventId: id, datasetId, status: 'proposed' })
  }

  const matches = await runMatcherForEvent(db, id, { env: opts.env })
  const matchedIds = new Set(matches.map(m => m.datasetId))
  const manualOnly = manualIds.filter(dsId => !matchedIds.has(dsId)).length
  return { id, created, proposedLinks: matches.length + manualOnly, manualLinks: manualIds.length, enriched }
}
