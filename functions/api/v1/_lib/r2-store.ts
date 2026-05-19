/**
 * R2 storage helpers — Phase 1b.
 *
 * Two responsibilities:
 *
 *   1. Mint short-lived presigned PUT URLs that a browser (or the
 *      `terraviz` CLI) can upload bytes to directly. R2 speaks the
 *      S3 protocol on its `*.r2.cloudflarestorage.com` endpoint, so
 *      the same SigV4 algorithm AWS S3 uses applies. The signing
 *      lives in this module so the route handler in Commit C is a
 *      thin envelope around `presignPut`.
 *
 *   2. After upload completes, read the object back via the
 *      `CATALOG_R2` binding and recompute SHA-256 to verify the
 *      publisher's claimed digest before flipping the dataset row.
 *      This is the "verify once at the cache boundary" gate that
 *      `CATALOG_ASSETS_PIPELINE.md` "Asset integrity & verification"
 *      describes.
 *
 * Local dev sets `MOCK_R2=true` so the contributor walkthrough works
 * without R2 S3 credentials. In mock mode, `presignPut` returns a
 * deterministic `https://mock-r2.localhost/...` URL the test suite
 * can match against, and `verifyContentDigest` reads from the R2
 * binding (Wrangler provisions one on disk under
 * `.wrangler/state/v3/r2/` regardless of whether real credentials
 * are configured).
 *
 * Path scheme is content-addressed — `datasets/{id}/by-digest/sha256/{hex}/asset.{ext}`
 * — so a given key can only ever hold one set of bytes. That makes
 * `Cache-Control: public, max-age=31536000, immutable` correct on
 * public reads and lets revisions land at a new path without
 * invalidating any existing cache.
 */

import { ConfigurationError } from './errors'

export interface R2Env {
  /** Workers binding for read-after-write digest verification. */
  CATALOG_R2?: R2Bucket
  /**
   * Bucket name as it appears in the R2 dashboard. Required for
   * SigV4 host construction; defaults to `terraviz-assets` to
   * match the canonical name in `CATALOG_ASSETS_PIPELINE.md`.
   */
  CATALOG_R2_BUCKET?: string
  /**
   * S3-compatible endpoint, e.g.
   * `https://<account>.r2.cloudflarestorage.com`. R2's docs print
   * this on the bucket page.
   */
  R2_S3_ENDPOINT?: string
  /** R2 S3 access-key id (Cloudflare dashboard → R2 → Manage API tokens). */
  R2_ACCESS_KEY_ID?: string
  /** R2 S3 secret access key — Wrangler secret in production. */
  R2_SECRET_ACCESS_KEY?: string
  /**
   * `"true"` returns deterministic stub URLs from `presignPut`
   * instead of signing. Local dev only — refused in
   * `requireR2Config` when no other config is set.
   */
  MOCK_R2?: string
}

/** Asset kinds that map onto distinct row columns / R2 key prefixes. */
export type AssetKind =
  | 'data'
  | 'thumbnail'
  | 'legend'
  | 'caption'
  | 'sphere_thumbnail'

/** Default presigned-PUT TTL — matches the publisher portal
 *  upload window for image / aux uploads (≤ ~256 MB, finish in
 *  seconds to a few minutes on a typical residential uplink). */
export const R2_PUT_TTL_SECONDS = 15 * 60

/** Extended presigned-PUT TTL for video sources. Source MP4s
 *  can be up to `MAX_BYTES_DATA` (10 GB); on a typical
 *  residential uplink (~25 Mbps) a 10 GB upload takes ~55
 *  minutes, plus headroom for slower links + retries. Two hours
 *  matches R2's maximum presigned-URL TTL (S3 v4 signatures cap
 *  at one week, but R2's binding wraps a shorter ceiling) and
 *  is what the asset-uploader budgets for. PR #112 followup —
 *  asset.ts:presigned-TTL (the prior 15-min default expired
 *  multi-GB uploads mid-transfer on slower links). */
export const R2_PUT_TTL_VIDEO_SECONDS = 2 * 60 * 60

/** Mock-mode host. Tests assert URLs against this constant. */
export const MOCK_R2_HOST = 'https://mock-r2.localhost'

/**
 * R2 key prefix the GHA transcode workflow watches for source
 * MP4 uploads (Phase 3pd). Lives outside the content-addressed
 * `datasets/{id}/by-digest/...` scheme because the workflow
 * doesn't know the digest in advance — only the dataset id and
 * upload id, both of which travel through the
 * `repository_dispatch` payload (see
 * `TranscodeDispatchPayload` in `github-dispatch.ts`). Scoping
 * by upload_id (not just dataset_id) means a re-upload to a
 * row that's already published lands at a fresh prefix instead
 * of overwriting the source bytes the prior workflow may still
 * be reading. See `buildVideoSourceKey` below for the full
 * `uploads/{dataset_id}/{upload_id}/source.mp4` shape.
 */
export const VIDEO_SOURCE_KEY_PREFIX = 'uploads'

/**
 * Throw if `value` isn't a Crockford-ULID-shaped string (26 base32
 * chars from the `0-9A-HJKMNP-TV-Z` alphabet). The dataset_id /
 * upload_id arguments to every key-building helper are
 * canonically ULIDs minted by `newUlid()`; rejecting any other
 * shape fails fast on a misrouted call rather than letting an
 * arbitrary string land in an R2 key path. `label` is the
 * argument name surfaced in the error so a stack trace points
 * at the offending parameter.
 */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/
function assertUlid(label: string, value: string): void {
  if (!ULID_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a ULID (26 base32 chars), got "${value}"`,
    )
  }
}

/**
 * Build the R2 key for a video source upload that's destined for
 * transcoding. `r2:uploads/{dataset_id}/{upload_id}/source.mp4`.
 * Used only for `kind='data'` + `mime='video/mp4'` uploads in
 * Phase 3pd; every other asset kind uses the content-addressed
 * `buildAssetKey` helper above.
 *
 * Scoping by upload_id (not just dataset_id) avoids the race
 * Copilot #9 flagged: a publisher re-uploading the same dataset
 * before the first transcode completes would otherwise overwrite
 * the source MP4 the workflow is about to download, leaving the
 * first upload stuck with a digest mismatch. The asset_uploads
 * row's ULID is the natural version slot — each mint gets a
 * fresh upload_id and a fresh source key.
 */
export function buildVideoSourceKey(datasetId: string, uploadId: string): string {
  assertUlid('buildVideoSourceKey: datasetId', datasetId)
  assertUlid('buildVideoSourceKey: uploadId', uploadId)
  return `${VIDEO_SOURCE_KEY_PREFIX}/${datasetId}/${uploadId}/source.mp4`
}

/**
 * Does an R2 key look like a video-source upload destined for the
 * transcode workflow? The /complete handler uses this to branch
 * between "write data_ref and finish" and "fire dispatch + stamp
 * transcoding=1". Matches the
 * `uploads/{dataset_id}/{upload_id}/source.mp4` shape exactly —
 * both ids must be ULIDs, the filename must be source.mp4, and
 * there must be nothing else between. PR #112 Copilot
 * 3pd-followup — the prior prefix-and-suffix-only check would
 * accept any `uploads/<anything>/source.mp4`, including the
 * obsolete one-level layout (`uploads/{dataset_id}/source.mp4`)
 * that pre-3pd-review3/A wrote, plus arbitrary deeper paths a
 * malformed asset_uploads row could surface.
 */
const VIDEO_SOURCE_KEY_PATTERN = new RegExp(
  `^${VIDEO_SOURCE_KEY_PREFIX}/[0-9A-HJKMNP-TV-Z]{26}/[0-9A-HJKMNP-TV-Z]{26}/source\\.mp4$`,
)

export function isVideoSourceKey(key: string): boolean {
  return VIDEO_SOURCE_KEY_PATTERN.test(key)
}

/**
 * Build the R2 key for a single frame in an image-sequence source
 * upload (Phase 3pf). Frames land at
 * `uploads/{dataset_id}/{upload_id}/frames/{NNNNN}.{ext}` —
 * five-digit zero-padded index so lexicographic key order matches
 * encode order, and so ffmpeg's `-i frames/%05d.{ext}` input glob
 * picks them up without further re-numbering.
 *
 * The five-digit format hard-bounds the per-upload frame count to
 * 99 999 frames; the `validateImageSequenceInit` validator caps at
 * 10 000 (see `asset-uploads.ts`), so there's ten-times headroom
 * before the index format itself becomes a constraint. If a future
 * publisher-API change ever raises the cap above 99 999, widening
 * here is mechanical — but the `validateImageSequenceInit` cap
 * keeps the in-browser hash budget and the JSON response size
 * bounded long before the key format runs out of digits, so this
 * is a sanity invariant not a tunable.
 *
 * Per-upload prefix (the `{upload_id}` segment) is what protects
 * an already-published row from re-upload races: a fresh upload
 * lands at a fresh prefix, and the existing transcoded bundle keeps
 * serving until /transcode-complete swaps `data_ref` atomically.
 * Same property the MP4 path uses; the `frames/` subdirectory keeps
 * source frames separable from any future per-upload auxiliary
 * asset that might live alongside.
 */
export const FRAME_KEY_INDEX_DIGITS = 5

export function buildFrameKey(
  datasetId: string,
  uploadId: string,
  index: number,
  ext: string,
): string {
  assertUlid('buildFrameKey: datasetId', datasetId)
  assertUlid('buildFrameKey: uploadId', uploadId)
  if (!Number.isInteger(index) || index < 0 || index > 99999) {
    throw new Error(
      `buildFrameKey: index must be an integer in [0, 99999], got ${index}`,
    )
  }
  if (!/^[a-z0-9]+$/.test(ext)) {
    throw new Error(
      `buildFrameKey: ext must be a lowercase-alphanumeric extension, got "${ext}"`,
    )
  }
  const padded = String(index).padStart(FRAME_KEY_INDEX_DIGITS, '0')
  return `${VIDEO_SOURCE_KEY_PREFIX}/${datasetId}/${uploadId}/frames/${padded}.${ext}`
}

/**
 * Does an R2 key look like a per-frame upload for an image-sequence
 * source? Matches the shape `buildFrameKey` produces:
 * `uploads/{ULID}/{ULID}/frames/{NNNNN}.{ext}` — both ids must be
 * ULIDs, the directory must be exactly `frames`, the filename must
 * be five base-10 digits + a lowercase-alphanumeric extension.
 *
 * Used by /asset/{upload_id}/complete to refuse HEAD-checking a key
 * whose shape doesn't match either the MP4 source layout (which has
 * its own predicate `isVideoSourceKey`) or this one. A malformed
 * `target_ref` on an asset_uploads row therefore fails fast at
 * /complete time rather than producing an opaque "404 from HEAD"
 * later.
 */
const FRAME_KEY_PATTERN = new RegExp(
  `^${VIDEO_SOURCE_KEY_PREFIX}/[0-9A-HJKMNP-TV-Z]{26}/[0-9A-HJKMNP-TV-Z]{26}/frames/\\d{${FRAME_KEY_INDEX_DIGITS}}\\.[a-z0-9]+$`,
)

export function isFrameKey(key: string): boolean {
  return FRAME_KEY_PATTERN.test(key)
}

/** R2 key prefix that holds all frames for one image-sequence upload.
 *  `uploads/{datasetId}/{uploadId}/frames/`. The trailing slash is
 *  intentional — passing this prefix to an R2 `list` operation
 *  returns exactly the per-frame objects without picking up the
 *  sibling `source_filenames.json` blob. */
export function buildFrameSequencePrefix(datasetId: string, uploadId: string): string {
  assertUlid('buildFrameSequencePrefix: datasetId', datasetId)
  assertUlid('buildFrameSequencePrefix: uploadId', uploadId)
  return `${VIDEO_SOURCE_KEY_PREFIX}/${datasetId}/${uploadId}/frames/`
}

/**
 * R2 key for the auxiliary JSON blob that records the publisher's
 * original per-frame filenames in encode order:
 * `uploads/{dataset_id}/{upload_id}/source_filenames.json`. Lives
 * alongside the frames (not inside `frames/`) so a list against
 * `buildFrameSequencePrefix` enumerates only the frames themselves.
 *
 * The blob carries an array shaped `[{ index, originalFilename }, ...]`
 * with one entry per frame in encode order. The frames-as-data
 * exposure work (Phase 3pg) surfaces these as `originalFilename`
 * on `/frames` responses so consumers that need to map back to the
 * publisher's on-disk convention (downstream pipelines, federated
 * mirrors) can do so. Display naming in the UI uses a derived
 * `{slug}_{timestamp|index}.{ext}` form instead — see
 * `CATALOG_IMAGE_SEQUENCE_PLAN.md` §"Frames as data" for the
 * rationale.
 */
export function buildFrameSourceFilenamesKey(datasetId: string, uploadId: string): string {
  assertUlid('buildFrameSourceFilenamesKey: datasetId', datasetId)
  assertUlid('buildFrameSourceFilenamesKey: uploadId', uploadId)
  return `${VIDEO_SOURCE_KEY_PREFIX}/${datasetId}/${uploadId}/source_filenames.json`
}

/**
 * R2 key prefix for transcoded HLS bundles, scoped per
 * dataset + upload (Phase 3pd review fix #2 / #15). The
 * upload-scoping is what lets a re-upload to an already-
 * published row land its new bundle at a fresh prefix
 * without overwriting the bytes a public client is mid-
 * playback against. The `/transcode-complete` route swaps
 * `data_ref` atomically once the workflow finishes writing
 * the new bundle; the old bundle continues to serve until
 * the swap.
 */
export const VIDEO_BUNDLE_KEY_PREFIX = 'videos'

/**
 * Build the R2 key for the master playlist of a transcoded HLS
 * bundle: `videos/{datasetId}/{uploadId}/master.m3u8`. The
 * workflow uploads its bundle under
 * `videos/{datasetId}/{uploadId}/` and the publisher API stores
 * the master path as `data_ref`. Versioning per upload_id (the
 * asset_uploads row ULID) means concurrent transcodes against
 * the same dataset land in distinct prefixes; the
 * `/transcode-complete` route picks the right one by looking up
 * the upload row.
 */
export function buildVideoBundleMasterKey(datasetId: string, uploadId: string): string {
  assertUlid('buildVideoBundleMasterKey: datasetId', datasetId)
  assertUlid('buildVideoBundleMasterKey: uploadId', uploadId)
  return `${VIDEO_BUNDLE_KEY_PREFIX}/${datasetId}/${uploadId}/master.m3u8`
}

/** Same as `buildVideoBundleMasterKey` but returns the directory
 *  prefix (no `/master.m3u8` tail). Used by the workflow runner
 *  to scope its `uploadHlsBundle` call to a per-upload prefix. */
export function buildVideoBundlePrefix(datasetId: string, uploadId: string): string {
  return `${VIDEO_BUNDLE_KEY_PREFIX}/${datasetId}/${uploadId}`
}

/**
 * Build a content-addressed R2 key per `CATALOG_ASSETS_PIPELINE.md`
 * "R2 assets: content-addressed keys". The hex must be the SHA-256
 * the publisher claims for these bytes; the upload-complete handler
 * later re-hashes and refuses to commit on mismatch.
 */
export function buildAssetKey(
  datasetId: string,
  kind: AssetKind,
  hex: string,
  ext: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`buildAssetKey: hex must be 64 lowercase hex chars, got "${hex}"`)
  }
  if (!/^[a-z0-9]{1,8}$/.test(ext)) {
    throw new Error(`buildAssetKey: ext must be 1-8 lowercase alphanumerics, got "${ext}"`)
  }
  const base = baseNameForKind(kind)
  return `datasets/${datasetId}/by-digest/sha256/${hex}/${base}.${ext}`
}

function baseNameForKind(kind: AssetKind): string {
  switch (kind) {
    case 'data':
      return 'asset'
    case 'thumbnail':
      return 'thumbnail'
    case 'legend':
      return 'legend'
    case 'caption':
      return 'caption'
    case 'sphere_thumbnail':
      return 'sphere-thumbnail'
  }
}

export interface PresignedPut {
  method: 'PUT'
  url: string
  /** Headers the uploader must echo back so the SigV4 signature matches. */
  headers: Record<string, string>
  key: string
  /** ISO 8601 UTC timestamp; uploads after this MUST fail at R2. */
  expires_at: string
}

export interface PresignOptions {
  /** Override TTL (seconds). Defaults to `R2_PUT_TTL_SECONDS`. */
  ttlSeconds?: number
  /** Override clock for tests. Date object or ms. */
  now?: number | Date
  /** Optional Content-Type header to bind into the signature. */
  contentType?: string
}

/**
 * Mint a presigned PUT URL for the given key. In `MOCK_R2=true`
 * mode returns a deterministic local URL so the dev environment
 * does not require real R2 credentials.
 */
export async function presignPut(
  env: R2Env,
  key: string,
  options: PresignOptions = {},
): Promise<PresignedPut> {
  const ttl = options.ttlSeconds ?? R2_PUT_TTL_SECONDS
  const now = normaliseNow(options.now)
  const bucket = env.CATALOG_R2_BUCKET || 'terraviz-assets'

  if (env.MOCK_R2 === 'true') {
    const exp = new Date(now.getTime() + ttl * 1000).toISOString()
    return {
      method: 'PUT',
      url: `${MOCK_R2_HOST}/${bucket}/${key}?expires=${encodeURIComponent(exp)}`,
      headers: options.contentType ? { 'Content-Type': options.contentType } : {},
      key,
      expires_at: exp,
    }
  }

  const config = requireR2Config(env)
  const url = await sigv4PresignPut({
    endpoint: config.endpoint,
    bucket,
    key,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ttlSeconds: ttl,
    now,
    contentType: options.contentType,
  })

  return {
    method: 'PUT',
    url,
    headers: options.contentType ? { 'Content-Type': options.contentType } : {},
    key,
    expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
  }
}

interface ResolvedR2Config {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
}

function requireR2Config(env: R2Env): ResolvedR2Config {
  const endpoint = env.R2_S3_ENDPOINT?.trim()
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim()
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new ConfigurationError(
      'R2 presigning is not configured. Set R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, ' +
        'and R2_SECRET_ACCESS_KEY, or set MOCK_R2=true for local development.',
    )
  }
  return { endpoint, accessKeyId, secretAccessKey }
}

function normaliseNow(input: number | Date | undefined): Date {
  if (input == null) return new Date()
  if (input instanceof Date) return input
  return new Date(input)
}

/**
 * Read the object at `key` via the R2 binding, hash it with SHA-256,
 * and compare against `claimedDigest` (`sha256:<hex>`).
 *
 * Implementation note: this currently buffers the entire object via
 * `arrayBuffer()` before hashing. The Workers runtime exposes
 * `crypto.subtle.digest` only on a complete `BufferSource`; there is
 * no streaming digest API in Web Crypto, so the alternative would be
 * a hand-rolled / wasm SHA-256 chained off the object body's
 * `ReadableStream`. The 100 MB image cap and 10 MB sphere-thumbnail
 * cap from `asset-uploads.ts` keep the in-memory footprint bounded
 * within Workers' memory budget; videos go to Stream and never reach
 * this path. A future "Layered visualisation" follow-on that raises
 * caps for very large image assets should land a streaming hash at
 * the same time.
 *
 * Returns:
 *   - `{ ok: true, digest, size }` on match.
 *   - `{ ok: false, reason: 'missing' }` if the object doesn't exist.
 *   - `{ ok: false, reason: 'mismatch', actual, claimed }` on hash mismatch.
 *   - `{ ok: false, reason: 'malformed_claim' }` if the claim is not a valid sha256:<hex64>.
 */
export type DigestVerification =
  | { ok: true; digest: string; size: number }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'mismatch'; actual: string; claimed: string }
  | { ok: false; reason: 'malformed_claim' }
  | { ok: false; reason: 'binding_missing' }

export async function verifyContentDigest(
  env: R2Env,
  key: string,
  claimedDigest: string,
): Promise<DigestVerification> {
  const parsed = parseSha256Claim(claimedDigest)
  if (!parsed) return { ok: false, reason: 'malformed_claim' }
  if (!env.CATALOG_R2) return { ok: false, reason: 'binding_missing' }

  const obj = await env.CATALOG_R2.get(key)
  if (!obj) return { ok: false, reason: 'missing' }

  const buffer = await obj.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  const actualHex = bytesToHex(new Uint8Array(hash))
  const actual = `sha256:${actualHex}`

  if (actualHex !== parsed) {
    return { ok: false, reason: 'mismatch', actual, claimed: claimedDigest }
  }
  return { ok: true, digest: actual, size: buffer.byteLength }
}

/**
 * Existence-only verification: HEAD the R2 object, return its
 * recorded size, but **don't read the body**. Used by the
 * video-source /complete path where the source MP4 can be up to
 * 10 GB — pulling it through `arrayBuffer()` would blow past the
 * Workers 128 MB memory cap. The transcode runner re-hashes the
 * source via Node's streaming `crypto.createHash` before kicking
 * off ffmpeg, so a tampered upload still surfaces as the
 * runner's exit-code-2 + stuck `transcoding=1` rather than
 * silently encoding bad bytes.
 *
 * Returns:
 *   - `{ ok: true, size }` when the object exists. Size is the
 *     bytes R2 has recorded for it (operator can sanity-check
 *     against the publisher's `declared_size`).
 *   - `{ ok: false, reason: 'missing' }` if not present.
 *   - `{ ok: false, reason: 'binding_missing' }` if CATALOG_R2
 *     isn't wired.
 */
export type ExistenceVerification =
  | { ok: true; size: number }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'binding_missing' }

export async function verifyObjectExists(
  env: R2Env,
  key: string,
): Promise<ExistenceVerification> {
  if (!env.CATALOG_R2) return { ok: false, reason: 'binding_missing' }
  const head = await env.CATALOG_R2.head(key)
  if (!head) return { ok: false, reason: 'missing' }
  return { ok: true, size: head.size }
}

function parseSha256Claim(claim: string): string | null {
  const match = /^sha256:([0-9a-f]{64})$/.exec(claim)
  return match ? match[1] : null
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

// ---------------------------------------------------------------------------
// AWS SigV4 query-string presigning, scoped to S3 / R2.
//
// R2 advertises itself with region "auto" and signs as service "s3".
// Only the bits needed for a presigned PUT live here — no body
// signing (we use UNSIGNED-PAYLOAD), no chunked encoding, no
// session tokens. Anything beyond that is a future-phase concern.
// ---------------------------------------------------------------------------

const SIGV4_REGION = 'auto'
const SIGV4_SERVICE = 's3'
const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256'
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

interface PresignArgs {
  endpoint: string
  bucket: string
  key: string
  accessKeyId: string
  secretAccessKey: string
  ttlSeconds: number
  now: Date
  contentType?: string
}

async function sigv4PresignPut(args: PresignArgs): Promise<string> {
  const { endpoint, bucket, key, accessKeyId, secretAccessKey, ttlSeconds, now, contentType } = args

  const endpointUrl = new URL(endpoint)
  const host = endpointUrl.host
  // Path-style addressing: `<endpoint>/<bucket>/<key>`. R2 also
  // accepts virtual-hosted style; path-style avoids a custom-host
  // certificate concern and is what the R2 dashboard's "S3 API"
  // examples print.
  const canonicalUri = `/${bucket}/${encodeKey(key)}`

  const amzDate = formatAmzDate(now) // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8) // YYYYMMDD
  const credentialScope = `${dateStamp}/${SIGV4_REGION}/${SIGV4_SERVICE}/aws4_request`

  const signedHeaderNames = contentType ? ['content-type', 'host'] : ['host']
  const signedHeadersValue = signedHeaderNames.join(';')

  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': SIGV4_ALGORITHM,
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(ttlSeconds),
    'X-Amz-SignedHeaders': signedHeadersValue,
  }

  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map(k => `${rfc3986(k)}=${rfc3986(queryParams[k])}`)
    .join('&')

  const canonicalHeaders =
    (contentType ? `content-type:${contentType.trim()}\n` : '') +
    `host:${host}\n`

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeadersValue,
    UNSIGNED_PAYLOAD,
  ].join('\n')

  const stringToSign = [
    SIGV4_ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const signingKey = await deriveSigningKey(secretAccessKey, dateStamp)
  const sigBytes = await hmacSha256(signingKey, stringToSign)
  const signature = bytesToHex(new Uint8Array(sigBytes))

  return (
    `${endpointUrl.origin}${canonicalUri}?${canonicalQueryString}` +
    `&X-Amz-Signature=${signature}`
  )
}

function encodeKey(key: string): string {
  // S3 canonical URI: encode each segment but keep slashes.
  return key.split('/').map(rfc3986).join('/')
}

/**
 * RFC 3986 percent-encoding for SigV4 — encodes everything except
 * the unreserved set (alnum and `-._~`). `encodeURIComponent`
 * leaves a few characters alone (`!*'()`) that AWS expects encoded,
 * so we post-process.
 */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, c =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function formatAmzDate(d: Date): string {
  const iso = d.toISOString()
  // 2024-01-02T03:04:05.678Z → 20240102T030405Z
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return bytesToHex(new Uint8Array(hash))
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
}

async function deriveSigningKey(secret: string, dateStamp: string): Promise<ArrayBuffer> {
  const kSecret = new TextEncoder().encode(`AWS4${secret}`)
  const kDate = await hmacSha256(kSecret, dateStamp)
  const kRegion = await hmacSha256(kDate, SIGV4_REGION)
  const kService = await hmacSha256(kRegion, SIGV4_SERVICE)
  return hmacSha256(kService, 'aws4_request')
}
