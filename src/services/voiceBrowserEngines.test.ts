import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  registerBrowserVoiceEngines,
  browserSttEngine,
  browserStreamingSttEngine,
  browserTtsEngine,
  curateVoices,
  voiceQualityRank,
  type BrowserVoiceInfo,
} from './voiceBrowserEngines'
import {
  resetVoiceEngines,
  resolveSttEngine,
  resolveTtsEngine,
  resolveStreamingSttEngine,
  type VoiceCapabilities,
} from './voiceService'

const ALL_CAPS: VoiceCapabilities = {
  webSpeechStt: true,
  speechSynthesis: true,
  mediaRecorder: true,
  getUserMedia: true,
}

const w = window as unknown as Record<string, any>

beforeEach(() => {
  resetVoiceEngines()
})

afterEach(() => {
  delete w['SpeechRecognition']
  delete w['speechSynthesis']
  delete w['SpeechSynthesisUtterance']
})

describe('voice curation', () => {
  const v = (name: string, voiceURI = name, isDefault = false): BrowserVoiceInfo => ({
    name, lang: 'en-US', voiceURI, isDefault,
  })

  it('drops Apple novelty voices (incl. a platform suffix)', () => {
    const out = curateVoices([
      v('Bad News'), v('Zarvox'), v('Bubbles (Enhanced)'), v('Samantha'),
    ])
    expect(out.map(x => x.name)).toEqual(['Samantha'])
  })

  it('ranks enhanced / Siri voices above compact ones', () => {
    expect(voiceQualityRank(v('Siri', 'com.apple.ttsbundle.siri_female_en-US'))).toBe(3)
    expect(voiceQualityRank(v('Sam', 'com.apple.voice.enhanced.en-US.Sam'))).toBe(3)
    expect(voiceQualityRank(v('Sam', 'com.apple.voice.compact.en-US.Sam'))).toBe(1)
    expect(voiceQualityRank(v('Generic'))).toBe(2)
  })

  it('sorts best-first: quality, then default, then name', () => {
    const out = curateVoices([
      v('Compact', 'com.apple.voice.compact.en-US.Compact'),
      v('Zoe', 'com.apple.voice.enhanced.en-US.Zoe'),
      v('Alex', 'com.apple.voice.enhanced.en-US.Alex'),
    ])
    expect(out.map(x => x.name)).toEqual(['Alex', 'Zoe', 'Compact'])
  })
})

describe('engine metadata', () => {
  it('declares the browser provider and gates on capabilities', () => {
    expect(browserSttEngine.provider).toBe('browser')
    expect(browserTtsEngine.provider).toBe('browser')
    expect(browserSttEngine.isAvailable({ ...ALL_CAPS, webSpeechStt: false })).toBe(false)
    expect(browserTtsEngine.isAvailable({ ...ALL_CAPS, speechSynthesis: false })).toBe(false)
    expect(browserSttEngine.supportsLanguage('kab')).toBe(true) // best-effort any
    expect(browserSttEngine.supportsLanguage('')).toBe(false)
  })
})

describe('registerBrowserVoiceEngines', () => {
  it('registers only the engines the runtime supports', () => {
    registerBrowserVoiceEngines({ ...ALL_CAPS, webSpeechStt: false })
    expect(resolveSttEngine('browser', 'en', ALL_CAPS)).toBeNull()
    expect(resolveTtsEngine('browser', 'en', ALL_CAPS)?.provider).toBe('browser')
  })

  it('registers both when both are available', () => {
    registerBrowserVoiceEngines(ALL_CAPS)
    expect(resolveSttEngine('auto', 'en', ALL_CAPS)?.provider).toBe('browser')
    expect(resolveTtsEngine('auto', 'en', ALL_CAPS)?.provider).toBe('browser')
  })

  it('registers the streaming STT engine when Web Speech is available', () => {
    registerBrowserVoiceEngines(ALL_CAPS)
    expect(resolveStreamingSttEngine('auto', 'en', ALL_CAPS)?.provider).toBe('browser')
    resetVoiceEngines()
    registerBrowserVoiceEngines({ ...ALL_CAPS, webSpeechStt: false })
    expect(resolveStreamingSttEngine('auto', 'en', ALL_CAPS)).toBeNull()
  })
})

describe('browser streaming STT engine', () => {
  /** Build a Web Speech results list from scripted segments. */
  function results(...segs: Array<{ t: string; final: boolean }>): any {
    const obj: any = { length: segs.length }
    segs.forEach((s, i) => { obj[i] = { length: 1, isFinal: s.final, 0: { transcript: s.t } } })
    return obj
  }

  it('emits per-utterance turns, interim partials, and speech-state in continuous mode', async () => {
    class FakeStreaming {
      lang = ''; interimResults = false; continuous = false; maxAlternatives = 1
      onresult: ((e: any) => void) | null = null
      onerror: ((e: any) => void) | null = null
      onend: (() => void) | null = null
      onspeechstart: (() => void) | null = null
      onspeechend: (() => void) | null = null
      start() {
        queueMicrotask(() => {
          this.onspeechstart?.()
          this.onresult?.({ resultIndex: 0, results: results({ t: 'hel', final: false }) })
          this.onresult?.({ resultIndex: 0, results: results({ t: 'hello', final: true }) })
          this.onresult?.({ resultIndex: 1, results: results({ t: 'hello', final: true }, { t: 'wor', final: false }) })
          this.onresult?.({ resultIndex: 1, results: results({ t: 'hello', final: true }, { t: 'world', final: true }) })
          this.onspeechend?.()
        })
      }
      stop() { this.onend?.() }
      abort() { this.onend?.() }
    }
    w['SpeechRecognition'] = FakeStreaming

    const partials: string[] = []
    const turns: string[] = []
    const states: boolean[] = []
    await new Promise<void>((resolve) => {
      const session = browserStreamingSttEngine.startStreaming({
        lang: 'en-US',
        onPartial: (t) => partials.push(t),
        onTurn: (t) => turns.push(t),
        onSpeechStateChange: (s) => states.push(s),
        onError: () => {},
        onEnd: () => resolve(),
      })
      // After the scripted microtask emits, end the session.
      setTimeout(() => session.stop(), 0)
    })

    expect(turns).toEqual(['hello', 'world'])
    expect(partials).toEqual(['hel', 'wor'])
    expect(states).toEqual([true, false])
  })

  it('abortTurn discards the turn and keeps the session alive (restart, no onEnd)', () => {
    let startCount = 0
    class FakeRec {
      lang = ''; interimResults = false; continuous = false; maxAlternatives = 1
      onresult: ((e: any) => void) | null = null
      onerror: ((e: any) => void) | null = null
      onend: (() => void) | null = null
      onspeechstart: (() => void) | null = null
      onspeechend: (() => void) | null = null
      start() { startCount++ }
      stop() { this.onend?.() }
      abort() { this.onend?.() } // Web Speech fires onend after abort
    }
    w['SpeechRecognition'] = FakeRec

    let ended = false
    const session = browserStreamingSttEngine.startStreaming({
      lang: 'en', onTurn: () => {}, onError: () => {}, onEnd: () => { ended = true },
    })
    expect(startCount).toBe(1)

    session.abortTurn()      // abort → onend → restart (not end)
    expect(startCount).toBe(2)
    expect(ended).toBe(false)

    session.stop()           // real stop → onend → onEnd
    expect(ended).toBe(true)
  })

  it('errors and ends when SpeechRecognition is absent', async () => {
    const errors: string[] = []
    await new Promise<void>((resolve) => {
      browserStreamingSttEngine.startStreaming({
        lang: 'en',
        onTurn: () => {},
        onError: (e) => errors.push(e.message),
        onEnd: () => resolve(),
      })
    })
    expect(errors).toEqual(['SpeechRecognition unavailable'])
  })
})

describe('browser STT engine', () => {
  it('wires SpeechRecognition results through to callbacks', async () => {
    // Fake SpeechRecognition that emits one interim + one final result.
    class FakeRecognition {
      lang = ''
      interimResults = false
      continuous = false
      maxAlternatives = 1
      onresult: ((e: any) => void) | null = null
      onerror: ((e: any) => void) | null = null
      onend: (() => void) | null = null
      start() {
        queueMicrotask(() => {
          this.onresult?.({
            resultIndex: 0,
            results: { length: 1, 0: { length: 1, isFinal: false, 0: { transcript: 'sea' } } },
          })
          this.onresult?.({
            resultIndex: 0,
            results: { length: 1, 0: { length: 1, isFinal: true, 0: { transcript: 'sea ice' } } },
          })
          this.onend?.()
        })
      }
      stop() {}
      abort() {}
    }
    w['SpeechRecognition'] = FakeRecognition

    const results: Array<{ transcript: string; isFinal: boolean }> = []
    await new Promise<void>((resolve) => {
      browserSttEngine.start({
        lang: 'en-US',
        interim: true,
        onResult: (r) => results.push(r),
        onError: () => {},
        onEnd: () => resolve(),
      })
    })

    expect(results).toEqual([
      { transcript: 'sea', isFinal: false },
      { transcript: 'sea ice', isFinal: true },
    ])
  })

  it('reports an error and ends when SpeechRecognition is absent', async () => {
    let errored = false
    await new Promise<void>((resolve) => {
      browserSttEngine.start({
        lang: 'en',
        interim: false,
        onResult: () => {},
        onError: () => { errored = true },
        onEnd: () => resolve(),
      })
    })
    expect(errored).toBe(true)
  })
})

describe('browser TTS engine', () => {
  it('speaks an utterance and resolves on end', async () => {
    const spoken: string[] = []
    class FakeUtterance {
      text: string
      lang = ''
      rate = 1
      voice: unknown = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) { this.text = text }
    }
    w['SpeechSynthesisUtterance'] = FakeUtterance
    w['speechSynthesis'] = {
      getVoices: () => [],
      speak: (u: FakeUtterance) => {
        spoken.push(u.text)
        queueMicrotask(() => u.onend?.())
      },
      cancel: () => {},
    }

    await browserTtsEngine.speak('hello world', { lang: 'en-US', rate: 1.1 })
    expect(spoken).toEqual(['hello world'])
  })

  it('resolves immediately when speechSynthesis is unavailable', async () => {
    await expect(browserTtsEngine.speak('hi', { lang: 'en' })).resolves.toBeUndefined()
  })

  it('still resolves via the safety timeout when onend never fires (Chrome stall / GC)', async () => {
    vi.useFakeTimers()
    try {
      class StalledUtterance {
        text: string
        lang = ''
        rate = 1
        voice: unknown = null
        onend: (() => void) | null = null
        onerror: (() => void) | null = null
        constructor(text: string) { this.text = text }
      }
      w['SpeechSynthesisUtterance'] = StalledUtterance
      // speak() that never reports completion — the bug we guard against.
      w['speechSynthesis'] = { getVoices: () => [], speak: () => {}, cancel: () => {}, resume: () => {} }

      const promise = browserTtsEngine.speak('hello', { lang: 'en' })
      let settled = false
      void promise.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(61000)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
