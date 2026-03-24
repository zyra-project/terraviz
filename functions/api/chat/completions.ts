/**
 * Cloudflare Pages Function — /api/chat/completions
 *
 * Proxies OpenAI-compatible chat completion requests to Cloudflare Workers AI.
 * Streams SSE responses back to the client in OpenAI format.
 * No external API key needed — uses the AI binding on Cloudflare's edge.
 */

interface Env {
  AI: {
    run(
      model: string,
      inputs: Record<string, unknown>,
      options?: { gateway?: { id: string }; returnRawResponse?: boolean },
    ): Promise<Response | ReadableStream | Record<string, unknown>>
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface RequestBody {
  model?: string
  messages: ChatMessage[]
  stream?: boolean
  tools?: unknown[]
}

// Model mapping: friendly names → Cloudflare AI model IDs
const MODEL_MAP: Record<string, string> = {
  'llama-3.1-8b': '@cf/meta/llama-3.1-8b-instruct',
  'llama-3.2-3b': '@cf/meta/llama-3.2-3b-instruct',
  default: '@cf/meta/llama-3.1-8b-instruct',
}

// Basic per-IP rate limiting (in-memory, resets on deploy)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 30 // requests per window
const RATE_WINDOW_MS = 60_000 // 1 minute

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const ip = context.request.headers.get('CF-Connecting-IP') ?? 'unknown'

  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again shortly.' }), {
      status: 429,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    })
  }

  let body: RequestBody
  try {
    body = await context.request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    })
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return new Response(JSON.stringify({ error: 'messages array required' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    })
  }

  // Resolve the Cloudflare AI model
  const requestedModel = body.model ?? 'default'
  const cfModel = MODEL_MAP[requestedModel] ?? MODEL_MAP['default']

  // Truncate messages to limit token usage
  const messages = body.messages.slice(-22) // system + 20 history + user

  if (body.stream) {
    return streamResponse(context.env.AI, cfModel, messages)
  }
  return nonStreamResponse(context.env.AI, cfModel, messages)
}

async function streamResponse(
  ai: Env['AI'],
  model: string,
  messages: ChatMessage[],
): Promise<Response> {
  // Use returnRawResponse to get the raw SSE stream from Workers AI
  const response = (await ai.run(
    model,
    { messages, stream: true },
    { returnRawResponse: true },
  )) as Response

  // Workers AI with returnRawResponse gives us an SSE stream,
  // but in its own format. We need to re-wrap it in OpenAI format.
  // Actually, @cf/meta models with stream:true + returnRawResponse
  // already return OpenAI-compatible SSE. Pass it through.
  return new Response(response.body, {
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

async function nonStreamResponse(
  ai: Env['AI'],
  model: string,
  messages: ChatMessage[],
): Promise<Response> {
  const result = (await ai.run(model, { messages })) as { response?: string }

  const payload = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.response ?? '' },
        finish_reason: 'stop',
      },
    ],
  }

  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  })
}
