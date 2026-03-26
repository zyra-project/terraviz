import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DocentConfig } from '../types'
import { streamChat, checkAvailability } from './llmProvider'
import type { LLMMessage, LLMTool, StreamChunk } from './llmProvider'

const testConfig: DocentConfig = {
  apiUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'test-model',
  enabled: true,
  readingLevel: 'general',
}

function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const data = lines.map(l => l + '\n').join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data))
      controller.close()
    },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('streamChat', () => {
  it('yields text deltas from SSE stream', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}',
      'data: {"choices":[{"delta":{"content":" world"},"index":0}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
    ]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: makeSSEStream(sseLines),
    }))

    const chunks: StreamChunk[] = []
    const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }]

    for await (const chunk of streamChat(messages, [], testConfig)) {
      chunks.push(chunk)
    }

    const deltas = chunks.filter(c => c.type === 'delta')
    expect(deltas).toHaveLength(2)
    expect((deltas[0] as any).text).toBe('Hello')
    expect((deltas[1] as any).text).toBe(' world')
    expect(chunks.some(c => c.type === 'done')).toBe(true)
  })

  it('yields tool calls from SSE stream', async () => {
    const sseLines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"load_dataset","arguments":"{\\"dataset_id\\":"}}]},"index":0}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"TEST_001\\"}"}}]},"index":0}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
    ]

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: makeSSEStream(sseLines),
    }))

    const chunks: StreamChunk[] = []
    const messages: LLMMessage[] = [{ role: 'user', content: 'show me ocean data' }]
    const tools: LLMTool[] = [{
      type: 'function',
      function: {
        name: 'load_dataset',
        description: 'Load a dataset',
        parameters: { type: 'object', properties: {} },
      },
    }]

    for await (const chunk of streamChat(messages, tools, testConfig)) {
      chunks.push(chunk)
    }

    const toolCalls = chunks.filter(c => c.type === 'tool_call')
    expect(toolCalls.length).toBeGreaterThan(0)
    const tc = toolCalls[0] as { type: 'tool_call'; call: { name: string; arguments: Record<string, unknown> } }
    expect(tc.call.name).toBe('load_dataset')
    expect(tc.call.arguments.dataset_id).toBe('TEST_001')
  })

  it('yields error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const chunks: StreamChunk[] = []
    for await (const chunk of streamChat([{ role: 'user', content: 'hi' }], [], testConfig)) {
      chunks.push(chunk)
    }

    expect(chunks.some(c => c.type === 'error')).toBe(true)
  })

  it('yields error on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
    }))

    const chunks: StreamChunk[] = []
    for await (const chunk of streamChat([{ role: 'user', content: 'hi' }], [], testConfig)) {
      chunks.push(chunk)
    }

    expect(chunks.some(c => c.type === 'error')).toBe(true)
  })

  it('sends Authorization header when API key is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: makeSSEStream(['data: [DONE]']),
    })
    vi.stubGlobal('fetch', fetchMock)

    const configWithKey = { ...testConfig, apiKey: 'sk-test-123' }
    const gen = streamChat([{ role: 'user', content: 'hi' }], [], configWithKey)
    for await (const _ of gen) { /* consume */ }

    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.headers.Authorization).toBe('Bearer sk-test-123')
  })

  it('omits Authorization header when no API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: makeSSEStream(['data: [DONE]']),
    })
    vi.stubGlobal('fetch', fetchMock)

    const gen = streamChat([{ role: 'user', content: 'hi' }], [], testConfig)
    for await (const _ of gen) { /* consume */ }

    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.headers.Authorization).toBeUndefined()
  })

  it('handles [DONE] signal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: makeSSEStream([
        'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}',
        'data: [DONE]',
      ]),
    }))

    const chunks: StreamChunk[] = []
    for await (const chunk of streamChat([{ role: 'user', content: 'hi' }], [], testConfig)) {
      chunks.push(chunk)
    }

    expect(chunks[chunks.length - 1].type).toBe('done')
  })
})

describe('checkAvailability', () => {
  it('returns ok when server responds and model is listed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'test-model' }] }),
    }))
    const result = await checkAvailability(testConfig)
    expect(result.ok).toBe(true)
  })

  it('returns not ok with reason when model is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'other-model' }] }),
    }))
    const result = await checkAvailability(testConfig)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('test-model')
    expect(result.reason).toContain('not found')
  })

  it('returns ok when model list cannot be parsed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error('bad json')),
    }))
    const result = await checkAvailability(testConfig)
    expect(result.ok).toBe(true)
  })

  it('returns not ok for failed response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    const result = await checkAvailability(testConfig)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('503')
  })

  it('returns not ok on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))
    const result = await checkAvailability(testConfig)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Could not reach')
  })
})
