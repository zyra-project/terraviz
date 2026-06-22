import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  cloudSttEngine,
  cloudStreamingSttEngine,
  cloudTtsEngine,
  registerCloudVoiceEngines,
  __resetCloudVoiceDisabled,
} from './voiceCloudEngines'
import {
  resetVoiceEngines,
  resolveTtsEngine,
  resolveSttEngine,
  resolveStreamingSttEngine,
  type VoiceCapabilities,
} from './voiceService'
import { createWsStreamingSttEngine, __resetWsStreamingDisabled, type WsLike } from './voiceWsStreaming'

const ALL_CAPS: VoiceCapabilities = {
  webSpeechStt: true,
  speechSynthesis: true,
  mediaRecorder: true,
  getUserMedia: true,
}

/** Minimal driveable fake socket — drives the WS engine's cooldown path. */
function makeFakeSocket(): { sock: WsLike } {
  const sock: WsLike = {
    binaryType: '', readyState: 1,
    send: () => {}, close: () => { sock.onclose?.() },
    onopen: null, onmessage: null, onerror: null, onclose: null,
  }
  return { sock }
}

beforeEach(() => {
  resetVoiceEngines()
  __resetCloudVoiceDisabled()
  __resetWsStreamingDisabled()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cloud engine metadata', () => {
  it('declares the cloud provider and curated language coverage', () => {
    expect(cloudTtsEngine.provider).toBe('cloud')
    expect(cloudSttEngine.provider).toBe('cloud')
    expect(cloudSttEngine.supportsLanguage('en')).toBe(true)
    expect(cloudSttEngine.supportsLanguage('kab')).toBe(false) // not in CLOUD_STT_LANGUAGES
    expect(cloudTtsEngine.supportsLanguage('ko')).toBe(true)   // MeloTTS
    expect(cloudTtsEngine.supportsLanguage('hi')).toBe(false)  // STT-only language
  })

  it('STT requires MediaRecorder + getUserMedia', () => {
    expect(cloudSttEngine.isAvailable(ALL_CAPS)).toBe(true)
    expect(cloudSttEngine.isAvailable({ ...ALL_CAPS, mediaRecorder: false })).toBe(false)
    expect(cloudSttEngine.isAvailable({ ...ALL_CAPS, getUserMedia: false })).toBe(false)
  })

  it('registers as the cloud provider but stays out of auto', () => {
    registerCloudVoiceEngines()
    expect(resolveTtsEngine('cloud', 'en', ALL_CAPS)?.provider).toBe('cloud')
    expect(resolveTtsEngine('auto', 'en', ALL_CAPS)).toBeNull()
    expect(resolveSttEngine('cloud', 'en', ALL_CAPS)?.provider).toBe('cloud')
  })
})

describe('cloud TTS', () => {
  class FakeAudio {
    src: string
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(src: string) { this.src = src }
    play() { queueMicrotask(() => this.onended?.()); return Promise.resolve() }
    pause() {}
  }

  it('posts text to /synthesize and plays the returned audio', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ audio: 'QUJD', format: 'mp3' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio)

    await cloudTtsEngine.speak('Hello there.', { lang: 'en-US' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/voice/synthesize')
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Hello there.', lang: 'en-US' })
  })

  it('disables cloud voice for the session on a KILL_VOICE 503', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 'voice_disabled' }), { status: 503 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio)

    await cloudTtsEngine.speak('Hi', { lang: 'en' })
    expect(cloudTtsEngine.isAvailable(ALL_CAPS)).toBe(false)
    // Subsequent speak short-circuits (no second fetch).
    await cloudTtsEngine.speak('Again', { lang: 'en' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('cloud STT', () => {
  it('records, uploads on stop, and emits the transcript', async () => {
    // Fake mic + recorder.
    const track = { stop: vi.fn() }
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    })
    let onstop: (() => void) | null = null
    class FakeRecorder {
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((e: { data: Blob }) => void) | null = null
      set onstop(fn: () => void) { onstop = fn }
      constructor(_s: unknown) {}
      start() {
        this.state = 'recording'
        this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) })
      }
      stop() { this.state = 'inactive'; onstop?.() }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder as unknown as typeof MediaRecorder)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ text: 'show me sea ice' }), { status: 200 },
    )))

    const results: string[] = []
    await new Promise<void>((resolve) => {
      const session = cloudSttEngine.start({
        lang: 'en', interim: true,
        onResult: (r) => { if (r.isFinal) results.push(r.transcript) },
        onError: () => {},
        onEnd: () => resolve(),
      })
      // Let getUserMedia + recorder.start() settle, then stop.
      queueMicrotask(() => queueMicrotask(() => session.stop()))
    })

    expect(results).toEqual(['show me sea ice'])
    expect(track.stop).toHaveBeenCalled()
  })
})

describe('cloud streaming STT', () => {
  it('declares the cloud provider and registers against the streaming resolver', () => {
    expect(cloudStreamingSttEngine.provider).toBe('cloud')
    registerCloudVoiceEngines()
    expect(resolveStreamingSttEngine('cloud', 'en', ALL_CAPS)?.provider).toBe('cloud')
    // opt-in only — never picked by `auto`.
    expect(resolveStreamingSttEngine('auto', 'en', ALL_CAPS)).toBeNull()
  })

  it('prefers the realtime WS engine when VITE_VOICE_WS_STREAMING is on', () => {
    // Default (flag off) → batch engine is the cloud streaming provider.
    registerCloudVoiceEngines()
    expect(resolveStreamingSttEngine('cloud', 'en', ALL_CAPS)).toBe(cloudStreamingSttEngine)

    // Flag on → the WS engine wins the `cloud` provider slot.
    resetVoiceEngines()
    vi.stubEnv('VITE_VOICE_WS_STREAMING', 'true')
    registerCloudVoiceEngines()
    const engine = resolveStreamingSttEngine('cloud', 'en', ALL_CAPS)
    expect(engine).not.toBe(cloudStreamingSttEngine)
    expect(engine?.provider).toBe('cloud')
    vi.unstubAllEnvs()
  })

  it('keeps the batch engine as a fallback when the WS path cools down', () => {
    vi.stubEnv('VITE_VOICE_WS_STREAMING', 'true')
    registerCloudVoiceEngines()
    // Both register (WS preferred, batch behind it); WS wins while available.
    expect(resolveStreamingSttEngine('cloud', 'en', ALL_CAPS)).not.toBe(cloudStreamingSttEngine)

    // Cool down the session-scoped WS path — the disabled flag is module
    // state shared across instances, so drive it through a fake-injected
    // one receiving a proxy error frame.
    const sock = makeFakeSocket()
    const probe = createWsStreamingSttEngine({
      createSocket: () => sock.sock,
      startCapture: () => ({ stop: () => {} }),
    })
    probe.startStreaming({ lang: 'en', stream: {} as MediaStream, onTurn: () => {}, onError: () => {}, onEnd: () => {} })
    sock.sock.onopen?.()
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'error', code: 'voice_disabled' }) })

    // WS is now unavailable → the resolver falls back to the batch engine.
    expect(resolveStreamingSttEngine('cloud', 'en', ALL_CAPS)).toBe(cloudStreamingSttEngine)
    vi.unstubAllEnvs()
  })

  it('records the provided stream and emits a turn on stop (without owning the mic)', async () => {
    let onstop: (() => void) | null = null
    class FakeRecorder {
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((e: { data: Blob }) => void) | null = null
      set onstop(fn: () => void) { onstop = fn }
      constructor(_s: unknown) {}
      start() {
        this.state = 'recording'
        this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) })
      }
      stop() { this.state = 'inactive'; onstop?.() }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder as unknown as typeof MediaRecorder)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ text: 'show me sea ice' }), { status: 200 },
    )))

    // A shared session stream — its tracks must NOT be stopped by the engine.
    const track = { stop: vi.fn() }
    const sharedStream = { getTracks: () => [track] } as unknown as MediaStream

    const turns: string[] = []
    await new Promise<void>((resolve) => {
      const session = cloudStreamingSttEngine.startStreaming({
        lang: 'en',
        stream: sharedStream,
        onTurn: (t) => turns.push(t),
        onError: () => {},
        onEnd: () => resolve(),
      })
      queueMicrotask(() => session.stop())
    })

    expect(turns).toEqual(['show me sea ice'])
    expect(track.stop).not.toHaveBeenCalled() // shared stream is the caller's
  })

  it('abortTurn discards the utterance without transcribing', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'dropped' }), { status: 200 }))
    let onstop: (() => void) | null = null
    class FakeRecorder {
      state = 'inactive'; mimeType = 'audio/webm'
      ondataavailable: ((e: { data: Blob }) => void) | null = null
      set onstop(fn: () => void) { onstop = fn }
      constructor(_s: unknown) {}
      start() { this.state = 'recording'; this.ondataavailable?.({ data: new Blob(['x']) }) }
      stop() { this.state = 'inactive'; onstop?.() }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder as unknown as typeof MediaRecorder)
    vi.stubGlobal('fetch', fetchMock)

    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
    const turns: string[] = []
    await new Promise<void>((resolve) => {
      const session = cloudStreamingSttEngine.startStreaming({
        lang: 'en', stream, onTurn: (t) => turns.push(t), onError: () => {}, onEnd: () => resolve(),
      })
      queueMicrotask(() => session.abortTurn())
    })

    expect(turns).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
