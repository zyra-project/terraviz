/**
 * Cloudflare Pages Function — /api/feedback-dashboard
 *
 * Admin endpoint for viewing AI feedback summary stats.
 *
 * Auth: Cloudflare Access at the edge (preferred); legacy
 * `FEEDBACK_ADMIN_TOKEN` bearer-token path kept as a fallback
 * for `wrangler dev` and break-glass.
 *
 * The web admin UI no longer calls this path directly — the
 * dashboard at `/api/feedback-admin` proxies the same data via
 * `?action=ai-dashboard` so a single Access destination covers
 * every admin operation. This route remains for direct
 * scripting (CI exports, ad-hoc curl checks under the bearer
 * fallback) and as a break-glass path.
 *
 * GET /api/feedback-dashboard
 *   ?days=30    — lookback window (default 30, max 365)
 *   ?recent=50  — number of recent entries (default 50, max 200)
 */

import { isInternalRequest } from './ingest'
import { fetchAiDashboard } from './_feedback-helpers'

interface Env {
  FEEDBACK_DB?: D1Database
  FEEDBACK_ADMIN_TOKEN?: string
}

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  }
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

function authenticate(request: Request, token?: string): boolean {
  if (isInternalRequest(request)) return true
  if (!token) return false
  const auth = request.headers.get('Authorization')
  if (!auth) return false
  const bearer = auth.replace(/^Bearer\s+/i, '')
  return bearer === token
}

export const onRequestOptions: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin')
  if (!isAllowedOrigin(origin, context.request.url)) {
    return new Response(null, { status: 403 })
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin')
  const allowedOrigin = isAllowedOrigin(origin, context.request.url) ? origin : null
  const cors = corsHeaders(allowedOrigin)
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json' }

  if (!authenticate(context.request, context.env.FEEDBACK_ADMIN_TOKEN)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: jsonHeaders,
    })
  }

  const db = context.env.FEEDBACK_DB
  if (!db) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 503,
      headers: jsonHeaders,
    })
  }

  const url = new URL(context.request.url)
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30') || 30, 1), 365)
  const recentLimit = Math.min(Math.max(parseInt(url.searchParams.get('recent') ?? '50') || 50, 1), 200)

  try {
    const data = await fetchAiDashboard(db, days, recentLimit)
    return new Response(JSON.stringify(data), { headers: jsonHeaders })
  } catch (err) {
    console.error('Dashboard query failed:', err)
    return new Response(JSON.stringify({ error: 'Query failed' }), {
      status: 500,
      headers: jsonHeaders,
    })
  }
}
