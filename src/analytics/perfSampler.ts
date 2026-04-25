/**
 * Frame-rate sampler for the 2D MapLibre surface.
 *
 * Measures inter-frame deltas via `requestAnimationFrame`, computes
 * a rolling 10-second median FPS + 95th-percentile frame time, and
 * emits one `perf_sample` event per active minute. VR/AR sessions
 * report their own end-of-session arithmetic mean via
 * `vr_session_ended.mean_fps` — this sampler pauses while VR is
 * running so the two surfaces don't double-count.
 *
 * Tab-hidden discipline: the sampler stops sampling and stops the
 * minute timer while `document.hidden` is true. rAF is naturally
 * throttled by the browser when the tab is hidden, but the explicit
 * pause keeps the math honest — a 60-second-real-world minute that
 * contained 50 seconds of hidden time would otherwise look like a
 * crashed app.
 *
 * The WebGL renderer hash is computed once (lazy, cached) by hashing
 * `WEBGL_debug_renderer_info`'s UNMASKED_RENDERER_WEBGL string with
 * SHA-256 → first 8 hex chars. The raw GPU string is never emitted
 * — only the bucketed hash, which lets us see fleet composition
 * without identifying individual users by their GPU.
 */

import { emit } from './emitter'
import type { PerfSampleEvent } from '../types'

/** Sample window for the rolling median / p95 calculation. */
const WINDOW_MS = 10_000

/** Emit cadence — one `perf_sample` per active minute. The plan
 * caps `perf_sample` at ≤ 1/min per session at the ingest endpoint. */
const EMIT_INTERVAL_MS = 60_000

interface SamplerState {
  running: boolean
  /** Frame-time samples in milliseconds, newest at the end. Pruned
   * to the last `WINDOW_MS` of samples on every push. */
  samples: Array<{ at: number; deltaMs: number }>
  /** Last `requestAnimationFrame` ID, for cancel on stop / pause. */
  rafId: number | null
  /** Previous frame's timestamp from rAF. */
  lastFrameAt: number
  /** `setInterval` handle for the per-minute emit. */
  emitTimer: ReturnType<typeof setInterval> | null
  /** True when a higher-priority surface (VR/AR) is using the GPU. */
  externallyPaused: boolean
  /** AbortController for the visibilitychange listener. */
  visibilityAbort: AbortController | null
  /** Memoized renderer hash — computed once per app launch. */
  rendererHash: string | null
}

let state: SamplerState = createState()

function createState(): SamplerState {
  return {
    running: false,
    samples: [],
    rafId: null,
    lastFrameAt: 0,
    emitTimer: null,
    externallyPaused: false,
    visibilityAbort: null,
    rendererHash: null,
  }
}

/** Start sampling. Idempotent — second call while running is a
 * no-op. Respects document visibility immediately, so calling this
 * while the tab is hidden registers a no-op until the tab returns. */
export function startPerfSampler(): void {
  if (state.running) return
  state.running = true
  if (typeof document !== 'undefined') {
    if (!state.visibilityAbort) {
      state.visibilityAbort = new AbortController()
      document.addEventListener(
        'visibilitychange',
        () => {
          if (document.visibilityState === 'hidden') {
            stopFrameLoop()
            stopMinuteTimer()
          } else if (state.running && !state.externallyPaused) {
            startFrameLoop()
            startMinuteTimer()
          }
        },
        { signal: state.visibilityAbort.signal },
      )
    }
    // Tab is hidden right now — register the listener and bail.
    // The visibility handler will start both the rAF loop and the
    // minute timer when the tab becomes visible. Without bailing
    // here, the minute timer would tick during hidden periods,
    // muddying the "active minute" definition.
    if (document.visibilityState === 'hidden') return
  }
  startFrameLoop()
  startMinuteTimer()
}

function startMinuteTimer(): void {
  if (state.emitTimer) return
  if (typeof setInterval === 'undefined') return
  state.emitTimer = setInterval(emitSample, EMIT_INTERVAL_MS)
}

function stopMinuteTimer(): void {
  if (state.emitTimer === null) return
  clearInterval(state.emitTimer)
  state.emitTimer = null
}

/** Stop sampling. Drops any pending samples without emitting. */
export function stopPerfSampler(): void {
  state.running = false
  stopFrameLoop()
  stopMinuteTimer()
  state.visibilityAbort?.abort()
  state.visibilityAbort = null
  state.samples = []
}

/** Pause sampling because a VR/AR session has taken over the GPU.
 * The plan: VR has its own end-of-session FPS metric on
 * `vr_session_ended.mean_fps`; this sampler stays out of the way
 * so the two metrics describe disjoint surfaces. Stops both the
 * rAF loop and the per-minute emit timer — the timer alone could
 * still fire shortly after VR entry and emit a spurious sample
 * built from pre-VR frames still inside the 10-second rolling
 * window. Resumed via `resumeForVrExit()`. */
export function pauseForVrEntry(): void {
  state.externallyPaused = true
  stopFrameLoop()
  stopMinuteTimer()
}

/** Resume sampling after a VR/AR session ends. No-op if the sampler
 * was never started. Restarts the rAF loop and the per-minute emit
 * timer, both gated on the tab being visible. Stale samples from
 * before VR entry are aged out by `pruneSamples` on the next emit. */
export function resumeForVrExit(): void {
  state.externallyPaused = false
  if (state.running && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
    startFrameLoop()
    startMinuteTimer()
  }
}

/** Test helper — reset every piece of module state. Not exported
 * from the analytics barrel. */
export function __resetPerfSamplerForTests(): void {
  if (state.rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(state.rafId)
  }
  if (state.emitTimer !== null) {
    clearInterval(state.emitTimer)
  }
  state.visibilityAbort?.abort()
  state = createState()
}

/** Test helper — emit a sample synchronously regardless of the
 * minute timer. */
export function __emitSampleNowForTests(): void {
  emitSample()
}

/** Test helper — feed a synthetic frame delta (ms) into the
 * rolling window. Lets unit tests verify median / p95 math without
 * driving requestAnimationFrame. */
export function __feedFrameForTests(deltaMs: number, at: number = Date.now()): void {
  pushSample(deltaMs, at)
}

// ---------------------------------------------------------------
// Internals
// ---------------------------------------------------------------

function startFrameLoop(): void {
  if (state.rafId !== null) return
  if (typeof requestAnimationFrame === 'undefined') return
  state.lastFrameAt = performance.now()
  const tick = (now: number): void => {
    const delta = now - state.lastFrameAt
    state.lastFrameAt = now
    // Drop the very first interval (initialization spike) and any
    // delta over 1 s (tab swap / sleep).
    if (delta > 0 && delta < 1000) {
      pushSample(delta, Date.now())
    }
    state.rafId = requestAnimationFrame(tick)
  }
  state.rafId = requestAnimationFrame(tick)
}

function stopFrameLoop(): void {
  if (state.rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(state.rafId)
  }
  state.rafId = null
}

function pushSample(deltaMs: number, at: number): void {
  state.samples.push({ at, deltaMs })
  pruneSamples(at)
}

function pruneSamples(now: number): void {
  const cutoff = now - WINDOW_MS
  while (state.samples.length > 0 && state.samples[0].at < cutoff) {
    state.samples.shift()
  }
}

function emitSample(): void {
  pruneSamples(Date.now())
  if (state.samples.length < 10) return // not enough signal to be useful
  const deltas = state.samples.map((s) => s.deltaMs).slice().sort((a, b) => a - b)
  const median = quantile(deltas, 0.5)
  const p95 = quantile(deltas, 0.95)
  const fps = median > 0 ? Math.round(1000 / median) : 0
  const event: PerfSampleEvent = {
    event_type: 'perf_sample',
    surface: 'map',
    webgl_renderer_hash: rendererHash(),
    fps_median_10s: fps,
    frame_time_p95_ms: Math.round(p95 * 10) / 10,
    jsheap_mb: jsHeapMb(),
  }
  emit(event)
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0
  const pos = (sortedAsc.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sortedAsc[lo]
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo)
}

/** Read a Chromium-only memory metric when available. Other engines
 * return `null`; the schema accepts that. */
function jsHeapMb(): number | null {
  if (typeof performance === 'undefined') return null
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory
  if (!mem || typeof mem.usedJSHeapSize !== 'number') return null
  return Math.round(mem.usedJSHeapSize / (1024 * 1024))
}

/** Compute the renderer hash lazily. The result is cached for the
 * lifetime of the sampler so we don't pay the WebGL-context cost
 * on every emit. Falls back to the literal `'unknown'` when the
 * GPU info isn't reachable (some browsers gate it behind a flag). */
function rendererHash(): string {
  if (state.rendererHash !== null) return state.rendererHash
  state.rendererHash = computeRendererHashSync()
  return state.rendererHash
}

function computeRendererHashSync(): string {
  if (typeof document === 'undefined') return 'unknown'
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return 'unknown'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    if (!ext) return 'unknown'
    const renderer = gl.getParameter(
      (ext as unknown as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL,
    )
    if (typeof renderer !== 'string') return 'unknown'
    return shortHash(renderer)
  } catch {
    return 'unknown'
  }
}

/** Stable 8-hex-char hash. Not crypto-strong (we want a sync call
 * with no async crypto round-trip), just enough for an opaque GPU
 * bucket. djb2-style with hex output — collisions are acceptable
 * because dashboards aggregate by the bucket, not by individual
 * users. */
function shortHash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0
  }
  // 8-hex-char output, zero-padded
  return h.toString(16).padStart(8, '0').slice(-8)
}
