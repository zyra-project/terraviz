import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWsStreamingSttEngine, __resetWsStreamingDisabled, type WsLike, type StartPcmCapture } from './voiceWsStreaming'

const ALL_CAPS = { webSpeechStt: true, speechSynthesis: true, mediaRecorder: true, getUserMedia: true }

// The session-scoped cooldown is module state shared across instances.
beforeEach(() => { __resetWsStreamingDisabled() })

function makeFakeSocket() {
  const sent: Array<ArrayBuffer | string> = []
  let closed = false
  const sock: WsLike = {
    binaryType: '',
    readyState: 1,
    send: (d) => sent.push(d),
    close: () => { if (closed) return; closed = true; sock.onclose?.() },
    onopen: null, onmessage: null, onerror: null, onclose: null,
  }
  return { sock, sent, get closed() { return closed } }
}

function makeFakeCapture() {
  let onFrame: ((pcm: ArrayBuffer) => void) | null = null
  let stopped = false
  const startCapture: StartPcmCapture = (_stream, cb) => {
    onFrame = cb
    return { stop: () => { stopped = true } }
  }
  return { startCapture, frame: (buf: ArrayBuffer) => onFrame?.(buf), get stopped() { return stopped }, get started() { return onFrame !== null } }
}

const dummyStream = {} as MediaStream

describe('ws streaming engine — metadata', () => {
  it('declares the cloud provider and curated language coverage', () => {
    const engine = createWsStreamingSttEngine()
    expect(engine.provider).toBe('cloud')
    expect(engine.supportsLanguage('en')).toBe(true)
    expect(engine.supportsLanguage('kab')).toBe(false)
    expect(engine.isAvailable(ALL_CAPS)).toBe(true)
    expect(engine.isAvailable({ ...ALL_CAPS, getUserMedia: false })).toBe(false)
  })
})

describe('ws streaming engine — transport', () => {
  it('starts capture on open and streams PCM frames over the socket', () => {
    const fakeSock = makeFakeSocket()
    const fakeCap = makeFakeCapture()
    const engine = createWsStreamingSttEngine({ createSocket: () => fakeSock.sock, startCapture: fakeCap.startCapture })
    engine.startStreaming({ lang: 'en', stream: dummyStream, onTurn: () => {}, onError: () => {} })

    expect(fakeCap.started).toBe(false) // not until the socket opens
    fakeSock.sock.onopen?.()
    expect(fakeCap.started).toBe(true)
    expect(fakeSock.sock.binaryType).toBe('arraybuffer')

    fakeCap.frame(new ArrayBuffer(8))
    fakeCap.frame(new ArrayBuffer(8))
    expect(fakeSock.sent).toHaveLength(2)
  })

  it('emits partials for interim results and a turn on is_final', () => {
    const fakeSock = makeFakeSocket()
    const engine = createWsStreamingSttEngine({ createSocket: () => fakeSock.sock, startCapture: makeFakeCapture().startCapture })
    const partials: string[] = []
    const turns: string[] = []
    engine.startStreaming({ lang: 'en', stream: dummyStream, onPartial: (t) => partials.push(t), onTurn: (t) => turns.push(t), onError: () => {} })
    fakeSock.sock.onopen?.()

    fakeSock.sock.onmessage?.({ data: JSON.stringify({ channel: { alternatives: [{ transcript: 'show' }] }, is_final: false }) })
    fakeSock.sock.onmessage?.({ data: JSON.stringify({ channel: { alternatives: [{ transcript: 'show me' }] }, is_final: false }) })
    fakeSock.sock.onmessage?.({ data: JSON.stringify({ channel: { alternatives: [{ transcript: 'show me sea ice' }] }, is_final: true }) })
    // Non-transcript frames are ignored.
    fakeSock.sock.onmessage?.({ data: '{"type":"Metadata"}' })

    expect(partials).toEqual(['show', 'show me'])
    expect(turns).toEqual(['show me sea ice'])
  })

  it('stop tears down capture + socket and fires onEnd once', () => {
    const fakeSock = makeFakeSocket()
    const fakeCap = makeFakeCapture()
    const onEnd = vi.fn()
    const engine = createWsStreamingSttEngine({ createSocket: () => fakeSock.sock, startCapture: fakeCap.startCapture })
    const session = engine.startStreaming({ lang: 'en', stream: dummyStream, onTurn: () => {}, onError: () => {}, onEnd })
    fakeSock.sock.onopen?.()

    session.stop()
    expect(fakeCap.stopped).toBe(true)
    expect(fakeSock.closed).toBe(true)
    expect(onEnd).toHaveBeenCalledTimes(1)

    // Idempotent — a late onclose doesn't double-fire onEnd.
    fakeSock.sock.onclose?.()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('reports a socket error and ends', () => {
    const fakeSock = makeFakeSocket()
    const onError = vi.fn()
    const onEnd = vi.fn()
    const engine = createWsStreamingSttEngine({ createSocket: () => fakeSock.sock, startCapture: makeFakeCapture().startCapture })
    engine.startStreaming({ lang: 'en', stream: dummyStream, onTurn: () => {}, onError, onEnd })
    fakeSock.sock.onerror?.()
    expect(onError).toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('fails fast (onError + onEnd, no socket) when no mic stream is provided', () => {
    const createSocket = vi.fn()
    const onError = vi.fn()
    const onEnd = vi.fn()
    const engine = createWsStreamingSttEngine({ createSocket, startCapture: makeFakeCapture().startCapture })
    const session = engine.startStreaming({ lang: 'en', onTurn: () => {}, onError, onEnd })

    expect(createSocket).not.toHaveBeenCalled() // no idle connection
    expect(onError).toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledTimes(1)
    // The returned handles are inert no-ops.
    expect(() => { session.stop(); session.abortTurn() }).not.toThrow()
  })

  it('cools down and ends on a proxy error frame, going unavailable for the session', () => {
    const fakeSock = makeFakeSocket()
    const onError = vi.fn()
    const onEnd = vi.fn()
    const engine = createWsStreamingSttEngine({ createSocket: () => fakeSock.sock, startCapture: makeFakeCapture().startCapture })
    expect(engine.isAvailable(ALL_CAPS)).toBe(true)

    engine.startStreaming({ lang: 'en', stream: dummyStream, onTurn: () => {}, onError, onEnd })
    fakeSock.sock.onopen?.()
    fakeSock.sock.onmessage?.({ data: JSON.stringify({ type: 'error', code: 'voice_disabled' }) })

    expect(onError).toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledTimes(1)
    // Session-scoped cooldown → the resolver now falls back to batch.
    expect(engine.isAvailable(ALL_CAPS)).toBe(false)
  })

  it('abortTurn reopens a fresh socket without ending the session', () => {
    const socks: Array<ReturnType<typeof makeFakeSocket>> = []
    const createSocket = (): WsLike => { const f = makeFakeSocket(); socks.push(f); return f.sock }
    const onTurn = vi.fn()
    const onEnd = vi.fn()
    const engine = createWsStreamingSttEngine({ createSocket, startCapture: makeFakeCapture().startCapture })
    const session = engine.startStreaming({ lang: 'en', stream: dummyStream, onTurn, onError: () => {}, onEnd })
    expect(socks).toHaveLength(1)
    socks[0]!.sock.onopen?.()

    session.abortTurn()
    // Old socket closed, a fresh one opened, session NOT ended.
    expect(socks[0]!.closed).toBe(true)
    expect(socks).toHaveLength(2)
    expect(onEnd).not.toHaveBeenCalled()

    // The fresh socket carries the next turn.
    socks[1]!.sock.onopen?.()
    socks[1]!.sock.onmessage?.({ data: JSON.stringify({ channel: { alternatives: [{ transcript: 'hi' }] }, is_final: true }) })
    expect(onTurn).toHaveBeenCalledWith('hi')
    expect(onEnd).not.toHaveBeenCalled()
  })
})
