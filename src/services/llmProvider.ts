/**
 * LLM Provider — OpenAI-compatible streaming API client.
 *
 * Supports any provider that speaks the OpenAI chat completions API:
 * OpenAI, Ollama, LM Studio, llama.cpp, vLLM, etc.
 *
 * Uses native fetch + ReadableStream for SSE parsing — no dependencies.
 */

import type { DocentConfig } from '../types'
import { logger } from '../utils/logger'
import { reportError } from '../analytics'

// On Tauri, use the HTTP plugin's fetch to bypass webview CORS restrictions.
// Local LLM servers (Ollama, LM Studio, etc.) don't set CORS headers for
// the tauri.localhost origin, so requests from the webview's native fetch fail.
const IS_TAURI = !!(window as any).__TAURI__
const tauriFetchReady: Promise<typeof globalThis.fetch | null> | null = IS_TAURI
  ? import('@tauri-apps/plugin-http').then(m => {
    logger.info('[LLM] Tauri HTTP plugin loaded')
    return m.fetch as typeof globalThis.fetch
  }).catch(err => {
    logger.warn('[LLM] Failed to load Tauri HTTP plugin:', err)
    reportError('llm', err)
    return null
  })
  : null

/** Use Tauri's CORS-free fetch when available, otherwise native fetch. */
async function corsFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (tauriFetchReady) {
    const f = await tauriFetchReady
    if (f) {
      logger.debug('[LLM] Using Tauri HTTP plugin for', typeof input === 'string' ? input : (input as Request).url)
      return f(input, init)
    }
    logger.warn('[LLM] Tauri HTTP plugin resolved to null, falling back to native fetch')
  }
  logger.debug('[LLM] Using native fetch for', typeof input === 'string' ? input : (input as Request).url)
  return fetch(input, init)
}

// --- Types ---

/** A text-only content part. */
export interface LLMTextPart {
  type: 'text'
  text: string
}

/** An image content part (base64 data URL). */
export interface LLMImagePart {
  type: 'image_url'
  image_url: { url: string }
}

export type LLMContentPart = LLMTextPart | LLMImagePart

/**
 * OpenAI-compatible tool_calls entry on an assistant message. Used when
 * sending the conversation back to the LLM in a multi-turn tool-calling
 * flow — the assistant message must echo the tool_calls it emitted so the
 * subsequent tool-role messages can reference them by id.
 */
export interface LLMAssistantToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** Arguments as a JSON-stringified payload, per the OpenAI spec. */
    arguments: string
  }
}

/**
 * A single message in the LLM conversation. Supports all four OpenAI roles:
 *
 * - `system` / `user` / `assistant` — normal conversation turns
 * - `assistant` with `tool_calls` — the assistant emitted tool calls
 * - `tool` with `tool_call_id` — a tool result being fed back to the LLM
 *
 * Kept as a single loose interface rather than a discriminated union so
 * callers that construct simple `{role, content}` messages don't have to
 * narrow before using them.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LLMContentPart[] | null
  /** Only valid for role: 'assistant'. Present when the model emitted tool calls. */
  tool_calls?: LLMAssistantToolCall[]
  /** Only valid for role: 'tool'. References the id of the assistant tool_call being answered. */
  tool_call_id?: string
}

export interface LLMTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * A tool call emitted by the model during streaming. Includes the provider-
 * assigned `id` so callers can send a matching `role: 'tool'` message back
 * in a subsequent streamChat call to close the loop.
 */
export interface LLMToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** Yielded by the streaming generator */
export type StreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; call: LLMToolCall }
  | { type: 'done' }
  | { type: 'error'; message: string }

// --- Constants ---
const REQUEST_TIMEOUT_MS = 30000
const STREAM_LINE_PREFIX = 'data:'

/**
 * Stream a chat completion from an OpenAI-compatible API.
 * Yields text deltas and tool calls as they arrive.
 */
export async function* streamChat(
  messages: LLMMessage[],
  tools: LLMTool[],
  config: DocentConfig,
  options?: { timeoutMs?: number },
): AsyncGenerator<StreamChunk> {
  const url = `${config.apiUrl.replace(/\/+$/, '')}/chat/completions`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
  }
  if (tools.length > 0) {
    body.tools = tools
  }

  const controller = new AbortController()
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    logger.info('[LLM] POST', url, 'model:', config.model)
    response = await corsFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    const msg = err instanceof Error ? err.message : 'Network error'
    logger.warn('[LLM] Connection failed:', msg)
    yield { type: 'error', message: msg }
    return
  }

  // Replace the initial connection timeout with a per-chunk inactivity timeout.
  // If no data arrives within the timeout during streaming, abort.
  clearTimeout(timeout)
  let inactivityTimer = setTimeout(() => controller.abort(), timeoutMs)
  const resetInactivity = () => {
    clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => controller.abort(), timeoutMs)
  }

  logger.info(`[LLM] Response status: ${response.status} ${response.statusText}`)

  if (!response.ok) {
    clearTimeout(inactivityTimer)
    const text = await response.text().catch(() => '')
    logger.warn(`[LLM] API error ${response.status}:`, text)
    // Extract error detail from JSON body if available
    let detail = ''
    try {
      const parsed = JSON.parse(text)
      if (parsed.error) detail = `: ${typeof parsed.error === 'string' ? parsed.error : parsed.error.message ?? ''}`
    } catch { /* not JSON */ }
    yield { type: 'error', message: `API error ${response.status}${detail}` }
    return
  }

  if (!response.body) {
    clearTimeout(inactivityTimer)
    logger.warn('[LLM] No response body — response type:', typeof response.body)
    yield { type: 'error', message: 'No response body' }
    return
  }

  logger.info('[LLM] Stream body type:', typeof response.body, 'locked:', response.bodyUsed)

  // Parse SSE stream
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let yieldedContent = false

  logger.debug('[LLM] Stream content-type:', response.headers?.get('content-type'))

  // Accumulate tool call fragments across chunks. OpenAI streams tool calls
  // in pieces — the id usually arrives in the first delta, the name in the
  // same or next delta, and arguments trickle in across many deltas.
  // If the provider never sends an id (some OpenAI-compatible servers omit
  // it), we synthesize a stable fallback so downstream multi-turn tool flows
  // always have a non-empty tool_call_id.
  let nextSyntheticId = 0
  const toolCallAccum = new Map<number, { id: string; name: string; args: string }>()

  try {
    let chunkCount = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        logger.info('[LLM] Stream done after', chunkCount, 'chunks, remaining buffer:', buffer.length, 'chars')
        break
      }
      chunkCount++

      resetInactivity()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === STREAM_LINE_PREFIX.trim()) continue
        logger.debug('[LLM] SSE line:', trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed)
        if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') {
          // Emit any accumulated tool calls
          for (const [, tc] of toolCallAccum) {
            if (!tc.name) continue
            try {
              const args = JSON.parse(tc.args || '{}')
              yield { type: 'tool_call', call: { id: tc.id, name: tc.name, arguments: args } }
            } catch {
              logger.warn('[LLM] Failed to parse tool call args:', tc.args)
            }
          }
          yield { type: 'done' }
          return
        }
        if (!trimmed.startsWith(STREAM_LINE_PREFIX)) continue

        const json = trimmed.slice(STREAM_LINE_PREFIX.length).trimStart()
        try {
          const chunk = JSON.parse(json)
          const delta = chunk.choices?.[0]?.delta

          if (!delta) continue

          // Text content
          if (delta.content) {
            yieldedContent = true
            yield { type: 'delta', text: delta.content }
          }

          // Tool calls (accumulated across chunks)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, { id: `call_synth_${nextSyntheticId++}`, name: '', args: '' })
              }
              const accum = toolCallAccum.get(idx)!
              if (tc.id && accum.id.startsWith('call_synth_')) accum.id = tc.id
              if (tc.function?.name && !accum.name) accum.name = tc.function.name
              if (tc.function?.arguments) accum.args += tc.function.arguments
            }
          }

          // Check for finish_reason
          const finish = chunk.choices?.[0]?.finish_reason
          if (finish === 'tool_calls' || finish === 'stop') {
            // Emit accumulated tool calls
            for (const [, tc] of toolCallAccum) {
              if (tc.name) {
                try {
                  const args = JSON.parse(tc.args || '{}')
                  yield { type: 'tool_call', call: { id: tc.id, name: tc.name, arguments: args } }
                } catch {
                  logger.warn('[LLM] Failed to parse tool call args:', tc.args)
                }
              }
            }
            if (finish === 'stop' || finish === 'tool_calls') {
              yield { type: 'done' }
              return
            }
          }
        } catch {
          logger.debug('[LLM] Skipping unparseable SSE payload:', json)
        }
      }
    }
  } finally {
    clearTimeout(inactivityTimer)
    reader.releaseLock()
  }

  if (!yieldedContent && toolCallAccum.size === 0) {
    logger.warn('[LLM] Stream ended without producing any content or tool calls')
  }

  // Emit any remaining tool calls
  for (const [, tc] of toolCallAccum) {
    if (tc.name) {
      try {
        const args = JSON.parse(tc.args || '{}')
        yield { type: 'tool_call', call: { id: tc.id, name: tc.name, arguments: args } }
      } catch {
        // skip
      }
    }
  }
  yield { type: 'done' }
}

/**
 * Check if the LLM API is reachable and the configured model is available.
 *
 * Returns an object with connection status and an optional reason on failure,
 * so the UI can display a meaningful message (e.g. "model not found").
 */
export interface AvailabilityResult {
  ok: boolean
  reason?: string
}

export async function checkAvailability(config: DocentConfig): Promise<AvailabilityResult> {
  const url = `${config.apiUrl.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = {}
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await corsFetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      return { ok: false, reason: `Server returned ${res.status}` }
    }

    // Try to verify the configured model exists in the model list
    try {
      const body = await res.json() as { data?: { id?: string }[] }
      const models = body.data
      if (Array.isArray(models) && models.length > 0) {
        const modelIds = models.map(m => m.id ?? '')
        const found = modelIds.some(id =>
          id === config.model || id.includes(config.model),
        )
        if (!found) {
          return {
            ok: false,
            reason: `Connected, but model "${config.model}" not found. Available: ${modelIds.join(', ')}`,
          }
        }
      }
    } catch {
      // Could not parse model list — server is reachable, skip model check
    }

    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    logger.warn('[LLM] Connection test failed:', detail)
    reportError('llm', err)
    return { ok: false, reason: `Could not reach the server: ${detail}` }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Fetch the list of model IDs available at the configured API URL.
 * Returns an empty array if the endpoint is unreachable or returns no models.
 */
export async function fetchModels(config: DocentConfig): Promise<string[]> {
  const url = `${config.apiUrl.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = {}
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await corsFetch(url, { headers, signal: controller.signal })
    if (!res.ok) return []
    const body = await res.json() as { data?: { id?: string }[] }
    const models = body.data
    if (!Array.isArray(models)) return []
    return models.map(m => m.id ?? '').filter(Boolean).sort()
  } catch {
    return []
  } finally {
    clearTimeout(timeoutId)
  }
}
