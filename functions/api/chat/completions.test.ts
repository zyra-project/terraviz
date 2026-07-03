/**
 * Wire-level tests for the /api/chat/completions proxy's reply-envelope
 * handling.
 *
 * The latent bug this guards: the non-streaming and shim paths used to
 * read `result.response ?? ''` directly, which silently yields an empty
 * assistant message when the model answers in the OpenAI-compatible
 * `{ choices: [{ message: { content } }] }` envelope (llama-4-scout was
 * observed doing exactly that live during slice-C enrichment testing).
 * All paths now go through the shared `workers-ai-text` extractor.
 */

import { describe, expect, it, vi } from 'vitest'
import { onRequestPost } from './completions'

type AiRun = (model: string, inputs: Record<string, unknown>, options?: unknown) => Promise<unknown>

function ctx(opts: { body: unknown; run: AiRun }) {
  const url = 'https://localhost/api/chat/completions'
  // A stub rather than a real Request: happy-dom emulates the browser's
  // forbidden-header rules and silently strips `Origin`, which the route
  // requires for its CORS allowlist gate.
  const request = {
    url,
    method: 'POST',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'origin' ? 'http://localhost:5173' : null),
    },
    json: async () => opts.body,
  } as unknown as Request
  return {
    request,
    env: { AI: { run: opts.run } },
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/chat/completions',
  } as unknown as Parameters<typeof onRequestPost>[0]
}

const MESSAGES = [{ role: 'user', content: 'hi' }]

describe('POST /api/chat/completions — non-streaming envelope handling', () => {
  it('reads the classic { response } envelope', async () => {
    const run = vi.fn(async () => ({ response: 'classic reply' }))
    const res = await onRequestPost(ctx({ body: { messages: MESSAGES, stream: false }, run }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0].message.content).toBe('classic reply')
  })

  it('reads the OpenAI choices[].message.content envelope (scout drift)', async () => {
    const run = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: 'scout reply' } }],
    }))
    const res = await onRequestPost(ctx({ body: { messages: MESSAGES, stream: false }, run }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0].message.content).toBe('scout reply')
  })
})

describe('POST /api/chat/completions — tool shim envelope handling', () => {
  const TOOLS = [{ type: 'function', function: { name: 'load_dataset', parameters: {} } }]

  it('emits tool_calls SSE chunks from the OpenAI-nested envelope', async () => {
    const run = vi.fn(async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Loading that now.',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'load_dataset', arguments: '{"id":"DS1"}' } },
            ],
          },
        },
      ],
    }))
    const res = await onRequestPost(
      ctx({ body: { model: 'llama-4-scout', messages: MESSAGES, stream: true, tools: TOOLS }, run }),
    )
    expect(res.status).toBe(200)
    const sse = await res.text()
    expect(sse).toContain('"content":"Loading that now."')
    expect(sse).toContain('"name":"load_dataset"')
    expect(sse).toContain('"finish_reason":"tool_calls"')
  })

  it('still handles the classic top-level { response, tool_calls } shape', async () => {
    const run = vi.fn(async () => ({
      response: 'On it.',
      tool_calls: [{ name: 'load_dataset', arguments: { id: 'DS2' } }],
    }))
    const res = await onRequestPost(
      ctx({ body: { model: 'llama-4-scout', messages: MESSAGES, stream: true, tools: TOOLS }, run }),
    )
    expect(res.status).toBe(200)
    const sse = await res.text()
    expect(sse).toContain('"content":"On it."')
    expect(sse).toContain('"arguments":"{\\"id\\":\\"DS2\\"}"')
    expect(sse).toContain('"finish_reason":"tool_calls"')
  })
})
