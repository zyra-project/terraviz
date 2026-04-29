/**
 * POST /api/v1/publish/tours — create a tour.
 *
 * Phase 1a accepts any non-empty `tour_json_ref` (the CLI feeds in
 * a URL or R2 key it constructed out-of-band). Phase 1b adds the
 * direct-upload pipeline that returns a real `r2:<key>` ref.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { createTour } from '../_lib/tour-mutations'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
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
