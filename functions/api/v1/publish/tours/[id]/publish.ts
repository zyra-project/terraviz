/**
 * POST /api/v1/publish/tours/{id}/publish
 *
 * Phase 3pt/G — publish a tour. Snapshots the current draft
 * JSON to an immutable `tours/{id}/published/{publish_id}.json`
 * key in R2, flips the row's `tour_json_ref` to that path,
 * and stamps `published_at`. The draft blob is left alone so
 * the publisher can continue editing — a follow-up publish
 * creates a new immutable snapshot.
 *
 * Body: optional. No fields read today; reserved for future
 * publish-message / change-summary inputs.
 *
 * Authorization: standard publisher middleware (the caller
 * must own the row OR be staff/admin/service). Service tokens
 * can publish on behalf of anyone — same policy
 * `getTourForPublisher` already encodes.
 *
 * Errors:
 *   404 not_found — tour doesn't exist or isn't visible
 *   500 invalid_draft_blob — the draft.json on R2 is corrupt
 *   503 binding_missing / draft_missing — env or blob
 *     misconfig the operator needs to fix
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { publishTour } from '../../../_lib/tour-mutations'

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

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = pickId(context.params.id)
  if (!id) return jsonError(400, 'invalid_request', 'Missing tour id.')
  const result = await publishTour(context.env, publisher, id)
  if (!result.ok) return jsonError(result.status, result.error, result.message)
  return new Response(
    JSON.stringify({ tour: result.tour, publish_id: result.publishId }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE },
    },
  )
}
