/**
 * POST /api/v1/publish/datasets/{id}/asset/{upload_id}/complete
 *
 * Finalise an asset upload that the publisher claims has finished
 * uploading bytes to the URL we minted in `POST .../asset`.
 *
 * Steps:
 *   1. Look up the `asset_uploads` row by `upload_id`. 404 if not
 *      found, 409 if not still `pending` (idempotent retry on a
 *      completed row → 200 with the existing dataset; re-attempt on
 *      a failed row → 409, the publisher must mint a fresh upload).
 *   2. Authorise: caller must own the dataset (same scope rule as
 *      the rest of `/publish/`).
 *   3. Verify the digest:
 *        - R2 uploads:    fetch the object via the R2 binding and
 *                         recompute SHA-256. Mismatch → mark failed,
 *                         return 409.
 *        - Stream uploads: poll Stream's transcode-status endpoint.
 *                          Still processing → 202 with a retry hint
 *                          (no row mutation). Errored → mark failed.
 *                          Ready → trust the publisher's claim as
 *                          source_digest; full master-playlist hash
 *                          for `content_digest` is a Phase 4
 *                          concern.
 *   4. Flip the `*_ref` column on the `datasets` row (and either
 *      `content_digest` for R2 data, `source_digest` for Stream
 *      data, or `auxiliary_digests.<kind>` for auxiliary assets).
 *   5. Mark the asset_uploads row `completed`.
 *   6. Invalidate the KV catalog snapshot if the dataset is
 *      currently published — same rule as `updateDataset`.
 *   7. Return the updated dataset row in the same envelope shape as
 *      `GET /api/v1/publish/datasets/{id}`.
 *
 * Failure envelopes match the rest of the publisher API:
 *   - `{ error, message }` for 404 / 409 / 503 system-level errors.
 *   - `{ errors: [{field, code, message}] }` is unused here — there's
 *     no body to validate beyond the upload id, which lives in the
 *     URL path.
 */

import type { CatalogEnv } from '../../../../../_lib/env'
import type { PublisherData } from '../../../../_middleware'
import type { DatasetRow } from '../../../../../_lib/catalog-store'
import { getDatasetForPublisher } from '../../../../../_lib/dataset-mutations'
import { isConfigurationError, isUpstreamError, safeErrorReason } from '../../../../../_lib/errors'
import { isLoopbackHost } from '../../../../../_lib/loopback'
import {
  FRAME_OPERATION_CONCURRENCY,
  runBoundedPool,
} from '../../../../../_lib/bounded-pool'
import { invalidateSnapshot } from '../../../../../_lib/snapshot'
import {
  buildContentAddressedFrameKey,
  buildFrameSourceFilenamesKey,
  isVideoSourceKey,
  verifyContentDigest,
  verifyObjectExists,
} from '../../../../../_lib/r2-store'
import { parseFrameManifest } from '../../../../../_lib/frames-manifest'
import { getTranscodeStatus } from '../../../../../_lib/stream-store'
import { dispatchTranscode } from '../../../../../_lib/github-dispatch'
import { mimeMatchesFormat } from '../../asset'
import {
  applyAssetAndMarkCompleted,
  extForMime,
  getAssetUpload,
  markAssetUploadFailed,
  markTranscodingUploadCompleted,
  revertTranscodingStamp,
  stampTranscodingForFrameSource,
  stampTranscodingForVideoSource,
  type AssetUploadRow,
} from '../../../../../_lib/asset-uploads'
import {
  type JobQueue,
  WaitUntilJobQueue,
} from '../../../../../_lib/job-queue'
import {
  generateSphereThumbnail,
  type SphereThumbnailJobPayload,
} from '../../../../../_lib/sphere-thumbnail-job'

/** Test injection point — middleware/tests can pre-populate `context.data.jobQueue`. */
interface CompleteContextData extends PublisherData {
  jobQueue?: JobQueue
}

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error, message, ...extra }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

interface RouteParams {
  id: string
  upload_id: string
}

function pickParam(value: string | string[] | undefined): string | null {
  if (!value) return null
  return Array.isArray(value) ? value[0] : value
}

export const onRequestPost: PagesFunction<CatalogEnv, keyof RouteParams> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const datasetId = pickParam(context.params.id as string | string[] | undefined)
  const uploadId = pickParam(context.params.upload_id as string | string[] | undefined)
  if (!datasetId || !uploadId) {
    return jsonError(400, 'invalid_request', 'Missing dataset id or upload id.')
  }

  const dataset = await getDatasetForPublisher(context.env.CATALOG_DB!, publisher, datasetId)
  if (!dataset) return jsonError(404, 'not_found', `Dataset ${datasetId} not found.`)

  const upload = await getAssetUpload(context.env.CATALOG_DB!, uploadId)
  if (!upload) return jsonError(404, 'not_found', `Upload ${uploadId} not found.`)

  // Tie the upload to the dataset id from the URL — the storage row
  // is the source of truth, but a publisher who's discovered another
  // tenant's upload_id should not be able to apply it to their own
  // dataset.
  if (upload.dataset_id !== datasetId) {
    return jsonError(404, 'not_found', `Upload ${uploadId} not found.`)
  }

  if (upload.status === 'completed') {
    // Idempotent retry — the row was already applied. Re-read the
    // dataset so the caller sees the latest persisted state — the
    // initial load happens before the upload-status check, so it
    // misses any background mutations (e.g. sphere-thumbnail
    // generation against the just-applied asset, or the workflow's
    // /transcode-complete callback flipping data_ref) that landed
    // since.
    //
    // The `transcoding` boolean mirrors the success-path response
    // shape so a client that retries /complete inside the
    // transcoding window (the upload row is `completed` but the
    // workflow hasn't fired /transcode-complete yet) still gets
    // routed to the "transcoding" branch of the uploader UI rather
    // than the "direct upload done" branch. Without this the
    // asset-uploader would set `stage = 'done-direct'` and notify
    // the parent with `mode: 'direct'`, which mis-paints the form
    // state for a row that's actually still waiting on the GHA
    // workflow.
    const currentDataset =
      (await getDatasetForPublisher(context.env.CATALOG_DB!, publisher, datasetId)) ?? dataset
    return new Response(
      JSON.stringify({
        dataset: currentDataset,
        upload,
        idempotent: true,
        transcoding: currentDataset.transcoding === 1,
      }),
      {
        status: 200,
        headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
      },
    )
  }
  if (upload.status === 'failed') {
    return jsonError(
      409,
      'upload_failed',
      `Upload ${uploadId} previously failed (${upload.failure_reason ?? 'unknown'}). Mint a fresh upload to retry.`,
    )
  }

  // Phase 3pf image-sequence branch: a non-NULL `frame_count` on
  // the asset_uploads row means the publisher uploaded N frames at
  // `uploads/{ds}/{up}/frames/{NNNNN}.{ext}` rather than a single
  // `source.mp4`. The HEAD verification, stamp, and dispatch shape
  // all differ from the single-file path; route into the
  // image-sequence helper so each branch's logic stays focused.
  if (upload.frame_count != null) {
    return handleFrameSourceComplete(context, datasetId, uploadId, dataset, upload)
  }

  // Re-verify upload.mime still matches dataset.format. The
  // /asset mint route already checked this at mint time, but
  // updateDataset accepts a format mutation as long as the row
  // isn't currently `transcoding=1`. Between mint and /complete
  // the publisher could PUT a fresh format:
  //
  //   1. POST /asset { kind: 'data', mime: 'video/mp4' } → mint OK
  //   2. PUT /datasets/{id} { format: 'image/png' } → accepted
  //      (the row isn't transcoding yet, so /AE's data_ref/format
  //      guard doesn't fire)
  //   3. POST /asset/{upload_id}/complete → currently stamps a
  //      video transcode + dispatches the workflow, which will
  //      eventually write an HLS data_ref into a row that now
  //      declares image format
  //
  // Re-checking here closes the gap. The error envelope mirrors
  // the mint-time `mime_format_mismatch` shape so the client
  // already knows how to render it. PR #112 followup —
  // complete.ts:format-revalidation.
  if (upload.kind === 'data' && !mimeMatchesFormat(upload.mime, dataset.format)) {
    return new Response(
      JSON.stringify({
        errors: [
          {
            field: 'format',
            code: 'mime_format_mismatch',
            message:
              `Upload ${uploadId} was minted for mime "${upload.mime}" but the dataset ` +
              `format is now "${dataset.format}". The format was changed between mint and ` +
              `complete; mint a fresh upload that matches the current format, or revert ` +
              `the format change first.`,
          },
        ],
      }),
      { status: 409, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  // ----- Verify the digest -----
  let verifiedDigest = upload.claimed_digest

  if (upload.target === 'r2') {
    if (!upload.target_ref.startsWith('r2:')) {
      return jsonError(500, 'malformed_target_ref', `Upload ${uploadId} has an unparseable target_ref.`)
    }
    // Mock mode: no real bytes were written (the publisher's PUT
    // went to mock-r2.localhost), so binding-based verification
    // would always 404. Trust the publisher's claimed digest, same
    // bargain we make for Stream uploads in production. Refuses to
    // honour MOCK_R2=true on a non-loopback hostname so a
    // misconfigured production deploy can't silently accept forged
    // claims — defense in depth, identical to the dev-bypass
    // middleware's loopback check.
    if (context.env.MOCK_R2 === 'true') {
      const url = new URL(context.request.url)
      if (!isLoopbackHost(url.hostname)) {
        return jsonError(
          500,
          'mock_r2_unsafe',
          `MOCK_R2=true refuses to honor a non-loopback hostname (got "${url.hostname}").`,
        )
      }
      verifiedDigest = upload.claimed_digest
    } else {
      const key = upload.target_ref.slice('r2:'.length)
      if (isVideoSourceKey(key)) {
        // Video sources can be up to 10 GB — the standard
        // arrayBuffer-based digest recompute would blow past the
        // Workers 128 MB memory cap (Phase 3pd review fix for
        // `Memory limit would be exceeded before EOF.`).
        //
        // Just confirm the upload arrived (HEAD-style check) and
        // trust the publisher's claim here; the GHA transcode
        // runner re-hashes the source bytes via Node's streaming
        // `crypto.createHash` before kicking off ffmpeg, so a
        // tampered upload surfaces as the runner's exit-code-2 +
        // stuck `transcoding=1` rather than as bad bytes encoded
        // into the HLS bundle. Same security trade we made for
        // Stream uploads pre-3pd ("Stream's UID is opaque, trust
        // the claim until the workflow runs").
        const existence = await verifyObjectExists(context.env, key)
        if (!existence.ok) {
          const now = new Date().toISOString()
          if (existence.reason === 'binding_missing') {
            return jsonError(503, 'r2_binding_missing', 'CATALOG_R2 binding is not configured on this deployment.')
          }
          // 'missing'
          await markAssetUploadFailed(context.env.CATALOG_DB!, uploadId, 'asset_missing', now)
          return jsonError(
            409,
            'asset_missing',
            `Object at ${key} is not present in R2. The publisher likely never uploaded the bytes; mint a fresh upload to retry.`,
          )
        }
        // Truncation guard: confirm R2's recorded size matches the
        // publisher's declared_size. Without this, a connection-
        // dropped PUT that landed a partial object would pass the
        // existence check, stamp the row as transcoding, fire the
        // dispatch, and only fail in the GHA runner's streaming
        // digest recompute — leaving the row stuck `transcoding=1`
        // until operator cleanup. The existence helper already
        // reads `head.size`; comparing it here is a cheap cut.
        // PR #112 followup — complete.ts:216.
        if (existence.size !== upload.declared_size) {
          const now = new Date().toISOString()
          await markAssetUploadFailed(context.env.CATALOG_DB!, uploadId, 'size_mismatch', now)
          return jsonError(
            409,
            'size_mismatch',
            `Object at ${key} is ${existence.size} bytes; the publisher declared ` +
              `${upload.declared_size}. The PUT was likely truncated mid-upload — ` +
              'mint a fresh upload and re-PUT the full file.',
            { declared: upload.declared_size, actual: existence.size },
          )
        }
        verifiedDigest = upload.claimed_digest
      } else {
        const verification = await verifyContentDigest(context.env, key, upload.claimed_digest)
        if (!verification.ok) {
          const now = new Date().toISOString()
          switch (verification.reason) {
            case 'binding_missing':
              return jsonError(503, 'r2_binding_missing', 'CATALOG_R2 binding is not configured on this deployment.')
            case 'malformed_claim':
              // Should never reach here — the init handler validates the
              // claim shape — but defending against direct row writes.
              await markAssetUploadFailed(context.env.CATALOG_DB!, uploadId, 'malformed_claim', now)
              return jsonError(409, 'malformed_claim', 'Stored content_digest claim is malformed.')
            case 'missing':
              await markAssetUploadFailed(context.env.CATALOG_DB!, uploadId, 'asset_missing', now)
              return jsonError(
                409,
                'asset_missing',
                `Object at ${key} is not present in R2. The publisher likely never uploaded the bytes; mint a fresh upload to retry.`,
              )
            case 'mismatch':
              await markAssetUploadFailed(context.env.CATALOG_DB!, uploadId, 'digest_mismatch', now)
              return jsonError(409, 'digest_mismatch', 'Recomputed digest does not match the claim.', {
                claimed: verification.claimed,
                actual: verification.actual,
              })
          }
        }
        verifiedDigest = verification.digest
      }
    }
  } else if (upload.target === 'stream') {
    if (!upload.target_ref.startsWith('stream:')) {
      return jsonError(500, 'malformed_target_ref', `Upload ${uploadId} has an unparseable target_ref.`)
    }
    // Defense-in-depth parallel to MOCK_R2 above: in mock mode,
    // `getTranscodeStatus` reports `ready` without contacting Stream,
    // so a misconfigured production deploy could "complete" video
    // uploads without any real Stream asset existing. Refuse on any
    // non-loopback hostname.
    if (context.env.MOCK_STREAM === 'true') {
      const url = new URL(context.request.url)
      if (!isLoopbackHost(url.hostname)) {
        return jsonError(
          500,
          'mock_stream_unsafe',
          `MOCK_STREAM=true refuses to honor a non-loopback hostname (got "${url.hostname}").`,
        )
      }
    }
    const uid = upload.target_ref.slice('stream:'.length)
    let status
    try {
      status = await getTranscodeStatus(context.env, uid)
    } catch (err) {
      if (isConfigurationError(err)) {
        return jsonError(503, 'stream_unconfigured', safeErrorReason(err, 'Stream backend is not configured.'))
      }
      // Stream returned 404 → the uid we minted at /asset isn't
      // present. Either the publisher's POST never reached Stream
      // or Stream lost the asset; either way the upload is dead and
      // the publisher needs to mint a fresh one.
      if (isUpstreamError(err) && err.status === 404) {
        const failedAt = new Date().toISOString()
        await markAssetUploadFailed(
          context.env.CATALOG_DB!,
          uploadId,
          'stream_asset_not_found',
          failedAt,
        )
        return jsonError(
          409,
          'stream_asset_not_found',
          `Stream asset "${uid}" could not be found. Mint a fresh upload to retry.`,
        )
      }
      return jsonError(502, 'stream_upstream_error', safeErrorReason(err, 'Stream returned an error.'))
    }
    if (status.state === 'pending' || status.state === 'processing') {
      return jsonError(
        202,
        'transcode_in_progress',
        `Stream transcode is ${status.state}. Retry after a short delay.`,
      )
    }
    if (status.state === 'error') {
      // `failure_reason` is documented as a stable machine-readable
      // code (per `migrations/catalog/0006_asset_uploads.sql`), so
      // store the canonical `transcode_error` regardless of how
      // verbose Stream's reason text is. The detail still flows
      // through the API response message so the publisher / CLI
      // can surface it for debugging.
      const now = new Date().toISOString()
      const detail = status.errors?.join(', ') || 'unknown'
      await markAssetUploadFailed(context.env.CATALOG_DB!, uploadId, 'transcode_error', now)
      return jsonError(409, 'transcode_error', `Stream transcoding failed: ${detail}`)
    }
    // ready — trust the publisher's claimed digest (source-of-truth
    // hash); see `CATALOG_ASSETS_PIPELINE.md` "Stream assets:
    // bridging the model".
    verifiedDigest = upload.claimed_digest
  } else {
    // Unknown `target`. The init handler only ever writes `'r2'` or
    // `'stream'`, so reaching here means the row was tampered with
    // (manual D1 edit, schema regression, etc). Fail closed — mark
    // the upload row failed and refuse to apply unverified bytes.
    const failedAt = new Date().toISOString()
    await markAssetUploadFailed(
      context.env.CATALOG_DB!,
      uploadId,
      'unknown_target',
      failedAt,
    )
    return jsonError(
      500,
      'unknown_target',
      `Upload ${uploadId} has an unrecognised target "${upload.target}". The asset will not be applied.`,
    )
  }

  // ----- Apply to the dataset row + mark the upload complete -----
  // Atomic via `db.batch` so the dataset row and the upload row can
  // never end up in disagreement (e.g. dataset has the new ref but
  // the upload row still reads 'pending', which would let a retry
  // re-fire the sphere-thumbnail enqueue + KV invalidation).
  const now = new Date().toISOString()

  // Phase 3pd video-source branch: the upload bytes are an MP4 at
  // `uploads/{dataset_id}/{upload_id}/source.mp4`, not the final
  // asset the catalog serves. The workflow does the encoding
  // asynchronously and POSTs `/transcode-complete` when done.
  //
  // Ordering matters: we **persist transcoding=1 BEFORE firing
  // the dispatch**, then **mark the upload completed AFTER the
  // dispatch confirms**. The dispatch is the external side
  // effect; we want the row to already match what the workflow
  // will expect by the time it asks. Phase 3pd review fix #9 —
  // the prior order (dispatch first, persist second) could
  // produce a race where the workflow ran against a
  // non-transcoding row and got 409 from /transcode-complete.
  //
  // Failure paths:
  //   - dispatch fails: revert `transcoding` back to NULL +
  //     restore the prior `data_ref` (compensating UPDATE).
  //     The upload row stays `pending` so the publisher can
  //     retry /complete after the operator fixes the GitHub
  //     config. 502 / 503 with the underlying error message.
  //   - persist fails before dispatch: nothing fired, no state
  //     change. Surfaced as the unhandled-exception path
  //     (the middleware wraps it).
  //   - mark-completed fails after dispatch succeeds: the
  //     workflow runs, the dataset row says transcoding=1, the
  //     workflow PATCHes via /transcode-complete which clears
  //     it — the asset_uploads row stays `pending` but that's
  //     cosmetic (the publisher-facing surface is the dataset
  //     row's `transcoding` flag).
  const isVideoSource =
    upload.target === 'r2' &&
    upload.target_ref.startsWith('r2:') &&
    isVideoSourceKey(upload.target_ref.slice('r2:'.length))

  if (isVideoSource) {
    // Refuse mock-mode dispatch on a non-loopback hostname for the
    // same reason MOCK_R2 / MOCK_STREAM refuse: a production
    // misconfig with MOCK_GITHUB_DISPATCH=true could otherwise
    // claim transcodes that never run.
    if (context.env.MOCK_GITHUB_DISPATCH === 'true') {
      const url = new URL(context.request.url)
      if (!isLoopbackHost(url.hostname)) {
        return jsonError(
          500,
          'mock_github_dispatch_unsafe',
          `MOCK_GITHUB_DISPATCH=true refuses to honor a non-loopback hostname (got "${url.hostname}").`,
        )
      }
    }

    // Concurrency guard: refuse to start a second video transcode
    // on a row whose previous upload is still in flight, OR on a
    // row in an inconsistent transcoding state. Three sub-cases
    // all return 409:
    //
    //   • `transcoding=1 AND active=otherUpload` — the row is
    //     legitimately transcoding for someone else. Wait for it
    //     to finish.
    //   • `transcoding=1 AND active=NULL` — corrupted state
    //     (pre-migration-0012 row, manual D1 edit, or a partial
    //     reset). The stamp and clear paths set the two columns
    //     in lockstep, so a NULL active with transcoding=1 means
    //     the row is in a shape the lifecycle never produces.
    //     PR #112 followup flagged this as a fall-through hole
    //     where the new upload would re-stamp and a second
    //     workflow could run alongside whatever prior workflow
    //     left the row stuck. Operator must clear (UPDATE
    //     datasets SET transcoding = NULL,
    //     active_transcode_upload_id = NULL WHERE id = '...')
    //     before any new upload can take over.
    //   • `transcoding=1 AND active=uploadId` — retry of THIS
    //     upload, falls through to the alreadyStamped recovery
    //     branch below; not a conflict.
    //
    // The upload-row status check above already short-circuits
    // a true status='completed' repeat before we get here.
    if (dataset.transcoding && dataset.active_transcode_upload_id !== uploadId) {
      const activeLabel = dataset.active_transcode_upload_id ?? '(none — corrupted state)'
      const detail = dataset.active_transcode_upload_id
        ? `Wait for that workflow to finish (or have an operator clear the row) before starting another.`
        : `The row is in an inconsistent state (transcoding=1 with no active upload binding). ` +
          `Have an operator reset the row (UPDATE datasets SET transcoding = NULL, ` +
          `active_transcode_upload_id = NULL WHERE id = '${datasetId}') before retrying.`
      return jsonError(
        409,
        'transcoding_in_progress',
        `Dataset ${datasetId} is already transcoding upload ${activeLabel}. ${detail}`,
      )
    }

    // Note on retry behaviour for stuck-pending uploads:
    // earlier followups carried an `alreadyStamped` recovery
    // branch that short-circuited a retry of /complete when the
    // row was already in the `transcoding=1 +
    // active_transcode_upload_id = uploadId` state. That branch
    // was meant to absorb the case "stamp succeeded, dispatch
    // succeeded, markTranscodingUploadCompleted failed transiently"
    // without firing a duplicate dispatch. PR #112 followup
    // pointed out that the same row state can ALSO be produced
    // by "stamp succeeded, dispatch failed, revertTranscodingStamp
    // ALSO failed" — and in that case there's no workflow
    // running and short-circuiting would permanently strand
    // the row (transcoding=1 with no callback ever coming).
    // Without a durable "dispatch succeeded" marker the row
    // state cannot distinguish the two cases, so the recovery
    // branch is gone. The retry path falls through to a fresh
    // stamp (a no-op for the same upload — the SQL's
    // `active_transcode_upload_id = uploadId` clause allows it)
    // followed by a fresh dispatch. The workflow itself is
    // idempotent (deterministic ffmpeg output keyed on source
    // bytes + upload_id), and /transcode-complete is idempotent
    // on a same-upload retry of an already-applied row
    // (3pd-followup/AQ on transcode-complete.ts), so a duplicate
    // workflow caused by the rare "mark step failed after
    // dispatch succeeded" case is bounded cost (≈ a few extra
    // minutes of compute) rather than a stranded row.

    // 1. Persist the dataset-row half (transcoding=1, +
    //    conditional data_ref clear, + source_digest, +
    //    content_digest=NULL). The asset_uploads row stays
    //    `pending` for now — that's the cursor we'll flip
    //    after the dispatch confirms.
    //
    //    The stamp is conditional in SQL on
    //    `active_transcode_upload_id IS NULL OR = uploadId`,
    //    so it's atomic with the JS-level overlap check above:
    //    if a concurrent /complete swapped the binding to a
    //    different upload in the gap between our SELECT and
    //    this UPDATE, changes=0 and we surface 409 instead of
    //    launching a stale workflow (PR #112 followup —
    //    asset-uploads.ts:407).
    // Capture the pre-stamp integrity snapshot. The stamp
    // clears (drafts) or preserves (published) content_digest
    // and overwrites source_digest with the new claim — without
    // capturing the prior values here, a dispatch-failure
    // revert can only restore data_ref and leaves the row in
    // an inconsistent "asset present, no integrity hash" shape.
    // PR #112 followup — asset-uploads.ts:revertTranscodingStamp.
    const priorStampState = {
      data_ref: dataset.data_ref,
      content_digest: dataset.content_digest,
      source_digest: dataset.source_digest,
      // The MP4 stamp doesn't write these, so the revert leaves
      // them at the row's pre-stamp values (NULL on a fresh row,
      // or the prior upload's values if this is a re-upload of an
      // image-sequence row — in that case the revert is a no-op
      // on the frame columns, which is what we want).
      frame_count: dataset.frame_count,
      frame_extension: dataset.frame_extension,
      frame_source_filenames_ref: dataset.frame_source_filenames_ref,
    }
    const stamped = await stampTranscodingForVideoSource(
      context.env.CATALOG_DB!,
      datasetId,
      upload,
      now,
    )
    if (stamped === 0) {
      return jsonError(
        409,
        'transcoding_in_progress',
        `Dataset ${datasetId}'s active transcode binding changed between the freshness check ` +
          `and the stamp step — a concurrent upload took over. Wait for that workflow to ` +
          'finish (or have an operator clear the row) before starting another.',
      )
    }

    // 2. Fire the external side effect.
    try {
      await dispatchTranscode(context.env, {
        kind: 'video',
        dataset_id: datasetId,
        upload_id: uploadId,
        source_key: upload.target_ref.slice('r2:'.length),
        source_digest: verifiedDigest,
      })
    } catch (err) {
      // Compensating revert. Best-effort — if this throws, the
      // row is stuck `transcoding=1` and an operator has to
      // clear it by hand; log via console.error so wrangler
      // tail surfaces it.
      //
      // The UPDATE is scoped to `AND active_transcode_upload_id = ?`
      // so a concurrent /complete that re-stamped the row to a
      // different upload's id (in the gap between our stamp and
      // this dispatch failure) won't be clobbered — changes will
      // be 0 and we log it as "lost the race" rather than wiping
      // the newer upload's in-flight state.
      try {
        const reverted = await revertTranscodingStamp(
          context.env.CATALOG_DB!,
          datasetId,
          upload,
          priorStampState,
          new Date().toISOString(),
        )
        if (reverted === 0) {
          console.warn(
            `[asset/complete] revert of transcoding stamp on ${datasetId} was a ` +
              `no-op — another upload took over the active binding before the ` +
              `dispatch-failure handler ran (upload ${uploadId} lost the race).`,
          )
        }
      } catch (revertErr) {
        console.error(
          `[asset/complete] failed to revert transcoding stamp on ${datasetId}:`,
          revertErr,
        )
      }
      if (isConfigurationError(err)) {
        return jsonError(503, 'github_dispatch_unconfigured', safeErrorReason(err, 'GitHub dispatch is not configured.'))
      }
      return jsonError(502, 'github_dispatch_upstream_error', safeErrorReason(err, 'GitHub dispatch failed.'))
    }

    // 3. Mark the upload row completed only after the dispatch
    //    succeeded. A later /complete retry on the same upload
    //    would now read status='completed' and short-circuit
    //    cleanly via the idempotent branch above.
    await markTranscodingUploadCompleted(context.env.CATALOG_DB!, uploadId, now)

    const updatedAfterDispatch = await context.env.CATALOG_DB!
      .prepare(`SELECT * FROM datasets WHERE id = ?`)
      .bind(datasetId)
      .first<DatasetRow>()
    return new Response(
      JSON.stringify({
        dataset: updatedAfterDispatch,
        upload: { ...upload, status: 'completed', completed_at: now },
        verified_digest: verifiedDigest,
        transcoding: true,
      }),
      {
        status: 202,
        headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
      },
    )
  }

  await applyAssetAndMarkCompleted(
    context.env.CATALOG_DB!,
    datasetId,
    upload,
    verifiedDigest,
    now,
  )

  // Read the updated row so we can return it + decide whether the
  // public catalog snapshot needs invalidation.
  const updated = await context.env.CATALOG_DB!
    .prepare(`SELECT * FROM datasets WHERE id = ?`)
    .bind(datasetId)
    .first<DatasetRow>()
  if (updated?.published_at && !updated.retracted_at) {
    await invalidateSnapshot(context.env)
  }

  // Kick off sphere-thumbnail generation when the source asset is
  // the kind we know how to render from: the primary `data` ref or
  // a publisher-supplied `thumbnail`. The job runs against the
  // request's `ctx.waitUntil` so the response goes back without
  // blocking.
  if (upload.kind === 'data' || upload.kind === 'thumbnail') {
    const queue = (context.data as unknown as CompleteContextData).jobQueue
      ?? new WaitUntilJobQueue(context.env, context.waitUntil.bind(context))
    const payload: SphereThumbnailJobPayload = {
      dataset_id: datasetId,
      source_ref: upload.target_ref,
    }
    await queue.enqueue<SphereThumbnailJobPayload>(
      'sphere_thumbnail',
      (env, p) => generateSphereThumbnail(env as CatalogEnv, p),
      payload,
    )
  }

  return new Response(
    JSON.stringify({
      dataset: updated,
      upload: { ...upload, status: 'completed', completed_at: now },
      verified_digest: verifiedDigest,
    }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}

/**
 * Phase 3pf — finalise an image-sequence upload.
 *
 * Parallel to the video-source branch in the main handler but with
 * three differences:
 *
 *   1. HEAD-checks every per-frame key + the source-filenames blob
 *      (the MP4 path HEAD-checks a single `source.mp4`).
 *   2. Stamps `frame_count`, `frame_extension`, and
 *      `frame_source_filenames_ref` on the dataset row alongside
 *      the usual transcoding lifecycle columns
 *      (`stampTranscodingForFrameSource`).
 *   3. Dispatches with `kind: 'frames'` so the GHA runner branches
 *      to its image-sequence ffmpeg invocation. The dispatch's
 *      `source_digest` carries the SHA-256 of the canonical
 *      source-filenames JSON (the runner re-verifies before
 *      starting the encode); per-frame digest verification stays
 *      a "trust the publisher's claim" trade — same bargain the
 *      MP4 path makes for the source MP4's hash, on the same
 *      logic (re-hashing N × 30 MB frames inside the Worker would
 *      blow past the 128 MB memory cap).
 *
 * Mock-mode handling, transcoding-overlap guards, dispatch-failure
 * revert + lost-race logging — all mirror the MP4 path. The
 * compensating revert clears the three new frame columns via
 * `revertTranscodingStamp` (extended in 3pf/B to do so), so a
 * dispatch failure on a frames upload leaves the row in exactly
 * the state it was in before /complete fired.
 */
async function handleFrameSourceComplete(
  context: Parameters<PagesFunction<CatalogEnv, keyof RouteParams>>[0],
  datasetId: string,
  uploadId: string,
  dataset: DatasetRow,
  upload: AssetUploadRow,
): Promise<Response> {
  // Re-verify dataset.format is still video/mp4. The format could
  // have been mutated between /asset and /complete (the route
  // accepts format changes on non-transcoding rows). Closes the
  // same gap the MP4 path's mime/format re-check closes.
  if (dataset.format !== 'video/mp4') {
    return new Response(
      JSON.stringify({
        errors: [
          {
            field: 'format',
            code: 'frames_require_video_format',
            message:
              `Upload ${uploadId} was minted for an image-sequence upload (frame_count=` +
              `${upload.frame_count}) targeting a video dataset, but dataset ${datasetId}'s ` +
              `format is now "${dataset.format}". The format was changed between mint and ` +
              `complete; mint a fresh upload after deciding whether the row should accept ` +
              `frames (set format=video/mp4) or a single image (use the single-file flow).`,
          },
        ],
      }),
      { status: 409, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  const frameCount = upload.frame_count as number
  // `extension` is recomputed from `upload.mime` rather than
  // stored on the asset_uploads row. This relies on `extForMime`
  // being stable across the mint → complete window: if a future
  // change ever flipped `image/jpeg` from `jpg` to `jpeg`, an
  // upload minted before the change but completed after would
  // HEAD the wrong keys (the bytes landed at `jpg`-suffixed
  // keys; the new mapping would look for `jpeg`-suffixed ones).
  // The mapping is intentionally well-known + stable (it mirrors
  // the canonical Web MIME ↔ extension associations), so the
  // risk is low. If we ever need to mutate it, add a
  // `frame_extension` column to asset_uploads in a migration so
  // the mint-time value is the source of truth. Phase 3pf-review/E
  // — Copilot discussion_r3263124313.
  const extension = extForMime(upload.mime)

  // Concurrency guard — same logic as the MP4 path. A row already
  // transcoding for a different upload refuses to take over.
  if (dataset.transcoding && dataset.active_transcode_upload_id !== uploadId) {
    const activeLabel = dataset.active_transcode_upload_id ?? '(none — corrupted state)'
    const detail = dataset.active_transcode_upload_id
      ? `Wait for that workflow to finish (or have an operator clear the row) before starting another.`
      : `The row is in an inconsistent state (transcoding=1 with no active upload binding). ` +
        `Have an operator reset the row before retrying.`
    return jsonError(
      409,
      'transcoding_in_progress',
      `Dataset ${datasetId} is already transcoding upload ${activeLabel}. ${detail}`,
    )
  }

  // Mock-mode loopback refusal — same defense in depth as the
  // MP4 path. A misconfigured production deploy with MOCK_R2=true
  // could otherwise short-circuit the HEAD checks and stamp the
  // row as transcoding without any frames present.
  const mockR2 = context.env.MOCK_R2 === 'true'
  if (mockR2) {
    const url = new URL(context.request.url)
    if (!isLoopbackHost(url.hostname)) {
      return jsonError(
        500,
        'mock_r2_unsafe',
        `MOCK_R2=true refuses to honor a non-loopback hostname (got "${url.hostname}").`,
      )
    }
  }

  // HEAD every frame + the source-filenames blob in parallel.
  // Mock mode skips R2 access (no real bytes were uploaded; the
  // mock-r2.localhost URLs aren't reachable). For real R2 a
  // missing object fails the upload — the publisher's PUTs either
  // didn't all land or didn't reach R2 at all.
  if (!mockR2) {
    // Pre-check the R2 binding once before issuing N+1 parallel
    // HEADs. The prior shape ran every HEAD against a missing
    // binding before the first one's `'binding_missing'` reason
    // surfaced as 503 — that's ~10001 amplified errors in the
    // request log at the 10 000-frame cap for what's a single
    // operator misconfiguration. Phase 3pf-review/E —
    // Copilot suppressed-confidence #4.
    if (!context.env.CATALOG_R2) {
      return jsonError(
        503,
        'r2_binding_missing',
        'CATALOG_R2 binding is not configured on this deployment.',
      )
    }
    // Frames are content-addressed (`docs/INCREMENTAL_FRAME_UPLOAD_PLAN.md`),
    // so the per-frame R2 keys are derived from each frame's digest —
    // which lives in the source-filenames manifest, not from the index.
    // Read + parse that blob first (it also confirms the blob landed),
    // then HEAD the distinct content-addressed frame keys.
    const sourceFilenamesKey = buildFrameSourceFilenamesKey(datasetId, uploadId)
    const blobObj = await context.env.CATALOG_R2.get(sourceFilenamesKey)
    if (!blobObj) {
      const failedAt = new Date().toISOString()
      await markAssetUploadFailed(context.env.CATALOG_DB!, uploadId, 'asset_missing', failedAt)
      return jsonError(
        409,
        'asset_missing',
        `Object at ${sourceFilenamesKey} is not present in R2. The publisher likely never ` +
          `uploaded the source-filenames manifest; mint a fresh upload to retry.`,
      )
    }
    const manifest = parseFrameManifest(await blobObj.text())
    if (!manifest || manifest.length !== frameCount) {
      const failedAt = new Date().toISOString()
      await markAssetUploadFailed(context.env.CATALOG_DB!, uploadId, 'asset_missing', failedAt)
      return jsonError(
        409,
        'asset_missing',
        `Source-filenames manifest at ${sourceFilenamesKey} is missing, malformed, or its length ` +
          `(${manifest?.length ?? 'unparseable'}) disagrees with frame_count ${frameCount}. ` +
          `Mint a fresh upload to retry.`,
      )
    }
    // Distinct keys: identical frame bytes share one content-addressed
    // object, so a deduped HEAD set keeps us well under the Workers
    // subrequest cap even at the 10 000-frame ceiling.
    const frameKeys = [
      ...new Set(manifest.map(e => buildContentAddressedFrameKey(datasetId, e.digest, extension))),
    ]
    // Bounded-concurrency HEAD pool rather than `Promise.all` —
    // Cloudflare Workers cap outbound subrequests at 50 (free) /
    // 1000 (paid) per invocation. 16 workers is well below the
    // paid-tier cap and high enough that the HEAD-all wall-clock
    // stays small. Phase 3pf-review/G — Copilot discussion_r3263466382.
    const existences = await runBoundedPool(
      frameKeys.map(key => () => verifyObjectExists(context.env, key)),
      FRAME_OPERATION_CONCURRENCY,
    )
    for (let i = 0; i < existences.length; i++) {
      const result = existences[i]
      if (!result.ok) {
        if (result.reason === 'binding_missing') {
          return jsonError(
            503,
            'r2_binding_missing',
            'CATALOG_R2 binding is not configured on this deployment.',
          )
        }
        // 'missing' — one of the keys never landed. Mark the
        // upload failed and surface the offending key so the
        // publisher's client can highlight which frame to retry.
        const failedAt = new Date().toISOString()
        await markAssetUploadFailed(
          context.env.CATALOG_DB!,
          uploadId,
          'asset_missing',
          failedAt,
        )
        return jsonError(
          409,
          'asset_missing',
          `Object at ${frameKeys[i]} is not present in R2. The publisher likely never ` +
            `uploaded the bytes; mint a fresh upload to retry.`,
        )
      }
    }
  }

  // Capture the pre-stamp snapshot for the revert path. All three
  // frame columns are NULL on a fresh row; on a re-upload of an
  // already-transcoded sequence they're the prior upload's values
  // (the revert restores them, which is a no-op for a successful
  // dispatch and lossless for a failed one).
  const now = new Date().toISOString()
  const priorStampState = {
    data_ref: dataset.data_ref,
    content_digest: dataset.content_digest,
    source_digest: dataset.source_digest,
    frame_count: dataset.frame_count,
    frame_extension: dataset.frame_extension,
    frame_source_filenames_ref: dataset.frame_source_filenames_ref,
  }
  const sourceFilenamesKey = buildFrameSourceFilenamesKey(datasetId, uploadId)
  const stamped = await stampTranscodingForFrameSource(
    context.env.CATALOG_DB!,
    datasetId,
    upload,
    frameCount,
    extension,
    `r2:${sourceFilenamesKey}`,
    now,
  )
  if (stamped === 0) {
    return jsonError(
      409,
      'transcoding_in_progress',
      `Dataset ${datasetId}'s active transcode binding changed between the freshness check ` +
        `and the stamp step — a concurrent upload took over. Wait for that workflow to ` +
        'finish (or have an operator clear the row) before starting another.',
    )
  }

  // Mock-mode dispatch loopback refusal — same as the MP4 path.
  if (context.env.MOCK_GITHUB_DISPATCH === 'true') {
    const url = new URL(context.request.url)
    if (!isLoopbackHost(url.hostname)) {
      // Roll back the stamp before refusing so the row doesn't
      // sit stuck `transcoding=1`.
      await revertTranscodingStamp(
        context.env.CATALOG_DB!,
        datasetId,
        upload,
        priorStampState,
        new Date().toISOString(),
      ).catch(err =>
        console.error(
          `[asset/complete] failed to revert frame-source stamp on ${datasetId}:`,
          err,
        ),
      )
      return jsonError(
        500,
        'mock_github_dispatch_unsafe',
        `MOCK_GITHUB_DISPATCH=true refuses to honor a non-loopback hostname (got "${url.hostname}").`,
      )
    }
  }

  try {
    await dispatchTranscode(context.env, {
      kind: 'frames',
      dataset_id: datasetId,
      upload_id: uploadId,
      frame_count: frameCount,
      extension,
      // `claimed_digest` on the asset_uploads row is the
      // source-filenames JSON hash (set at /asset mint time). The
      // runner re-hashes the blob's bytes and refuses to encode if
      // they don't match.
      source_digest: upload.claimed_digest,
    })
  } catch (err) {
    try {
      const reverted = await revertTranscodingStamp(
        context.env.CATALOG_DB!,
        datasetId,
        upload,
        priorStampState,
        new Date().toISOString(),
      )
      if (reverted === 0) {
        console.warn(
          `[asset/complete] revert of frame-source transcoding stamp on ${datasetId} was a ` +
            `no-op — another upload took over the active binding before the ` +
            `dispatch-failure handler ran (upload ${uploadId} lost the race).`,
        )
      }
    } catch (revertErr) {
      console.error(
        `[asset/complete] failed to revert frame-source stamp on ${datasetId}:`,
        revertErr,
      )
    }
    if (isConfigurationError(err)) {
      return jsonError(503, 'github_dispatch_unconfigured', safeErrorReason(err, 'GitHub dispatch is not configured.'))
    }
    return jsonError(502, 'github_dispatch_upstream_error', safeErrorReason(err, 'GitHub dispatch failed.'))
  }

  await markTranscodingUploadCompleted(context.env.CATALOG_DB!, uploadId, now)

  const updatedAfterDispatch = await context.env.CATALOG_DB!
    .prepare(`SELECT * FROM datasets WHERE id = ?`)
    .bind(datasetId)
    .first<DatasetRow>()
  return new Response(
    JSON.stringify({
      dataset: updatedAfterDispatch,
      upload: { ...upload, status: 'completed', completed_at: now },
      verified_digest: upload.claimed_digest,
      transcoding: true,
    }),
    {
      status: 202,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}
