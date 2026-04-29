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
import { getDatasetForPublisher } from '../../../_lib/dataset-mutations'
import { isLoopbackHost } from '../../../_lib/loopback'
import {
  buildAssetKey,
  presignPut,
  R2_PUT_TTL_SECONDS,
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
 * Decide which backend an `(kind, mime)` pair lands in. Video data
 * goes to Stream so we get transcoding + ABR for free; everything
 * else goes to R2 under a content-addressed key.
 */
function chooseTarget(kind: AssetKind, mime: string): 'r2' | 'stream' {
  if (kind === 'data' && mime === 'video/mp4') return 'stream'
  return 'r2'
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

  const validated = validateAssetInit(body as Record<string, unknown>)
  if (!validated.ok) {
    return new Response(JSON.stringify({ errors: validated.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }
  const { kind, mime, size, content_digest } = validated.value

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
      const ext = extForMime(mime)
      const hex = content_digest.slice('sha256:'.length)
      const key = buildAssetKey(id, kind, hex, ext)
      const presigned = await presignPut(context.env, key, { contentType: mime })
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
    if (target === 'stream') {
      return jsonError(503, 'stream_unconfigured', reason)
    }
    return jsonError(503, 'r2_unconfigured', reason)
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

/** Re-export for symmetry with the rest of the routes — keeps import sites tidy. */
export const TTLS = {
  R2_PUT_TTL_SECONDS,
  STREAM_DIRECT_UPLOAD_TTL_SECONDS,
}
