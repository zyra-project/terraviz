/**
 * Cloudflare Pages Function — /api/ingest
 *
 * Receives batches of telemetry events from the client and writes
 * each one as a datapoint to Workers Analytics Engine. Injects the
 * server-side `environment` tag (production / preview / local) so
 * queries can separate prod traffic from preview deploys without
 * needing a second AE dataset.
 *
 * Accepts anonymous POSTs with no auth token. Abuse controls:
 * origin allowlist, per-IP and per-session rate limits, hard body
 * cap, KV-backed kill switch that returns 410 Gone so the client
 * cools down for the rest of the session.
 *
 * See docs/ANALYTICS_IMPLEMENTATION_PLAN.md "Phase 1 architecture"
 * and "Security posture" for the full spec. Privacy posture: this
 * endpoint never writes CF-Connecting-IP into analytics storage —
 * IP is only seen briefly for rate limiting.
 *
 * Body:
 *   { session_id: string, events: TelemetryEvent[] }
 *
 * Responses:
 *   204  — accepted, nothing to say
 *   400  — invalid JSON or schema
 *   403  — origin mismatch
 *   410  — kill switch on; client should stop for the session
 *   413  — body too large
 *   429  — rate limited
 */

import type { TelemetryEvent } from '../../src/types'

interface Env {
  /** Analytics Engine dataset binding — declared in wrangler.toml. */
  ANALYTICS?: AnalyticsEngineDataset
  /** KV namespace for the runtime kill switch. */
  TELEMETRY_KILL_SWITCH?: KVNamespace
  /** Cloudflare Pages injects these at runtime. */
  CF_PAGES?: string
  CF_PAGES_BRANCH?: string
}

interface IngestBody {
  session_id: string
  events: TelemetryEvent[]
}

// --- Tunables (exported for tests) ---

export const MAX_BODY_BYTES = 65_536
export const MAX_EVENTS_PER_REQUEST = 100
export const MAX_SESSION_ID_LEN = 64
export const MAX_STRING_FIELD_LEN = 1024
export const RATE_LIMIT_PER_IP = 60
export const RATE_LIMIT_PER_SESSION = 100
export const RATE_WINDOW_MS = 60_000
export const KILL_SWITCH_KEY = 'telemetry_enabled'

// Values the kill switch may take. Absent / any other value = allow.
const KILL_SWITCH_DENY_VALUES = new Set(['false', 'disabled', '0', 'off'])

// Every event type declared in src/types/index.ts. Unknown types are
// rejected at validation — fail closed.
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session_start', 'session_end', 'layer_loaded', 'layer_unloaded',
  'feedback', 'camera_settled', 'map_click', 'viewport_focus',
  'layout_changed', 'playback_action', 'settings_changed',
  'browse_opened', 'browse_filter', 'tour_started', 'tour_task_fired',
  'tour_paused', 'tour_resumed', 'tour_ended', 'tour_question_answered',
  'vr_session_started',
  'vr_session_ended', 'vr_placement', 'perf_sample', 'error',
  'dwell', 'orbit_interaction', 'orbit_turn', 'orbit_tool_call',
  'orbit_load_followed', 'orbit_correction', 'browse_search',
  'vr_interaction', 'error_detail',
])

// --- CORS / origin ---

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  'http://localhost:5173',
  'http://localhost:4173',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
])

function isAllowedOrigin(origin: string | null, requestUrl: string): boolean {
  if (!origin) return false
  if (ALLOWED_ORIGINS.has(origin)) return true
  // Same-origin accepted always (lets preview deploys call their own
  // Pages Function without listing every preview subdomain).
  try {
    const req = new URL(requestUrl)
    if (origin === req.origin) return true
    const oHost = new URL(origin).hostname
    if (oHost.endsWith('.pages.dev')) return true
  } catch {
    // Malformed origin — fall through to reject
  }
  return false
}

function corsHeaders(origin?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
  if (origin) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

// --- Rate limiting (in-memory, per-isolate) ---

interface RateEntry { count: number; resetAt: number }

const ipRate = new Map<string, RateEntry>()
const sessionRate = new Map<string, RateEntry>()

function isRateLimited(
  map: Map<string, RateEntry>,
  key: string,
  limit: number,
  now: number = Date.now(),
): boolean {
  const entry = map.get(key)
  if (!entry || now > entry.resetAt) {
    map.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
    // Evict expired keys occasionally to bound memory.
    if (map.size > 1000) {
      for (const [k, v] of map) {
        if (now > v.resetAt) map.delete(k)
      }
    }
    return false
  }
  entry.count++
  return entry.count > limit
}

/** Test helper — clear per-isolate rate-limit state between cases. */
export function __resetRateLimitState(): void {
  ipRate.clear()
  sessionRate.clear()
}

// --- Validation ---

function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_SESSION_ID_LEN
}

function isValidEvent(event: unknown): event is TelemetryEvent {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false
  const e = event as Record<string, unknown>
  if (typeof e.event_type !== 'string') return false
  if (!KNOWN_EVENT_TYPES.has(e.event_type)) return false

  for (const [key, value] of Object.entries(e)) {
    if (key === 'event_type') continue
    // Reject `null` on the wire — it confuses the positional blob /
    // double encoding in `toDataPoint` (a skipped field shifts every
    // subsequent field up one position, breaking dashboards that pin
    // queries to specific blob/double indexes). Clients should emit
    // `''` for empty strings and `0` (or another sentinel) for empty
    // numbers; see `CameraSettledEvent.layer_id` for the canonical
    // example.
    if (value === null) return false
    const t = typeof value
    if (t === 'string') {
      if ((value as string).length > MAX_STRING_FIELD_LEN) return false
    } else if (t === 'number') {
      if (!Number.isFinite(value as number)) return false
    } else if (t === 'boolean') {
      // OK
    } else {
      // Objects, arrays, functions, symbols, undefined — rejected
      return false
    }
  }
  return true
}

function isValidBody(body: unknown): body is IngestBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const b = body as Record<string, unknown>
  if (!isValidSessionId(b.session_id)) return false
  if (!Array.isArray(b.events)) return false
  if (b.events.length === 0) return false
  if (b.events.length > MAX_EVENTS_PER_REQUEST) return false
  for (const event of b.events) {
    if (!isValidEvent(event)) return false
  }
  return true
}

// --- Environment tagging ---

/** Injected as `environment` blob on every datapoint. Server is the
 * source of truth — clients never participate in this. */
export function environmentOf(env: Env): 'production' | 'preview' | 'local' {
  if (!env.CF_PAGES) return 'local'
  return env.CF_PAGES_BRANCH === 'main' ? 'production' : 'preview'
}

/** Normalize Cloudflare's `CF-IPCountry` header to a 2-letter ISO
 * code, or `'XX'` when absent / malformed. Cloudflare uses the
 * pseudo-code `'T1'` for Tor / unknown network origins; we map
 * that to `'XX'` too so dashboards don't show it as a real country.
 * This is the only geo-derived signal written to storage; the
 * raw IP is read by the rate limiter and discarded. */
export function countryOf(cfCountry: string | null): string {
  if (!cfCountry) return 'XX'
  const trimmed = cfCountry.trim().toUpperCase()
  if (trimmed.length !== 2) return 'XX'
  if (!/^[A-Z]{2}$/.test(trimmed)) return 'XX'
  if (trimmed === 'T1' || trimmed === 'XX') return 'XX'
  return trimmed
}

/** Names of the headers Cloudflare Access attaches to a signed-in
 * staff request. Exported so tests can reference them by name
 * instead of hard-coding strings. `cf-access-authenticated-user-
 * email` is the plaintext identity header, `cf-access-jwt-
 * assertion` is the signed JWT — either indicates a verified
 * staff session at the edge. Cloudflare strips these headers
 * from unauthenticated requests, so presence-alone is safe. */
export const CF_ACCESS_HEADERS = [
  'cf-access-authenticated-user-email',
  'cf-access-jwt-assertion',
] as const

/** True when the request carries a Cloudflare Access identity.
 * Intentionally presence-only — we never read the email value
 * into analytics storage. The boolean derivation runs in the
 * Pages Function where the headers are trusted (Cloudflare's
 * edge guarantees unforgeable delivery). */
export function isInternalRequest(request: Request): boolean {
  for (const name of CF_ACCESS_HEADERS) {
    const value = request.headers.get(name)
    if (value && value.trim().length > 0) return true
  }
  return false
}

// --- Kill switch ---

async function isKillSwitchOn(env: Env): Promise<boolean> {
  const kv = env.TELEMETRY_KILL_SWITCH
  if (!kv) return false
  try {
    const value = await kv.get(KILL_SWITCH_KEY)
    return value !== null && KILL_SWITCH_DENY_VALUES.has(value.toLowerCase())
  } catch {
    // Fail open — a broken KV binding shouldn't take the whole
    // endpoint down.
    return false
  }
}

// --- AE payload conversion ---

/** Convert a typed event into the positional `blobs` / `doubles` /
 * `indexes` shape Analytics Engine expects. Server-stamped blobs
 * come first so their positions are stable across event types:
 *   blob1 = `event_type`
 *   blob2 = `environment`
 *   blob3 = `country` (2-letter ISO, or `'XX'` when unknown)
 *   blob4 = `internal` (`'true'` / `'false'` — Cloudflare Access
 *           staff identity present on the request)
 * Subsequent blobs and doubles are the event's own string / number
 * fields in alphabetical order. Query patterns that rely on blob
 * positions live in docs/ANALYTICS_QUERIES.md.
 *
 * Position-stability invariant: every event of a given `event_type`
 * MUST contribute the same set of keys, otherwise a missing field
 * shifts every subsequent field up by one position and breaks
 * dashboards that pin queries to specific indexes. Enforced by:
 *   - TS types declare every field as required (no `?:`).
 *   - `null` is rejected at `isValidEvent` (clients emit `''`/`0`
 *     sentinels for absent values).
 *   - `undefined` is also rejected here for belt-and-suspenders. */
export function toDataPoint(
  event: TelemetryEvent,
  sessionId: string,
  environment: string,
  country: string,
  internal: boolean,
): AnalyticsEngineDataPoint {
  const blobs: string[] = [
    event.event_type,
    environment,
    country,
    internal ? 'true' : 'false',
  ]
  const doubles: number[] = []

  const record = event as unknown as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((k) => k !== 'event_type')
    .sort()

  for (const key of keys) {
    const value = record[key]
    // Validation already rejects null and undefined; this guard
    // keeps the function safe if it's ever called from a path that
    // bypasses validation.
    if (value === null || value === undefined) continue
    const t = typeof value
    if (t === 'string') {
      blobs.push(value as string)
    } else if (t === 'number') {
      doubles.push(value as number)
    } else if (t === 'boolean') {
      blobs.push(value ? 'true' : 'false')
    }
    // Arrays / objects are rejected at validation; nothing to do here.
  }

  // AE caps at 20 blobs and 20 doubles per datapoint. Truncate if
  // ever approached — the schema is designed to stay well under.
  return {
    blobs: blobs.slice(0, 20),
    doubles: doubles.slice(0, 20),
    indexes: [sessionId],
  }
}

// --- Helpers ---

function jsonError(
  message: string,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// --- Handlers ---

export const onRequestOptions: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin')
  if (!isAllowedOrigin(origin, context.request.url)) {
    return new Response(null, { status: 403 })
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const request = context.request
  const origin = request.headers.get('Origin')
  if (!isAllowedOrigin(origin, request.url)) {
    return new Response(null, { status: 403 })
  }
  const cors = corsHeaders(origin)

  // Kill switch — cheapest check first so a flipped switch sheds
  // load without spending any parsing effort.
  if (await isKillSwitchOn(context.env)) {
    return new Response(null, {
      status: 410,
      headers: { ...cors, 'Retry-After': '300' },
    })
  }

  // Content-Length guard — reject oversized bodies before reading.
  const contentLength = request.headers.get('Content-Length')
  if (contentLength) {
    const n = parseInt(contentLength, 10)
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return jsonError('payload too large', 413, cors)
    }
  }

  // Per-IP rate limit.
  const ip = request.headers.get('CF-Connecting-IP')
  if (ip && isRateLimited(ipRate, ip, RATE_LIMIT_PER_IP)) {
    return jsonError('rate limit (ip)', 429, cors)
  }

  // Parse body.
  let text: string
  try {
    text = await request.text()
  } catch {
    return jsonError('read error', 400, cors)
  }
  if (text.length > MAX_BODY_BYTES) {
    return jsonError('payload too large', 413, cors)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return jsonError('invalid json', 400, cors)
  }
  if (!isValidBody(body)) {
    return jsonError('invalid body', 400, cors)
  }

  // Per-session rate limit (after parse — need the session_id).
  if (isRateLimited(sessionRate, body.session_id, RATE_LIMIT_PER_SESSION)) {
    return jsonError('rate limit (session)', 429, cors)
  }

  // Write to Analytics Engine. If the binding is missing (local dev
  // without the binding configured), accept and discard — the
  // 204 response lets the client's success path run unchanged.
  const environment = environmentOf(context.env)
  // `CF-IPCountry` is set by Cloudflare's edge from the connecting
  // IP's GeoIP lookup. Never reading the raw IP for analytics; this
  // header is the only geo-derived signal we store. Absent / Tor
  // requests map to `'XX'` so dashboards don't show a synthetic value.
  const country = countryOf(request.headers.get('CF-IPCountry'))
  // Presence-only check for Cloudflare Access identity. When an
  // Access policy sits in front of /api/ingest (mixed-mode — public
  // traffic passes through, staff traffic carries the SSO header),
  // this derives a `true`/`false` tag without reading the email.
  // The email and JWT are trusted only because Cloudflare's edge
  // strips forged versions before they hit the function.
  const internal = isInternalRequest(request)
  const ae = context.env.ANALYTICS
  if (ae) {
    for (const event of body.events) {
      try {
        ae.writeDataPoint(
          toDataPoint(event, body.session_id, environment, country, internal),
        )
      } catch {
        // One bad datapoint should not fail the whole batch.
      }
    }
  }

  return new Response(null, { status: 204, headers: cors })
}
