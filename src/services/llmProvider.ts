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

// --- Types ---

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LLMTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LLMToolCall {
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
const STREAM_LINE_PREFIX = 'data: '

/**
 * Stream a chat completion from an OpenAI-compatible API.
 * Yields text deltas and tool calls as they arrive.
 */
export async function* streamChat(
  messages: LLMMessage[],
  tools: LLMTool[],
  config: DocentConfig,
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
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
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

  clearTimeout(timeout)

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.warn(`[LLM] API error ${response.status}:`, text)
    yield { type: 'error', message: `API error: ${response.status}` }
    return
  }

  if (!response.body) {
    yield { type: 'error', message: 'No response body' }
    return
  }

  // Parse SSE stream
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // Accumulate tool call fragments across chunks
  const toolCallAccum = new Map<number, { name: string; args: string }>()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === STREAM_LINE_PREFIX.trim()) continue
        if (trimmed === 'data: [DONE]') {
          // Emit any accumulated tool calls
          for (const [, tc] of toolCallAccum) {
            try {
              const args = JSON.parse(tc.args || '{}')
              yield { type: 'tool_call', call: { name: tc.name, arguments: args } }
            } catch {
              logger.warn('[LLM] Failed to parse tool call args:', tc.args)
            }
          }
          yield { type: 'done' }
          return
        }
        if (!trimmed.startsWith(STREAM_LINE_PREFIX)) continue

        const json = trimmed.slice(STREAM_LINE_PREFIX.length)
        try {
          const chunk = JSON.parse(json)
          const delta = chunk.choices?.[0]?.delta

          if (!delta) continue

          // Text content
          if (delta.content) {
            yield { type: 'delta', text: delta.content }
          }

          // Tool calls (accumulated across chunks)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, { name: '', args: '' })
              }
              const accum = toolCallAccum.get(idx)!
              if (tc.function?.name) accum.name += tc.function.name
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
                  yield { type: 'tool_call', call: { name: tc.name, arguments: args } }
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
          // Skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Emit any remaining tool calls
  for (const [, tc] of toolCallAccum) {
    if (tc.name) {
      try {
        const args = JSON.parse(tc.args || '{}')
        yield { type: 'tool_call', call: { name: tc.name, arguments: args } }
      } catch {
        // skip
      }
    }
  }
  yield { type: 'done' }
}

/**
 * Check if the LLM API is reachable.
 */
export async function checkAvailability(config: DocentConfig): Promise<boolean> {
  const url = `${config.apiUrl.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = {}
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}
