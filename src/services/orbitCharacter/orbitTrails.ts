/**
 * Sub-sphere trails — distance-based sparkle wakes.
 *
 * Every per-vertex alpha in the trail shader is driven by the
 * vertex's `travelDistance` — the cumulative distance the sub has
 * moved since that position was written — rather than its age in
 * the rolling buffer. Three things fall out of that naturally:
 *
 *   1. **Speed adaptation.** Fast sub → travelDistance grows
 *      quickly → only the first few vertices remain in the visible
 *      fade range. Slow sub → distance grows slowly → many more
 *      vertices stay inside the fade range. Visible trail LENGTH
 *      (in world space) stays bounded by `uFadeEnd` regardless of
 *      sub speed, so EXCITED doesn't paint a "star field."
 *
 *   2. **Clean state transitions.** On state change we invalidate
 *      every existing vertex's travelDistance by setting it beyond
 *      `uFadeEnd` — those vertices instantly become invisible. The
 *      buffer continues to roll normally, filling in fresh positions
 *      from the new state. Combined with a 200 ms intensity
 *      fade-in on state change, transitions read as a brief dim
 *      then a fresh trail, not a lingering star field.
 *
 *   3. **Solid head + quick taper.** The alpha curve is a two-zone
 *      function of travelDistance:
 *        - `0 <= d < uHeadDistance`: alpha = 1 (solid bright head)
 *        - `uHeadDistance <= d < uFadeEnd`: alpha = (1 - t)^2.5
 *        - `d >= uFadeEnd`: alpha = 0 (discarded)
 *      Reads as a bright near-solid band at the sub's location
 *      fading to invisibility after the configured distance.
 *
 * Color + intensity remain decision-table driven:
 *   - `trailColorFor(state, palette)` — idle/quiet states use warm
 *     off-white; expressive states use the active palette accent.
 *     New states default to the idle bucket.
 *   - Intensity reads `expressionFor(state).trailIntensity`.
 *   - Per-state fade distance reads
 *     `expressionFor(state).trailFadeDistance` so quiet states can
 *     wrap into closed sparkle rings (long fade ≈ orbit
 *     circumference) while fast states stay compact.
 *
 * Design doc hazard: `THREE.Line` / `Line2` render at 1 pixel width
 * on mobile GPUs. Trails stay on `THREE.Points` with a custom
 * point-sprite shader.
 *
 * See `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md` §4.
 */

import * as THREE from 'three'
import { PALETTES, type PaletteKey } from './orbitTypes'
import { expressionFor, STATES } from './orbitStates'
import { GESTURES } from './orbitGestures'
import type { StateKey, GestureKind } from './orbitTypes'

/**
 * Rolling buffer size. With distance-based alpha the effective
 * visible length is set by `uFadeEnd`, not by buffer size — buffer
 * just needs to be long enough to sample the full orbit path at
 * the slowest write cadence. IDLE orbits at ~0.5 rad/s covers the
 * full orbit in ~12.5 s at 60 Hz = 750 frames; writing every 2
 * frames gives 375 writes per orbit. A 160-vertex buffer covers
 * ~40 % of the slowest orbit, which combined with `uFadeEnd=0.65`
 * is enough for the trail to wrap into a near-complete sparkle
 * ring during idle.
 */
export const TRAIL_LENGTH = 160

/**
 * Trail write cadence. Lower rate = each buffer slot covers more
 * motion distance. With distance-based alpha this mostly affects
 * how smooth the head zone reads (denser writes = smoother).
 */
const TRAIL_WRITE_EVERY_N_FRAMES = 2

/**
 * Solid-bright head zone, in world-space distance behind the sub.
 * Shared across states — tuning it per-state didn't add readability
 * in testing. ~1.2 cm reads as "the trail tightly couples to the
 * sub" without overwhelming the tail.
 */
const TRAIL_HEAD_DISTANCE = 0.012

/**
 * Duration (seconds) of the intensity fade-in after a state
 * change. Short enough that fast state sequences don't feel laggy;
 * long enough that the transition reads as intentional rather than
 * a glitch.
 */
const STATE_CHANGE_FADE_DURATION = 0.2

/**
 * Seed-value multiplier used to push invalidated vertices beyond
 * the visible fade range. Large enough that for any plausible
 * `uFadeEnd` the invalidated vertex's alpha is 0 and the fragment
 * is discarded; cheap to compare against.
 */
const TRAIL_INVALID_DISTANCE = 1e4

/** Warm off-white used for idle / low-excitement trails. */
const IDLE_TRAIL_COLOR = '#fff0d8'

/**
 * States where the trail should use the palette's ACCENT color
 * (expressive register). Everything else falls into the idle bucket
 * and uses the warm off-white. Adding a new state without listing
 * it here defaults to idle — one less thing to remember.
 */
const EXPRESSIVE_TRAIL_STATES = new Set<StateKey>([
  'TALKING', 'POINTING', 'PRESENTING',
  'EXCITED', 'HAPPY', 'CURIOUS', 'SURPRISED', 'CONFUSED',
])

/**
 * Resolve the trail color for the current frame. Precedence, highest
 * to lowest:
 *
 *   1. **Active gesture's `trailColor`** (if any) — Affirm's gold,
 *      Shrug's amber, etc. Overrides everything else for the
 *      gesture's duration.
 *   2. **State's `pupilColor`** (if set) — SOLEMN's reverent blue,
 *      CONFUSED's questioning amber. Ties the trail visually to the
 *      character's emotional register so the color signal runs
 *      across pupil AND wake.
 *   3. **Expressive-state palette accent** — the existing behavior
 *      for states like TALKING, POINTING, EXCITED, etc.
 *   4. **Warm off-white idle default** — for quiet states and any
 *      future state not listed in `EXPRESSIVE_TRAIL_STATES`.
 */
export function trailColorFor(
  state: StateKey,
  palette: PaletteKey,
  activeGestureKind: GestureKind | null = null,
): string {
  if (activeGestureKind) {
    const g = GESTURES[activeGestureKind]
    if (g.trailColor) return g.trailColor
  }
  const s = STATES[state]
  if (s.pupilColor) return s.pupilColor
  return EXPRESSIVE_TRAIL_STATES.has(state)
    ? PALETTES[palette].accent
    : IDLE_TRAIL_COLOR
}

export interface TrailHandle {
  points: THREE.Points
  geom: THREE.BufferGeometry
  mat: THREE.ShaderMaterial
  positions: Float32Array
  travelDistances: Float32Array
  prevSubPos: THREE.Vector3
  currentIntensity: number
  currentFadeEnd: number
  writeCounter: number
  lastState: StateKey
  /**
   * Last frame's active gesture (null when no gesture is playing).
   * Trail invalidates on both gesture-start (null → kind) and
   * gesture-end (kind → null) so the sub's pre- and post-gesture
   * orbit doesn't mix with the gesture's own motion in the trail
   * buffer — Wave especially produces a muddied sweep when idle
   * orbit particles are still visible behind the gesture.
   */
  lastGestureKind: GestureKind | null
  stateChangeTime: number
}

export function buildTrails(
  // Widened from THREE.Scene to Object3D so the embedded `OrbitAvatarNode`
  // can pass the avatar's container Group. The function only calls
  // `scene.add(points)` below, which is an Object3D method, so the
  // wider type is functionally equivalent for the standalone caller.
  scene: THREE.Object3D,
  subSpheres: THREE.Mesh[],
  palette: PaletteKey,
  pixelRatio: number,
): TrailHandle[] {
  return subSpheres.map((sub) => {
    const positions = new Float32Array(TRAIL_LENGTH * 3)
    const sizes = new Float32Array(TRAIL_LENGTH)
    const travelDistances = new Float32Array(TRAIL_LENGTH)
    const seeds = new Float32Array(TRAIL_LENGTH)
    for (let j = 0; j < TRAIL_LENGTH; j++) {
      positions[j * 3] = sub.position.x
      positions[j * 3 + 1] = sub.position.y
      positions[j * 3 + 2] = sub.position.z
      // Start every vertex beyond the visible range so the trail
      // grows in from empty as the sub moves — no "bright stripe"
      // pop on first frame.
      travelDistances[j] = TRAIL_INVALID_DISTANCE
      // Slight per-vertex size jitter reinforces the "sparkle" read —
      // uniform-size particles look like a dashed line instead.
      sizes[j] = 6 + 8 * (0.75 + Math.random() * 0.5)
      seeds[j] = Math.random()
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1))
    geom.setAttribute('travelDistance', new THREE.BufferAttribute(travelDistances, 1))
    geom.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(IDLE_TRAIL_COLOR) },
        uIntensity: { value: 0 },
        uPixelRatio: { value: pixelRatio },
        uTime: { value: 0 },
        uHeadDistance: { value: TRAIL_HEAD_DISTANCE },
        uFadeEnd: { value: 0.45 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float size;
        attribute float travelDistance;
        attribute float seed;
        uniform float uPixelRatio;
        uniform float uHeadDistance;
        varying float vTravelDistance;
        varying float vSeed;
        void main() {
          vTravelDistance = travelDistance;
          vSeed = seed;
          // Head-zone size boost — particles within uHeadDistance of
          // the sub render larger, so adjacent additive sprites
          // overlap into a continuous bright line close to the
          // satellite. Beyond the head zone, size returns to baseline
          // and the trail reads as discrete sparkles.
          float headT = clamp(travelDistance / max(0.0001, uHeadDistance), 0.0, 1.0);
          float sizeMul = mix(2.2, 1.0, headT);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatio * (0.35 / max(0.001, -mv.z)) * sizeMul;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uTime;
        uniform float uHeadDistance;
        uniform float uFadeEnd;
        varying float vTravelDistance;
        varying float vSeed;
        void main() {
          // Distance-based alpha: solid head, quadratic taper, discard
          // beyond the visible fade range.
          if (vTravelDistance >= uFadeEnd) discard;
          float trailAlpha;
          if (vTravelDistance < uHeadDistance) {
            trailAlpha = 1.0;
          } else {
            float t = (vTravelDistance - uHeadDistance) / max(0.0001, uFadeEnd - uHeadDistance);
            trailAlpha = pow(1.0 - t, 2.5);
          }

          // Per-particle circular falloff — keeps each sprite reading
          // as a bright pointlet rather than a square sprite.
          vec2 c = gl_PointCoord - vec2(0.5);
          float d = length(c);
          if (d > 0.5) discard;
          float particleFade = 1.0 - smoothstep(0.0, 0.5, d);
          particleFade = pow(particleFade, 2.2);

          // Per-vertex twinkle — each particle pulses on its own
          // phase, so the trail doesn't strobe in unison.
          float twinkle = 0.6 + 0.4 * sin(uTime * 6.0 + vSeed * 6.2831);

          float a = trailAlpha * uIntensity * particleFade * twinkle;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
    })
    const points = new THREE.Points(geom, mat)
    scene.add(points)
    return {
      points, geom, mat,
      positions, travelDistances,
      prevSubPos: sub.position.clone(),
      currentIntensity: 0,
      currentFadeEnd: 0.45,
      writeCounter: 0,
      // Any real state will trigger the change-detect branch on the
      // first update; '__init' sentinel avoids accidentally matching
      // an actual state key.
      lastState: '__init' as unknown as StateKey,
      lastGestureKind: null,
      stateChangeTime: -STATE_CHANGE_FADE_DURATION * 2,
    }
  })
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const smoothstep01 = (x: number): number => {
  const c = Math.max(0, Math.min(1, x))
  return c * c * (3 - 2 * c)
}

/**
 * Per-frame trail update.
 *
 * On state change (detected by comparing `state` to `trail.lastState`)
 * we:
 *   - invalidate all existing travel distances (push them beyond
 *     `uFadeEnd` so those vertices render at alpha 0)
 *   - reset `prevSubPos` so the first frame's frame-movement doesn't
 *     accidentally pick up any discontinuity between states
 *   - record `stateChangeTime` so the intensity multiplier ramps in
 *     smoothly over `STATE_CHANGE_FADE_DURATION`
 *
 * Every frame, we add the sub's frame-movement distance to every
 * vertex's travel distance. New positions at head (index 0) get
 * `travelDistance = 0`. The shader reads travelDistance each frame
 * from the vertex attribute and computes alpha.
 *
 * Sub 0 owns the directional trail during point/trace (sub 1's trail
 * is suppressed so the lead sub's motion reads cleanly).
 * `flightBoost` lifts trail intensity during Orbit's fly-to-Earth
 * arc so the journey leaves a visible streak.
 */
export function updateTrails(
  trails: TrailHandle[],
  subSpheres: THREE.Mesh[],
  state: StateKey,
  activeGestureKind: GestureKind | null,
  palette: PaletteKey,
  time: number,
  flightBoost = 0,
): void {
  const s = STATES[state]
  const expr = expressionFor(state)
  const trailColor = trailColorFor(state, palette, activeGestureKind)
  trails.forEach((trail, i) => {
    const sub = subSpheres[i]

    // Invalidate on state change OR gesture start/end. Gestures
    // hijack sub positions for a short duration; without this
    // invalidation, the sub's pre-gesture orbit trail mixes with
    // the gesture's own path (Wave is the worst offender — the
    // right sub sweeps through the residual orbit particles).
    const stateChanged = state !== trail.lastState
    const gestureChanged = activeGestureKind !== trail.lastGestureKind
    if (stateChanged || gestureChanged) {
      for (let j = 0; j < TRAIL_LENGTH; j++) {
        trail.travelDistances[j] = TRAIL_INVALID_DISTANCE
      }
      trail.geom.attributes.travelDistance.needsUpdate = true
      trail.prevSubPos.copy(sub.position)
      trail.stateChangeTime = time
      trail.lastState = state
      trail.lastGestureKind = activeGestureKind
    }

    trail.mat.uniforms.uColor.value.set(trailColor)
    trail.mat.uniforms.uTime.value = time
    // Ease uFadeEnd toward the state's target so state transitions
    // don't visibly snap the trail length.
    trail.currentFadeEnd = lerp(trail.currentFadeEnd, expr.trailFadeDistance, 0.10)
    trail.mat.uniforms.uFadeEnd.value = trail.currentFadeEnd

    // State-change intensity fade-in — smoothstep from 0 at the
    // change instant up to 1 over STATE_CHANGE_FADE_DURATION.
    const elapsed = time - trail.stateChangeTime
    const stateFade = smoothstep01(elapsed / STATE_CHANGE_FADE_DURATION)

    let targetIntensity = Math.max(flightBoost, expr.trailIntensity)
    if ((s.subMode === 'point' || s.subMode === 'trace') && i !== 0) {
      targetIntensity = 0
    }
    targetIntensity *= stateFade

    trail.currentIntensity = lerp(trail.currentIntensity, targetIntensity, 0.15)
    trail.mat.uniforms.uIntensity.value = trail.currentIntensity

    // Downsample writes — shift the rolling buffer and write a new
    // head point every Nth frame. We still accumulate travel
    // distance every frame (below) so the head zone and fade edge
    // advance smoothly regardless of write cadence.
    trail.writeCounter += 1
    const shouldWrite = trail.writeCounter >= TRAIL_WRITE_EVERY_N_FRAMES
    if (shouldWrite) trail.writeCounter = 0

    // Frame movement — used to advance every existing vertex's
    // travel distance. Computed every frame (not gated on
    // shouldWrite) so the shader sees smooth distance growth.
    const dx = sub.position.x - trail.prevSubPos.x
    const dy = sub.position.y - trail.prevSubPos.y
    const dz = sub.position.z - trail.prevSubPos.z
    const frameMovement = Math.sqrt(dx * dx + dy * dy + dz * dz)
    trail.prevSubPos.copy(sub.position)

    const td = trail.travelDistances
    if (shouldWrite) {
      // Roll buffer: shift positions, shift travelDistances, write
      // new head at index 0.
      const pos = trail.positions
      for (let j = TRAIL_LENGTH - 1; j > 0; j--) {
        pos[j * 3] = pos[(j - 1) * 3]
        pos[j * 3 + 1] = pos[(j - 1) * 3 + 1]
        pos[j * 3 + 2] = pos[(j - 1) * 3 + 2]
        td[j] = td[j - 1] + frameMovement
      }
      pos[0] = sub.position.x
      pos[1] = sub.position.y
      pos[2] = sub.position.z
      td[0] = 0
      trail.geom.attributes.position.needsUpdate = true
    } else {
      // Non-write frame: advance every existing vertex's travel
      // distance by the frame's movement so the shader's fade edge
      // continues to march in between buffer rolls.
      for (let j = 0; j < TRAIL_LENGTH; j++) td[j] += frameMovement
    }
    trail.geom.attributes.travelDistance.needsUpdate = true
  })
}

export function setTrailPixelRatio(trails: TrailHandle[], pixelRatio: number): void {
  for (const t of trails) t.mat.uniforms.uPixelRatio.value = pixelRatio
}
