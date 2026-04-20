/**
 * GESTURES — transient overlays that play OVER the active state, then
 * yield control back. One at a time; new triggers while one is playing
 * are ignored (see OrbitController.playGesture).
 *
 * Each gesture's `compute(t, ctx)` takes a normalized `t ∈ [0, 1]` and
 * returns a `GestureFrame` that overrides sub-sphere positions and,
 * optionally, head rotation and pupil color. Design convention: at
 * t=0 and t=1 the gesture returns roughly-neutral positions so entry
 * and exit don't snap. Peak shape lives in the middle.
 *
 * Head-ownership rule (enforced in `updateCharacter`): if the gesture
 * specifies `head`, it owns head rotation entirely for its duration;
 * state-driven head motion (Yes/No/tilt) eases to zero so when the
 * gesture ends, state head resumes from rest rather than snapping
 * mid-motion.
 *
 * The four compute functions below are the output of nine prototype
 * iterations — retuning any of them should come with a design-doc
 * update first.
 */

import * as THREE from 'three'

export type GestureKind = 'shrug' | 'wave' | 'beckon' | 'affirm'

export interface GestureContext {
  direction: THREE.Vector3 // unit vector from head to active target
  featureIsAtEarth: boolean
}

export interface GestureFrame {
  subSpheres: Array<{ x: number; y: number; z: number }> // head-relative
  head?: { pitch?: number; yaw?: number; roll?: number }
  pupilColor?: string
  pupilFlash?: number // 0..1 — envelope for the flash
}

export interface Gesture {
  label: string
  duration: number // seconds
  compute: (t: number, ctx: GestureContext) => GestureFrame
}

const smoothstep01 = (x: number): number => {
  const c = Math.max(0, Math.min(1, x))
  return c * c * (3 - 2 * c)
}

export const GESTURES: Record<GestureKind, Gesture> = {
  shrug: {
    label: 'Shrug',
    duration: 1.4,
    compute: (t, _ctx) => {
      // "I don't know" — both sub-spheres rise and spread wide, head tilts
      // back slightly, subtle side-to-side sway during the held phase.
      const r = 0.14
      let spread: number, lift: number
      if (t < 0.25) {
        const e = smoothstep01(t / 0.25)
        spread = r * (1.0 + 0.7 * e); lift = 0.07 * e
      } else if (t < 0.75) {
        spread = r * 1.7; lift = 0.07
      } else {
        const e = smoothstep01((1.0 - t) / 0.25)
        spread = r * (1.0 + 0.7 * e); lift = 0.07 * e
      }
      const peak = Math.sin(smoothstep01((t - 0.05) / 0.9) * Math.PI)
      const headPitch = -0.14 * peak
      const headYaw = Math.sin(t * Math.PI * 1.8) * 0.08 * peak
      return {
        subSpheres: [
          { x:  spread, y: lift, z: 0 },
          { x: -spread, y: lift, z: 0 },
        ],
        head: { pitch: headPitch, yaw: headYaw },
      }
    },
  },
  wave: {
    label: 'Wave',
    duration: 1.8,
    compute: (t, _ctx) => {
      // One sub-sphere swings side-to-side (waving hand); other tucks close.
      const r = 0.14
      const peak = Math.sin(smoothstep01((t - 0.05) / 0.9) * Math.PI)
      const swing = Math.sin(t * Math.PI * 4) // two full cycles
      const waveY = r * 0.55 + 0.02 * peak
      const waveX = r * 0.7 + swing * 0.08 * peak
      return {
        subSpheres: [
          { x:  waveX, y: waveY, z: 0.02 * peak },
          { x: -r * 0.5, y: -r * 0.2, z: -0.01 },
        ],
      }
    },
  },
  beckon: {
    label: 'Beckon',
    duration: 1.6,
    // Directional: extending sub reaches toward `ctx.direction`
    // (CHAT_FEATURE at chat, Earth feature at Earth). Head turns
    // slightly toward the target. Pairs with Pointing/Presenting:
    // Point shows WHERE; Beckon says "come toward THERE."
    compute: (t, ctx) => {
      const r = 0.14
      const peak = Math.sin(smoothstep01((t - 0.05) / 0.9) * Math.PI)
      const cycle = Math.sin(t * Math.PI * 2)
      const dir = ctx.direction
      const extBase = 0.09
      const extPulse = (0.5 + 0.5 * cycle) * 0.10
      const extDist = (extBase + extPulse) * peak
      const refDist = r * 0.55
      return {
        subSpheres: [
          { x: -dir.x * refDist, y: -dir.y * refDist + 0.01, z: -dir.z * refDist },
          { x:  dir.x * extDist, y:  dir.y * extDist + 0.02 * peak, z:  dir.z * extDist },
        ],
        head: {
          pitch: -dir.y * 0.10 * peak,
          yaw: Math.atan2(dir.x, -dir.z) * 0.22 * peak,
        },
      }
    },
  },
  affirm: {
    label: 'Affirm',
    duration: 0.9,
    compute: (t, _ctx) => {
      // Quiet "mm-hm" — a single small nod + gold pupil flash. Smaller
      // motion than YES state; meant as transient acknowledgment
      // during Listening/Chatting, not a committed yes.
      const r = 0.14
      const nod = Math.sin(t * Math.PI) * 0.14
      const flash =
        t < 0.35 ? smoothstep01(t / 0.35)
        : t < 0.65 ? 1.0
        : smoothstep01((1.0 - t) / 0.35)
      return {
        subSpheres: [
          { x:  r * 0.92, y: -nod * 0.05, z: 0 },
          { x: -r * 0.92, y: -nod * 0.05, z: 0 },
        ],
        head: { pitch: nod },
        pupilColor: '#efc85c',
        pupilFlash: flash,
      }
    },
  },
}

export const GESTURE_KEYS: GestureKind[] = ['shrug', 'wave', 'beckon', 'affirm']
