/**
 * Materials and shaders for the Orbit character.
 *
 * Lifted from `docs/prototypes/orbit-prototype.jsx` after a one-time
 * ASCII-quote normalization pass. The GLSL is byte-for-byte identical
 * to the prototype so the nine-iteration visual tuning is preserved.
 * See docs/ORBIT_CHARACTER_INTEGRATION_PLAN.md §5.
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

// -----------------------------------------------------------------------
// Earth — procedural continent shader, no textures. fBm-ish noise via
// layered sin/cos gives readable continent-like blobs. Not geographically
// accurate, but "this is a planet" reads at every scale. Self-contained
// (no texture fetches), runs inside the Quest shader budget.
// -----------------------------------------------------------------------

export interface EarthMaterialBundle {
  material: THREE.ShaderMaterial
  uniforms: {
    uTime: { value: number }
    uLightDir: { value: THREE.Vector3 }
  }
}

export function createEarthMaterial(): EarthMaterialBundle {
  const uniforms = {
    uTime: { value: 0 },
    uLightDir: { value: new THREE.Vector3(0.6, 0.8, 0.5).normalize() },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vPosW = worldPos.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      varying vec3 vNormalW;
      varying vec3 vPosW;
      uniform float uTime;
      uniform vec3 uLightDir;

      float pseudo3(vec3 p) {
        float a = sin(p.x * 5.3 + 1.2) * cos(p.y * 4.1 - 0.7) * sin(p.z * 3.7 + 0.4);
        float b = sin(p.x * 9.7 + 2.4) * cos(p.y * 8.3 + 1.3) * sin(p.z * 7.5 - 0.9) * 0.55;
        float c = sin(p.x * 17.1 + 4.5) * cos(p.y * 15.2 + 2.1) * sin(p.z * 13.4 + 1.6) * 0.30;
        float d = sin(p.x * 31.3 + 0.2) * cos(p.y * 27.9 + 3.2) * 0.15;
        return a + b + c + d;
      }

      void main() {
        vec3 n = normalize(vNormalW);

        float land = pseudo3(n * 1.6);
        float isLand = smoothstep(0.05, 0.22, land);

        vec3 deepOcean   = vec3(0.03, 0.06, 0.13);
        vec3 shallowSea  = vec3(0.06, 0.14, 0.22);
        vec3 coast       = vec3(0.14, 0.22, 0.18);
        vec3 forest      = vec3(0.13, 0.22, 0.10);
        vec3 savanna     = vec3(0.32, 0.28, 0.14);
        vec3 desert      = vec3(0.42, 0.35, 0.20);

        float shallow = smoothstep(-0.1, 0.1, land);
        vec3 oceanCol = mix(deepOcean, shallowSea, shallow);

        float variation = pseudo3(n * 4.5) * 0.5 + 0.5;
        vec3 landCol = mix(forest, savanna, variation);
        landCol = mix(landCol, desert, smoothstep(0.6, 0.9, variation) * 0.55);

        float coastBlend = smoothstep(0.04, 0.18, land) * (1.0 - smoothstep(0.18, 0.28, land));
        landCol = mix(landCol, coast, coastBlend * 0.4);

        vec3 color = mix(oceanCol, landCol, isLand);

        float iceBlend = smoothstep(0.78, 0.90, abs(n.y));
        color = mix(color, vec3(0.82, 0.88, 0.92), iceBlend);

        float diff = max(0.18, dot(n, normalize(uLightDir)));
        color *= diff;

        vec3 viewDir = normalize(cameraPosition - vPosW);
        float fres = pow(1.0 - max(0.0, dot(n, viewDir)), 3.0);
        color += vec3(0.25, 0.45, 0.70) * fres * 0.35;

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  })
  return { material, uniforms }
}
