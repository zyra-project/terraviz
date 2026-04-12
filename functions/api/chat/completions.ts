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
  'llama-4-scout':        '@cf/meta/llama-4-scout-17b-16e-instruct',
  'llama-3.3-70b':        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'llama-3.1-70b':        '@cf/meta/llama-3.1-70b-instruct',
  'llama-3.1-8b':         '@cf/meta/llama-3.1-8b-instruct',
  'llama-3.2-3b':         '@cf/meta/llama-3.2-3b-instruct',
  'llama-3.2-11b-vision': '@cf/meta/llama-3.2-11b-vision-instruct',
  default:                '@cf/meta/llama-4-scout-17b-16e-instruct',
}

// Models on Workers AI that support OpenAI-style function calling. When
// the selected model is in this set, the proxy forwards `tools` to the
// model instead of stripping them, and routes through `toolStreamShim` so
// the response tool_calls are wrapped in OpenAI-format SSE chunks.
const TOOL_CALLING_MODELS = new Set([
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@hf/nousresearch/hermes-2-pro-mistral-7b',
])

// Models that are natively multimodal — they accept OpenAI-style multipart
// `content` arrays (text + image_url parts) as-is, without the image
// extraction / license dance the older llama-3.2-11b-vision model needs.
const NATIVE_MULTIMODAL_MODELS = new Set([
  '@cf/meta/llama-4-scout-17b-16e-instruct',
])

// Legacy vision models that need the separate-image-field API + Meta
// community license acceptance. Kept for users who explicitly select
// llama-3.2-11b-vision in their config; llama-4-scout supersedes it for
// the default vision path.
const LEGACY_VISION_MODELS = new Set([
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

  // Strip tools on models that don't support function calling. Tool-call-
  // driven action cards only work with models listed in TOOL_CALLING_MODELS;
  // for everything else the client-side local engine yields action cards
  // independently.
  const supportsTools = TOOL_CALLING_MODELS.has(cfModel)
  if (body.tools?.length && !supportsTools) {
    body.tools = undefined
  }

  const hasTools = supportsTools && !!body.tools?.length
  const hasImages = messagesContainImages(truncated)
  const isLegacyVision = LEGACY_VISION_MODELS.has(cfModel)
  const isNativeMultimodal = NATIVE_MULTIMODAL_MODELS.has(cfModel)

  try {
    // Legacy vision path — only when the user explicitly selects
    // llama-3.2-11b-vision. The API shape differs from modern models
    // (separate image field, license acceptance, no streaming), so it
    // keeps its own code path.
    if (isLegacyVision) {
      const { image, textMessages } = extractImageAndNormalise(truncated)
      if (body.stream) {
        return await visionStreamShim(context.env.AI, cfModel, textMessages, cors, image)
      }
      await ensureLicenseAccepted(context.env.AI, cfModel)
      return await nonStreamResponse(context.env.AI, cfModel, textMessages, cors, image)
    }

    // Modern path: llama-4-scout and other native multimodal / tool-calling
    // models. If the request includes tools OR images (or both), route
    // through `toolStreamShim` which calls Workers AI non-streaming and
    // wraps the complete response — text deltas, tool_calls, or both —
    // in OpenAI-format SSE chunks. Real streaming is only used for the
    // plain-text no-tools no-images case so the common path still gets
    // token-by-token streaming UX.
    if (hasTools || (hasImages && isNativeMultimodal)) {
      if (body.stream) {
        return await toolStreamShim(context.env.AI, cfModel, truncated, body.tools, cors)
      }
      // Non-streaming: pass messages through with tools, return standard JSON
      const wfMessages = truncated.map(m => {
        const out: Record<string, unknown> = { role: m.role, content: m.content }
        const anyM = m as unknown as Record<string, unknown>
        if (anyM.tool_calls) out.tool_calls = anyM.tool_calls
        if (anyM.tool_call_id) out.tool_call_id = anyM.tool_call_id
        return out
      })
      const inputs: Record<string, unknown> = { messages: wfMessages, max_tokens: DEFAULT_MAX_TOKENS }
      if (body.tools?.length) inputs.tools = body.tools
      const result = (await context.env.AI.run(cfModel, inputs)) as { response?: string; tool_calls?: unknown[] }
      const payload = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: cfModel,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: result.response ?? '',
            ...(result.tool_calls?.length ? { tool_calls: result.tool_calls } : {}),
          },
          finish_reason: result.tool_calls?.length ? 'tool_calls' : 'stop',
        }],
      }
      return new Response(JSON.stringify(payload), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // Plain text, no tools, no images: real streaming path (unchanged)
    const textMessages = truncated.map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : m.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n'),
    }))
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

/**
 * True if any message in the conversation contains at least one image_url
 * content part. Text-only messages (string or array of text parts) return
 * false. Used by the router to decide whether to route to `toolStreamShim`
 * (which preserves multipart content) or the plain text streaming path.
 */
function messagesContainImages(messages: ChatMessage[]): boolean {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'image_url' && part.image_url?.url) return true
      }
    }
  }
  return false
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

/**
 * Unified non-streaming path for native multimodal / tool-calling models.
 *
 * Workers AI's streaming SSE format for `tool_calls` is poorly documented,
 * so this helper calls `ai.run` in non-streaming mode and transforms the
 * complete response into OpenAI-compatible SSE chunks (content delta +
 * tool_calls deltas + finish). The client's existing SSE parser handles
 * these chunks transparently — from its perspective the stream "just
 * works," it just arrives in one burst instead of token-by-token.
 *
 * Handles both response shapes observed on Workers AI:
 *   - llama-4-scout:  tool_calls entries have {id, type, function: {name, arguments}}
 *   - llama-3.3-70b:  tool_calls entries have {name, arguments} (no id/type/function wrapper)
 *
 * Messages are passed through as-is — including multipart content arrays
 * with image_url parts, assistant messages with `tool_calls`, and tool-
 * role messages with `tool_call_id`. Workers AI's native multimodal and
 * function-calling models accept the OpenAI shape directly.
 */
async function toolStreamShim(
  ai: Env['AI'],
  model: string,
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  cors: Record<string, string>,
): Promise<Response> {
  // Pass through messages as-is, preserving tool_calls and tool_call_id
  // fields that the client's multi-turn loop adds for tool result round-trips.
  const wfMessages = messages.map(m => {
    const out: Record<string, unknown> = {
      role: m.role,
      content: m.content,
    }
    const anyM = m as unknown as Record<string, unknown>
    if (anyM.tool_calls) out.tool_calls = anyM.tool_calls
    if (anyM.tool_call_id) out.tool_call_id = anyM.tool_call_id
    return out
  })

  const inputs: Record<string, unknown> = {
    messages: wfMessages,
    max_tokens: DEFAULT_MAX_TOKENS,
  }
  if (tools?.length) inputs.tools = tools

  type WorkersAIToolCall = {
    id?: string
    type?: string
    function?: { name: string; arguments: unknown }
    name?: string
    arguments?: Record<string, unknown>
  }
  type WorkersAIResult = {
    response?: string
    tool_calls?: WorkersAIToolCall[]
  }

  let result: WorkersAIResult
  try {
    result = (await ai.run(model, inputs)) as WorkersAIResult
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Workers AI error'
    return new Response(
      JSON.stringify({ error: { message: msg, type: 'workers_ai_error' } }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  }

  const chatId = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const base = { id: chatId, object: 'chat.completion.chunk', created, model }
  const chunks: string[] = []

  // Text content chunk (if present)
  if (result.response) {
    chunks.push(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { content: result.response } }],
      })}\n\n`,
    )
  }

  // Tool call chunks (if present)
  if (result.tool_calls?.length) {
    for (let i = 0; i < result.tool_calls.length; i++) {
      const raw = result.tool_calls[i]
      // Normalize both response shapes into OpenAI's function-tool-call format
      const name = raw.function?.name ?? raw.name ?? ''
      const rawArgs = raw.function?.arguments ?? raw.arguments ?? {}
      const argsString = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)
      const id = raw.id ?? `call_${chatId}_${i}`
      chunks.push(
        `data: ${JSON.stringify({
          ...base,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: i,
                id,
                type: 'function',
                function: {
                  name,
                  arguments: argsString,
                },
              }],
            },
          }],
        })}\n\n`,
      )
    }
  }

  // Final chunk with finish_reason
  chunks.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: result.tool_calls?.length ? 'tool_calls' : 'stop',
      }],
    })}\n\n`,
  )
  chunks.push('data: [DONE]\n\n')

  return new Response(chunks.join(''), {
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
