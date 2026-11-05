// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultFeatures } from '../../../src/types/node-features'
import { NODE_FEATURES_CACHE_KEY } from '../v1/_lib/node-settings-store'
import { makeKV } from '../v1/_lib/test-helpers'
import { onRequestPost as transcribe } from './transcribe'
import { onRequestPost as synthesize } from './synthesize'
import { isVoiceKilled, arrayBufferToBase64, isAllowedOrigin, type VoiceEnv } from './_voice-lib'
import {
  streamConfigured,
  buildGatewayUrl,
  streamRefusal,
  onRequest as stream,
  MAX_STREAM_BYTES,
  MAX_STREAM_MS,
} from './stream'
import { resetOrbitGateForTests } from '../_lib/orbit-gate'

// The gate memoises per module instance; each case starts cold.
beforeEach(resetOrbitGateForTests)

const ORIGIN = 'https://preview.terraviz.pages.dev'
const URL_T = `${ORIGIN}/api/voice/transcribe`
const URL_S = `${ORIGIN}/api/voice/synthesize`

function ctx(request: Request, env: VoiceEnv) {
  return { request, env } as unknown as Parameters<typeof transcribe>[0]
}

/**
 * Build a fake Request. `Origin` is a forbidden request header so it
 * can't be set on a real `Request` in Node — mirror ingest.test and
 * hand-roll the bits the handlers read.
 */
function fakeReq(opts: {
  url: string
  origin?: string | null
  headers?: Record<string, string>
  arrayBuffer?: ArrayBuffer
  json?: unknown
}): Request {
  const h = new Map<string, string>()
  if (opts.origin) h.set('origin', opts.origin)
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k.toLowerCase(), v)
  return {
    url: opts.url,
    headers: {
      get: (n: string) => h.get(n.toLowerCase()) ?? null,
      has: (n: string) => h.has(n.toLowerCase()),
    },
    arrayBuffer: async () => opts.arrayBuffer ?? new ArrayBuffer(0),
    json: async () => opts.json,
  } as unknown as Request
}

function aiOk(result: Record<string, unknown>): VoiceEnv {
  return { AI: { run: async () => result } }
}

describe('_voice-lib', () => {
  it('isVoiceKilled honours deny values only', () => {
    expect(isVoiceKilled({ KILL_VOICE: '1' })).toBe(true)
    expect(isVoiceKilled({ KILL_VOICE: 'TRUE' })).toBe(true)
    expect(isVoiceKilled({ KILL_VOICE: 'off' })).toBe(false)
    expect(isVoiceKilled({})).toBe(false)
  })

  it('isAllowedOrigin accepts same-origin + localhost, rejects others', () => {
    expect(isAllowedOrigin(ORIGIN, URL_T)).toBe(true)
    expect(isAllowedOrigin('http://localhost:5173', URL_T)).toBe(true)
    expect(isAllowedOrigin('https://evil.example', URL_T)).toBe(false)
    expect(isAllowedOrigin(null, URL_T)).toBe(false)
  })

  it('arrayBufferToBase64 round-trips through atob', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 255])
    const b64 = arrayBufferToBase64(bytes.buffer)
    const back = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    expect([...back]).toEqual([...bytes])
  })
})

describe('transcribe', () => {
  const audio = new Uint8Array([1, 2, 3, 4]).buffer
  const req = (env: VoiceEnv, body: ArrayBuffer = audio, origin: string | null = ORIGIN) =>
    transcribe(ctx(fakeReq({ url: URL_T, origin, arrayBuffer: body }), env))

  it('rejects a foreign origin with 403', async () => {
    const res = await req(aiOk({ text: 'x' }), audio, 'https://evil.example')
    expect(res.status).toBe(403)
  })

  it('returns 503 voice_disabled when KILL_VOICE is set', async () => {
    const res = await req({ ...aiOk({ text: 'x' }), KILL_VOICE: '1' })
    expect(res.status).toBe(503)
    expect((await res.json() as { code: string }).code).toBe('voice_disabled')
  })

  it('returns 503 voice_unavailable when the AI binding is absent', async () => {
    const res = await req({})
    expect(res.status).toBe(503)
    expect((await res.json() as { code: string }).code).toBe('voice_unavailable')
  })

  it('400s on empty audio', async () => {
    const res = await req(aiOk({ text: 'x' }), new ArrayBuffer(0))
    expect(res.status).toBe(400)
  })

  it('transcribes audio to { text }', async () => {
    const res = await req(aiOk({ text: 'show me sea ice' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'show me sea ice' })
  })
})

describe('synthesize', () => {
  const req = (env: VoiceEnv, body: unknown, origin: string | null = ORIGIN) =>
    synthesize(ctx(fakeReq({ url: URL_S, origin, json: body }), env))

  it('400s when text is missing', async () => {
    const res = await req(aiOk({ audio: 'AAA' }), {})
    expect(res.status).toBe(400)
  })

  it('returns base64 audio for valid text (MeloTTS default)', async () => {
    let usedModel = ''
    const env: VoiceEnv = { AI: { run: async (m) => { usedModel = m; return { audio: 'QUJD' } } } }
    const res = await req(env, { text: 'Hello there.', lang: 'en-US' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ audio: 'QUJD', format: 'mp3' })
    expect(usedModel).toBe('@cf/myshell-ai/melotts')
  })

  it('routes to Aura when model: aura is requested', async () => {
    let usedModel = ''
    const env: VoiceEnv = { AI: { run: async (m) => { usedModel = m; return { audio: 'QUJD' } } } }
    await req(env, { text: 'Hi', model: 'aura' })
    expect(usedModel).toBe('@cf/deepgram/aura-1')
  })

  it('returns 503 when KILL_VOICE is set', async () => {
    const res = await req({ ...aiOk({ audio: 'AAA' }), KILL_VOICE: 'true' }, { text: 'Hi' })
    expect(res.status).toBe(503)
  })
})

describe('the node orbit feature gate', () => {
  /** A catalog KV whose cached feature map has Orbit turned off. */
  function orbitOff(): Pick<VoiceEnv, 'CATALOG_KV'> {
    const kv = makeKV()
    kv._store.set(NODE_FEATURES_CACHE_KEY, JSON.stringify({ ...defaultFeatures(), orbit: false }))
    return { CATALOG_KV: kv }
  }

  it('transcribe answers 403 feature_disabled and never runs the model', async () => {
    const run = vi.fn(async () => ({ text: 'x' }))
    const res = await transcribe(ctx(
      fakeReq({ url: URL_T, origin: ORIGIN, arrayBuffer: new Uint8Array([1, 2]).buffer }),
      { AI: { run }, ...orbitOff() },
    ))
    expect(res.status).toBe(403)
    expect((await res.json() as { code: string }).code).toBe('feature_disabled')
    expect(run).not.toHaveBeenCalled()
  })

  it('synthesize answers 403 feature_disabled and never runs the model', async () => {
    const run = vi.fn(async () => ({ audio: 'QUJD' }))
    const res = await synthesize(ctx(
      fakeReq({ url: URL_S, origin: ORIGIN, json: { text: 'Hi' } }),
      { AI: { run }, ...orbitOff() },
    ))
    expect(res.status).toBe(403)
    expect((await res.json() as { code: string }).code).toBe('feature_disabled')
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves KILL_VOICE in charge when both apply', async () => {
    // The kill switch carries the Retry-After the client cools down
    // on; the gate must not shadow it.
    const res = await synthesize(ctx(
      fakeReq({ url: URL_S, origin: ORIGIN, json: { text: 'Hi' } }),
      { ...aiOk({ audio: 'AAA' }), KILL_VOICE: '1', ...orbitOff() },
    ))
    expect(res.status).toBe(503)
    expect((await res.json() as { code: string }).code).toBe('voice_disabled')
  })

  it('refuses a foreign origin before reading the feature map', async () => {
    const env = { ...aiOk({ text: 'x' }), ...orbitOff() }
    const res = await transcribe(ctx(fakeReq({ url: URL_T, origin: 'https://evil.example' }), env))
    expect(res.status).toBe(403)
    expect(env.CATALOG_KV!.get).not.toHaveBeenCalled()
  })
})

describe('voice stream refusal order', () => {
  const CONFIGURED = { CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g', CF_AIG_TOKEN: 't' }
  const offKv = () => {
    const kv = makeKV()
    kv._store.set(NODE_FEATURES_CACHE_KEY, JSON.stringify({ ...defaultFeatures(), orbit: false }))
    return kv
  }

  it('opens for a configured node with Orbit on', async () => {
    expect(await streamRefusal(CONFIGURED, 'ip', () => false)).toBeNull()
  })

  it('refuses with feature_disabled and spends no rate allowance while Orbit is off', async () => {
    const limiter = vi.fn(() => false)
    expect(await streamRefusal({ ...CONFIGURED, CATALOG_KV: offKv() }, 'ip', limiter)).toBe('feature_disabled')
    expect(limiter).not.toHaveBeenCalled()
  })

  it('says feature_disabled rather than unconfigured on a node with neither', async () => {
    expect(await streamRefusal({ CATALOG_KV: offKv() }, 'ip', () => false)).toBe('feature_disabled')
  })

  it('leaves KILL_VOICE in charge when both apply', async () => {
    expect(await streamRefusal({ ...CONFIGURED, KILL_VOICE: '1', CATALOG_KV: offKv() }, 'ip', () => false))
      .toBe('voice_disabled')
  })

  it('refuses a foreign origin before reading the feature map', async () => {
    const kv = offKv()
    const request = fakeReq({
      url: `${ORIGIN}/api/voice/stream`,
      origin: 'https://evil.example',
      headers: { Upgrade: 'websocket' },
    })
    const res = await stream({ request, env: { ...CONFIGURED, CATALOG_KV: kv } } as unknown as Parameters<typeof stream>[0])
    expect(res.status).toBe(403)
    expect(kv.get).not.toHaveBeenCalled()
  })
})

describe('voice stream proxy helpers', () => {
  it('streamConfigured requires all three gateway settings', () => {
    expect(streamConfigured({})).toBe(false)
    expect(streamConfigured({ CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g' })).toBe(false)
    expect(streamConfigured({ CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g', CF_AIG_TOKEN: 't' })).toBe(true)
    // Whitespace-only counts as unset — otherwise the deploy looks
    // configured and every socket dies at the gateway instead.
    expect(streamConfigured({ CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g', CF_AIG_TOKEN: '  ' })).toBe(
      false,
    )
  })

  it('buildGatewayUrl targets Nova-3 linear16 16k with interim results + language', () => {
    const url = buildGatewayUrl({ CF_ACCOUNT_ID: 'acct', CF_AI_GATEWAY: 'gw', CF_AIG_TOKEN: 't' }, 'es-MX')
    // https, not wss: the URL goes to fetch(), which refuses wss:// in a Worker.
    expect(url.startsWith('https://gateway.ai.cloudflare.com/v1/acct/gw/workers-ai?')).toBe(true)
    expect(url).toContain('model=%40cf%2Fdeepgram%2Fnova-3')
    expect(url).toContain('encoding=linear16')
    expect(url).toContain('sample_rate=16000')
    expect(url).toContain('interim_results=true')
    expect(url).toContain('language=es') // base language only
  })

  it('buildGatewayUrl honours a model override', () => {
    const url = buildGatewayUrl({ CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g', CF_AIG_TOKEN: 't', VOICE_STREAM_MODEL: '@cf/deepgram/flux' }, 'en')
    expect(url).toContain('model=%40cf%2Fdeepgram%2Fflux')
  })

  it('buildGatewayUrl trims the account id, gateway name, and model', () => {
    // These land in the URL path, where a trailing newline routes
    // the socket somewhere that does not exist.
    const url = buildGatewayUrl(
      { CF_ACCOUNT_ID: ' acct\n', CF_AI_GATEWAY: 'gw ', CF_AIG_TOKEN: 't', VOICE_STREAM_MODEL: ' @cf/deepgram/flux\n' },
      'en',
    )
    expect(url.startsWith('https://gateway.ai.cloudflare.com/v1/acct/gw/workers-ai?')).toBe(true)
    expect(url).toContain('model=%40cf%2Fdeepgram%2Fflux')
  })
})

/**
 * The relay itself, which nothing exercised until it turned out never to
 * have relayed. Node has no workerd, so the stand-ins carry the two
 * runtime behaviours that broke it, each checked against workerd 1.20261023
 * through Miniflare:
 *
 * - `fetch()` refuses a `wss://` URL ("Fetch API cannot load"); an outbound
 *   WebSocket is `https://` plus `Upgrade: websocket`.
 * - From compatibility date 2026-03-17 a socket delivers a binary message as
 *   a `Blob` unless its `binaryType` is `'arraybuffer'`, and `send()` turns a
 *   Blob into the text "[object Blob]".
 *
 * `Response` is stubbed too: Node's refuses status 101.
 */
describe('voice stream relay', () => {
  class FakeSocket {
    binaryType: 'blob' | 'arraybuffer' = 'blob'
    accepted = false
    closed = false
    sent: unknown[] = []
    private listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>()
    accept(): void { this.accepted = true }
    addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
    }
    // The runtime's send() stringifies a Blob; record what it would put on the wire.
    send(data: unknown): void { this.sent.push(data instanceof Blob ? String(data) : data) }
    closeCode?: number
    closeReason?: string
    close(code?: number, reason?: string): void {
      this.closed = true
      this.closeCode = code
      this.closeReason = reason
    }
    /** The far end hanging up, or the socket erroring. */
    emit(type: 'close' | 'error'): void {
      for (const fn of this.listeners.get(type) ?? []) fn({})
    }
    /** A frame arriving from the far end, typed as the runtime would type it. */
    receive(data: Uint8Array | string): void {
      const ev = typeof data === 'string' || this.binaryType === 'arraybuffer'
        ? { data: typeof data === 'string' ? data : data.slice().buffer }
        : { data: new Blob([data.slice()]) }
      for (const fn of this.listeners.get('message') ?? []) fn(ev)
    }
  }

  const CONFIGURED = { CF_ACCOUNT_ID: 'a', CF_AI_GATEWAY: 'g', CF_AIG_TOKEN: 'tok' }
  let pairs: Array<{ client: FakeSocket; server: FakeSocket }>
  let upstream: FakeSocket
  let fetched: Array<{ url: string; headers: Record<string, string> }>
  // What the stand-in gateway answers: a socket by default, or a refusal.
  let gatewayAnswer: () => Promise<{ webSocket: FakeSocket | null; status?: number }>
  let ipCounter = 0

  beforeEach(() => {
    pairs = []
    upstream = new FakeSocket()
    fetched = []
    gatewayAnswer = async () => ({ webSocket: upstream, status: 101 })
    vi.stubGlobal('WebSocketPair', class {
      0: FakeSocket
      1: FakeSocket
      constructor() {
        const pair = { client: new FakeSocket(), server: new FakeSocket() }
        pairs.push(pair)
        this[0] = pair.client
        this[1] = pair.server
      }
    })
    vi.stubGlobal('fetch', async (url: string, init?: { headers?: Record<string, string> }) => {
      if (!/^https?:\/\//.test(url)) throw new TypeError(`Fetch API cannot load: ${url}`)
      fetched.push({ url, headers: init?.headers ?? {} })
      return gatewayAnswer()
    })
    vi.stubGlobal('Response', class {
      status: number
      webSocket: unknown
      constructor(_body: unknown, init?: { status?: number; webSocket?: unknown }) {
        this.status = init?.status ?? 200
        this.webSocket = init?.webSocket
      }
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  async function open(): Promise<{ res: { status: number; webSocket: unknown }; server: FakeSocket }> {
    const request = fakeReq({
      url: `${ORIGIN}/api/voice/stream?lang=en`,
      origin: ORIGIN,
      // A fresh address per case: the per-IP rate limiter is module state.
      headers: { Upgrade: 'websocket', 'CF-Connecting-IP': `203.0.113.${++ipCounter}` },
    })
    const res = await stream({ request, env: CONFIGURED } as unknown as Parameters<typeof stream>[0])
    return { res: res as unknown as { status: number; webSocket: unknown }, server: pairs[0]?.server }
  }

  it('opens the gateway socket over https with the secret, and relays rather than refusing', async () => {
    const { res, server } = await open()
    expect(fetched).toHaveLength(1)
    expect(fetched[0].url.startsWith('https://gateway.ai.cloudflare.com/v1/a/g/workers-ai?')).toBe(true)
    // Exactly these: nothing of the visitor's request (cookies, Origin, IP)
    // is forwarded, and the gateway is asked not to log the session.
    expect(fetched[0].headers).toEqual({
      Upgrade: 'websocket',
      'cf-aig-authorization': 'tok',
      'cf-aig-collect-log': 'false',
    })
    // A refusal sends one error frame and closes; the relay sends nothing yet.
    expect(pairs).toHaveLength(1)
    expect(server.sent).toEqual([])
    expect(server.closed).toBe(false)
    expect(res.status).toBe(101)
    expect(res.webSocket).toBe(pairs[0].client)
    expect(upstream.accepted).toBe(true)
  })

  it('relays an audio frame to the gateway as bytes, not as "[object Blob]"', async () => {
    const { server } = await open()
    server.receive(new Uint8Array([1, 2, 3]))
    expect(upstream.sent).toHaveLength(1)
    expect(upstream.sent[0]).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(upstream.sent[0] as ArrayBuffer))).toEqual([1, 2, 3])
  })

  it('relays a transcript back to the client unchanged', async () => {
    const { server } = await open()
    const transcript = JSON.stringify({ channel: { alternatives: [{ transcript: 'hello' }] }, is_final: true })
    upstream.receive(transcript)
    expect(server.sent).toEqual([transcript])
  })

  // Deepgram answers in JSON text, but the relay is an opaque pass-through,
  // so a binary frame coming back must arrive as bytes too.
  it('relays a binary frame from the gateway back as bytes', async () => {
    const { server } = await open()
    upstream.receive(new Uint8Array([9, 8, 7]))
    expect(server.sent).toHaveLength(1)
    expect(server.sent[0]).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(server.sent[0] as ArrayBuffer))).toEqual([9, 8, 7])
  })

  // A refused upgrade must still reach the client as an error frame, and
  // must now leave a trace in the server log, since a silent refusal is
  // what hid the wss:// bug. The trace names the status and nothing else:
  // not the token, not the account path in the URL.
  it('reports a gateway that refuses the upgrade, logging only its status', async () => {
    gatewayAnswer = async () => ({ webSocket: null, status: 401 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { server } = await open()
      expect(server.sent).toEqual([JSON.stringify({ type: 'error', code: 'upstream_unavailable' })])
      expect(server.closed).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      const logged = warn.mock.calls[0].join(' ')
      expect(logged).toContain('HTTP 401')
      expect(logged).not.toContain('tok')
      expect(logged).not.toContain('/v1/a/g')
    } finally {
      warn.mockRestore()
    }
  })

  describe('the per-stream cap', () => {
    afterEach(() => { vi.useRealTimers() })
    const ERROR_FRAME = /"type":"error"/

    it(`closes both sockets ${MAX_STREAM_MS} ms after opening, with 1008 and no error frame`, async () => {
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { server } = await open()
        vi.advanceTimersByTime(MAX_STREAM_MS - 1)
        expect(server.closed).toBe(false)
        vi.advanceTimersByTime(1)
        expect(server.closed).toBe(true)
        expect([server.closeCode, server.closeReason]).toEqual([1008, 'stream_limit'])
        expect(upstream.closed).toBe(true)
        // No error frame: that would cool the client down for the session.
        expect(server.sent.some((m) => typeof m === 'string' && ERROR_FRAME.test(m))).toBe(false)
        expect(warn.mock.calls.map((c) => c.join(' '))).toEqual(['[voice/stream] closed at the stream limit (time)'])
      } finally {
        warn.mockRestore()
      }
    })

    it(`relays audio up to ${MAX_STREAM_BYTES} bytes and closes on the frame that would cross it`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { server } = await open()
        const second = 2 * 16_000 // one second of linear16 at 16 kHz
        expect(MAX_STREAM_BYTES % second).toBe(0)
        for (let i = 0; i < MAX_STREAM_BYTES / second; i++) server.receive(new Uint8Array(second))
        expect(upstream.sent).toHaveLength(MAX_STREAM_BYTES / second)
        expect(server.closed).toBe(false)
        server.receive(new Uint8Array(1))
        expect(upstream.sent).toHaveLength(MAX_STREAM_BYTES / second) // the crossing frame is dropped
        expect([server.closeCode, server.closeReason]).toEqual([1008, 'stream_limit'])
        expect(upstream.closed).toBe(true)
        expect(warn.mock.calls.map((c) => c.join(' '))).toEqual(['[voice/stream] closed at the stream limit (bytes)'])
        // Nothing moves after the close, in either direction.
        upstream.receive('{"late":true}')
        expect(server.sent.some((m) => m === '{"late":true}')).toBe(false)
      } finally {
        warn.mockRestore()
      }
    })

    it('treats an ordinary hang-up as one: plain close, timer cancelled, nothing logged', async () => {
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { server } = await open()
        server.emit('close')
        expect(upstream.closed).toBe(true)
        expect(upstream.closeCode).toBeUndefined()
        expect(server.closeCode).toBeUndefined()
        // The lifetime timer is gone, so the limit never fires afterwards.
        vi.advanceTimersByTime(MAX_STREAM_MS * 2)
        expect(server.closeCode).toBeUndefined()
        expect(warn).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })

  it('reports a gateway fetch that throws, logging the error name but not its message', async () => {
    gatewayAnswer = async () => { throw new TypeError('network down for https://gateway.ai.cloudflare.com/v1/a/g/') }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { server } = await open()
      expect(server.sent).toEqual([JSON.stringify({ type: 'error', code: 'upstream_unavailable' })])
      expect(warn).toHaveBeenCalledTimes(1)
      const logged = warn.mock.calls[0].join(' ')
      expect(logged).toContain('TypeError')
      expect(logged).not.toContain('/v1/a/g')
    } finally {
      warn.mockRestore()
    }
  })
})
