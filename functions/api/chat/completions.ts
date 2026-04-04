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

interface ContentPart {
  type: string
  text?: string
  image_url?: { url: string }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

interface RequestBody {
  model?: string
  messages: ChatMessage[]
  stream?: boolean
  tools?: unknown[]
}

// Model mapping: friendly names → Cloudflare AI model IDs
const MODEL_MAP: Record<string, string> = {
  'llama-3.1-70b': '@cf/meta/llama-3.1-70b-instruct',
  'llama-3.1-8b': '@cf/meta/llama-3.1-8b-instruct',
  'llama-3.2-3b': '@cf/meta/llama-3.2-3b-instruct',
  'llama-3.2-11b-vision': '@cf/meta/llama-3.2-11b-vision-instruct',
  default: '@cf/meta/llama-3.1-70b-instruct',
}

// Models that accept image input
const VISION_MODELS = new Set([
  '@cf/meta/llama-3.2-11b-vision-instruct',
])

/**
 * Extract the first base64 image from OpenAI-format messages and convert
 * multimodal content arrays to plain text for the CF AI API.
 * Returns the image bytes (if any) and normalised text-only messages.
 */
function extractImageAndNormalise(
  messages: ChatMessage[],
): { image: Uint8Array | null; textMessages: { role: string; content: string }[] } {
  let image: Uint8Array | null = null

  const textMessages = messages.map(msg => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content }
    }
    // Multimodal content array — extract image + concatenate text
    const textParts: string[] = []
    for (const part of msg.content) {
      if (part.type === 'text' && part.text) {
        textParts.push(part.text)
      } else if (part.type === 'image_url' && part.image_url?.url && !image) {
        // Extract the first image only (CF API supports one image)
        const dataUrl = part.image_url.url
        const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/)
        if (match) {
          try {
            const binary = atob(match[1])
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i)
            }
            image = bytes
          } catch {
            // Invalid base64 — skip the image rather than failing the request
          }
        }
      }
    }
    return { role: msg.role, content: textParts.join('\n') }
  })

  return { image, textMessages }
}

// Workers AI default max_tokens is ~256 which truncates conversational responses.
// 512 tokens ≈ 380 words — enough for Orbit's 150-word guideline with headroom.
const DEFAULT_MAX_TOKENS = 512

// Basic per-IP rate limiting (in-memory, resets on deploy)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 30 // requests per window
const RATE_WINDOW_MS = 60_000 // 1 minute

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    // Prune expired entries to prevent unbounded growth
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

// Allowed CORS origins — same-origin in production, localhost for dev
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:4173',
])

function isAllowedOrigin(origin: string | null, requestUrl: string): boolean {
  if (!origin) return false
  if (ALLOWED_ORIGINS.has(origin)) return true
  // Allow same-origin (deployed Pages site)
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  }
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

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

  let body: RequestBody
  try {
    body = await context.request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return new Response(JSON.stringify({ error: 'messages array required' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Resolve the Cloudflare AI model — accept friendly names via MODEL_MAP
  // or pass through full @cf/... model IDs directly
  const requestedModel = body.model ?? 'default'
  const cfModel = requestedModel.startsWith('@cf/')
    ? requestedModel
    : (MODEL_MAP[requestedModel] ?? MODEL_MAP['default'])

  // Truncate messages to limit token usage
  const truncated = body.messages.slice(-22) // system + 20 history + user

  // Workers AI does not support tool calling — strip tools from the request so no tool calls
  // are produced on this path. The client-side local engine yields action cards independently.
  // Tool-call-driven action cards only work with external OpenAI-compatible providers
  // (e.g., OpenAI, Ollama) that support the tools/tool_choice API.
  if (body.tools?.length) {
    body.tools = undefined
  }

  // For vision models, extract image data and normalise messages to text-only
  const isVision = VISION_MODELS.has(cfModel)
  const { image, textMessages } = isVision
    ? extractImageAndNormalise(truncated)
    : { image: null, textMessages: truncated.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n') })) }

  // Vision models on Workers AI do not support streaming — always use
  // non-streaming and, if the client requested streaming, wrap the
  // complete response in SSE format so the client parser handles it.
  try {
    if (isVision) {
      if (body.stream) {
        return await visionStreamShim(context.env.AI, cfModel, textMessages, cors, image)
      }
      // Non-streaming vision path also needs license acceptance
      await ensureLicenseAccepted(context.env.AI, cfModel)
      return await nonStreamResponse(context.env.AI, cfModel, textMessages, cors, image)
    }

    if (body.stream) {
      return await streamResponse(context.env.AI, cfModel, textMessages, cors)
    }
    return await nonStreamResponse(context.env.AI, cfModel, textMessages, cors)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return new Response(JSON.stringify({ error: { message, type: 'server_error' } }), {
      status: 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
}

// Track which vision models have had their license accepted (per isolate lifetime)
const acceptedLicenses = new Set<string>()

/**
 * Accept the Meta community license for a vision model by sending 'agree'.
 * CF Workers AI requires this before the model can be used.
 * Only needs to happen once per model per isolate.
 */
async function ensureLicenseAccepted(ai: Env['AI'], model: string): Promise<void> {
  if (acceptedLicenses.has(model)) return
  // The error says "submit the prompt 'agree'" — try both prompt and messages formats
  try {
    await ai.run(model, { prompt: 'agree' })
    acceptedLicenses.add(model)
    return
  } catch {
    // prompt format didn't work, try messages format
  }
  try {
    await ai.run(model, {
      messages: [{ role: 'user', content: 'agree' }],
    })
    acceptedLicenses.add(model)
  } catch {
    // Neither worked — the actual request will surface the error
  }
}

/**
 * Vision models don't support streaming on Workers AI.
 * Call non-streaming, then wrap the result in SSE so the client's
 * streaming parser handles it transparently.
 *
 * Errors are returned as SSE text deltas (not HTTP errors) so the
 * user can see what went wrong directly in the chat.
 */
async function visionStreamShim(
  ai: Env['AI'],
  model: string,
  messages: { role: string; content: string }[],
  cors: Record<string, string>,
  image: Uint8Array | null,
): Promise<Response> {
  // Accept Meta license on first use
  await ensureLicenseAccepted(ai, model)

  const inputs: Record<string, unknown> = { messages, max_tokens: DEFAULT_MAX_TOKENS }
  if (image) inputs.image = [...image]

  let text: string
  try {
    const result = (await ai.run(model, inputs)) as { response?: string }
    text = result.response ?? ''
    if (!text) {
      text = '[Vision model returned an empty response. Try rephrasing your question.]'
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Vision model error'
    // Return the error as chat text so the user can see what went wrong
    text = `[Vision analysis failed: ${msg}]`
  }

  // Wrap the complete response as two SSE chunks (content + final) + [DONE]
  const chatId = `chatcmpl-${Date.now()}`
  const base = {
    id: chatId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  }
  const contentChunk = {
    ...base,
    choices: [{ index: 0, delta: { content: text } }],
  }
  const finalChunk = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }
  const sseBody =
    `data: ${JSON.stringify(contentChunk)}\n\n` +
    `data: ${JSON.stringify(finalChunk)}\n\n` +
    `data: [DONE]\n\n`

  return new Response(sseBody, {
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

async function streamResponse(
  ai: Env['AI'],
  model: string,
  messages: { role: string; content: string }[],
  cors: Record<string, string>,
): Promise<Response> {
  const response = (await ai.run(
    model,
    { messages, stream: true, max_tokens: DEFAULT_MAX_TOKENS },
    { returnRawResponse: true },
  )) as Response

  if (!response.body) {
    return new Response(JSON.stringify({ error: 'No response from AI' }), {
      status: 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // Workers AI returns its own SSE format: {"response":"token","p":"..."}
  // Transform it to OpenAI-compatible format: {"choices":[{"delta":{"content":"token"}}]}
  const chatId = `chatcmpl-${Date.now()}`
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  const transformed = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }

      const text = decoder.decode(value, { stream: true })
      const lines = text.split('\n')

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()

        if (payload === '[DONE]') {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          continue
        }

        try {
          const parsed = JSON.parse(payload)

          // Skip usage-only chunks (response is null or empty with usage)
          if (parsed.response === null || (parsed.response === '' && parsed.usage)) {
            continue
          }

          const openAIChunk = {
            id: chatId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: { content: parsed.response },
              finish_reason: null,
            }],
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`))
        } catch {
          // Skip unparseable lines
        }
      }
    },
  })

  return new Response(transformed, {
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

async function nonStreamResponse(
  ai: Env['AI'],
  model: string,
  messages: { role: string; content: string }[],
  cors: Record<string, string>,
  image?: Uint8Array | null,
): Promise<Response> {
  const inputs: Record<string, unknown> = { messages, max_tokens: DEFAULT_MAX_TOKENS }
  if (image) inputs.image = [...image]

  const result = (await ai.run(model, inputs)) as { response?: string }

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
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
