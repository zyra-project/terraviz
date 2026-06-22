/**
 * Hands-free voice wiring (Phase 3, slice 4d).
 *
 * Bridges the service-layer `RealtimeVoiceSession` (continuous STT +
 * local VAD gate, both interaction models) to the chat UI:
 *
 *   - live partials fill the input so the user sees what's heard,
 *   - a completed turn submits the message,
 *   - the mic is suspended while Orbit is thinking/speaking so it can't
 *     transcribe its own TTS (§9.1 self-trigger guard).
 *
 * The session exists only when the user opts into a hands-free mode
 * AND a streaming engine resolves for the locale; otherwise this is
 * inert and the Phase 1 single-tap mic is untouched. The mic/VAD seams
 * are injectable so the controller is testable against fakes.
 */
import {
  RealtimeVoiceSession,
  type RealtimeState,
  type AcquireMic,
  type StartVad,
} from '../services/voiceRealtimeSession'
import { resolveStreamingSttEngine } from '../services/voiceService'
import type { VoiceHandsFreeMode, VoiceProviderPreference } from '../types'
import { logger } from '../utils/logger'

export interface HandsFreeHooks {
  /** Live partial transcript — write into the input field. */
  onPartial: (text: string) => void
  /** A completed turn — set the input and submit. */
  onTurn: (text: string) => void
  /** Session state changed — update the listening indicator. */
  onStateChange?: (state: RealtimeState) => void
}

export interface HandsFreeSyncOptions {
  mode: VoiceHandsFreeMode
  lang: string
  provider: VoiceProviderPreference
}

/** Optional mic/VAD seams forwarded to the session (tests inject fakes). */
export interface HandsFreeDeps {
  acquireMic?: AcquireMic
  startVad?: StartVad
}

export class HandsFreeController {
  private session: RealtimeVoiceSession | null = null
  private mode: VoiceHandsFreeMode = 'off'
  private muted = false
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
    this.session = new RealtimeVoiceSession({
      engine,
      lang: opts.lang,
      mode: opts.mode,
      onPartial: (t) => this.hooks.onPartial(t),
      onTurn: (t) => this.hooks.onTurn(t),
      onStateChange: (s) => this.hooks.onStateChange?.(s),
      onError: (e) => logger.warn('[voice] hands-free session error', e),
      acquireMic: this.deps.acquireMic,
      startVad: this.deps.startVad,
    })
    // open-mic listens continuously from the moment it's enabled;
    // push-to-talk waits for the first press.
    if (opts.mode === 'open-mic') void this.session.arm()
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

  /** Toggle mute (open-mic). Returns the new muted state. */
  toggleMute(): boolean {
    this.muted = !this.muted
    if (this.session) {
      if (this.muted) this.session.disarm()
      else if (this.mode === 'open-mic') void this.session.arm()
    }
    return this.muted
  }

  /** Suspend/resume the mic while Orbit is thinking/speaking. */
  setBusy(busy: boolean): void {
    this.session?.setSuspended(busy)
  }

  teardown(): void {
    this.session?.disarm()
    this.session = null
    this.mode = 'off'
    this.muted = false
  }
}
