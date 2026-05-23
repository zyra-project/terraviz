/**
 * /api/v1/publish/tours/{id}/json
 *
 * Phase 3pt/E — autosave + reopen endpoints for the publisher
 * tour-authoring dock.
 *
 *   GET → the tour file the engine would play (a JSON
 *         `TourFile`: `{ "tourTasks": [...] }`). Reads from R2.
 *         Returns an empty tour file if the row exists but the
 *         blob is missing (cold start before first autosave).
 *
 *   PUT → overwrite the draft. Body must be a JSON object with
 *         a `tourTasks` array; per-task strict validation is
 *         the engine's job at run-time so the editor doesn't
 *         get coupled to the engine's private validator
 *         surface. Bumps `updated_at` on the row.
 *
 * Authorization: same as `/api/v1/publish/tours/{id}` — the
 * publisher must own the row (or be staff/admin/service per
 * `getTourForPublisher`).
 *
 * Errors:
 *   400 invalid_json / invalid_tour_file
 *   404 not_found — tour doesn't exist or isn't visible to the caller
 *   500 invalid_tour_blob — the R2 blob exists but isn't valid JSON (data corruption)
 *   503 binding_missing — `CATALOG_R2` unbound
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { readTourDraftJson, writeTourDraftJson } from '../../../_lib/tour-mutations'

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
  const result = await readTourDraftJson(context.env, publisher, id)
  if (!result.ok) return jsonError(result.status, result.error, result.message)
  return new Response(
    JSON.stringify({ tour: result.tour, tourFile: result.tourFile }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}

export const onRequestPut: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = pickId(context.params.id)
  if (!id) return jsonError(400, 'invalid_request', 'Missing tour id.')
  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  const result = await writeTourDraftJson(context.env, publisher, id, body)
  if (!result.ok) return jsonError(result.status, result.error, result.message)
  return new Response(JSON.stringify({ tour: result.tour }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}
