/**
 * POST /api/v1/publish/tours/draft
 *
 * Phase 3pt/E — mint a fresh draft tour row + write an empty
 * `{"tourTasks":[]}` blob at the canonical R2 draft key. Used
 * by the publisher portal's "New tour" button: instead of
 * requiring the caller to first upload a tour file and then
 * POST to /tours with the ref, this endpoint does both in one
 * server request. `createDraftTour` writes the R2 blob first
 * (when `CATALOG_R2` is bound) and only then inserts the D1
 * row, so the operation is not transactionally atomic across
 * the two Cloudflare services. The possible partial-state
 * outcomes:
 *
 *   - R2 write fails (blob missing, no D1 row): the request
 *     surfaces the error; nothing to recover.
 *   - R2 write succeeds, D1 insert fails: orphan blob with no
 *     row pointing at it; harmless (eventual lifecycle cleanup).
 *   - R2 binding absent + D1 insert succeeds: the row exists,
 *     `tour_json_ref` points at a key with no object. `GET
 *     /api/v1/publish/tours/{id}/json` recovers by treating
 *     missing blob as an empty tour file (`readTourDraftJson`
 *     returns `{tourTasks:[]}`). The follow-up `PUT
 *     /api/v1/publish/tours/{id}/json` (autosave) returns
 *     `503 binding_missing` until the binding is added, so
 *     production deploys must bind the bucket. The unbound
 *     branch exists only for unit tests / smoke checks. Phase
 *     3pt-review/H/I — Copilot discussion_r3291171425 +
 *     r3291446496.
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
