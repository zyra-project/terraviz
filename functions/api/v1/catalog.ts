/**
 * Cloudflare Pages Function — GET /api/v1/catalog
 *
 * Returns the full public catalog as `{ schema_version,
 * generated_at, etag, datasets: WireDataset[], cursor, tombstones }`.
 *
 * Phase 1a serves only `visibility='public'` datasets that are not
 * hidden and not retracted. Federation, restricted, private, and
 * grant-resolved access live behind `/api/v1/federation/feed`
 * (Phase 4). The two paths share the D1 reader — only the
 * visibility predicate differs.
 *
 * Caching:
 *   - The full response body is rendered into KV under a single
 *     key (see `_lib/snapshot.ts`). On read, we return the cached
 *     body verbatim.
 *   - ETag-driven 304s. A client passing `If-None-Match: <etag>`
 *     gets a 304 if the snapshot's ETag matches.
 *   - Cache-Control: `public, max-age=60, stale-while-revalidate=300`
 *     on the response so the Cloudflare edge can serve from its
 *     own cache for a minute and revalidate for five.
 *   - Snapshot is rebuilt whenever a publisher write path issues
 *     `invalidateSnapshot(env)` (Commits F+).
 *
 * Incremental sync:
 *   - `?since={cursor}` returns only datasets updated after that
 *     cursor, plus tombstones for retracted/deleted rows since
 *     then. Phase 1a has no retract path so tombstones are always
 *     empty; the contract is in place for federation subscribers.
 *   - The `?since=` request path is *not* cached. Snapshots are
 *     for the full-catalog hot path; per-cursor responses are
 *     small and don't warrant a fan-out of KV keys.
 */

import { CatalogEnv } from './_lib/env'
import {
  getNodeIdentity,
  listPublicDatasets,
  getDecorations,
  type DatasetRow,
} from './_lib/catalog-store'
import { serializeDataset, maxUpdatedAt, type WireDataset } from './_lib/dataset-serializer'
import {
  buildAndCacheSnapshot,
  computeEtag,
  readSnapshot,
} from './_lib/snapshot'

const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'
const CONTENT_TYPE = 'application/json; charset=utf-8'
// Stable timestamp used in the empty-catalog body so the response
// bytes are a pure function of dataset state. The unix epoch is a
// recognisable "no rows yet" sentinel; the populated path replaces
// it with the latest `updated_at`.
const EMPTY_GENERATED_AT = '1970-01-01T00:00:00.000Z'

interface CatalogResponseBody {
  schema_version: number
  generated_at: string
  etag: string
  cursor: string | null
  datasets: WireDataset[]
  tombstones: string[]
}

async function renderCatalog(
  env: CatalogEnv,
  options: { since?: string } = {},
): Promise<{ body: string; contentType: string; etag: string }> {
  const db = env.CATALOG_DB!
  const identity = await getNodeIdentity(db)
  if (!identity) {
    // Fresh deploy without `npm run gen:node-key`. Render an empty
    // catalog with a placeholder identity rather than 503'ing the
    // public read path — the operator may still want browse to
    // work even before the well-known doc is ready.
    //
    // Derive the etag from the same canonical seed the populated
    // path uses so two requests with no rows always produce the
    // same etag, AND pin `generated_at` to a fixed empty-state
    // sentinel so identical state also produces identical body
    // bytes. The previous hardcoded `"empty"` etag paired with a
    // fresh `Date.now()` `generated_at` violated the ETag contract:
    // same etag, different bytes across rebuilds.
    const seed = JSON.stringify({
      schema_version: 1,
      cursor: null,
      datasets: [] as WireDataset[],
      tombstones: [] as string[],
    })
    const etag = await computeEtag(seed)
    const empty: CatalogResponseBody = {
      schema_version: 1,
      generated_at: EMPTY_GENERATED_AT,
      etag,
      cursor: null,
      datasets: [],
      tombstones: [],
    }
    return { body: JSON.stringify(empty), contentType: CONTENT_TYPE, etag }
  }

  const rows: DatasetRow[] = await listPublicDatasets(db, options)
  const decorationMap = await getDecorations(
    db,
    rows.map(r => r.id),
  )
  const datasets = rows.map(r =>
    serializeDataset(r, decorationMap.get(r.id)!, identity),
  )

  // The etag stamped in the response header MUST equal the one
  // inside the body — derive it once over a body shape that omits
  // `etag` and `generated_at` (both would make the etag chase its
  // tail) and then bake it into the JSON. Identical D1 contents
  // therefore produce identical etags across renders, so 304s
  // continue to work after a snapshot rebuild.
  //
  // `generated_at` is pinned to `cursor` (the latest `updated_at`
  // across the result set) rather than `Date.now()`. Two
  // semantically: `generated_at` is "this view is as of T", and
  // when nothing has changed since the last render T is the
  // freshest dataset's update time. Mechanically: it makes the
  // body bytes a pure function of the dataset state, so the etag
  // really does identify the bytes you'd send back.
  const cursor = maxUpdatedAt(rows)
  const etagSeed = JSON.stringify({
    schema_version: 1,
    cursor,
    datasets,
    tombstones: [] as string[],
  })
  const etag = await computeEtag(etagSeed)
  const body: CatalogResponseBody = {
    schema_version: 1,
    generated_at: cursor ?? EMPTY_GENERATED_AT,
    etag,
    cursor,
    datasets,
    tombstones: [],
  }
  return { body: JSON.stringify(body), contentType: CONTENT_TYPE, etag }
}

function ifNoneMatch(request: Request): string | null {
  return request.headers.get('if-none-match')
}

function notModified(etag: string): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
      'Cache-Control': CACHE_CONTROL,
    },
  })
}

function bindingMissingResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'binding_missing',
      message: 'CATALOG_DB binding is not configured on this deployment.',
    }),
    {
      status: 503,
      headers: { 'Content-Type': CONTENT_TYPE },
    },
  )
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) return bindingMissingResponse()

  const url = new URL(context.request.url)
  const since = url.searchParams.get('since') ?? undefined

  // The KV snapshot only covers the no-cursor full-catalog read.
  // `?since=...` is a cursor-scoped path; render fresh every time.
  if (since) {
    const { body, contentType, etag } = await renderCatalog(context.env, { since })
    if (ifNoneMatch(context.request) === etag) return notModified(etag)
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        ETag: etag,
        // Cursor responses are mostly used by sync jobs; let the
        // edge cache short-circuit identical re-fetches.
        'Cache-Control': 'public, max-age=30',
      },
    })
  }

  const cached = await readSnapshot(context.env)
  if (cached) {
    if (ifNoneMatch(context.request) === cached.etag) return notModified(cached.etag)
    return new Response(cached.body, {
      status: 200,
      headers: {
        'Content-Type': cached.contentType,
        ETag: cached.etag,
        'Cache-Control': CACHE_CONTROL,
      },
    })
  }

  const fresh = await buildAndCacheSnapshot(context.env, () => renderCatalog(context.env))
  if (ifNoneMatch(context.request) === fresh.etag) return notModified(fresh.etag)
  return new Response(fresh.body, {
    status: 200,
    headers: {
      'Content-Type': fresh.contentType,
      ETag: fresh.etag,
      'Cache-Control': CACHE_CONTROL,
    },
  })
}

// Exported for tests.
export { renderCatalog }
