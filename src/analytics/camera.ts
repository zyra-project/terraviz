/**
 * Shared `camera_settled` helper — one emit path, one rounding
 * contract, one throttle budget for both the 2D MapLibre surface
 * (`mapRenderer.ts`) and the immersive XR surface (`vrInteraction.ts`
 * via `vrSession.ts`).
 *
 * The per-session throttle is intentionally projection-agnostic:
 * a user who flips from 2D to VR mid-session can't double up on
 * the budget by hitting both surfaces. The plan specifies ≤30/min
 * per session; the server also enforces this but a runaway client
 * would burn its rate limit and get 429s.
 *
 * Privacy rounding:
 *   - lat / lon → 3 decimals (≈ 110 m at the equator)
 *   - bearing / pitch → whole degrees
 *   - zoom → passed through (call sites already bucket naturally
 *     via MapLibre's zoom levels or the VR scale-to-zoom mapping)
 */

import { emit } from './emitter'
import type { CameraSettledEvent } from '../types'

/** Maximum `camera_settled` events per rolling minute, shared across
 * 2D + VR/AR emits. Drops (silently) when the budget is exhausted.
 * Exposed for tests. */
export const CAMERA_SETTLED_MAX_PER_MINUTE = 30

const WINDOW_MS = 60_000

interface CameraSettledParams {
  slot_index: string
  projection: CameraSettledEvent['projection']
  center_lat: number
  center_lon: number
  zoom: number
  bearing: number
  pitch: number
  /** Optional dataset id loaded in the slot at the moment the
   * camera settled. Forwarded verbatim to the event. */
  layer_id?: string | null
}

// Rolling-window sample buffer. Timestamps only; entries older than
// WINDOW_MS are evicted at emit time so the array stays bounded.
let sampleTimes: number[] = []

function pruneWindow(now: number): void {
  if (sampleTimes.length === 0) return
  const cutoff = now - WINDOW_MS
  // The array is naturally ordered by time (we push in order), so
  // splicing from the front until we pass the cutoff is cheap.
  while (sampleTimes.length > 0 && sampleTimes[0] < cutoff) {
    sampleTimes.shift()
  }
}

/** Round a value to `decimals` decimal places and strip `-0`. */
export function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

/** True when the throttle budget has room for one more emit. Tests
 * may read this to verify shared-budget semantics without emitting. */
export function canEmitCameraSettled(now: number = Date.now()): boolean {
  pruneWindow(now)
  return sampleTimes.length < CAMERA_SETTLED_MAX_PER_MINUTE
}

/**
 * Emit a `camera_settled` event if the throttle budget allows.
 * Silently drops if the budget is exhausted — the server side
 * has its own rate limit so losing an event here is preferable
 * to trickle-retrying and getting 429'd.
 *
 * Returns whether the event was actually emitted. Call sites can
 * use the return value for local bookkeeping (e.g. "did we skip
 * the last one?") but the emitter side is fire-and-forget.
 */
export function emitCameraSettled(params: CameraSettledParams): boolean {
  const now = Date.now()
  pruneWindow(now)
  if (sampleTimes.length >= CAMERA_SETTLED_MAX_PER_MINUTE) return false
  sampleTimes.push(now)

  emit({
    event_type: 'camera_settled',
    slot_index: params.slot_index,
    projection: params.projection,
    center_lat: round(params.center_lat, 3),
    center_lon: round(params.center_lon, 3),
    // zoom uses 2 decimals — MapLibre's fractional zoom is meaningful
    // but finer-than-0.01 precision is just noise.
    zoom: round(params.zoom, 2),
    bearing: Math.round(params.bearing),
    pitch: Math.round(params.pitch),
    layer_id: params.layer_id ?? null,
  })
  return true
}

/** Test helper: clear the throttle window so tests can assert the
 * budget without waiting 60 seconds between cases. Not exported
 * from the analytics barrel. */
export function __resetCameraThrottleForTests(): void {
  sampleTimes = []
}

/** Test helper: inspect the current window size. */
export function __cameraThrottleWindowSize(): number {
  return sampleTimes.length
}
