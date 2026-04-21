/**
 * Sub-sphere trails — emissive point-sprite streams.
 *
 * The design doc calls out the mobile-line-width gotcha: `THREE.Line` /
 * `Line2` render at 1 pixel width on mobile GPUs regardless of the
 * requested `linewidth`. Trails instead use `THREE.Points` with a
 * custom point-sprite shader — circular fade, distance-scaled size,
 * additive blending. Per-vertex `size` and `alpha` attributes give the
 * tail-taper shape.
 *
 * Shader + geometry are lifted verbatim from the prototype.
 * See ORBIT_CHARACTER_DESIGN.md §Trails.
 */

import * as THREE from 'three'
import { PALETTES, type PaletteKey } from './orbitTypes'
import { STATES } from './orbitStates'
import type { StateKey } from './orbitTypes'

export const TRAIL_LENGTH = 42

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
    for (let j = 0; j < TRAIL_LENGTH; j++) {
      positions[j * 3] = sub.position.x
      positions[j * 3 + 1] = sub.position.y
      positions[j * 3 + 2] = sub.position.z
      const t = 1 - j / TRAIL_LENGTH
      alphas[j] = t
      sizes[j] = 4 + t * 16
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1))
    geom.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1))
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(PALETTES[palette].accent) },
        uIntensity: { value: 0 },
        uPixelRatio: { value: pixelRatio },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float size; attribute float alpha;
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatio * (0.35 / max(0.001, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uIntensity;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - vec2(0.5);
          float d = length(c);
          if (d > 0.5) discard;
          float fade = 1.0 - smoothstep(0.0, 0.5, d);
          fade = pow(fade, 1.5);
          float a = vAlpha * uIntensity * fade;
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
 * is a hook the flight-system phase will drive; zero for now.
 */
export function updateTrails(
  trails: TrailHandle[],
  subSpheres: THREE.Mesh[],
  state: StateKey,
  palette: PaletteKey,
  flightBoost = 0,
): void {
  const s = STATES[state]
  const paletteColor = PALETTES[palette].accent
  trails.forEach((trail, i) => {
    trail.mat.uniforms.uColor.value.set(paletteColor)
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
