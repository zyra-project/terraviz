/**
 * Hands-free voice wiring (Phase 3, slice 4d + wake-word integration).
 *
 * Bridges the service-layer `RealtimeVoiceSession` (continuous STT +
 * local VAD gate, all interaction models) to the chat UI:
 *
 *   - live partials fill the input so the user sees what's heard,
 *   - a completed turn submits the message,
 *   - the mic is suspended while Orbit is thinking/speaking so it can't
 *     transcribe its own TTS (§9.1 self-trigger guard).
 *
 * Three hands-free interaction models (§9.1):
 *   - `push-to-talk` — a held control opens the mic for one turn,
 *   - `open-mic`     — continuous, local-VAD-gated listening,
 *   - `wake-word`    — silent until an on-device "Hey Orbit" wake arms a
 *                      single turn. No audio streams to STT until a wake
 *                      fires (the tiny wake model is the only thing
 *                      listening), the privacy-preserving exhibit path.
 *
 * The session exists only when the user opts into a hands-free mode AND
 * a streaming engine resolves for the locale; otherwise this is inert
 * and the Phase 1 single-tap mic is untouched. The mic/VAD/wake seams
 * are injectable so the controller is testable against fakes.
 * (docs/ORBIT_VOICE_PLAN.md §8 decision 5, §9.1, §10.4)
 */
import {
  RealtimeVoiceSession,
  type RealtimeMode,
  type RealtimeState,
  type AcquireMic,
  type StartVad,
} from '../services/voiceRealtimeSession'
import { resolveStreamingSttEngine } from '../services/voiceService'
import { startWakeWord } from '../services/voiceWakeWord'
import type { VoiceHandsFreeMode, VoiceProviderPreference } from '../types'
import { logger } from '../utils/logger'

export interface HandsFreeHooks {
  /** Live partial transcript — write into the input field. */
  onPartial: (text: string) => void
  /** A completed turn — set the input and submit. */
  onTurn: (text: string) => void
  /** Session state changed — update the listening indicator. */
  onStateChange?: (state: RealtimeState) => void
  /** A wake fired but no turn followed (a false fire) — for §10.4 telemetry. */
  onWakeMisfire?: () => void
}

export interface HandsFreeSyncOptions {
  mode: VoiceHandsFreeMode
  lang: string
  provider: VoiceProviderPreference
}

/** A running wake-word listener; `stop()` releases its mic + model. */
export interface WakeSession { stop(): void }
/** Start on-device wake-word listening; `onWake` fires on "Hey Orbit". */
export type StartWake = (onWake: () => void) => WakeSession

/** Optional mic/VAD/wake seams forwarded to the session (tests inject fakes). */
export interface HandsFreeDeps {
  acquireMic?: AcquireMic
  startVad?: StartVad
  startWake?: StartWake
}

// A wake that arms a turn but hears nothing is abandoned after this long,
// so a stray "Hey Orbit" doesn't hold the mic open forever. Real turns
// endpoint well inside this via the streaming engine's turn detector.
const WAKE_CAPTURE_TIMEOUT_MS = 8000

// Operator-provided wake-word config (build env; mirrors the
// `VITE_VOICE_WS_STREAMING` opt-in). Absent a model URL, wake-word is
// unconfigured and the mode stays inert / hidden.
const WAKE_MODEL_URL = import.meta.env.VITE_VOICE_WAKEWORD_MODEL_URL as string | undefined
const WAKE_MODEL = import.meta.env.VITE_VOICE_WAKEWORD_MODEL as string | undefined
const WAKE_ORT_URL = import.meta.env.VITE_VOICE_WAKEWORD_ORT_URL as string | undefined

const IS_TAURI = typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI__

/**
 * Whether the wake-word hands-free mode can run here: a model URL is
 * configured and we're on the web (the ONNX/CDN path is web-only, like
 * the cloud engines). Gates the settings option so it isn't offered as
 * a dead choice.
 */
export function isWakeWordConfigured(): boolean {
  return !IS_TAURI && !!WAKE_MODEL_URL
}

function defaultAcquireMic(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error('getUserMedia unavailable'))
  }
  return navigator.mediaDevices.getUserMedia({ audio: true })
}

/**
 * Default wake-word starter: acquire a dedicated mic and run the
 * on-device openWakeWord pipeline over it. Its own mic (separate from
 * the turn-capture session's) stays open continuously, but nothing is
 * streamed anywhere — only the local score → wake decision runs. Soft-
 * fails: a mic/model failure just means no wakes, never a throw.
 */
const defaultStartWake: StartWake = (onWake) => {
  if (!WAKE_MODEL_URL) return { stop: () => {} }
  let stopped = false
  let inner: { stop(): void } | null = null
  let micStream: MediaStream | null = null
  defaultAcquireMic()
    .then((stream) => {
      if (stopped) { stream.getTracks().forEach(t => t.stop()); return }
      micStream = stream
      inner = startWakeWord(stream, {
        modelBaseUrl: WAKE_MODEL_URL,
        wakeModel: WAKE_MODEL,
        ortUrl: WAKE_ORT_URL,
        onWake,
      })
    })
    .catch((err) => logger.warn('[voice] wake-word mic failed', err))
  return {
    stop: () => {
      stopped = true
      inner?.stop(); inner = null
      micStream?.getTracks().forEach(t => t.stop()); micStream = null
    },
  }
}

export class HandsFreeController {
  private session: RealtimeVoiceSession | null = null
  private wake: WakeSession | null = null
  private mode: VoiceHandsFreeMode = 'off'
  private muted = false
  private busy = false // Orbit is thinking/speaking — ignore wakes
  private wakeCaptureTimer: ReturnType<typeof setTimeout> | null = null
  // Last-synced language / provider, so a lang or provider change while
  // staying in the same mode still rebuilds the session.
  private lang = ''
  private provider: VoiceProviderPreference = 'auto'

  constructor(
    private readonly hooks: HandsFreeHooks,
    private readonly deps: HandsFreeDeps = {},
  ) {}

  get currentMode(): VoiceHandsFreeMode { return this.mode }
  isActive(): boolean { return this.session !== null }
  isMuted(): boolean { return this.muted }
  getState(): RealtimeState { return this.session?.getState() ?? 'idle' }

  /**
   * (Re)configure from the current voice config. Tears down on `off`
   * or when no streaming engine resolves; (re)creates on a real change.
   * A no-op only when mode AND language AND provider are unchanged
   * (otherwise the live session would keep recognizing with stale
   * settings).
   */
  sync(opts: HandsFreeSyncOptions): void {
    const unchanged = opts.mode === this.mode
      && opts.lang === this.lang
      && opts.provider === this.provider
      && (this.mode === 'off' || this.session !== null)
    if (unchanged) return
    this.teardown()
    this.lang = opts.lang
    this.provider = opts.provider
    if (opts.mode === 'off') return
    const engine = resolveStreamingSttEngine(opts.provider, opts.lang)
    if (!engine) return // no streaming engine for this locale → stay inert
    this.mode = opts.mode
    // wake-word captures a turn like push-to-talk (no VAD, caller-driven
    // start; we end it ourselves on the turn), gated by the wake.
    const realtimeMode: RealtimeMode = opts.mode === 'open-mic' ? 'open-mic' : 'push-to-talk'
    this.session = new RealtimeVoiceSession({
      engine,
      lang: opts.lang,
      mode: realtimeMode,
      onPartial: (t) => this.hooks.onPartial(t),
      onTurn: (t) => this.handleTurn(t),
      onStateChange: (s) => this.hooks.onStateChange?.(s),
      onError: (e) => logger.warn('[voice] hands-free session error', e),
      acquireMic: this.deps.acquireMic,
      startVad: this.deps.startVad,
    })
    if (opts.mode === 'open-mic') {
      // Listens continuously from the moment it's enabled.
      void this.session.arm()
    } else if (opts.mode === 'wake-word') {
      // Silent until "Hey Orbit"; the session arms per-wake.
      const start = this.deps.startWake ?? defaultStartWake
      this.wake = start(() => this.onWake())
    }
    // push-to-talk waits for the first press.
  }

  /** push-to-talk press (button down). Arms lazily on the first press. */
  async press(): Promise<void> {
    if (this.mode !== 'push-to-talk' || !this.session || this.muted) return
    if (this.session.getState() === 'idle') await this.session.arm()
    this.session.startCapture()
  }

  /** push-to-talk release (button up / leave). */
  release(): void {
    if (this.mode !== 'push-to-talk') return
    this.session?.stopCapture()
  }

  /** Toggle mute. Returns the new muted state. */
  toggleMute(): boolean {
    this.muted = !this.muted
    if (!this.session) return this.muted
    if (this.mode === 'open-mic') {
      if (this.muted) this.session.disarm()
      else void this.session.arm()
    } else if (this.mode === 'wake-word') {
      // Stop listening for the wake entirely while muted; abandon any
      // in-flight wake-armed turn.
      if (this.muted) {
        this.stopWake()
        this.endWakeTurn()
      } else {
        const start = this.deps.startWake ?? defaultStartWake
        this.wake = start(() => this.onWake())
      }
    }
    return this.muted
  }

  /** Suspend/resume the mic while Orbit is thinking/speaking. */
  setBusy(busy: boolean): void {
    this.busy = busy
    this.session?.setSuspended(busy)
  }

  teardown(): void {
    this.stopWake()
    this.clearWakeTimer()
    this.session?.disarm()
    this.session = null
    this.mode = 'off'
    this.muted = false
    this.busy = false
  }

  // --- wake-word internals ---

  /** A confirmed "Hey Orbit" — arm a single turn (unless muted/busy). */
  private onWake(): void {
    if (this.mode !== 'wake-word' || !this.session || this.muted || this.busy) return
    // Already handling a wake-armed turn — ignore (the detector's own
    // cooldown also debounces this).
    if (this.session.getState() !== 'idle') return
    void (async () => {
      await this.session?.arm()
      // A teardown/mute could have raced in during mic acquisition.
      if (this.mode !== 'wake-word' || !this.session) return
      this.session.startCapture()
      this.clearWakeTimer()
      this.wakeCaptureTimer = setTimeout(() => {
        // Heard the wake but no turn followed — a false fire.
        this.endWakeTurn()
        this.hooks.onWakeMisfire?.()
      }, WAKE_CAPTURE_TIMEOUT_MS)
    })()
  }

  /** End a wake-armed capture and return to wake-listening (mic released). */
  private endWakeTurn(): void {
    this.clearWakeTimer()
    if (this.session && this.session.getState() !== 'idle') this.session.disarm()
  }

  private handleTurn(text: string): void {
    this.hooks.onTurn(text)
    // A wake-word turn is one utterance: end the capture so only the tiny
    // wake model listens again (open-mic/push-to-talk keep their session).
    if (this.mode === 'wake-word') this.endWakeTurn()
  }

  private stopWake(): void {
    this.wake?.stop()
    this.wake = null
  }

  private clearWakeTimer(): void {
    if (this.wakeCaptureTimer) { clearTimeout(this.wakeCaptureTimer); this.wakeCaptureTimer = null }
  }
}
