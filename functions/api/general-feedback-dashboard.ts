/**
 * Cloudflare Pages Function — /api/general-feedback-dashboard
 *
 * Admin endpoint for viewing general feedback summary stats
 * (bug reports, feature requests, other). Sibling to
 * /api/feedback-dashboard which covers the AI response ratings.
 *
 * Auth: Cloudflare Access at the edge (preferred). Sign-in
 * happens once per session via the Access policy on this path;
 * the function reads `Cf-Access-Authenticated-User-Email` to
 * confirm staff identity. The legacy `FEEDBACK_ADMIN_TOKEN`
 * bearer-token path is kept as an optional fallback for
 * `wrangler dev` (where Access doesn't run) and as break-glass
 * if the Access policy is ever misconfigured. Removing the env
 * var disables the bearer path entirely.
 *
 * GET /api/general-feedback-dashboard
 *   ?days=30    — lookback window (default 30, max 365)
 *   ?recent=100 — number of recent entries (default 100, max 200)
 */

import { isInternalRequest } from './ingest'

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
  // Cloudflare Access — production path. The edge attaches the
  // SSO identity header on requests that match the Access policy.
  if (isInternalRequest(request)) return true
  // Bearer token — local-dev / break-glass fallback. Only enabled
  // when FEEDBACK_ADMIN_TOKEN is set in env. Removing the env var
  // makes Access the only auth path.
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
  const recentLimit = Math.min(Math.max(parseInt(url.searchParams.get('recent') ?? '100') || 100, 1), 200)

  try {
    // Totals by kind
    const totals = await db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN kind = 'bug' THEN 1 ELSE 0 END) as bugs,
        SUM(CASE WHEN kind = 'feature' THEN 1 ELSE 0 END) as features,
        SUM(CASE WHEN kind = 'other' THEN 1 ELSE 0 END) as other
      FROM general_feedback`,
    ).first<{ total: number; bugs: number; features: number; other: number }>()

    // Submissions by day over the lookback window
    const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString()
    const byDay = await db.prepare(
      `SELECT
        DATE(created_at) as date,
        SUM(CASE WHEN kind = 'bug' THEN 1 ELSE 0 END) as bugs,
        SUM(CASE WHEN kind = 'feature' THEN 1 ELSE 0 END) as features,
        SUM(CASE WHEN kind = 'other' THEN 1 ELSE 0 END) as other
      FROM general_feedback
      WHERE created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY date DESC`,
    ).bind(sinceDate).all<{ date: string; bugs: number; features: number; other: number }>()

    // Recent entries — the screenshot column is intentionally NOT
    // selected here. Data URLs can be up to 200KB each, so inlining
    // them in a 100-row list response can produce multi-megabyte
    // payloads. The admin UI fetches screenshots on demand via
    // /api/general-feedback-screenshot?id=X when the user opens a
    // detail panel. Report length()+presence instead so reviewers
    // can still see which rows have an image attached.
    const recent = await db.prepare(
      `SELECT id, kind, message, contact, url, user_agent, app_version,
              platform, dataset_id, created_at,
              length(screenshot) as screenshot_length
      FROM general_feedback
      ORDER BY created_at DESC
      LIMIT ?`,
    ).bind(recentLimit).all<{
      id: number
      kind: string
      message: string
      contact: string
      url: string
      user_agent: string
      app_version: string
      platform: string
      dataset_id: string | null
      created_at: string
      screenshot_length: number
    }>()

    return new Response(JSON.stringify({
      totalCount: totals?.total ?? 0,
      bugCount: totals?.bugs ?? 0,
      featureCount: totals?.features ?? 0,
      otherCount: totals?.other ?? 0,
      byDay: byDay.results,
      recentFeedback: recent.results.map(r => {
        const { screenshot_length, ...rest } = r
        return {
          ...rest,
          hasScreenshot: (screenshot_length ?? 0) > 0,
          screenshotLength: screenshot_length ?? 0,
        }
      }),
    }), { headers: jsonHeaders })
  } catch (err) {
    console.error('General feedback dashboard query failed:', err)
    return new Response(JSON.stringify({ error: 'Query failed' }), {
      status: 500,
      headers: jsonHeaders,
    })
  }
}
