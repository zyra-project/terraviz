/**
 * Materials and shaders for the Orbit character.
 *
 * Vinyl-toy redesign: the body and sub-spheres use a matte
 * `MeshStandardMaterial` whose diffuse channel is overwritten with a
 * warm→cool gradient via `onBeforeCompile`. The gradient runs along a
 * tilted axis (pink-top → cool-bottom with a slight diagonal lean) so
 * the face reads with warm light from above — the neotenous cue the
 * concept art carries.
 *
 * The eye is a stacked disc rig (iris ring, navy pupil field with
 * star sparkles, tiny black pupil dot, two catchlights) that sells
 * the "big wet anime eye" read the concept art shows. See
 * `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md`.
 */

import * as THREE from 'three'
import { PALETTES, type PaletteKey } from './orbitTypes'

// -----------------------------------------------------------------------
// Vinyl body — MeshStandardMaterial with a warm→cool gradient injected
// via onBeforeCompile. Gradient direction is a tilted axis (top-pink,
// bottom-cool, leaning ~15° off vertical) so the face carries a warm
// wash from above and the lower body cools toward the bottom. Matches
// the concept art's lit-from-above vinyl read and the soft neoteny cue
// of a warm forehead.
// -----------------------------------------------------------------------

/**
 * Half-length of the gradient axis in object space. Anything outside
 * this range clamps to the edge color. Matches the body radius
 * (0.075) plus head-room so silhouette pixels hit the clean anchor.
 */
const BODY_GRADIENT_HALF_SPAN = 0.095

/**
 * Gradient axis direction in object space, normalized. Roughly
 * (0.26, -0.97, 0.0) — 15° off vertical, so the warm anchor sits
 * slightly up-and-to-the-left and cool anchor down-and-to-the-right.
 * The Y component dominates so the read is "warm top, cool bottom";
 * the X lean gives the diagonal sparkle the concept art has.
 */
const BODY_GRADIENT_AXIS_X = 0.259
const BODY_GRADIENT_AXIS_Y = -0.966
const BODY_GRADIENT_AXIS_Z = 0.0

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
     * Gradient direction in object space — unit vector pointing from
     * cool anchor toward warm anchor. Exposed on the bundle so future
     * state-driven tweaks (e.g. spinning the axis for a confused
     * spiral) don't need to recompile the shader.
     */
    uAxis: { value: THREE.Vector3 }
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
    uAxis: { value: new THREE.Vector3(BODY_GRADIENT_AXIS_X, BODY_GRADIENT_AXIS_Y, BODY_GRADIENT_AXIS_Z) },
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
    shader.uniforms.uAxis = uniforms.uAxis
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
         uniform vec3 uAxis;
         varying vec3 vOrbitObjPos;`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        // Project the object-space position onto the gradient axis.
        // uAxis points from cool → warm anchor; dot() returns + when
        // the fragment sits on the warm side. Remap to [0,1], mix.
        `float orbitG = clamp(dot(vOrbitObjPos, uAxis) / uSpan * 0.5 + 0.5, 0.0, 1.0);
         vec3 orbitGradient = mix(uCool, uWarm, orbitG);
         vec4 diffuseColor = vec4( orbitGradient, opacity );`,
      )
  }
  return { material, uniforms }
}

// -----------------------------------------------------------------------
// Eye-field (socket interior) — flat disc with a soft dark-rim shader.
//
// Lids used to be painted here via `uUpperLid` / `uLowerLid` smoothstep
// bands, but that produced a flat-disc read and a pink "eyeshadow"
// band from the accent-color crease blend. Lids are now 3-D
// spherical-cap meshes rotating on their own pivots (see
// {@link createLidGeometry} + `buildPairedEye` in `orbitScene.ts`),
// so this shader's only remaining job is to render the socket
// interior behind the iris stack: darker in the center, a touch
// lifted at the rim so the 3-D bezel torus has something to frame.
// -----------------------------------------------------------------------

export interface EyeFieldMaterialBundle {
  material: THREE.ShaderMaterial
  uniforms: {
    uEyeColor: { value: THREE.Color }
    uRimColor: { value: THREE.Color }
  }
}

export function createEyeFieldMaterial(_palette: PaletteKey = 'cyan'): EyeFieldMaterialBundle {
  const uniforms = {
    // Warm dark charcoal for the socket interior — reads as "shadowed
    // recess" rather than "black hole on flat plastic." The inner
    // disc is darker than the rim so the bezel torus catches a
    // lighter halo around the socket without any additional geometry.
    uEyeColor: { value: new THREE.Color(0x0b0910) },
    uRimColor: { value: new THREE.Color(0x1f1a24) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uEyeColor; uniform vec3 uRimColor;
      void main() {
        vec2 c = vUv - vec2(0.5);
        float dist = length(c);
        float eyeMask = 1.0 - smoothstep(0.48, 0.50, dist);
        if (eyeMask < 0.01) discard;
        // Interior is deep; the outer ~30% brightens slightly to
        // suggest the socket's rim curving up toward the bezel.
        float rimFactor = smoothstep(0.32, 0.49, dist);
        vec3 color = mix(uEyeColor, uRimColor, rimFactor);
        gl_FragColor = vec4(color, eyeMask);
      }`,
  })
  return { material, uniforms }
}

// -----------------------------------------------------------------------
// Eye stack — iris ring, navy pupil field with star sparkles, dark
// pupil dot, plus a soft additive iris glow. Shared across the two
// paired eyes so a palette swap is still one write per material.
// See `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md` §Face.
// -----------------------------------------------------------------------

/**
 * Deep navy of the pupil field — the "dark-blue-with-stars" area
 * inside the teal iris ring. Warm navy (not pure black) so it reads
 * as "big liquid anime eye" rather than a dead hole.
 */
const PUPIL_FIELD_COLOR = 0x1a2040

/**
 * Near-black of the tiny pupil-center dot. Just dark enough to
 * register against the navy field without flattening into a void.
 */
const PUPIL_DOT_COLOR = 0x05080e

export interface PupilMaterials {
  /**
   * Iris ring — the accent-colored disc that becomes the visible
   * "iris" once the navy pupil field covers its center. Carries the
   * palette accent + state-driven pupil-color tint (SOLEMN blue,
   * CONFUSED amber, gesture flashes).
   */
  irisMat: THREE.MeshBasicMaterial
  /**
   * Additive accent glow behind the iris. Tinted the same as the
   * iris so the color pops in state transitions.
   */
  irisGlowMat: THREE.MeshBasicMaterial
  /**
   * Dark navy pupil-field disc with a soft radial edge so it feathers
   * into the iris color underneath instead of stacking as a sharp
   * navy donut. Holds the star sparkles on top.
   */
  pupilFieldMat: THREE.ShaderMaterial
  pupilFieldUniforms: { uColor: { value: THREE.Color }; uOpacity: { value: number } }
  /**
   * Tiny near-black pupil-center dot. The "real" anatomical pupil;
   * scales with state pupilSize like the old single-color pupil did.
   */
  pupilDotMat: THREE.MeshBasicMaterial
  /**
   * Additive-white material for the iris sparkle stars. Shared across
   * all star sprites on both eyes. See {@link createStarGeometry}.
   */
  starMat: THREE.MeshBasicMaterial
}

/**
 * Apply the shared "clip to socket silhouette" stencil test to a
 * material. Unlike the lid material (which uses `EqualStencilFunc`
 * with a per-eye ref so each lid only renders inside its own socket),
 * pupil-group materials (iris, pupil field, stars, pupil dot,
 * catchlights, iris glow) are **shared across both eyes**. We can't
 * give them per-eye refs without duplicating every material — so
 * they use `NotEqualStencilFunc` against `0`, which passes wherever
 * ANY socket mask has written stencil (both left=1 and right=2
 * pass "!= 0"). Each eye's contents are positioned in its own local
 * space and can't cross the gap between sockets, so shared-material
 * cross-contamination isn't possible in practice.
 *
 * Three.js `stencilWrite: true` is the master enable; all stencil
 * ops are `KeepStencilOp` so the material reads the buffer without
 * modifying it.
 */
function applyPupilStencilClip(mat: THREE.Material): void {
  mat.stencilWrite = true
  mat.stencilRef = 0
  mat.stencilFunc = THREE.NotEqualStencilFunc
  mat.stencilFail = THREE.KeepStencilOp
  mat.stencilZFail = THREE.KeepStencilOp
  mat.stencilZPass = THREE.KeepStencilOp
}

export function createPupilMaterials(palette: PaletteKey = 'cyan'): PupilMaterials {
  const accent = new THREE.Color(PALETTES[palette].accent)
  const pupilFieldUniforms = {
    uColor: { value: new THREE.Color(PUPIL_FIELD_COLOR) },
    uOpacity: { value: 1.0 },
  }
  const pupilFieldMat = new THREE.ShaderMaterial({
    uniforms: pupilFieldUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor; uniform float uOpacity;
      void main() {
        vec2 c = vUv - vec2(0.5);
        float d = length(c) * 2.0;   // 0 at center, 1 at disc edge
        if (d > 1.0) discard;
        // Soft outer edge — the last 15% of radius feathers into the
        // iris layer behind, so the pupil/iris transition reads as
        // "liquid eye" rather than two stacked stickers.
        float a = uOpacity * (1.0 - smoothstep(0.82, 1.0, d));
        gl_FragColor = vec4(uColor, a);
      }`,
  })
  const irisMat = new THREE.MeshBasicMaterial({
    color: accent.clone(),
    transparent: true,
  })
  const irisGlowMat = new THREE.MeshBasicMaterial({
    color: accent.clone(),
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
  })
  const pupilDotMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PUPIL_DOT_COLOR),
    transparent: true,
  })
  const starMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  // Every mesh inside the pupilGroup is clipped to the socket by the
  // stencil mask — otherwise gaze excursion lets the iris / pupil
  // field escape past the bezel rim when Orbit looks toward an eye's
  // outer corner.
  applyPupilStencilClip(irisMat)
  applyPupilStencilClip(irisGlowMat)
  applyPupilStencilClip(pupilFieldMat)
  applyPupilStencilClip(pupilDotMat)
  applyPupilStencilClip(starMat)
  return {
    irisMat, irisGlowMat,
    pupilFieldMat, pupilFieldUniforms,
    pupilDotMat, starMat,
  }
}

// -----------------------------------------------------------------------
// Socket bezel ring — 3-D torus around each eye. Sits flush with the
// body surface, framing the recessed socket below. Matte charcoal
// `MeshStandardMaterial` so the scene key light picks it up: the
// upper arc brightens, the lower arc shadows, and the socket
// silhouette reads as a real hole in the body rather than a painted
// spot. Shared across both eyes (one material, two meshes).
// -----------------------------------------------------------------------

export function createBezelMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    // DIAGNOSTIC — temporarily bright blue so the user can tell
    // whether the "inner-wedge" artifacts they see are specular
    // highlights on the bezel's torus tube. Revert on next commit.
    color: 0x0088ff,
    roughness: 0.45,
    metalness: 0.0,
  })
}

// -----------------------------------------------------------------------
// Socket stencil mask + lid material.
//
// The eyelid dome geometry extends beyond the socket rim at wide
// rotations — there's no dome shape that covers the full iris AND
// stays inside the small socket silhouette during its travel arc.
// The fix is a stencil clip: a tiny invisible mask disc the size of
// the socket is drawn first, writing a per-pixel stencil ID; the
// lid material then tests the stencil and only paints fragments
// where the ID matches. Anything that would render outside the
// socket gets clipped by the GPU for free.
//
// Each eye uses a different stencil ID (left=1, right=2) so the
// left lid can't accidentally bleed through the right socket's mask.
// -----------------------------------------------------------------------

/**
 * Build an invisible stencil-writing material for the socket mask.
 * Writes `stencilRef` to the stencil buffer wherever the mask mesh
 * covers. Does not write color or depth — the mask is purely a
 * stencil-setup pass.
 */
export function createSocketMaskMaterial(stencilRef: number): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    // Don't touch color or depth — the mask is purely a stencil
    // setup pass, invisible to the final image.
    colorWrite: false,
    depthWrite: false,
    // Bypass the depth test entirely so the mask always writes
    // stencil regardless of what meshes have rendered before it.
    // The body silhouette sits in front of the recessed socket at
    // the socket center, so WITHOUT this, mask fragments would be
    // occluded by the body and stencil would not be written in the
    // middle of the socket — the clip would fail there and the lid
    // would leak through.
    depthTest: false,
  })
  mat.stencilWrite = true
  mat.stencilRef = stencilRef
  mat.stencilFunc = THREE.AlwaysStencilFunc
  mat.stencilZPass = THREE.ReplaceStencilOp
  mat.stencilFail = THREE.KeepStencilOp
  mat.stencilZFail = THREE.KeepStencilOp
  return mat
}

/**
 * Build a lid material — the body's vinyl gradient pipeline + a
 * stencil test that clips the lid to the socket interior. Shares
 * the palette uniforms with the main body bundle so palette swaps
 * propagate correctly; only the stencil flags differ.
 *
 * **Three.js gotcha:** `stencilWrite` is the master switch for the
 * entire stencil subsystem on a material — if it's `false`, the GPU
 * skips both the stencil TEST and WRITE. To make a material read
 * the stencil buffer without modifying it, we turn `stencilWrite`
 * ON and set every stencil op (`stencilFail`, `stencilZFail`,
 * `stencilZPass`) to `KeepStencilOp`. That way the lid tests
 * against the mask ID but never alters the buffer.
 *
 * Each eye gets its own lid material instance with its own
 * `stencilRef` so left/right sockets don't cross-contaminate.
 */
export function createLidMaterial(palette: PaletteKey, stencilRef: number): BodyMaterialBundle {
  const bundle = createBodyMaterial(palette)
  const mat = bundle.material
  mat.stencilWrite = true
  mat.stencilRef = stencilRef
  mat.stencilFunc = THREE.EqualStencilFunc
  mat.stencilFail = THREE.KeepStencilOp
  mat.stencilZFail = THREE.KeepStencilOp
  mat.stencilZPass = THREE.KeepStencilOp
  return bundle
}

// -----------------------------------------------------------------------
// Eyelid geometry — a shallow spherical cap. Shared across every lid
// instance (two per eye × two eyes = four meshes). The cap opens
// downward (toward the eye it covers); rotation on the parenting
// pivot swings it into/out of frame.
// -----------------------------------------------------------------------

/**
 * Build the shared spherical-cap geometry for eyelids. Called once
 * at buildScene time; all four lid meshes share the result. A cap
 * of phi-length `Math.PI * 2` and theta-length `Math.PI * 0.42`
 * gives a shallow dome about 40% of a hemisphere tall — enough to
 * cover the socket when closed, thin enough to read as a "lid"
 * rather than a hat.
 */
export function createLidGeometry(radius: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(
    radius,
    24, 8,                  // widthSegs, heightSegs — ample for the smooth edge
    0, Math.PI * 2,          // full azimuth (the whole ring)
    0, Math.PI * 0.42,       // top 40% of the sphere = shallow dome
  )
}

/**
 * Build a tiny five-point star geometry for iris sparkles. Four
 * inner vertices pinch toward the center to give the star its
 * pointed-lobe shape without going full SVG-path on the GPU.
 * Shared across every star sprite on both eyes — clones of the
 * mesh share the geometry so memory stays flat.
 */
export function createStarGeometry(radius: number): THREE.BufferGeometry {
  const points = 5
  const inner = radius * 0.42
  // Triangle-fan: center vertex at index 0, then 2*points outer vertices
  // alternating between the long-ray tip and the short inner dip.
  const verts = new Float32Array((1 + 2 * points + 1) * 3)
  verts[0] = 0; verts[1] = 0; verts[2] = 0
  for (let i = 0; i <= 2 * points; i++) {
    const wrapped = i % (2 * points)
    const r = wrapped % 2 === 0 ? radius : inner
    // Top vertex is a tip (upward-pointing star); rotate -π/2 to start there.
    const angle = -Math.PI / 2 + (wrapped / (2 * points)) * Math.PI * 2
    verts[(i + 1) * 3] = Math.cos(angle) * r
    verts[(i + 1) * 3 + 1] = Math.sin(angle) * r
    verts[(i + 1) * 3 + 2] = 0
  }
  const idx: number[] = []
  for (let i = 0; i < 2 * points; i++) {
    idx.push(0, i + 1, i + 2)
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  geom.setIndex(idx)
  return geom
}

// -----------------------------------------------------------------------
// Catchlight — static additive-white disc that sits on each eye and
// stays fixed relative to the eye group as the pupil moves. Two
// highlights per eye (primary upper-right, secondary lower-left) sell
// the "wet, alive" read that rigid pupils alone can't.
// -----------------------------------------------------------------------

/**
 * Build a catchlight material — additive-white specular highlight
 * with a soft radial falloff (bright core → transparent edge). Reads
 * as a light reflection on the iris rather than a flat white decal
 * stamped onto the eye, which is what a plain `MeshBasicMaterial`
 * produced. Each instance carries its own `uOpacity` uniform so
 * primary / secondary catchlights can have different intensities
 * but share the same shader.
 */
export function createCatchlightMaterial(opacity: number): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: opacity },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uOpacity;
      void main() {
        // Distance from disc center, 0 at center to 1 at disc edge.
        // Quadratic falloff (pow exponent 2.2) pushes the bright
        // zone toward the center so the highlight has a clear
        // core rather than a uniform wash across the disc.
        vec2 c = vUv - vec2(0.5);
        float d = length(c) * 2.0;
        if (d >= 1.0) discard;
        float fade = pow(1.0 - d, 2.2);
        gl_FragColor = vec4(1.0, 1.0, 1.0, uOpacity * fade);
      }`,
  })
  // Catchlights ride the pupilGroup so they track gaze. Stencil
  // clip keeps them inside the socket silhouette at extreme gaze
  // angles, matching the rest of the pupil-group meshes.
  applyPupilStencilClip(mat)
  return mat
}

// -----------------------------------------------------------------------
// Backlight halo — soft warm radial glow that sits behind the body
// and bleeds outward to the scene background. Closes the "luminous
// vinyl toy" read from the concept art without having to pump
// emissive on the body material (which would fight the matte look).
// -----------------------------------------------------------------------

export interface BacklightMaterialBundle {
  material: THREE.ShaderMaterial
  uniforms: {
    uColor: { value: THREE.Color }
    uOpacity: { value: number }
  }
}

/**
 * Warm-white halo color. Kept constant across palettes — the
 * backlight is ambient "lit from behind" light, not character color.
 * Palette-tinting the halo makes the cool palettes read as sickly;
 * a neutral warm glow flatters every option.
 */
const BACKLIGHT_COLOR = 0xffd4a0

export function createBacklightMaterial(): BacklightMaterialBundle {
  const uniforms = {
    uColor: { value: new THREE.Color(BACKLIGHT_COLOR) },
    uOpacity: { value: 0.42 },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        vec2 c = vUv - vec2(0.5);
        float d = length(c);
        if (d > 0.5) discard;
        float fade = 1.0 - smoothstep(0.0, 0.5, d);
        fade = pow(fade, 1.6);
        gl_FragColor = vec4(uColor, uOpacity * fade);
      }`,
  })
  return { material, uniforms }
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
