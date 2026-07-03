/**
 * GET /api/v1/blog — the public list of published posts (Phase 3d;
 * `docs/CURRENT_EVENTS_PLAN.md` §7 companion work).
 *
 * Lean card shape (no body markdown): slug, title, summary, publish
 * time, and the cited-dataset count. Caching mirrors `events.ts`:
 * KV-cached at `blog:list:v1` with a 60 s TTL; the publish/unpublish
 * routes bust it so changes are live within a tick. Degrades to
 * `{ posts: [] }` with `no-store` on any read failure (most commonly
 * the table not yet migrated) so nothing caches the empty list.
 */

import type { CatalogEnv } from './_lib/env'
import { BLOG_LIST_CACHE_KEY, listPublishedPosts, toPublicPost } from './_lib/blog-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_TTL_SECONDS = 60

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function ok(body: string, xCache: 'HIT' | 'MISS'): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      'X-Cache': xCache,
    },
  })
}

function degraded(): Response {
  return new Response(JSON.stringify({ posts: [] }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store', 'X-Cache': 'BYPASS' },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }

  if (context.env.CATALOG_KV) {
    try {
      const cached = await context.env.CATALOG_KV.get(BLOG_LIST_CACHE_KEY)
      if (cached) return ok(cached, 'HIT')
    } catch {
      // KV failure = cache miss; D1 is the source of truth.
    }
  }

  let rows
  try {
    rows = await listPublishedPosts(context.env.CATALOG_DB)
  } catch (err) {
    console.warn(
      '[blog] list read failed — returning empty list (table missing / D1 error):',
      err instanceof Error ? err.message : String(err),
    )
    return degraded()
  }

  const posts = rows.map(r => ({
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    publishedAt: r.published_at,
    // toPublicPost's parse is corruption-tolerant (a bad JSON blob
    // counts as zero, not a 500 on the public list).
    datasetCount: toPublicPost(r).datasetIds.length,
  }))
  const body = JSON.stringify({ posts })
  if (context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(BLOG_LIST_CACHE_KEY, body, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // Best-effort cache fill.
    }
  }
  return ok(body, 'MISS')
}
