/**
 * Cloudflare Pages Function — /api/feedback-admin
 *
 * Machine interface for feedback data. The browser dashboard this
 * endpoint used to serve was replaced by the portal's
 * `/publish/feedback` tab (Phase C of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`) — a bare GET now
 * 302-redirects there. The `?action=` data operations survive
 * unchanged: they're the scripting surface (CSV/JSONL exports,
 * dashboards-as-JSON) with the bearer-token fallback that forks
 * without Cloudflare Access rely on, and the portal links out to
 * the export actions.
 *
 *   GET /api/feedback-admin                            → 302 → /publish/feedback
 *   GET /api/feedback-admin?action=ai-dashboard        → JSON
 *   GET /api/feedback-admin?action=general-dashboard   → JSON
 *   GET /api/feedback-admin?action=ai-export           → JSONL
 *   GET /api/feedback-admin?action=general-export      → CSV
 *   GET /api/feedback-admin?action=screenshot&id=N     → JSON
 */

import { isInternalRequest } from './ingest'
import {
  fetchAiDashboard,
  fetchGeneralDashboard,
  fetchScreenshot,
  streamAiExport,
  streamGeneralExport,
} from './_feedback-helpers'

interface Env {
  FEEDBACK_DB?: D1Database
  FEEDBACK_ADMIN_TOKEN?: string
}

function authenticate(request: Request, token?: string): boolean {
  if (isInternalRequest(request)) return true
  if (!token) return false
  const auth = request.headers.get('Authorization')
  if (!auth) return false
  const bearer = auth.replace(/^Bearer\s+/i, '')
  return bearer === token
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS,
  })
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  const action = url.searchParams.get('action')

  // Treat the param as "present" the moment it appears in the URL,
  // even if blank — so `?action=` 400s rather than silently
  // redirecting a data request the caller mistyped.
  if (action !== null) {
    return handleAction(context, action, url)
  }

  // The HTML dashboard moved into the publisher portal — same data,
  // real auth surface, one admin UI. Permanent enough to bookmark,
  // but 302 (not 301) so the redirect stays revisitable if the
  // portal route ever moves again.
  return Response.redirect(new URL('/publish/feedback', url.origin).toString(), 302)
}

async function handleAction(
  context: EventContext<Env, string, unknown>,
  action: string,
  url: URL,
): Promise<Response> {
  if (!authenticate(context.request, context.env.FEEDBACK_ADMIN_TOKEN)) {
    return jsonError('Unauthorized', 401)
  }

  const db = context.env.FEEDBACK_DB
  if (!db) {
    return jsonError('Database not configured', 503)
  }

  try {
    switch (action) {
      case 'ai-dashboard': {
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30') || 30, 1), 365)
        const recent = Math.min(Math.max(parseInt(url.searchParams.get('recent') ?? '50') || 50, 1), 200)
        const data = await fetchAiDashboard(db, days, recent)
        return new Response(JSON.stringify(data), { headers: JSON_HEADERS })
      }
      case 'general-dashboard': {
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30') || 30, 1), 365)
        const recent = Math.min(Math.max(parseInt(url.searchParams.get('recent') ?? '100') || 100, 1), 200)
        const data = await fetchGeneralDashboard(db, days, recent)
        return new Response(JSON.stringify(data), { headers: JSON_HEADERS })
      }
      case 'ai-export': {
        const since = url.searchParams.get('since')
        const rating = url.searchParams.get('rating')
        const includePrompt = url.searchParams.get('include_prompt') === 'true'
        const limit = parseInt(url.searchParams.get('limit') ?? '1000') || 1000
        const stream = await streamAiExport(db, { since, rating, includePrompt, limit })
        return new Response(stream, {
          headers: {
            'Content-Type': 'application/jsonl',
            'Content-Disposition': `attachment; filename="feedback-export-${new Date().toISOString().slice(0, 10)}.jsonl"`,
          },
        })
      }
      case 'general-export': {
        const since = url.searchParams.get('since')
        const kind = url.searchParams.get('kind')
        const limit = parseInt(url.searchParams.get('limit') ?? '10000') || 10000
        const stream = await streamGeneralExport(db, { since, kind, limit })
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="general-feedback-export-${new Date().toISOString().slice(0, 10)}.csv"`,
          },
        })
      }
      case 'screenshot': {
        const idParam = url.searchParams.get('id')
        const id = idParam ? parseInt(idParam, 10) : NaN
        if (!Number.isFinite(id) || id <= 0) {
          return jsonError('Invalid id', 400)
        }
        const result = await fetchScreenshot(db, id)
        if (!result) return jsonError('Not found', 404)
        return new Response(JSON.stringify(result), { headers: JSON_HEADERS })
      }
      default:
        return jsonError('Unknown action', 400)
    }
  } catch (err) {
    console.error(`feedback-admin action=${action} failed:`, err)
    return jsonError('Query failed', 500)
  }
}
