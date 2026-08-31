// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — GET /api/v1/datasets/{id}/related
 *
 * Public "more like this" endpoint — semantic related-dataset
 * discovery. Given a dataset id, it seeds a vector search with that
 * dataset's own title + abstract and returns the nearest *other*
 * public datasets, ordered by cosine similarity. This is the semantic
 * upgrade to the client-side lexical `relatedDatasets.ts` scorer
 * (shared categories + keywords), which stays as the offline / degraded
 * fallback (`docs/CURRENT_EVENTS_PLAN.md` Phase 3b).
 *
 * It reuses the existing Vectorize stack wholesale — `searchDatasets`
 * embeds the seed text, queries the index (public-only), and hydrates
 * the hits into the same `{ id, title, abstract_snippet, categories,
 * peer_id, score }` wire shape `/api/v1/search` returns. The only extra
 * step is dropping the seed dataset itself from its own neighbour list.
 *
 * Query parameters:
 *   - `limit` (optional, 1–20; default 5): max neighbours to return.
 *
 * Behaviour / failure modes (inherited from `searchDatasets`):
 *   - Seed dataset not public / not found → 404.
 *   - Embed bindings unconfigured → `{ datasets: [], degraded:
 *     'unconfigured' }` (the client falls back to the lexical scorer).
 *   - Workers AI quota exhausted → `degraded: 'quota_exhausted'`.
 *   - Missing `CATALOG_DB` → 503.
 *
 * Caching: KV (`CATALOG_KV`) under `related:v1:<id>:<limit>` for 60 s,
 * mirroring `/api/v1/search`. Degraded responses are never cached so an
 * operator wiring Vectorize for the first time sees results immediately.
 */

import type { CatalogEnv } from '../../_lib/env'
import { getPublicDataset } from '../../_lib/catalog-store'
import {
  searchDatasets,
  type SearchDatasetsHit,
  type SearchDatasetsResult,
} from '../../_lib/search-datasets'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_TTL_SECONDS = 60
const CACHE_KEY_PREFIX = 'related:v1:'

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20

/** Characters of seed text (title + abstract) fed to the embedder.
 *  Matches the spirit of the search endpoint's 200-char query cap —
 *  the title plus a sentence or two of abstract is plenty of signal
 *  for the BGE model, and keeps the embed call cheap. */
const SEED_TEXT_MAX = 400

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

/** Build the embed seed text from a dataset row. Title carries the
 *  strongest signal; the abstract refines it. Lowercased to match the
 *  `/api/v1/search` canonicalisation (BGE is case-insensitive at the
 *  token level). */
function seedTextFor(row: { title: string; abstract: string | null }): string {
  const parts = [row.title, row.abstract ?? ''].map(p => p.trim()).filter(p => p.length > 0)
  return parts.join('. ').normalize('NFC').slice(0, SEED_TEXT_MAX).toLowerCase()
}

function parseLimit(url: URL): number | { error: string; message: string } {
  const raw = url.searchParams.get('limit')
  if (raw == null) return DEFAULT_LIMIT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return {
      error: 'invalid_request',
      message: `Query parameter \`limit\` must be an integer between 1 and ${MAX_LIMIT}.`,
    }
  }
  return parsed
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }

  const limitOrError = parseLimit(new URL(context.request.url))
  if (typeof limitOrError !== 'number') {
    return jsonError(400, limitOrError.error, limitOrError.message)
  }
  const limit = limitOrError

  // Resolve the seed dataset — public rows only, so a private / hidden
  // / retracted id can't be used to probe the index.
  const seed = await getPublicDataset(context.env.CATALOG_DB, id)
  if (!seed) return jsonError(404, 'not_found', `Dataset ${id} not found.`)

  const cacheKey = `${CACHE_KEY_PREFIX}${id}:${limit}`
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

  const seedText = seedTextFor(seed)
  // A row with an empty title AND abstract has nothing to embed —
  // return an empty (non-degraded) neighbour set rather than a useless
  // embed call.
  let result: SearchDatasetsResult
  if (seedText.length === 0) {
    result = { datasets: [] }
  } else {
    // Over-fetch by one so dropping the seed itself (its own nearest
    // neighbour) still leaves a full `limit` of real neighbours.
    const raw = await searchDatasets(context.env, {
      query: seedText,
      limit: limit + 1,
      filters: { peer_id: 'local' },
    })
    const datasets: SearchDatasetsHit[] = raw.datasets.filter(hit => hit.id !== id).slice(0, limit)
    result = raw.degraded ? { datasets, degraded: raw.degraded } : { datasets }
  }

  const body = JSON.stringify(result)
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPE,
    'X-Cache': 'MISS',
  }
  if (result.degraded) {
    headers['Cache-Control'] = 'no-store'
    headers.Warning = `199 - "related degraded: ${result.degraded}"`
  } else {
    headers['Cache-Control'] = `public, max-age=${CACHE_TTL_SECONDS}`
    if (context.env.CATALOG_KV) {
      try {
        await context.env.CATALOG_KV.put(cacheKey, body, { expirationTtl: CACHE_TTL_SECONDS })
      } catch {
        // Best-effort cache fill; serving the response wins.
      }
    }
  }

  return new Response(body, { status: 200, headers })
}
