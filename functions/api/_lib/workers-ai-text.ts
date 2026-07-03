/**
 * Workers AI reply-envelope extraction, shared by every server-side
 * consumer of `env.AI.run()` (the Orbit chat proxy, current-events
 * enrichment, event-tour caption generation).
 *
 * Workers AI is not uniform across model generations: classic models
 * answer `{ response: string }`, JSON-mode replies can arrive as
 * `{ response: object }` (already parsed), and newer models use the
 * OpenAI-compatible `{ choices: [{ message: { content, tool_calls } }] }`
 * shape (llama-4-scout does, observed live on the preview deployment
 * during slice-C enrichment testing). Reading `result.response` alone
 * silently yields empty text on the newer envelope — the bug this
 * module exists to prevent recurring one call site at a time.
 */

/** Pull the reply text out of whatever envelope the model returned.
 *  Returns null for anything unrecognisable. */
export function extractModelText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw || null
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.response === 'string') return r.response || null
  // JSON mode — the reply arrives pre-parsed; re-serialize for the
  // shared extraction path.
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response)
  const choices = r.choices
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const msg = (choices[0] as Record<string, unknown>).message
    const content = msg && typeof msg === 'object' ? (msg as Record<string, unknown>).content : undefined
    if (typeof content === 'string') return content || null
  }
  if (typeof r.output_text === 'string') return r.output_text || null
  return null
}

/** A tool call in either shape Workers AI has been observed to emit:
 *  llama-4-scout wraps `{ id, type, function: { name, arguments } }`,
 *  llama-3.3-70b emits bare `{ name, arguments }`. */
export interface WorkersAiToolCall {
  id?: string
  type?: string
  function?: { name: string; arguments: unknown }
  name?: string
  arguments?: Record<string, unknown> | string
}

/** Pull the tool calls out of the envelope: top-level `tool_calls`
 *  (the classic Workers AI shape) or nested under
 *  `choices[0].message.tool_calls` (the OpenAI-compatible shape).
 *  Returns null when the reply carries none. */
export function extractModelToolCalls(raw: unknown): WorkersAiToolCall[] | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (Array.isArray(r.tool_calls)) return r.tool_calls as WorkersAiToolCall[]
  const choices = r.choices
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const msg = (choices[0] as Record<string, unknown>).message
    if (msg && typeof msg === 'object') {
      const toolCalls = (msg as Record<string, unknown>).tool_calls
      if (Array.isArray(toolCalls)) return toolCalls as WorkersAiToolCall[]
    }
  }
  return null
}
