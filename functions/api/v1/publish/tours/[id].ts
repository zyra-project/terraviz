/**
 * /api/v1/publish/tours/{id}
 *
 *   GET → Single tour body, role-aware visibility filter.
 *   PUT → Patch metadata. Same authorisation.
 *   DELETE → Hard-delete the row + best-effort drop the draft
 *     R2 blob (Phase 3pt/G). Published immutable snapshots
 *     under `tours/{id}/published/{publish_id}.json` are NOT
 *     removed — federation subscribers may still hold those
 *     refs. Phase 4 federation lands a soft-retract gesture
 *     that supersedes this for published tours.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { deleteTour, getTourForPublisher, updateTour } from '../../_lib/tour-mutations'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function pickId(p: string | string[] | undefined): string | null {
  const v = Array.isArray(p) ? p[0] : p
  return v || null
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = pickId(context.params.id)
  if (!id) return jsonError(400, 'invalid_request', 'Missing tour id.')
  const row = await getTourForPublisher(context.env.CATALOG_DB!, publisher, id)
  if (!row) return jsonError(404, 'not_found', `Tour ${id} not found.`)
  return new Response(JSON.stringify({ tour: row }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestPut: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = pickId(context.params.id)
  if (!id) return jsonError(400, 'invalid_request', 'Missing tour id.')
  const existing = await getTourForPublisher(context.env.CATALOG_DB!, publisher, id)
  if (!existing) return jsonError(404, 'not_found', `Tour ${id} not found.`)

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'Request body must be an object.')
  }
  const result = await updateTour(context.env, publisher, id, body as Record<string, unknown>)
  if (!result.ok) {
    return new Response(JSON.stringify({ errors: result.errors }), {
      status: result.status,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  return new Response(JSON.stringify({ tour: result.tour }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export const onRequestDelete: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = pickId(context.params.id)
  if (!id) return jsonError(400, 'invalid_request', 'Missing tour id.')
  const result = await deleteTour(context.env, publisher, id)
  if (!result.ok) return jsonError(result.status, result.error, result.message)
  return new Response(JSON.stringify({ deleted_id: result.deleted_id }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}
