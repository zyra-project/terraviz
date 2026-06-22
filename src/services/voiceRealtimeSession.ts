/**
 * Hands-free realtime voice session controller (Phase 3, slice 4a).
 *
 * Ties the three Phase-3 primitives into one turn cycle, independent
 * of any concrete provider or UI:
 *
 *   - the streaming STT engine (`StreamingSttEngine`) for partials +
 *     turn detection,
 *   - the local VAD gate (`startMicVad`) so audio only streams during
 *     real speech (§9.1 acceptance criterion), and
 *   - a `mode` so the *same* controller drives **both** interaction
 *     models §9.1 asks us to prototype:
 *       • `open-mic`     — mic stays open; local VAD decides when to
 *                          stream (auto turn-taking, wake-word-ready).
 *       • `push-to-talk` — capture is caller-driven (a button); no VAD
 *                          gate, robust in a noisy hall.
 *
 * The controller owns the mic + stream lifecycle only. It does **not**
 * run the LLM or TTS — it emits transcripts (`onTurn`) and leaves
 * reply/speech to the caller. While Orbit is thinking or speaking the
 * caller calls `setSuspended(true)` so the mic can't self-trigger on
 * Orbit's own voice; barge-in/ducking refinements come in slice 5.
 *
 * The mic-acquire and VAD-start seams are injectable so the whole
 * state machine is testable against fakes (real getUserMedia / Web
 * Audio can't run in CI — §10.3).
 */
import { type StreamingSttEngine, type StreamingSttSession } from './voiceService'
import { startMicVad, type MicVad, type EnergyVadOptions } from './voiceVad'
import { logger } from '../utils/logger'

export type RealtimeMode = 'open-mic' | 'push-to-talk'

export type RealtimeState =
  /** Not armed; mic closed. */
  | 'idle'
  /** Armed: mic open (open-mic) or waiting for a press (push-to-talk); nothing streaming. */
  | 'listening'
  /** Speech detected / button held: audio is streaming, partials flow. */
  | 'capturing'
  /** Armed but gated off — Orbit is thinking/speaking; VAD ignored. */
  | 'suspended'

export type AcquireMic = () => Promise<MediaStream>
export type StartVad = typeof startMicVad

export interface RealtimeSessionOptions {
  engine: StreamingSttEngine
  lang: string
  mode: RealtimeMode
  onTurn: (transcript: string) => void
  onPartial?: (text: string) => void
  onStateChange?: (state: RealtimeState) => void
  onError?: (error: Error) => void
  /** Tuning for the local VAD gate (open-mic mode). */
  vad?: EnergyVadOptions
  /** Injectable for tests; defaults to `navigator.mediaDevices.getUserMedia`. */
  acquireMic?: AcquireMic
  /** Injectable for tests; defaults to `startMicVad`. */
  startVad?: StartVad
}

function defaultAcquireMic(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error('getUserMedia unavailable'))
  }
  return navigator.mediaDevices.getUserMedia({ audio: true })
}

export class RealtimeVoiceSession {
  private readonly opts: RealtimeSessionOptions
  private readonly acquireMic: AcquireMic
  private readonly startVad: StartVad

  private state: RealtimeState = 'idle'
  private stream: MediaStream | null = null
  private vad: MicVad | null = null
  private sttSession: StreamingSttSession | null = null
  private suspended = false
  private armSeq = 0 // generation token to detect disarm during async arm()

  constructor(opts: RealtimeSessionOptions) {
    this.opts = opts
    this.acquireMic = opts.acquireMic ?? defaultAcquireMic
    this.startVad = opts.startVad ?? startMicVad
  }

  getState(): RealtimeState {
    return this.state
  }

  private setState(next: RealtimeState): void {
    if (this.state === next) return
    this.state = next
    this.opts.onStateChange?.(next)
  }

  /**
   * Open the mic and begin listening. In open-mic mode this starts the
   * local VAD gate; in push-to-talk it just readies the session and
   * waits for `startCapture()`.
   */
  async arm(): Promise<void> {
    if (this.state !== 'idle') return
    // disarm() also leaves `state === 'idle'`, so state alone can't tell
    // us a disarm raced in while we awaited the mic. A generation token
    // does: disarm() (and any re-arm) bumps it, invalidating this call.
    const seq = ++this.armSeq
    let stream: MediaStream
    try {
      stream = await this.acquireMic()
    } catch (err) {
      if (seq === this.armSeq) this.opts.onError?.(err as Error)
      return
    }
    if (seq !== this.armSeq) {
      // disarm()/re-arm happened during acquisition — drop this mic.
      stream.getTracks().forEach(t => t.stop())
      return
    }
    this.stream = stream
    if (this.opts.mode === 'open-mic') {
      this.vad = this.startVad(this.stream, {
        ...this.opts.vad,
        onSpeechStart: () => this.onVadSpeechStart(),
        onSpeechEnd: () => this.onVadSpeechEnd(),
      })
    }
    this.setState('listening')
  }

  /** Close everything and return to idle. */
  disarm(): void {
    this.armSeq++ // invalidate any in-flight arm()
    this.endStream()
    this.vad?.stop()
    this.vad = null
    this.stopTracks()
    this.suspended = false
    this.setState('idle')
  }

  /**
   * Begin streaming a turn. Caller-driven in push-to-talk (button
   * down); VAD-driven in open-mic. No-op when suspended or already
   * capturing.
   */
  startCapture(): void {
    if (this.suspended) return
    if (this.state !== 'listening') return
    this.beginStream()
  }

  /** End the current turn's streaming (button up); keeps the session armed. */
  stopCapture(): void {
    if (this.state !== 'capturing') return
    this.endStream()
    this.setState(this.suspended ? 'suspended' : 'listening')
  }

  /**
   * Gate the mic while Orbit is thinking/speaking so it can't
   * self-trigger. `true` drops any in-flight turn and ignores VAD;
   * `false` resumes listening. (Echo handling / ducking: slice 5.)
   */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return
    this.suspended = suspended
    if (suspended) {
      this.endStream()
      if (this.state !== 'idle') this.setState('suspended')
    } else if (this.state === 'suspended') {
      this.setState('listening')
    }
  }

  // --- internal ---

  private onVadSpeechStart(): void {
    if (this.suspended || this.state !== 'listening') return
    this.beginStream()
  }

  private onVadSpeechEnd(): void {
    // Trailing silence — stop streaming so audio doesn't leave the
    // device during quiet. The engine has already endpointed any turn.
    if (this.state === 'capturing') this.stopCapture()
  }

  private beginStream(): void {
    if (this.sttSession || !this.stream) return
    let live = true
    let session: StreamingSttSession | undefined
    const onEnded = (): void => {
      live = false
      // Engine ended — ours via stop(), or unexpectedly (Web Speech
      // timeout, permission loss, network). Drop the session and return
      // to a recoverable state so the next onset/press can restart.
      if (session !== undefined && this.sttSession === session) {
        this.sttSession = null
        if (this.state === 'capturing') this.setState(this.suspended ? 'suspended' : 'listening')
      }
    }
    session = this.opts.engine.startStreaming({
      lang: this.opts.lang,
      stream: this.stream, // let a record→transcribe engine reuse our mic
      onPartial: (t) => this.opts.onPartial?.(t),
      onTurn: (t) => {
        this.opts.onTurn(t)
        // Open-mic auto-returns to listening after a turn; push-to-talk
        // stays capturing until the button is released.
        if (this.opts.mode === 'open-mic') {
          this.endStream()
          if (this.state === 'capturing') this.setState(this.suspended ? 'suspended' : 'listening')
        }
      },
      onError: (e) => this.opts.onError?.(e),
      onEnd: onEnded,
    })
    // The engine may have ended synchronously during start (e.g. an
    // immediate failure) — don't enter `capturing` with a dead session.
    if (!live) return
    this.sttSession = session
    this.setState('capturing')
  }

  private endStream(): void {
    const session = this.sttSession
    if (!session) return
    // Null first so the engine's onEnd (which stop() may fire) sees the
    // session already retired and doesn't double-handle the transition.
    this.sttSession = null
    try { session.stop() } catch (err) { logger.warn('[voice] realtime stop failed', err) }
  }

  private stopTracks(): void {
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
  }
}
