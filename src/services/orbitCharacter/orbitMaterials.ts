/**
 * Materials and shaders for the Orbit character.
 *
 * The iridescent body fresnel, eye-field lid-control shader, pupil
 * glow, and point-sprite trail GLSL below are the output of nine
 * prototype iterations. Retuning any of them should come with a
 * design-doc update first.
 */

import * as THREE from 'three'
import { PALETTES, type PaletteKey } from './orbitTypes'

// -----------------------------------------------------------------------
// Iridescent body — fresnel + palette-driven hue shift + glow halo.
// Runs inside the Quest shader budget (~30 lines of GLSL).
// -----------------------------------------------------------------------

export interface BodyMaterialBundle {
  material: THREE.ShaderMaterial
  uniforms: {
    uTime: { value: number }
    uBaseColor: { value: THREE.Color }
    uAccentColor: { value: THREE.Color }
    uGlowColor: { value: THREE.Color }
  }
}

export function createBodyMaterial(palette: PaletteKey = 'cyan'): BodyMaterialBundle {
  const p = PALETTES[palette]
  const uniforms = {
    uTime: { value: 0 },
    uBaseColor: { value: new THREE.Color(p.base) },
    uAccentColor: { value: new THREE.Color(p.accent) },
    uGlowColor: { value: new THREE.Color(p.glow) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vNormal; varying vec3 vViewDir;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }`,
    fragmentShader: `
      uniform vec3 uBaseColor; uniform vec3 uAccentColor; uniform vec3 uGlowColor;
      uniform float uTime;
      varying vec3 vNormal; varying vec3 vViewDir;
      void main() {
        float ndotv = max(0.0, dot(normalize(vNormal), normalize(vViewDir)));
        float fresnel = pow(1.0 - ndotv, 2.5);
        vec3 color = mix(uBaseColor, uAccentColor, fresnel);
        float halo = pow(fresnel, 6.0);
        color += uGlowColor * halo * 0.6;
        float shift = sin(fresnel * 8.0 + uTime * 0.4) * 0.04;
        color += vec3(shift, shift * 0.3, -shift * 0.5);
        gl_FragColor = vec4(color, 1.0);
      }`,
  })
  return { material, uniforms }
}

// -----------------------------------------------------------------------
// Eye field — flat disc with shader-driven upper/lower lid coverage.
// Lids render in body color so the eye reads as "skin folding over"
// with no visible seam. See ORBIT_CHARACTER_DESIGN.md "The eye" section.
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
    uBodyColor: { value: new THREE.Color(p.base) },
    uBodyAccent: { value: new THREE.Color(p.accent) },
    uEyeColor: { value: new THREE.Color(0x060810) },
    uRimColor: { value: new THREE.Color(0x1a1c25) },
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
        vec3 lidColor = mix(uBodyColor, uBodyAccent, crease * 0.25);
        vec3 baseColor = mix(uEyeColor, uRimColor, rimFactor);
        vec3 color = mix(baseColor, lidColor, covered);
        gl_FragColor = vec4(color, eyeMask);
      }`,
  })
  return { material, uniforms }
}

// -----------------------------------------------------------------------
// Pupil + pupil glow — additive discs layered on the eye.
// Shared material between primary and (future) paired eyes.
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

// Earth material lived here as a procedural continent shader while
// the photoreal stack was being built. It's now in
// `src/services/photorealEarth.ts` — the Orbit scene consumes that
// factory directly. No local Earth material exports remain.
