/**
 * Wake-word detection (Phase 3.5) — "Hey Orbit" arms hands-free
 * listening without a tap, the committed exhibit affordance
 * (docs/ORBIT_VOICE_PLAN.md §8 decision 5).
 *
 * Two layers, split for testability like `voiceVad.ts`:
 *
 *   - `WakeWordDetector` — a **pure** score → wake state machine with
 *     threshold, debounce (consecutive frames) and a post-wake cooldown.
 *     No ONNX, no audio; fully deterministic and unit-tested.
 *   - `startWakeWord` (later slice) — lazy-loads `onnxruntime-web` and
 *     the openWakeWord pipeline (melspectrogram → speech embedding →
 *     wake model), runs it over the mic, and feeds per-frame scores in.
 *
 * Privacy/cost: the detector runs **entirely on-device** — no audio
 * leaves the machine until a wake fires and a real turn begins, which
 * is the whole reason a wake word beats an always-streaming open mic
 * in a noisy public hall (§9.1).
 */

import { createOnnxWakeWordScorer } from './voiceWakeWordOnnx'
import { logger } from '../utils/logger'

export interface WakeWordOptions {
  /** Model score (0..1) at or above which a frame counts as a hit. */
  threshold?: number
  /** Consecutive hit frames required to fire — debounces single-frame
   *  spikes / crowd-noise blips. */
  triggerFrames?: number
  /** Suppress further wakes for this long after one fires, so a single
   *  "Hey Orbit" doesn't double-trigger while the phrase is still in
   *  the model's window. */
  cooldownMs?: number
  onWake?: () => void
  /** Injectable clock (tests). */
  now?: () => number
}

const DEFAULT_THRESHOLD = 0.5
const DEFAULT_TRIGGER_FRAMES = 3
const DEFAULT_COOLDOWN_MS = 2000

/**
 * Turns a stream of per-frame wake-word scores into discrete wake
 * events. `push()` one score per model inference; `onWake` fires once
 * `triggerFrames` consecutive frames clear `threshold`, then the
 * detector goes deaf for `cooldownMs`.
 */
export class WakeWordDetector {
  private readonly threshold: number
  private readonly triggerFrames: number
  private readonly cooldownMs: number
  private readonly onWake?: () => void
  private readonly now: () => number

  private hitCount = 0
  private cooldownUntil = 0

  constructor(opts: WakeWordOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD
    this.triggerFrames = Math.max(1, opts.triggerFrames ?? DEFAULT_TRIGGER_FRAMES)
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? DEFAULT_COOLDOWN_MS)
    this.onWake = opts.onWake
    this.now = opts.now ?? Date.now
  }

  /** Whether the detector is actively listening (not in cooldown). */
  get armed(): boolean {
    return this.now() >= this.cooldownUntil
  }

  /** Feed one frame's wake-word score (0..1). */
  push(score: number): void {
    if (!this.armed) { this.hitCount = 0; return }
    if (score >= this.threshold) {
      this.hitCount++
      if (this.hitCount >= this.triggerFrames) {
        this.hitCount = 0
        this.cooldownUntil = this.now() + this.cooldownMs
        this.onWake?.()
      }
    } else {
      this.hitCount = 0
    }
  }

  /** Clear hit/cooldown state (e.g. when wake-word is disabled). */
  reset(): void {
    this.hitCount = 0
    this.cooldownUntil = 0
  }
}

// ---------------------------------------------------------------------------
// Scorer seam + composition
// ---------------------------------------------------------------------------

/** A running wake-word scorer; `stop()` releases its audio graph / model. */
export interface WakeWordCapture {
  stop(): void
}

/**
 * Produces per-frame wake-word scores from a mic stream and pushes them
 * to `onScore`. The concrete backend is the on-device openWakeWord
 * pipeline (onnxruntime-web: melspectrogram → speech embedding → wake
 * model); tests inject a fake. Async because the real one lazy-loads
 * the runtime + models.
 */
export type WakeWordScorer = (
  stream: MediaStream,
  onScore: (score: number) => void,
) => WakeWordCapture | Promise<WakeWordCapture>

export interface StartWakeWordOptions extends WakeWordOptions {
  /**
   * Base URL the openWakeWord ONNX models are hosted at (operator-
   * provided — they aren't bundled). When set (and no `scorer` is
   * injected), the default openWakeWord ONNX backend is used.
   */
  modelBaseUrl?: string
  /** Wake model filename under `modelBaseUrl` (default: `hey jarvis`). */
  wakeModel?: string
  /** onnxruntime-web ESM URL (CDN by default; self-host for offline). */
  ortUrl?: string
  /** Injectable scorer (tests / alternate backends). */
  scorer?: WakeWordScorer
}

/** A running wake-word session; `stop()` tears it down. */
export interface WakeWordSession {
  stop(): void
}

/**
 * Compose a scorer with a `WakeWordDetector`: every score the scorer
 * emits is fed through the threshold/debounce/cooldown machine, and
 * `onWake` fires on a confirmed wake.
 *
 * Returns **synchronously** so the caller holds a `stop()` while the
 * scorer is still loading (the ONNX backend fetches a runtime + three
 * models — seconds). Calling `stop()` during that window genuinely
 * cancels: the resolved capture is released the moment it arrives.
 * A scorer that fails to start is soft-failed (logged) — wake-word
 * just stays inert rather than rejecting and wedging voice startup.
 */
export function startWakeWord(
  stream: MediaStream,
  opts: StartWakeWordOptions,
): WakeWordSession {
  const detector = new WakeWordDetector(opts)
  const scorer = opts.scorer
    ?? (opts.modelBaseUrl
      ? createOnnxWakeWordScorer({ modelBaseUrl: opts.modelBaseUrl, wakeModel: opts.wakeModel, ortUrl: opts.ortUrl })
      : defaultScorerUnavailable)
  let stopped = false
  let capture: WakeWordCapture | null = null
  Promise.resolve(scorer(stream, (score) => { if (!stopped) detector.push(score) }))
    .then((c) => { if (stopped) c.stop(); else capture = c })
    .catch((err) => logger.warn('[voice] wake-word failed to start', err))
  return {
    stop: () => {
      stopped = true
      detector.reset()
      capture?.stop()
      capture = null
    },
  }
}

/**
 * Inert fallback when no models are configured and no scorer is
 * injected — reports unavailable (never scores) rather than silently
 * pretending to work. The real openWakeWord ONNX backend lives in
 * `voiceWakeWordOnnx.ts` and is selected automatically when
 * `modelBaseUrl` is set.
 */
const defaultScorerUnavailable: WakeWordScorer = () => ({ stop: () => {} })
