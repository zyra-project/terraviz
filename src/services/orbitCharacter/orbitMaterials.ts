/**
 * Materials and shaders for the Orbit character.
 *
 * Vinyl-toy redesign: the body and sub-spheres use a matte
 * `MeshStandardMaterial` whose diffuse channel is overwritten with a
 * horizontal two-color gradient (warm → cool) via `onBeforeCompile`.
 * The eye-field lid shader is retained but now closes lids against
 * the body's warm anchor rather than a metallic fresnel rim, so the
 * eye reads as skin folding over opaque vinyl. See
 * `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md`.
 */

import * as THREE from 'three'
import { PALETTES, type PaletteKey } from './orbitTypes'

// -----------------------------------------------------------------------
// Vinyl body — MeshStandardMaterial with a horizontal warm→cool gradient
// injected via onBeforeCompile. Gradient spans object-space X, which
// matches the concept art's pink-left / blue-right read regardless of
// how the body's rotation sways each frame (since body.rotation is
// tiny and the gradient feels baked-in, not slipping).
// -----------------------------------------------------------------------

/**
 * Half-width in object space of the body along X. Anything outside
 * this range clamps to the gradient edge color. Matches the body
 * geometry's `IcosahedronGeometry(BODY_RADIUS=0.075)` plus a little
 * head-room so extreme silhouette pixels hit the clean anchor color.
 */
const BODY_GRADIENT_HALF_SPAN = 0.09

export interface BodyMaterialBundle {
  /**
   * The actual mesh material. A MeshStandardMaterial (not a
   * ShaderMaterial) so Three.js's standard lighting pipeline — key
   * light, shadows, tone mapping — works without reinventing each.
   */
  material: THREE.MeshStandardMaterial
  /**
   * Gradient uniforms that `updateCharacter` writes each frame from
   * the active palette. `uTime` is retained as a field (unused by
   * the fragment today) so callers that expected the legacy
   * interface still type-check.
   */
  uniforms: {
    uTime: { value: number }
    uWarm: { value: THREE.Color }
    uCool: { value: THREE.Color }
    uSpan: { value: number }
    /**
     * Back-compat handles. The legacy `uBaseColor` / `uAccentColor`
     * / `uGlowColor` uniforms were read by other subsystems; we
     * keep Color instances so `updateCharacter` can still
     * `.set(p.base)` etc. without branching. Nothing in the
     * gradient shader reads them.
     */
    uBaseColor: { value: THREE.Color }
    uAccentColor: { value: THREE.Color }
    uGlowColor: { value: THREE.Color }
  }
}

export function createBodyMaterial(palette: PaletteKey = 'cyan'): BodyMaterialBundle {
  const p = PALETTES[palette]
  const uniforms = {
    uTime: { value: 0 },
    uWarm: { value: new THREE.Color(p.warm) },
    uCool: { value: new THREE.Color(p.cool) },
    uSpan: { value: BODY_GRADIENT_HALF_SPAN },
    uBaseColor: { value: new THREE.Color(p.base) },
    uAccentColor: { value: new THREE.Color(p.accent) },
    uGlowColor: { value: new THREE.Color(p.glow) },
  }
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0.0,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWarm = uniforms.uWarm
    shader.uniforms.uCool = uniforms.uCool
    shader.uniforms.uSpan = uniforms.uSpan
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vOrbitObjPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vOrbitObjPos = position;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uWarm;
         uniform vec3 uCool;
         uniform float uSpan;
         varying vec3 vOrbitObjPos;`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `float orbitG = clamp(vOrbitObjPos.x / uSpan * 0.5 + 0.5, 0.0, 1.0);
         vec3 orbitGradient = mix(uWarm, uCool, orbitG);
         vec4 diffuseColor = vec4( orbitGradient, opacity );`,
      )
  }
  return { material, uniforms }
}

// -----------------------------------------------------------------------
// Eye field — flat disc with shader-driven upper/lower lid coverage.
// Lids render in the body's WARM anchor color so the eye reads as
// "skin folding over opaque vinyl" with no visible seam against the
// new gradient body. See ORBIT_CHARACTER_VINYL_REDESIGN.md "Face".
// -----------------------------------------------------------------------

export interface EyeFieldMaterialBundle {
  material: THREE.ShaderMaterial
  uniforms: {
    uUpperLid: { value: number }
    uLowerLid: { value: number }
    uBodyColor: { value: THREE.Color }
    uBodyAccent: { value: THREE.Color }
    uEyeColor: { value: THREE.Color }
    uRimColor: { value: THREE.Color }
  }
}

export function createEyeFieldMaterial(palette: PaletteKey = 'cyan'): EyeFieldMaterialBundle {
  const p = PALETTES[palette]
  const uniforms = {
    uUpperLid: { value: 0 },
    uLowerLid: { value: 0 },
    // `uBodyColor` now gets written with the palette's WARM anchor
    // (the left side of the gradient), which is the hue that sits
    // directly above/below the eye disc. Lids close to that color so
    // the lid+body seam is invisible.
    uBodyColor: { value: new THREE.Color(p.warm) },
    uBodyAccent: { value: new THREE.Color(p.accent) },
    // Warm dark charcoal instead of near-black — reads as socket
    // shadow, not void. See design doc §Face "Warmer sockets".
    uEyeColor: { value: new THREE.Color(0x1f1a24) },
    uRimColor: { value: new THREE.Color(0x2a2230) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uUpperLid; uniform float uLowerLid;
      uniform vec3 uBodyColor; uniform vec3 uBodyAccent;
      uniform vec3 uEyeColor; uniform vec3 uRimColor;
      void main() {
        vec2 c = vUv - vec2(0.5);
        float dist = length(c);
        float eyeMask = 1.0 - smoothstep(0.48, 0.50, dist);
        if (eyeMask < 0.01) discard;
        float rimFactor = smoothstep(0.36, 0.48, dist);
        float y = c.y + 0.5;
        float upperCov = smoothstep(1.0 - uUpperLid - 0.04, 1.0 - uUpperLid + 0.04, y);
        float lowerCov = 1.0 - smoothstep(uLowerLid - 0.04, uLowerLid + 0.04, y);
        float covered = max(upperCov, lowerCov);
        float crease = 1.0 - abs(y - (1.0 - uUpperLid)) * 6.0;
        crease = max(crease, 1.0 - abs(y - uLowerLid) * 6.0);
        crease = clamp(crease, 0.0, 1.0) * covered;
        vec3 lidColor = mix(uBodyColor, uBodyAccent, crease * 0.2);
        vec3 baseColor = mix(uEyeColor, uRimColor, rimFactor);
        vec3 color = mix(baseColor, lidColor, covered);
        gl_FragColor = vec4(color, eyeMask);
      }`,
  })
  return { material, uniforms }
}

// -----------------------------------------------------------------------
// Pupil + pupil glow — additive discs layered on the eye.
// Shared material between the left and right paired eyes.
// -----------------------------------------------------------------------

export interface PupilMaterials {
  pupilMat: THREE.MeshBasicMaterial
  glowMat: THREE.MeshBasicMaterial
}

export function createPupilMaterials(palette: PaletteKey = 'cyan'): PupilMaterials {
  const accent = new THREE.Color(PALETTES[palette].accent)
  return {
    pupilMat: new THREE.MeshBasicMaterial({
      color: accent.clone(),
      transparent: true,
    }),
    glowMat: new THREE.MeshBasicMaterial({
      color: accent.clone(),
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
    }),
  }
}

// -----------------------------------------------------------------------
// Catchlight — static additive-white disc that sits on each eye and
// stays fixed relative to the eye group as the pupil moves. Two
// highlights per eye (primary upper-right, secondary lower-left) sell
// the "wet, alive" read that rigid pupils alone can't.
// -----------------------------------------------------------------------

export function createCatchlightMaterial(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
}

/**
 * Vinyl sub-sphere material — same gradient pipeline as the body,
 * same matte roughness. Returning the bundle (not just the material)
 * lets `updateCharacter` palette-propagate without branching.
 */
export function createSubSphereMaterial(palette: PaletteKey = 'cyan'): BodyMaterialBundle {
  // Subs share the body's gradient recipe; `createBodyMaterial`
  // already parameterizes the whole thing on palette anchors. The
  // returned bundle structure is identical, so per-frame palette
  // writes iterate body + subs with the same code path.
  return createBodyMaterial(palette)
}

// Earth material lived here as a procedural continent shader while
// the photoreal stack was being built. It's now in
// `src/services/photorealEarth.ts` — the Orbit scene consumes that
// factory directly. No local Earth material exports remain.
