/**
 * Cloudflare-edge voice engines (Phase 2) — STT via Whisper and TTS
 * via MeloTTS/Aura, talking to the `/api/voice/*` Pages Functions.
 *
 * These register as the `cloud` provider. They are **opt-in**: `auto`
 * never selects them (see `voiceService` AUTO_ORDER) because edge
 * inference is metered and the STT UX differs (record → upload, no
 * live interim). The user pins them via `voiceProvider: 'cloud'`.
 *
 * Web-only: the `/api` proxy doesn't exist in the Tauri desktop
 * shell, so these report unavailable there (desktop uses the browser
 * / on-device engines). A `KILL_VOICE` 503 disables them for the rest
 * of the session. (docs/ORBIT_VOICE_PLAN.md §3, §6, §7)
 */

import {
  registerSttEngine,
  registerTtsEngine,
  registerStreamingSttEngine,
  CLOUD_STT_LANGUAGES,
  CLOUD_TTS_LANGUAGES,
  baseLanguage,
  type SttEngine,
  type TtsEngine,
  type StreamingSttEngine,
} from './voiceService'
import { createWsStreamingSttEngine } from './voiceWsStreaming'
import { logger } from '../utils/logger'

const IS_TAURI = typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI__
const TRANSCRIBE_URL = '/api/voice/transcribe'
const SYNTHESIZE_URL = '/api/voice/synthesize'
/** Cap a single cloud recording so a forgotten session can't run forever. */
const MAX_RECORD_MS = 15_000

/** Set once the server reports `KILL_VOICE` (503 voice_disabled) — cools down for the session. */
let cloudVoiceDisabled = false

/** Test seam. */
export function __resetCloudVoiceDisabled(): void {
  cloudVoiceDisabled = false
}

async function readCode(res: Response): Promise<string | undefined> {
  try {
    return (await res.json() as { code?: string }).code
  } catch {
    return undefined
  }
}

/** Note a kill-switch response so subsequent calls short-circuit. */
function noteKill(res: Response, code: string | undefined): void {
  if (res.status === 503 && code === 'voice_disabled') {
    cloudVoiceDisabled = true
    logger.info('[voice] cloud voice disabled by server (KILL_VOICE)')
  }
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

let currentAudio: HTMLAudioElement | null = null

function playDataUrl(url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const audio = new Audio(url)
    currentAudio = audio
    const done = (): void => {
      if (currentAudio === audio) currentAudio = null
      resolve()
    }
    audio.onended = done
    audio.onerror = done
    // cancel() pauses rather than ending, which fires neither `ended`
    // nor `error` — resolve on pause too so an awaited speak() honours
    // its "resolves when finished or cancelled" contract instead of
    // hanging the TTS chain.
    audio.onpause = done
    // play() can reject (e.g. iOS gesture policy); resolve anyway so a
    // queued sequence can't wedge.
    audio.play().catch(done)
  })
}

export const cloudTtsEngine: TtsEngine = {
  provider: 'cloud',
  supportsLanguage: (lang) => CLOUD_TTS_LANGUAGES.has(baseLanguage(lang)),
  isAvailable: () => !IS_TAURI && !cloudVoiceDisabled,
  speak: async (text, opts) => {
    if (cloudVoiceDisabled || !text) return
    let res: Response
    try {
      res = await fetch(SYNTHESIZE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang: opts.lang }),
      })
    } catch (err) {
      logger.warn('[voice] cloud TTS request failed', err)
      return
    }
    if (!res.ok) {
      noteKill(res, await readCode(res))
      return
    }
    // Soft-fail a bad body — this runs inside the TTS queue chain, so a
    // throw here would reject the chain and wedge the Stop-speaking UI.
    let data: { audio?: string; format?: string }
    try {
      data = await res.json()
    } catch (err) {
      logger.warn('[voice] cloud TTS response parse failed', err)
      return
    }
    if (!data.audio) return
    await playDataUrl(`data:audio/mpeg;base64,${data.audio}`)
  },
  cancel: () => {
    currentAudio?.pause()
    currentAudio = null
  },
}

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

/**
 * POST a recorded utterance to the Whisper endpoint. Returns the
 * transcript, or an `Error` (kill-switch responses are noted so the
 * session cools down). Shared by the push-to-talk and streaming engines.
 */
async function transcribeBlob(blob: Blob): Promise<{ text: string } | { error: Error }> {
  try {
    const res = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    })
    if (!res.ok) {
      noteKill(res, await readCode(res))
      return { error: new Error(`transcribe ${res.status}`) }
    }
    const data = await res.json() as { text?: string }
    return { text: data.text ?? '' }
  } catch (err) {
    return { error: err as Error }
  }
}

export const cloudSttEngine: SttEngine = {
  provider: 'cloud',
  supportsLanguage: (lang) => CLOUD_STT_LANGUAGES.has(baseLanguage(lang)),
  isAvailable: (caps) => !IS_TAURI && !cloudVoiceDisabled && caps.mediaRecorder && caps.getUserMedia,
  start: ({ onResult, onError, onEnd }) => {
    let stopped = false
    let recorder: MediaRecorder | null = null
    let stream: MediaStream | null = null
    let safetyTimer: ReturnType<typeof setTimeout> | null = null
    const chunks: BlobPart[] = []

    const cleanup = (): void => {
      if (safetyTimer) clearTimeout(safetyTimer)
      stream?.getTracks().forEach(t => t.stop())
    }

    navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
      stream = s
      if (stopped) { cleanup(); onEnd(); return }
      recorder = new MediaRecorder(s)
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      recorder.onstop = async () => {
        cleanup()
        const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
        if (!blob.size) { onEnd(); return }
        const result = await transcribeBlob(blob)
        if ('error' in result) { onError(result.error); onEnd(); return }
        onResult({ transcript: result.text, isFinal: true })
        onEnd()
      }
      recorder.start()
      safetyTimer = setTimeout(() => {
        if (recorder?.state === 'recording') recorder.stop()
      }, MAX_RECORD_MS)
    }).catch((err) => {
      onError(err as Error)
      onEnd()
    })

    return {
      stop: () => {
        stopped = true
        if (recorder && recorder.state === 'recording') recorder.stop()
        else cleanup()
      },
    }
  },
}

/**
 * Realtime streaming STT over Cloudflare Whisper (Phase 3). Cloudflare
 * Whisper is request/response, not a live socket — so this engine
 * records **one VAD-bounded utterance per `startStreaming`→`stop`
 * cycle** (the caller's local VAD does the segmentation) and POSTs it
 * to `/api/voice/transcribe`, emitting the result as a single `onTurn`.
 * No live partials (the documented cloud STT trade-off, §4.4); a true
 * WebSocket path (Deepgram Nova-3/Flux on Workers AI) can register here
 * later behind the same interface. Reuses the session's mic `stream` so
 * the utterance isn't clipped by a second async `getUserMedia`.
 */
export const cloudStreamingSttEngine: StreamingSttEngine = {
  provider: 'cloud',
  supportsLanguage: (lang) => CLOUD_STT_LANGUAGES.has(baseLanguage(lang)),
  isAvailable: (caps) => !IS_TAURI && !cloudVoiceDisabled && caps.mediaRecorder && caps.getUserMedia,
  startStreaming: ({ stream, onTurn, onError, onEnd }) => {
    let stopped = false
    let aborted = false
    let recorder: MediaRecorder | null = null
    let ownStream: MediaStream | null = null // only set if we opened our own
    let safetyTimer: ReturnType<typeof setTimeout> | null = null
    const chunks: BlobPart[] = []

    const cleanup = (): void => {
      if (safetyTimer) clearTimeout(safetyTimer)
      // Stop only a mic we opened ourselves — a shared session stream is
      // owned (and reused across utterances) by the caller.
      ownStream?.getTracks().forEach(t => t.stop())
      ownStream = null
    }

    const begin = (s: MediaStream): void => {
      if (stopped) { cleanup(); onEnd?.(); return }
      recorder = new MediaRecorder(s)
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      recorder.onstop = async () => {
        cleanup()
        if (aborted) { onEnd?.(); return } // barge-in — discard, don't transcribe
        const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
        if (!blob.size) { onEnd?.(); return }
        const result = await transcribeBlob(blob)
        if ('error' in result) { onError(result.error); onEnd?.(); return }
        if (result.text) onTurn(result.text.trim())
        onEnd?.()
      }
      recorder.start()
      safetyTimer = setTimeout(() => {
        if (recorder?.state === 'recording') recorder.stop()
      }, MAX_RECORD_MS)
    }

    if (stream) {
      begin(stream)
    } else {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((s) => { ownStream = s; begin(s) })
        .catch((err) => { onError(err as Error); onEnd?.() })
    }

    const finalize = (): void => {
      if (recorder && recorder.state === 'recording') recorder.stop()
      else cleanup()
    }
    return {
      stop: () => { stopped = true; finalize() },
      abortTurn: () => { aborted = true; finalize() },
    }
  },
}

/**
 * Lazily-built realtime WS streaming engine, kept as a stable singleton
 * so repeated `registerCloudVoiceEngines()` calls (config change /
 * re-init) register the same instance idempotently.
 */
let wsStreamingEngine: StreamingSttEngine | null = null
function getWsStreamingEngine(): StreamingSttEngine {
  return (wsStreamingEngine ??= createWsStreamingSttEngine())
}

/** Register the cloud engines (web only). Idempotent via the registry. */
export function registerCloudVoiceEngines(): void {
  if (IS_TAURI) return
  registerSttEngine(cloudSttEngine)
  // Realtime WS streaming (live partials) is preferred for `cloud`
  // streaming when the deploy opts in (the AI Gateway must be
  // configured — see /api/voice/stream). Registered *ahead of* the
  // batch Whisper engine so the resolver picks it first; the batch
  // engine stays registered as the fallback the resolver drops to if
  // the WS path cools itself down (proxy error frame / handshake fail).
  // Default off so deploys that haven't set up the gateway are
  // unaffected.
  if (import.meta.env.VITE_VOICE_WS_STREAMING === 'true') {
    registerStreamingSttEngine(getWsStreamingEngine())
  }
  registerStreamingSttEngine(cloudStreamingSttEngine)
  registerTtsEngine(cloudTtsEngine)
  logger.debug('[voice] cloud engines registered (opt-in via provider=cloud)')
}
