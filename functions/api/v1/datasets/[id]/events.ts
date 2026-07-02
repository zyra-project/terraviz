/**
 * Cloudflare Pages Function — GET /api/v1/datasets/{id}/events
 *
 * Public, unauthenticated read of the APPROVED current events that relate
 * to one dataset — the info panel's "In the news" section
 * (`docs/CURRENT_EVENTS_PLAN.md` §6, "In the news" surface). The reverse
 * of `GET /api/v1/events`: given a dataset, return the approved events
 * that carry an `approved` link to it, each with enough to render a cited
 * card (headline + source link + when):
 *
 *   { "events": [ { "id", "title", "summary"?,
 *                   "source": { "name", "url", "publishedAt"? },
 *                   "occurredStart"?, "occurredEnd"?, "geometry",
 *                   "datasetIds": [ … ] } ] }
 *
 * Curator-gated upstream (approved event + approved link only), so it is
 * safe to serve anonymously. No KV cache — the query is cheap and
 * per-dataset, and skipping KV avoids a stale-after-approval coordination
 * problem; a short `Cache-Control` (60 s) lets the edge/browser coalesce.
 * A read error (e.g. the table not yet migrated) degrades to a `no-store`
 * `{ events: [] }` so the panel simply doesn't render and recovers once
 * the schema exists.
 */

import type { CatalogEnv } from '../../_lib/env'
import { listApprovedEventsForDataset } from '../../_lib/events-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_TTL_SECONDS = 60

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }

  try {
    const events = await listApprovedEventsForDataset(context.env.CATALOG_DB, id)
    return new Response(JSON.stringify({ events }), {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPE,
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    })
  } catch (err) {
    // Graceful absence — the client treats any non-{events:[…]} shape or a
    // read failure as "no panel", so an un-migrated table shows nothing.
    // Log first so an operator can tell a genuine D1 error apart from the
    // expected pre-migration case (mirrors `events.ts` / `featured-event.ts`).
    console.warn(
      `[dataset-events] read failed for dataset ${id} — returning empty list (table missing / D1 error):`,
      err instanceof Error ? err.message : String(err),
    )
    return new Response(JSON.stringify({ events: [] }), {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store' },
    })
  }
}
