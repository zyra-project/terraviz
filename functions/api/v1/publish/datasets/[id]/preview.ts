/**
 * POST /api/v1/publish/datasets/{id}/preview
 *
 * Mints a 15-minute HMAC-signed preview token bound to this dataset
 * and the calling publisher. The CLI's `terraviz preview` returns
 * the consumer URL the operator can share:
 *
 *   GET /api/v1/datasets/{id}/preview/{token}
 *
 * which is anonymous (no Access cookie required) but only returns
 * the row when the HMAC verifies and the embedded `id` matches.
 *
 * Body: `{ ttl_seconds?: number }`. The default is 900s; the
 * issuer can request shorter for one-shot share links. We cap the
 * upper bound at 24h so a leaked token has a bounded blast radius.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { getDatasetForPublisher } from '../../../_lib/dataset-mutations'
import { issuePreviewToken, resolveSigningSecret } from '../../../_lib/preview-token'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const MAX_TTL_SECONDS = 24 * 60 * 60

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')

  const existing = await getDatasetForPublisher(context.env.CATALOG_DB!, publisher, id)
  if (!existing) return jsonError(404, 'not_found', `Dataset ${id} not found.`)

  // Optional `ttl_seconds`; we accept an empty body for the default.
  let ttlSeconds: number | undefined
  const text = await context.request.text()
  if (text) {
    try {
      const parsed = JSON.parse(text) as { ttl_seconds?: number }
      if (parsed && typeof parsed.ttl_seconds === 'number') {
        ttlSeconds = parsed.ttl_seconds
      }
    } catch {
      return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
    }
  }
  if (ttlSeconds !== undefined && (ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS)) {
    return jsonError(400, 'invalid_ttl', `ttl_seconds must be in [1, ${MAX_TTL_SECONDS}].`)
  }

  let secret: string
  try {
    secret = resolveSigningSecret(context.env)
  } catch (e) {
    return jsonError(
      503,
      'preview_unconfigured',
      e instanceof Error ? e.message : 'Preview signing key is not configured.',
    )
  }
  const token = await issuePreviewToken(
    secret,
    { kind: 'dataset', id, publisher_id: publisher.id },
    ttlSeconds ? { ttlSeconds } : {},
  )
  return new Response(
    JSON.stringify({
      token,
      url: `/api/v1/datasets/${id}/preview/${token}`,
      expires_in: ttlSeconds ?? 15 * 60,
    }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}
