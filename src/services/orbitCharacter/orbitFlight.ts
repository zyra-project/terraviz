/**
 * Flight system + scale presets.
 *
 * Three presets sell a different scale register each (design doc
 * §Scale presets): `close` is tabletop companion; `continental`
 * shrinks Orbit to state-size beside a continent; `planetary`
 * shrinks Orbit to a speck beside a world. The visceral moment
 * lives in `planetary`.
 *
 * Numbers and Bezier math are lifted from the prototype. In a future
 * VR port, drop the camera moves (Quest handles framing) but keep
 * the Earth radii and positions.
 */

import * as THREE from 'three'
import type { ScaleKey } from './orbitTypes'

export interface ScalePreset {
  label: string
  tag: string
  earthRadius: number
  earthCenter: [number, number, number]
  cameraPos: [number, number, number]
  cameraTarget: [number, number, number]
  fov: number
  flightOut: number
  flightBack: number
  arcHeight: number
}

export const SCALE_PRESETS: Record<ScaleKey, ScalePreset> = {
  close: {
    label: 'Close',
    tag: 'a tabletop planet beside a companion',
    earthRadius: 0.22,
    earthCenter: [0.38, -0.01, -0.60],
    cameraPos: [0, 0.02, 0.45],
    cameraTarget: [0.14, -0.02, -0.28],
    fov: 38,
    flightOut: 4.2, flightBack: 3.4, arcHeight: 0.09,
  },
  continental: {
    label: 'Continental',
    tag: 'Orbit shrinks to a state beside a continent',
    earthRadius: 1.1,
    earthCenter: [1.9, -0.08, -3.0],
    cameraPos: [0, 0.03, 1.2],
    cameraTarget: [0.9, -0.05, -1.7],
    fov: 42,
    flightOut: 6.5, flightBack: 5.0, arcHeight: 0.55,
  },
  planetary: {
    label: 'Planetary',
    tag: 'Orbit shrinks to a speck beside a world',
    earthRadius: 4.0,
    earthCenter: [5.0, -0.30, -10.0],
    cameraPos: [0, 0.04, 2.5],
    cameraTarget: [2.3, -0.15, -4.8],
    fov: 45,
    flightOut: 10.5, flightBack: 7.8, arcHeight: 1.6,
  },
}

export const PRESET_KEYS: ScaleKey[] = ['close', 'continental', 'planetary']

// Orbit's chat rest position (at user's arm length) — same across presets.
export const CHAT_POS = new THREE.Vector3(0, 0, 0)
// Chat-distance feature, indicable when Orbit is at chat distance.
export const CHAT_FEATURE = new THREE.Vector3(0.32, -0.03, 0.02)

// Parking + feature directions from Earth center. Fixed relative to
// Earth so the hit-point lands in the same relative spot at every
// scale preset.
const PARKING_DIR = new THREE.Vector3(-0.55, -0.18, 0.82).normalize()
const FEATURE_DIR = new THREE.Vector3(-0.12, 0.10, 0.99).normalize()

export function parkingOf(p: ScalePreset, out = new THREE.Vector3()): THREE.Vector3 {
  const off = Math.max(0.09, 0.02 * p.earthRadius)
  out.set(p.earthCenter[0], p.earthCenter[1], p.earthCenter[2])
  return out.add(PARKING_DIR.clone().multiplyScalar(p.earthRadius + off))
}

export function featureOf(p: ScalePreset, out = new THREE.Vector3()): THREE.Vector3 {
  const off = Math.max(0.005, 0.003 * p.earthRadius)
  out.set(p.earthCenter[0], p.earthCenter[1], p.earthCenter[2])
  return out.add(FEATURE_DIR.clone().multiplyScalar(p.earthRadius + off))
}

// ── Flight state + Bezier ────────────────────────────────────────────

export type FlightMode = 'rest' | 'out' | 'atEarth' | 'back'

export interface FlightState {
  mode: FlightMode
  startPos: THREE.Vector3
  endPos: THREE.Vector3
  startTime: number
  duration: number
  arcHeight: number
}

export function createFlightState(): FlightState {
  return {
    mode: 'rest',
    startPos: new THREE.Vector3(),
    endPos: new THREE.Vector3(),
    startTime: 0,
    duration: 0,
    arcHeight: 0,
  }
}

/** Cubic Bezier with computed control points (arc upward, arrive tangentially). */
function cubicBezier(
  p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3,
  t: number, out: THREE.Vector3,
): THREE.Vector3 {
  const u = 1 - t
  const u2 = u * u, u3 = u2 * u, t2 = t * t, t3 = t2 * t
  out.x = u3 * p0.x + 3 * u2 * t * p1.x + 3 * u * t2 * p2.x + t3 * p3.x
  out.y = u3 * p0.y + 3 * u2 * t * p1.y + 3 * u * t2 * p2.y + t3 * p3.y
  out.z = u3 * p0.z + 3 * u2 * t * p1.z + 3 * u * t2 * p2.z + t3 * p3.z
  return out
}

const _tmpMid = new THREE.Vector3()
const _tmpP1 = new THREE.Vector3()
const _tmpP2 = new THREE.Vector3()

/**
 * Per-frame flight update. Writes into `restPos` (Orbit's target head
 * position absent body sway). Returns the updated mode so the caller
 * can detect arrival transitions.
 */
export function updateFlight(
  flight: FlightState,
  preset: ScalePreset,
  time: number,
  restPos: THREE.Vector3,
): FlightMode {
  if (flight.mode === 'out' || flight.mode === 'back') {
    const elapsed = time - flight.startTime
    const rawT = Math.min(1, Math.max(0, elapsed / flight.duration))
    const tE = rawT * rawT * (3 - 2 * rawT) // smooth-in/out

    _tmpMid.copy(flight.startPos).lerp(flight.endPos, 0.5)
    _tmpMid.y += flight.arcHeight
    _tmpP1.copy(flight.startPos).lerp(_tmpMid, 0.55)
    _tmpP2.copy(flight.endPos).lerp(_tmpMid, 0.55)
    cubicBezier(flight.startPos, _tmpP1, _tmpP2, flight.endPos, tE, restPos)

    if (rawT >= 1) {
      restPos.copy(flight.endPos)
      flight.mode = flight.mode === 'out' ? 'atEarth' : 'rest'
    }
  } else if (flight.mode === 'atEarth') {
    parkingOf(preset, restPos)
  } else {
    restPos.copy(CHAT_POS)
  }
  return flight.mode
}

/** Begin an outbound flight from Orbit's current rest position to the preset parking spot. */
export function startFlyToEarth(
  flight: FlightState,
  preset: ScalePreset,
  time: number,
): boolean {
  if (flight.mode === 'out' || flight.mode === 'back') return false
  flight.startPos.copy(CHAT_POS)
  parkingOf(preset, flight.endPos)
  flight.duration = preset.flightOut
  flight.arcHeight = preset.arcHeight
  flight.startTime = time
  flight.mode = 'out'
  return true
}

export function startFlyHome(
  flight: FlightState,
  preset: ScalePreset,
  time: number,
): boolean {
  if (flight.mode === 'out' || flight.mode === 'back') return false
  parkingOf(preset, flight.startPos)
  flight.endPos.copy(CHAT_POS)
  flight.duration = preset.flightBack
  flight.arcHeight = preset.arcHeight
  flight.startTime = time
  flight.mode = 'back'
  return true
}

/** Snap-reset flight — used when preset changes mid-flight or mid-atEarth. */
export function resetFlight(flight: FlightState): void {
  flight.mode = 'rest'
}
