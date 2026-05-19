/**
 * POST /api/v1/publish/datasets/{id}/transcode-complete
 *
 * Called by the GitHub Actions transcode workflow once it has
 * written the HLS bundle to R2 under
 * `videos/{datasetId}/{uploadId}/`. Flips `data_ref` to the
 * `master.m3u8` path and clears `transcoding`. Restricted to
 * service-token publishers (and admins) because the
 * `transcoding` column is server-managed — community publishers
 * shouldn't be able to fake "transcode complete" through the
 * regular PUT path.
 *
 * Body:
 *   {
 *     "upload_id":      "<26-char ULID>",   // required; the
 *                                           // asset_uploads row
 *                                           // this transcode is
 *                                           // finalising.
 *     "source_digest":  "sha256:..."        // required; must match
 *                                           // the row's stored
 *                                           // source_digest. Guards
 *                                           // against a stale
 *                                           // dispatch winning
 *                                           // against a fresher
 *                                           // upload — PR #112
 *                                           // Copilot #3.
 *   }
 *
 * The server **constructs `data_ref` itself** from the route id
 * + the upload id (`r2:videos/{routeId}/{uploadId}/master.m3u8`).
 * The workflow doesn't get to choose — that's the fix for
 * PR #112 Copilot #3: a misrouted workflow could otherwise PATCH
 * dataset A with dataset B's bundle by passing the wrong path.
 *
 * Authorization: caller must be `role='service'` or `role='staff'`
 * with `is_admin=1`. The Phase 3pa publisher-store provisions
 * Cloudflare Access service tokens as `role='service'`, so the
 * workflow's `CF_Access_Client_Id` / `CF_Access_Client_Secret`
 * carry exactly the right identity by default.
 *
 * Failure envelopes match the rest of the publisher API:
 *   - 400 invalid_json / invalid_body / invalid_upload_id
 *   - 403 transcode_complete_forbidden — non-service caller
 *   - 404 not_found — dataset doesn't exist
 *   - 404 upload_not_found — upload_id doesn't exist or isn't
 *     bound to this dataset
 *   - 409 not_transcoding — the row isn't currently `transcoding=1`
 *   - 409 source_digest_mismatch — supplied digest doesn't match
 *   - 409 upload_kind_mismatch — the upload row isn't a video
 *     source (`kind != 'data'` or target_ref doesn't live under
 *     `uploads/`)
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import type { DatasetRow } from '../../../_lib/catalog-store'
import { writeDatasetAudit } from '../../../_lib/audit-store'
import { clearTranscoding, getAssetUpload, markTranscodingUploadCompleted } from '../../../_lib/asset-uploads'
import { invalidateSnapshot } from '../../../_lib/snapshot'
import { buildVideoBundleMasterKey, isVideoSourceKey } from '../../../_lib/r2-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

interface TranscodeCompleteBody {
  upload_id: string
  source_digest: string
}

function validateBody(raw: unknown): TranscodeCompleteBody | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'Request body must be an object.' }
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.upload_id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(obj.upload_id)) {
    return { error: 'upload_id must be a 26-character ULID.' }
  }
  if (typeof obj.source_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(obj.source_digest)) {
    return {
      error: 'source_digest is required and must be sha256:<64-hex>.',
    }
  }
  return { upload_id: obj.upload_id, source_digest: obj.source_digest }
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')

  // Restrict to service tokens + admin staff. Community publishers
  // (and even non-admin staff) shouldn't be flipping `transcoding`
  // through this endpoint — they go through the normal upload +
  // /complete flow, which manages the column server-side.
  const isAllowed =
    publisher.role === 'service' || (publisher.role === 'staff' && publisher.is_admin === 1)
  if (!isAllowed) {
    return jsonError(
      403,
      'transcode_complete_forbidden',
      'This endpoint is restricted to service tokens and admin staff.',
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

  if (!existing.transcoding) {
    // Idempotency check before returning the 409: if the row is
    // already in the post-transcode steady state for THIS upload
    // (data_ref points at the expected master.m3u8 and the
    // workflow's claimed source_digest still matches what we
    // recorded), treat the retry as success. The workflow's
    // HTTP call to this endpoint can drop its response on the
    // wire (R2 → GHA runner network blip), and the workflow's
    // retry loop would re-POST after the database has already
    // applied the change. Without this branch the retry sees
    // `transcoding IS NULL` and 409s — reporting a successful
    // transcode as a failure. PR #112 followup.
    //
    // The role guard at the top of the handler already restricts
    // callers to `role='service'` tokens (and admin staff), so
    // an attacker can't trigger this branch by planting a
    // data_ref via the publisher PUT path — only the workflow
    // can reach here, and `existing.source_digest` is set by the
    // /asset/.../complete stamp from the publisher's claim
    // (which the workflow re-verifies via streaming SHA before
    // calling here). The combination of "service-role caller" +
    // "source_digest matches the row's stored value" + "data_ref
    // already equals the path we'd compute here" is a state
    // only a previously-successful clearTranscoding for this
    // exact upload can produce.
    const expectedDataRef = `r2:${buildVideoBundleMasterKey(id, validated.upload_id)}`
    if (
      existing.data_ref === expectedDataRef &&
      existing.source_digest === validated.source_digest
    ) {
      // Re-run the asset_uploads bookkeeping before returning.
      // The first /transcode-complete call may have cleared the
      // dataset row (clearTranscoding) but failed to mark the
      // upload (transient D1 error after the first UPDATE). The
      // workflow's retry then lands here — without the catch-up
      // markTranscodingUploadCompleted, the upload row stays `pending`
      // and a later /asset/.../complete retry on the same upload
      // would re-stamp transcoding=1 and dispatch another
      // workflow. The mark step is itself idempotent
      // (`WHERE status='pending'`), so calling it on an already-
      // completed row is a no-op. PR #112 followup —
      // transcode-complete.ts:idempotent-skips-mark.
      const now = new Date().toISOString()
      await markTranscodingUploadCompleted(db, validated.upload_id, now)
      return new Response(
        JSON.stringify({ dataset: existing, idempotent: true }),
        {
          status: 200,
          headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
        },
      )
    }
    return jsonError(
      409,
      'not_transcoding',
      `Dataset ${id} is not currently transcoding (transcoding column is NULL/0). ` +
        'Did the workflow fire twice or against the wrong id?',
    )
  }

  // Look up the upload row. Two things to verify: (a) the upload
  // belongs to *this* dataset, defending against a workflow that
  // dispatched on dataset A trying to PATCH dataset B; (b) the
  // upload was a video source (not a thumbnail or some other
  // kind that happened to share the upload_id namespace).
  const upload = await getAssetUpload(db, validated.upload_id)
  if (!upload || upload.dataset_id !== id) {
    return jsonError(
      404,
      'upload_not_found',
      `Upload ${validated.upload_id} not found for dataset ${id}.`,
    )
  }
  const targetKey = upload.target_ref.startsWith('r2:')
    ? upload.target_ref.slice('r2:'.length)
    : ''
  if (upload.kind !== 'data' || !isVideoSourceKey(targetKey)) {
    return jsonError(
      409,
      'upload_kind_mismatch',
      `Upload ${validated.upload_id} is not a video source (kind=${upload.kind}, target=${upload.target_ref}).`,
    )
  }

  // Primary stale-callback guard: the row's `active_transcode_upload_id`
  // (set in lockstep with `transcoding=1` by /asset/.../complete) must
  // match the workflow's `upload_id`. Two re-uploads of an identical
  // MP4 produce identical `source_digest`s, so the per-upload binding
  // is the only check that disambiguates them. Migration 0012.
  if (existing.active_transcode_upload_id !== validated.upload_id) {
    return jsonError(
      409,
      'transcode_upload_mismatch',
      `Dataset ${id}'s active transcode is bound to upload ` +
        `${existing.active_transcode_upload_id ?? '(none)'}; got upload ` +
        `${validated.upload_id}. Refusing to apply — a newer upload has ` +
        'taken over, or the row was reset out of band.',
    )
  }

  // Defense-in-depth: source_digest still has to match. The active-
  // upload-id check above is the primary guard, but if a row's
  // `active_transcode_upload_id` and `source_digest` ever drift
  // (e.g. partial migration, manual D1 edit), this catches it
  // before we flip data_ref.
  if (existing.source_digest !== validated.source_digest) {
    return jsonError(
      409,
      'source_digest_mismatch',
      `Supplied source_digest does not match the value stored at upload time. ` +
        'Refusing to apply — the workflow may be PATCHing the wrong dataset.',
    )
  }

  // Build the data_ref server-side from the *route* id and the
  // *upload* id. The workflow doesn't get to choose; even a
  // forged body can't point the row at another dataset's bundle.
  const dataRef = `r2:${buildVideoBundleMasterKey(id, validated.upload_id)}`

  const now = new Date().toISOString()
  // The UPDATE itself has `AND active_transcode_upload_id = ?`,
  // so it's atomic with the JS-level check above — if a
  // different /asset/.../complete swapped the binding in the
  // gap between the SELECT and this call (TOCTOU window),
  // changes will be 0 and we refuse to apply. The 409 envelope
  // mirrors the explicit check's `transcode_upload_mismatch`
  // shape so the workflow's retry logic treats them the same
  // way: "another upload took over; this run is stale."
  const changes = await clearTranscoding(db, id, validated.upload_id, dataRef, now)
  if (changes === 0) {
    return jsonError(
      409,
      'transcode_upload_mismatch',
      `Dataset ${id}'s active transcode binding changed between the freshness check and ` +
        `the apply step (upload ${validated.upload_id} was no longer active when we tried ` +
        'to clear it). Refusing to apply — a newer upload has taken over.',
    )
  }

  // Also mark the asset_uploads row completed. The /asset/.../complete
  // route already does this after dispatch succeeds, but that step can
  // fail (transient D1 error, request abort) leaving the upload row
  // stuck `pending`. Re-marking here is the durable backstop: by the
  // time /transcode-complete runs, the dispatch has demonstrably
  // succeeded (the workflow is calling back), so the upload row's
  // `pending` state is just bookkeeping debt. PR #112 followup —
  // closes the alreadyCompleted recovery vector by making
  // `upload.status` the only signal a retry of /complete needs.
  await markTranscodingUploadCompleted(db, validated.upload_id, now)

  // Refresh the row so the response carries the latest state.
  const updated = await db
    .prepare(`SELECT * FROM datasets WHERE id = ?`)
    .bind(id)
    .first<DatasetRow>()

  // Always invalidate when transcode finishes — for a draft this
  // is a no-op (drafts don't appear in the snapshot), but for a
  // re-upload to a published row the snapshot still holds the
  // *old* data_ref and needs a refresh so public clients pick up
  // the new HLS bundle on their next read.
  if (updated?.published_at && !updated.retracted_at) {
    await invalidateSnapshot(context.env)
  }

  // Audit lists every column `clearTranscoding` mutates so the
  // operator-facing history captures the full server-managed
  // state change, not just the publisher-visible columns. The
  // earlier list (`data_ref`, `transcoding`) omitted the two
  // companions: `active_transcode_upload_id` (cleared in
  // lockstep with `transcoding`) and `content_digest` (cleared
  // atomically with the data_ref swap — HLS bundles don't
  // carry a single digest). PR #112 followup —
  // transcode-complete.ts audit completeness.
  await writeDatasetAudit(db, publisher, 'dataset.update', id, {
    fields: ['data_ref', 'transcoding', 'active_transcode_upload_id', 'content_digest'],
    reason: 'transcode_complete',
    upload_id: validated.upload_id,
  })

  return new Response(
    JSON.stringify({ dataset: updated }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}
