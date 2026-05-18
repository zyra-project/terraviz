/**
 * GET /api/v1/datasets/{id}/preview/{token}/manifest
 *
 * Token-gated sibling of `/api/v1/datasets/{id}/manifest`. The
 * public manifest endpoint refuses to serve drafts (it filters on
 * `published_at IS NOT NULL`); this one is what the SPA's
 * `?preview=…` consumer fetches so an unpublished draft is
 * actually playable.
 *
 * Auth model is identical to the metadata-only preview endpoint
 * (`[token].ts`): the HMAC-signed token is bound to a dataset id,
 * verifies against the deployment's `PREVIEW_SIGNING_KEY`, and is
 * cross-checked against the URL path so a leaked token for one
 * dataset can't be replayed against another. The token's TTL is
 * the only blast-radius limit — a token issued for 15m can fetch
 * the manifest for those 15m, after which both the metadata and
 * manifest endpoints return 401.
 *
 * Resolution logic lives in `resolveManifest` (imported from the
 * public manifest module) so the wire shape stays identical
 * across the two paths.
 */

import type { CatalogEnv } from '../../../../_lib/env'
import type { DatasetRow } from '../../../../_lib/catalog-store'
import { resolveSigningSecret, verifyPreviewToken } from '../../../../_lib/preview-token'
import { resolveManifest } from '../../manifest'

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

  const result = await resolveManifest(row, context.env)
  if ('error' in result) {
    return jsonError(result.error.status, result.error.code, result.error.message)
  }

  return new Response(JSON.stringify(result.manifest), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
