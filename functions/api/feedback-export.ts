/**
 * Cloudflare Pages Function — /api/feedback-export
 *
 * Streams feedback as JSONL for RLHF training data extraction.
 *
 * Auth: Cloudflare Access at the edge (preferred); legacy
 * `FEEDBACK_ADMIN_TOKEN` bearer-token path kept as a fallback
 * for `wrangler dev` and break-glass. See
 * `general-feedback-dashboard.ts` for the full notes.
 *
 * GET /api/feedback-export
 *   ?since=ISO_DATE       — only entries after this date
 *   ?rating=thumbs-up     — filter by rating (thumbs-up or thumbs-down)
 *   ?limit=1000           — max entries (default 1000, max 10000)
 *   ?include_prompt=true  — include full system prompt (default false, saves bandwidth)
 *
 * Each line is a JSON object:
 * {
 *   "system": "...",           // system prompt (if include_prompt=true)
 *   "user": "...",             // user message that triggered the response
 *   "assistant": "...",        // the rated AI response
 *   "rating": "thumbs-up",
 *   "tags": ["..."],
 *   "comment": "...",
 *   "model": "...",
 *   "dataset_id": "...",
 *   "turn_index": 0,
 *   "is_fallback": false,
 *   "history_compressed": false,
 *   "action_clicks": ["..."],
 *   "timestamp": "..."
 * }
 */

import { isInternalRequest } from './ingest'

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
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '1000') || 1000, 1), 10_000)

  // Build query with optional filters
  const conditions: string[] = []
  const bindings: unknown[] = []

  if (since) {
    conditions.push('created_at >= ?')
    bindings.push(since)
  }
  if (rating === 'thumbs-up' || rating === 'thumbs-down') {
    conditions.push('rating = ?')
    bindings.push(rating)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const columns = includePrompt
    ? 'system_prompt, user_message, assistant_message, rating, tags, comment, model_config, dataset_id, turn_index, is_fallback, history_compressed, action_clicks, created_at'
    : 'user_message, assistant_message, rating, tags, comment, model_config, dataset_id, turn_index, is_fallback, history_compressed, action_clicks, created_at'

  try {
    const stmt = db.prepare(
      `SELECT ${columns} FROM feedback ${where} ORDER BY created_at ASC LIMIT ?`,
    )
    bindings.push(limit)
    const result = await stmt.bind(...bindings).all<Record<string, unknown>>()

    // Stream as JSONL using ReadableStream to avoid buffering large exports
    const encoder = new TextEncoder()
    const rows = result.results
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const row of rows) {
          const safeParse = (s: unknown, fallback: unknown) => {
            try { return JSON.parse(String(s || JSON.stringify(fallback))) }
            catch { return fallback }
          }
          const entry: Record<string, unknown> = {
            user: row.user_message || '',
            assistant: row.assistant_message || '',
            rating: row.rating,
            tags: safeParse(row.tags, []),
            comment: row.comment || '',
            model: (() => {
              try { return (JSON.parse((row.model_config as string) || '{}')).model ?? '' }
              catch { return '' }
            })(),
            dataset_id: row.dataset_id ?? null,
            turn_index: row.turn_index ?? null,
            is_fallback: !!(row.is_fallback),
            history_compressed: !!(row.history_compressed),
            action_clicks: safeParse(row.action_clicks, []),
            timestamp: row.created_at,
          }
          if (includePrompt) {
            entry.system = row.system_prompt || ''
          }
          controller.enqueue(encoder.encode(JSON.stringify(entry) + '\n'))
        }
        controller.close()
      },
    })

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
