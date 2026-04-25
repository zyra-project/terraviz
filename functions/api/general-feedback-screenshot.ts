/**
 * Cloudflare Pages Function — /api/general-feedback-screenshot
 *
 * Returns the screenshot data URL for a single general_feedback row.
 * Kept separate from the dashboard list response so the list stays
 * small — screenshots are fetched on demand when an admin opens a
 * detail panel.
 *
 * Auth: Cloudflare Access at the edge (preferred); legacy
 * `FEEDBACK_ADMIN_TOKEN` bearer-token path kept as a fallback
 * for `wrangler dev` and break-glass.
 *
 * The web admin UI no longer calls this path directly — the
 * dashboard at `/api/feedback-admin` proxies the same payload
 * via `?action=screenshot&id=N` so a single Access destination
 * covers every admin operation. This route remains for direct
 * scripting and break-glass.
 *
 * GET /api/general-feedback-screenshot?id=123
 */

import { isInternalRequest } from './ingest'
import { fetchScreenshot } from './_feedback-helpers'

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

export const onRequestGet: PagesFunction<Env> = async (context) => {
  if (!authenticate(context.request, context.env.FEEDBACK_ADMIN_TOKEN)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const db = context.env.FEEDBACK_DB
  if (!db) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const url = new URL(context.request.url)
  const idParam = url.searchParams.get('id')
  const id = idParam ? parseInt(idParam, 10) : NaN
  if (!Number.isFinite(id) || id <= 0) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const result = await fetchScreenshot(db, id)
    if (!result) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('general-feedback-screenshot query failed:', err)
    return new Response(JSON.stringify({ error: 'Query failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
