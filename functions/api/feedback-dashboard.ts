/**
 * Cloudflare Pages Function — /api/feedback-dashboard
 *
 * Admin endpoint for viewing feedback summary stats.
 * Protected by bearer token (FEEDBACK_ADMIN_TOKEN env var).
 *
 * GET /api/feedback-dashboard
 *   ?days=30    — lookback window (default 30, max 365)
 *   ?recent=50  — number of recent entries (default 50, max 200)
 */

interface Env {
  FEEDBACK_DB?: D1Database
  FEEDBACK_ADMIN_TOKEN?: string
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
  if (!token) return false
  const auth = request.headers.get('Authorization')
  if (!auth) return false
  const bearer = auth.replace(/^Bearer\s+/i, '')
  return bearer === token
}

export const onRequestOptions: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin')
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin')
  const cors = corsHeaders(origin)
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
    // Total counts
    const totals = await db.prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN rating = 'thumbs-up' THEN 1 ELSE 0 END) as thumbs_up,
        SUM(CASE WHEN rating = 'thumbs-down' THEN 1 ELSE 0 END) as thumbs_down
      FROM feedback`,
    ).first<{ total: number; thumbs_up: number; thumbs_down: number }>()

    // Ratings by day (last N days)
    const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString()
    const byDay = await db.prepare(
      `SELECT
        DATE(created_at) as date,
        SUM(CASE WHEN rating = 'thumbs-up' THEN 1 ELSE 0 END) as up,
        SUM(CASE WHEN rating = 'thumbs-down' THEN 1 ELSE 0 END) as down
      FROM feedback
      WHERE created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY date DESC`,
    ).bind(sinceDate).all<{ date: string; up: number; down: number }>()

    // Top tags
    const allTags = await db.prepare(
      'SELECT tags FROM feedback WHERE tags != \'[]\' AND created_at >= ?',
    ).bind(sinceDate).all<{ tags: string }>()

    const tagCounts = new Map<string, number>()
    for (const row of allTags.results) {
      try {
        const parsed = JSON.parse(row.tags) as string[]
        for (const tag of parsed) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
        }
      } catch { /* skip malformed */ }
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }))

    // Recent feedback
    const recent = await db.prepare(
      `SELECT rating, comment, tags, user_message, assistant_message, dataset_id, model_config, is_fallback, turn_index, history_compressed, system_prompt, created_at
      FROM feedback
      ORDER BY created_at DESC
      LIMIT ?`,
    ).bind(recentLimit).all<{
      rating: string
      comment: string
      tags: string
      user_message: string
      assistant_message: string
      dataset_id: string | null
      model_config: string
      is_fallback: number
      turn_index: number | null
      history_compressed: number
      system_prompt: string
      created_at: string
    }>()

    return new Response(JSON.stringify({
      totalCount: totals?.total ?? 0,
      thumbsUpCount: totals?.thumbs_up ?? 0,
      thumbsDownCount: totals?.thumbs_down ?? 0,
      byDay: byDay.results,
      topTags,
      recentFeedback: recent.results.map(r => ({
        ...r,
        tags: JSON.parse(r.tags || '[]'),
        modelConfig: JSON.parse(r.model_config || '{}'),
        isFallback: !!r.is_fallback,
        historyCompressed: !!r.history_compressed,
      })),
    }), { headers: jsonHeaders })
  } catch (err) {
    console.error('Dashboard query failed:', err)
    return new Response(JSON.stringify({ error: 'Query failed' }), {
      status: 500,
      headers: jsonHeaders,
    })
  }
}
