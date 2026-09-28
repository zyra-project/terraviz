// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
import { EMPTY_STREAM_PROBE_TIMEOUT_MS, onRequestPost } from './completions'

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

describe('POST /api/chat/completions — upstream failures on the streaming path', () => {
  // `returnRawResponse: true` means a failed Workers AI call comes back as a
  // Response rather than a throw. Before this guard the transformer read that
  // error body as if it were SSE, skipped every line of it, and closed an empty
  // stream — which the client rendered as "the model said nothing": two
  // retries, the local engine, and a "check LLM settings" banner. On an
  // exhausted neuron budget that is the wrong story to tell an operator.
  function plainBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'llama-3.2-3b',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      ...overrides,
    }
  }

  it('turns an exhausted neuron budget into the typed 503 the SPA degrades on', async () => {
    const run = vi.fn(async () => new Response(
      JSON.stringify({
        error: '4006: you have used up your daily free allocation of 10,000 neurons',
      }),
      { status: 429 },
    ))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(503)
    const json = await res.json() as { error: { type: string; code: number; message: string } }
    expect(json.error.type).toBe('quota_exhausted')
    expect(json.error.code).toBe(4006)
    // The error the envelope carries, not the envelope.
    expect(json.error.message).toBe(
      '4006: you have used up your daily free allocation of 10,000 neurons',
    )
  })

  it('reads the Cloudflare errors[] envelope the same way', async () => {
    const run = vi.fn(async () => new Response(
      JSON.stringify({
        errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }],
        success: false,
      }),
      { status: 429 },
    ))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(503)
    const json = await res.json() as { error: { type: string; message: string } }
    expect(json.error.type).toBe('quota_exhausted')
    expect(json.error.message).toBe(
      '4006: you have used up your daily free allocation of 10,000 neurons',
    )
  })

  it('does not read a request id as a quota code', async () => {
    // Reported in review: run over the raw body, `\b4006\b` matched the
    // "4006" group of the request id and a missing model became a spent
    // budget. Only the error's own code and message are classified.
    const run = vi.fn(async () => new Response(
      '{"errors":[{"code":5007,"message":"No such model"}],' +
        '"request_id":"9f1c2b7a-3e5d-4006-8a1b-2c3d4e5f6a7b"}',
      { status: 400 },
    ))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(502)
    const json = await res.json() as { error: { type: string; message: string } }
    expect(json.error.type).toBe('server_error')
    expect(json.error.message).toBe('5007: No such model')
  })

  it('reports any other upstream failure as a 502, with what the upstream said', async () => {
    // Deliberately not a quota signal: the classifier is conservative about
    // load-shedding, which is a wait-for-the-incident answer, not an upgrade one.
    const run = vi.fn(async () => new Response(
      'Capacity temporarily exceeded for this model',
      { status: 503 },
    ))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(502)
    const json = await res.json() as { error: { type: string; message: string } }
    expect(json.error.type).toBe('server_error')
    expect(json.error.message).toContain('Capacity temporarily exceeded')
  })

  // The production signature: 200, `text/event-stream`, a body that closes
  // without a byte in it. Not `new Response('')`, which has no body at all and
  // takes the older `!response.body` branch instead.
  function emptyStream(): Response {
    return new Response(new ReadableStream({ start(controller) { controller.close() } }))
  }

  it('classifies an empty upstream stream as quota when the budget is spent', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(emptyStream())
      .mockRejectedValueOnce(
        new Error('4006: you have used up your daily free allocation of 10,000 neurons'),
      )

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(503)
    const json = await res.json() as { error: { type: string; code: number } }
    expect(json.error.type).toBe('quota_exhausted')
    expect(json.error.code).toBe(4006)
    // The classification is a second, 1-token call — and only on this path.
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not blame the budget for an empty stream it cannot explain', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(emptyStream())
      .mockResolvedValueOnce({ response: 'ok' })

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(502)
    const json = await res.json() as { error: { type: string; message: string } }
    expect(json.error.type).toBe('server_error')
    expect(json.error.message).toContain('empty stream')
  })

  it('reports a probe failure that is not quota as a 502 with its message', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(emptyStream())
      .mockRejectedValueOnce(new Error('Service temporarily unavailable'))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(502)
    const json = await res.json() as { error: { type: string; message: string } }
    expect(json.error.type).toBe('server_error')
    expect(json.error.message).toBe('Service temporarily unavailable')
  })

  it('gives up on a probe that does not answer and reports the empty stream', async () => {
    // The probe only exists to tell a spent budget (rejected at once) from
    // anything else; a hanging one must not hold the request open.
    vi.useFakeTimers()
    try {
      const run = vi.fn()
        .mockResolvedValueOnce(emptyStream())
        .mockReturnValueOnce(new Promise(() => {}))

      let settled = false
      const pending = Promise.resolve(onRequestPost(ctx({ body: plainBody(), run })))
        .finally(() => { settled = true })

      await vi.advanceTimersByTimeAsync(EMPTY_STREAM_PROBE_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const res = await pending

      expect(res.status).toBe(502)
      const json = await res.json() as { error: { type: string; message: string } }
      expect(json.error.type).toBe('server_error')
      expect(json.error.message).toBe('Workers AI returned an empty stream')
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a 200 with no body at all as an empty stream', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(new Response(null))
      .mockRejectedValueOnce(
        new Error('4006: you have used up your daily free allocation of 10,000 neurons'),
      )

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(503)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('quota_exhausted')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('cancels the upstream body before reporting it empty', async () => {
    const cancel = vi.fn()
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.close() },
      cancel,
    })
    // `cancel` on a closed stream is a no-op in the spec, so observe the
    // reader call itself.
    const response = new Response(upstream)
    const reader = response.body!.getReader()
    const readerCancel = vi.spyOn(reader, 'cancel')
    vi.spyOn(response.body!, 'getReader').mockReturnValue(reader)
    const run = vi.fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ response: 'ok' })

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(502)
    expect(readerCancel).toHaveBeenCalledTimes(1)
  })

  it('leaves a healthy raw stream alone', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"response":"still streaming"}\n\ndata: [DONE]\n\n',
        ))
        controller.close()
      },
    })
    const run = vi.fn(async () => new Response(stream))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toContain('"content":"still streaming"')
    expect(text).toContain('data: [DONE]')
    // No probe on the healthy path.
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not mistake a zero-length first chunk for an empty stream', async () => {
    // "Empty" is "closed without a byte", not "the first read had none".
    const run = vi.fn(async () => new Response(upstreamOf([
      new Uint8Array(0),
      'data: {"response":"late but real"}\n\ndata: [DONE]\n\n',
    ])))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(200)
    expect(contentOf(await res.text())).toBe('late but real')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('streams a body with bytes but no tokens as is', async () => {
    // Records an assumption rather than a feature: the spent-budget signal
    // observed in production is an *empty* body. An in-band error event has
    // not been seen, so it is passed through (and the client treats the
    // tokenless answer as a failed attempt) rather than guessed at.
    const run = vi.fn(async () => new Response(upstreamOf([
      'data: {"error":"4006: you have used up your daily free allocation"}\n\n',
    ])))

    const res = await onRequestPost(ctx({ body: plainBody(), run }))

    expect(res.status).toBe(200)
    expect(contentOf(await res.text())).toBe('')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

/** A raw upstream body that hands out one chunk per read. */
function upstreamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const queue = chunks.map(c => (typeof c === 'string' ? new TextEncoder().encode(c) : c))
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
  })
}

/** The concatenated `delta.content` of an OpenAI-format SSE body. */
function contentOf(sse: string): string {
  return sse
    .split('\n')
    .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map(l => (JSON.parse(l.slice(6)) as { choices: Array<{ delta: { content?: string } }> })
      .choices[0].delta.content ?? '')
    .join('')
}

describe('POST /api/chat/completions — streaming transform', () => {
  const body = { model: 'llama-3.2-3b', stream: true, messages: MESSAGES }

  it('reassembles an SSE event split across upstream chunks', async () => {
    const run = vi.fn(async () => new Response(upstreamOf([
      'data: {"response":"Hel',
      'lo"}\n\ndata: {"response":" world"}\n\n',
      'data: [DONE]\n\n',
    ])))

    const res = await onRequestPost(ctx({ body, run }))

    expect(res.status).toBe(200)
    expect(contentOf(await res.text())).toBe('Hello world')
  })

  it('keeps a read loop moving past chunks that carry no token', async () => {
    // A pull() that enqueues nothing is not called again for a read already
    // waiting on it, so a usage-only or keep-alive chunk used to leave the
    // client's read pending forever. Each read here is issued only after the
    // previous pull has settled, which is what exposed it.
    const run = vi.fn(async () => new Response(upstreamOf([
      'data: {"response":"Hi"}\n\n',
      'data: {"response":"","usage":{"prompt_tokens":3}}\n\n',
      ': keep-alive\n\n',
      'data: {"response":" there"}\n\n',
      'data: [DONE]\n\n',
    ])))

    const res = await onRequestPost(ctx({ body, run }))
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let sse = ''
    for (;;) {
      await new Promise(r => setTimeout(r, 0))
      const next = await Promise.race([
        reader.read(),
        new Promise<'stalled'>(r => setTimeout(() => r('stalled'), 500)),
      ])
      if (next === 'stalled') throw new Error(`read stalled after ${JSON.stringify(sse)}`)
      if (next.done) break
      sse += decoder.decode(next.value, { stream: true })
    }

    expect(contentOf(sse)).toBe('Hi there')
    expect(sse).toContain('data: [DONE]')
  })

  it('cancels the upstream stream when the client goes away', async () => {
    const encoder = new TextEncoder()
    const upstreamCancel = vi.fn()
    let sent = false
    // One token, then an upstream still generating: the next read never
    // settles, as with a model partway through its answer.
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return new Promise<void>(() => {})
        sent = true
        controller.enqueue(encoder.encode('data: {"response":"Hi"}\n\n'))
      },
      cancel: upstreamCancel,
    })
    const run = vi.fn(async () => new Response(upstream))

    const res = await onRequestPost(ctx({ body, run }))
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(contentOf(new TextDecoder().decode(first.value))).toBe('Hi')

    await reader.cancel('client gone')

    expect(upstreamCancel).toHaveBeenCalledWith('client gone')
  })

  it('flushes a final event that arrives without a trailing newline', async () => {
    const run = vi.fn(async () => new Response(upstreamOf([
      'data: {"response":"no newline"}',
    ])))

    const res = await onRequestPost(ctx({ body, run }))

    expect(contentOf(await res.text())).toBe('no newline')
  })
})

describe('POST /api/chat/completions — tool shim failures', () => {
  const TOOLS = [{ type: 'function', function: { name: 'load_dataset', parameters: {} } }]
  const body = { model: 'llama-4-scout', messages: MESSAGES, stream: true, tools: TOOLS }

  it('reports a spent budget with the same typed 503 as the streaming path', async () => {
    const run = vi.fn(async () => {
      throw new Error('4006: you have used up your daily free allocation of 10,000 neurons')
    })

    const res = await onRequestPost(ctx({ body, run }))

    expect(res.status).toBe(503)
    const json = await res.json() as { error: { type: string; code: number } }
    expect(json.error.type).toBe('quota_exhausted')
    expect(json.error.code).toBe(4006)
  })

  it('reports anything else as the same 502 server_error', async () => {
    const run = vi.fn(async () => {
      throw new Error('Service temporarily unavailable')
    })

    const res = await onRequestPost(ctx({ body, run }))

    expect(res.status).toBe(502)
    const json = await res.json() as { error: { type: string; message: string } }
    expect(json.error.type).toBe('server_error')
    expect(json.error.message).toBe('Service temporarily unavailable')
  })

  it('classifies a thrown JSON error body by its error, not its request id', async () => {
    const run = vi.fn(async () => {
      throw new Error(
        '{"errors":[{"code":5007,"message":"No such model"}],' +
          '"request_id":"9f1c2b7a-3e5d-4006-8a1b-2c3d4e5f6a7b"}',
      )
    })

    const res = await onRequestPost(ctx({ body, run }))

    expect(res.status).toBe(502)
    const json = await res.json() as { error: { message: string } }
    expect(json.error.message).toBe('5007: No such model')
  })
})
