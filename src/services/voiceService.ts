/**
 * Voice service — the shared speech abstraction for Orbit.
 *
 * Both the 2D chat (`chatUI.ts`) and the VR docent talk to *this*
 * module, never to `SpeechRecognition` / `speechSynthesis` /
 * cloud endpoints directly. It owns:
 *
 *   - capability detection (what this environment can do),
 *   - a provider registry + resolver (on-device → cloud → browser),
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

const sttEngines: SttEngine[] = []
const ttsEngines: TtsEngine[] = []

export function registerSttEngine(engine: SttEngine): void {
  if (!sttEngines.some(e => e.provider === engine.provider)) sttEngines.push(engine)
}

export function registerTtsEngine(engine: TtsEngine): void {
  if (!ttsEngines.some(e => e.provider === engine.provider)) ttsEngines.push(engine)
}

/** Clear the registry — for tests, and for re-registration on config change. */
export function resetVoiceEngines(): void {
  sttEngines.length = 0
  ttsEngines.length = 0
}

/**
 * Resolution order for `auto`. On-device first (best privacy, no
 * per-use cost), then the Cloudflare edge, then the browser API.
 * Phases 2/4 register the `cloud` / `local` engines; until then
 * `auto` falls through to `browser`. (docs/ORBIT_VOICE_PLAN.md §4.4)
 */
const AUTO_ORDER: readonly VoiceProvider[] = ['local', 'cloud', 'browser']

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
  // Break after sentence-final punctuation followed by whitespace,
  // and on hard newlines.
  return text
    .split(/(?<=[.!?])\s+|\n+/)
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
