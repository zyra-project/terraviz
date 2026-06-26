/**
 * Cloudflare Pages Function — GET /api/v1/featured-event
 *
 * Public, unauthenticated read of the single current event that should
 * headline the "Right now" hero (`docs/CURRENT_EVENTS_PLAN.md` §6.1):
 * the freshest **approved** event with an **approved** link to a
 * published, visible dataset, within the recency window. Returns
 *
 *   { "event": { "id", "title", "summary"?, "source": { "name", "url",
 *                "publishedAt"? }, "occurredStart"?, "occurredEnd"?,
 *                "datasetId", "datasetTitle" } }
 *
 * or `{ "event": null }` when nothing qualifies.
 *
 * The hero pipeline is curator-gated upstream — this endpoint only ever
 * returns approved content, so it is safe to serve anonymously.
 *
 * Caching mirrors `featured-hero`: KV-cached at `featured-event:v1` with
 * a 60 s TTL (the review route busts the key for immediate effect); a
 * missing `CATALOG_DB` (or a read error, e.g. the table not yet migrated)
 * degrades to `{ event: null }` so `heroService` falls through to its
 * auto-derive pick rather than the catalog breaking.
 */

import type { CatalogEnv } from './_lib/env'
import {
  getFeaturedEvent,
  toPublicFeaturedEvent,
  FEATURED_EVENT_CACHE_KEY,
} from './_lib/events-store'

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
    const cached = await context.env.CATALOG_KV.get(FEATURED_EVENT_CACHE_KEY)
    if (cached) return ok(cached, 'HIT')
  }

  // Degrade to `{ event: null }` on any read failure (most commonly the
  // current_events table not yet migrated). Not cached, so recovery is
  // immediate once the schema exists.
  let row
  try {
    row = await getFeaturedEvent(context.env.CATALOG_DB)
  } catch (err) {
    console.warn(
      '[featured-event] read failed — returning null (table missing / D1 error):',
      err instanceof Error ? err.message : String(err),
    )
    return ok(JSON.stringify({ event: null }), 'BYPASS')
  }

  const body = JSON.stringify({ event: row ? toPublicFeaturedEvent(row) : null })
  if (context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(FEATURED_EVENT_CACHE_KEY, body, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // Best-effort cache fill.
    }
  }
  return ok(body, 'MISS')
}
