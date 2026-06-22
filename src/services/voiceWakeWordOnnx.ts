/**
 * openWakeWord ONNX scorer (Phase 3.5) — the on-device backend that
 * turns mic audio into per-frame wake-word scores for
 * `WakeWordDetector`. Faithful port of openWakeWord's inference
 * pipeline (https://github.com/dscripka/openWakeWord):
 *
 *   16 kHz mono audio
 *     → melspectrogram model         (audio → 32-bin mel frames, x/10+2)
 *     → speech embedding model        (76 mel frames × 32 → 96-dim, stride 8)
 *     → wake model                    (16 embeddings → score 0..1)
 *
 * Design choices that keep it dependency-light and exhibit-friendly:
 *
 *   - **No npm dependency.** `onnxruntime-web` is lazy-imported from a
 *     configurable CDN URL only when wake-word is enabled (operators can
 *     self-host for offline kiosks — set `ortUrl`). Keeps it out of the
 *     main bundle entirely, like the Three.js VR path.
 *   - **Operator-hosted models.** The three `.onnx` files load from
 *     `modelBaseUrl`; they aren't bundled (licensing + size). See
 *     `docs/ORBIT_WAKEWORD.md` for which files and how to swap the wake
 *     model (built-in `hey jarvis` → a custom "Hey Orbit").
 *   - **Entirely on-device.** Audio never leaves the machine; only the
 *     score does, and only `WakeWordDetector` sees it.
 *
 * ⚠️ This pipeline is written against openWakeWord's documented tensor
 * shapes but **cannot be validated in CI** (no models, no mic). It
 * needs real-hardware validation before exhibit use — see the doc.
 */
import type { WakeWordCapture, WakeWordScorer } from './voiceWakeWord'
import { logger } from '../utils/logger'

// --- openWakeWord pipeline constants (see utils.py AudioFeatures) ---
const SAMPLE_RATE = 16000
const CHUNK_SAMPLES = 1280          // 80 ms per processed audio chunk
const MEL_BINS = 32
const EMBED_WINDOW_FRAMES = 76      // mel frames per embedding window
const EMBED_STRIDE_FRAMES = 8       // advance between embedding windows
const EMBED_DIM = 96
const WAKE_WINDOW_EMBEDS = 16       // embeddings per wake-model inference
const MEL_NORM = (x: number): number => x / 10 + 2

const DEFAULT_ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.mjs'
/** Default built-in wake model (CC BY-NC-SA — see docs/ORBIT_WAKEWORD.md). */
export const DEFAULT_WAKE_MODEL = 'hey_jarvis_v0.1.onnx'

// Minimal onnxruntime-web surface (loaded at runtime; no @types needed).
interface OrtTensor { data: Float32Array; dims: readonly number[] }
interface OrtSession {
  inputNames: string[]
  outputNames: string[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
}
interface OrtModule {
  env: { wasm: { wasmPaths?: string; numThreads?: number } }
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor
  InferenceSession: { create(uri: string): Promise<OrtSession> }
}

export interface OnnxWakeWordOptions {
  /** Base URL the three ONNX model files are hosted at. */
  modelBaseUrl: string
  /** Wake model filename under `modelBaseUrl`. Default: `hey jarvis`. */
  wakeModel?: string
  /** onnxruntime-web ESM URL (CDN by default; self-host for offline). */
  ortUrl?: string
}

async function loadOrt(ortUrl: string): Promise<OrtModule> {
  // @vite-ignore: a runtime URL import — never bundled, fetched lazily.
  const mod = (await import(/* @vite-ignore */ ortUrl)) as unknown as OrtModule
  // Point the wasm loader at the same CDN dir as the JS by default.
  mod.env.wasm.wasmPaths = ortUrl.replace(/[^/]+$/, '')
  return mod
}

/**
 * Build the openWakeWord ONNX scorer. Returns a `WakeWordScorer` that
 * `startWakeWord` composes with the detector.
 */
export function createOnnxWakeWordScorer(opts: OnnxWakeWordOptions): WakeWordScorer {
  const base = opts.modelBaseUrl.replace(/\/$/, '')
  const wakeModel = opts.wakeModel ?? DEFAULT_WAKE_MODEL
  const ortUrl = opts.ortUrl ?? DEFAULT_ORT_URL

  return async (stream: MediaStream, onScore: (score: number) => void): Promise<WakeWordCapture> => {
    let stopped = false
    const inert: WakeWordCapture = { stop: () => { stopped = true } }

    // Soft-fail the runtime + model load: a missing CDN, bad modelBaseUrl
    // or incompatible model must not reject and wedge voice startup — log
    // and stay inert (no scores → no wakes).
    let ort: OrtModule
    let melSess: OrtSession, embSess: OrtSession, wakeSess: OrtSession
    try {
      ort = await loadOrt(ortUrl)
      ;[melSess, embSess, wakeSess] = await Promise.all([
        ort.InferenceSession.create(`${base}/melspectrogram.onnx`),
        ort.InferenceSession.create(`${base}/embedding_model.onnx`),
        ort.InferenceSession.create(`${base}/${wakeModel}`),
      ])
    } catch (err) {
      logger.warn('[voice] wake-word: failed to load onnxruntime-web / models', err)
      return inert
    }
    if (stopped) return inert

    // Rolling feature buffers.
    const melBuffer: Float32Array[] = []  // each entry = one 32-bin frame
    const embBuffer: Float32Array[] = []  // each entry = one 96-dim embedding

    async function runMel(chunk: Float32Array): Promise<void> {
      const out = await melSess.run({ [melSess.inputNames[0]!]: new ort.Tensor('float32', chunk, [1, chunk.length]) })
      const mel = out[melSess.outputNames[0]!]!
      const bins = mel.dims[mel.dims.length - 1]! // 32
      const frames = mel.dims[mel.dims.length - 2]!
      const data = mel.data
      for (let f = 0; f < frames; f++) {
        const frame = new Float32Array(bins)
        for (let b = 0; b < bins; b++) frame[b] = MEL_NORM(data[f * bins + b] ?? 0)
        melBuffer.push(frame)
      }
    }

    async function pumpEmbeddings(): Promise<void> {
      // One embedding per `EMBED_WINDOW_FRAMES` window, advancing `EMBED_STRIDE_FRAMES`.
      while (melBuffer.length >= EMBED_WINDOW_FRAMES) {
        const flat = new Float32Array(EMBED_WINDOW_FRAMES * MEL_BINS)
        for (let i = 0; i < EMBED_WINDOW_FRAMES; i++) flat.set(melBuffer[i]!, i * MEL_BINS)
        const out = await embSess.run({ [embSess.inputNames[0]!]: new ort.Tensor('float32', flat, [1, EMBED_WINDOW_FRAMES, MEL_BINS, 1]) })
        embBuffer.push(Float32Array.from(out[embSess.outputNames[0]!]!.data)) // 96-dim
        melBuffer.splice(0, EMBED_STRIDE_FRAMES)
        await pumpWake()
      }
      // Keep the mel buffer from growing without bound.
      if (melBuffer.length > EMBED_WINDOW_FRAMES * 2) melBuffer.splice(0, melBuffer.length - EMBED_WINDOW_FRAMES)
    }

    async function pumpWake(): Promise<void> {
      if (embBuffer.length < WAKE_WINDOW_EMBEDS) return
      const flat = new Float32Array(WAKE_WINDOW_EMBEDS * EMBED_DIM)
      const start = embBuffer.length - WAKE_WINDOW_EMBEDS
      for (let i = 0; i < WAKE_WINDOW_EMBEDS; i++) flat.set(embBuffer[start + i]!, i * EMBED_DIM)
      const out = await wakeSess.run({ [wakeSess.inputNames[0]!]: new ort.Tensor('float32', flat, [1, WAKE_WINDOW_EMBEDS, EMBED_DIM]) })
      const score = out[wakeSess.outputNames[0]!]!.data[0] ?? 0
      if (!stopped) onScore(score)
      if (embBuffer.length > WAKE_WINDOW_EMBEDS * 2) embBuffer.splice(0, embBuffer.length - WAKE_WINDOW_EMBEDS)
    }

    // --- Audio capture at 16 kHz, serialized inference ---
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    const closeCtx = (): void => {
      try { void ctx.close().catch(() => {}) } catch { /* already closing */ }
    }
    // The requested rate is only a hint — the browser may pick another.
    // Feeding the models off-rate audio yields meaningless scores (and
    // could false-fire), so fail closed rather than misfire. (A resampler
    // is the future fix; see docs/ORBIT_WAKEWORD.md.)
    if (ctx.sampleRate !== SAMPLE_RATE) {
      logger.warn(`[voice] wake-word: AudioContext is ${ctx.sampleRate} Hz, not ${SAMPLE_RATE} Hz — disabling`)
      closeCtx()
      return inert
    }
    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(2048, 1, 1)
    let pending = new Float32Array(0)
    let inflight = false
    // Cap the backlog so a kiosk that can't keep up drops the oldest
    // audio rather than growing memory/latency unbounded.
    const MAX_PENDING = SAMPLE_RATE * 2 // ~2 s of 16 kHz audio

    async function drain(): Promise<void> {
      if (inflight) return // serialize: one chunk through the models at a time
      inflight = true
      try {
        while (!stopped && pending.length >= CHUNK_SAMPLES) {
          const chunk = pending.slice(0, CHUNK_SAMPLES)
          pending = pending.slice(CHUNK_SAMPLES)
          await runMel(chunk)
          await pumpEmbeddings()
        }
      } catch (err) {
        logger.warn('[voice] wake-word inference failed', err)
      } finally {
        inflight = false
      }
    }

    processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      if (stopped) return
      const input = e.inputBuffer.getChannelData(0)
      let merged = new Float32Array(pending.length + input.length)
      merged.set(pending); merged.set(input, pending.length)
      // Drop oldest audio beyond the cap (inference fell behind).
      if (merged.length > MAX_PENDING) merged = merged.slice(merged.length - MAX_PENDING)
      pending = merged
      void drain()
    }
    source.connect(processor)
    processor.connect(ctx.destination)

    return {
      stop: () => {
        stopped = true
        try { processor.disconnect(); source.disconnect() } catch { /* already torn down */ }
        closeCtx()
      },
    }
  }
}
