/**
 * Phase 3pt/E — publisher-side API client for the tour-authoring
 * dock. Thin wrapper over the shared `publisherGet` /
 * `publisherSend` helpers so the dock doesn't reach into the
 * publisher portal's internals while still inheriting its
 * session-handling + retry pipeline.
 *
 * Three endpoints map to three functions here:
 *
 *   POST /api/v1/publish/tours/draft       → createDraftTour
 *   GET  /api/v1/publish/tours/{id}/json   → fetchTourJson
 *   PUT  /api/v1/publish/tours/{id}/json   → saveTourJson
 */

import { publisherGet, publisherSend } from '../publisher/api'
import type { TourFile } from '../../types'

/** Subset of the `tours` row shape the dock cares about.
 *  `description` / `visibility` / `thumbnail_ref` are optional
 *  here because some endpoints (createDraftTour, publishTour)
 *  only echo back the rename-relevant subset; the row itself
 *  always has them. */
export interface TourSummary {
  id: string
  slug: string
  title: string
  tour_json_ref: string
  updated_at: string
  description?: string | null
  visibility?: string
  thumbnail_ref?: string | null
}

export async function createDraftTour(opts?: {
  title?: string
  fetchFn?: typeof fetch
}): Promise<{ tour: TourSummary } | { error: string }> {
  const result = await publisherSend<{ tour: TourSummary }>(
    '/api/v1/publish/tours/draft',
    opts?.title ? { title: opts.title } : {},
    { method: 'POST', fetchFn: opts?.fetchFn },
  )
  if (!result.ok) {
    return { error: errorLabel(result) }
  }
  return result.data
}

export async function fetchTourJson(
  id: string,
  opts?: { fetchFn?: typeof fetch },
): Promise<
  | { tour: TourSummary; tourFile: TourFile }
  | { error: string; kind: 'not_found' | 'network' | 'session' | 'server' | 'validation' }
> {
  const result = await publisherGet<{ tour: TourSummary; tourFile: TourFile }>(
    `/api/v1/publish/tours/${encodeURIComponent(id)}/json`,
    { fetchFn: opts?.fetchFn },
  )
  if (!result.ok) {
    return { error: errorLabel(result), kind: result.kind }
  }
  return result.data
}

export async function saveTourJson(
  id: string,
  tourFile: TourFile,
  opts?: { fetchFn?: typeof fetch },
): Promise<{ tour: TourSummary } | { error: string }> {
  const result = await publisherSend<{ tour: TourSummary }>(
    `/api/v1/publish/tours/${encodeURIComponent(id)}/json`,
    tourFile,
    { method: 'PUT', fetchFn: opts?.fetchFn },
  )
  if (!result.ok) {
    return { error: errorLabel(result) }
  }
  return result.data
}

/**
 * Phase 3pt/G — list the publisher's tours for the
 * /publish/tours landing page. Pagination via the same cursor
 * shape datasets.ts uses (the `next_cursor` field is forwarded
 * verbatim; clients pass it back as `?cursor=`).
 */
export interface TourListItem extends TourSummary {
  description: string | null
  thumbnail_ref: string | null
  visibility: string
  published_at: string | null
  publisher_id: string | null
}

export async function listTours(opts?: {
  limit?: number
  cursor?: string
  fetchFn?: typeof fetch
}): Promise<
  | { tours: TourListItem[]; next_cursor: string | null }
  | { error: string; kind: 'not_found' | 'network' | 'session' | 'server' | 'validation' }
> {
  const params = new URLSearchParams()
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts?.cursor !== undefined) params.set('cursor', opts.cursor)
  const qs = params.toString()
  const result = await publisherGet<{ tours: TourListItem[]; next_cursor: string | null }>(
    `/api/v1/publish/tours${qs ? `?${qs}` : ''}`,
    { fetchFn: opts?.fetchFn },
  )
  if (!result.ok) {
    return { error: errorLabel(result), kind: result.kind }
  }
  return result.data
}

/**
 * Phase 3pt/G — publish a tour. Server snapshots the draft
 * blob to an immutable `tours/{id}/published/{publish_id}.json`
 * key and flips `tour_json_ref` + `published_at`. Returns the
 * updated row + the publish_id so the dock can surface a
 * "Published as v…" confirmation.
 */
export async function publishTour(
  id: string,
  opts?: { fetchFn?: typeof fetch },
): Promise<{ tour: TourSummary; publish_id: string } | { error: string }> {
  const result = await publisherSend<{ tour: TourSummary; publish_id: string }>(
    `/api/v1/publish/tours/${encodeURIComponent(id)}/publish`,
    {},
    { method: 'POST', fetchFn: opts?.fetchFn },
  )
  if (!result.ok) {
    return { error: errorLabel(result) }
  }
  return result.data
}

/**
 * Phase 3pt-review/C — patch a tour's metadata (title /
 * description / visibility). PUTs the `tours` row's mutable
 * columns. Lives on a different endpoint than `saveTourJson`
 * because the R2 tour-file blob doesn't carry these — they're
 * D1 columns and surface in the list view.
 */
export async function updateTourMetadata(
  id: string,
  body: {
    title?: string
    description?: string
    visibility?: string
  },
  opts?: { fetchFn?: typeof fetch },
): Promise<{ tour: TourSummary } | { error: string }> {
  const result = await publisherSend<{ tour: TourSummary }>(
    `/api/v1/publish/tours/${encodeURIComponent(id)}`,
    body,
    { method: 'PUT', fetchFn: opts?.fetchFn },
  )
  if (!result.ok) {
    return { error: errorLabel(result) }
  }
  return result.data
}

/**
 * Phase 3pt/G — hard-delete a tour. Removes the D1 row +
 * best-effort drops the draft R2 blob. Used by the tour list
 * page's × button on each row. The publisher confirms via
 * `window.confirm` before this fires so an accidental click
 * can't drop weeks of work.
 */
export async function deleteTour(
  id: string,
  opts?: { fetchFn?: typeof fetch },
): Promise<{ deleted_id: string } | { error: string }> {
  const result = await publisherSend<{ deleted_id: string }>(
    `/api/v1/publish/tours/${encodeURIComponent(id)}`,
    undefined,
    { method: 'DELETE', fetchFn: opts?.fetchFn },
  )
  if (!result.ok) {
    return { error: errorLabel(result) }
  }
  return result.data
}

/** Surface a short string for the dock's autosave-status badge.
 *  The dock doesn't try to handle validation errors specifically —
 *  the JSON-editor validation in `dock.ts` should keep them out of
 *  the network round-trip; anything that slips through gets the
 *  server's message verbatim. */
function errorLabel(
  result:
    | { kind: 'network' }
    | { kind: 'session' }
    | { kind: 'not_found' }
    | { kind: 'server'; status?: number; body?: string }
    | { kind: 'validation'; errors: Array<{ field: string; code: string; message: string }> },
): string {
  switch (result.kind) {
    case 'network':
      return 'Network unavailable'
    case 'session':
      return 'Session expired — please sign in again'
    case 'not_found':
      return 'Tour not found'
    case 'server':
      return result.body || `Server error (${result.status ?? 'unknown'})`
    case 'validation':
      return result.errors[0]?.message ?? 'Validation failed'
  }
}
