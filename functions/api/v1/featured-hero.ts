/**
 * Cloudflare Pages Function — GET /api/v1/featured-hero
 *
 * Public, unauthenticated read of the operator's "Right now" hero
 * override (Phase 7 §9.1; see `docs/HERO_ADMIN_SCOPING.md`). Returns
 *
 *   { "hero": { "datasetId", "window": { "start", "end" }, "headline"? } }
 *
 * or `{ "hero": null }` when no override is set.
 *
 * The endpoint returns the RAW override — it does NOT evaluate the
 * activation window or resolve/visibility-check the dataset. The
 * client (`heroService`) applies the same window + resolve logic it
 * uses for the static `featured-now.json` fallback, so "is the hero
 * live right now" has a single source of truth regardless of source.
 *
 * Caching:
 *   - KV-cached at `hero:v1` with a 60 s TTL so a publisher set/clear
 *     takes effect within a minute (the Phase B write routes also
 *     bust the key for immediate effect).
 *   - `Cache-Control` matches.
 *
 * Errors:
 *   - 503 `binding_missing` for missing `CATALOG_DB` — the client
 *     falls back to the static `featured-now.json` on any non-200.
 */

import type { CatalogEnv } from './_lib/env'
import { getHeroOverride, toPublicHero, HERO_CACHE_KEY } from './_lib/hero-override-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_TTL_SECONDS = 60

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }

  if (context.env.CATALOG_KV) {
    const cached = await context.env.CATALOG_KV.get(HERO_CACHE_KEY)
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

  const row = await getHeroOverride(context.env.CATALOG_DB)
  const body = JSON.stringify({ hero: row ? toPublicHero(row) : null })

  if (context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(HERO_CACHE_KEY, body, {
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
