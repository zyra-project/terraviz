/**
 * GET /api/v1/blog/:slug — one published post, hydrated for the public
 * page (Phase 3d).
 *
 * Returns the full markdown body plus:
 *   - `datasets`: `{ id, title }` for each cited dataset that is
 *     currently published/visible — hidden or retracted datasets are
 *     silently omitted so a citation can't leak catalog state.
 *   - `event`: the cited current event's title + source citation, but
 *     ONLY while that event is `approved` — a draft/rejected event's
 *     existence must not leak through a post citation.
 *
 * 404 for unknown slugs AND drafts (indistinguishable, deliberately).
 * KV-cached per slug (`blog:post:<slug>:v1`, 60 s TTL); the authoring
 * writes bust it. Degrades to 404 `no-store` on read failure.
 */

import type { CatalogEnv } from '../_lib/env'
import { blogPostCacheKey, getPublishedBySlug, toPublicPost } from '../_lib/blog-store'
import { getCurrentEvent } from '../_lib/events-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_TTL_SECONDS = 60

/** Generated-slug shape (see blog-store's deriveBlogSlug): lowercase
 *  alphanumerics + hyphens, ≤64 chars. Anything else can't be a real
 *  post, so it 404s before touching KV or D1 — and can't feed an
 *  arbitrary/oversized string into a KV key. */
const SLUG_RE = /^[a-z0-9-]{1,64}$/
/** D1 bind-variable budget for the dataset-title hydration (mirrors
 *  D1_BIND_BATCH in catalog-store.ts; POST_MAX_DATASETS is 20, so one
 *  chunk always suffices). */
const MAX_HYDRATE = 80

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'not_found', message: 'No such post.' }), {
    status: 404,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store' },
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

export const onRequestGet: PagesFunction<CatalogEnv, 'slug'> = async context => {
  if (!context.env.CATALOG_DB) {
    return new Response(
      JSON.stringify({ error: 'binding_missing', message: 'CATALOG_DB binding is not configured on this deployment.' }),
      { status: 503, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }
  const raw = context.params.slug
  const slug = Array.isArray(raw) ? raw[0] : raw
  if (!slug || !SLUG_RE.test(slug)) return notFound()

  const cacheKey = blogPostCacheKey(slug)
  if (context.env.CATALOG_KV) {
    try {
      const cached = await context.env.CATALOG_KV.get(cacheKey)
      if (cached) return ok(cached, 'HIT')
    } catch {
      // KV failure = cache miss; D1 is the source of truth.
    }
  }

  // One degrade guard around EVERY read — the post lookup and both
  // hydration queries. A transient D1 failure anywhere must yield the
  // documented `no-store` 404, never a 500 from a public route.
  let pub
  let datasets: Array<{ id: string; title: string }> = []
  let event: { id: string; title: string; sourceName: string; sourceUrl: string } | null = null
  try {
    const row = await getPublishedBySlug(context.env.CATALOG_DB, slug)
    if (!row) return notFound()
    pub = toPublicPost(row)

    // Hydrate cited-dataset titles, visibility-filtered — the same
    // filter every public dataset surface applies.
    const ids = pub.datasetIds.slice(0, MAX_HYDRATE)
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ')
      const res = await context.env.CATALOG_DB
        .prepare(
          `SELECT id, title FROM datasets
            WHERE id IN (${placeholders})
              AND published_at IS NOT NULL
              AND is_hidden = 0
              AND retracted_at IS NULL`,
        )
        .bind(...ids)
        .all<{ id: string; title: string }>()
      const byId = new Map((res.results ?? []).map(r => [r.id, r]))
      datasets = ids.flatMap(id => {
        const hit = byId.get(id)
        return hit ? [{ id: hit.id, title: hit.title }] : []
      })
    }

    // Cited event: only surfaced while approved.
    if (pub.eventId) {
      const ev = await getCurrentEvent(context.env.CATALOG_DB, pub.eventId)
      if (ev && ev.status === 'approved') {
        event = { id: ev.id, title: ev.title, sourceName: ev.source_name, sourceUrl: ev.source_url }
      }
    }
  } catch (err) {
    console.warn(
      '[blog] post read failed (table missing / D1 error):',
      err instanceof Error ? err.message : String(err),
    )
    return notFound()
  }

  const body = JSON.stringify({
    post: {
      slug: pub.slug,
      title: pub.title,
      summary: pub.summary,
      bodyMd: pub.bodyMd,
      publishedAt: pub.publishedAt,
      datasets,
      event,
    },
  })
  if (context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(cacheKey, body, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // Best-effort cache fill.
    }
  }
  return ok(body, 'MISS')
}
