/**
 * Cloudflare Pages Function — /api/feedback-export
 *
 * Streams feedback as JSONL for RLHF training data extraction.
 *
 * Auth: Cloudflare Access at the edge (preferred); legacy
 * `FEEDBACK_ADMIN_TOKEN` bearer-token path kept as a fallback
 * for `wrangler dev` and break-glass.
 *
 * The web admin UI no longer calls this path directly — the
 * dashboard at `/api/feedback-admin` proxies the same export
 * via `?action=ai-export` so a single Access destination covers
 * every admin operation. This route remains for direct
 * scripting (CI exports, ad-hoc curl checks) and break-glass.
 *
 * GET /api/feedback-export
 *   ?since=ISO_DATE       — only entries after this date
 *   ?rating=thumbs-up     — filter by rating (thumbs-up or thumbs-down)
 *   ?limit=1000           — max entries (default 1000, max 10000)
 *   ?include_prompt=true  — include full system prompt (default false, saves bandwidth)
 */

import { isInternalRequest } from './ingest'
import { streamAiExport } from './_feedback-helpers'

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
  const since = url.searchParams.get('since')
  const rating = url.searchParams.get('rating')
  const includePrompt = url.searchParams.get('include_prompt') === 'true'
  const limit = parseInt(url.searchParams.get('limit') ?? '1000') || 1000

  try {
    const stream = await streamAiExport(db, { since, rating, includePrompt, limit })
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/jsonl',
        'Content-Disposition': `attachment; filename="feedback-export-${new Date().toISOString().slice(0, 10)}.jsonl"`,
      },
    })
  } catch (err) {
    console.error('Export query failed:', err)
    return new Response(JSON.stringify({ error: 'Export failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
