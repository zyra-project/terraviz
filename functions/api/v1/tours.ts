/**
 * GET /api/v1/tours
 *
 * Phase 3pt/G follow-up — public tour discovery. Returns the
 * published, non-retracted tours visible to the caller. The SPA
 * uses this to render tour cards alongside dataset cards in the
 * Browse overlay; federation peers will use it (or its
 * `/api/v1/federation/feed/tours` cousin in Phase 4) to mirror
 * the local catalog.
 *
 * Visibility tiers (gated server-side):
 *   - 'public'     — anyone
 *   - 'federated'  — federation peers + signed-in viewers
 *   - 'restricted' — signed-in viewers only
 *   - 'private'    — never surfaced here (publisher-only via
 *                    /api/v1/publish/tours)
 *
 * v1 of this endpoint treats every caller as anonymous (only
 * 'public' rows are returned). Once Phase 4 federation lands a
 * peer-identity mechanism + the SPA acquires a signed-in
 * notion, callers will pass through here at their appropriate
 * tier — the predicate in `listPublicTours` already accepts
 * the viewer level so the routing change is one parameter.
 *
 * Pagination: `?cursor=<id>&limit=<n>` — ULID lexicographic
 * order, `id < ?` for next-page. Same shape the publisher list
 * uses. Default `limit=50`, capped at 200.
 *
 * Caching: `Cache-Control: public, max-age=60,
 * stale-while-revalidate=300` matches the public catalog
 * endpoint. A snapshot/etag layer like `/api/v1/catalog` can be
 * bolted on once tour traffic warrants it; for v1 the D1 read
 * is fast enough and `invalidateSnapshot` already runs on every
 * tour publish/retract for the catalog snapshot.
 */

import type { CatalogEnv } from './_lib/env'
import { listPublicTours, type TourRow } from './_lib/tour-mutations'
import { resolveAssetRefStrict } from './_lib/r2-public-url'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

interface PublicTourListItem {
  id: string
  slug: string
  origin_node: string
  title: string
  description: string | null
  /** Resolved HTTPS URL for the immutable published tour JSON, or
   * null if R2 isn't bound on this deployment (the SPA should
   * gracefully degrade — show the card, refuse to launch). */
  tour_json_url: string | null
  /** Resolved HTTPS URL for the thumbnail, or null if missing /
   * unresolved. */
  thumbnail_url: string | null
  visibility: string
  schema_version: number
  created_at: string
  updated_at: string
  published_at: string
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function bindingMissingResponse(): Response {
  return jsonError(
    503,
    'binding_missing',
    'CATALOG_DB binding is not configured on this deployment.',
  )
}

function serializeTour(env: CatalogEnv, row: TourRow): PublicTourListItem {
  return {
    id: row.id,
    slug: row.slug,
    origin_node: row.origin_node,
    title: row.title,
    description: row.description,
    tour_json_url: resolveAssetRefStrict(env, row.tour_json_ref),
    thumbnail_url: resolveAssetRefStrict(env, row.thumbnail_ref),
    visibility: row.visibility,
    schema_version: row.schema_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // listPublicTours filters out NULL published_at rows.
    published_at: row.published_at!,
  }
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) return bindingMissingResponse()
  const url = new URL(context.request.url)
  const limitRaw = url.searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (limitRaw != null) {
    if (!/^\d+$/.test(limitRaw)) {
      return jsonError(
        400,
        'invalid_request',
        `limit must be a base-10 integer in [1, ${MAX_LIMIT}].`,
      )
    }
    const n = parseInt(limitRaw, 10)
    if (n < 1 || n > MAX_LIMIT) {
      return jsonError(
        400,
        'invalid_request',
        `limit must be a base-10 integer in [1, ${MAX_LIMIT}].`,
      )
    }
    limit = n
  }
  const cursor = url.searchParams.get('cursor') ?? undefined
  const result = await listPublicTours(context.env, {
    limit,
    cursor,
    viewer: 'anonymous',
  })
  const body = {
    schema_version: 1,
    tours: result.tours.map(r => serializeTour(context.env, r)),
    next_cursor: result.next_cursor,
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': CACHE_CONTROL },
  })
}
