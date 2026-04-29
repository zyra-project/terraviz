/**
 * Cloudflare Stream helpers — Phase 1b.
 *
 * Stream is the video half of the asset pipeline; R2 carries images,
 * captions, legends, sphere thumbnails, and tour JSON. The two
 * stores have different upload protocols (Stream mints a one-shot
 * "direct upload" URL with TUS-resumable semantics; R2 hands out an
 * S3-compatible presigned PUT). This module wraps Stream's REST API
 * so the asset-init handler in Commit C can branch on `kind` and
 * call the right store without leaking HTTP plumbing into the route.
 *
 * What lives here:
 *
 *   - `mintDirectUploadUrl(env, opts)` — calls
 *     `POST /accounts/{id}/stream/direct_upload`, returns
 *     `{ upload_url, stream_uid }`. The browser/CLI POSTs the file
 *     bytes directly to `upload_url`; Stream picks up the bytes,
 *     transcodes, and exposes them under `stream_uid`.
 *   - `getTranscodeStatus(env, uid)` — polls
 *     `GET /accounts/{id}/stream/{uid}` and returns a small `{ state,
 *     ready, errors }` summary the publisher portal / CLI can poll
 *     until ready.
 *   - `streamPlaybackUrl(env, uid)` — builds the public HLS playback
 *     URL pattern Stream documents
 *     (`https://customer-<id>.cloudflarestream.com/<uid>/manifest/video.m3u8`).
 *     Signed-token playback for restricted assets is a Phase 4
 *     federation concern; this function emits the public form only.
 *
 * Local dev runs with `MOCK_STREAM=true`. In mock mode every call
 * returns deterministic stub values keyed by an in-memory state
 * machine so a multi-step "request upload → poll until ready"
 * walkthrough behaves the same as a real Stream account would. No
 * Cloudflare account, no API token, no real bytes uploaded.
 */

export interface StreamEnv {
  /**
   * Cloudflare account id that owns the Stream subscription.
   * Required for real-mode calls; ignored when `MOCK_STREAM=true`.
   */
  STREAM_ACCOUNT_ID?: string
  /**
   * API token with `Stream: Edit` permission. Wrangler secret in
   * production. Ignored when `MOCK_STREAM=true`.
   */
  STREAM_API_TOKEN?: string
  /**
   * Customer subdomain Stream prints in the dashboard
   * (`customer-<hex>.cloudflarestream.com`). Hard-coded into the
   * playback URL pattern, so we let operators override it without
   * recompiling. Defaults to `customer-mock.cloudflarestream.com`
   * in mock mode.
   */
  STREAM_CUSTOMER_SUBDOMAIN?: string
  /**
   * `"true"` returns deterministic stub values from every helper
   * in this module so the contributor walkthrough works without a
   * Cloudflare Stream subscription. Refused for real-mode calls
   * by `requireStreamConfig`.
   */
  MOCK_STREAM?: string
}

/** Default mock customer subdomain — surfaced in the playback URL. */
export const MOCK_STREAM_SUBDOMAIN = 'customer-mock.cloudflarestream.com'

/** Default mock direct-upload host. Tests assert URLs against this. */
export const MOCK_STREAM_UPLOAD_HOST = 'https://mock-stream.localhost'

/** Default direct-upload TTL — matches Stream's documented 1-hour ceiling. */
export const STREAM_DIRECT_UPLOAD_TTL_SECONDS = 60 * 60

/**
 * Cloudflare Stream's transcode lifecycle. We squash Stream's full
 * vocabulary (`pendingupload | downloading | queued | inprogress |
 * ready | error | live-inprogress`) into the four states the route
 * handlers actually care about.
 */
export type TranscodeState = 'pending' | 'processing' | 'ready' | 'error'

export interface MintDirectUploadOptions {
  /** Bytes the publisher claims will be uploaded. Hard-capped at 10 GB per `CATALOG_PUBLISHING_TOOLS.md`. */
  maxDurationSeconds?: number
  /** TTL for the upload URL (seconds). Defaults to `STREAM_DIRECT_UPLOAD_TTL_SECONDS`. */
  expirySeconds?: number
  /**
   * Free-form metadata keys forwarded to Stream's `meta` field. Used
   * by the asset-init handler to stash the `(dataset_id, upload_id)`
   * pair so a later webhook (Phase 4+) can correlate.
   */
  meta?: Record<string, string>
  /** Override clock for tests. */
  now?: number | Date
  /** Override `fetch` for tests. */
  fetchImpl?: typeof fetch
}

export interface DirectUploadMint {
  /** URL the browser/CLI POSTs the file bytes to. */
  upload_url: string
  /** Stream-assigned UID; becomes the `stream:<uid>` `data_ref`. */
  stream_uid: string
  /** ISO 8601 UTC timestamp; uploads after this MUST fail at Stream. */
  expires_at: string
}

/**
 * Mint a one-shot direct upload URL. In mock mode returns a
 * deterministic local URL + a deterministic uid derived from the
 * current time so a multi-step test can correlate.
 */
export async function mintDirectUploadUrl(
  env: StreamEnv,
  options: MintDirectUploadOptions = {},
): Promise<DirectUploadMint> {
  const ttl = options.expirySeconds ?? STREAM_DIRECT_UPLOAD_TTL_SECONDS
  const now = normaliseNow(options.now)
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString()

  if (env.MOCK_STREAM === 'true') {
    const uid = mockUid(now)
    return {
      upload_url: `${MOCK_STREAM_UPLOAD_HOST}/upload/${uid}`,
      stream_uid: uid,
      expires_at: expiresAt,
    }
  }

  const config = requireStreamConfig(env)
  const fetchImpl = options.fetchImpl ?? fetch

  const body: Record<string, unknown> = { expiry: expiresAt }
  if (options.maxDurationSeconds != null) body.maxDurationSeconds = options.maxDurationSeconds
  if (options.meta) body.meta = options.meta

  const res = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/direct_upload`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
  const json = (await res.json().catch(() => null)) as StreamDirectUploadResponse | null
  if (!res.ok || !json?.success || !json.result?.uploadURL || !json.result?.uid) {
    const reason = (json?.errors && json.errors[0]?.message) || `HTTP ${res.status}`
    throw new Error(`Stream direct_upload failed: ${reason}`)
  }
  return {
    upload_url: json.result.uploadURL,
    stream_uid: json.result.uid,
    expires_at: expiresAt,
  }
}

interface StreamDirectUploadResponse {
  success: boolean
  errors?: Array<{ code: number; message: string }>
  result?: { uploadURL?: string; uid?: string }
}

export interface TranscodeStatus {
  state: TranscodeState
  /** Convenience: `state === 'ready'`. */
  ready: boolean
  /** Stream's raw state string, surfaced for debugging only. */
  raw_state?: string
  /** Stream's `errors` array if the asset failed to transcode. */
  errors?: string[]
}

export interface GetTranscodeStatusOptions {
  fetchImpl?: typeof fetch
}

/**
 * Poll Stream for the transcode state of a uid. In mock mode every
 * uid is `ready` immediately — the contributor walkthrough doesn't
 * pretend a transcode takes time.
 */
export async function getTranscodeStatus(
  env: StreamEnv,
  uid: string,
  options: GetTranscodeStatusOptions = {},
): Promise<TranscodeStatus> {
  if (env.MOCK_STREAM === 'true') {
    return { state: 'ready', ready: true, raw_state: 'ready' }
  }

  const config = requireStreamConfig(env)
  const fetchImpl = options.fetchImpl ?? fetch
  const res = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/stream/${encodeURIComponent(uid)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiToken}` },
    },
  )
  const json = (await res.json().catch(() => null)) as StreamGetResponse | null
  if (!res.ok || !json?.success || !json.result) {
    const reason = (json?.errors && json.errors[0]?.message) || `HTTP ${res.status}`
    throw new Error(`Stream get failed: ${reason}`)
  }
  const rawState = json.result.status?.state ?? ''
  const errMsgs = (json.result.status?.errorReasonText
    ? [json.result.status.errorReasonText]
    : undefined)
  return {
    state: normaliseState(rawState),
    ready: rawState === 'ready',
    raw_state: rawState,
    errors: errMsgs,
  }
}

interface StreamGetResponse {
  success: boolean
  errors?: Array<{ code: number; message: string }>
  result?: {
    uid: string
    status?: { state: string; errorReasonText?: string }
  }
}

function normaliseState(s: string): TranscodeState {
  switch (s) {
    case 'ready':
      return 'ready'
    case 'error':
      return 'error'
    case 'pendingupload':
    case '':
      return 'pending'
    default:
      return 'processing'
  }
}

/**
 * Public HLS playback URL for a Stream uid. Signed-token playback
 * for restricted assets is a Phase 4 federation concern and is not
 * implemented here.
 */
export function streamPlaybackUrl(env: StreamEnv, uid: string): string {
  const subdomain =
    env.STREAM_CUSTOMER_SUBDOMAIN?.trim() ||
    (env.MOCK_STREAM === 'true' ? MOCK_STREAM_SUBDOMAIN : '')
  if (!subdomain) {
    throw new Error(
      'STREAM_CUSTOMER_SUBDOMAIN is not configured. Set it from the Stream ' +
        'dashboard, or set MOCK_STREAM=true for local development.',
    )
  }
  return `https://${subdomain}/${encodeURIComponent(uid)}/manifest/video.m3u8`
}

interface ResolvedStreamConfig {
  accountId: string
  apiToken: string
}

function requireStreamConfig(env: StreamEnv): ResolvedStreamConfig {
  const accountId = env.STREAM_ACCOUNT_ID?.trim()
  const apiToken = env.STREAM_API_TOKEN?.trim()
  if (!accountId || !apiToken) {
    throw new Error(
      'Stream is not configured. Set STREAM_ACCOUNT_ID + STREAM_API_TOKEN, ' +
        'or set MOCK_STREAM=true for local development.',
    )
  }
  return { accountId, apiToken }
}

function normaliseNow(input: number | Date | undefined): Date {
  if (input == null) return new Date()
  if (input instanceof Date) return input
  return new Date(input)
}

/**
 * Deterministic mock UID derived from a clock — hex encoding of
 * the ms timestamp, padded to a 32-char fixed length so it looks
 * like a real Stream uid (32-hex). Different clock → different
 * uid; same clock → same uid (which is exactly what the test
 * fixtures want).
 */
function mockUid(now: Date): string {
  const ms = now.getTime().toString(16).padStart(12, '0')
  // Pad with `0` to the 32-char Stream-uid shape. Tests don't care
  // about the suffix, only that it's stable for a given clock.
  return (`${ms}` + '0'.repeat(32)).slice(0, 32)
}
