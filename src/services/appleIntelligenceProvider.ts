/**
 * Apple Intelligence Provider — on-device LLM via the Foundation Models framework.
 *
 * This module provides the same `StreamChunk` async-generator interface as
 * `llmProvider.streamChat`, but instead of making an HTTP request to an
 * OpenAI-compatible server, it calls the `apple-intelligence` Tauri plugin
 * which wraps Apple's `SystemLanguageModel` on iOS 26+ / macOS 26+.
 *
 * The provider is only available on Apple Intelligence-capable devices
 * (iPhone 15 Pro+, iPhone 16/17, M-series iPads/Macs) running the Tauri
 * native app. On all other platforms, `isAvailable()` returns false and
 * `docentService` falls back to the OpenAI-compatible HTTP provider.
 *
 * Architecture:
 *   JS (this file)  →  invoke('plugin:apple-intelligence|chat')  →  Rust shim
 *     →  Swift AppleIntelligencePlugin  →  FoundationModels.SystemLanguageModel
 *     →  Tauri events (ai-delta, ai-tool-call, ai-done, ai-error)  →  JS yields StreamChunk
 */

import type { LLMMessage, LLMTool, StreamChunk } from './llmProvider'
import { logger } from '../utils/logger'

// --- Lazy Tauri imports (same pattern as downloadService.ts) ---

const IS_TAURI = typeof window !== 'undefined' && !!(window as any).__TAURI__

let invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null
let listen: ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null

const tauriReady: Promise<boolean> = IS_TAURI
  ? Promise.all([
    import('@tauri-apps/api/core').then(m => { invoke = m.invoke }),
    import('@tauri-apps/api/event').then(m => { listen = m.listen }),
  ]).then(() => true).catch(() => false)
  : Promise.resolve(false)

// --- Availability ---

/** Cached availability result — checked once per app lifecycle. */
let availabilityCache: boolean | null = null

/**
 * Check whether the Apple Intelligence on-device model is available.
 *
 * Returns true only when ALL of the following are true:
 * - Running inside a Tauri native app (not the web build)
 * - Running on iOS 26+ or macOS 26+ (Foundation Models framework present)
 * - The device supports Apple Intelligence (A17 Pro+, M-series)
 * - Apple Intelligence is enabled in the device settings
 * - The `apple-intelligence` Tauri plugin is registered
 *
 * The result is cached after the first check — availability doesn't change
 * during an app session.
 */
export async function isAvailable(): Promise<boolean> {
  if (availabilityCache !== null) return availabilityCache

  if (!IS_TAURI) {
    availabilityCache = false
    return false
  }

  await tauriReady
  if (!invoke) {
    availabilityCache = false
    return false
  }

  try {
    const result = await invoke('plugin:apple-intelligence|is_available') as {
      available: boolean
      reason?: string
    }
    availabilityCache = result.available
    if (!result.available && result.reason) {
      logger.info(`[AppleIntelligence] Not available: ${result.reason}`)
    } else if (result.available) {
      logger.info('[AppleIntelligence] On-device model is available')
    }
    return result.available
  } catch (err) {
    logger.warn('[AppleIntelligence] Plugin not registered or invoke failed:', err)
    availabilityCache = false
    return false
  }
}

// --- Streaming ---

/** Event payload shapes emitted by the Swift plugin during a chat session. */
interface AIDeltaEvent {
  session_id: string
  text: string
}

interface AIToolCallEvent {
  session_id: string
  id: string
  name: string
  arguments: Record<string, unknown>
}

interface AIDoneEvent {
  session_id: string
}

interface AIErrorEvent {
  session_id: string
  message: string
}

/**
 * Stream a chat completion from the on-device Apple Intelligence model.
 *
 * Yields the same `StreamChunk` union as `llmProvider.streamChat` so
 * `docentService.processMessage` can use either provider interchangeably.
 *
 * The streaming flow:
 * 1. Call `plugin:apple-intelligence|chat` with serialized messages + tools
 * 2. The Swift plugin creates a `LanguageModelSession`, starts streaming
 * 3. Swift emits Tauri events: `ai-delta`, `ai-tool-call`, `ai-done`, `ai-error`
 * 4. This generator listens for those events and yields `StreamChunk`s
 * 5. On `ai-done` or `ai-error`, the generator returns
 *
 * The `config` parameter is not used for API URL/key (there is no server),
 * but `readingLevel` and other fields flow through the system prompt which
 * is built by the caller before reaching this function.
 */
export async function* streamChatLocal(
  messages: LLMMessage[],
  tools: LLMTool[],
  options?: { timeoutMs?: number },
): AsyncGenerator<StreamChunk> {
  await tauriReady
  if (!invoke || !listen) {
    yield { type: 'error', message: 'Apple Intelligence plugin not available' }
    return
  }

  // Generate a unique session ID so we can filter events from concurrent
  // sessions (defensive — in practice only one chat streams at a time).
  const sessionId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const timeoutMs = options?.timeoutMs ?? 60000

  // Set up a promise-based queue: events push chunks, the generator pulls them.
  const queue: StreamChunk[] = []
  let resolve: (() => void) | null = null
  let done = false

  const push = (chunk: StreamChunk) => {
    queue.push(chunk)
    if (resolve) {
      resolve()
      resolve = null
    }
  }

  // Subscribe to all event types before starting the chat
  const unlisteners: Array<() => void> = []
  try {
    unlisteners.push(await listen('ai-delta', (e) => {
      const p = e.payload as AIDeltaEvent
      if (p.session_id !== sessionId) return
      push({ type: 'delta', text: p.text })
    }))

    unlisteners.push(await listen('ai-tool-call', (e) => {
      const p = e.payload as AIToolCallEvent
      if (p.session_id !== sessionId) return
      push({ type: 'tool_call', call: { id: p.id, name: p.name, arguments: p.arguments } })
    }))

    unlisteners.push(await listen('ai-done', (e) => {
      const p = e.payload as AIDoneEvent
      if (p.session_id !== sessionId) return
      done = true
      push({ type: 'done' })
    }))

    unlisteners.push(await listen('ai-error', (e) => {
      const p = e.payload as AIErrorEvent
      if (p.session_id !== sessionId) return
      done = true
      push({ type: 'error', message: p.message })
    }))
  } catch (err) {
    for (const unlisten of unlisteners) unlisten()
    yield { type: 'error', message: 'Failed to subscribe to Apple Intelligence events' }
    return
  }

  // Start the chat — the Swift plugin begins streaming events
  try {
    logger.info('[AppleIntelligence] Starting chat session:', sessionId)
    invoke('plugin:apple-intelligence|chat', {
      sessionId,
      messages: serializeMessages(messages),
      tools: serializeTools(tools),
    }).catch(err => {
      // If the invoke itself fails (not a streaming error), push an error event
      if (!done) {
        done = true
        push({ type: 'error', message: `Plugin invoke failed: ${err}` })
      }
    })
  } catch (err) {
    for (const unlisten of unlisteners) unlisten()
    yield { type: 'error', message: `Failed to start chat: ${err}` }
    return
  }

  // Yield chunks as they arrive from events
  const timeoutAt = Date.now() + timeoutMs
  try {
    while (!done) {
      // Drain any queued chunks
      while (queue.length > 0) {
        const chunk = queue.shift()!
        yield chunk
        if (chunk.type === 'done' || chunk.type === 'error') return
      }

      // Wait for the next event or timeout
      const remaining = timeoutAt - Date.now()
      if (remaining <= 0) {
        done = true
        yield { type: 'error', message: 'Apple Intelligence response timed out' }
        return
      }

      await Promise.race([
        new Promise<void>(r => { resolve = r }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
      ]).catch(() => {
        if (!done) {
          done = true
          push({ type: 'error', message: 'Apple Intelligence response timed out' })
        }
      })
    }

    // Drain remaining
    while (queue.length > 0) {
      yield queue.shift()!
    }
  } finally {
    // Clean up event listeners
    for (const unlisten of unlisteners) unlisten()
  }
}

// --- Serialization helpers ---

/**
 * Convert LLMMessage[] to a shape the Swift plugin expects. Strips image
 * content parts (Foundation Models doesn't accept images in the same way
 * as OpenAI) and flattens multipart content to plain text.
 */
function serializeMessages(messages: LLMMessage[]): Array<{
  role: string
  content: string
  tool_calls?: unknown[]
  tool_call_id?: string
}> {
  return messages.map(m => {
    let content: string
    if (typeof m.content === 'string') {
      content = m.content
    } else if (Array.isArray(m.content)) {
      // Flatten multipart to text-only (Foundation Models is text-only for now)
      content = m.content
        .filter(p => p.type === 'text')
        .map(p => (p as { text: string }).text)
        .join('\n')
    } else {
      content = ''
    }

    const msg: Record<string, unknown> = { role: m.role, content }
    if (m.tool_calls) msg.tool_calls = m.tool_calls
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
    return msg as ReturnType<typeof serializeMessages>[number]
  })
}

/**
 * Convert LLMTool[] to a stable plugin-facing shape for forward compatibility.
 * The current Swift implementation does not consume tools in v1 (Phase 3's
 * pre-search handles discovery), but we preserve this serialization so the
 * payload schema is ready if native tool registration is added later.
 */
function serializeTools(tools: LLMTool[]): Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
}> {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }))
}
