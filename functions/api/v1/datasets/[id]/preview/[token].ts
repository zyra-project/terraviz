/**
 * GET /api/v1/datasets/{id}/preview/{token}
 *
 * Anonymous endpoint that returns a draft (or any other
 * unpublished) dataset in the wire shape when the embedded
 * HMAC-signed preview token verifies and matches the path's `id`.
 * The route lives outside `/publish/` so it doesn't go through
 * the Access middleware — the publisher issues the token from
 * inside Access, then shares the resulting URL with collaborators
 * or the SPA's `?preview=` consumer.
 *
 * Response body: `{ dataset: WireDataset }` — the same shape the
 * public catalog endpoints emit, with one preview-specific tweak:
 * `dataLink` points at the token-gated manifest sibling
 * (`/api/v1/datasets/{id}/preview/{token}/manifest`) instead of
 * the public one. The SPA's existing manifest-fetch path
 * (`hlsService.ts` / `loadImageDataset`) then renders the draft
 * unchanged. Pre-3pe this endpoint returned the raw `DatasetRow`
 * shape — useful for a reviewer with `curl` but not for the SPA;
 * the swap to wire shape is what makes the ?preview= consumer
 * actually work.
 *
 * Failure modes (`{ error, message }`):
 *   - 503 binding_missing — CATALOG_DB not bound.
 *   - 503 identity_missing — node_identity row missing.
 *   - 503 preview_unconfigured — PREVIEW_SIGNING_KEY not set.
 *   - 401 invalid_token — token mangled, expired, or signed with
 *     the wrong secret.
 *   - 401 token_id_mismatch — token's `id` claim doesn't match the
 *     URL path; rejects shuffled-token attacks where a leaked
 *     token for one dataset is used to read another.
 *   - 404 not_found — token verifies but the row is gone.
 */

import type { CatalogEnv } from '../../../_lib/env'
import { resolveSigningSecret, verifyPreviewToken } from '../../../_lib/preview-token'
import {
  type DatasetRow,
  getDecorations,
  getNodeIdentity,
} from '../../../_lib/catalog-store'
import { serializeDataset } from '../../../_lib/dataset-serializer'
import { makeDataRefResolver } from '../../../_lib/data-ref-resolver'
import { buildFramesUrlTemplate, resolveAssetRefStrict } from '../../../_lib/r2-public-url'

const CONTENT_TYPE = 'application/json; charset=utf-8'
// Errors are explicitly non-cacheable: RFC 9111 lets intermediaries
// heuristically cache 4xx/5xx without an explicit directive. With a
// 15-minute token TTL, a cached 401 right before mint can make a
// freshly issued token appear invalid.
const NO_STORE = 'private, no-store'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': NO_STORE },
  })
}

function pickParam(p: string | string[] | undefined): string | null {
  const v = Array.isArray(p) ? p[0] : p
  return v || null
}

type Params = 'id' | 'token'

export const onRequestGet: PagesFunction<CatalogEnv, Params> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured.')
  }

  const id = pickParam(context.params.id)
  const token = pickParam(context.params.token)
  if (!id || !token) {
    return jsonError(400, 'invalid_request', 'Missing dataset id or token.')
  }

  let secret: string
  try {
    secret = resolveSigningSecret(context.env)
  } catch {
    // Operator hasn't set PREVIEW_SIGNING_KEY in production. Fail
    // closed with a typed envelope so an anonymous probe doesn't
    // get a stack trace.
    return jsonError(
      503,
      'preview_unconfigured',
      'Preview tokens are not configured on this deployment.',
    )
  }
  const claims = await verifyPreviewToken(secret, token)
  if (!claims || claims.kind !== 'dataset') {
    return jsonError(401, 'invalid_token', 'Preview token is invalid or expired.')
  }
  if (claims.id !== id) {
    return jsonError(
      401,
      'token_id_mismatch',
      'Preview token does not match the requested dataset.',
    )
  }

  const db = context.env.CATALOG_DB
  const [identity, row] = await Promise.all([
    getNodeIdentity(db),
    db
      .prepare('SELECT * FROM datasets WHERE id = ? LIMIT 1')
      .bind(id)
      .first<DatasetRow>(),
  ])
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
  // Public-route dataLink (`/api/v1/datasets/{id}/manifest`) refuses
  // unpublished rows; swap in the token-gated sibling so the SPA's
  // existing hlsService / image-load paths reach a working manifest
  // for a draft. Tour datasets ignore dataLink (the tour engine
  // consumes tourJsonUrl directly), so the rewrite is a no-op for
  // them but harmless.
  dataset.dataLink = `/api/v1/datasets/${id}/preview/${token}/manifest`

  return new Response(JSON.stringify({ dataset }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
