/**
 * /api/v1/publish/featured/{dataset_id}
 *
 * PUT    → Update the featured-list position for an existing entry.
 *          Body: `{ position }`. 404 if the dataset isn't currently
 *          featured (caller should POST to add).
 * DELETE → Remove the dataset from the featured list. Idempotent —
 *          204 No Content whether the row was present or not.
 *
 * Both endpoints require privileged callers (staff / admin /
 * service); community publishers cannot curate operator content.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import {
  removeFeaturedDataset,
  updateFeaturedPosition,
  validatePosition,
} from '../../_lib/featured-datasets'
import { isPrivileged } from '../../_lib/publisher-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function pickDatasetId(context: Parameters<PagesFunction<CatalogEnv, 'dataset_id'>>[0]): string | null {
  const param = context.params.dataset_id
  const id = Array.isArray(param) ? param[0] : param
  return id || null
}

export const onRequestPut: PagesFunction<CatalogEnv, 'dataset_id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(
      403,
      'forbidden_role',
      'Featured-list mutation is restricted to staff, admin, and service callers.',
    )
  }
  const datasetId = pickDatasetId(context)
  if (!datasetId) return jsonError(400, 'invalid_request', 'Missing dataset id.')

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'Request body must be an object.')
  }
  const { position } = body as Record<string, unknown>
  const positionCheck = validatePosition(position)
  if (!positionCheck.ok) {
    return new Response(
      JSON.stringify({
        errors: [{ field: 'position', code: 'invalid_position', message: positionCheck.message }],
      }),
      { status: 400, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  const result = await updateFeaturedPosition(context.env.CATALOG_DB!, datasetId, positionCheck.position)
  if (!result.ok) return jsonError(result.status, result.error, result.message)
  return new Response(JSON.stringify({ featured: result.row }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestDelete: PagesFunction<CatalogEnv, 'dataset_id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(
      403,
      'forbidden_role',
      'Featured-list mutation is restricted to staff, admin, and service callers.',
    )
  }
  const datasetId = pickDatasetId(context)
  if (!datasetId) return jsonError(400, 'invalid_request', 'Missing dataset id.')

  await removeFeaturedDataset(context.env.CATALOG_DB!, datasetId)
  return new Response(null, { status: 204 })
}
