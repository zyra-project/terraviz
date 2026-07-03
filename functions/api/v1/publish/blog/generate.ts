/**
 * POST /api/v1/publish/blog/generate — AI-draft a blog post from the
 * curator's selections (Phase 3d; `docs/CURRENT_EVENTS_PLAN.md` §7).
 *
 * Body: `{ datasetIds: string[], eventId?, tone?, length?,
 * includeTour? }`. Gathers the node profile (0028), the cited event,
 * and the visible selected datasets, then asks Workers AI for a
 * grounded markdown draft. The draft is RETURNED, not persisted — the
 * curator edits it in the portal and saves through the normal create
 * route; publishing stays a separate action.
 *
 * `includeTour: true` (with an `eventId`) additionally emits the §7
 * companion tour — the same generator the events tab's "Generate
 * tour" uses, but over the curator's hand-picked datasets — persisted
 * as a normal editable tour draft. A tour failure never sinks the
 * draft: the response carries `tour: null` and the reason instead.
 *
 * Privileged-only; audit-logged (`blog.generate`). Generation IS the
 * feature here, so no-AI is a typed 503 and an unusable reply a 502 —
 * unlike enrichment there is no useful deterministic fallback for a
 * whole post.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { EnrichEnv } from '../../_lib/events-enrich'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { writeAuditEvent } from '../../_lib/audit-store'
import { getNodeProfile } from '../../_lib/node-profile-store'
import { getCurrentEvent } from '../../_lib/events-store'
import { generateBlogDraft, type BlogDraftLength } from '../../_lib/blog-generate'
import { resolveHttpAssetUrl } from '../../_lib/r2-public-url'
import { buildEventTourTasks, generateTourCaptions, type EventTourDataset } from '../../_lib/event-tour'
import { createDraftTour, deleteTour, writeTourDraftJson } from '../../_lib/tour-mutations'
import { POST_MAX_DATASETS } from '../../_lib/blog-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

interface GenerateBody {
  datasetIds?: unknown
  eventId?: unknown
  tone?: unknown
  length?: unknown
  includeTour?: unknown
}

export const onRequestPost: PagesFunction<CatalogEnv & EnrichEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Generating blog drafts is restricted to admin and service callers.')
  }

  let body: GenerateBody
  try {
    body = (await context.request.json()) as GenerateBody
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const rawIds = Array.isArray(body.datasetIds) ? body.datasetIds : []
  const datasetIds = [...new Set(rawIds.filter((v): v is string => typeof v === 'string' && v.length > 0))].slice(
    0,
    POST_MAX_DATASETS,
  )
  if (datasetIds.length === 0) {
    return jsonError(400, 'no_datasets', 'Select at least one dataset to ground the draft in.')
  }
  const tone = typeof body.tone === 'string' ? body.tone : null
  const length: BlogDraftLength =
    body.length === 'short' || body.length === 'long' ? body.length : 'medium'
  const includeTour = body.includeTour === true

  const db = context.env.CATALOG_DB

  // Visible selected datasets — the same filter every public surface
  // applies; a hidden selection silently drops out of the grounding.
  const placeholders = datasetIds.map(() => '?').join(', ')
  const dsRes = await db
    .prepare(
      `SELECT id, title, abstract, start_time, end_time, format, thumbnail_ref FROM datasets
        WHERE id IN (${placeholders})
          AND published_at IS NOT NULL
          AND is_hidden = 0
          AND retracted_at IS NULL`,
    )
    .bind(...datasetIds)
    .all<{ id: string; title: string; abstract: string | null; start_time: string | null; end_time: string | null; format: string | null; thumbnail_ref: string | null }>()
  const byId = new Map((dsRes.results ?? []).map(r => [r.id, r]))
  const datasets = datasetIds.flatMap(id => {
    const row = byId.get(id)
    return row ? [row] : []
  })
  if (datasets.length === 0) {
    return jsonError(400, 'no_datasets', 'None of the selected datasets are visible in the catalog.')
  }

  let event = null
  if (typeof body.eventId === 'string' && body.eventId.length > 0) {
    event = await getCurrentEvent(db, body.eventId)
    if (!event) return jsonError(404, 'not_found', `Event ${body.eventId} not found.`)
  }

  const profile = await getNodeProfile(db)

  const outcome = await generateBlogDraft(context.env, {
    profile,
    event,
    datasets: datasets.map(d => ({ id: d.id, title: d.title, abstract: d.abstract })),
    tone,
    length,
  })
  if (!outcome.ok) {
    return jsonError(outcome.error === 'ai_unavailable' ? 503 : 502, outcome.error, outcome.message)
  }

  // Companion tour (§7): same generator as the events tab, over the
  // curator's hand-picked datasets. Best-effort — a failure here must
  // not sink the draft the model already produced.
  let tour: { id: string; slug: string; title: string } | null = null
  let tourError: string | null = null
  if (includeTour && event) {
    try {
      const tourDatasets: EventTourDataset[] = datasets.map(d => ({
        id: d.id,
        title: d.title,
        startTime: d.start_time,
        endTime: d.end_time,
        format: d.format,
        thumbnailUrl: resolveHttpAssetUrl(context.env, d.thumbnail_ref),
      }))
      const captions = await generateTourCaptions(context.env, event, tourDatasets)
      const tourTasks = buildEventTourTasks(event, tourDatasets, captions)
      const created = await createDraftTour(context.env, publisher, {
        title: `Event: ${event.title}`.slice(0, 200),
      })
      if (!created.ok) {
        tourError = created.errors?.[0]?.message ?? 'Could not create the tour draft.'
      } else {
        const written = await writeTourDraftJson(context.env, publisher, created.tour.id, { tourTasks })
        if (!written.ok) {
          tourError = written.message
          // Honour the tour:null contract — don't leave an empty,
          // undiscoverable draft row behind. Best-effort: a failed
          // cleanup just means a stray empty draft in /publish/tours.
          try {
            await deleteTour(context.env, publisher, created.tour.id)
          } catch {
            // The row survives as a visible (deletable) empty draft.
          }
        } else {
          tour = { id: written.tour.id, slug: written.tour.slug, title: written.tour.title }
        }
      }
    } catch (e) {
      // Log the real failure server-side; the wire gets a generic
      // message (CodeQL: no exception internals in responses).
      console.warn('[blog-generate] companion tour failed:', e instanceof Error ? e.message : String(e))
      tourError = 'Tour generation failed — see the deployment logs.'
    }
  } else if (includeTour && !event) {
    tourError = 'A companion tour needs a cited event for its fly-to and timing.'
  }

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'blog.generate',
    subject_kind: 'blog_post',
    subject_id: null,
    metadata_json: JSON.stringify({
      datasets: datasets.length,
      event: event ? event.id : null,
      tour_id: tour?.id ?? null,
    }),
  })

  return new Response(JSON.stringify({ draft: outcome.draft, tour, tourError }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
