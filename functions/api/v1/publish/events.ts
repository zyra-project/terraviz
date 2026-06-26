/**
 * /api/v1/publish/events — the current-events review queue + ingestion
 * sink (`docs/CURRENT_EVENTS_PLAN.md` §5, §9).
 *
 * GET  — Privileged-only review queue: events for a curator to vet, each
 *        with its proposed event→dataset links (score + per-signal
 *        breakdown + the linked dataset's title). Defaults to
 *        `status=proposed`; `?status=` narrows to another bucket.
 * POST — Privileged-only create (the ingestion path, typically a service
 *        token from the import-events CLI). Idempotent on
 *        `(feed_id, external_id)`: a re-ingest refreshes the existing
 *        event's content instead of duplicating it. On create/refresh the
 *        matcher runs to (re)propose dataset links, so the queue arrives
 *        pre-populated. Always lands as `proposed` — the curator gate is
 *        unchanged.
 *
 * Reads `context.data.publisher` injected by the publish middleware.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { isPrivileged } from '../_lib/publisher-store'
import { writeAuditEvent } from '../_lib/audit-store'
import { parseCreate, resolveOriginNode, ingestEvent, type FieldError } from '../_lib/events-ingest'
import {
  listCurrentEvents,
  listLinksForEvent,
  listLinksForEvents,
  getEventDecorations,
  getDecorationsForEvents,
  getCurrentEvent,
  bustFeaturedEventCache,
  toPublicEvent,
  type CurrentEventStatus,
  type EventDatasetLinkRow,
  type NewCurrentEvent,
} from '../_lib/events-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

const VALID_STATUSES: readonly CurrentEventStatus[] = [
  'proposed',
  'approved',
  'rejected',
  'expired',
]

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

/** Shape a stored link row into the queue's wire form. */
function toPublicLink(row: EventDatasetLinkRow, datasetTitle: string | null) {
  return {
    datasetId: row.dataset_id,
    datasetTitle,
    score: row.match_score,
    signals: row.signals_json ? (JSON.parse(row.signals_json) as unknown) : null,
    status: row.status,
  }
}

/** Fetch the titles for a set of dataset ids in one query. */
async function fetchDatasetTitles(
  db: D1Database,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (ids.length === 0) return titles
  const placeholders = ids.map(() => '?').join(', ')
  const res = await db
    .prepare(`SELECT id, title FROM datasets WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; title: string }>()
  for (const row of res.results ?? []) titles.set(row.id, row.title)
  return titles
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'The events review queue is restricted to admin and service callers.')
  }

  const statusParam = new URL(context.request.url).searchParams.get('status')
  if (statusParam && !VALID_STATUSES.includes(statusParam as CurrentEventStatus)) {
    return jsonError(400, 'invalid_status', `\`status\` must be one of: ${VALID_STATUSES.join(', ')}.`)
  }
  const status = (statusParam as CurrentEventStatus | null) ?? 'proposed'

  const db = context.env.CATALOG_DB
  const eventRows = await listCurrentEvents(db, { status })

  // Bulk-fetch links + decorations for the whole page (chunked IN
  // queries) rather than two per event, then resolve all referenced
  // dataset titles in one more query — keeps the queue O(1) round-trips
  // as events accumulate, not O(N).
  const eventIds = eventRows.map(e => e.id)
  const linksByEvent = await listLinksForEvents(db, eventIds)
  const decorationsByEvent = await getDecorationsForEvents(db, eventIds)
  const datasetIds = [...new Set([...linksByEvent.values()].flat().map(l => l.dataset_id))]
  const titles = await fetchDatasetTitles(db, datasetIds)

  const events = eventRows.map(row => {
    const links = linksByEvent.get(row.id) ?? []
    const decorations = decorationsByEvent.get(row.id) ?? { categories: {}, keywords: [] }
    return {
      ...toPublicEvent(row, decorations),
      links: links.map(l => toPublicLink(l, titles.get(l.dataset_id) ?? null)),
    }
  })

  return new Response(JSON.stringify({ events }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

// ----- POST: create / ingest -----

function validationFailure(errors: FieldError[]): Response {
  return new Response(JSON.stringify({ errors }), {
    status: 400,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Creating events is restricted to admin and service callers.')
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const parsed = parseCreate(body)
  if (!parsed.ok) return validationFailure(parsed.errors)

  const db = context.env.CATALOG_DB
  const input: NewCurrentEvent = { ...parsed.value, originNode: await resolveOriginNode(db) }

  // Idempotent on the feed dedupe key, runs the matcher inline so the
  // review queue is pre-populated — shared with the refresh route.
  const { id, created, proposedLinks } = await ingestEvent(db, input)

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'event.ingested',
    subject_kind: 'event',
    subject_id: id,
    metadata_json: JSON.stringify({
      created,
      feed_id: input.feedId ?? null,
      external_id: input.externalId ?? null,
      proposed_links: proposedLinks,
    }),
  })
  // A new approved event can't appear yet (lands proposed), but a
  // refresh of an already-approved event can change what the hero shows.
  await bustFeaturedEventCache(context.env.CATALOG_KV)

  const row = await getCurrentEvent(db, id)
  const decorations = await getEventDecorations(db, id)
  const links = await listLinksForEvent(db, id)
  return new Response(
    JSON.stringify({
      created,
      event: row ? toPublicEvent(row, decorations) : null,
      links: links.map(l => toPublicLink(l, null)),
    }),
    { status: created ? 201 : 200, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' } },
  )
}
