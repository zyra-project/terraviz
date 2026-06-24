/**
 * R2 S3-API bulk uploader for HLS bundles.
 *
 * Phase 3 commit B. Takes a local directory produced by
 * `cli/lib/ffmpeg-hls.ts`'s `encodeHls` and uploads its contents
 * to Cloudflare R2 under a key prefix, preserving the directory
 * structure that the HLS master playlist's relative-path
 * variants expect.
 *
 * Talks to R2 via the S3-compatible API rather than Cloudflare's
 * native R2 binding because this is operator-side code running
 * outside the Pages Function runtime. Operator credentials —
 * `R2_S3_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
 * — are the same trio Phase 2's commit 2/N added to
 * `expected-bindings.ts`; the migration CLI reads them from
 * `process.env`.
 *
 * SigV4 signing is delegated to `aws4fetch` — a tiny, fetch-based
 * SigV4 library specifically designed for edge / CLI use. The
 * full AWS SDK would bring multiple megabytes of transitive
 * dependencies for what is, in the end, "PUT bytes with a
 * signature." aws4fetch is ~2 KB minified, no transitive deps.
 *
 * Concurrency: bounded parallelism per Decision 8 in the Phase 3
 * brief. Each row's bundle has ~30-60 small files (master + 3
 * variant playlists + ~3 × 10 segments); uploading sequentially
 * would take 30-60× the per-PUT round-trip. We cap concurrency
 * at 6 PUTs per row — fast enough to saturate the operator's
 * uplink without burning R2's per-bucket request rate.
 *
 * Per-file Content-Type:
 *   .m3u8 → application/vnd.apple.mpegurl   (HLS playlists)
 *   .ts   → video/mp2t                       (MPEG transport segments)
 *   *     → application/octet-stream         (fallback)
 *
 * Setting Content-Type matters: HLS players inspect it when the
 * master playlist URL is hit, and R2's public-bucket serving
 * passes the stored Content-Type through verbatim. A misnamed
 * Content-Type breaks playback in some clients (Safari is
 * especially strict).
 */

import { AwsClient } from 'aws4fetch'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

/** Default parallelism per bundle. See Decision 8 in the brief —
 * enough to hide PUT latency, low enough to be polite to R2. */
const DEFAULT_CONCURRENCY = 6

/** S3-API region R2 expects in the SigV4 signature. R2 ignores
 * the value for routing but the signing algorithm requires a
 * region as input. Cloudflare's docs use `auto`. */
const R2_REGION = 'auto'

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.vtt': 'text/vtt',
  '.mp4': 'video/mp4',
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** Operator-side R2 credentials. The CLI reads these from
 * `process.env`; tests pass them directly. */
export interface R2UploadConfig {
  /** Full https://...r2.cloudflarestorage.com URL (no trailing slash). */
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  /** Bucket name. Default `terraviz-assets`. */
  bucket: string
}

export interface R2UploadOptions {
  /** Test injection — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Override the per-bundle PUT concurrency. */
  concurrency?: number
  /** Called for each file once its PUT lands successfully. */
  onProgress?: (info: { key: string; bytes: number; done: number; total: number }) => void
}

export interface R2UploadResult {
  /** Key of the master playlist (callers use this to build the
   * row's `data_ref`). */
  masterKey: string
  /** Every key that was uploaded for this bundle. */
  keys: string[]
  /** Total bytes uploaded across all files in the bundle. */
  totalBytes: number
  /** Wall-clock upload duration in ms. */
  durationMs: number
}

export class R2UploadError extends Error {
  readonly status: number | null
  readonly key: string | null

  constructor(status: number | null, key: string | null, message: string) {
    super(message)
    this.name = 'R2UploadError'
    this.status = status
    this.key = key
  }
}

/** Total attempts per R2 request before giving up on transient
 *  failures. R2 returns sporadic `500 InternalError` on PUT and a
 *  `429 ServiceUnavailable` ("reduce your rate of simultaneous reads")
 *  under read pressure; a single un-retried op among thousands (the
 *  frame cache restore/save, the transcode's segment HEADs) drops that
 *  object — and for the cache that means a NOAA re-fetch. */
const DEFAULT_R2_ATTEMPTS = 4
/** Base backoff between R2 retries (ms); doubles each attempt. */
const DEFAULT_R2_RETRY_DELAY_MS = 500

function r2Sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

/** Transient R2 failures worth retrying: a network throw (the callers
 *  surface this path separately), R2's rate-limit 429, and any 5xx
 *  (the sporadic InternalError). Deterministic 4xx (403/404/…) fail
 *  fast — a retry can't fix them. */
function isRetryableR2Status(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * Sign + fetch an R2 request, retrying transient failures (network
 * error, 429, 5xx) with exponential backoff. Re-signs each attempt so a
 * long backoff can't outlive the SigV4 signature. Returns the final
 * `Response` — the caller applies its own ok/non-ok handling — and
 * throws `R2UploadError` only when the final attempt is a network
 * throw. `label` (GET/PUT/HEAD/DELETE/LIST) + `key` shape the error
 * message for the operator's log.
 */
async function signedFetchWithRetry(
  client: AwsClient,
  url: string,
  signInit: RequestInit,
  label: string,
  key: string,
  fetchImpl: typeof fetch,
  attempts: number,
  delayMs: number,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await fetchImpl(await client.sign(url, signInit))
    } catch (e) {
      if (attempt >= attempts) {
        throw new R2UploadError(
          null,
          key,
          `${label} ${key} unreachable: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      await r2Sleep(delayMs * 2 ** (attempt - 1))
      continue
    }
    if (res.ok || !isRetryableR2Status(res.status) || attempt >= attempts) return res
    await r2Sleep(delayMs * 2 ** (attempt - 1))
  }
}

/** Resolve the per-request retry budget from caller options. */
function retryBudget(options: { attempts?: number; retryDelayMs?: number }): {
  attempts: number
  delayMs: number
} {
  return {
    attempts: Math.max(1, Math.floor(options.attempts ?? DEFAULT_R2_ATTEMPTS)),
    delayMs: Math.max(0, options.retryDelayMs ?? DEFAULT_R2_RETRY_DELAY_MS),
  }
}

/**
 * Read R2 S3-API credentials from `process.env`. Returns an
 * incomplete config if any variable is missing — caller should
 * validate before use (see `validateR2Config`).
 */
export function loadR2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2UploadConfig {
  return {
    endpoint: (env.R2_S3_ENDPOINT ?? '').replace(/\/$/, ''),
    accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
    bucket: env.CATALOG_R2_BUCKET?.trim() || 'terraviz-assets',
  }
}

/** Throws `R2UploadError` with a missing-field message if any
 * required credential is unset. */
export function validateR2Config(config: R2UploadConfig): void {
  const missing: string[] = []
  if (!config.endpoint) missing.push('R2_S3_ENDPOINT')
  if (!config.accessKeyId) missing.push('R2_ACCESS_KEY_ID')
  if (!config.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY')
  if (!config.bucket) missing.push('bucket')
  if (missing.length) {
    throw new R2UploadError(
      null,
      null,
      `R2 upload config is incomplete: missing ${missing.join(', ')}.`,
    )
  }
}

/** Map a filename to the right HLS-aware Content-Type. */
export function contentTypeForFile(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return CONTENT_TYPE_BY_EXT[ext] ?? DEFAULT_CONTENT_TYPE
}

/** Build the full PUT URL for a key. R2 uses path-style addressing
 * against the account-level endpoint: `<endpoint>/<bucket>/<key>`.
 * Each key path segment is URI-encoded; slashes are preserved so
 * the directory structure is reflected in the public URL. */
export function buildObjectUrl(config: R2UploadConfig, key: string): string {
  const encodedKey = key.split('/').map(s => encodeURIComponent(s)).join('/')
  return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodedKey}`
}

/**
 * Walk a local directory and return its files relative to the
 * root, with sizes. Used by both the bundle uploader and the
 * caller's pre-flight cost estimate.
 */
export function walkBundleFiles(rootDir: string): Array<{ relative: string; absolute: string; size: number }> {
  const out: Array<{ relative: string; absolute: string; size: number }> = []
  function walk(cur: string): void {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      out.push({ relative: relative(rootDir, full), absolute: full, size: statSync(full).size })
    }
  }
  walk(rootDir)
  return out
}

/**
 * Upload all files under `localDir` to R2 under `keyPrefix`.
 * Returns once every PUT has succeeded. Throws `R2UploadError` on
 * the first failure — partial uploads stay on R2 (callers can
 * clean them up via `deleteR2Prefix` if needed, but for the
 * migration's purposes a single re-run wipes + reuploads anyway).
 *
 * The HLS bundle's directory structure is preserved in the R2
 * key space (relative path → key suffix under `keyPrefix`), so
 * the master playlist's variant-URI relative paths resolve
 * correctly when the bundle is served.
 */
export async function uploadHlsBundle(
  config: R2UploadConfig,
  localDir: string,
  keyPrefix: string,
  options: R2UploadOptions = {},
): Promise<R2UploadResult> {
  validateR2Config(config)
  const files = walkBundleFiles(localDir)
  if (files.length === 0) {
    throw new R2UploadError(null, null, `uploadHlsBundle: ${localDir} is empty`)
  }
  // master.m3u8 must exist for the bundle to be playable — fail
  // fast rather than uploading a half-baked tree.
  const masterFile = files.find(f => f.relative === 'master.m3u8')
  if (!masterFile) {
    throw new R2UploadError(
      null,
      null,
      `uploadHlsBundle: master.m3u8 not found under ${localDir}`,
    )
  }

  const prefix = keyPrefix.replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: R2_REGION,
  })

  const start = Date.now()
  let totalBytes = 0
  let done = 0
  const keys: string[] = []

  // Bounded concurrent uploads. Each worker pulls the next file
  // index off a shared cursor until the list is exhausted.
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++
      if (idx >= files.length) return
      const file = files[idx]
      const key = `${prefix}/${file.relative}`.replace(/\\/g, '/')
      const url = buildObjectUrl(config, key)
      const body = readFileSync(file.absolute)
      const contentType = contentTypeForFile(file.relative)
      // Round-trip the Uint8Array through a fresh ArrayBuffer so
      // the DOM BodyInit type-check is happy — same pattern the
      // existing cli/lib/client.ts uses for PUT bodies.
      const ab = body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer
      const signed = await client.sign(url, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(body.byteLength),
        },
        body: ab,
      })
      let res: Response
      try {
        res = await fetchImpl(signed)
      } catch (e) {
        throw new R2UploadError(
          null,
          key,
          `PUT ${key} unreachable: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (res.status < 200 || res.status >= 300) {
        const text = await res.text().catch(() => '')
        throw new R2UploadError(
          res.status,
          key,
          `PUT ${key} failed (${res.status}): ${text.slice(0, 200) || '(no body)'}`,
        )
      }
      totalBytes += file.size
      done += 1
      keys.push(key)
      options.onProgress?.({ key, bytes: file.size, done, total: files.length })
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker())
  await Promise.all(workers)

  return {
    masterKey: `${prefix}/master.m3u8`,
    keys,
    totalBytes,
    durationMs: Date.now() - start,
  }
}

export interface UploadR2ObjectOptions {
  /** Test injection. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Total attempts per request before giving up on a transient R2
   *  failure (network / 429 / 5xx). Default 4. */
  attempts?: number
  /** Base backoff between retries (ms); doubles each attempt. Default
   *  500. Tests pass 0. */
  retryDelayMs?: number
}

export interface UploadR2ObjectResult {
  /** The full R2 key the object was PUT under (echoed back so the
   * caller doesn't have to thread it alongside the result). */
  key: string
  /** Number of bytes uploaded. */
  bytes: number
  /** Wall-clock upload duration in ms. */
  durationMs: number
}

/**
 * Upload a single in-memory object to R2 via the S3 API. Used by
 * the 3b migrate-r2-assets pump, which fetches a single thumbnail
 * / legend / caption / color-table file from upstream and PUTs
 * it to R2 under `datasets/{id}/<asset>.<ext>`.
 *
 * Companion to `uploadHlsBundle`, which uploads a directory of
 * many files. The per-file logic is intentionally NOT factored
 * out of `uploadHlsBundle` here — keeping the bundle uploader's
 * inner loop self-contained means a future change to the
 * single-file path doesn't risk breaking the bundle path.
 *
 * Throws `R2UploadError` on:
 *   - missing config (validateR2Config),
 *   - network throw during the PUT,
 *   - non-2xx response from R2.
 */
export async function uploadR2Object(
  config: R2UploadConfig,
  key: string,
  body: Uint8Array,
  contentType: string,
  options: UploadR2ObjectOptions = {},
): Promise<UploadR2ObjectResult> {
  validateR2Config(config)
  const fetchImpl = options.fetchImpl ?? fetch
  const { attempts, delayMs } = retryBudget(options)
  const client = s3Client(config)

  const start = Date.now()
  const url = buildObjectUrl(config, key)
  // Same ArrayBuffer round-trip as the bundle uploader so the
  // DOM `BodyInit` type-check is happy. The slice copies — fine
  // for the small per-file payloads in scope (thumbnails up to
  // a few MB, captions a few KB).
  const ab = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer
  const res = await signedFetchWithRetry(
    client,
    url,
    {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
      },
      body: ab,
    },
    'PUT',
    key,
    fetchImpl,
    attempts,
    delayMs,
  )
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '')
    throw new R2UploadError(
      res.status,
      key,
      `PUT ${key} failed (${res.status}): ${text.slice(0, 200) || '(no body)'}`,
    )
  }

  return {
    key,
    bytes: body.byteLength,
    durationMs: Date.now() - start,
  }
}

/**
 * Delete every object under a key prefix. Used by the rollback
 * subcommand (3/F) — after the data_ref PATCH lands, this is
 * cleanup; failures are non-fatal at the caller.
 *
 * The S3 ListObjectsV2 + DeleteObjects flow would be more
 * efficient (1 list + 1 batch-delete vs 1 list + N deletes), but
 * R2's batch-delete behavior on the S3 API is subtly different
 * from AWS S3 (some quirks around quiet mode + XML error paths).
 * For the rollback path's volume (~30-60 objects per dataset,
 * one dataset at a time), per-object DELETE is simpler and
 * reliable.
 */
/**
 * Delete a single R2 object by exact key. Phase 3b uses this on
 * the per-asset rollback path (3b/I) — one row's
 * `datasets/<id>/<asset>.<ext>` deletion. Distinct from
 * `deleteR2Prefix` because:
 *
 *   - 3b assets are one-file-per-column, not directory bundles.
 *     Using deleteR2Prefix for a single file works (prefix-match)
 *     but leaves room for false-positive matches if another
 *     object happens to share a prefix.
 *   - The single-DELETE path is one HTTP round-trip instead of
 *     a LIST + N DELETEs, which is meaningful when the rollback
 *     pump processes hundreds of assets.
 *
 * Throws `R2UploadError` on:
 *   - missing config (validateR2Config),
 *   - network throw during the DELETE,
 *   - non-2xx response (404 included — the caller decides
 *     whether a missing-object DELETE is fatal; this helper
 *     surfaces it cleanly).
 */
export async function deleteR2Object(
  config: R2UploadConfig,
  key: string,
  options: UploadR2ObjectOptions = {},
): Promise<{ key: string; durationMs: number }> {
  validateR2Config(config)
  const fetchImpl = options.fetchImpl ?? fetch
  const { attempts, delayMs } = retryBudget(options)
  const client = s3Client(config)

  const start = Date.now()
  const url = buildObjectUrl(config, key)
  const res = await signedFetchWithRetry(client, url, { method: 'DELETE' }, 'DELETE', key, fetchImpl, attempts, delayMs)
  // S3 returns 204 on successful single-object DELETE. R2 follows
  // the same semantics. Anything outside 2xx is an error here —
  // the caller (rollback path) treats orphan storage as
  // non-fatal but still wants to log a clean message.
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '')
    throw new R2UploadError(
      res.status,
      key,
      `DELETE ${key} failed (${res.status}): ${text.slice(0, 200) || '(no body)'}`,
    )
  }

  return { key, durationMs: Date.now() - start }
}

function s3Client(config: R2UploadConfig): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: R2_REGION,
  })
}

/**
 * HEAD an R2 object: true if it exists, false on 404. Used by the
 * content-addressed frame publish to skip re-uploading frames already
 * in the shared store (`docs/INCREMENTAL_FRAME_UPLOAD_PLAN.md`). Throws
 * `R2UploadError` on a network failure or an unexpected non-404 error
 * status so a transient hiccup can be distinguished from a real
 * "absent" (callers treat a thrown HEAD as "not present" → re-upload,
 * which is always safe because the key is content-addressed).
 */
export async function r2ObjectExists(
  config: R2UploadConfig,
  key: string,
  options: UploadR2ObjectOptions = {},
): Promise<boolean> {
  validateR2Config(config)
  const fetchImpl = options.fetchImpl ?? fetch
  const { attempts, delayMs } = retryBudget(options)
  const res = await signedFetchWithRetry(
    s3Client(config),
    buildObjectUrl(config, key),
    { method: 'HEAD' },
    'HEAD',
    key,
    fetchImpl,
    attempts,
    delayMs,
  )
  if (res.status === 404) return false
  if (res.status >= 200 && res.status < 300) return true
  throw new R2UploadError(res.status, key, `HEAD ${key} failed (${res.status})`)
}

/** GET an R2 object's body as text, or null on 404. Used by the frame
 *  GC to read the currently-advertised `source_filenames.json` manifest
 *  for the keep-set. Throws on network / non-404 error. */
export async function getR2ObjectText(
  config: R2UploadConfig,
  key: string,
  options: UploadR2ObjectOptions = {},
): Promise<string | null> {
  validateR2Config(config)
  const fetchImpl = options.fetchImpl ?? fetch
  const { attempts, delayMs } = retryBudget(options)
  const res = await signedFetchWithRetry(
    s3Client(config),
    buildObjectUrl(config, key),
    { method: 'GET' },
    'GET',
    key,
    fetchImpl,
    attempts,
    delayMs,
  )
  if (res.status === 404) return null
  if (res.status < 200 || res.status >= 300) {
    throw new R2UploadError(res.status, key, `GET ${key} failed (${res.status})`)
  }
  return await res.text()
}

/** GET an R2 object's bytes, or null on 404. Retries transient
 *  failures (network / 429 / 5xx) like the other helpers. Used by the
 *  frame cache restore to pull each cached frame onto disk; frames are
 *  small (~1 MB JPEGs) so an in-memory `arrayBuffer` is fine. Throws on
 *  a non-404 error. */
export async function getR2ObjectBytes(
  config: R2UploadConfig,
  key: string,
  options: UploadR2ObjectOptions = {},
): Promise<Uint8Array | null> {
  validateR2Config(config)
  const fetchImpl = options.fetchImpl ?? fetch
  const { attempts, delayMs } = retryBudget(options)
  const res = await signedFetchWithRetry(
    s3Client(config),
    buildObjectUrl(config, key),
    { method: 'GET' },
    'GET',
    key,
    fetchImpl,
    attempts,
    delayMs,
  )
  if (res.status === 404) return null
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '')
    throw new R2UploadError(res.status, key, `GET ${key} failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Paginated ListObjectsV2 over a key prefix — follows
 * `NextContinuationToken` so a prefix with more than 1,000 objects (a
 * frame store routinely has thousands) lists completely. Returns every
 * key under the prefix. Throws `R2UploadError` on a network / non-2xx
 * failure.
 */
export async function listR2KeysPaginated(
  config: R2UploadConfig,
  prefix: string,
  options: UploadR2ObjectOptions = {},
): Promise<string[]> {
  validateR2Config(config)
  const fetchImpl = options.fetchImpl ?? fetch
  const { attempts, delayMs } = retryBudget(options)
  const client = s3Client(config)
  const keys: string[] = []
  let token: string | undefined
  do {
    let url =
      `${config.endpoint}/${encodeURIComponent(config.bucket)}` +
      `?list-type=2&prefix=${encodeURIComponent(prefix)}`
    if (token) url += `&continuation-token=${encodeURIComponent(token)}`
    const res = await signedFetchWithRetry(client, url, { method: 'GET' }, 'LIST', prefix, fetchImpl, attempts, delayMs)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new R2UploadError(res.status, prefix, `LIST ${prefix} failed (${res.status}): ${text.slice(0, 200)}`)
    }
    const xml = await res.text()
    keys.push(...parseListKeys(xml))
    token = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)
      ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
      : undefined
  } while (token)
  return keys
}

export async function deleteR2Prefix(
  config: R2UploadConfig,
  keyPrefix: string,
  options: R2UploadOptions = {},
): Promise<{ deleted: number; durationMs: number }> {
  validateR2Config(config)
  const prefix = keyPrefix.replace(/\/+$/, '') + '/'
  const fetchImpl = options.fetchImpl ?? fetch
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: R2_REGION,
  })

  // List first so we know exactly which keys to delete. R2's
  // ListObjectsV2 uses URL params `list-type=2&prefix=<p>`.
  const listUrl =
    `${config.endpoint}/${encodeURIComponent(config.bucket)}` +
    `?list-type=2&prefix=${encodeURIComponent(prefix)}`
  const listSigned = await client.sign(listUrl, { method: 'GET' })
  let listRes: Response
  try {
    listRes = await fetchImpl(listSigned)
  } catch (e) {
    // Network error on the LIST — translate to R2UploadError so
    // callers get a consistent failure shape (rather than a raw
    // TypeError from undici escaping the helper's contract).
    throw new R2UploadError(
      null,
      prefix,
      `LIST ${prefix} unreachable: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!listRes.ok) {
    const text = await listRes.text().catch(() => '')
    throw new R2UploadError(
      listRes.status,
      prefix,
      `LIST ${prefix} failed (${listRes.status}): ${text.slice(0, 200)}`,
    )
  }
  const xml = await listRes.text()
  const keys = parseListKeys(xml)

  const start = Date.now()
  let cursor = 0
  let deleted = 0
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++
      if (idx >= keys.length) return
      const key = keys[idx]
      const url = buildObjectUrl(config, key)
      const signed = await client.sign(url, { method: 'DELETE' })
      let res: Response
      try {
        res = await fetchImpl(signed)
      } catch (e) {
        // Network error on a per-object DELETE — translate to
        // R2UploadError with the failing key for attribution.
        throw new R2UploadError(
          null,
          key,
          `DELETE ${key} unreachable: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      // S3 DELETE returns 204; 404 is treated as success (idempotent).
      if (res.status === 204 || res.status === 200 || res.status === 404) {
        deleted += 1
        continue
      }
      const text = await res.text().catch(() => '')
      throw new R2UploadError(
        res.status,
        key,
        `DELETE ${key} failed (${res.status}): ${text.slice(0, 200)}`,
      )
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, keys.length || 1) }, () => worker())
  await Promise.all(workers)

  return { deleted, durationMs: Date.now() - start }
}

/**
 * Parse object keys out of the S3 ListObjectsV2 XML response.
 * R2's response is standard S3 XML — each object is wrapped in
 * a `<Contents><Key>...</Key></Contents>` element. A tiny regex
 * is enough for our case; we don't need a full XML parser
 * (no namespaces, no nested element trees that matter for keys).
 *
 * Exported for tests.
 */
export function parseListKeys(xml: string): string[] {
  const keys: string[] = []
  const re = /<Key>([^<]+)<\/Key>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    keys.push(decodeXmlEntities(match[1]))
  }
  return keys
}

function decodeXmlEntities(s: string): string {
  // Order matters: `&amp;` must come LAST so all other entities
  // resolve first. Otherwise a literal source-text `&quot;` (which
  // S3 encodes as `&amp;quot;` in the XML response) double-
  // unescapes through `&amp;` → `&quot;` → `"`, corrupting keys
  // that contain literal `&quot;` / `&apos;` / `&lt;` / `&gt;`
  // sequences. Caught by CodeQL on the Phase 3 PR review.
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
