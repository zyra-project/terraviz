/**
 * Cloudflare Pages Function — /api/general-feedback-export
 *
 * CSV export of the general_feedback table (bug reports, feature
 * requests, other). Companion to /api/feedback-export which ships
 * JSONL for RLHF training data on the AI feedback table.
 *
 * Auth: Cloudflare Access at the edge (preferred); legacy
 * `FEEDBACK_ADMIN_TOKEN` bearer-token path kept as a fallback
 * for `wrangler dev` and break-glass. See
 * `general-feedback-dashboard.ts` for the full notes.
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

/**
 * Estimate the decoded byte size of a base64 data URL. The JS string
 * length counts characters, not bytes — and base64 encodes 3 bytes
 * per 4 characters of payload. Strip the `data:...;base64,` prefix
 * first so we only count the encoded payload.
 */
function estimateDataUrlBytes(dataUrl: string): number {
  if (!dataUrl) return 0
  const commaIdx = dataUrl.indexOf(',')
  const payload = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl
  // Each '=' padding char represents 1 fewer decoded byte.
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

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

/**
 * Escape a value for inclusion in a CSV cell per RFC 4180:
 * if the value contains a comma, double-quote, or line break, wrap
 * it in double quotes and double up any embedded double quotes.
 */
function csvEscape(value: unknown): string {
  if (value == null) return ''
  const s = String(value)
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
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
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '10000') || 10000, 1), 50_000)

  const conditions: string[] = []
  const bindings: unknown[] = []

  if (since) {
    conditions.push('created_at >= ?')
    bindings.push(since)
  }
  if (kind === 'bug' || kind === 'feature' || kind === 'other') {
    conditions.push('kind = ?')
    bindings.push(kind)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    // Select everything we need to produce CSV columns. We still pull
    // the screenshot so we can emit its length without an extra query —
    // but we drop it before writing the row to the output stream.
    const stmt = db.prepare(
      `SELECT id, kind, message, contact, url, user_agent, app_version,
              platform, dataset_id, screenshot, created_at
      FROM general_feedback
      ${where}
      ORDER BY created_at ASC
      LIMIT ?`,
    )
    bindings.push(limit)
    const result = await stmt.bind(...bindings).all<{
      id: number
      kind: string
      message: string
      contact: string
      url: string
      user_agent: string
      app_version: string
      platform: string
      dataset_id: string | null
      screenshot: string
      created_at: string
    }>()

    const encoder = new TextEncoder()
    const rows = result.results
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const header = [
          'id',
          'kind',
          'created_at',
          'platform',
          'dataset_id',
          'url',
          'contact',
          'app_version',
          'user_agent',
          'has_screenshot',
          'screenshot_bytes',
          'message',
        ].join(',') + '\r\n'
        controller.enqueue(encoder.encode(header))

        for (const row of rows) {
          const hasScreenshot = !!row.screenshot
          const screenshotBytes = hasScreenshot ? estimateDataUrlBytes(row.screenshot) : 0
          const line = [
            csvEscape(row.id),
            csvEscape(row.kind),
            csvEscape(row.created_at),
            csvEscape(row.platform),
            csvEscape(row.dataset_id ?? ''),
            csvEscape(row.url),
            csvEscape(row.contact),
            csvEscape(row.app_version),
            csvEscape(row.user_agent),
            csvEscape(hasScreenshot ? 'true' : 'false'),
            csvEscape(screenshotBytes),
            csvEscape(row.message),
          ].join(',') + '\r\n'
          controller.enqueue(encoder.encode(line))
        }
        controller.close()
      },
    })

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
