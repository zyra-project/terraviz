/**
 * Voice service — the shared speech abstraction for Orbit.
 *
 * Both the 2D chat (`chatUI.ts`) and the VR docent talk to *this*
 * module, never to `SpeechRecognition` / `speechSynthesis` /
 * cloud endpoints directly. It owns:
 *
 *   - capability detection (what this environment can do),
 *   - a provider registry + resolver (`auto` = on-device → browser;
 *     `cloud` is opt-in, excluded from `auto`),
 *   - the per-locale capability matrix (voice exists only for a
 *     subset of the UI's locales),
 *   - the **spoken-form projection** — a spoken answer is not a
 *     written answer, so TTS reads a cleaned projection rather than
 *     the raw stream (markers / markdown / URLs / IDs removed), and
 *   - sentence chunking so TTS can start speaking sentence 1 while
 *     the LLM is still generating sentence 2.
 *
 * This file is intentionally DOM-free and i18n-free: it is the
 * foundation layer. The concrete browser/cloud engines and the UI
 * register against it in later phases. Authoritative design:
 * `docs/ORBIT_VOICE_PLAN.md` (§1.1 projection, §3 capability
 * matrix, §4.4 resolver, §10 engineering specifics).
 */

import type { VoiceProviderPreference, VoiceProvider } from '../types'

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

/** What the current runtime can physically do for voice. */
export interface VoiceCapabilities {
  /** `SpeechRecognition` / `webkitSpeechRecognition` present (browser STT). */
  webSpeechStt: boolean
  /** `speechSynthesis` present (browser TTS). */
  speechSynthesis: boolean
  /** `MediaRecorder` present — needed to capture audio for cloud STT. */
  mediaRecorder: boolean
  /** `getUserMedia` present — needed for mic access on any non-browser-STT path. */
  getUserMedia: boolean
}

/**
 * Detect voice capabilities. Guarded so it is safe to call in a
 * non-browser (test / SSR) context, where it reports everything
 * unavailable.
 */
export function detectVoiceCapabilities(): VoiceCapabilities {
  if (typeof window === 'undefined') {
    return { webSpeechStt: false, speechSynthesis: false, mediaRecorder: false, getUserMedia: false }
  }
  const w = window as unknown as Record<string, unknown>
  const hasNavigator = typeof navigator !== 'undefined'
  return {
    webSpeechStt: 'SpeechRecognition' in w || 'webkitSpeechRecognition' in w,
    speechSynthesis: 'speechSynthesis' in w,
    mediaRecorder: typeof (w['MediaRecorder']) !== 'undefined',
    getUserMedia: hasNavigator && !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'),
  }
}

// ---------------------------------------------------------------------------
// Language coverage
// ---------------------------------------------------------------------------

/**
 * Reduce a BCP-47 locale tag to its base language subtag, lowercased.
 * `'pt-BR'` → `'pt'`, `'en'` → `'en'`, `''` → `''`.
 */
export function baseLanguage(locale: string): string {
  return (locale || '').toLowerCase().split('-')[0]?.trim() ?? ''
}

/**
 * Languages the Cloudflare-edge STT (Deepgram Nova-3) covers. Used
 * by the cloud STT engine (Phase 2) to declare `supportsLanguage`.
 * Source: docs/ORBIT_VOICE_PLAN.md §3.
 */
export const CLOUD_STT_LANGUAGES: ReadonlySet<string> = new Set([
  'en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl',
])

/**
 * Languages the Cloudflare-edge TTS covers (union of MeloTTS — the
 * default — and Deepgram Aura-2). Source: docs/ORBIT_VOICE_PLAN.md §3.
 */
export const CLOUD_TTS_LANGUAGES: ReadonlySet<string> = new Set([
  'en', 'es', 'fr', 'zh', 'ja', 'ko',
])

// ---------------------------------------------------------------------------
// Engine interfaces + registry
// ---------------------------------------------------------------------------

/** One STT result; `isFinal` distinguishes a committed transcript from an interim. */
export interface SttResult {
  transcript: string
  isFinal: boolean
}

export interface SttStartOptions {
  lang: string
  /** Emit interim (partial) results as the user speaks. */
  interim: boolean
  onResult: (result: SttResult) => void
  onError: (error: Error) => void
  onEnd: () => void
}

/** A live recognition session; `stop()` ends capture. */
export interface SttSession {
  stop(): void
}

export interface SttEngine {
  readonly provider: VoiceProvider
  /** Whether this engine can serve the given base language. */
  supportsLanguage(lang: string): boolean
  /** Whether this engine can run given the detected capabilities. */
  isAvailable(caps: VoiceCapabilities): boolean
  start(options: SttStartOptions): SttSession
}

export interface TtsSpeakOptions {
  lang: string
  /** 0.5–2; 1 is normal. */
  rate?: number
  /** Provider-scoped voice id. */
  voice?: string
}

export interface TtsEngine {
  readonly provider: VoiceProvider
  supportsLanguage(lang: string): boolean
  isAvailable(caps: VoiceCapabilities): boolean
  /** Resolves when the utterance finishes (or is cancelled). */
  speak(text: string, options: TtsSpeakOptions): Promise<void>
  /** Stop any in-flight speech immediately (barge-in / Stop control). */
  cancel(): void
}

// ---------------------------------------------------------------------------
// Streaming STT — the Phase 3 realtime / hands-free abstraction
// ---------------------------------------------------------------------------
//
// Distinct from `SttEngine` (single-utterance push-to-talk, Phases 1–2).
// A streaming engine runs a *continuous* session: it detects turn
// boundaries itself (endpointing / turn detection rather than a
// hand-rolled silence timer) and emits one `onTurn` per completed
// utterance, with live `onPartial` updates in between. This is
// provider-agnostic on purpose — the realtime UI (VAD gating,
// listening indicator, barge-in) is built against this interface and a
// fake engine, so the concrete provider (Deepgram Flux WS proxy vs a
// Cloudflare realtime path) can be chosen later without UI churn.
// (docs/ORBIT_VOICE_PLAN.md §8 decision 5, §9.1, §10)

export interface StreamingSttCallbacks {
  /** Live partial transcript for the in-progress turn (may revise). */
  onPartial?: (text: string) => void
  /** A completed turn — the engine's turn detector has endpointed. */
  onTurn: (transcript: string) => void
  /**
   * Voice-activity transitions from the engine's local VAD: `true`
   * when speech onset is detected, `false` on the trailing silence.
   * Drives the "listening" indicator and lets the caller duck audio.
   */
  onSpeechStateChange?: (speaking: boolean) => void
  onError: (error: Error) => void
  /** The continuous session has fully ended (stop() or fatal error). */
  onEnd?: () => void
}

export interface StreamingSttStartOptions extends StreamingSttCallbacks {
  lang: string
  /**
   * The session's live mic stream, when it has one. An engine that
   * captures its own audio (e.g. cloud record→transcribe) reuses this
   * instead of opening a second `getUserMedia` — avoiding a duplicate
   * mic and the start-of-utterance clip an async re-acquire would
   * cause. Engines that capture internally (browser Web Speech) ignore
   * it.
   */
  stream?: MediaStream
}

/** A live continuous recognition session. */
export interface StreamingSttSession {
  /** End the session and release the mic. */
  stop(): void
  /**
   * Discard the in-flight turn without ending the session — used for
   * barge-in (the user interrupts) and to drop a turn that collided
   * with Orbit's own TTS. The session keeps listening afterwards.
   */
  abortTurn(): void
}

export interface StreamingSttEngine {
  readonly provider: VoiceProvider
  supportsLanguage(lang: string): boolean
  isAvailable(caps: VoiceCapabilities): boolean
  /** Begin a continuous, turn-detected recognition session. */
  startStreaming(options: StreamingSttStartOptions): StreamingSttSession
}

const sttEngines: SttEngine[] = []
const ttsEngines: TtsEngine[] = []
const streamingSttEngines: StreamingSttEngine[] = []

export function registerSttEngine(engine: SttEngine): void {
  if (!sttEngines.some(e => e.provider === engine.provider)) sttEngines.push(engine)
}

export function registerTtsEngine(engine: TtsEngine): void {
  if (!ttsEngines.some(e => e.provider === engine.provider)) ttsEngines.push(engine)
}

export function registerStreamingSttEngine(engine: StreamingSttEngine): void {
  if (!streamingSttEngines.some(e => e.provider === engine.provider)) streamingSttEngines.push(engine)
}

/** Clear the registry — for tests, and for re-registration on config change. */
export function resetVoiceEngines(): void {
  sttEngines.length = 0
  ttsEngines.length = 0
  streamingSttEngines.length = 0
}

/**
 * Resolution order for `auto`. On-device first (best privacy, no
 * per-use cost), then the browser API. **`cloud` is deliberately
 * excluded from `auto`** — Cloudflare edge inference is metered and
 * changes the STT UX (record→upload, no live interim), so it's
 * opt-in: reachable only by pinning `voiceProvider: 'cloud'` (e.g. a
 * kiosk, or a user who wants the better/private path). Phase 4
 * registers the `local` engine. (docs/ORBIT_VOICE_PLAN.md §4.4)
 */
const AUTO_ORDER: readonly VoiceProvider[] = ['local', 'browser']

function pickEngine<T extends { provider: VoiceProvider; supportsLanguage(l: string): boolean; isAvailable(c: VoiceCapabilities): boolean }>(
  engines: readonly T[],
  pref: VoiceProviderPreference,
  lang: string,
  caps: VoiceCapabilities,
): T | null {
  const order: readonly VoiceProviderPreference[] = pref === 'auto' ? AUTO_ORDER : [pref]
  for (const provider of order) {
    const engine = engines.find(e => e.provider === provider && e.isAvailable(caps) && e.supportsLanguage(lang))
    if (engine) return engine
  }
  return null
}

export function resolveSttEngine(
  pref: VoiceProviderPreference,
  lang: string,
  caps: VoiceCapabilities = detectVoiceCapabilities(),
): SttEngine | null {
  return pickEngine(sttEngines, pref, baseLanguage(lang), caps)
}

export function resolveTtsEngine(
  pref: VoiceProviderPreference,
  lang: string,
  caps: VoiceCapabilities = detectVoiceCapabilities(),
): TtsEngine | null {
  return pickEngine(ttsEngines, pref, baseLanguage(lang), caps)
}

/**
 * Resolve a realtime streaming STT engine (Phase 3). Same preference /
 * capability resolution as the push-to-talk path; a separate registry
 * because not every provider streams. `null` → no realtime engine for
 * this locale/preference, so the caller falls back to push-to-talk.
 */
export function resolveStreamingSttEngine(
  pref: VoiceProviderPreference,
  lang: string,
  caps: VoiceCapabilities = detectVoiceCapabilities(),
): StreamingSttEngine | null {
  return pickEngine(streamingSttEngines, pref, baseLanguage(lang), caps)
}

/** What provider, if any, can serve voice in a given locale right now. */
export interface LocaleVoiceSupport {
  stt: VoiceProvider | null
  tts: VoiceProvider | null
}

/**
 * The per-locale capability matrix (§3): given the active locale,
 * the user's provider preference, and the runtime capabilities,
 * report which provider (if any) can do STT and TTS. `null` means
 * "no voice in this language" — the UI hides the control rather
 * than offering a dead button.
 */
export function voiceSupportForLocale(
  locale: string,
  pref: VoiceProviderPreference = 'auto',
  caps: VoiceCapabilities = detectVoiceCapabilities(),
): LocaleVoiceSupport {
  const lang = baseLanguage(locale)
  return {
    stt: resolveSttEngine(pref, lang, caps)?.provider ?? null,
    tts: resolveTtsEngine(pref, lang, caps)?.provider ?? null,
  }
}

/**
 * Base BCP-47 languages the voice stack can name with confidence —
 * the union of the cloud STT + TTS coverage. Backs the recognition-
 * language override (`voiceLang`): the settings picker offers these
 * so a visitor can speak a language that differs from the read UI
 * locale (bilingual floor, regional STT accuracy, kiosk pinning).
 * The caller prepends a "" ("same as app locale") default; the
 * browser engine still accepts any locale the OS supports via the
 * default path. (docs/ORBIT_VOICE_PLAN.md §8 — Phase 3)
 */
export function listVoiceLanguageOptions(): string[] {
  return [...new Set([...CLOUD_STT_LANGUAGES, ...CLOUD_TTS_LANGUAGES])].sort()
}

// ---------------------------------------------------------------------------
// Spoken-form projection (§1.1)
// ---------------------------------------------------------------------------

/**
 * Small domain glossary for terms that read badly letter-by-letter
 * or as an acronym. Conservative + whole-word only; extend with
 * care (wrong expansions are worse than none). Keys are matched
 * case-sensitively as standalone tokens.
 */
const SPOKEN_GLOSSARY: Readonly<Record<string, string>> = {
  SST: 'sea surface temperature',
  SSH: 'sea surface height',
}

/**
 * Project Orbit's written output into something a TTS engine should
 * read aloud. A spoken answer is not a written answer: strip the
 * `<<LOAD:…>>` / `[[LOAD:…]]` markers, dataset IDs, markdown syntax,
 * and URLs; flatten lists; collapse whitespace; expand a tiny
 * glossary. This is the source-of-truth for `splitIntoSpokenChunks`
 * — never the raw stream. (docs/ORBIT_VOICE_PLAN.md §1.1)
 */
export function toSpokenForm(input: string): string {
  let text = input ?? ''

  // Fenced + inline code → keep the inner text, drop the syntax.
  text = text.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, '$1')
  text = text.replace(/`([^`]+)`/g, '$1')

  // Load markers (both raw and placeholder forms) and bare dataset IDs.
  text = text.replace(/<?<LOAD:[^>]+>>?/g, '')
  text = text.replace(/\[\[LOAD:[^\]]+\]\]/g, '')
  text = text.replace(/\bINTERNAL_[A-Za-z0-9_]+\b/g, '')
  text = text.replace(/\bDS[0-9A-HJKMNP-TV-Z]{26}\b/g, '') // ULID dataset ids

  // Images then links → human-readable text only.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // Bare URLs.
  text = text.replace(/https?:\/\/\S+/g, '')

  // Headings, blockquotes, list markers at line starts.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  text = text.replace(/^[ \t]*>[ \t]?/gm, '')
  text = text.replace(/^[ \t]*([-*+]|\d+\.)[ \t]+/gm, '')

  // Emphasis / strikethrough markers (leave the words).
  text = text.replace(/(\*\*|__|\*|_|~~)(.*?)\1/g, '$2')

  // Glossary expansion (whole-word, case-sensitive).
  for (const [term, expansion] of Object.entries(SPOKEN_GLOSSARY)) {
    text = text.replace(new RegExp(`\\b${term}\\b`, 'g'), expansion)
  }

  // Collapse whitespace.
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').replace(/[ \t]*\n[ \t]*/g, '\n')
  return text.trim()
}

/**
 * Split spoken-form text into sentence-sized chunks so TTS can be
 * queued incrementally. Operates on a *complete* string (the
 * streaming, stateful variant lands with the playback layer in a
 * later phase). Empty / whitespace-only chunks are dropped.
 * (docs/ORBIT_VOICE_PLAN.md §2 practice 4, §10.2)
 */
export function splitIntoSpokenChunks(input: string): string[] {
  const text = toSpokenForm(input)
  if (!text) return []
  // Break after sentence-final punctuation, and on hard newlines.
  // Lookbehind-free on purpose: `(?<=…)` is a parse-time SyntaxError
  // on Safari 15 (a supported target), and because this module loads
  // at startup it would break the whole app even when voice is unused.
  // So insert a newline after `.!?` + whitespace, then split on newlines.
  return text
    .replace(/([.!?])\s+/g, '$1\n')
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Fake engines (for tests, and as a reference implementation shape)
// ---------------------------------------------------------------------------

/** A scripted STT engine for tests — emits the given transcript as a final result. */
export function createFakeSttEngine(opts: {
  provider?: VoiceProvider
  languages?: Iterable<string>
  transcript?: string
  available?: boolean
}): SttEngine {
  const langs = new Set(opts.languages ?? ['en'])
  return {
    provider: opts.provider ?? 'browser',
    supportsLanguage: (l) => langs.has(baseLanguage(l)),
    isAvailable: () => opts.available ?? true,
    start: ({ onResult, onEnd }) => {
      queueMicrotask(() => {
        onResult({ transcript: opts.transcript ?? '', isFinal: true })
        onEnd()
      })
      return { stop: () => {} }
    },
  }
}

/**
 * A driveable streaming STT engine for tests (and the reference shape
 * the real Deepgram/Cloudflare engines will implement). Real streaming
 * recognition is nondeterministic and can't run in CI (§10.3), so the
 * fake lets a test push partials, completed turns, and VAD transitions
 * into the active session by hand, and records stop/abortTurn for
 * barge-in assertions.
 */
export interface FakeStreamingSttEngine extends StreamingSttEngine {
  /** Emit a live partial transcript into the active session. */
  emitPartial(text: string): void
  /** Emit a completed (endpointed) turn into the active session. */
  emitTurn(text: string): void
  /** Emit a VAD speech-state transition into the active session. */
  emitSpeechState(speaking: boolean): void
  /** Emit a recoverable error into the active session. */
  emitError(error: Error): void
  /** Simulate the engine ending on its own (not via stop()) — service
   *  timeout, permission loss — to exercise caller recovery. */
  endActiveSession(): void
  /** True while a session is open (stop() not yet called). */
  readonly active: boolean
  readonly stopCount: number
  readonly abortTurnCount: number
}

export function createFakeStreamingSttEngine(opts: {
  provider?: VoiceProvider
  languages?: Iterable<string>
  available?: boolean
} = {}): FakeStreamingSttEngine {
  const langs = new Set(opts.languages ?? ['en'])
  let current: StreamingSttStartOptions | null = null
  let stopCount = 0
  let abortTurnCount = 0
  return {
    provider: opts.provider ?? 'browser',
    supportsLanguage: (l) => langs.has(baseLanguage(l)),
    isAvailable: () => opts.available ?? true,
    startStreaming: (options) => {
      current = options
      return {
        stop: () => {
          if (!current) return
          const ended = current
          current = null
          stopCount++
          ended.onEnd?.()
        },
        abortTurn: () => { abortTurnCount++ },
      }
    },
    emitPartial: (text) => current?.onPartial?.(text),
    emitTurn: (text) => current?.onTurn(text),
    emitSpeechState: (speaking) => current?.onSpeechStateChange?.(speaking),
    emitError: (error) => current?.onError(error),
    endActiveSession: () => {
      if (!current) return
      const ended = current
      current = null
      ended.onEnd?.()
    },
    get active() { return current !== null },
    get stopCount() { return stopCount },
    get abortTurnCount() { return abortTurnCount },
  }
}

/** A TTS engine for tests — records what it was asked to speak. */
export function createFakeTtsEngine(opts: {
  provider?: VoiceProvider
  languages?: Iterable<string>
  available?: boolean
  spoken?: string[]
}): TtsEngine {
  const langs = new Set(opts.languages ?? ['en'])
  const sink = opts.spoken ?? []
  return {
    provider: opts.provider ?? 'browser',
    supportsLanguage: (l) => langs.has(baseLanguage(l)),
    isAvailable: () => opts.available ?? true,
    speak: async (text) => { sink.push(text) },
    cancel: () => {},
  }
}
