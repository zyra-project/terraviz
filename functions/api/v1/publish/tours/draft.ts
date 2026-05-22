/**
 * POST /api/v1/publish/tours/draft
 *
 * Phase 3pt/E — mint a fresh draft tour row + write an empty
 * `{"tourTasks":[]}` blob at the canonical R2 draft key. Used
 * by the publisher portal's "New tour" button: instead of
 * requiring the caller to first upload a tour file and then
 * POST to /tours with the ref, this endpoint does both in one
 * server request. The R2 write and the D1 insert happen
 * sequentially against two different Cloudflare services, so
 * the operation is not transactionally atomic across them — a
 * failure mid-flow leaves either the row or the blob, but not
 * both. Partial-state recovery depends on which half landed:
 *
 *   - Blob written but row insert failed: orphan blob; harmless
 *     (no row references it; eventual R2 lifecycle cleanup).
 *   - Row inserted but blob write failed: the row's
 *     `tour_json_ref` still points at the (missing) draft key;
 *     `GET /api/v1/publish/tours/{id}/json` recovers gracefully
 *     by treating the missing blob as an empty tour file
 *     (`readTourDraftJson` returns `{tourTasks:[]}`), and the
 *     next PUT to `/api/v1/publish/tours/{id}/json` writes the
 *     blob for real — provided `CATALOG_R2` is bound. With the
 *     binding missing, that PUT returns `503 binding_missing`,
 *     so production deploys must bind the bucket. Phase
 *     3pt-review/H — Copilot discussion_r3291171425.
 *
 * Returns the new `tour` row so the dock can navigate to
 * `/?tourEdit=<id>` immediately. Phase 3pt-review/A — Copilot
 * discussion_r3284321902.
 *
 * Authorization: same as `POST /api/v1/publish/tours` — any
 * authenticated publisher (the middleware short-circuits
 * unauthenticated requests).
 *
 * Body is optional; pass `{ "title": "..." }` to override the
 * auto-derived placeholder. Caller-supplied titles run through
 * the same `validateTitle` rules `createTour` / `updateTour`
 * use (≥3 chars, ≤200 chars, no control chars) and return a
 * 400 validation envelope on failure. Omit the title to use
 * the server-generated `Untitled tour <suffix>` placeholder.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { createDraftTour } from '../../_lib/tour-mutations'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  let body: { title?: string } = {}
  const text = await context.request.text()
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as { title?: string }
      }
    } catch {
      return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
    }
  }
  const result = await createDraftTour(context.env, publisher, { title: body.title })
  if (!result.ok) {
    return new Response(JSON.stringify({ errors: result.errors }), {
      status: result.status,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  return new Response(JSON.stringify({ tour: result.tour }), {
    status: 201,
    headers: {
      'Content-Type': CONTENT_TYPE,
      Location: `/api/v1/publish/tours/${result.tour.id}`,
    },
  })
}
