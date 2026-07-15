/**
 * POST /api/v1/publish/events/:id — submit a curator review for one
 * current event (`docs/CURRENT_EVENTS_PLAN.md` §5).
 *
 * Privileged-only (admin / service). Carries the curator's
 * decisions in a single body so an event verdict and per-link verdicts
 * land together:
 *
 *   {
 *     "event": "approve" | "reject",                 // optional: vet the event itself
 *     "links": [{ "datasetId": "...", "decision": "approve" | "reject" }], // optional
 *     "addDatasetIds": ["..."],                       // optional: pair extra datasets the matcher missed
 *     "edits": { "occurredStart": "...", "regionName": "...", "point": { "lat": 37.2, "lon": -76.8 } } // optional
 *   }
 *
 * `edits` lets a curator override the occurred time and/or location —
 * the fix for a wrong or missing AI-inferred value (slice C). The
 * region name resolves through the same `regions.ts` vocabulary the
 * enrichment uses; `point` pins an exact spot (a region edit clears a
 * stale point unless a new one accompanies it; a point-only edit keeps
 * the surrounding bbox/region). An edited field sheds its "AI-inferred"
 * flag and the matcher re-runs so the pairing signals score the
 * corrected values.
 *
 * `addDatasetIds` lets a curator pair a dataset the matcher never
 * suggested: each is seeded as a fresh `proposed` link (visibility-
 * filtered; ids already linked are skipped so a matcher score is never
 * clobbered), ready to approve like any other.
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
import { writeAuditEvent } from '../../_lib/audit-store'
import {
  canMutateEvent,
  canReviewEvent,
  claimEventOwner,
  getCurrentEvent,
  listLinksForEvent,
  getEventDecorations,
  setEventStatus,
  setLinkStatus,
  insertProposedLinkIfAbsent,
  applyEventEdits,
  toPublicEvent,
  bustFeaturedEventCache,
  type CurrentEventStatus,
  type EventGeometry,
  type EventLinkStatus,
} from '../../_lib/events-store'
import { sanitizeDatasetIds, filterVisibleDatasetIds } from '../../_lib/events-ingest'
import { looksLikeUrl } from '../../_lib/validators'
import { isNocookieEmbedUrl } from '../../_lib/youtube-channels'
import { runMatcherForEvent } from '../../_lib/events-matcher'
import { resolveRegion } from '../../../../../src/data/regions'

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
  addDatasetIds: string[]
  /** Curator corrections to the event's own metadata (slice C: the fix
   *  for a wrong or missing AI-inferred value). `geometry` arrives
   *  resolved from `edits.regionName` via `regions.ts` and/or a raw
   *  `edits.point`; `pointOnly` marks a point-without-region edit so the
   *  handler can preserve the event's existing bbox/region. */
  edits?: { occurredStart?: string; geometry?: EventGeometry; pointOnly?: boolean; imageUrl?: string; imageAlt?: string | null; videoEmbedUrl?: string | null }
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

  const addDatasetIds = sanitizeDatasetIds(body.addDatasetIds)

  // Curator metadata corrections — a date and/or a place constrained to
  // the same regions.ts vocabulary the AI enrichment uses.
  let edits: ParsedReview['edits']
  if (body.edits != null) {
    const e = (body.edits && typeof body.edits === 'object' ? body.edits : {}) as Record<string, unknown>
    const out: NonNullable<ParsedReview['edits']> = {}
    if (e.occurredStart != null) {
      const ms = typeof e.occurredStart === 'string' ? Date.parse(e.occurredStart) : NaN
      if (!Number.isFinite(ms)) {
        errors.push({ field: 'edits.occurredStart', code: 'invalid', message: '`edits.occurredStart` must be a parseable date.' })
      } else {
        out.occurredStart = new Date(ms).toISOString()
      }
    }
    let regionGeometry: EventGeometry | undefined
    if (e.regionName != null) {
      const region = typeof e.regionName === 'string' ? resolveRegion(e.regionName) : null
      if (!region) {
        errors.push({ field: 'edits.regionName', code: 'invalid', message: '`edits.regionName` must be a known region name.' })
      } else {
        const [w, s, eb, n] = region.bounds
        regionGeometry = { boundingBox: { n, s, w, e: eb }, regionName: region.name }
      }
    }
    let point: { lat: number; lon: number } | undefined
    if (e.point != null) {
      const p = (typeof e.point === 'object' ? e.point : {}) as Record<string, unknown>
      const lat = typeof p.lat === 'number' && Number.isFinite(p.lat) ? p.lat : NaN
      const lon = typeof p.lon === 'number' && Number.isFinite(p.lon) ? p.lon : NaN
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        errors.push({ field: 'edits.point', code: 'invalid', message: '`edits.point` must be { lat: -90..90, lon: -180..180 }.' })
      } else {
        point = { lat, lon }
      }
    }
    // Compose the geometry edit. A region edit replaces bbox + name and
    // clears any stale point unless a point edit accompanies it; a
    // point-only edit is completed by the caller against the existing
    // geometry (see the handler), so bbox/region are preserved.
    if (regionGeometry) {
      out.geometry = point ? { ...regionGeometry, point } : regionGeometry
    } else if (point) {
      out.geometry = { point }
      out.pointOnly = true
    }
    // Curator-picked story image (the Suggested-media pane). Same
    // guard as ingest: http(s) only, bounded — it renders publicly.
    if (e.imageUrl != null) {
      const img = typeof e.imageUrl === 'string' ? e.imageUrl.trim() : ''
      if (!looksLikeUrl(img) || img.length > 2048) {
        errors.push({ field: 'edits.imageUrl', code: 'invalid', message: '`edits.imageUrl` must be an http(s) URL of at most 2048 characters.' })
      } else {
        out.imageUrl = img
      }
    }
    // Alt text for the image (media accessibility). Accompanies an
    // imageUrl edit, or stands alone to describe the image in place.
    if (e.imageAlt != null) {
      const alt = typeof e.imageAlt === 'string' ? e.imageAlt.trim() : null
      if (alt === null || alt.length > 512) {
        errors.push({ field: 'edits.imageAlt', code: 'invalid', message: '`edits.imageAlt` must be a string of at most 512 characters.' })
      } else {
        out.imageAlt = alt.length > 0 ? alt : null
      }
    }
    // Curator-picked video embed (the agency-YouTube suggestion). Only
    // our own source's nocookie/embed shape may pass — it becomes an
    // iframe src. Empty string clears it.
    if (e.videoEmbedUrl != null) {
      const v = typeof e.videoEmbedUrl === 'string' ? e.videoEmbedUrl.trim() : ''
      if (v === '') {
        out.videoEmbedUrl = null
      } else if (!isNocookieEmbedUrl(v)) {
        errors.push({ field: 'edits.videoEmbedUrl', code: 'invalid', message: '`edits.videoEmbedUrl` must be a youtube-nocookie.com/embed URL.' })
      } else {
        out.videoEmbedUrl = v
      }
    }
    if (out.occurredStart !== undefined || out.geometry !== undefined || out.imageUrl !== undefined || out.imageAlt !== undefined || out.videoEmbedUrl !== undefined) edits = out
  }

  if (event === undefined && links.length === 0 && addDatasetIds.length === 0 && edits === undefined && errors.length === 0) {
    errors.push({ field: 'event', code: 'empty', message: 'Provide an `event` decision, one or more `links`, `addDatasetIds`, or `edits`.' })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { event, links, addDatasetIds, edits } }
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher

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

  // Two-tier write gate (decision D1). Baseline: the caller must be able
  // to *edit* this event at all (its owner with edit.own, or an editor
  // with edit.any). Additionally, any approve/reject decision — on the
  // event itself or its dataset links — is a *publish* action, so it
  // needs a publishing role. A contributor may correct its own event's
  // metadata (edits-only submit) but cannot approve it; approving an
  // unclaimed feed event requires content.publish.any (editor/admin).
  if (!canMutateEvent(publisher, event)) {
    return jsonError(403, 'forbidden_owner', 'You can only edit events you own.')
  }
  const hasDecision = parsed.value.event != null || parsed.value.links.length > 0
  if (hasDecision && !canReviewEvent(publisher, event)) {
    return jsonError(403, 'forbidden_role', 'Approving or rejecting an event requires a publishing role.')
  }

  // Apply metadata corrections before anything else, so a same-submit
  // approve acts on the corrected event, and re-run the matcher so the
  // T/Ti/G signals score against the curator's values (statuses are
  // preserved; scores refresh, new candidates may propose).
  if (parsed.value.edits) {
    const edits = { ...parsed.value.edits }
    if (edits.pointOnly && edits.geometry) {
      // A point-only edit refines, not replaces: keep the event's
      // existing bbox / region name around the new pin.
      const existing: EventGeometry = {}
      if (event.bbox_n !== null && event.bbox_s !== null && event.bbox_w !== null && event.bbox_e !== null) {
        existing.boundingBox = { n: event.bbox_n, s: event.bbox_s, w: event.bbox_w, e: event.bbox_e }
      }
      if (event.region_name) existing.regionName = event.region_name
      edits.geometry = { ...existing, point: edits.geometry.point }
    }
    await applyEventEdits(db, id, {
      occurredStart: edits.occurredStart,
      geometry: edits.geometry,
      imageUrl: edits.imageUrl,
      imageAlt: edits.imageAlt,
      videoEmbedUrl: edits.videoEmbedUrl,
    })
    // The matcher scores on date/place — an image-only edit changes
    // no signal, so skip the re-run for it.
    if (edits.occurredStart !== undefined || edits.geometry !== undefined) {
      await runMatcherForEvent(db, id, { env: context.env })
    }
  }

  // Seed any hand-picked additions FIRST (so an add + approve can land in
  // one submit). Drop hidden/retracted/unknown datasets via the shared
  // visibility filter, then insert atomically with DO-NOTHING-on-conflict:
  // an already-linked dataset is left untouched (its matcher score is never
  // clobbered), even under a concurrent add or matcher write.
  let addedCount = 0
  if (parsed.value.addDatasetIds.length > 0) {
    const visible = await filterVisibleDatasetIds(db, parsed.value.addDatasetIds)
    for (const datasetId of visible) {
      if (await insertProposedLinkIfAbsent(db, id, datasetId)) addedCount++
    }
  }

  // Every link decision must target a real link of this event. A link of
  // any status is fair game — a curator may revise an earlier decision —
  // so we check existence, not status.
  const existingLinks = await listLinksForEvent(db, id)
  const linkIds = new Set(existingLinks.map(l => l.dataset_id))
  const unknownLinks = parsed.value.links.filter(l => !linkIds.has(l.datasetId))
  if (unknownLinks.length > 0) {
    return validationFailure(
      unknownLinks.map(l => ({
        field: 'links',
        code: 'unknown_link',
        message: `Dataset ${l.datasetId} is not a link of event ${id}.`,
      })),
    )
  }

  if (parsed.value.event) {
    await setEventStatus(db, id, DECISION_TO_STATUS[parsed.value.event], publisher.id)
    // Approving an unclaimed event claims it for the approver (no-op if
    // it already has an owner). Reject never assigns ownership.
    if (parsed.value.event === 'approve') {
      await claimEventOwner(db, id, publisher.id)
    }
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
      added_links: addedCount,
      edits: parsed.value.edits ?? null,
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
      event: updated
        ? { ...toPublicEvent(updated, decorations), can_edit: canMutateEvent(publisher, updated) }
        : null,
      links: links.map(l => ({
        datasetId: l.dataset_id,
        score: l.match_score,
        status: l.status,
      })),
    }),
    { status: 200, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' } },
  )
}
