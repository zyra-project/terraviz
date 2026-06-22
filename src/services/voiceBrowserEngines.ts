/**
 * Browser Web Speech engines — the Phase 1 STT/TTS implementations
 * that register against `voiceService`'s resolver.
 *
 * STT uses `SpeechRecognition` / `webkitSpeechRecognition`; TTS uses
 * `speechSynthesis` + `SpeechSynthesisUtterance`. Both are
 * best-effort for any language the host OS/browser happens to
 * support — so they declare broad language coverage and sit *last*
 * in the `auto` resolver order, after the curated cloud/on-device
 * engines (docs/ORBIT_VOICE_PLAN.md §4.1, §4.4).
 *
 * Privacy note: in Chrome, `SpeechRecognition` ships audio to
 * Google. Acceptable for the open-web MVP; the public-kiosk path
 * must use the cloud/on-device engines instead (voice plan §6.1).
 */

import {
  registerSttEngine,
  registerTtsEngine,
  registerStreamingSttEngine,
  detectVoiceCapabilities,
  type SttEngine,
  type TtsEngine,
  type StreamingSttEngine,
  type VoiceCapabilities,
} from './voiceService'
import { logger } from '../utils/logger'

// --- Minimal Web Speech typings (not in this project's TS lib set) ---

interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike {
  readonly length: number
  isFinal: boolean
  0: SpeechRecognitionAlternativeLike
}
interface SpeechRecognitionResultListLike {
  readonly length: number
  [index: number]: SpeechRecognitionResultLike
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  onspeechstart?: (() => void) | null
  onspeechend?: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w['SpeechRecognition'] ?? w['webkitSpeechRecognition'] ?? null) as SpeechRecognitionCtor | null
}

/** STT via the Web Speech API. */
export const browserSttEngine: SttEngine = {
  provider: 'browser',
  // Best-effort: the browser attempts whatever BCP-47 tag we give it.
  supportsLanguage: (lang) => !!lang,
  isAvailable: (caps) => caps.webSpeechStt,
  start: ({ lang, interim, onResult, onError, onEnd }) => {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      onError(new Error('SpeechRecognition unavailable'))
      onEnd()
      return { stop: () => {} }
    }
    const rec = new Ctor()
    rec.lang = lang
    rec.interimResults = interim
    rec.continuous = false
    rec.maxAlternatives = 1
    rec.onresult = (event) => {
      // `results` accumulates every segment of the utterance (prior
      // finals + the current interim/final). Emit the full combined
      // transcript each time so a caller that overwrites the field
      // doesn't lose earlier speech; `isFinal` only once all are final.
      let transcript = ''
      let isFinal = true
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i]
        if (!result) continue
        transcript += result[0]?.transcript ?? ''
        if (!result.isFinal) isFinal = false
      }
      onResult({ transcript, isFinal })
    }
    rec.onerror = (event) => onError(new Error(event?.error || 'speech-recognition-error'))
    rec.onend = () => onEnd()
    try {
      rec.start()
    } catch (err) {
      onError(err as Error)
      onEnd()
    }
    return {
      stop: () => {
        try { rec.stop() } catch { /* already stopped */ }
      },
    }
  },
}

/**
 * Streaming STT via the Web Speech API in **continuous** mode — the
 * Phase 3 realtime engine that needs no external provider or key, so
 * the `auto` resolver can serve hands-free voice today (a Deepgram /
 * Cloudflare engine can register later for better turn detection).
 *
 * Continuous recognition emits a final result per endpointed utterance
 * (≈ a turn) with interim results in between, and fires
 * `onspeechstart` / `onspeechend` — which map directly onto the
 * `StreamingSttEngine` contract. (docs/ORBIT_VOICE_PLAN.md §4.1, §9.1)
 *
 * Privacy: in Chrome this streams audio to Google, so the kiosk path
 * should still prefer a cloud/on-device streaming engine; the local
 * VAD gate (`RealtimeVoiceSession`) keeps audio from streaming until
 * speech onset regardless.
 */
export const browserStreamingSttEngine: StreamingSttEngine = {
  provider: 'browser',
  supportsLanguage: (lang) => !!lang,
  isAvailable: (caps) => caps.webSpeechStt,
  startStreaming: ({ lang, onPartial, onTurn, onSpeechStateChange, onError, onEnd }) => {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      onError(new Error('SpeechRecognition unavailable'))
      onEnd?.()
      return { stop: () => {}, abortTurn: () => {} }
    }
    const rec = new Ctor()
    rec.lang = lang
    rec.interimResults = true
    rec.continuous = true
    rec.maxAlternatives = 1

    let emittedTurns = 0  // count of final results already emitted
    let aborted = false   // barge-in: suppress the in-flight turn's output
    let restarting = false // abortTurn() restarts rather than ending
    let stopped = false   // stop() ends the session for good

    rec.onresult = (event) => {
      if (aborted) return
      // Continuous mode accumulates every result across the session.
      // Emit each newly-final result as a turn; the trailing interim
      // results form the live partial.
      for (let i = emittedTurns; i < event.results.length; i++) {
        const result = event.results[i]
        if (result?.isFinal) {
          onTurn((result[0]?.transcript ?? '').trim())
          emittedTurns = i + 1
        }
      }
      let partial = ''
      for (let i = emittedTurns; i < event.results.length; i++) {
        partial += event.results[i]?.[0]?.transcript ?? ''
      }
      if (partial) onPartial?.(partial)
    }
    rec.onspeechstart = () => { if (!aborted) onSpeechStateChange?.(true) }
    rec.onspeechend = () => { if (!aborted) onSpeechStateChange?.(false) }
    rec.onerror = (event) => onError(new Error(event?.error || 'speech-recognition-error'))
    rec.onend = () => {
      // `abort()` from abortTurn() fires `onend`; restart instead of
      // ending so the continuous session keeps listening. A real stop()
      // (or a fatal start failure) ends it.
      if (restarting && !stopped) {
        restarting = false
        aborted = false
        emittedTurns = 0
        try { rec.start() } catch (err) { onError(err as Error); onEnd?.() }
        return
      }
      onEnd?.()
    }
    try {
      rec.start()
    } catch (err) {
      onError(err as Error)
      onEnd?.()
    }
    return {
      stop: () => {
        stopped = true
        try { rec.stop() } catch { /* already stopped */ }
      },
      abortTurn: () => {
        // Discard the in-flight turn WITHOUT ending the session: abort
        // the current recognition (drops its audio + partials), then the
        // onend handler restarts it so listening continues clean.
        if (stopped) return
        aborted = true
        restarting = true
        try { rec.abort() } catch { restarting = false }
      },
    }
  },
}

/** TTS via `speechSynthesis`. */
/**
 * Live utterances. Chrome garbage-collects a `SpeechSynthesisUtterance`
 * that isn't referenced from JS while it's mid-flight — the result is
 * no audio AND `onend` never firing (so a caller awaiting the speak
 * would hang and a Stop control would stick). Holding a reference here
 * until the utterance settles avoids that. (ORBIT_VOICE_PLAN §10.2)
 */
const liveUtterances = new Set<unknown>()

export const browserTtsEngine: TtsEngine = {
  provider: 'browser',
  supportsLanguage: (lang) => !!lang,
  isAvailable: (caps) => caps.speechSynthesis,
  speak: (text, opts) => new Promise<void>((resolve) => {
    const w = window as unknown as Record<string, any>
    const synth = w['speechSynthesis']
    const Utterance = w['SpeechSynthesisUtterance']
    if (!synth || !Utterance || !text) {
      resolve()
      return
    }
    const utterance = new Utterance(text)
    utterance.lang = opts.lang
    if (typeof opts.rate === 'number') utterance.rate = opts.rate
    if (opts.voice) {
      const match = synth.getVoices?.().find((v: { name: string }) => v.name === opts.voice)
      if (match) utterance.voice = match
    }
    liveUtterances.add(utterance)
    let settled = false
    // Safety net: if the engine never reports completion (some
    // browsers drop onend after a cancel, or stall), resolve anyway
    // so the speech queue can't wedge and the Stop control can't stick.
    const timeoutMs = Math.min(60000, 4000 + text.length * 120)
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      liveUtterances.delete(utterance)
      resolve()
    }
    utterance.onend = finish
    utterance.onerror = finish
    timer = setTimeout(finish, timeoutMs)
    try {
      synth.speak(utterance)
      // Chrome can leave synthesis paused after a prior cancel(); nudge it.
      synth.resume?.()
    } catch (err) {
      logger.warn('[voice] speechSynthesis.speak failed', err)
      finish()
    }
  }),
  cancel: () => {
    liveUtterances.clear()
    try {
      (window as unknown as Record<string, any>)['speechSynthesis']?.cancel()
    } catch { /* nothing speaking */ }
  },
}

let ttsPrimed = false

/**
 * Unlock `speechSynthesis` for iOS Safari, which only produces audio
 * if synthesis was first invoked from inside a user gesture. Auto-speak
 * fires later from an async chain, so we prime it once from an early tap
 * (mic / send / enabling auto-speak) by speaking a silent blank
 * utterance. Idempotent and inaudible. (ORBIT_VOICE_PLAN §10.5)
 */
export function primeBrowserTts(): void {
  if (ttsPrimed) return
  const w = window as unknown as Record<string, any>
  const synth = w['speechSynthesis']
  const Utterance = w['SpeechSynthesisUtterance']
  if (!synth || !Utterance) return
  try {
    const u = new Utterance(' ')
    u.volume = 0
    synth.speak(u)
    synth.resume?.()
    ttsPrimed = true
  } catch { /* priming is best-effort */ }
}

/** A `speechSynthesis` voice the user can choose in settings. */
export interface BrowserVoiceInfo {
  name: string
  lang: string
  voiceURI: string
  isDefault: boolean
}

/** List the system TTS voices (empty until the browser has loaded them). */
export function listBrowserVoices(): BrowserVoiceInfo[] {
  const synth = (window as unknown as Record<string, any>)['speechSynthesis']
  if (!synth?.getVoices) return []
  return (synth.getVoices() as Array<{ name: string; lang: string; voiceURI?: string; default?: boolean }>).map(v => ({
    name: v.name,
    lang: v.lang,
    voiceURI: v.voiceURI ?? v.name,
    isDefault: !!v.default,
  }))
}

/**
 * Apple's built-in *novelty* voices (Bad News, Zarvox, Bubbles…),
 * exposed wholesale by `speechSynthesis.getVoices()`. They're musical
 * / joke voices, useless for reading a docent reply, so we hide them
 * from the picker. Matched case-insensitively against the base name
 * (a trailing platform suffix like " (Enhanced)" is tolerated).
 */
const NOVELTY_VOICE_NAMES: ReadonlySet<string> = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos',
  'deranged', 'good news', 'hysterical', 'jester', 'organ', 'pipe organ',
  'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox',
])

function isNoveltyVoice(v: BrowserVoiceInfo): boolean {
  const base = v.name.toLowerCase().replace(/\s*\(.*\)\s*$/, '').trim()
  return NOVELTY_VOICE_NAMES.has(base)
}

/**
 * Rank a voice by likely quality from its URI/name. Higher is better:
 * Apple/Google neural & "enhanced/premium" and Siri voices first,
 * stripped-down "compact" voices last. Used only for ordering the
 * picker — never to exclude (besides novelty).
 */
export function voiceQualityRank(v: BrowserVoiceInfo): number {
  const hay = `${v.voiceURI} ${v.name}`.toLowerCase()
  if (/siri|enhanced|premium|neural|natural|wavenet/.test(hay)) return 3
  if (/compact|eloquence/.test(hay)) return 1
  return 2
}

/**
 * Curate the raw voice list for the picker: drop novelty voices and
 * sort best-first (quality rank, then the system default, then name).
 */
export function curateVoices(voices: BrowserVoiceInfo[]): BrowserVoiceInfo[] {
  return voices
    .filter(v => !isNoveltyVoice(v))
    .sort((a, b) => {
      const r = voiceQualityRank(b) - voiceQualityRank(a)
      if (r !== 0) return r
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

/**
 * Subscribe to the async `voiceschanged` event (voices often aren't
 * ready on first call). Returns an unsubscribe function.
 */
export function onBrowserVoicesChanged(cb: () => void): () => void {
  const synth = (window as unknown as Record<string, any>)['speechSynthesis']
  if (!synth?.addEventListener) return () => {}
  synth.addEventListener('voiceschanged', cb)
  return () => synth.removeEventListener?.('voiceschanged', cb)
}

/**
 * Register the browser engines that the current runtime can support.
 * Idempotent (the registry de-dupes by provider). Safe to call from
 * UI init; returns the capabilities it acted on.
 */
export function registerBrowserVoiceEngines(
  caps: VoiceCapabilities = detectVoiceCapabilities(),
): VoiceCapabilities {
  if (caps.webSpeechStt) {
    registerSttEngine(browserSttEngine)
    registerStreamingSttEngine(browserStreamingSttEngine)
  }
  if (caps.speechSynthesis) registerTtsEngine(browserTtsEngine)
  logger.debug('[voice] browser engines registered', { stt: caps.webSpeechStt, tts: caps.speechSynthesis })
  return caps
}
