/**
 * Sub-sphere trails — sparkling "comet" streams.
 *
 * Design doc hazard: `THREE.Line` / `Line2` render at 1 pixel width
 * on mobile GPUs regardless of the requested `linewidth`. Trails
 * stay as `THREE.Points` with a custom point-sprite shader — circular
 * fade, distance-scaled size, additive blending. Per-vertex `size`
 * and `alpha` give the tail taper; per-vertex `seed` plus a `uTime`
 * uniform produce the twinkle that reads as "comet sparkle" in the
 * vinyl redesign (see `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md` §4).
 *
 * Color is decision-table driven: idle/low-excitement states fall
 * back to a warm off-white palette; expressive states use the
 * active palette's accent. A new state automatically lands in the
 * idle bucket — extensible without edits.
 */

import * as THREE from 'three'
import { PALETTES, type PaletteKey } from './orbitTypes'
import { STATES } from './orbitStates'
import type { StateKey } from './orbitTypes'

export const TRAIL_LENGTH = 42

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

export function trailColorFor(state: StateKey, palette: PaletteKey): string {
  return EXPRESSIVE_TRAIL_STATES.has(state)
    ? PALETTES[palette].accent
    : IDLE_TRAIL_COLOR
}

export interface TrailHandle {
  points: THREE.Points
  geom: THREE.BufferGeometry
  mat: THREE.ShaderMaterial
  positions: Float32Array
  currentIntensity: number
}

export function buildTrails(
  scene: THREE.Scene,
  subSpheres: THREE.Mesh[],
  palette: PaletteKey,
  pixelRatio: number,
): TrailHandle[] {
  return subSpheres.map((sub) => {
    const positions = new Float32Array(TRAIL_LENGTH * 3)
    const sizes = new Float32Array(TRAIL_LENGTH)
    const alphas = new Float32Array(TRAIL_LENGTH)
    const seeds = new Float32Array(TRAIL_LENGTH)
    for (let j = 0; j < TRAIL_LENGTH; j++) {
      positions[j * 3] = sub.position.x
      positions[j * 3 + 1] = sub.position.y
      positions[j * 3 + 2] = sub.position.z
      const t = 1 - j / TRAIL_LENGTH
      alphas[j] = t
      // Slight per-vertex size jitter reinforces the "sparkle" read —
      // uniform-size points look like a dashed line instead.
      sizes[j] = 3 + t * 18 * (0.75 + Math.random() * 0.5)
      seeds[j] = Math.random()
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1))
    geom.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1))
    geom.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(IDLE_TRAIL_COLOR) },
        uIntensity: { value: 0 },
        uPixelRatio: { value: pixelRatio },
        uTime: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float size; attribute float alpha; attribute float seed;
        uniform float uPixelRatio;
        varying float vAlpha;
        varying float vSeed;
        void main() {
          vAlpha = alpha;
          vSeed = seed;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatio * (0.35 / max(0.001, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uIntensity; uniform float uTime;
        varying float vAlpha; varying float vSeed;
        void main() {
          vec2 c = gl_PointCoord - vec2(0.5);
          float d = length(c);
          if (d > 0.5) discard;
          float fade = 1.0 - smoothstep(0.0, 0.5, d);
          // Sharper exponent reads as a spark core rather than a
          // soft smear.
          fade = pow(fade, 2.2);
          // Per-vertex twinkle — each particle pulses on its own
          // phase, so the trail doesn't strobe in unison.
          float twinkle = 0.6 + 0.4 * sin(uTime * 6.0 + vSeed * 6.2831);
          float a = vAlpha * uIntensity * fade * twinkle;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
    })
    const points = new THREE.Points(geom, mat)
    scene.add(points)
    return { points, geom, mat, positions, currentIntensity: 0 }
  })
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Per-frame trail update.
 *
 * Reads the active STATE's `trail` amount, eases each trail's
 * intensity toward it, and rolls each trail's positions forward by
 * one step (shift buffer, write current sub-sphere position at index 0).
 *
 * Sub 0 owns the directional trail during point/trace (sub 1's trail
 * is suppressed so the lead sub's motion reads cleanly). `flightBoost`
 * lifts trail intensity during Orbit's fly-to-Earth arc so the journey
 * leaves a visible streak.
 */
export function updateTrails(
  trails: TrailHandle[],
  subSpheres: THREE.Mesh[],
  state: StateKey,
  palette: PaletteKey,
  time: number,
  flightBoost = 0,
): void {
  const s = STATES[state]
  const trailColor = trailColorFor(state, palette)
  trails.forEach((trail, i) => {
    trail.mat.uniforms.uColor.value.set(trailColor)
    trail.mat.uniforms.uTime.value = time
    let targetIntensity = Math.max(flightBoost, s.trail)
    if ((s.subMode === 'point' || s.subMode === 'trace') && i !== 0) {
      targetIntensity = 0
    }
    trail.currentIntensity = lerp(trail.currentIntensity, targetIntensity, 0.10)
    trail.mat.uniforms.uIntensity.value = trail.currentIntensity

    const sub = subSpheres[i]
    const pos = trail.positions
    for (let j = TRAIL_LENGTH - 1; j > 0; j--) {
      pos[j * 3] = pos[(j - 1) * 3]
      pos[j * 3 + 1] = pos[(j - 1) * 3 + 1]
      pos[j * 3 + 2] = pos[(j - 1) * 3 + 2]
    }
    pos[0] = sub.position.x
    pos[1] = sub.position.y
    pos[2] = sub.position.z
    trail.geom.attributes.position.needsUpdate = true
  })
}

export function setTrailPixelRatio(trails: TrailHandle[], pixelRatio: number): void {
  for (const t of trails) t.mat.uniforms.uPixelRatio.value = pixelRatio
}
