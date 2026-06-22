/**
 * Local voice-activity detection (VAD) for Phase 3 hands-free voice.
 *
 * §9.1 of docs/ORBIT_VOICE_PLAN.md makes "local VAD **before** any
 * audio is streamed" a Phase 3 acceptance criterion: in an
 * always-listening exhibit we must not ship mic audio to a realtime
 * STT provider until on-device detection says someone is actually
 * speaking. That bounds cost, and it's the privacy story (the mic is
 * open, but audio leaves the device only during a real utterance).
 *
 * Two layers, split for testability (real Web Audio can't run in CI):
 *
 *   - `EnergyVad` — a **pure** energy-threshold state machine with
 *     attack/release hysteresis. Feed it per-frame RMS energy; it
 *     emits speech onset/offset. No audio APIs, fully deterministic.
 *   - `startMicVad` — the thin Web Audio capture loop that computes
 *     RMS from an `AnalyserNode` and feeds `EnergyVad`. Browser-only
 *     glue; the logic it drives is what the tests pin down.
 */

export interface EnergyVadOptions {
  /**
   * RMS energy (0..1) at or above which a frame counts as speech.
   * The default is conservative for a quiet room; the exhibit tunes
   * this against recorded hall noise (§9.1).
   */
  threshold?: number
  /** Consecutive speech frames required to fire onset (attack). */
  attackFrames?: number
  /**
   * Consecutive sub-threshold frames required to fire offset
   * (release / hangover) — keeps brief pauses mid-utterance from
   * ending the turn.
   */
  releaseFrames?: number
  onSpeechStart?: () => void
  onSpeechEnd?: () => void
}

const DEFAULT_THRESHOLD = 0.015
const DEFAULT_ATTACK_FRAMES = 3
const DEFAULT_RELEASE_FRAMES = 12

/**
 * Energy-threshold VAD with hysteresis. `push()` one RMS sample per
 * audio frame; `onSpeechStart` fires after `attackFrames` consecutive
 * loud frames, `onSpeechEnd` after `releaseFrames` consecutive quiet
 * frames. Hysteresis stops a single spike or dropout from flapping
 * the state.
 */
export class EnergyVad {
  private readonly threshold: number
  private readonly attackFrames: number
  private readonly releaseFrames: number
  private readonly onSpeechStart?: () => void
  private readonly onSpeechEnd?: () => void

  private speakingState = false
  private attackCount = 0
  private releaseCount = 0

  constructor(opts: EnergyVadOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD
    this.attackFrames = Math.max(1, opts.attackFrames ?? DEFAULT_ATTACK_FRAMES)
    this.releaseFrames = Math.max(1, opts.releaseFrames ?? DEFAULT_RELEASE_FRAMES)
    this.onSpeechStart = opts.onSpeechStart
    this.onSpeechEnd = opts.onSpeechEnd
  }

  /** Whether the detector currently considers the input to be speech. */
  get speaking(): boolean {
    return this.speakingState
  }

  /** Feed one frame's RMS energy (0..1). */
  push(energy: number): void {
    if (energy >= this.threshold) {
      this.releaseCount = 0
      if (!this.speakingState) {
        this.attackCount++
        if (this.attackCount >= this.attackFrames) {
          this.speakingState = true
          this.attackCount = 0
          this.onSpeechStart?.()
        }
      }
    } else {
      this.attackCount = 0
      if (this.speakingState) {
        this.releaseCount++
        if (this.releaseCount >= this.releaseFrames) {
          this.speakingState = false
          this.releaseCount = 0
          this.onSpeechEnd?.()
        }
      }
    }
  }

  /** Drop all state back to silence without firing callbacks. */
  reset(): void {
    this.speakingState = false
    this.attackCount = 0
    this.releaseCount = 0
  }
}

/** Root-mean-square of a time-domain frame (each sample in -1..1). */
export function rmsEnergy(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] ?? 0
    sum += s * s
  }
  return Math.sqrt(sum / frame.length)
}

/** A running mic VAD; `stop()` tears down the audio graph. */
export interface MicVad {
  stop(): void
}

// Minimal structural types so this module doesn't depend on lib.dom's
// full AudioContext surface (and so the capture loop stays mockable).
interface AnalyserLike {
  fftSize: number
  getFloatTimeDomainData(array: Float32Array): void
}
interface AudioContextLike {
  createAnalyser(): AnalyserLike
  createMediaStreamSource(stream: MediaStream): { connect(node: AnalyserLike): void; disconnect(): void }
  close(): Promise<void>
  readonly state: string
}
type AudioContextCtor = new () => AudioContextLike

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w['AudioContext'] ?? w['webkitAudioContext'] ?? null) as AudioContextCtor | null
}

/**
 * Run energy VAD over a live mic `MediaStream`. Polls the analyser at
 * ~`frameMs` and feeds RMS into an `EnergyVad`. Returns a handle whose
 * `stop()` disconnects the source and closes the context. Browser-only
 * — returns `null` where Web Audio is unavailable.
 */
export function startMicVad(
  stream: MediaStream,
  opts: EnergyVadOptions & { frameMs?: number } = {},
): MicVad | null {
  const Ctor = getAudioContextCtor()
  if (!Ctor) return null

  const ctx = new Ctor()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)

  const vad = new EnergyVad(opts)
  const buf = new Float32Array(analyser.fftSize)
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf)
    vad.push(rmsEnergy(buf))
  }, opts.frameMs ?? 50)

  return {
    stop: () => {
      clearInterval(timer)
      try { source.disconnect() } catch { /* already torn down */ }
      if (ctx.state !== 'closed') void ctx.close().catch(() => {})
    },
  }
}
