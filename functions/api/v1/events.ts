/**
 * Cloudflare Pages Function — GET /api/v1/events
 *
 * Public, unauthenticated read of the APPROVED current events for the
 * catalog Map / Timeline overlays (`docs/CURRENT_EVENTS_PLAN.md` §6.3):
 * each approved event within the recency window that has an approved link
 * to a published, visible dataset, carrying enough to plot it in space +
 * time, cite it, and click through to a dataset:
 *
 *   { "events": [ { "id", "title", "summary"?,
 *                   "source": { "name", "url", "publishedAt"? },
 *                   "occurredStart"?, "occurredEnd"?, "geometry",
 *                   "datasetIds": [ … ] } ] }
 *
 * Curator-gated upstream — only approved content with approved links to
 * visible datasets is ever returned, so it is safe to serve anonymously.
 *
 * Caching mirrors `featured-event`: KV-cached at `events-list:v1` with a
 * 60 s TTL (the review route busts the key on approve/reject); a missing
 * `CATALOG_DB` (or a read error, e.g. the table not yet migrated) degrades
 * to `{ events: [] }` so the catalog views simply show no overlay rather
 * than breaking.
 */

import type { CatalogEnv } from './_lib/env'
import { listPublicEvents, EVENTS_LIST_CACHE_KEY } from './_lib/events-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_TTL_SECONDS = 60

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function ok(body: string, xCache: 'HIT' | 'MISS' | 'BYPASS'): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      'X-Cache': xCache,
    },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }

  if (context.env.CATALOG_KV) {
    const cached = await context.env.CATALOG_KV.get(EVENTS_LIST_CACHE_KEY)
    if (cached) return ok(cached, 'HIT')
  }

  // Degrade to `{ events: [] }` on any read failure (most commonly the
  // current_events table not yet migrated). Not cached, so recovery is
  // immediate once the schema exists.
  let events
  try {
    events = await listPublicEvents(context.env.CATALOG_DB)
  } catch (err) {
    console.warn(
      '[events] read failed — returning empty list (table missing / D1 error):',
      err instanceof Error ? err.message : String(err),
    )
    return ok(JSON.stringify({ events: [] }), 'BYPASS')
  }

  const body = JSON.stringify({ events })
  if (context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(EVENTS_LIST_CACHE_KEY, body, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // Best-effort cache fill.
    }
  }
  return ok(body, 'MISS')
}
