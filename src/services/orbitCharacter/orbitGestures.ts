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

export type GestureKind = 'shrug' | 'wave' | 'beckon' | 'affirm' | 'tickle'

export interface GestureContext {
  direction: THREE.Vector3 // unit vector from head to active target
  featureIsAtEarth: boolean
  /**
   * When true, the viewer has OS prefers-reduced-motion set. Gestures
   * that produce rapid repeating motion (Tickle's spiral, Excited
   * flutters) should dampen their amplitudes / frequencies when this
   * is active so the motion still reads as the gesture but doesn't
   * feel overwhelming.
   */
  reducedMotion: boolean
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
  /**
   * Optional solid tint for the sparkle trail during this gesture.
   * If set, overrides the state/palette color in `trailColorFor`
   * for the duration of the gesture. Used to reinforce gesture
   * semantics via color — e.g. Affirm's gold "mm-hm," Shrug's
   * amber "questioning" tone.
   *
   * Undefined means the trail stays on the current state color.
   */
  trailColor?: string
}

const smoothstep01 = (x: number): number => {
  const c = Math.max(0, Math.min(1, x))
  return c * c * (3 - 2 * c)
}

export const GESTURES: Record<GestureKind, Gesture> = {
  shrug: {
    label: 'Shrug',
    duration: 1.4,
    // Amber tint reads as "questioning / uncertain" — the
    // emotional register of Shrug.
    trailColor: '#d9a85c',
    compute: (t, _ctx) => {
      // "I don't know" — sub-spheres trace an ARM-like arc: they
      // sweep outward and upward along a curved path rather than
      // sliding in a straight line, then hold at peak, then sweep
      // back. Head tilts back slightly with a subtle side-to-side
      // sway during the held phase.
      //
      // Path is a quadratic Bezier from rest → control → peak. The
      // control point sits OUTWARD and UPWARD of the midpoint so
      // the curve bows up, reading as a shoulder-to-elbow-to-wrist
      // swing rather than a linear translation.
      const r = 0.14
      // `swing` ∈ [0, 1]: 0 at rest, 1 at held peak, 0 at end.
      let swing: number
      if (t < 0.25) swing = smoothstep01(t / 0.25)
      else if (t < 0.75) swing = 1.0
      else swing = smoothstep01((1.0 - t) / 0.25)

      // Bezier endpoints (absolute values; mirrored on X for the
      // second sub). REST is close to the body on the right side;
      // PEAK is spread wide and lifted.
      const restX = r * 0.20
      const restY = -r * 0.10
      const peakX = r * 1.65
      const peakY = r * 0.45
      // Control point — pulled UP and slightly OUTWARD from the
      // midpoint so the curve bows over the top rather than running
      // in a straight line. This is what gives the motion its arm
      // swing character.
      const ctrlX = (restX + peakX) * 0.5 + r * 0.20
      const ctrlY = (restY + peakY) * 0.5 + r * 0.55
      // Quadratic Bezier B(s) = (1-s)^2·P0 + 2(1-s)·s·P1 + s^2·P2
      const s = swing
      const u = 1 - s
      const armX = u * u * restX + 2 * u * s * ctrlX + s * s * peakX
      const armY = u * u * restY + 2 * u * s * ctrlY + s * s * peakY
      // Small forward-bow on Z so the arms arc toward camera at
      // peak swing (max at swing=0.5). Gives the motion a third
      // dimension; reads as natural rather than flat.
      const armZ = 4 * swing * (1 - swing) * 0.025

      const peak = Math.sin(smoothstep01((t - 0.05) / 0.9) * Math.PI)
      const headPitch = -0.14 * peak
      const headYaw = Math.sin(t * Math.PI * 1.8) * 0.08 * peak
      return {
        subSpheres: [
          { x:  armX, y: armY, z: armZ },
          { x: -armX, y: armY, z: armZ },
        ],
        head: { pitch: headPitch, yaw: headYaw },
      }
    },
  },
  wave: {
    label: 'Wave',
    duration: 1.8,
    compute: (t, _ctx) => {
      // "Hi!" — sub 0 is the "hand": it rises along a Bezier arc
      // from rest to a wave-ready position, holds there while
      // swinging side-to-side (the actual wave), then returns
      // along the arc. Sub 1 stays tucked close to body throughout.
      const r = 0.14

      // Phase envelope — rise / hold / return with smooth endpoints.
      let rise: number
      if (t < 0.20) rise = smoothstep01(t / 0.20)
      else if (t < 0.80) rise = 1.0
      else rise = smoothstep01((1.0 - t) / 0.20)

      // Bezier arm path: REST (tucked) → CONTROL (up + slightly
      // wider) → PEAK (wave-ready, up and wide). Control biased
      // outward + upward from the midpoint gives the arc.
      const restX = r * 0.35, restY = -r * 0.15
      const peakX = r * 0.85, peakY = r * 0.55
      const ctrlX = (restX + peakX) * 0.5 + r * 0.15
      const ctrlY = (restY + peakY) * 0.5 + r * 0.35
      const s = rise, u = 1 - s
      const baseX = u * u * restX + 2 * u * s * ctrlX + s * s * peakX
      const baseY = u * u * restY + 2 * u * s * ctrlY + s * s * peakY

      // Hand swing — only during the hold plateau. Smooth gate so
      // the swing doesn't appear mid-rise. ~3 cycles over the
      // held 60 % of the gesture duration.
      const swingGate = smoothstep01((rise - 0.85) / 0.15)
      const swingX = Math.sin(t * Math.PI * 6) * swingGate * r * 0.22

      // Forward Z bow during the arc + a held forward lean during
      // the swing — reads as "hand extended toward viewer."
      const archZ = 4 * rise * (1 - rise) * 0.015 + swingGate * 0.02

      return {
        subSpheres: [
          { x: baseX + swingX, y: baseY, z: archZ },
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
    //
    // Arc/curl layered on the base extension pulse so the sub's
    // path reads as a "curl" rather than a linear extend-retract
    // — arm rises when extending, dips when pulling back,
    // approximating fingers curling inward toward the palm.
    compute: (t, ctx) => {
      const r = 0.14
      const peak = Math.sin(smoothstep01((t - 0.05) / 0.9) * Math.PI)
      const cycle = Math.sin(t * Math.PI * 2)
      const dir = ctx.direction
      const extBase = 0.09
      const extPulse = (0.5 + 0.5 * cycle) * 0.10
      const extDist = (extBase + extPulse) * peak
      // Arc/curl — Y rises on extend (cycle > 0), dips on pull-back
      // (cycle < 0). Syncs with the pulse so the motion reads as a
      // curl rather than a straight extend-retract.
      const curlY = cycle * 0.035 * peak
      const refDist = r * 0.55
      return {
        subSpheres: [
          { x: -dir.x * refDist, y: -dir.y * refDist + 0.01, z: -dir.z * refDist },
          {
            x: dir.x * extDist,
            y: dir.y * extDist + 0.02 * peak + curlY,
            z: dir.z * extDist,
          },
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
    // Gold tint matches the pupil flash — reinforces the positive
    // "mm-hm" acknowledgment across every visual channel.
    trailColor: '#efc85c',
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
  tickle: {
    label: 'Tickle',
    duration: 1.2,
    // Pink/warm tint reinforces the playful "tee-hee" register. Warm
    // without being saturated so it reads as blush rather than alert.
    trailColor: '#ff9ecb',
    compute: (t, ctx) => {
      // Poke response — Orbit giggles. Sub-spheres spiral rapidly
      // around the head, head wiggles side to side, pupils flash the
      // same pink as the trail to sell "flustered delight." Under
      // reduced motion the spiral frequency drops and the head
      // wiggle is halved so the visual is still present but calmer.
      const r = 0.14
      const peak = Math.sin(smoothstep01((t - 0.05) / 0.9) * Math.PI)

      // Spiral — two subs on opposite sides of the orbit, both
      // rotating. Frequency scales down under reduced motion.
      const rate = ctx.reducedMotion ? 4.0 : 8.0
      const phase0 = t * Math.PI * rate
      const phase1 = phase0 + Math.PI
      const radius = r * 0.65 * peak

      // Head wiggle — sinusoidal yaw at ~3 Hz. Halved under reduced
      // motion.
      const wiggleAmp = ctx.reducedMotion ? 0.05 : 0.11
      const headYaw = Math.sin(t * Math.PI * 6) * wiggleAmp * peak
      // Very slight backward pitch — the "shrinking away from the
      // poke" component.
      const headPitch = -0.06 * peak

      // Pupil color envelope — flash pink during the middle 70 % of
      // the gesture, fading in/out at the edges.
      const flash =
        t < 0.20 ? smoothstep01(t / 0.20)
        : t < 0.80 ? 1.0
        : smoothstep01((1.0 - t) / 0.20)

      return {
        subSpheres: [
          {
            x: Math.cos(phase0) * radius,
            y: Math.sin(phase0) * radius * 0.6,
            z: Math.sin(phase0 * 0.7) * radius * 0.4,
          },
          {
            x: Math.cos(phase1) * radius,
            y: Math.sin(phase1) * radius * 0.6,
            z: Math.sin(phase1 * 0.7) * radius * 0.4,
          },
        ],
        head: { pitch: headPitch, yaw: headYaw },
        pupilColor: '#ff9ecb',
        pupilFlash: flash,
      }
    },
  },
}

export const GESTURE_KEYS: GestureKind[] = ['shrug', 'wave', 'beckon', 'affirm', 'tickle']
