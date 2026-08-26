// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
import { getTourForPublisher, publishTour } from '../../../_lib/tour-mutations'
import { canOwnOrAny } from '../../../_lib/capabilities'

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
  // Publishing is a privilege above authoring: a contributor may create
  // + edit its own draft tour but cannot make it public. Gate on the
  // publish capability against the tour's owner (author-own or
  // editor/admin-any), mirroring datasets/blog.
  const existing = await getTourForPublisher(context.env.CATALOG_DB!, publisher, id)
  if (!existing) return jsonError(404, 'not_found', `Tour ${id} not found.`)
  if (!canOwnOrAny(publisher, existing.publisher_id, 'content.publish.own', 'content.publish.any')) {
    return jsonError(403, 'forbidden_role', 'Publishing a tour requires a publishing role.')
  }
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
