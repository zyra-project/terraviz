/**
 * Cloudflare Pages Function — /api/feedback
 *
 * Accepts user feedback on AI (Orbit) responses.
 * Stores feedback in Cloudflare D1 for later analysis.
 *
 * POST /api/feedback  — JSON body matching FeedbackPayload
 */

interface Env {
  FEEDBACK_DB?: D1Database
}

interface FeedbackBody {
  rating: 'thumbs-up' | 'thumbs-down'
  comment: string
  messageId: string
  messages: unknown[]
  datasetId: string | null
  timestamp: number
  systemPrompt?: string
  modelConfig?: Record<string, unknown>
  isFallback?: boolean
  userMessage?: string
  turnIndex?: number
  historyCompressed?: boolean
  actionClicks?: string[]
  tags?: string[]
}

// --- Rate limiting (in-memory, per-isolate) ---

const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    if (rateLimitMap.size > 1000) {
      for (const [key, val] of rateLimitMap) {
        if (now > val.resetAt) rateLimitMap.delete(key)
      }
    }
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT
}

// --- CORS ---

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

// --- Validation ---

function isValidBody(body: unknown): body is FeedbackBody {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (b.rating !== 'thumbs-up' && b.rating !== 'thumbs-down') return false
  if (typeof b.comment !== 'string') return false
  if (typeof b.messageId !== 'string' || !b.messageId) return false
  if (!Array.isArray(b.messages)) return false
  if (typeof b.timestamp !== 'number') return false
  if (b.systemPrompt !== undefined && typeof b.systemPrompt !== 'string') return false
  if (b.isFallback !== undefined && typeof b.isFallback !== 'boolean') return false
  if (b.userMessage !== undefined && typeof b.userMessage !== 'string') return false
  if (b.turnIndex !== undefined && typeof b.turnIndex !== 'number') return false
  if (b.historyCompressed !== undefined && typeof b.historyCompressed !== 'boolean') return false
  if (b.datasetId !== undefined && b.datasetId !== null && typeof b.datasetId !== 'string') return false
  if (b.actionClicks !== undefined && (!Array.isArray(b.actionClicks) || !b.actionClicks.every((v: unknown) => typeof v === 'string'))) return false
  if (b.tags !== undefined && (!Array.isArray(b.tags) || !b.tags.every((v: unknown) => typeof v === 'string'))) return false
  return true
}

// --- Handlers ---

export const onRequestOptions: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin')
  if (!isAllowedOrigin(origin, context.request.url)) {
    return new Response(null, { status: 403 })
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin')
  if (!origin || !isAllowedOrigin(origin, context.request.url)) {
    return new Response(null, { status: 403 })
  }
  const cors = corsHeaders(origin)
  const ip = context.request.headers.get('CF-Connecting-IP')

  if (ip && isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again shortly.' }), {
      status: 429,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (!isValidBody(body)) {
    return new Response(JSON.stringify({ error: 'Invalid feedback payload' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Truncate messages and strip to essential fields to prevent oversized payloads
  const messages = body.messages.slice(-100).map((m: unknown) => {
    if (typeof m !== 'object' || m === null) return m
    const msg = m as Record<string, unknown>
    return { id: msg.id, role: msg.role, text: msg.text, timestamp: msg.timestamp }
  })
  let conversationJson = JSON.stringify(messages)
  // Cap total size to 500KB to stay well within D1 row limits
  if (conversationJson.length > 500_000) {
    conversationJson = JSON.stringify(messages.slice(-20))
  }

  // Extract the rated assistant message text for easy export queries
  const ratedMsg = messages.find((m: unknown) => {
    if (typeof m !== 'object' || m === null) return false
    const msg = m as Record<string, unknown>
    return msg.id === body.messageId && (msg.role === 'docent' || msg.role === 'assistant')
  }) as Record<string, unknown> | undefined
  const assistantMessage = typeof ratedMsg?.text === 'string' ? ratedMsg.text.slice(0, 50_000) : ''

  // Store in D1 if binding is available, otherwise log to console
  const db = context.env.FEEDBACK_DB
  if (db) {
    try {
      const tagsJson = JSON.stringify((body.tags ?? []).slice(0, 10))
      const comment = body.comment.slice(0, 2000)
      // Cap modelConfig to expected shape and size
      const mc = body.modelConfig
      const safeModelConfig = (mc && typeof mc === 'object' && !Array.isArray(mc))
        ? { model: String((mc as Record<string, unknown>).model ?? ''),
            readingLevel: String((mc as Record<string, unknown>).readingLevel ?? ''),
            visionEnabled: !!(mc as Record<string, unknown>).visionEnabled }
        : {}
      const modelConfigJson = JSON.stringify(safeModelConfig)

      // ON CONFLICT handles upsert — second submission (with tags/comment)
      // updates the existing row automatically
      await db.prepare(
        `INSERT INTO feedback (rating, comment, message_id, dataset_id, conversation, system_prompt, model_config, is_fallback, user_message, turn_index, history_compressed, action_clicks, tags, assistant_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           comment = excluded.comment,
           tags = excluded.tags,
           rating = excluded.rating`,
      ).bind(
        body.rating,
        comment,
        body.messageId,
        body.datasetId ?? null,
        conversationJson,
        (body.systemPrompt ?? '').slice(0, 100_000),
        modelConfigJson,
        body.isFallback ? 1 : 0,
        (body.userMessage ?? '').slice(0, 10_000),
        body.turnIndex ?? null,
        body.historyCompressed ? 1 : 0,
        JSON.stringify((body.actionClicks ?? []).slice(0, 50)),
        tagsJson,
        assistantMessage,
        new Date().toISOString(),
      ).run()
    } catch (err) {
      console.error('Failed to write feedback to D1:', err)
      return new Response(JSON.stringify({ error: 'Failed to store feedback' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
  } else {
    // No D1 binding — log for Cloudflare Workers tail/dashboard
    console.log('[feedback]', JSON.stringify({
      rating: body.rating,
      comment: body.comment.slice(0, 500),
      messageId: body.messageId,
      datasetId: body.datasetId,
      messageCount: messages.length,
      timestamp: body.timestamp,
      model: (body.modelConfig as Record<string, unknown>)?.model ?? 'unknown',
      isFallback: body.isFallback ?? false,
      hasSystemPrompt: !!body.systemPrompt,
      turnIndex: body.turnIndex,
      actionClicks: body.actionClicks,
    }))
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
