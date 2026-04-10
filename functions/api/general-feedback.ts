/**
 * Cloudflare Pages Function — /api/general-feedback
 *
 * Accepts app-level feedback (bug reports, feature requests, other).
 * Persisted to the general_feedback D1 table — a sibling to the AI
 * response feedback table with a different row shape.
 *
 * POST /api/general-feedback — JSON body matching GeneralFeedbackBody
 */

interface Env {
  FEEDBACK_DB?: D1Database
}

type Kind = 'bug' | 'feature' | 'other'

interface GeneralFeedbackBody {
  kind: Kind
  message: string
  contact?: string
  url?: string
  appVersion?: string
  platform?: 'web' | 'desktop'
  datasetId?: string | null
  screenshot?: string
}

// --- Limits ---

const MAX_MESSAGE = 2000
const MAX_CONTACT = 200
const MAX_URL = 500
const MAX_UA = 500
const MAX_APP_VERSION = 64
const MAX_SCREENSHOT = 200_000 // ~200KB data URL

// --- Rate limiting (in-memory, per-isolate) ---

const RATE_LIMIT = 5
const RATE_WINDOW_MS = 60_000

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

const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:4173',
])

function isAllowedOrigin(origin: string | null, requestUrl: string): boolean {
  if (!origin) return false
  if (ALLOWED_ORIGINS.has(origin)) return true
  try {
    const req = new URL(requestUrl)
    return origin === req.origin
  } catch {
    return false
  }
}

function corsHeaders(origin?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

// --- Validation ---

function isValidBody(body: unknown): body is GeneralFeedbackBody {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (b.kind !== 'bug' && b.kind !== 'feature' && b.kind !== 'other') return false
  if (typeof b.message !== 'string' || b.message.trim().length === 0) return false
  if (b.contact !== undefined && typeof b.contact !== 'string') return false
  if (b.url !== undefined && typeof b.url !== 'string') return false
  if (b.appVersion !== undefined && typeof b.appVersion !== 'string') return false
  if (b.platform !== undefined && b.platform !== 'web' && b.platform !== 'desktop') return false
  if (b.datasetId !== undefined && b.datasetId !== null && typeof b.datasetId !== 'string') return false
  if (b.screenshot !== undefined && typeof b.screenshot !== 'string') return false
  return true
}

function isValidDataUrl(s: string): boolean {
  return /^data:image\/(jpeg|png|webp);base64,/.test(s)
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
  const origin = context.request.headers.get('Origin')
  if (!origin || !isAllowedOrigin(origin, context.request.url)) {
    return new Response(null, { status: 403 })
  }
  const cors = corsHeaders(origin)
  const ip = context.request.headers.get('CF-Connecting-IP')

  if (ip && isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again shortly.' }), {
      status: 429,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (!isValidBody(body)) {
    return new Response(JSON.stringify({ error: 'Invalid feedback payload' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Normalize and cap all fields
  const message = body.message.trim().slice(0, MAX_MESSAGE)
  const contact = (body.contact ?? '').trim().slice(0, MAX_CONTACT)
  const url = (body.url ?? '').slice(0, MAX_URL)
  const appVersion = (body.appVersion ?? '').slice(0, MAX_APP_VERSION)
  const platform = body.platform ?? 'web'
  const datasetId = body.datasetId ?? null
  const userAgent = (context.request.headers.get('User-Agent') ?? '').slice(0, MAX_UA)

  let screenshot = ''
  if (body.screenshot) {
    if (body.screenshot.length > MAX_SCREENSHOT) {
      return new Response(JSON.stringify({ error: 'Screenshot too large' }), {
        status: 413,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    if (!isValidDataUrl(body.screenshot)) {
      return new Response(JSON.stringify({ error: 'Invalid screenshot data URL' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    screenshot = body.screenshot
  }

  // Store in D1 if binding is available, otherwise log
  const db = context.env.FEEDBACK_DB
  if (db) {
    try {
      await db.prepare(
        `INSERT INTO general_feedback (kind, message, contact, url, user_agent, app_version, platform, dataset_id, screenshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        body.kind,
        message,
        contact,
        url,
        userAgent,
        appVersion,
        platform,
        datasetId,
        screenshot,
        new Date().toISOString(),
      ).run()
    } catch (err) {
      console.error('Failed to write general_feedback to D1:', err)
      return new Response(JSON.stringify({ error: 'Failed to store feedback' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  } else {
    // No D1 binding — log for Cloudflare Workers tail/dashboard
    console.log('[general-feedback]', JSON.stringify({
      kind: body.kind,
      message: message.slice(0, 500),
      hasContact: contact.length > 0,
      url,
      appVersion,
      platform,
      datasetId,
      hasScreenshot: screenshot.length > 0,
    }))
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
