/**
 * POST /api/v1/publish/datasets/{id}/asset
 *
 * Initiate an asset upload. Body declares
 * `{ kind, mime, size, content_digest }`; the handler validates the
 * shape, picks the right backend (Stream for `data` videos, R2 for
 * everything else), mints a short-lived upload URL, and persists an
 * `asset_uploads` row in `pending` state. The publisher then PUTs/
 * POSTs the file bytes directly to the URL we returned, then calls
 * `POST .../{upload_id}/complete` (Commit D) which verifies the
 * digest and flips the corresponding `*_ref` column on the dataset
 * row.
 *
 * Response shape:
 *   {
 *     "upload_id": "01HX...",      // ULID, key for /complete
 *     "kind":      "data",
 *     "target":    "stream" | "r2",
 *     "stream":    { "upload_url", "stream_uid" }    // when target=stream
 *     "r2":        { "method", "url", "headers", "key" } // when target=r2
 *     "expires_at": "2026-04-29T..."
 *   }
 *
 * Authorization: same publisher-API rules as the rest of `/publish/`.
 * Community publishers can only initiate uploads for rows they own;
 * staff see everything. 404 — same as `GET .../{id}` — when the row
 * isn't visible.
 *
 * Failure modes:
 *   - 400 invalid_json / invalid_body — body shape problems.
 *   - 400 with `{errors: [...]}` — per-field validation failures
 *     (kind, mime, size cap, content_digest shape).
 *   - 404 not_found — dataset id not visible to caller.
 *   - 503 binding_missing — CATALOG_DB / CATALOG_KV not wired (the
 *     middleware catches CATALOG_DB; CATALOG_R2 only matters at
 *     /complete time).
 *   - 503 r2_unconfigured / stream_unconfigured — neither real
 *     credentials nor mock-mode flag is set. Surfaced explicitly so
 *     a misconfigured deploy gets a fix-it hint, not a 500.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import type { DatasetRow } from '../../../_lib/catalog-store'
import type { PublisherRow } from '../../../_lib/publisher-store'
import { getDatasetForPublisher } from '../../../_lib/dataset-mutations'
import { isConfigurationError } from '../../../_lib/errors'
import { isLoopbackHost } from '../../../_lib/loopback'
import {
  buildAssetKey,
  buildFrameKey,
  buildFrameSequencePrefix,
  buildFrameSourceFilenamesKey,
  buildVideoSourceKey,
  presignPut,
  R2_PUT_TTL_SECONDS,
  R2_PUT_TTL_VIDEO_SECONDS,
  type AssetKind,
} from '../../../_lib/r2-store'
import {
  mintDirectUploadUrl,
  STREAM_DIRECT_UPLOAD_TTL_SECONDS,
} from '../../../_lib/stream-store'
import {
  extForMime,
  insertAssetUpload,
  validateAssetInit,
  validateImageSequenceInit,
} from '../../../_lib/asset-uploads'
import { newUlid } from '../../../_lib/ulid'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function pickId(context: Parameters<PagesFunction<CatalogEnv, 'id'>>[0]): string | null {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  return id || null
}

/**
 * Decide which backend an `(kind, mime)` pair lands in. Phase 3pd
 * collapsed the two-backend split: Cloudflare Stream is gone, R2
 * is the only target. Video data still gets a special key layout
 * (see `buildVideoSourceKey` in `r2-store.ts`) so the GHA transcode
 * workflow can find the source at a predictable path, but the
 * upload mechanism is the same presigned PUT.
 *
 * The function signature still returns the union type so
 * downstream code paths can be torn out incrementally — the Stream
 * branch in `complete.ts` and `stream-store.ts` is now dead code
 * waiting for a follow-up cleanup PR.
 */
function chooseTarget(_kind: AssetKind, _mime: string): 'r2' | 'stream' {
  return 'r2'
}

/**
 * Should this `(kind, mime)` upload land at the video-source key
 * for the GHA transcode workflow to pick up, or at a regular
 * content-addressed asset key? Video data is the one case that
 * goes through the async transcode pipeline.
 */
function isVideoSourceUpload(kind: AssetKind, mime: string): boolean {
  return kind === 'data' && mime === 'video/mp4'
}

/**
 * For `kind='data'`, the upload's mime must match the dataset's
 * declared `format` so the catalog row stays internally consistent.
 * Tour datasets are the one cross-bucket case: the row says
 * `tour/json`; the upload's actual HTTP content-type is
 * `application/json`.
 */
export function mimeMatchesFormat(mime: string, format: string): boolean {
  if (mime === format) return true
  if (format === 'tour/json' && mime === 'application/json') return true
  return false
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const id = pickId(context)
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')

  const existing = await getDatasetForPublisher(context.env.CATALOG_DB!, publisher, id)
  if (!existing) return jsonError(404, 'not_found', `Dataset ${id} not found.`)

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'Request body must be an object.')
  }

  // Discriminator: an image-sequence upload arrives as the same
  // /asset endpoint but with a `frames` array in the body. Route
  // the request through a different validator + key-minting flow.
  // The MP4 / single-image path is everything below this block.
  if (Array.isArray((body as Record<string, unknown>).frames)) {
    return handleImageSequenceInit(
      context,
      id,
      publisher,
      existing,
      body as Record<string, unknown>,
    )
  }

  const validated = validateAssetInit(body as Record<string, unknown>)
  if (!validated.ok) {
    return new Response(JSON.stringify({ errors: validated.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  const { kind, mime, size, content_digest } = validated.value

  // For `data` uploads, the mime must match the dataset's declared
  // `format` — otherwise we'd commit a `data_ref` to bytes whose
  // type contradicts the catalog row, breaking manifest resolution
  // for downstream consumers. `tour/json` ↔ `application/json` is
  // the one cross-bucket equivalence we honour (the row says
  // `tour/json`; the upload's HTTP content-type is the standard
  // `application/json`).
  if (kind === 'data' && !mimeMatchesFormat(mime, existing.format)) {
    return new Response(
      JSON.stringify({
        errors: [
          {
            field: 'mime',
            code: 'mime_format_mismatch',
            message: `Upload mime "${mime}" does not match dataset format "${existing.format}". Update the dataset's format first if you intend to change the asset type.`,
          },
        ],
      }),
      { status: 400, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  // Refuse to mint a fresh video-source upload while the row is
  // already transcoding. The overlap-guard in
  // /asset/{upload_id}/complete would 409 the same case later,
  // but a 2-hour presigned PUT URL paired with the 10 GB
  // MAX_BYTES_DATA cap means a publisher (or stale edit-page
  // tab) could waste a multi-GB upload before learning the row
  // is locked. Failing fast at mint time saves the bandwidth.
  // PR #112 followup — asset.ts:pre-mint-transcoding-check.
  //
  // Scope is video-only — image and aux uploads don't go through
  // the transcoding lifecycle, so a parallel image upload during
  // a video transcode is harmless.
  if (isVideoSourceUpload(kind, mime) && existing.transcoding) {
    return jsonError(
      409,
      'transcoding_in_progress',
      `Dataset ${id} is already transcoding ` +
        (existing.active_transcode_upload_id
          ? `upload ${existing.active_transcode_upload_id}`
          : `(no active upload binding — corrupted state, contact an operator)`) +
        `. Wait for the workflow to finish (the "Transcoding…" badge on the detail ` +
        `page will clear when it does) before starting a new upload.`,
    )
  }

  const target = chooseTarget(kind, mime)
  const uploadId = newUlid()
  const now = new Date().toISOString()
  // Whether this upload is in mock mode — used by the CLI / portal
  // to skip the actual byte transit (the mock URLs aren't reachable)
  // and by `/complete` to short-circuit digest verification (no
  // bytes were ever uploaded). Mirrors the existing Stream-mock
  // behaviour: the publisher's claimed digest becomes ground truth.
  const mock =
    (target === 'r2' && context.env.MOCK_R2 === 'true') ||
    (target === 'stream' && context.env.MOCK_STREAM === 'true')

  // Defense in depth: refuse mock mode on a non-loopback hostname.
  // A misconfigured production deploy with `MOCK_R2=true` /
  // `MOCK_STREAM=true` left on could otherwise mint stub upload
  // URLs and accept them at /complete without any real bytes. Same
  // pattern as the publish middleware's `DEV_BYPASS_ACCESS` check.
  if (mock) {
    const url = new URL(context.request.url)
    if (!isLoopbackHost(url.hostname)) {
      const flag = target === 'stream' ? 'mock_stream_unsafe' : 'mock_r2_unsafe'
      const envVar = target === 'stream' ? 'MOCK_STREAM' : 'MOCK_R2'
      return jsonError(
        500,
        flag,
        `${envVar}=true refuses to honor a non-loopback hostname (got "${url.hostname}").`,
      )
    }
  }

  // Mint the upload URL + target_ref. Errors from the storage helpers
  // (R2 unconfigured, Stream API failure, etc.) become 503s — we don't
  // know whether to retry or fix config without operator action.
  let response: AssetInitResponse
  try {
    if (target === 'stream') {
      const mint = await mintDirectUploadUrl(context.env, {
        meta: { dataset_id: id, upload_id: uploadId, kind, content_digest },
      })
      const targetRef = `stream:${mint.stream_uid}`
      await insertAssetUpload(context.env.CATALOG_DB!, {
        id: uploadId,
        dataset_id: id,
        publisher_id: publisher.id,
        kind,
        target: 'stream',
        target_ref: targetRef,
        mime,
        declared_size: size,
        claimed_digest: content_digest,
        created_at: now,
      })
      response = {
        upload_id: uploadId,
        kind,
        target: 'stream',
        stream: { upload_url: mint.upload_url, stream_uid: mint.stream_uid },
        expires_at: mint.expires_at,
        mock,
      }
    } else {
      // Video data uploads land at the predictable
      // `uploads/{dataset_id}/{upload_id}/source.mp4` key so the
      // GHA transcode workflow can find them via the
      // `client_payload.source_key` passed in the
      // repository_dispatch fired at /complete time. Per-upload
      // prefix keeps a re-upload to a still-transcoding row from
      // overwriting the source bytes the prior workflow may still
      // be reading. Every other asset kind keeps the content-
      // addressed `datasets/{id}/by-digest/...` scheme that lets
      // revisions land at a new path without invalidating any
      // existing cache.
      const ext = extForMime(mime)
      const hex = content_digest.slice('sha256:'.length)
      const isVideo = isVideoSourceUpload(kind, mime)
      const key = isVideo
        ? buildVideoSourceKey(id, uploadId)
        : buildAssetKey(id, kind, hex, ext)
      // Video sources get the extended TTL — `R2_PUT_TTL_SECONDS`
      // (15 min) is fine for image / aux uploads but too short
      // for the 10 GB MAX_BYTES_DATA ceiling on residential
      // uplinks. PR #112 followup — the prior default expired
      // multi-GB uploads mid-transfer.
      const presigned = await presignPut(context.env, key, {
        contentType: mime,
        ttlSeconds: isVideo ? R2_PUT_TTL_VIDEO_SECONDS : undefined,
      })
      const targetRef = `r2:${key}`
      await insertAssetUpload(context.env.CATALOG_DB!, {
        id: uploadId,
        dataset_id: id,
        publisher_id: publisher.id,
        kind,
        target: 'r2',
        target_ref: targetRef,
        mime,
        declared_size: size,
        claimed_digest: content_digest,
        created_at: now,
      })
      response = {
        upload_id: uploadId,
        kind,
        target: 'r2',
        r2: {
          method: presigned.method,
          url: presigned.url,
          headers: presigned.headers,
          key: presigned.key,
        },
        expires_at: presigned.expires_at,
        mock,
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // Distinguish missing-credentials (operator must fix the deploy)
    // from upstream-service failures (transient, may succeed on retry).
    if (isConfigurationError(err)) {
      const code = target === 'stream' ? 'stream_unconfigured' : 'r2_unconfigured'
      return jsonError(503, code, reason)
    }
    const code = target === 'stream' ? 'stream_upstream_error' : 'r2_upstream_error'
    return jsonError(502, code, reason)
  }

  return new Response(JSON.stringify(response), {
    status: 201,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Cache-Control': 'private, no-store',
      Location: `/api/v1/publish/datasets/${id}/asset/${uploadId}`,
    },
  })
}

interface AssetInitResponse {
  upload_id: string
  kind: AssetKind
  target: 'r2' | 'stream'
  stream?: { upload_url: string; stream_uid: string }
  r2?: { method: 'PUT'; url: string; headers: Record<string, string>; key: string }
  expires_at: string
  /**
   * `true` when MOCK_R2 / MOCK_STREAM is set for this target. The
   * mint URL is reachable only as a string (mock-r2.localhost
   * doesn't accept real bytes); the CLI / portal honour this flag
   * by skipping the upload step, and `/complete` honours it by
   * trusting the publisher's claimed digest as ground truth.
   */
  mock: boolean
}

interface ImageSequenceInitFrameResponse {
  filename: string
  /** Zero-padded position in the encode order (matches the
   *  five-digit format `buildFrameKey` writes into the R2 key). */
  index: number
  method: 'PUT'
  url: string
  headers: Record<string, string>
  /** R2 key the presigned URL writes to —
   *  `uploads/{dataset_id}/{upload_id}/frames/{NNNNN}.{ext}`. */
  key: string
}

interface ImageSequenceInitResponse {
  upload_id: string
  kind: 'data'
  target: 'r2'
  /** Per-frame presigned PUTs, one per entry in the request's
   *  `frames` array, in the same order the publisher supplied. */
  frames: ImageSequenceInitFrameResponse[]
  /** Presigned PUT for the source-filenames JSON blob the
   *  publisher's client builds from the original filenames + the
   *  per-frame indexes. The blob is fetched by the GHA runner
   *  alongside the frames; its hash is what gets carried through
   *  `source_digest` on the dispatch payload. */
  source_filenames: {
    method: 'PUT'
    url: string
    headers: Record<string, string>
    key: string
  }
  expires_at: string
  mock: boolean
}

/**
 * Phase 3pf image-sequence upload init. Validates the body's
 * `frames` array, checks the row's format / overlap guards, then
 * mints one presigned PUT per frame + one for the source-filenames
 * JSON blob. Persists a single `asset_uploads` row with
 * `frame_count = N` so /complete can branch its HEAD-all loop.
 *
 * The per-frame R2 keys come from `buildFrameKey` —
 * `uploads/{dataset_id}/{upload_id}/frames/{NNNNN}.{ext}` —
 * with `extension` derived from the validated mime via
 * `extForMime`. The asset_uploads row's `target_ref` stores the
 * prefix (with trailing slash) since there's no single canonical
 * key for the upload; /complete reconstructs the per-frame keys
 * from `frame_count` + `mime`.
 *
 * Format constraint: image-sequence uploads only target video
 * datasets (`format = 'video/mp4'`). The runner's output is
 * always an HLS bundle regardless of source kind; a publisher
 * who wants to publish individual images uses the existing
 * single-file path.
 */
async function handleImageSequenceInit(
  context: Parameters<PagesFunction<CatalogEnv, 'id'>>[0],
  id: string,
  publisher: PublisherRow,
  existing: DatasetRow,
  body: Record<string, unknown>,
): Promise<Response> {
  const validated = validateImageSequenceInit(body)
  if (!validated.ok) {
    return new Response(JSON.stringify({ errors: validated.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  const { mime, extension, frames, totalSize, sourceFilenamesDigest } = validated.value

  // Image-sequence sources always encode to a video HLS bundle —
  // the dataset row's `format` therefore has to be `video/mp4`.
  // A publisher who wants to publish a single image uses the
  // single-file branch above; a publisher who wants to publish a
  // tour uses the manual `data_ref` field. The error envelope
  // mirrors `mime_format_mismatch` from the single-file path so
  // the client renders one code path for both shapes.
  if (existing.format !== 'video/mp4') {
    return new Response(
      JSON.stringify({
        errors: [
          {
            field: 'format',
            code: 'frames_require_video_format',
            message:
              `Image-sequence uploads target a video dataset (format=video/mp4), ` +
              `but dataset ${id} has format "${existing.format}". Change the dataset's ` +
              `format to video/mp4 before uploading frames.`,
          },
        ],
      }),
      { status: 400, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  // Same transcoding-overlap guard the MP4 path uses. A row
  // mid-transcode would otherwise consume a multi-GB frame batch
  // before /complete refuses it.
  if (existing.transcoding) {
    return jsonError(
      409,
      'transcoding_in_progress',
      `Dataset ${id} is already transcoding ` +
        (existing.active_transcode_upload_id
          ? `upload ${existing.active_transcode_upload_id}`
          : `(no active upload binding — corrupted state, contact an operator)`) +
        `. Wait for the workflow to finish (the "Transcoding…" badge on the detail ` +
        `page will clear when it does) before starting a new upload.`,
    )
  }

  const uploadId = newUlid()
  const now = new Date().toISOString()
  const mock = context.env.MOCK_R2 === 'true'

  // Mock-mode loopback refusal (defense in depth) — same as the
  // single-file branch.
  if (mock) {
    const url = new URL(context.request.url)
    if (!isLoopbackHost(url.hostname)) {
      return jsonError(
        500,
        'mock_r2_unsafe',
        `MOCK_R2=true refuses to honor a non-loopback hostname (got "${url.hostname}").`,
      )
    }
  }

  let frameMints: ImageSequenceInitFrameResponse[]
  let sourceFilenamesMint: ImageSequenceInitResponse['source_filenames']
  try {
    // Per-frame mints — parallel via Promise.all because each
    // presign is a SigV4 computation independent of the others.
    // The mock path returns deterministic URLs without any work.
    const framePresigns = await Promise.all(
      frames.map((f, index) => {
        const key = buildFrameKey(id, uploadId, index, extension)
        return presignPut(context.env, key, {
          contentType: mime,
          // Video-tier TTL covers multi-GB sequence uploads on a
          // residential uplink; the typical 240-frame 4K PNG batch
          // is ~7 GB but the publisher hashes + PUTs frames serially
          // (bounded concurrency), so the practical upload time
          // tracks the MP4 path.
          ttlSeconds: R2_PUT_TTL_VIDEO_SECONDS,
        }).then(presigned => ({ presigned, frame: f, index }))
      }),
    )
    frameMints = framePresigns.map(({ presigned, frame, index }) => ({
      filename: frame.filename,
      index,
      method: presigned.method,
      url: presigned.url,
      headers: presigned.headers,
      key: presigned.key,
    }))
    // Source-filenames blob — short-TTL because the publisher
    // builds + PUTs it in seconds, not minutes.
    const fnKey = buildFrameSourceFilenamesKey(id, uploadId)
    const fnPresigned = await presignPut(context.env, fnKey, {
      contentType: 'application/json',
    })
    sourceFilenamesMint = {
      method: fnPresigned.method,
      url: fnPresigned.url,
      headers: fnPresigned.headers,
      key: fnPresigned.key,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (isConfigurationError(err)) {
      return jsonError(503, 'r2_unconfigured', reason)
    }
    return jsonError(502, 'r2_upstream_error', reason)
  }

  // Single asset_uploads row covers the whole sequence. The
  // claimed_digest column carries the SHA-256 of the canonical
  // source-filenames JSON (computed client-side from the per-frame
  // digest list); the GHA runner re-verifies that digest before
  // running ffmpeg, so a tampered manifest fails the workflow
  // rather than the publisher API.
  //
  // **Digest trust model.** The publisher's client computes
  // `sourceFilenamesDigest` BEFORE PUTing the actual blob — there is
  // no enforcement here that the bytes which subsequently land at
  // the source-filenames presigned URL hash to the declared value.
  // A buggy or hostile client could PUT bytes that don't match;
  // `verifySourceFilenamesBlob` in `cli/transcode-from-dispatch.ts`
  // catches the mismatch by re-hashing the blob inside the GHA
  // runner before encoding (same bargain the MP4 path makes with
  // the source MP4's claimed digest). This is intentional — the
  // alternative (Worker-side re-hash) wouldn't help because the
  // PUT goes directly to R2 and the Worker never sees the bytes
  // anyway. The indirection (publisher hashes JSON → PUTs JSON →
  // runner re-hashes JSON) is what makes the trust boundary work.
  //
  // We trust the parent body's claimed total `size` was already
  // cross-checked against the sum of `frames[*].size` by the
  // validator, so `declared_size` is the validated `totalSize`.
  //
  // `target_ref` holds the prefix (with trailing slash) so a
  // future inspection of the row points at the directory the
  // frames live under. /complete reconstructs the per-frame keys
  // from `dataset_id + upload_id + frame_count + extension`.
  const targetRef = `r2:${buildFrameSequencePrefix(id, uploadId)}`
  await insertAssetUpload(context.env.CATALOG_DB!, {
    id: uploadId,
    dataset_id: id,
    publisher_id: publisher.id,
    kind: 'data',
    target: 'r2',
    target_ref: targetRef,
    mime,
    declared_size: totalSize,
    claimed_digest: sourceFilenamesDigest,
    created_at: now,
    frame_count: frames.length,
  })

  const response: ImageSequenceInitResponse = {
    upload_id: uploadId,
    kind: 'data',
    target: 'r2',
    frames: frameMints,
    source_filenames: sourceFilenamesMint,
    // `validateImageSequenceInit` rejects empty `frames` arrays
    // before we reach here, so the frame-tier video TTL applies
    // unconditionally — every presigned PUT in the response uses
    // the same expiry.
    expires_at: new Date(Date.now() + R2_PUT_TTL_VIDEO_SECONDS * 1000).toISOString(),
    mock,
  }

  return new Response(JSON.stringify(response), {
    status: 201,
    headers: {
      'Content-Type': CONTENT_TYPE,
      'Cache-Control': 'private, no-store',
      Location: `/api/v1/publish/datasets/${id}/asset/${uploadId}`,
    },
  })
}

/** Re-export for symmetry with the rest of the routes — keeps import sites tidy. */
export const TTLS = {
  R2_PUT_TTL_SECONDS,
  R2_PUT_TTL_VIDEO_SECONDS,
  STREAM_DIRECT_UPLOAD_TTL_SECONDS,
}
