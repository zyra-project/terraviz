/**
 * Cloudflare Pages Function — /api/general-feedback-export
 *
 * CSV export of the general_feedback table (bug reports, feature
 * requests, other). Companion to /api/feedback-export which ships
 * JSONL for RLHF training data on the AI feedback table.
 *
 * Auth: Cloudflare Access at the edge (preferred); legacy
 * `FEEDBACK_ADMIN_TOKEN` bearer-token path kept as a fallback
 * for `wrangler dev` and break-glass.
 *
 * The web admin UI no longer calls this path directly — the
 * dashboard at `/api/feedback-admin` proxies the same export
 * via `?action=general-export` so a single Access destination
 * covers every admin operation. This route remains for direct
 * scripting and break-glass.
 *
 * GET /api/general-feedback-export
 *   ?since=ISO_DATE       — only entries after this date
 *   ?kind=bug|feature|other — filter by kind
 *   ?limit=10000          — max entries (default 10000, max 50000)
 *
 * The screenshot column is NOT included in the CSV — data URLs would
 * bloat the file and aren't useful in a spreadsheet anyway. Instead,
 * a boolean has_screenshot column and a screenshot_bytes column are
 * emitted so reviewers can tell which rows have a screenshot attached
 * and drill into them via the dashboard if needed. screenshot_bytes
 * is an estimate of the decoded image byte size, not the length of
 * the base64 data URL string.
 */

import { isInternalRequest } from './ingest'
import { streamGeneralExport } from './_feedback-helpers'

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
  const kind = url.searchParams.get('kind')
  const limit = parseInt(url.searchParams.get('limit') ?? '10000') || 10000

  try {
    const stream = await streamGeneralExport(db, { since, kind, limit })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="general-feedback-export-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    })
  } catch (err) {
    console.error('General feedback export query failed:', err)
    return new Response(JSON.stringify({ error: 'Export failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
