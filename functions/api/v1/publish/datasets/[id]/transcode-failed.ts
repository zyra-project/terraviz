/**
 * POST /api/v1/publish/datasets/{id}/transcode-failed
 *
 * Failure counterpart to `/transcode-complete`. Called by the
 * `transcode-hls` GitHub Actions workflow's `if: failure()` step when
 * the transcode job fails — an encode/upload error, or (the common
 * case) the job timeout, which SIGKILLs the runner process before it
 * can post `/transcode-complete`. The runner can't self-report a
 * timeout, so this is a separate workflow step.
 *
 * Effect: releases the transcode lock on the dataset row
 * (`transcoding`, `active_transcode_upload_id` → NULL) WITHOUT touching
 * `data_ref` — the row reverts to its last good bundle (the stamp held
 * the prior published values during the transcode window). Without this
 * the row stays `transcoding=1` forever after a failed run, so the UI
 * shows a perpetual in-progress state and a fresh upload's
 * `transcoding_in_progress` guard refuses to dispatch.
 *
 * Body:
 *   {
 *     "upload_id":     "<26-char ULID>",  // required; the asset_uploads
 *                                         // row whose transcode failed.
 *     "error_summary": "string"           // optional; recorded in the
 *                                         // audit trail (sanitized,
 *                                         // length-capped).
 *   }
 *
 * Authorization: privileged callers only (`role='service'` or
 * `role='admin'`), exactly like `/transcode-complete` — the
 * `transcoding` column is server-managed.
 *
 * Failure envelopes:
 *   - 400 invalid_json / invalid_body
 *   - 403 transcode_failed_forbidden — non-service caller
 *   - 404 not_found — dataset doesn't exist
 *   - 409 transcode_upload_mismatch — a newer upload owns the active
 *     transcode; refuse to clear it.
 *
 * Idempotent: if the row isn't currently transcoding (a prior failure
 * callback already cleared it, or a `/transcode-complete` won the race),
 * returns 200 `{ idempotent: true }` rather than erroring — a failure
 * callback must never itself fail the workflow's cleanup step.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import type { DatasetRow } from '../../../_lib/catalog-store'
import { writeDatasetAudit } from '../../../_lib/audit-store'
import { isPrivileged } from '../../../_lib/publisher-store'
import { abandonTranscoding } from '../../../_lib/asset-uploads'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const MAX_ERROR_SUMMARY = 500

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

interface TranscodeFailedBody {
  upload_id: string
  error_summary: string | null
}

function validateBody(raw: unknown): TranscodeFailedBody | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'Request body must be an object.' }
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.upload_id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(obj.upload_id)) {
    return { error: 'upload_id must be a 26-character ULID.' }
  }
  let errorSummary: string | null = null
  if (obj.error_summary != null) {
    if (typeof obj.error_summary !== 'string') {
      return { error: 'error_summary must be a string when present.' }
    }
    // Collapse control chars to single spaces and cap the length — the
    // summary lands verbatim in the audit log.
    errorSummary = obj.error_summary
      .replace(/\p{Cc}+/gu, ' ')
      .trim()
      .slice(0, MAX_ERROR_SUMMARY)
  }
  return { upload_id: obj.upload_id, error_summary: errorSummary }
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')

  if (!isPrivileged(publisher)) {
    return jsonError(
      403,
      'transcode_failed_forbidden',
      'This endpoint is restricted to service tokens and admins.',
    )
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  const validated = validateBody(body)
  if ('error' in validated) {
    return jsonError(400, 'invalid_body', validated.error)
  }

  const db = context.env.CATALOG_DB!
  const existing = await db
    .prepare(`SELECT * FROM datasets WHERE id = ?`)
    .bind(id)
    .first<DatasetRow>()
  if (!existing) return jsonError(404, 'not_found', `Dataset ${id} not found.`)

  // Idempotency: a failure callback that arrives after the lock is
  // already released (a prior failure callback, or a /transcode-complete
  // that won the race) is a no-op success — the cleanup step must not
  // turn a benign double-callback into a workflow failure.
  if (!existing.transcoding) {
    return ok({ dataset: existing, idempotent: true })
  }

  // Refuse to clear a transcode owned by a *different* (newer) upload.
  // Two re-uploads can't be disambiguated by digest, so the active-
  // upload binding is the only safe guard (migration 0012).
  if (existing.active_transcode_upload_id !== validated.upload_id) {
    return jsonError(
      409,
      'transcode_upload_mismatch',
      `Dataset ${id}'s active transcode is bound to upload ` +
        `${existing.active_transcode_upload_id ?? '(none)'}; got upload ` +
        `${validated.upload_id}. Refusing to clear — a newer upload has taken over.`,
    )
  }

  const now = new Date().toISOString()
  const changes = await abandonTranscoding(db, id, validated.upload_id, now)
  if (changes === 0) {
    // The binding moved between the SELECT and the UPDATE (a newer
    // /asset/.../complete swapped it). Same shape as the explicit
    // check above so the workflow treats them identically.
    return jsonError(
      409,
      'transcode_upload_mismatch',
      `Dataset ${id}'s active transcode binding changed before the lock could be released ` +
        `(upload ${validated.upload_id} was no longer active). A newer upload has taken over.`,
    )
  }

  const updated = await db
    .prepare(`SELECT * FROM datasets WHERE id = ?`)
    .bind(id)
    .first<DatasetRow>()

  // No snapshot invalidation: data_ref is unchanged, so public clients
  // keep serving the prior good bundle — nothing to refresh.
  await writeDatasetAudit(db, publisher, 'dataset.update', id, {
    fields: ['transcoding', 'active_transcode_upload_id'],
    reason: 'transcode_failed',
    upload_id: validated.upload_id,
    error_summary: validated.error_summary,
  })

  return ok({ dataset: updated })
}
