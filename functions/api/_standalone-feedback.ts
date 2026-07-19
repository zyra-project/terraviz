/**
 * Cloudflare Pages Function helpers — standalone-widget feedback.
 *
 * The standalone TerraViz HTML build ships an in-app feedback widget
 * that POSTs to `/api/feedback` with a body shaped nothing like the
 * Orbit AI thumbs payload that route was built for:
 *
 *   { source: "terraviz-standalone", type: "bug"|"idea"|"content",
 *     rating: 1–5|null, text, name|null, email|null,
 *     meta: { …app-state snapshot }, screenshot: data:image/png|null }
 *
 * `functions/api/feedback.ts` dispatches on that shape (see
 * `isStandaloneFeedbackBody`) and hands matching requests here.
 * Everything else about the AI-thumbs path is untouched.
 *
 * Differences from the sibling feedback routes, all deliberate:
 *
 * - CORS is `*` and no Origin header is required — the widget also
 *   runs from `file://` and arbitrary origins via
 *   `window.TERRAVIZ_FEEDBACK_URL`, and plain curl must work.
 * - Screenshots are multi-MB PNGs; the binary is decoded and stored
 *   in R2 (`CATALOG_R2`, the bucket the catalog assets already use)
 *   and only the object key lands in D1 — never base64 in a row.
 * - The client falls back to a mailto: draft on any non-2xx, so
 *   storage failures return an honest 5xx instead of soft-accepting.
 *
 * Rows land in `general_feedback` with `status: 'new'`, the same
 * queue the Publisher Portal's Feedback → General tab reviews.
 */

import { getEffectiveFeatures } from './v1/_lib/node-settings-store'

export interface StandaloneFeedbackEnv {
  FEEDBACK_DB?: D1Database
  CATALOG_R2?: R2Bucket
  /** Catalog bindings — read-only here, for the per-node feature
   *  toggles (`node_settings`). Optional like everything else. */
  CATALOG_DB?: D1Database
  CATALOG_KV?: KVNamespace
}

export const STANDALONE_FEEDBACK_SOURCE = 'terraviz-standalone'

const TYPES = ['bug', 'idea', 'content'] as const
type StandaloneType = (typeof TYPES)[number]

export interface StandaloneFeedbackBody {
  source?: string
  type: StandaloneType
  rating?: number | null
  text: string
  name?: string | null
  email?: string | null
  meta?: Record<string, unknown> | null
  screenshot?: string | null
}

// --- Limits ---

/** Whole-request cap (~12 MB) — a PNG screenshot base64-encodes to
 *  ~1.37× its binary size, so this admits the widget's stated
 *  0.5–8 MB screenshots with headroom. Enforced in feedback.ts
 *  before the JSON parse. */
export const MAX_STANDALONE_BODY_BYTES = 12_500_000
const MAX_TEXT = 5000
const MAX_NAME = 200
const MAX_EMAIL = 200
const MAX_SOURCE = 64
const MAX_META_KEYS = 32
const MAX_META_VALUE = 1000
const MAX_META_JSON = 16_000
const MAX_SCREENSHOT_BYTES = 9_000_000
const MAX_UA = 500
const MAX_DATASET = 300

// --- Rate limiting (in-memory, per-isolate, same pattern as the
// sibling feedback routes). Internal reviewers only — 10/hour is
// generous for legitimate use. ---

const RATE_LIMIT = 10
const RATE_WINDOW_MS = 3_600_000

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    if (rateLimitMap.size > 1000) {
      for (const [key, val] of rateLimitMap) {
        if (now > val.resetAt) rateLimitMap.delete(key)
      }
    }
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT
}

// --- CORS ---

/** Wildcard CORS for this one payload shape: the widget legitimately
 *  posts from any origin (or none). No credentials are involved. */
export function standaloneCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

// --- Shape detection + validation ---

/**
 * Distinguish a standalone-widget submission from the Orbit AI thumbs
 * payload sharing the route. The AI shape carries `rating:
 * 'thumbs-up'|'thumbs-down'` + `messageId` and never `type`/`text`;
 * the widget always sends its `source` marker plus `type` + `text`.
 */
export function isStandaloneFeedbackBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (b.source === STANDALONE_FEEDBACK_SOURCE) return true
  return typeof b.type === 'string' && (TYPES as readonly string[]).includes(b.type)
    && typeof b.text === 'string'
}

function validationError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object'
  const b = body as Record<string, unknown>
  if (typeof b.type !== 'string' || !(TYPES as readonly string[]).includes(b.type)) {
    return `type must be one of: ${TYPES.join(', ')}`
  }
  if (typeof b.text !== 'string' || b.text.trim().length === 0) return 'text is required'
  if (b.text.length > MAX_TEXT) return `text must be at most ${MAX_TEXT} characters`
  if (b.rating !== undefined && b.rating !== null
    && (typeof b.rating !== 'number' || !Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5)) {
    return 'rating must be an integer 1-5 or null'
  }
  if (b.name !== undefined && b.name !== null && typeof b.name !== 'string') return 'name must be a string or null'
  if (b.email !== undefined && b.email !== null && typeof b.email !== 'string') return 'email must be a string or null'
  if (b.meta !== undefined && b.meta !== null && (typeof b.meta !== 'object' || Array.isArray(b.meta))) {
    return 'meta must be an object'
  }
  if (b.screenshot !== undefined && b.screenshot !== null && typeof b.screenshot !== 'string') {
    return 'screenshot must be a data URL string or null'
  }
  return null
}

/** Keep only shallow scalar meta values, bounded in count, per-value
 *  length, and total serialized size — the snapshot is display data
 *  for the portal's "App state" section, not a schema contract. */
function sanitizeMeta(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return ''
  const out: Record<string, string | number | boolean> = {}
  let keys = 0
  for (const [key, value] of Object.entries(meta)) {
    if (keys >= MAX_META_KEYS) break
    if (typeof value === 'string') out[key.slice(0, 64)] = value.slice(0, MAX_META_VALUE)
    else if (typeof value === 'number' && Number.isFinite(value)) out[key.slice(0, 64)] = value
    else if (typeof value === 'boolean') out[key.slice(0, 64)] = value
    else continue
    keys++
  }
  const json = JSON.stringify(out)
  return json === '{}' || json.length > MAX_META_JSON ? '' : json
}

// --- Screenshot ---

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_PREFIX = 'data:image/png;base64,'

/** Decode a `data:image/png;base64,` URL and verify the PNG magic
 *  bytes. Returns null on anything malformed. */
export function decodePngDataUrl(dataUrl: string): Uint8Array | null {
  if (!dataUrl.startsWith(PNG_PREFIX)) return null
  let binary: string
  try {
    binary = atob(dataUrl.slice(PNG_PREFIX.length))
  } catch {
    return null
  }
  if (binary.length < PNG_MAGIC.length) return null
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return null
  }
  return bytes
}

// --- Handler ---

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...standaloneCorsHeaders(), 'Content-Type': 'application/json' },
  })
}

/**
 * Handle a standalone-widget submission. `body` is the already-parsed
 * JSON (feedback.ts owns the raw-body size cap and parse).
 */
export async function handleStandaloneFeedback(
  context: EventContext<StandaloneFeedbackEnv, string, Record<string, unknown>>,
  body: unknown,
): Promise<Response> {
  const ip = context.request.headers.get('CF-Connecting-IP')
  if (ip && isRateLimited(ip)) {
    return json(429, { error: 'Rate limit exceeded. Try again later.' })
  }

  const error = validationError(body)
  if (error) return json(400, { error })
  const b = body as StandaloneFeedbackBody

  // Feature gate — mirrors the sibling routes: feedback off means
  // soft-accept and drop, so the widget never falls back to mailto
  // on a node that has deliberately turned reviewing off.
  if (!(await getEffectiveFeatures(context.env)).feedback) {
    return json(200, { ok: true, id: null })
  }

  // The client honestly falls back to mailto on non-2xx, so a
  // deployment without the D1 binding must not pretend to store.
  const db = context.env.FEEDBACK_DB
  if (!db) {
    console.error('standalone feedback: FEEDBACK_DB binding missing')
    return json(503, { error: 'Feedback storage is not configured' })
  }

  // Screenshot → R2 binary. A malformed data URL is a client bug and
  // fails honestly; a missing R2 binding or a failed put degrades to
  // storing the report without its screenshot (the text is the
  // valuable part, and mailto would lose it entirely).
  let screenshotKey = ''
  if (b.screenshot) {
    const bytes = decodePngDataUrl(b.screenshot)
    if (!bytes) return json(400, { error: 'screenshot must be a data:image/png;base64 URL' })
    if (bytes.length > MAX_SCREENSHOT_BYTES) return json(413, { error: 'Screenshot too large' })
    const r2 = context.env.CATALOG_R2
    if (r2) {
      const key = `feedback/screenshots/${crypto.randomUUID()}.png`
      try {
        await r2.put(key, bytes, { httpMetadata: { contentType: 'image/png' } })
        screenshotKey = key
      } catch (err) {
        console.error('standalone feedback: R2 screenshot put failed:', err)
      }
    } else {
      console.error('standalone feedback: CATALOG_R2 binding missing, dropping screenshot')
    }
  }

  const meta = (b.meta && typeof b.meta === 'object') ? b.meta as Record<string, unknown> : null
  const metaUa = typeof meta?.ua === 'string' ? meta.ua : ''
  const dataset = typeof meta?.dataset === 'string' ? meta.dataset.slice(0, MAX_DATASET) : null

  try {
    const result = await db.prepare(
      `INSERT INTO general_feedback (
         kind, message, contact, url, user_agent, app_version, platform,
         dataset_id, screenshot, created_at,
         source, rating, reporter_name, meta, screenshot_r2_key, status, country
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      b.type,
      b.text.trim().slice(0, MAX_TEXT),
      (b.email ?? '').trim().slice(0, MAX_EMAIL),
      '',
      (context.request.headers.get('User-Agent') ?? metaUa).slice(0, MAX_UA),
      '',
      '',
      dataset,
      '',
      new Date().toISOString(),
      (b.source ?? STANDALONE_FEEDBACK_SOURCE).slice(0, MAX_SOURCE),
      b.rating ?? null,
      (b.name ?? '').trim().slice(0, MAX_NAME),
      sanitizeMeta(meta),
      screenshotKey,
      'new',
      context.request.headers.get('CF-IPCountry') ?? '',
    ).run()
    return json(200, { ok: true, id: String(result.meta.last_row_id) })
  } catch (err) {
    console.error('standalone feedback: D1 insert failed:', err)
    return json(500, { error: 'Failed to store feedback' })
  }
}
