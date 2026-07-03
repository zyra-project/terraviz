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
import type { PublisherData } from '../../_middleware'
import { isPrivileged } from '../../../_lib/publisher-store'
import { writeAuditEvent } from '../../../_lib/audit-store'
import { getCurrentEvent, listLinksForEvent } from '../../../_lib/events-store'
import { createDraftTour, writeTourDraftJson } from '../../../_lib/tour-mutations'
import {
  buildEventTourTasks,
  generateTourCaptions,
  MAX_TOUR_STOPS,
  type EventTourDataset,
} from '../../../_lib/event-tour'

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
 *  datasets never become stops. */
async function resolveStopDatasets(db: D1Database, eventId: string): Promise<EventTourDataset[]> {
  const links = await listLinksForEvent(db, eventId)
  const approved = links.filter(l => l.status === 'approved')
  const pool = (approved.length > 0 ? approved : links.filter(l => l.status === 'proposed'))
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
    .slice(0, MAX_TOUR_STOPS)
  if (pool.length === 0) return []

  const placeholders = pool.map(() => '?').join(', ')
  const res = await db
    .prepare(
      `SELECT id, title, start_time, end_time, format FROM datasets
        WHERE id IN (${placeholders})
          AND published_at IS NOT NULL
          AND is_hidden = 0
          AND retracted_at IS NULL`,
    )
    .bind(...pool.map(l => l.dataset_id))
    .all<{ id: string; title: string; start_time: string | null; end_time: string | null; format: string | null }>()
  const byId = new Map((res.results ?? []).map(r => [r.id, r]))
  // Preserve the score order the pool established.
  const out: EventTourDataset[] = []
  for (const link of pool) {
    const row = byId.get(link.dataset_id)
    if (row) {
      out.push({ id: row.id, title: row.title, startTime: row.start_time, endTime: row.end_time, format: row.format })
    }
  }
  return out
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Generating event tours is restricted to admin and service callers.')
  }

  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing event id.')

  const db = context.env.CATALOG_DB
  const event = await getCurrentEvent(db, id)
  if (!event) return jsonError(404, 'not_found', `Event ${id} not found.`)

  const datasets = await resolveStopDatasets(db, id)
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
  const captions = await generateTourCaptions(context.env as never, event, datasets)
  const tourTasks = buildEventTourTasks(event, datasets, captions)

  const created = await createDraftTour(context.env, publisher, { title: `Event: ${event.title}`.slice(0, 200) })
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
