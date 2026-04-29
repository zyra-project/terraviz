/**
 * GET /api/v1/datasets/{id}/preview/{token}
 *
 * Anonymous endpoint that returns a draft (or any other unpublished)
 * dataset row when the embedded HMAC-signed preview token verifies
 * and matches the path's `id`. The route lives outside `/publish/`
 * so it doesn't go through the Access middleware — the publisher
 * issues the token from inside Access, then shares the resulting
 * URL with collaborators or the SPA's preview iframe.
 *
 * Failure modes (`{ error, message }`):
 *   - 503 binding_missing — CATALOG_DB not bound.
 *   - 401 invalid_token — token mangled, expired, or signed with
 *     the wrong secret.
 *   - 401 token_id_mismatch — token's `id` claim doesn't match the
 *     URL path; rejects shuffled-token attacks where a leaked token
 *     for one dataset is used to read another.
 *   - 404 not_found — token verifies but the row is gone.
 *
 * The response body is the same shape as the authenticated single-
 * dataset endpoint (`{ dataset: DatasetRow }`) so the frontend's
 * preview iframe consumes either with the same code path.
 */

import type { CatalogEnv } from '../../../_lib/env'
import { resolveSigningSecret, verifyPreviewToken } from '../../../_lib/preview-token'
import type { DatasetRow } from '../../../_lib/catalog-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
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

  const row = await context.env.CATALOG_DB.prepare(
    'SELECT * FROM datasets WHERE id = ? LIMIT 1',
  )
    .bind(id)
    .first<DatasetRow>()
  if (!row) return jsonError(404, 'not_found', `Dataset ${id} not found.`)

  return new Response(JSON.stringify({ dataset: row }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
