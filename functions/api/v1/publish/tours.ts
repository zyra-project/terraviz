/**
 * /api/v1/publish/tours — tour collection endpoint.
 *
 *   POST → create a tour (Phase 1a). Accepts any non-empty
 *     `tour_json_ref` (CLI feeds in a URL or R2 key); Phase 1b
 *     adds the direct-upload pipeline that returns a real
 *     `r2:<key>` ref. Phase 3pt/E adds a sibling /tours/draft
 *     endpoint that bypasses the ref requirement for the
 *     publisher-portal "New tour" flow.
 *
 *   GET → list the publisher's tours (Phase 3pt/G). Honours the
 *     same role-aware visibility as the per-id GET — staff /
 *     admin / service see every tour; community publishers see
 *     their own. Cursor pagination via `id < ?` so the list
 *     stays stable when fresh tours land at the top.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { getNodeIdentity } from '../_lib/catalog-store'
import { createTour, listToursForPublisher } from '../_lib/tour-mutations'
import { can } from '../_lib/capabilities'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const url = new URL(context.request.url)
  const limitRaw = url.searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (limitRaw != null) {
    if (!/^\d+$/.test(limitRaw)) {
      return jsonError(400, 'invalid_request', `limit must be a base-10 integer in [1, ${MAX_LIMIT}].`)
    }
    const n = parseInt(limitRaw, 10)
    if (n < 1 || n > MAX_LIMIT) {
      return jsonError(400, 'invalid_request', `limit must be a base-10 integer in [1, ${MAX_LIMIT}].`)
    }
    limit = n
  }
  const cursor = url.searchParams.get('cursor') ?? undefined
  const result = await listToursForPublisher(context.env, publisher, { limit, cursor })
  return new Response(
    JSON.stringify({ tours: result.tours, next_cursor: result.next_cursor }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!can(publisher, 'content.create')) {
    return jsonError(403, 'forbidden_role', 'Creating tours requires an authoring role.')
  }
  // See publish/datasets.ts — the createTour SQL embeds the
  // node_identity row id as `origin_node`, so a fresh deploy that
  // hasn't run `gen:node-key` would crash with a NOT NULL error.
  // Surface as 503 identity_missing instead.
  const identity = await getNodeIdentity(context.env.CATALOG_DB!)
  if (!identity) {
    return jsonError(
      503,
      'identity_missing',
      'Node identity has not been provisioned. Run `npm run gen:node-key`.',
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
  const result = await createTour(context.env, publisher, body as Record<string, unknown>)
  if (!result.ok) {
    return new Response(JSON.stringify({ errors: result.errors }), {
      status: result.status,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  return new Response(JSON.stringify({ tour: result.tour }), {
    status: 201,
    headers: { 'Content-Type': CONTENT_TYPE, Location: `/api/v1/publish/tours/${result.tour.id}` },
  })
}
