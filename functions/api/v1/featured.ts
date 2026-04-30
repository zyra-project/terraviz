/**
 * Cloudflare Pages Function — GET /api/v1/featured
 *
 * Public read of the operator's curated featured-datasets set,
 * shaped for the docent's `list_featured_datasets` LLM tool. Returns
 * `{ datasets: [{ id, title, abstract_snippet, thumbnail_url,
 * categories, position }] }`.
 *
 * The publisher-API sibling `/api/v1/publish/featured` returns the
 * curation rows themselves (`{ featured: [{ dataset_id, position,
 * added_by, added_at }] }`) for the publisher portal's reorder UI.
 * This endpoint is the unauthenticated docent-facing read; same
 * underlying table, different shape.
 *
 * Query parameters:
 *   - `limit` (optional, 1–24; default 6).
 *
 * Caching:
 *   - KV-cached at `featured:v1:<limit>` with a short TTL (60s) so
 *     a publisher-side reorder takes effect within a minute. The
 *     publisher route's add/update/remove handlers do NOT
 *     invalidate this cache yet — the TTL bound is the contract for
 *     now; an explicit invalidation is a small Phase 4 follow-on
 *     once the curation UI lands.
 *   - Cache-Control follows the same pattern.
 *
 * Errors:
 *   - 503 `binding_missing` for missing `CATALOG_DB`.
 *   - 400 `invalid_request` for an out-of-range `limit`.
 */

import type { CatalogEnv } from './_lib/env'
import {
  FEATURED_DOCENT_DEFAULT_LIMIT,
  FEATURED_DOCENT_MAX_LIMIT,
  listFeaturedForDocent,
} from './_lib/featured-datasets'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_TTL_SECONDS = 60
const FEATURED_CACHE_KEY_PREFIX = 'featured:v1:'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function parseLimit(raw: string | null): number | { error: string; message: string } {
  if (raw == null) return FEATURED_DOCENT_DEFAULT_LIMIT
  if (!/^[0-9]+$/.test(raw)) {
    return { error: 'invalid_request', message: '`limit` must be a positive integer.' }
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > FEATURED_DOCENT_MAX_LIMIT) {
    return {
      error: 'invalid_request',
      message: `\`limit\` must be between 1 and ${FEATURED_DOCENT_MAX_LIMIT}.`,
    }
  }
  return n
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }

  const url = new URL(context.request.url)
  const parsed = parseLimit(url.searchParams.get('limit'))
  if (typeof parsed !== 'number') {
    return jsonError(400, parsed.error, parsed.message)
  }
  const limit = parsed
  const cacheKey = `${FEATURED_CACHE_KEY_PREFIX}${limit}`

  if (context.env.CATALOG_KV) {
    const cached = await context.env.CATALOG_KV.get(cacheKey)
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: {
          'Content-Type': CONTENT_TYPE,
          'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
          'X-Cache': 'HIT',
        },
      })
    }
  }

  const result = await listFeaturedForDocent(context.env, { limit })
  const body = JSON.stringify(result)

  if (context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(cacheKey, body, {
        expirationTtl: CACHE_TTL_SECONDS,
      })
    } catch {
      // Best-effort cache fill.
    }
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      'X-Cache': 'MISS',
    },
  })
}
