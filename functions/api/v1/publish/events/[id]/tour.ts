/**
 * POST /api/v1/publish/events/:id/tour — generate an editable tour
 * draft from a current event (`docs/CURRENT_EVENTS_PLAN.md` §7).
 *
 * Bundles the event's geometry/time/prose with its vetted dataset
 * pairings (approved links first; top-scored proposed links only when
 * nothing is approved yet), writes AI-assisted captions (template
 * fallback when Workers AI is unbound — generation never blocks on the
 * model), and persists the result through the normal draft-tour
 * pipeline (`createDraftTour` + `writeTourDraftJson`). The response
 * carries the new tour row; the portal links straight into the
 * authoring dock (`/?tourEdit=<id>`) so the curator polishes captions
 * and timing before publishing — nothing auto-publishes.
 *
 * Privileged-only (admin / service), audit-logged
 * (`event.tour_generated`).
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { EnrichEnv } from '../../../_lib/events-enrich'
import type { PublisherData } from '../../_middleware'
import { getEffectiveFeatures } from '../../../_lib/node-settings-store'
import { writeAuditEvent } from '../../../_lib/audit-store'
import { canMutateEvent, getCurrentEvent, listLinksForEvent } from '../../../_lib/events-store'
import { getDecorations, type DecorationRows } from '../../../_lib/catalog-store'
import { orderTourStops, type StopCandidate } from '../../../_lib/tour-stop-order'
import { resolveHttpAssetUrl } from '../../../_lib/r2-public-url'
import { createDraftTour, writeTourDraftJson } from '../../../_lib/tour-mutations'
import {
  buildEventTourTasks,
  generateTourCaptions,
  MAX_TOUR_STOPS,
  type EventTourDataset,
} from '../../../_lib/event-tour'
import { allowlistedContentHosts } from '../../../_lib/video-index-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

/** Resolve the event's stop datasets: approved pairings first (the
 *  curator's vetted story), top-scored proposed ones only as a fallback
 *  so a tour can be previewed pre-approval. Hidden/retracted/unpublished
 *  datasets never become stops — and the visibility filter runs over the
 *  whole candidate pool BEFORE the stop cap, so a hidden top-scored link
 *  yields the next visible one rather than a hole (or a spurious
 *  `no_datasets`).
 *
 *  Order comes from `orderTourStops` rather than the match ranking
 *  (`docs/TOUR_DIRECTION_PLAN.md` D1): the strongest pairing still
 *  opens, but the stops after it trade a little match score for not
 *  looking like the stop before. Four visible candidates sharing a
 *  facet and a bounding box used to run back to back purely because
 *  the matcher scored them together. */
async function resolveStopDatasets(
  db: D1Database,
  eventId: string,
  resolveThumb: (ref: string | null) => string | null,
): Promise<EventTourDataset[]> {
  const links = await listLinksForEvent(db, eventId)
  const approved = links.filter(l => l.status === 'approved')
  const pool = (approved.length > 0 ? approved : links.filter(l => l.status === 'proposed'))
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
    // Wide candidate window, bounded only by D1's bind-variable budget
    // (mirrors D1_BIND_BATCH in catalog-store.ts); the stop cap is
    // applied after the visibility filter below.
    .slice(0, 80)
  if (pool.length === 0) return []

  const placeholders = pool.map(() => '?').join(', ')
  const res = await db
    .prepare(
      `SELECT id, title, start_time, end_time, format, thumbnail_ref,
              bbox_n, bbox_s, bbox_w, bbox_e FROM datasets
        WHERE id IN (${placeholders})
          AND published_at IS NOT NULL
          AND is_hidden = 0
          AND retracted_at IS NULL`,
    )
    .bind(...pool.map(l => l.dataset_id))
    .all<{
      id: string
      title: string
      start_time: string | null
      end_time: string | null
      format: string | null
      thumbnail_ref: string | null
      bbox_n: number | null
      bbox_s: number | null
      bbox_w: number | null
      bbox_e: number | null
    }>()
  const byId = new Map((res.results ?? []).map(r => [r.id, r]))

  // Visible candidates only, in link order — the sequencer re-orders,
  // but it must never be handed a dataset that failed the filter.
  const visible = pool.map(l => byId.get(l.dataset_id)).filter(r => r !== undefined)
  if (visible.length === 0) return []

  // Facets for the variety signal, through the existing batched
  // decoration loader (it chunks against D1's bind budget already).
  // A failure here degrades to score order rather than sinking the
  // tour: worse sequencing beats no tour.
  let decorations = new Map<string, DecorationRows>()
  try {
    decorations = await getDecorations(db, visible.map(r => r.id))
  } catch {
    decorations = new Map()
  }

  const scoreByDataset = new Map(pool.map(l => [l.dataset_id, l.match_score]))
  const candidates: StopCandidate[] = visible.map(row => {
    const decoration = decorations.get(row.id)
    const hasBbox =
      row.bbox_n !== null && row.bbox_s !== null && row.bbox_w !== null && row.bbox_e !== null
    return {
      id: row.id,
      matchScore: scoreByDataset.get(row.id) ?? null,
      categories: (decoration?.categories ?? []).map(c => `${c.facet}:${c.value}`),
      keywords: decoration?.keywords ?? [],
      bbox: hasBbox
        ? { n: row.bbox_n!, s: row.bbox_s!, w: row.bbox_w!, e: row.bbox_e! }
        : null,
    }
  })

  // Cap AFTER the visibility filter so the draft always gets the best
  // visible stops, and after ordering so the cap keeps a varied four
  // rather than the four the matcher happened to rank together.
  const ordered = orderTourStops(candidates, { limit: MAX_TOUR_STOPS })
  const out: EventTourDataset[] = []
  for (const id of ordered) {
    const row = byId.get(id)
    if (!row) continue
    out.push({
      id: row.id,
      title: row.title,
      startTime: row.start_time,
      endTime: row.end_time,
      format: row.format,
      thumbnailUrl: resolveThumb(row.thumbnail_ref),
    })
  }
  return out
}

export const onRequestPost: PagesFunction<CatalogEnv & EnrichEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher

  // Cross-feature coupling: the middleware gates this path on `events`
  // (its prefix), but the handler CREATES a tour draft — that needs
  // the tours feature too.
  if (!(await getEffectiveFeatures(context.env)).tours) {
    return new Response(
      JSON.stringify({
        error: 'feature_disabled',
        feature: 'tours',
        message: 'The tours feature is disabled on this node — an event tour cannot be created.',
      }),
      { status: 403, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing event id.')

  const db = context.env.CATALOG_DB
  const event = await getCurrentEvent(db, id)
  if (!event) return jsonError(404, 'not_found', `Event ${id} not found.`)
  // Owner-scoped write: the owner writes via content.edit.own; an
  // unclaimed event (owner_id null) requires content.edit.any
  // (editor/admin/service). See canMutateEvent.
  if (!canMutateEvent(publisher, event)) {
    return jsonError(403, 'forbidden_owner', 'You can only build tours for events you own.')
  }

  const datasets = await resolveStopDatasets(db, id, ref => resolveHttpAssetUrl(context.env, ref))
  if (datasets.length === 0) {
    // Carries the `errors: [...]` field envelope alongside the plain
    // `{ error, message }` shape so the portal's publisherSend client
    // surfaces the specific message rather than a generic 400 toast.
    const message = 'This event has no visible dataset pairings to build tour stops from.'
    return new Response(
      JSON.stringify({
        error: 'no_datasets',
        message,
        errors: [{ field: 'links', code: 'no_datasets', message }],
      }),
      { status: 400, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  // Captions: AI-written when the binding exists, deterministic
  // templates otherwise — the tour generator never blocks on the model.
  const captions = await generateTourCaptions(context.env, event, datasets)
  // The registered-source host allowlist authoritatively guards a
  // curator-picked direct-file video before it's emitted as a native
  // <video> stop (played through the media-proxy for VR CORS).
  const allowedVideoHosts = await allowlistedContentHosts(context.env.CATALOG_DB)
  const tourTasks = buildEventTourTasks(event, datasets, captions, { allowedVideoHosts })

  const created = await createDraftTour(context.env, publisher, {
    title: `Event: ${event.title}`.slice(0, 200),
    // The vetted story image doubles as the tour's catalog-card
    // thumbnail — a generated tour otherwise ships with none.
    thumbnailRef: event.image_url && /^https?:\/\//i.test(event.image_url) ? event.image_url : null,
  })
  if (!created.ok) {
    return jsonError(created.status, 'tour_create_failed', created.errors?.[0]?.message ?? 'Could not create the tour draft.')
  }
  const written = await writeTourDraftJson(context.env, publisher, created.tour.id, { tourTasks })
  if (!written.ok) {
    return jsonError(written.status, written.error, written.message)
  }

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'event.tour_generated',
    subject_kind: 'event',
    subject_id: id,
    metadata_json: JSON.stringify({
      tour_id: created.tour.id,
      stops: datasets.map(d => d.id),
    }),
  })

  return new Response(
    JSON.stringify({ tour: { id: written.tour.id, slug: written.tour.slug, title: written.tour.title } }),
    { status: 201, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' } },
  )
}
