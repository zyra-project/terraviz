/**
 * Cloudflare Pages Function — GET /api/v1/search?q=...
 *
 * Public semantic-search endpoint. Embeds the query, queries the
 * Vectorize index, hydrates dataset rows from D1, returns
 * `{ datasets: [{ id, title, abstract_snippet, categories,
 * peer_id, score }] }`.
 *
 * Query parameters:
 *   - `q`         (required, 1–200 chars): the search text.
 *   - `limit`     (optional, 1–50; default 10): number of hits.
 *   - `category`  (optional): exact-match filter, lowercased.
 *   - `peer_id`   (optional): `'local'` (translated to the local
 *                 node id) or a peer node id. Defaults to `'local'`
 *                 when omitted, so federated peers are excluded by
 *                 default — matching the plan's federation-opt-in
 *                 stance (CATALOG_BACKEND_PLAN.md "Per-peer inclusion
 *                 in the docent"). Pass an explicit peer node id to
 *                 search a specific peer's content.
 *
 * Caching:
 *   - The most-common query shapes are cached in KV under a
 *     content-derived key with a short TTL (60s). The cache lives
 *     under `CATALOG_KV` so it shares a binding with the
 *     full-catalog snapshot. Distinct query / filters / limit
 *     combinations get their own keys; the cache shape is
 *     `search:v1:<sha256(canonicalised options)>`.
 *   - No If-None-Match support: search hits are short-lived and
 *     not really meant to ETag-revalidate; clients refetch when
 *     the user types.
 *   - When the embed bindings aren't wired (`degraded:
 *     'unconfigured'`) the response is NOT cached — operators
 *     wiring up Vectorize for the first time get fresh results
 *     immediately rather than serving 60 s of empty payloads from
 *     KV.
 *
 * Errors:
 *   - 400 `invalid_request` for missing / overlong `q` or
 *     out-of-range `limit`.
 *   - 503 `binding_missing` for missing `CATALOG_DB`.
 *   - 5xx for upstream Vectorize / Workers AI failures the helper
 *     bubbles up.
 */

import type { CatalogEnv } from './_lib/env'
import {
  searchDatasets,
  type SearchDatasetsResult,
} from './_lib/search-datasets'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_TTL_SECONDS = 60
const SEARCH_CACHE_KEY_PREFIX = 'search:v1:'

const MAX_QUERY_LENGTH = 200
const MAX_LIMIT = 50

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

interface ParsedRequest {
  q: string
  limit: number
  category: string | undefined
  /** Always populated — defaults to 'local' when the URL omits the param. */
  peer_id: string
}

function parseRequest(url: URL): ParsedRequest | { error: string; message: string } {
  const qRaw = url.searchParams.get('q')
  if (!qRaw) {
    return { error: 'invalid_request', message: 'Missing required query parameter `q`.' }
  }
  // Canonicalise `q` once at parse time and use the same value for
  // both the cache key and the embed call. Without this, `q=Hurricane`
  // and `q=hurricane` would share a cache slot (the cache key
  // canonicalises) but compute distinct embeddings (the embedder sees
  // the raw URL value), so whichever request misses first ends up
  // caching its result for the other — content-addressing violation.
  // Lowercasing is conservative for English BGE which is largely
  // case-insensitive at the token level.
  const q = qRaw.normalize('NFC').trim().toLowerCase()
  if (q.length === 0) {
    return { error: 'invalid_request', message: 'Missing required query parameter `q`.' }
  }
  // Validate length on the canonical form so a request whose
  // canonicalised query is ≤ MAX_QUERY_LENGTH isn't rejected just
  // because the raw URL had a lot of surrounding whitespace.
  if (q.length > MAX_QUERY_LENGTH) {
    return {
      error: 'invalid_request',
      message: `Query parameter \`q\` is too long (max ${MAX_QUERY_LENGTH} chars).`,
    }
  }

  const limitRaw = url.searchParams.get('limit')
  let limit = 10
  if (limitRaw != null) {
    const parsed = Number(limitRaw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return {
        error: 'invalid_request',
        message: `Query parameter \`limit\` must be an integer between 1 and ${MAX_LIMIT}.`,
      }
    }
    limit = parsed
  }

  // Default peer_id to 'local' so federated peers are excluded
  // unless an operator explicitly opts in. The helper translates
  // 'local' to the configured node id before forwarding to
  // Vectorize. Canonicalise once here (NFC + trim, but preserve
  // case — node ids are case-sensitive in Vectorize metadata) so
  // the cache key and the downstream filter use the exact same
  // value. A missing, empty, or whitespace-only `peer_id` is
  // treated the same as omitting the param and falls through to
  // the default — without this, `?peer_id=%20PEER_X%20` would
  // compute a result with a space-padded filter (matching nothing)
  // but cache it under the same key as `?peer_id=PEER_X`,
  // serving the corrupt result back on the next correct request.
  const peerIdRaw = url.searchParams.get('peer_id')
  const peerIdCanonical = peerIdRaw?.normalize('NFC').trim()
  const peer_id = peerIdCanonical && peerIdCanonical.length > 0 ? peerIdCanonical : 'local'

  // `category` is similarly canonicalised here so the cache key and
  // the downstream filter agree. The Vectorize filter helper also
  // lowercases defensively, but doing it once up-front keeps the
  // post/pre cache surface symmetric. An explicitly-empty
  // `?category=` (or `?category=%20%20`) is collapsed to
  // `undefined` so it lands in the same cache slot as the
  // omitted-param form (both are "no category filter" downstream).
  const categoryRaw = url.searchParams.get('category')
  const categoryCanonical =
    categoryRaw != null ? categoryRaw.normalize('NFC').trim().toLowerCase() : undefined
  const category = categoryCanonical && categoryCanonical.length > 0 ? categoryCanonical : undefined

  return { q, limit, category, peer_id }
}

/**
 * Stable cache key for the (query, limit, filters) tuple.
 *
 * Every input field is already canonicalised by `parseRequest`
 * (NFC + trim, plus lowercase for case-insensitive fields) so the
 * same canonical form drives both the cache key here AND the
 * downstream embed/query call — that's the only way the "trivial
 * variants share a cache slot" promise is actually true
 * content-addressing. If a future change adds extra
 * canonicalisation, do it in `parseRequest` and not here.
 *
 * `peer_id` keeps its case — node ids are case-sensitive in
 * Vectorize metadata + D1 filtering, so two differently-cased peer
 * ids must NOT collapse into the same cache slot (otherwise
 * `peer_id=PEER_X` would serve `peer_id=peer_x`'s results back).
 */
async function cacheKeyFor(parsed: ParsedRequest): Promise<string> {
  const canonical = JSON.stringify({
    q: parsed.q,
    l: parsed.limit,
    c: parsed.category ?? null,
    p: parsed.peer_id,
  })
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0')
  return `${SEARCH_CACHE_KEY_PREFIX}${hex.slice(0, 32)}`
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }

  const url = new URL(context.request.url)
  const parsedOrError = parseRequest(url)
  if ('error' in parsedOrError) {
    return jsonError(400, parsedOrError.error, parsedOrError.message)
  }
  const parsed = parsedOrError

  // Compute the cache key lazily — only when KV is bound. Skip the
  // SHA-256 entirely on KV-less deployments. Memoised across read
  // and write so we hash once per request when KV is present.
  let cacheKey: string | null = null
  const getCacheKey = async (): Promise<string> => {
    if (cacheKey === null) cacheKey = await cacheKeyFor(parsed)
    return cacheKey
  }

  if (context.env.CATALOG_KV) {
    const cached = await context.env.CATALOG_KV.get(await getCacheKey())
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

  const result: SearchDatasetsResult = await searchDatasets(context.env, {
    query: parsed.q,
    limit: parsed.limit,
    filters: {
      category: parsed.category,
      peer_id: parsed.peer_id,
    },
  })

  const body = JSON.stringify(result)
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPE,
    'X-Cache': 'MISS',
  }

  // Don't cache degraded responses — an operator wiring Vectorize
  // for the first time should get fresh results the moment the
  // binding lands, not 60 s of empty payloads from KV.
  if (result.degraded) {
    headers['Cache-Control'] = 'no-store'
    headers.Warning = `199 - "search degraded: ${result.degraded}"`
  } else {
    headers['Cache-Control'] = `public, max-age=${CACHE_TTL_SECONDS}`
    if (context.env.CATALOG_KV) {
      try {
        await context.env.CATALOG_KV.put(await getCacheKey(), body, {
          expirationTtl: CACHE_TTL_SECONDS,
        })
      } catch {
        // Best-effort cache fill; serving the response wins.
      }
    }
  }

  return new Response(body, { status: 200, headers })
}
