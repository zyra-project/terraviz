// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
import { logger } from '../utils/logger'
import { until } from '../test-utils'

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

  describe('synthesis ahead of playback', () => {
    const played: string[] = []
    class RecordingAudio extends FakeAudio {
      play() { played.push(this.src); return super.play() }
    }
    const audioFor = (text: string): string => btoa(text)
    const bodyText = (init: RequestInit): string => (JSON.parse(init.body as string) as { text: string }).text

    beforeEach(() => {
      played.length = 0
      cloudTtsEngine.cancel() // drop anything a previous test prepared
      vi.stubGlobal('Audio', RecordingAudio as unknown as typeof Audio)
    })

    afterEach(() => vi.restoreAllMocks())

    const gatewayError = (): Response => new Response('upstream hiccup', { status: 502 })

    /**
     * Keep the engine's 300 ms retry pause from ever elapsing, so a
     * `speak()` that enters it can only get out through Stop. Every
     * other timer runs as usual.
     */
    function holdRetryPause(): { pausing: () => boolean } {
      const realSetTimeout = globalThis.setTimeout
      let pausing = false
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        if (ms !== 300) return realSetTimeout(fn, ms)
        pausing = true
        return 0
      }) as unknown as typeof setTimeout)
      return { pausing: () => pausing }
    }

    /** A /synthesize that answers each text's audio once `release(text)` is called. */
    function heldSynth() {
      const waiting = new Map<string, () => void>()
      const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
        const text = bodyText(init)
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        waiting.set(text, () => resolve(new Response(JSON.stringify({ audio: audioFor(text) }), { status: 200 })))
      }))
      return { fetchMock, release: (text: string) => waiting.get(text)?.() }
    }

    it('uses the prefetched audio instead of requesting the sentence again', async () => {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
        new Response(JSON.stringify({ audio: audioFor(bodyText(init)) }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      cloudTtsEngine.prefetch!('Second sentence.', { lang: 'en' })
      await cloudTtsEngine.speak('Second sentence.', { lang: 'en' })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(played).toEqual([`data:audio/mpeg;base64,${audioFor('Second sentence.')}`])
    })

    it('synthesizes the next sentence while the current one is still on its way', async () => {
      const { fetchMock, release } = heldSynth()
      vi.stubGlobal('fetch', fetchMock)

      const first = cloudTtsEngine.speak('One.', { lang: 'en' })
      cloudTtsEngine.prefetch!('Two.', { lang: 'en' })
      // Both requests are in flight before the first has answered.
      expect(fetchMock.mock.calls.map(([, init]) => bodyText(init))).toEqual(['One.', 'Two.'])

      release('One.')
      release('Two.')
      await first
      await cloudTtsEngine.speak('Two.', { lang: 'en' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(played).toHaveLength(2)
    })

    it('retries a gateway error once, so a sentence is not silently skipped', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('upstream hiccup', { status: 502 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ audio: 'QUJD' }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      await cloudTtsEngine.speak('Hello.', { lang: 'en' })

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(played).toHaveLength(1)
    })

    it('does not retry a client error or the kill switch', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'bad_request' }), { status: 400 }))
      vi.stubGlobal('fetch', fetchMock)

      await cloudTtsEngine.speak('Hello.', { lang: 'en' })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(played).toEqual([])
    })

    it('stays silent when stopped while the sentence was being synthesized', async () => {
      const { fetchMock, release } = heldSynth()
      vi.stubGlobal('fetch', fetchMock)

      const speaking = cloudTtsEngine.speak('Too late.', { lang: 'en' })
      cloudTtsEngine.cancel()
      release('Too late.')
      await speaking

      expect(played).toEqual([])
    })

    it('abandons prepared sentences on cancel and fetches afresh afterwards', async () => {
      const { fetchMock, release } = heldSynth()
      vi.stubGlobal('fetch', fetchMock)

      cloudTtsEngine.prefetch!('Later.', { lang: 'en' })
      const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit]
      cloudTtsEngine.cancel()
      expect(firstInit.signal?.aborted).toBe(true)

      const speaking = cloudTtsEngine.speak('Later.', { lang: 'en' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      release('Later.')
      await speaking
      expect(played).toHaveLength(1)
    })

    it('caps how far ahead it synthesizes', () => {
      const { fetchMock } = heldSynth()
      vi.stubGlobal('fetch', fetchMock)

      for (const text of ['A.', 'B.', 'C.', 'D.', 'E.']) cloudTtsEngine.prefetch!(text, { lang: 'en' })
      // Idempotent per text, too.
      cloudTtsEngine.prefetch!('A.', { lang: 'en' })

      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('asks again at the sentence\'s turn when both prefetch attempts failed', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(gatewayError())
        .mockResolvedValueOnce(gatewayError())
        .mockResolvedValueOnce(new Response(JSON.stringify({ audio: 'QUJD' }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      // The prefetch uses up both failures before the sentence's turn...
      cloudTtsEngine.prefetch!('Second.', { lang: 'en' })
      await until(() => fetchMock.mock.calls.length === 2, 'the prefetch retry')
      // ...and the service has recovered by the time it comes.
      await cloudTtsEngine.speak('Second.', { lang: 'en' })

      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(played).toHaveLength(1)
    })

    it('does not ask again when the prefetch hit the kill switch', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'voice_disabled' }), { status: 503 }))
      vi.stubGlobal('fetch', fetchMock)

      cloudTtsEngine.prefetch!('Second.', { lang: 'en' })
      await cloudTtsEngine.speak('Second.', { lang: 'en' })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(played).toEqual([])
    })

    it('does not ask again when the prefetch was refused', async () => {
      // A spent quota or a rate limit answers 429. That is an answer, not
      // a failure that may pass: a second request would only repeat it.
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'quota_exhausted' }), { status: 429 }))
      vi.stubGlobal('fetch', fetchMock)

      cloudTtsEngine.prefetch!('Second.', { lang: 'en' })
      await cloudTtsEngine.speak('Second.', { lang: 'en' })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(played).toEqual([])
    })

    // Stop has to reach the sentence `speak()` is waiting on whether its
    // request was started ahead of time or by `speak()` itself.
    describe.each([
      ['a prefetched sentence', true],
      ['a sentence that was not prefetched', false],
    ])('stopping %s mid-request', (_name, prepare) => {
      const speakCurrent = (): Promise<void> => {
        if (prepare) cloudTtsEngine.prefetch!('Current.', { lang: 'en' })
        return cloudTtsEngine.speak('Current.', { lang: 'en' })
      }

      it('aborts the request, and speak() settles without waiting for an answer', async () => {
        const { fetchMock } = heldSynth()
        vi.stubGlobal('fetch', fetchMock)

        const speaking = speakCurrent()
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        cloudTtsEngine.cancel()

        expect(init.signal?.aborted).toBe(true)
        // Never released, so only the abort can settle it.
        await speaking
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(played).toEqual([])
      })

      it('does not retry a gateway error that lands after Stop', async () => {
        const { pausing } = holdRetryPause()
        // Ignores the abort, as a response already on its way does.
        const answers: Array<(res: Response) => void> = []
        const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
          new Promise<Response>((resolve) => { answers.push(resolve) }))
        vi.stubGlobal('fetch', fetchMock)

        const speaking = speakCurrent()
        cloudTtsEngine.cancel()
        answers[0]!(gatewayError())
        await speaking

        expect(pausing()).toBe(false)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(played).toEqual([])
      })
    })

    it('stops waiting to retry when cancelled', async () => {
      const { pausing } = holdRetryPause()
      const fetchMock = vi.fn(async () => gatewayError())
      vi.stubGlobal('fetch', fetchMock)

      const speaking = cloudTtsEngine.speak('Current.', { lang: 'en' })
      await until(pausing, 'the retry pause')
      cloudTtsEngine.cancel()
      await speaking

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does not report a Stop during the body download as a parse failure', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      // The headers have arrived; the body fails the way a real one does
      // when its request is aborted mid-download.
      let body: Promise<unknown> | null = null
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        json: () => (body = new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })),
      }) as unknown as Response)
      vi.stubGlobal('fetch', fetchMock)

      cloudTtsEngine.prefetch!('Later.', { lang: 'en' })
      await until(() => body !== null, 'the body download')
      cloudTtsEngine.cancel()
      // The engine was waiting on `body` first, so its handler has run
      // by the time this one has.
      await body!.catch(() => {})

      expect(warn).not.toHaveBeenCalled()
    })
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
