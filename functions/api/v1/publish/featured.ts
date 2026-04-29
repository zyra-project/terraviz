/**
 * /api/v1/publish/featured
 *
 * GET  → List the operator's curated featured-datasets, in display
 *        order. The docent's `list_featured_datasets` LLM tool
 *        consumes the same data via an internal call site (Phase 1b
 *        wire-up follows in a docent commit).
 * POST → Add a dataset to the featured list. Body:
 *        `{ dataset_id, position }`. Privileged callers only —
 *        community publishers cannot curate operator-wide content.
 *
 * Authorisation:
 *   - GET is open to any active publisher (the docent reads it via
 *     a service token; staff portal reads it via cookie). The list
 *     is operator-curated, not per-tenant, so there's no per-row
 *     visibility scope to apply.
 *   - POST requires `isPrivileged(publisher)` — staff, admin, or
 *     service-token caller. 403 forbidden_role for community.
 *
 * Failure envelopes match the rest of the publisher API:
 *   `{ error, message }` for system-level errors,
 *   `{ errors: [...] }` for body-validation arrays.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import {
  addFeaturedDataset,
  listFeaturedDatasets,
  validatePosition,
} from '../_lib/featured-datasets'
import { isPrivileged } from '../_lib/publisher-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function validationFailure(errors: Array<{ field: string; code: string; message: string }>, status = 400): Response {
  return new Response(JSON.stringify({ errors }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const url = new URL(context.request.url)
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? Number(limitRaw) : undefined
  // Must be a positive integer literal — `1.5` and `1e2` both pass
  // `Number.isFinite` but aren't what the operator typed; require
  // base-10 digits + `Number.isInteger` to keep D1's LIMIT clause
  // reading exactly what the URL said.
  if (
    limitRaw &&
    (!/^[0-9]+$/.test(limitRaw) || !Number.isFinite(limit) || !Number.isInteger(limit) || limit! < 1)
  ) {
    return jsonError(400, 'invalid_limit', '?limit= must be a positive integer.')
  }
  const featured = await listFeaturedDatasets(context.env.CATALOG_DB!, { limit })
  return new Response(JSON.stringify({ featured }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(
      403,
      'forbidden_role',
      'Featured-list mutation is restricted to staff, admin, and service callers.',
    )
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'Request body must be an object.')
  }
  const { dataset_id, position } = body as Record<string, unknown>

  const errors: Array<{ field: string; code: string; message: string }> = []
  if (typeof dataset_id !== 'string' || !dataset_id) {
    errors.push({ field: 'dataset_id', code: 'invalid_dataset_id', message: 'dataset_id is required.' })
  }
  const positionCheck = validatePosition(position)
  if (!positionCheck.ok) {
    errors.push({ field: 'position', code: 'invalid_position', message: positionCheck.message })
  }
  if (errors.length) return validationFailure(errors)

  const result = await addFeaturedDataset(context.env.CATALOG_DB!, publisher, {
    dataset_id: dataset_id as string,
    position: (positionCheck as { ok: true; position: number }).position,
  })
  if (!result.ok) {
    return jsonError(result.status, result.error, result.message)
  }
  return new Response(JSON.stringify({ featured: result.row }), {
    status: 201,
    headers: {
      'Content-Type': CONTENT_TYPE,
      Location: `/api/v1/publish/featured/${result.row.dataset_id}`,
    },
  })
}
