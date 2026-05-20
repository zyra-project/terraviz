/**
 * Cloudflare Pages Function — GET /api/v1/datasets/{id}
 *
 * Single-dataset lookup, fully expanded. Honors the same public
 * visibility filter as `/api/v1/catalog` — restricted, federated,
 * and private datasets resolve via the federation feed (Phase 4)
 * or the publisher API (Commit F+) instead.
 *
 * Caching is shorter and per-request than the list endpoint: a
 * single-dataset hit is rare enough that pre-rendering into KV
 * isn't worth a fan-out of keys, and the response is small enough
 * that the cost of re-rendering on every fetch is bounded. ETag-
 * driven 304s still apply; the edge cache picks up the slack.
 */

import { CatalogEnv } from '../_lib/env'
import {
  getNodeIdentity,
  getPublicDataset,
  getDecorations,
} from '../_lib/catalog-store'
import { serializeDataset } from '../_lib/dataset-serializer'
import { makeDataRefResolver } from '../_lib/data-ref-resolver'
import { buildFramesUrlTemplate, resolveAssetRefStrict } from '../_lib/r2-public-url'
import { computeEtag } from '../_lib/snapshot'

const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'
const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')
  if (!context.env.CATALOG_DB) {
    return jsonError(
      503,
      'binding_missing',
      'CATALOG_DB binding is not configured on this deployment.',
    )
  }

  const db = context.env.CATALOG_DB
  const [identity, row] = await Promise.all([getNodeIdentity(db), getPublicDataset(db, id)])
  if (!identity) {
    return jsonError(
      503,
      'identity_missing',
      'Node identity has not been provisioned. Run `npm run gen:node-key`.',
    )
  }
  if (!row) return jsonError(404, 'not_found', `Dataset ${id} not found.`)

  const decorations = await getDecorations(db, [id])
  const resolveDataRef = makeDataRefResolver(context.env)
  // Bind env into the asset resolver so r2:<key> references on
  // thumbnail/legend/caption/color_table_ref columns get resolved
  // to the public R2 URL — Phase 3b's migrate-r2-assets writes
  // r2: handles, the SPA needs HTTPS. The *Strict variant skips
  // the R2_S3_ENDPOINT fallback so a missing R2_PUBLIC_BASE
  // surfaces as a missing-field omission rather than a 403-on-
  // load URL (which is what the lenient resolver would emit
  // against a non-public-bucket S3 endpoint).
  const assetResolver = (ref: string | null | undefined) =>
    resolveAssetRefStrict(context.env, ref)
  const framesResolver = (ref: string, ext: string) =>
    buildFramesUrlTemplate(context.env, ref, ext)
  const dataset = serializeDataset(
    row,
    decorations.get(id)!,
    identity,
    resolveDataRef,
    assetResolver,
    framesResolver,
  )
  const body = JSON.stringify(dataset)
  const etag = await computeEtag(body)

  if (context.request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL },
    })
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      ETag: etag,
      'Cache-Control': CACHE_CONTROL,
    },
  })
}
