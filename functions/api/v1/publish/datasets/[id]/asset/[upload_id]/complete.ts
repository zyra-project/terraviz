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
import { isConfigurationError, isUpstreamError } from '../../../../../_lib/errors'
import { isLoopbackHost } from '../../../../../_lib/loopback'
import { invalidateSnapshot } from '../../../../../_lib/snapshot'
import { verifyContentDigest } from '../../../../../_lib/r2-store'
import { getTranscodeStatus } from '../../../../../_lib/stream-store'
import {
  applyAssetAndMarkCompleted,
  getAssetUpload,
  markAssetUploadFailed,
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
    // generation against the just-applied asset) that landed since.
    const currentDataset =
      (await getDatasetForPublisher(context.env.CATALOG_DB!, publisher, datasetId)) ?? dataset
    return new Response(JSON.stringify({ dataset: currentDataset, upload, idempotent: true }), {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    })
  }
  if (upload.status === 'failed') {
    return jsonError(
      409,
      'upload_failed',
      `Upload ${uploadId} previously failed (${upload.failure_reason ?? 'unknown'}). Mint a fresh upload to retry.`,
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
      const message = err instanceof Error ? err.message : String(err)
      if (isConfigurationError(err)) {
        return jsonError(503, 'stream_unconfigured', message)
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
      return jsonError(502, 'stream_upstream_error', message)
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
