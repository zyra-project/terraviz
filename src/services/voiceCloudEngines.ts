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
  CLOUD_STT_LANGUAGES,
  CLOUD_TTS_LANGUAGES,
  baseLanguage,
  type SttEngine,
  type TtsEngine,
} from './voiceService'
import { logger } from '../utils/logger'

const IS_TAURI = !!(window as unknown as Record<string, unknown>).__TAURI__
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
        try {
          const res = await fetch(TRANSCRIBE_URL, {
            method: 'POST',
            headers: { 'Content-Type': blob.type },
            body: blob,
          })
          if (!res.ok) {
            noteKill(res, await readCode(res))
            onError(new Error(`transcribe ${res.status}`))
            onEnd()
            return
          }
          const data = await res.json() as { text?: string }
          onResult({ transcript: data.text ?? '', isFinal: true })
          onEnd()
        } catch (err) {
          onError(err as Error)
          onEnd()
        }
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

/** Register the cloud engines (web only). Idempotent via the registry. */
export function registerCloudVoiceEngines(): void {
  if (IS_TAURI) return
  registerSttEngine(cloudSttEngine)
  registerTtsEngine(cloudTtsEngine)
  logger.debug('[voice] cloud engines registered (opt-in via provider=cloud)')
}
