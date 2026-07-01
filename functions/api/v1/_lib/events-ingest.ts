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
import { runMatcherForEvent } from './events-matcher'
import {
  findEventByExternal,
  updateCurrentEventContent,
  insertCurrentEvent,
  upsertEventDatasetLink,
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
}

export interface IngestOptions {
  /** Hand-picked dataset pairings from the new-event drawer, inserted as
   *  `proposed` links before the matcher runs. Filtered to real, visible
   *  datasets; unknown / hidden ids are silently dropped. */
  manualDatasetIds?: readonly string[]
}

/** Restrict an id list to datasets that exist and are publicly visible
 *  (mirrors the matcher's candidate filter). Guards the link FK and stops
 *  a manual pairing from pointing at a hidden/retracted dataset. */
async function filterVisibleDatasetIds(
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
  if (input.feedId && input.externalId) {
    const existing = await findEventByExternal(db, input.feedId, input.externalId)
    if (existing) {
      await updateCurrentEventContent(db, existing.id, input)
      id = existing.id
      created = false
    } else {
      id = (await insertCurrentEvent(db, input)).id
      created = true
    }
  } else {
    id = (await insertCurrentEvent(db, input)).id
    created = true
  }

  // Seed the hand-picked pairings before the matcher so an overlapping
  // dataset's link is refreshed (not clobbered) with real signals.
  const manualIds = await filterVisibleDatasetIds(db, opts.manualDatasetIds ?? [])
  for (const datasetId of manualIds) {
    await upsertEventDatasetLink(db, { eventId: id, datasetId, status: 'proposed' })
  }

  const matches = await runMatcherForEvent(db, id)
  const matchedIds = new Set(matches.map(m => m.datasetId))
  const manualOnly = manualIds.filter(dsId => !matchedIds.has(dsId)).length
  return { id, created, proposedLinks: matches.length + manualOnly, manualLinks: manualIds.length }
}
