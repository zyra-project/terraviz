// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * POST /api/v1/publish/tours/{id}/retract
 *
 * Phase 3pt/G follow-up — retract a published tour. Sets the
 * `retracted_at` timestamp on the row; leaves `published_at`
 * and the immutable R2 snapshot in place so:
 *   - the publisher list distinguishes "draft" from "retracted"
 *   - federation peers can still resolve a cached
 *     `tour_json_ref` URL (the row simply stops appearing in
 *     the public list / catalog snapshot)
 *   - a follow-up publish lifts the row back into the public
 *     surface by clearing `retracted_at` (see `publishTour`)
 *
 * Authorization: standard publisher middleware. The caller must
 * own the row OR be staff/admin/service; same policy
 * `getTourForPublisher` already encodes.
 *
 * Errors:
 *   404 not_found — tour doesn't exist or isn't visible
 *   409 not_published — row was never published; retract is
 *       meaningless. Use `DELETE` for hard-removal of drafts.
 *   409 already_retracted — idempotent no-op surfaced as a
 *       conflict so the UI can show "already retracted".
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { getTourForPublisher, retractTour } from '../../../_lib/tour-mutations'
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
  // Retract is a publish-tier action (changes public visibility) — same
  // gate as publish.
  const existing = await getTourForPublisher(context.env.CATALOG_DB!, publisher, id)
  if (!existing) return jsonError(404, 'not_found', `Tour ${id} not found.`)
  if (!canOwnOrAny(publisher, existing.publisher_id, 'content.publish.own', 'content.publish.any')) {
    return jsonError(403, 'forbidden_role', 'Retracting a tour requires a publishing role.')
  }
  const result = await retractTour(context.env, publisher, id)
  if (!result.ok) return jsonError(result.status, result.error, result.message)
  return new Response(JSON.stringify({ tour: result.tour }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}
