// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages Function — /api/chat/completions
 *
 * Proxies OpenAI-compatible chat completion requests to Cloudflare Workers AI.
 * Streams SSE responses back to the client in OpenAI format.
 * No external API key needed — uses the AI binding on Cloudflare's edge.
 */

import { isWorkersAiQuotaError, workersAiErrorMessage } from '../_lib/workers-ai-error'
import {
  extractModelText,
  extractModelToolCalls,
  type WorkersAiToolCall,
} from '../_lib/workers-ai-text'

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
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
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
    if (!Array.isArray(msg.content)) {
      return { role: msg.role, content: '' }
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
      const result = await context.env.AI.run(cfModel, inputs)
      // Envelope-tolerant reads — some models answer { response, tool_calls }
      // top-level, others the OpenAI { choices: [{ message }] } shape.
      const resultText = extractModelText(result)
      const resultToolCalls = extractModelToolCalls(result)
      const chatId = `chatcmpl-${Date.now()}`
      // Normalize tool_calls to OpenAI shape (same logic as toolStreamShim)
      const normalizedToolCalls = resultToolCalls?.map((raw, i) => {
        const name = raw.function?.name ?? raw.name ?? ''
        const rawArgs = raw.function?.arguments ?? raw.arguments ?? {}
        return {
          id: raw.id ?? `call_${chatId}_${i}`,
          type: 'function' as const,
          function: {
            name,
            arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs),
          },
        }
      })
      const payload = {
        id: chatId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: cfModel,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: resultText ?? '',
            ...(normalizedToolCalls?.length ? { tool_calls: normalizedToolCalls } : {}),
          },
          finish_reason: resultToolCalls?.length ? 'tool_calls' : 'stop',
        }],
      }
      return new Response(JSON.stringify(payload), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // Plain text, no tools, no images: real streaming path (unchanged).
    // Guard against content: null (assistant tool-call echoes) and
    // role: 'tool' messages that shouldn't reach this path but might
    // if supportsTools is false and the client sends stale history.
    const textMessages = truncated
      .filter(m => m.role !== 'tool')
      .map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n')
            : '',
      }))
    if (body.stream) {
      return await streamResponse(context.env.AI, cfModel, textMessages, cors)
    }
    return await nonStreamResponse(context.env.AI, cfModel, textMessages, cors)
  } catch (err) {
    // The one place the upstream-failure contract is built: the
    // binding's throws, the tool shim and the raw streaming path all
    // land here. A thrown message can itself be a JSON error body;
    // `workersAiErrorMessage` reduces it to the error it names, for the
    // message the client is told (`isWorkersAiQuotaError` does the same
    // reduction itself before matching).
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
    const message = workersAiErrorMessage(raw) || 'Internal server error'
    // Phase 1f/D — surface Workers AI quota exhaustion as a typed
    // 503 so the SPA can flip its degraded-mode badge instead of
    // showing a generic 502 server_error.
    if (isWorkersAiQuotaError(message)) {
      return new Response(
        JSON.stringify({ error: { message, type: 'quota_exhausted', code: 4006 } }),
        { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }
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
    const result = await ai.run(model, inputs)
    text = extractModelText(result) ?? ''
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

  // A failed upstream arrives as a Response, not a throw: with
  // `returnRawResponse` Workers AI hands back its own error envelope — a
  // 4xx/5xx body that is not SSE at all — and the transformer below skips
  // every line of it and closes an *empty* stream. The client cannot tell
  // that from a model that answered nothing: it retries twice, falls back
  // to the local engine, and shows "AI service unavailable — check LLM
  // settings", which is how an exhausted neuron budget was being
  // reported. Throw it instead, carrying the error the envelope names
  // rather than the envelope, so the catch in `onRequestPost` turns it
  // into the same typed failure the non-streaming paths produce.
  if (!response.ok) {
    const detail = workersAiErrorMessage(await response.text().catch(() => ''))
    throw new Error(detail.slice(0, 300) || `Workers AI request failed (${response.status})`)
  }

  // No body at all is the same silence as a body with nothing in it.
  if (!response.body) return await failEmptyStream(ai, model)

  // Workers AI returns its own SSE format: {"response":"token","p":"..."}
  // Transform it to OpenAI-compatible format: {"choices":[{"delta":{"content":"token"}}]}
  const chatId = `chatcmpl-${Date.now()}`
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  // Workers AI reports a spent free-tier budget as an *empty* 200
  // text/event-stream — verified against the production deployment: zero
  // bytes with `content-type: text/event-stream` — so the status says
  // nothing and the transformer below would close a stream that never
  // carried a token. The client reads that as "the model answered
  // nothing": two retries, the local engine, and a banner telling the
  // operator to check settings that are fine. Reading up to the first
  // bytes before committing to a streaming Response keeps the two apart —
  // an empty upstream still becomes an error the SPA's degraded badge acts
  // on, and a non-empty one costs nothing beyond the first token the
  // client was already waiting for.
  //
  // "Empty" means no bytes before the upstream closed, not "the first
  // read was empty": a zero-length chunk can precede a real answer. And a
  // body that *has* bytes but no `response` tokens — an in-band
  // `data: {"error":"4006: …"}` — is streamed as is. The budget signal
  // observed in production is the empty body; classifying in-band shapes
  // nobody has seen would be guessing, and a guessed "quota" sends the
  // operator to upgrade a plan that was never the problem.
  let buffered: Uint8Array | null
  try {
    buffered = await readFirstBytes(reader)
  } catch (err) {
    await reader.cancel(err).catch(() => {})
    throw err
  }
  if (!buffered) {
    await reader.cancel().catch(() => {})
    return await failEmptyStream(ai, model)
  }

  // Enqueues the OpenAI-format chunk for every complete SSE line; reports
  // whether it enqueued anything.
  const emitLines = (
    lines: string[],
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => {
    let enqueued = false
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()

      if (payload === '[DONE]') {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        enqueued = true
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
        enqueued = true
      } catch {
        // Skip unparseable lines
      }
    }
    return enqueued
  }

  // An SSE event can be split across upstream chunks, so the last,
  // possibly partial line of each chunk waits for the next one.
  let partial = ''

  const transformed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Keep reading until something is enqueued or the upstream ends. A
      // pull that returns having enqueued nothing is not called again for
      // a read that is already waiting, so a usage-only or keep-alive
      // chunk would otherwise stall the stream.
      for (;;) {
        let value: Uint8Array | undefined
        if (buffered) {
          value = buffered
          buffered = null
        } else {
          const next = await reader.read()
          if (next.done) {
            emitLines((partial + decoder.decode()).split('\n'), controller)
            partial = ''
            controller.close()
            return
          }
          value = next.value
        }

        const lines = (partial + decoder.decode(value, { stream: true })).split('\n')
        partial = lines.pop() ?? ''
        if (emitLines(lines, controller)) return
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

/** The first non-empty chunk of an upstream body, or null if it closes without one. */
async function readFirstBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array | null> {
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return null
    if (value && value.length > 0) return value
  }
}

/**
 * How long the empty-stream probe may take before the proxy stops waiting
 * and reports the empty stream as it is. A rejected probe — the spent
 * budget case — comes back before any inference, well inside this; the
 * bound only matters when the probe would itself hang, and then the
 * client is still waiting on the same request.
 */
export const EMPTY_STREAM_PROBE_TIMEOUT_MS = 4_000

/**
 * What it means when Workers AI answers 200 and then says nothing.
 *
 * A spent free-tier budget is the observed cause — the platform sends an
 * empty event stream rather than an error — and one 1-token call settles
 * it: its rejection propagates to the catch in `onRequestPost`, which
 * classifies it through the same `isWorkersAiQuotaError` the other paths
 * use. When the budget really is spent that call is rejected before any
 * inference, so the classification is free; when it succeeds, or does not
 * answer within `EMPTY_STREAM_PROBE_TIMEOUT_MS`, the honest answer is that
 * the upstream stream came back empty, which is a 502 and not something to
 * blame on the operator's settings.
 */
async function failEmptyStream(ai: Env['AI'], model: string): Promise<never> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<void>(resolve => {
    timer = setTimeout(resolve, EMPTY_STREAM_PROBE_TIMEOUT_MS)
  })
  try {
    await Promise.race([
      ai.run(model, { messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      timedOut,
    ])
  } finally {
    clearTimeout(timer)
  }
  throw new Error('Workers AI returned an empty stream')
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

  const result = await ai.run(model, inputs)

  const payload = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: extractModelText(result) ?? '' },
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

  // A failed call propagates to the catch in `onRequestPost`, which
  // builds the same 503 `quota_exhausted` / 502 `server_error` bodies
  // for every path. (This shim used to build its own, and its 502 had
  // drifted to `type: 'workers_ai_error'`; the SPA only ever reads
  // `quota_exhausted`, so nothing depended on the difference.)
  const result: unknown = await ai.run(model, inputs)

  const chatId = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const base = { id: chatId, object: 'chat.completion.chunk', created, model }
  const chunks: string[] = []

  // Envelope-tolerant reads — some models answer { response, tool_calls }
  // top-level, others the OpenAI { choices: [{ message }] } shape.
  const resultText = extractModelText(result)
  const resultToolCalls: WorkersAiToolCall[] | null = extractModelToolCalls(result)

  // Text content chunk (if present)
  if (resultText) {
    chunks.push(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { content: resultText } }],
      })}\n\n`,
    )
  }

  // Tool call chunks (if present)
  if (resultToolCalls?.length) {
    for (let i = 0; i < resultToolCalls.length; i++) {
      const raw = resultToolCalls[i]
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
        finish_reason: resultToolCalls?.length ? 'tool_calls' : 'stop',
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
