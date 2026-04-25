/**
 * Cloudflare Pages Function helpers — feedback admin data layer.
 *
 * This file is excluded from routing (the leading underscore is the
 * Pages convention for non-route modules). It owns the SQL and
 * response-shaping logic shared by:
 *
 *   - /api/feedback-admin           (the HTML dashboard + dispatcher)
 *   - /api/feedback-dashboard       (legacy direct endpoint)
 *   - /api/feedback-export          (legacy direct endpoint)
 *   - /api/general-feedback-dashboard
 *   - /api/general-feedback-export
 *   - /api/general-feedback-screenshot
 *
 * Auth lives in the route files. These helpers assume the caller
 * has already gated the request.
 */

export interface AiDashboardResponse {
  totalCount: number
  thumbsUpCount: number
  thumbsDownCount: number
  byDay: Array<{ date: string; up: number; down: number }>
  topTags: Array<{ tag: string; count: number }>
  recentFeedback: Array<Record<string, unknown>>
}

export interface GeneralDashboardResponse {
  totalCount: number
  bugCount: number
  featureCount: number
  otherCount: number
  byDay: Array<{ date: string; bugs: number; features: number; other: number }>
  recentFeedback: Array<Record<string, unknown>>
}

export interface AiExportOptions {
  since?: string | null
  rating?: string | null
  limit?: number
  includePrompt?: boolean
}

export interface GeneralExportOptions {
  since?: string | null
  kind?: string | null
  limit?: number
}

export async function fetchAiDashboard(
  db: D1Database,
  days: number,
  recentLimit: number,
): Promise<AiDashboardResponse> {
  const totals = await db.prepare(
    `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN rating = 'thumbs-up' THEN 1 ELSE 0 END) as thumbs_up,
      SUM(CASE WHEN rating = 'thumbs-down' THEN 1 ELSE 0 END) as thumbs_down
    FROM feedback`,
  ).first<{ total: number; thumbs_up: number; thumbs_down: number }>()

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

  return {
    totalCount: totals?.total ?? 0,
    thumbsUpCount: totals?.thumbs_up ?? 0,
    thumbsDownCount: totals?.thumbs_down ?? 0,
    byDay: byDay.results,
    topTags,
    recentFeedback: recent.results.map(r => {
      const safeParse = (s: string, fallback: unknown) => {
        try { return JSON.parse(s || JSON.stringify(fallback)) }
        catch { return fallback }
      }
      return {
        ...r,
        tags: safeParse(r.tags, []),
        modelConfig: safeParse(r.model_config, {}),
        isFallback: !!r.is_fallback,
        historyCompressed: !!r.history_compressed,
      }
    }),
  }
}

export async function fetchGeneralDashboard(
  db: D1Database,
  days: number,
  recentLimit: number,
): Promise<GeneralDashboardResponse> {
  const totals = await db.prepare(
    `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN kind = 'bug' THEN 1 ELSE 0 END) as bugs,
      SUM(CASE WHEN kind = 'feature' THEN 1 ELSE 0 END) as features,
      SUM(CASE WHEN kind = 'other' THEN 1 ELSE 0 END) as other
    FROM general_feedback`,
  ).first<{ total: number; bugs: number; features: number; other: number }>()

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
  // payloads. The admin UI fetches screenshots on demand via the
  // screenshot action when the user opens a detail panel.
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

  return {
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
  }
}

export async function streamAiExport(
  db: D1Database,
  options: AiExportOptions,
): Promise<ReadableStream<Uint8Array>> {
  const since = options.since ?? null
  const rating = options.rating ?? null
  const includePrompt = !!options.includePrompt
  const limit = Math.min(Math.max(options.limit ?? 1000, 1), 10_000)

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

  const stmt = db.prepare(
    `SELECT ${columns} FROM feedback ${where} ORDER BY created_at ASC LIMIT ?`,
  )
  bindings.push(limit)
  const result = await stmt.bind(...bindings).all<Record<string, unknown>>()

  const encoder = new TextEncoder()
  const rows = result.results
  return new ReadableStream<Uint8Array>({
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
}

/**
 * Estimate the decoded byte size of a base64 data URL. The JS string
 * length counts characters, not bytes — base64 encodes 3 bytes per 4
 * characters of payload. Strip the `data:...;base64,` prefix first
 * so we only count the encoded payload.
 */
function estimateDataUrlBytes(dataUrl: string): number {
  if (!dataUrl) return 0
  const commaIdx = dataUrl.indexOf(',')
  const payload = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

function csvEscape(value: unknown): string {
  if (value == null) return ''
  const s = String(value)
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export async function streamGeneralExport(
  db: D1Database,
  options: GeneralExportOptions,
): Promise<ReadableStream<Uint8Array>> {
  const since = options.since ?? null
  const kind = options.kind ?? null
  const limit = Math.min(Math.max(options.limit ?? 10000, 1), 50_000)

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
  return new ReadableStream<Uint8Array>({
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
}

export async function fetchScreenshot(
  db: D1Database,
  id: number,
): Promise<{ id: number; screenshot: string } | null> {
  const row = await db.prepare(
    'SELECT screenshot FROM general_feedback WHERE id = ?',
  ).bind(id).first<{ screenshot: string }>()

  if (!row) return null
  return { id, screenshot: row.screenshot || '' }
}
