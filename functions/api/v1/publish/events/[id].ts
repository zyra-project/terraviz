/**
 * POST /api/v1/publish/events/:id — submit a curator review for one
 * current event (`docs/CURRENT_EVENTS_PLAN.md` §5).
 *
 * Privileged-only (staff / admin / service). Carries the curator's
 * decisions in a single body so an event verdict and per-link verdicts
 * land together:
 *
 *   {
 *     "event": "approve" | "reject",                 // optional: vet the event itself
 *     "links": [{ "datasetId": "...", "decision": "approve" | "reject" }]  // optional
 *   }
 *
 * Event status (is this event reputable/relevant?) and link status
 * (is this dataset pairing good?) are independent dimensions — a curator
 * can approve the event and reject a weak link in the same submit. 404
 * if the event is unknown; 400 `{ errors }` for a malformed body or a
 * `datasetId` that isn't a proposed link of the event. One audit row
 * (`event.reviewed`) records the whole submission.
 *
 * Reads `context.data.publisher` injected by the publish middleware.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { writeAuditEvent } from '../../_lib/audit-store'
import {
  getCurrentEvent,
  listLinksForEvent,
  getEventDecorations,
  setEventStatus,
  setLinkStatus,
  toPublicEvent,
  bustFeaturedEventCache,
  type CurrentEventStatus,
  type EventLinkStatus,
} from '../../_lib/events-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

interface FieldError {
  field: string
  code: string
  message: string
}

type Decision = 'approve' | 'reject'

interface LinkDecision {
  datasetId: string
  decision: Decision
}

interface ParsedReview {
  event?: Decision
  links: LinkDecision[]
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function validationFailure(errors: FieldError[]): Response {
  return new Response(JSON.stringify({ errors }), {
    status: 400,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

const DECISION_TO_STATUS: Record<Decision, EventLinkStatus & CurrentEventStatus> = {
  approve: 'approved',
  reject: 'rejected',
}

/** Validate the review body shape (not yet against the event's links). */
function parseReview(
  raw: unknown,
): { ok: true; value: ParsedReview } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  let event: Decision | undefined
  if (body.event != null) {
    if (body.event === 'approve' || body.event === 'reject') event = body.event
    else errors.push({ field: 'event', code: 'invalid', message: '`event` must be "approve" or "reject".' })
  }

  const links: LinkDecision[] = []
  if (body.links != null) {
    if (!Array.isArray(body.links)) {
      errors.push({ field: 'links', code: 'invalid', message: '`links` must be an array.' })
    } else {
      body.links.forEach((entry, i) => {
        const l = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
        const datasetId = l.datasetId
        const decision = l.decision
        if (typeof datasetId !== 'string' || datasetId.length === 0) {
          errors.push({ field: `links[${i}].datasetId`, code: 'required', message: '`datasetId` is required.' })
        }
        if (decision !== 'approve' && decision !== 'reject') {
          errors.push({ field: `links[${i}].decision`, code: 'invalid', message: '`decision` must be "approve" or "reject".' })
        }
        if (typeof datasetId === 'string' && (decision === 'approve' || decision === 'reject')) {
          links.push({ datasetId, decision })
        }
      })
    }
  }

  if (event === undefined && links.length === 0 && errors.length === 0) {
    errors.push({ field: 'event', code: 'empty', message: 'Provide an `event` decision and/or one or more `links`.' })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { event, links } }
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Reviewing events is restricted to staff, admin, and service callers.')
  }

  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing event id.')

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const parsed = parseReview(body)
  if (!parsed.ok) return validationFailure(parsed.errors)

  const db = context.env.CATALOG_DB
  const event = await getCurrentEvent(db, id)
  if (!event) return jsonError(404, 'not_found', `Event ${id} not found.`)

  // Every link decision must target a real proposed link of this event.
  const existingLinks = await listLinksForEvent(db, id)
  const linkIds = new Set(existingLinks.map(l => l.dataset_id))
  const unknownLinks = parsed.value.links.filter(l => !linkIds.has(l.datasetId))
  if (unknownLinks.length > 0) {
    return validationFailure(
      unknownLinks.map(l => ({
        field: 'links',
        code: 'unknown_link',
        message: `Dataset ${l.datasetId} is not a proposed link of event ${id}.`,
      })),
    )
  }

  if (parsed.value.event) {
    await setEventStatus(db, id, DECISION_TO_STATUS[parsed.value.event], publisher.id)
  }
  for (const link of parsed.value.links) {
    await setLinkStatus(db, id, link.datasetId, DECISION_TO_STATUS[link.decision], publisher.id)
  }

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'event.reviewed',
    subject_kind: 'event',
    subject_id: id,
    metadata_json: JSON.stringify({
      event: parsed.value.event ?? null,
      links: parsed.value.links,
    }),
  })

  // A status change can alter what the public "Right now" hero surfaces;
  // bust the cache so an approval shows up within a tick (the 60 s TTL is
  // the backstop).
  await bustFeaturedEventCache(context.env.CATALOG_KV)

  // Re-read so the response reflects the applied decisions.
  const updated = await getCurrentEvent(db, id)
  const decorations = await getEventDecorations(db, id)
  const links = await listLinksForEvent(db, id)
  return new Response(
    JSON.stringify({
      event: updated ? toPublicEvent(updated, decorations) : null,
      links: links.map(l => ({
        datasetId: l.dataset_id,
        score: l.match_score,
        status: l.status,
      })),
    }),
    { status: 200, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' } },
  )
}
