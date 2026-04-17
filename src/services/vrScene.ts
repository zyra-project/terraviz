/**
 * Three.js scene for the VR view.
 *
 * Builds a unit sphere in front of the user and swaps its texture
 * between a baked base Earth image and a live HLS `HTMLVideoElement`
 * depending on what the 2D app has loaded. The HUD (play/pause,
 * dataset title, exit button) lives in `vrHud.ts` and is attached by
 * the caller.
 *
 * Day/night shading — when no dataset is loaded, the globe shows a
 * photorealistic day/night composite:
 *   - Diffuse (day Earth) from external CDN
 *   - Specular map for ocean glint (local asset)
 *   - Emissive map (night lights) gated to the unlit side via a
 *     `smoothstep` shader patch, ported from the pre-MapLibre
 *     `earthMaterials.ts` (commit 3911300^).
 * When a dataset texture (video/image) is loaded, emissive gating
 * is disabled so the dataset covers both hemispheres uniformly.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}.
 */

import type * as THREE from 'three'
import { getSunPosition } from '../utils/time'
import { getCloudTextureUrl } from '../utils/deviceCapability'
import { logger } from '../utils/logger'

/**
 * Placement of the globe in the local-floor reference space.
 *
 * Local-floor places `y=0` at the user's standing floor, so `y=1.3`
 * is roughly eye-height for a seated user. `z=-1.5` puts the globe
 * about arm's-length ahead of them.
 */
const GLOBE_POSITION = { x: 0, y: 1.3, z: -1.5 }

/** Starting globe radius in meters. Gets scaled by zoom input. */
const GLOBE_RADIUS = 0.5

/** Clamps on zoom so the globe never vanishes into the user's head or flies off. */
export const MIN_GLOBE_SCALE = 0.3
export const MAX_GLOBE_SCALE = 2.5

/**
 * Fallback Earth texture — monochrome specular map shipped with
 * the repo. Used as the initial `material.map` while the full
 * diffuse loads from the CDN, and as a permanent fallback if the
 * CDN fetch fails. Also serves as the specular map regardless.
 */
const BASE_EARTH_TEXTURE_URL = '/assets/Earth_Specular_2K.jpg'

/**
 * External CDN URLs for the full Earth day/night textures, in
 * progressive-enhancement tiers.
 *
 * Hosted on a CloudFront distribution (not Git LFS). The previous
 * `Earth_Diffuse_6K.jpg` asset was deliberately removed from LFS
 * in commit `34167f2` when the zyra-project account hit 9 GB /
 * 10 GB LFS bandwidth/month. CloudFront keeps that problem from
 * recurring and gives better edge-cached latency than S3 direct.
 *
 * Progressive strategy:
 *   1. 2K loads first (~500 ms on a good connection) → fast first
 *      render. Arm's-length viewing is visually indistinguishable
 *      from higher tiers at the Quest's ~40° globe FOV.
 *   2. 4K then replaces it in the background (~2-3 s) → crisp
 *      enough for moderate lean-in / zoom.
 *   3. 8K (diffuse only) replaces 4K (~5-10 s) → the "lean in and
 *      count the coastlines" tier. Worth having even though most
 *      users won't see the difference: AR's zoom-and-inspect is
 *      the killer capability that rewards high-resolution source.
 *
 * Automatic mipmap generation (Three.js default for power-of-two
 * textures) means higher tiers don't hurt distant-view quality —
 * the GPU samples from pre-filtered levels. Upgrading is always a
 * win when it succeeds.
 *
 * Lights mirrors diffuse with full 2K → 4K → 8K progression. 8K
 * RGBA is ~256 MB on the GPU before mipmaps, which is chunky for
 * Quest 2's VRAM, but: (a) progressive loading means a failed 8K
 * allocation leaves the 4K tier resident rather than erroring,
 * (b) Quest 3 / Pro have plenty of headroom, (c) night-side city
 * detail is exactly the kind of thing users want to lean in and
 * inspect — coastal city strings, suburban patterns, highway
 * networks are legible at 8K in a way they aren't at 4K.
 *
 * If any tier URL 404s or fails to allocate, progression stops at
 * the previous tier and the visible texture stays at the
 * highest-successful tier.
 */
const EARTH_TEXTURE_BASE = 'https://d3sik7mbbzunjo.cloudfront.net/terraviz/basemaps'
const EARTH_DIFFUSE_URLS = [
  `${EARTH_TEXTURE_BASE}/earth_diffuse_2048.jpg`,
  `${EARTH_TEXTURE_BASE}/earth_diffuse_4096.jpg`,
  `${EARTH_TEXTURE_BASE}/earth_diffuse_8192.jpg`,
]
const EARTH_LIGHTS_URLS = [
  `${EARTH_TEXTURE_BASE}/earth_lights_2048.jpg`,
  `${EARTH_TEXTURE_BASE}/earth_lights_4096.jpg`,
  `${EARTH_TEXTURE_BASE}/earth_lights_8192.jpg`,
]

// --- Day/night material constants (ported from earthMaterials.ts) ---
const EARTH_SHININESS = 40
const NIGHT_LIGHT_STRENGTH = 0.5

/**
 * Atmosphere shell radii relative to the globe. Two concentric
 * spheres render additively over the globe to fake Rayleigh +
 * Mie scattering: the inner shell is a soft day-side glow with
 * sunset warm tones near the terminator; the outer shell is a
 * wider fresnel rim that extends beyond the planet's silhouette.
 *
 * Values match the pre-MapLibre `earthMaterials.ts` constants,
 * scaled by GLOBE_RADIUS so the relationship to the globe is
 * preserved at our half-metre sphere.
 */
const ATMOSPHERE_INNER_RADIUS = GLOBE_RADIUS * 1.003
const ATMOSPHERE_OUTER_RADIUS = GLOBE_RADIUS * 1.012
const ATMOSPHERE_SEGMENTS = 64

/**
 * Sun sprite placement (visible in both VR and AR). Positioned at
 * `globe.position + sunDir * SUN_DISTANCE` each frame so it tracks
 * the real subsolar direction and moves with the globe when the
 * globe is placed/translated. An earlier version gated this to
 * VR-only out of concern that a glowing disc in a real room would
 * look weird; in practice the atmosphere rim uses the same additive
 * approach in AR and works fine, and users expect to SEE where the
 * light is coming from as a spatial cue. Showing the sun in both
 * modes is consistent with that.
 *
 * Angular size at arm's-length viewing: core ≈ 1.7° (readable as
 * "a sun" without dominating the view), glow halo ≈ 8.5° (a soft
 * bloom that fades out before reaching the globe).
 */
const SUN_DISTANCE = 10
const SUN_CORE_SCALE = 0.3
const SUN_GLOW_SCALE = 1.5
const SUN_GLOW_OPACITY = 0.4
const SUN_GLOW_TEXTURE_SIZE = 256

/**
 * How often to recompute the subsolar point (via `getSunPosition`).
 * The sun moves ~0.25° per minute in longitude; 2 seconds = 0.008°
 * which is imperceptible. Per-frame re-calculation runs ~90x more
 * than needed AND allocates a new `Date` object each time, which
 * profiled as avoidable GC pressure in XR.
 */
const SUN_UPDATE_INTERVAL_MS = 2000

/**
 * Cloud overlay — a slightly-larger translucent sphere above the
 * globe surface with a day/night shader patch so clouds dim to
 * near-black on the night side (otherwise they'd obscure the city
 * lights underneath).
 *
 * Cloud texture is shared with the 2D app via `getCloudTextureUrl()`
 * from `utils/deviceCapability.ts` — already hosted on the S3
 * bucket, no new asset needed. Values copied from pre-MapLibre
 * earthMaterials.ts.
 */
const CLOUD_RADIUS = GLOBE_RADIUS * 1.005
const CLOUD_SEGMENTS = 64
const CLOUD_OPACITY = 0.9
/**
 * Gamma exponent applied when converting luminance → alpha during
 * the cloud texture preprocessing step. Keeps thin cloud wisps
 * more transparent than dense formations, which looks more like
 * real atmosphere than a uniform-alpha wash would.
 */
const CLOUD_ALPHA_GAMMA = 0.55

/**
 * Convert the subsolar geographic lat/lng (degrees) into a
 * world-space unit direction vector. Matches the convention used
 * by the old `EarthMaterials.setSun()` — note the negated Z so
 * the result lines up with Three.js `SphereGeometry`'s default
 * equirectangular UV wrap.
 */
function sunDirectionFromLatLng(
  THREE_: typeof THREE,
  lat: number,
  lng: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const latRad = (lat * Math.PI) / 180
  const lngRad = (lng * Math.PI) / 180
  return out.set(
    Math.cos(latRad) * Math.cos(lngRad),
    Math.sin(latRad),
    -Math.cos(latRad) * Math.sin(lngRad),
  )
}

/**
 * What's currently driving the globe's surface texture. Mirrors the
 * 2D dataset model: image datasets (Age of Sea Floor, Bathymetry,
 * etc.) are pre-decoded `HTMLImageElement`s; video datasets stream
 * through HLS into an `HTMLVideoElement`. Null falls back to the
 * base Earth placeholder.
 *
 * Image datasets carry the already-decoded `HTMLImageElement` from
 * the 2D loader rather than a URL so we skip the re-fetch + the
 * resolution-fallback dance that `datasetLoader.ts` does — the
 * browser has already resolved which URL succeeded and decoded the
 * pixels into this element.
 */
export type VrDatasetTexture =
  | { readonly kind: 'video'; readonly element: HTMLVideoElement }
  | { readonly kind: 'image'; readonly element: HTMLImageElement }

export interface VrSceneHandle {
  /** The Three.js scene — attach/detach objects (controllers, HUD) here. */
  readonly scene: THREE.Scene
  /** The primary globe mesh — backward-compatible handle. vrInteraction uses this for single-hand drag. */
  readonly globe: THREE.Mesh
  /**
   * All globe meshes including the primary at index 0. Used by
   * vrInteraction for multi-globe raycast — any globe can be
   * hit, and hitting a non-primary promotes it.
   */
  readonly allGlobes: THREE.Mesh[]
  /**
   * Set the number of visible globe slots. 1 = primary-only
   * (default, backward-compatible). 2+ = arc layout with
   * secondary globes alongside the primary. Creates/destroys
   * secondary globes as needed; the primary is always slot 0.
   */
  setPanelCount(count: number): void
  /**
   * Set texture for a specific slot. Slot 0 delegates to the full
   * primary setTexture (photoreal Earth stack, shader patches,
   * atmosphere/cloud toggling). Slot > 0 uses a simpler material
   * swap on secondary globes.
   *
   * @param onReady Same semantics as setTexture for slot 0. For
   *   secondaries, fires immediately for images/null, async for
   *   video with readyState < 2.
   */
  setSlotTexture(slot: number, spec: VrDatasetTexture | null, onReady?: () => void): void
  /**
   * Swap the primary globe's texture. Convenience alias for
   * `setSlotTexture(0, spec, onReady)`.
   */
  setTexture(spec: VrDatasetTexture | null, onReady?: () => void): void
  /**
   * Per-frame update — currently syncs the ground shadow scale to
   * the globe's zoom. Safe to skip if the caller doesn't need a
   * frame-accurate shadow (e.g. during loading), but cheap enough
   * to call every frame.
   */
  update(): void
  /** Release every GPU resource. Safe to call multiple times. */
  dispose(): void
}

/**
 * Build the VR scene. Caller is responsible for attaching the
 * returned scene to a renderer, wiring up controller input
 * (`vrInteraction.ts`), and calling `dispose()` when the session ends.
 *
 * Takes the already-imported Three.js module so the lazy-loading
 * decision lives at the call site (`vrSession.ts`).
 *
 * @param transparentBackground When true (AR passthrough mode),
 *   the scene background stays unset so the renderer's clear pixels
 *   reveal the camera feed behind. When false (VR mode), a dark
 *   "deep space" background is set so the user is fully immersed.
 */
export function createVrScene(
  THREE_: typeof THREE,
  transparentBackground = false,
): VrSceneHandle {
  const scene = new THREE_.Scene()
  // For VR, set a dark space-blue background. For AR passthrough,
  // leave background unset (null) so the renderer clears to
  // transparent and the camera feed shows through.
  if (!transparentBackground) {
    scene.background = new THREE_.Color(0x000814) // deep space blue
  }

  // Ambient fill so the night side isn't pitch black. The main
  // light comes from `sunLight` below, positioned at the current
  // subsolar direction in world space — so the globe's day/night
  // terminator matches real UTC time.
  scene.add(new THREE_.AmbientLight(0xffffff, 0.35))
  const sunLight = new THREE_.DirectionalLight(0xffffff, 1.8)
  // Initial position — update() repositions each frame based on
  // current UTC time via getSunPosition().
  sunLight.position.set(2, 1.5, 1)
  scene.add(sunLight)

  // When a dataset is loaded, the globe must be uniformly lit so the
  // scientific-viz colours read correctly across the entire sphere.
  // We add a second ambient at intensity 0 and toggle between
  // "planet mode" (sunLight on, datasetAmbient off) and "dataset
  // mode" (sunLight off, datasetAmbient on) in setTexture.
  const datasetAmbient = new THREE_.AmbientLight(0xffffff, 0)
  scene.add(datasetAmbient)

  // Shader-uniform handle for the sun direction. Shared between the
  // Earth material's `onBeforeCompile` patch and the per-frame
  // `update()` which writes the current subsolar direction.
  const sunDirUniform = { value: new THREE_.Vector3(1, 0, 0) }
  // Scratches for the per-frame sun-update path. `sunLocalDirCache`
  // is refreshed at `SUN_UPDATE_INTERVAL_MS` cadence (subsolar point
  // moves ~0.25°/min — the cadence is way finer than needed but
  // cheap). Per-frame we copy it into a scratch, apply the globe's
  // current rotation, and write into downstream targets — no
  // allocations in the hot path.
  const sunLocalDirCache = new THREE_.Vector3(1, 0, 0)
  const sunDirScratch = new THREE_.Vector3()
  const sunWorldPosScratch = new THREE_.Vector3()
  let lastSunUpdateMs = -Infinity

  // Promise-based image loader used by the Earth CDN progressive
  // loader, the cloud overlay, and anything else in the scene that
  // needs a decoded `HTMLImageElement` from a cross-origin URL.
  // `crossOrigin='anonymous'` is required so the returned image is
  // CORS-clean — otherwise Canvas2D `getImageData()` throws (used
  // for the cloud luminance → alpha preprocessing).
  const loadImage = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Failed to load ${url}`))
      img.src = url
    })

  // Load the initial fallback texture (monochrome specular). Serves
  // double duty: the `map` until the diffuse CDN fetch lands, AND
  // the `specularMap` permanently so oceans get glint.
  const textureLoader = new THREE_.TextureLoader()
  const baseEarthTexture = textureLoader.load(BASE_EARTH_TEXTURE_URL)
  baseEarthTexture.colorSpace = THREE_.SRGBColorSpace
  const specularMapTexture = textureLoader.load(BASE_EARTH_TEXTURE_URL)

  // MeshPhongMaterial — matches the pre-MapLibre earthMaterials.ts
  // shader style. Phong is simpler than StandardMaterial (no PBR)
  // and runs faster on Quest. The `emissive: white` + `emissiveMap`
  // combination is what the shader patch uses for night-lights
  // gating; emissiveMap starts null and gets set once the lights
  // texture finishes loading.
  const material = new THREE_.MeshPhongMaterial({
    map: baseEarthTexture,
    specularMap: specularMapTexture,
    specular: new THREE_.Color(0xaaaaaa),
    shininess: EARTH_SHININESS,
    emissiveMap: null,
    emissive: new THREE_.Color(0xffffff),
  })

  // Shader patch: gate the emissive map (night city lights) to the
  // dark side of the globe only, using a smoothstep over the sun
  // direction dot product. Night lights become invisible on the lit
  // side even though the emissiveMap texture is sampled everywhere.
  //
  // Direct port from earthMaterials.ts (pre-MapLibre). Three.js'
  // standard Phong shader is patched in-place via onBeforeCompile
  // rather than rolled from scratch, so lighting / shadows / etc.
  // all still work out of the box.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = sunDirUniform

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
       uniform vec3 uSunDir;
       varying float vNdotL;`,
    )
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
       vec3 wNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
       vNdotL = dot(wNormal, uSunDir);`,
    )

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
       varying float vNdotL;`,
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#ifdef USE_EMISSIVEMAP
         vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
         float nightFactor = smoothstep( 0.0, -0.2, vNdotL );
         totalEmissiveRadiance *= emissiveColor.rgb * nightFactor * ${NIGHT_LIGHT_STRENGTH.toFixed(2)};
       #endif`,
    )
  }

  // 64×64 is plenty for a globe that fills ~40° of the viewer's FOV.
  const geometry = new THREE_.SphereGeometry(GLOBE_RADIUS, 64, 64)
  const globe = new THREE_.Mesh(geometry, material)
  globe.position.set(GLOBE_POSITION.x, GLOBE_POSITION.y, GLOBE_POSITION.z)
  scene.add(globe)

  // --- Atmosphere ---
  // Direct port of earthMaterials.ts's Rayleigh scattering shader.
  // Two concentric transparent shells use additive blending over
  // the Earth surface:
  //
  //   Inner shell (FrontSide)  — rim-glow on the day side, warm
  //     sunset colour near the terminator, darker on the night
  //     side. Simulates in-scattering of sunlight through the
  //     daytime atmosphere.
  //   Outer shell (BackSide)   — wider halo extending beyond the
  //     planet's silhouette, sampled with a fresnel-weighted
  //     Rayleigh+Mie phase mix. Makes the planet look like it
  //     has a proper hazy edge rather than a hard sphere outline.
  //
  // Both share the uSunDir uniform with the Earth material so the
  // day/night terminator and atmosphere glow move together.
  //
  // Position + scale sync to the globe each frame in update() —
  // they're NOT children of the globe mesh so they don't inherit
  // the user's rotation input (atmosphere doesn't rotate with the
  // surface in reality).
  const atmosphereVertexShader = `
    varying vec3 vWorldNormal;
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `

  const atmosphereScatteringConstants = `
    const vec3 betaR = vec3(5.5e-6, 13.0e-6, 22.4e-6);
    const vec3 betaNorm = betaR / 22.4e-6;
  `

  const atmosphereInnerFrag = `
    uniform vec3 uSunDir;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPosition;
    ${atmosphereScatteringConstants}

    void main() {
      vec3 viewDir = normalize(cameraPosition - vWorldPosition);
      vec3 N = normalize(vWorldNormal);

      float NdotV = dot(viewDir, N);
      float rim = exp(-8.0 * NdotV * NdotV);

      float sunNdot = dot(N, uSunDir);
      float atmosphereLit = smoothstep(-0.15, 0.4, sunNdot);

      float opticalDepth = 1.0 / max(NdotV, 0.05);

      vec3 extinction = exp(-betaR * opticalDepth * 4e5);
      vec3 rayleighColor = betaNorm * (1.0 - extinction);

      float terminator = exp(-6.0 * sunNdot * sunNdot);
      vec3 sunsetWarm = vec3(1.0, 0.4, 0.1);
      vec3 color = mix(rayleighColor, sunsetWarm, terminator * rim * 0.5);

      float alpha = rim * atmosphereLit * 0.35;
      gl_FragColor = vec4(color, alpha);
    }
  `

  const atmosphereOuterFrag = `
    uniform vec3 uSunDir;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPosition;
    ${atmosphereScatteringConstants}

    void main() {
      vec3 viewDir = normalize(cameraPosition - vWorldPosition);
      vec3 N = normalize(vWorldNormal);

      float fresnel = 1.0 - dot(viewDir, N);
      float rim = pow(fresnel, 1.5);

      float sunNdot = dot(N, uSunDir);
      float atmosphereLit = smoothstep(-0.15, 0.4, sunNdot);

      float cosTheta = dot(viewDir, uSunDir);
      float rayleighPhase = 0.75 * (1.0 + cosTheta * cosTheta);

      float g = 0.758;
      float g2 = g * g;
      float miePhase = (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
      miePhase *= 0.12;

      vec3 scatterColor = betaNorm * rayleighPhase;
      scatterColor += vec3(1.0, 0.95, 0.85) * miePhase;

      float terminator = exp(-8.0 * sunNdot * sunNdot);
      vec3 sunsetColor = vec3(1.0, 0.4, 0.08);
      scatterColor = mix(scatterColor, sunsetColor, terminator * 0.35);

      float alpha = rim * atmosphereLit * 0.18;
      gl_FragColor = vec4(scatterColor, alpha);
    }
  `

  const atmosphereInnerGeometry = new THREE_.SphereGeometry(
    ATMOSPHERE_INNER_RADIUS, ATMOSPHERE_SEGMENTS, ATMOSPHERE_SEGMENTS,
  )
  const atmosphereInnerMaterial = new THREE_.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereInnerFrag,
    uniforms: { uSunDir: sunDirUniform },
    transparent: true,
    side: THREE_.FrontSide,
    depthWrite: false,
    blending: THREE_.AdditiveBlending,
  })
  const atmosphereInner = new THREE_.Mesh(atmosphereInnerGeometry, atmosphereInnerMaterial)
  atmosphereInner.position.copy(globe.position)
  scene.add(atmosphereInner)

  const atmosphereOuterGeometry = new THREE_.SphereGeometry(
    ATMOSPHERE_OUTER_RADIUS, ATMOSPHERE_SEGMENTS, ATMOSPHERE_SEGMENTS,
  )
  const atmosphereOuterMaterial = new THREE_.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereOuterFrag,
    uniforms: { uSunDir: sunDirUniform },
    transparent: true,
    side: THREE_.BackSide,
    depthWrite: false,
    blending: THREE_.AdditiveBlending,
  })
  const atmosphereOuter = new THREE_.Mesh(atmosphereOuterGeometry, atmosphereOuterMaterial)
  atmosphereOuter.position.copy(globe.position)
  scene.add(atmosphereOuter)

  // --- Sun sprite ---
  // Two billboard sprites: a small bright core and a larger soft
  // glow halo. Both use procedural CanvasTextures (radial gradients)
  // so we don't need a new asset hosted anywhere. Positioned each
  // frame in update() at `globe.position + sunDir * SUN_DISTANCE`
  // so they track the real subsolar direction as UTC advances.
  //
  // Visible in both VR and AR modes. An earlier version gated this
  // VR-only on the theory that a glowing disc in the user's real
  // room would read as weird — but the atmosphere rim shader
  // already renders additively in AR and looks fine, so the sun
  // (same additive approach) is consistent rather than jarring.
  //
  // Direct port from the pre-MapLibre `earthMaterials.ts` sun
  // visual (commit 3911300^), scaled for our 0.5 m globe.
  let sunCoreSprite: THREE.Sprite | null = null
  let sunGlowSprite: THREE.Sprite | null = null
  {
    /**
     * Build a canvas with a radial gradient from opaque centre to
     * transparent edge. Used for both sun core (bright white) and
     * sun glow (warm, larger, lower peak opacity).
     */
    const buildGlowTexture = (
      size: number,
      coreRadius: number,
      color: [number, number, number],
      peakAlpha: number,
    ): THREE.CanvasTexture => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('[VR sun] 2D canvas context unavailable')
      const mid = size / 2
      const grad = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid)
      grad.addColorStop(0, `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${peakAlpha})`)
      grad.addColorStop(coreRadius, `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${peakAlpha * 0.6})`)
      grad.addColorStop(coreRadius + 0.15, `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${peakAlpha * 0.15})`)
      grad.addColorStop(1, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0)`)
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, size, size)
      const tex = new THREE_.CanvasTexture(canvas)
      tex.colorSpace = THREE_.SRGBColorSpace
      return tex
    }

    // Core: small, bright, near-white. Additive blending so it reads
    // as emissive rather than a coloured disc.
    const coreTexture = buildGlowTexture(SUN_GLOW_TEXTURE_SIZE, 0.25, [255, 252, 230], 1.0)
    const coreMaterial = new THREE_.SpriteMaterial({
      map: coreTexture,
      blending: THREE_.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    })
    sunCoreSprite = new THREE_.Sprite(coreMaterial)
    sunCoreSprite.scale.set(SUN_CORE_SCALE, SUN_CORE_SCALE, 1)
    sunCoreSprite.renderOrder = -2 // behind HUD + globe, but atmosphere is additive so order only matters against opaques
    scene.add(sunCoreSprite)

    // Glow: larger, warmer, softer. Gives the sun a bloomy halo
    // without an actual post-process pass.
    const glowTexture = buildGlowTexture(SUN_GLOW_TEXTURE_SIZE, 0.1, [255, 220, 170], SUN_GLOW_OPACITY)
    const glowMaterial = new THREE_.SpriteMaterial({
      map: glowTexture,
      blending: THREE_.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    })
    sunGlowSprite = new THREE_.Sprite(glowMaterial)
    sunGlowSprite.scale.set(SUN_GLOW_SCALE, SUN_GLOW_SCALE, 1)
    sunGlowSprite.renderOrder = -3 // behind the core
    scene.add(sunGlowSprite)
  }

  // --- Cloud overlay ---
  // Slightly-larger translucent sphere above the Earth surface.
  // Loaded asynchronously from the shared cloud bucket (same URL
  // the 2D app uses); mesh only appears once the texture decodes
  // so the scene never shows an opaque white sphere placeholder.
  //
  // Direct port from earthMaterials.ts, including the luminance →
  // alpha preprocessing step: dense clouds stay opaque, thin
  // wisps see through to the ground. Gives a more atmospheric look
  // than a uniform-alpha wash would.
  //
  // Parented to the globe mesh so the clouds inherit globe
  // rotation (when the user grabs and spins the planet, clouds
  // spin with it — clouds are conceptually part of Earth, unlike
  // the atmosphere which stays fixed relative to the sun).
  let cloudMesh: THREE.Mesh | null = null
  /**
   * Desired cloud visibility — set by setTexture based on whether a
   * dataset is loaded. Tracked separately from cloudMesh.visible
   * because the cloud mesh is created asynchronously (after the
   * cloud texture loads) and setTexture can run before it exists;
   * the async loader applies this flag to the mesh on creation so
   * the "dataset loaded before clouds finished fetching" path
   * doesn't leave clouds inappropriately visible.
   */
  let cloudsShouldBeVisible = true
  ;(async () => {
    try {
      const img = await loadImage(getCloudTextureUrl())

      // Convert luminance channel to alpha on an offscreen canvas.
      // Result: solid white RGB, varying alpha based on brightness
      // of the source image (with gamma to boost contrast between
      // wisps and dense cloud cover).
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('[VR cloud] 2D canvas context unavailable')
      ctx.drawImage(img, 0, 0, img.width, img.height)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const data = imageData.data
      for (let i = 0; i < data.length; i += 4) {
        const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
        const alpha = Math.pow(lum, CLOUD_ALPHA_GAMMA)
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
        data[i + 3] = Math.round(alpha * 255)
      }
      ctx.putImageData(imageData, 0, 0)

      const cloudTexture = new THREE_.CanvasTexture(canvas)
      cloudTexture.colorSpace = THREE_.SRGBColorSpace

      const cloudGeometry = new THREE_.SphereGeometry(
        CLOUD_RADIUS, CLOUD_SEGMENTS, CLOUD_SEGMENTS,
      )
      const cloudMaterial = new THREE_.MeshPhongMaterial({
        map: cloudTexture,
        transparent: true,
        depthWrite: false,
        opacity: CLOUD_OPACITY,
      })

      // Shader patch: on the night side, darken the cloud diffuse
      // colour to near-black so city lights beneath remain visible
      // through the (now-dim) cloud layer. Same smoothstep pattern
      // as the Earth material's emissive gating, applied to the
      // diffuse map_fragment chunk instead.
      cloudMaterial.onBeforeCompile = (shader) => {
        shader.uniforms.uSunDir = sunDirUniform

        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `#include <common>
           uniform vec3 uSunDir;
           varying float vCloudNdotL;`,
        )
        shader.vertexShader = shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vec3 wN = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
           vCloudNdotL = dot(wN, uSunDir);`,
        )

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>
           varying float vCloudNdotL;`,
        )
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           float nightMask = smoothstep(0.0, -0.2, vCloudNdotL);
           diffuseColor.rgb *= mix(vec3(1.0), vec3(0.08), nightMask);`,
        )
      }

      cloudMesh = new THREE_.Mesh(cloudGeometry, cloudMaterial)
      // Apply the current desired visibility — a dataset may have
      // been loaded while this async fetch was in flight, in which
      // case the mesh needs to start hidden.
      cloudMesh.visible = cloudsShouldBeVisible
      // Child of the globe — inherits position, scale, AND rotation.
      // Rotation inheritance is intentional: clouds move with Earth's
      // surface rotation.
      globe.add(cloudMesh)
    } catch (err) {
      logger.warn('[VR] Cloud texture load failed; no cloud overlay:', err)
    }
  })()

  // --- Ground shadow ---
  // Subtle dark radial gradient on a horizontal plane below the
  // globe. Helps the globe feel spatially anchored — especially in
  // AR mode where there's no dark void to ground it visually.
  // Scales with globe scale each frame so a zoomed-in globe casts a
  // correspondingly larger shadow.
  const shadowCanvas = document.createElement('canvas')
  shadowCanvas.width = 256
  shadowCanvas.height = 256
  const shadowCtx = shadowCanvas.getContext('2d')
  if (shadowCtx) {
    const grad = shadowCtx.createRadialGradient(128, 128, 0, 128, 128, 128)
    grad.addColorStop(0, 'rgba(0, 0, 0, 0.55)')
    grad.addColorStop(0.35, 'rgba(0, 0, 0, 0.28)')
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
    shadowCtx.fillStyle = grad
    shadowCtx.fillRect(0, 0, 256, 256)
  }
  const shadowTexture = new THREE_.CanvasTexture(shadowCanvas)
  shadowTexture.colorSpace = THREE_.SRGBColorSpace
  shadowTexture.minFilter = THREE_.LinearFilter
  shadowTexture.magFilter = THREE_.LinearFilter

  const shadowMaterial = new THREE_.MeshBasicMaterial({
    map: shadowTexture,
    transparent: true,
    depthWrite: false, // shadow shouldn't occlude the globe or HUD
  })
  // Slightly larger than the globe's diameter so the shadow's soft
  // edges fall off well outside its silhouette.
  const shadowGeometry = new THREE_.PlaneGeometry(GLOBE_RADIUS * 3, GLOBE_RADIUS * 3)
  const shadow = new THREE_.Mesh(shadowGeometry, shadowMaterial)
  // Rotate flat (facing up, normal along +Y) and tuck just below the
  // globe's visible bottom. Inherits the globe's position so it
  // moves with it; scale is synced each frame in update().
  shadow.rotation.x = -Math.PI / 2
  shadow.position.set(
    GLOBE_POSITION.x,
    GLOBE_POSITION.y - GLOBE_RADIUS - 0.005,
    GLOBE_POSITION.z,
  )
  shadow.renderOrder = -1 // draw before everything else
  scene.add(shadow)

  // Current dataset texture + a key for change detection. The key
  // lets vrSession compare cheaply each frame and call setTexture
  // only when the dataset actually changed.
  let activeDatasetTexture: THREE.Texture | null = null
  /** Identity of the currently-loaded spec — element reference for change detection. */
  let activeKey: HTMLVideoElement | HTMLImageElement | null = null
  /**
   * Cleanup closure for pending video `seeked` / `playing`
   * listeners. Set when we attach the one-shot listeners that
   * promote the VideoTexture from placeholder to visible; cleared
   * when either listener fires OR when a new dataset takes over OR
   * on session dispose. Without this, a dataset swap or session
   * end before the HLS decoder produces its first frame would
   * leave two listeners attached to the shared `<video>` element
   * indefinitely (each subsequent enter/exit would stack more).
   */
  let cancelPendingVideoListeners: (() => void) | null = null

  /**
   * Base diffuse texture once the CDN fetch lands — kept so we can
   * restore it after a dataset texture is cleared. While CDN is
   * pending or failed, this stays null and `baseEarthTexture`
   * (the monochrome specular) is what `map` falls back to.
   */
  let baseDiffuseTexture: THREE.Texture | null = null
  /**
   * Night-lights emissive texture once the CDN fetch lands. Null
   * while pending or failed — in which case the day/night shader
   * patch reads an unbound sampler and the `#ifdef USE_EMISSIVEMAP`
   * guards keep the effect disabled.
   */
  let lightsTexture: THREE.Texture | null = null

  // --- Load CDN textures in the background ---
  // Diffuse replaces the monochrome fallback as `material.map`;
  // lights becomes `material.emissiveMap` and activates the
  // day/night shader path. Each texture loads independently so a
  // 404 on one doesn't prevent the other from applying.
  //
  // These URLs 404 gracefully if the bucket isn't populated — the
  // monochrome specular map remains visible and the code behaves
  // correctly regardless of hosting status.

  /**
   * Walk a list of resolution tiers in ascending order, upgrading
   * the texture as each tier lands. On a tier-404 or network error
   * we stop progression and keep whatever tier most recently
   * succeeded — so a missing 8K variant still gets you the 4K, and
   * a bucket that only has 2K still gets you 2K.
   *
   * `apply` is called with each tier's texture in turn. It's also
   * responsible for disposing any previously-applied texture of
   * the same kind so we don't leak GPU memory when upgrading.
   */
  async function loadProgressive(
    urls: string[],
    apply: (tex: THREE.Texture) => void,
    label: string,
  ): Promise<void> {
    for (const url of urls) {
      try {
        const img = await loadImage(url)
        const tex = new THREE_.Texture(img)
        tex.colorSpace = THREE_.SRGBColorSpace
        tex.needsUpdate = true
        apply(tex)
      } catch (err) {
        logger.warn(`[VR] ${label} tier ${url} failed — stopping progression:`, err)
        return
      }
    }
  }

  // Diffuse — 2K → 4K → 8K. Each tier replaces the previous;
  // previous texture disposed so GPU memory doesn't balloon.
  void loadProgressive(
    EARTH_DIFFUSE_URLS,
    tex => {
      // Swap only if no dataset has taken over during the fetch.
      if (activeKey !== null) {
        // Still hold on to the tier so we can restore it when the
        // dataset clears; the previous-tier reference is now
        // orphaned and should be disposed.
        baseDiffuseTexture?.dispose()
        baseDiffuseTexture = tex
        return
      }
      baseDiffuseTexture?.dispose()
      baseDiffuseTexture = tex
      material.map = tex
      material.needsUpdate = true
      // Upgrade any secondary globes that are still showing the base
      // Earth (no dataset loaded on their slot) — they were created
      // with whatever diffuse tier was available at the time.
      for (const sg of secondaries) {
        if (sg.activeKey === null) {
          sg.material.map = tex
          sg.material.needsUpdate = true
        }
      }
    },
    'earth diffuse',
  )

  // Lights — 2K → 4K → 8K, mirroring the diffuse tier list. The
  // 8K tier costs ~256 MB of GPU memory before mipmaps (chunky
  // for Quest 2) but the progressive loader degrades gracefully:
  // a failed 8K allocation leaves the 4K tier resident rather
  // than erroring. See EARTH_LIGHTS_URLS docstring for the full
  // rationale on why lights matches diffuse at full resolution.
  void loadProgressive(
    EARTH_LIGHTS_URLS,
    tex => {
      if (activeKey !== null) {
        lightsTexture?.dispose()
        lightsTexture = tex
        return
      }
      lightsTexture?.dispose()
      lightsTexture = tex
      material.emissiveMap = tex
      material.needsUpdate = true
    },
    'earth lights',
  )

  // --- Secondary globes (Phase 2.5 multi-globe support) ---
  // When panelCount > 1, additional globe meshes are created at
  // arc positions alongside the primary. Each secondary gets a
  // basic MeshPhongMaterial (no day/night shader patch, no
  // atmosphere, no clouds — those are primary-only decoration).
  // Secondary-to-primary promotion is handled by vrInteraction;
  // when the user taps a secondary, the caller swaps which slot
  // is "primary" in the 2D app's viewportManager, and the VR
  // scene rebuilds the arc on the next setPanelCount call.

  interface SecondaryGlobe {
    mesh: THREE.Mesh
    material: THREE.MeshPhongMaterial
    shadow: THREE.Mesh
    shadowGeom: THREE.PlaneGeometry
    shadowMat: THREE.MeshBasicMaterial
    activeKey: HTMLVideoElement | HTMLImageElement | null
    activeTexture: THREE.Texture | null
    cancelPendingVideoListeners: (() => void) | null
  }

  const secondaries: SecondaryGlobe[] = []

  /**
   * Compute world-space position for slot `i` in an arc of `total`
   * globes. Slot 0 is always centered when total=1. For total=2+,
   * globes fan out horizontally with ~1.2m spacing center-to-center
   * (0.2m gap between 0.5m-radius spheres). All sit at the same
   * distance from the user (same Z), same height (same Y).
   */
  function arcPosition(i: number, total: number): { x: number; y: number; z: number } {
    if (total <= 1) return GLOBE_POSITION
    // Spread evenly around the center, each 1.2m apart
    const spacing = GLOBE_RADIUS * 2 + 0.2
    const totalWidth = (total - 1) * spacing
    const x = GLOBE_POSITION.x - totalWidth / 2 + i * spacing
    return { x, y: GLOBE_POSITION.y, z: GLOBE_POSITION.z }
  }

  /** Build a simple secondary globe — basic Phong, no shader patches. */
  function createSecondaryGlobe(): SecondaryGlobe {
    const mat = new THREE_.MeshPhongMaterial({
      map: baseDiffuseTexture ?? baseEarthTexture,
      specular: new THREE_.Color(0x444444),
      shininess: 30,
    })
    const mesh = new THREE_.Mesh(
      new THREE_.SphereGeometry(GLOBE_RADIUS, 64, 64),
      mat,
    )
    scene.add(mesh)

    // Per-secondary ground shadow (same construction as primary's)
    const sMat = new THREE_.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      depthWrite: false,
    })
    const sGeom = new THREE_.PlaneGeometry(GLOBE_RADIUS * 3, GLOBE_RADIUS * 3)
    const sMesh = new THREE_.Mesh(sGeom, sMat)
    sMesh.rotation.x = -Math.PI / 2
    sMesh.renderOrder = -1
    scene.add(sMesh)

    return {
      mesh,
      material: mat,
      shadow: sMesh,
      shadowGeom: sGeom,
      shadowMat: sMat,
      activeKey: null,
      activeTexture: null,
      cancelPendingVideoListeners: null,
    }
  }

  /** Dispose a secondary globe's GPU resources and remove from scene. */
  function disposeSecondary(sg: SecondaryGlobe): void {
    if (sg.cancelPendingVideoListeners) sg.cancelPendingVideoListeners()
    if (sg.activeTexture) sg.activeTexture.dispose()
    sg.material.dispose()
    ;(sg.mesh.geometry as THREE.BufferGeometry).dispose()
    scene.remove(sg.mesh)
    sg.shadowMat.dispose()
    sg.shadowGeom.dispose()
    scene.remove(sg.shadow)
  }

  /**
   * Reposition all globes (primary + secondaries) according to the
   * arc layout. Called when panel count changes or when we need the
   * positions refreshed. After the initial placement, secondaries
   * track the primary via `syncSecondaryPositions()` each frame —
   * this function only runs on panel-count changes.
   */
  function layoutArc(): void {
    const total = 1 + secondaries.length
    const pos0 = arcPosition(0, total)
    globe.position.set(pos0.x, pos0.y, pos0.z)
    for (let i = 0; i < secondaries.length; i++) {
      const pos = arcPosition(i + 1, total)
      secondaries[i].mesh.position.set(pos.x, pos.y, pos.z)
    }
  }

  /**
   * Reposition secondaries relative to the primary's current
   * position. When the primary moves (user placed the globe on an
   * AR surface, or an anchor-pose sync wrote into globe.position),
   * the arc must translate with it so the whole layout stays in
   * view together. Called every frame from update().
   *
   * Offset = arc-slot-(i+1) − arc-slot-0 in the nominal layout
   * (both read from GLOBE_POSITION-relative coords). Scaled by the
   * primary's uniform scale so pinch-zoomed globes widen/narrow
   * their inter-globe gap to match.
   */
  const syncSecondaryPositionsScratch = new THREE_.Vector3()
  function syncSecondaryPositions(): void {
    if (secondaries.length === 0) return
    const total = 1 + secondaries.length
    const pos0 = arcPosition(0, total)
    const s = globe.scale.x
    for (let i = 0; i < secondaries.length; i++) {
      const pos = arcPosition(i + 1, total)
      syncSecondaryPositionsScratch.set(
        (pos.x - pos0.x) * s,
        (pos.y - pos0.y) * s,
        (pos.z - pos0.z) * s,
      )
      syncSecondaryPositionsScratch.add(globe.position)
      secondaries[i].mesh.position.copy(syncSecondaryPositionsScratch)
    }
  }

  return {
    scene,
    globe,
    get allGlobes() {
      return [globe, ...secondaries.map(s => s.mesh)]
    },

    setPanelCount(count) {
      const desired = Math.max(1, Math.min(4, count))
      const neededSecondaries = desired - 1
      // Add secondaries if we need more
      while (secondaries.length < neededSecondaries) {
        secondaries.push(createSecondaryGlobe())
      }
      // Remove extras if we need fewer
      while (secondaries.length > neededSecondaries) {
        const sg = secondaries.pop()!
        disposeSecondary(sg)
      }
      // Reposition everyone in the arc layout
      layoutArc()
    },

    setSlotTexture(slot, spec, onReady) {
      if (slot === 0) {
        // Primary — full photoreal treatment via the existing path
        this.setTexture(spec, onReady)
        return
      }
      const sgIdx = slot - 1
      if (sgIdx >= secondaries.length) {
        onReady?.()
        return
      }
      const sg = secondaries[sgIdx]

      // Change detection — same idempotency as primary
      const nextKey = spec?.kind === 'video' ? spec.element : spec?.kind === 'image' ? spec.element : null
      if (nextKey === sg.activeKey) {
        onReady?.()
        return
      }
      // Cancel any pending video listeners from the previous spec
      if (sg.cancelPendingVideoListeners) {
        sg.cancelPendingVideoListeners()
        sg.cancelPendingVideoListeners = null
      }
      if (sg.activeTexture) {
        sg.activeTexture.dispose()
        sg.activeTexture = null
      }

      if (!spec) {
        sg.material.map = baseDiffuseTexture ?? baseEarthTexture
        sg.activeKey = null
        sg.material.needsUpdate = true
        onReady?.()
      } else if (spec.kind === 'video') {
        sg.activeKey = spec.element
        try { spec.element.currentTime = spec.element.currentTime } catch { /* no-op */ }
        const tex = new THREE_.VideoTexture(spec.element)
        tex.colorSpace = THREE_.SRGBColorSpace
        tex.minFilter = THREE_.LinearFilter
        tex.magFilter = THREE_.LinearFilter
        sg.activeTexture = tex
        if (spec.element.readyState >= 2) {
          sg.material.map = tex
          sg.material.needsUpdate = true
          onReady?.()
        } else {
          sg.material.map = baseDiffuseTexture ?? baseEarthTexture
          const onFrame = () => {
            sg.cancelPendingVideoListeners = null
            if (sg.activeKey !== spec.element) return
            sg.material.map = tex
            sg.material.needsUpdate = true
            onReady?.()
          }
          spec.element.addEventListener('seeked', onFrame, { once: true })
          spec.element.addEventListener('playing', onFrame, { once: true })
          sg.cancelPendingVideoListeners = () => {
            spec.element.removeEventListener('seeked', onFrame)
            spec.element.removeEventListener('playing', onFrame)
          }
        }
      } else if (spec.kind === 'image') {
        const tex = new THREE_.Texture(spec.element)
        tex.colorSpace = THREE_.SRGBColorSpace
        tex.minFilter = THREE_.LinearFilter
        tex.magFilter = THREE_.LinearFilter
        tex.needsUpdate = true
        sg.activeTexture = tex
        sg.material.map = tex
        sg.activeKey = spec.element
        sg.material.needsUpdate = true
        onReady?.()
      }
    },

    setTexture(spec, onReady) {
      // Skip texture-swap work if the spec is unchanged — repeated
      // polls from the session loop are a no-op in the steady state.
      // BUT still fire onReady: the caller (vrSession) is waiting
      // for the "texture is live and visible" signal to trigger its
      // loading-scene fade-out, and for the initial null → null
      // case (user enters VR with no dataset loaded in 2D) the
      // state transition is trivial but the caller still needs to
      // hear that readiness is achieved. Callers dedupe via their
      // own "already fired" flag so firing on every no-op is
      // harmless.
      const nextKey = spec?.kind === 'video' ? spec.element : spec?.kind === 'image' ? spec.element : null
      if (nextKey === activeKey) {
        onReady?.()
        return
      }

      // Dispose any previously-loaded dataset texture. VideoTexture
      // holds a reference to the source <video> element and an
      // internal update scheduler; image Textures own a GPU buffer.
      if (activeDatasetTexture) {
        activeDatasetTexture.dispose()
        activeDatasetTexture = null
      }

      // Cancel any pending video-frame-wait listeners from a
      // previous spec. If the previous video's `seeked`/`playing`
      // event never fired (decode still in progress), those
      // listeners would otherwise leak on the shared <video>
      // element and accumulate across session entries.
      if (cancelPendingVideoListeners) {
        cancelPendingVideoListeners()
        cancelPendingVideoListeners = null
      }

      if (!spec) {
        // Restore the full photoreal Earth stack — diffuse if CDN
        // loaded, specular fallback otherwise; specular ocean glint;
        // night-lights emissive gated by the day/night shader;
        // clouds + atmosphere rim. Anything the user sees while no
        // dataset is loaded is "Earth as a planet". Dataset-loaded
        // branches below hide these layers so scientific
        // visualisations aren't obscured.
        material.map = baseDiffuseTexture ?? baseEarthTexture
        material.emissiveMap = lightsTexture
        material.emissive.setHex(0xffffff)
        material.specularMap = specularMapTexture
        material.specular.setHex(0xaaaaaa)
        cloudsShouldBeVisible = true
        if (cloudMesh) cloudMesh.visible = true
        atmosphereInner.visible = true
        atmosphereOuter.visible = true
        // Planet mode: directional sun for hemisphere lighting +
        // base ambient for shadow fill.
        sunLight.intensity = 1.8
        datasetAmbient.intensity = 0
        activeKey = null
        // No dataset to wait for — readiness is immediate.
        onReady?.()
      } else if (spec.kind === 'video') {
        const video = spec.element
        activeKey = video

        // Dataset loaded — hide Earth-specific decoration so the
        // data isn't obscured:
        //   - Night-lights emissive (would bleed additively onto
        //     the dataset's dark regions).
        //   - Specular ocean glint (would add bright highlights
        //     only over ocean areas of the dataset, creating
        //     uneven lighting that looks like an artifact).
        //   - Cloud overlay (covers surface features the dataset
        //     is trying to show).
        //   - Atmosphere rim glow + sunset terminator (distracting
        //     around scientific-viz colours).
        material.emissiveMap = null
        material.emissive.setHex(0x000000)
        material.specularMap = null
        material.specular.setHex(0x000000)
        cloudsShouldBeVisible = false
        if (cloudMesh) cloudMesh.visible = false
        atmosphereInner.visible = false
        atmosphereOuter.visible = false
        // Dataset mode: kill directional sun so both hemispheres
        // are uniformly lit; boost ambient so data reads evenly.
        sunLight.intensity = 0
        datasetAmbient.intensity = 1.6

        // Force the decoder to produce a frame at the current
        // position. Without this, paused HLS streams may have no
        // decoded frame available and VideoTexture reads as black.
        try { video.currentTime = video.currentTime } catch { /* no-op */ }

        const tex = new THREE_.VideoTexture(video)
        tex.colorSpace = THREE_.SRGBColorSpace
        tex.minFilter = THREE_.LinearFilter
        tex.magFilter = THREE_.LinearFilter
        activeDatasetTexture = tex

        if (video.readyState >= 2) {
          // Frame already decoded — swap immediately and signal ready.
          material.map = tex
          onReady?.()
        } else {
          // No frame yet — keep the base Earth visible instead of
          // showing a black ball. Swap in the VideoTexture as soon
          // as the forced seek decodes a frame or the user presses
          // play (whichever fires first). { once: true } ensures
          // each listener self-removes after firing; we ALSO
          // track a manual cleanup so a dataset swap / dispose
          // before either event fires doesn't leak the listeners.
          material.map = baseEarthTexture
          const onFrame = () => {
            // One fired and self-removed; clear our tracker so the
            // other (which may still be attached) isn't touched by
            // a later cancel call.
            cancelPendingVideoListeners = null
            // Guard: dataset may have changed while we waited.
            if (activeKey !== video) return
            material.map = tex
            material.needsUpdate = true
            onReady?.()
          }
          video.addEventListener('seeked', onFrame, { once: true })
          video.addEventListener('playing', onFrame, { once: true })
          cancelPendingVideoListeners = () => {
            video.removeEventListener('seeked', onFrame)
            video.removeEventListener('playing', onFrame)
          }
        }
      } else if (spec.kind === 'image') {
        // The 2D loader already decoded this image (including the
        // resolution-fallback dance), so we wrap the live
        // HTMLImageElement directly — no re-fetch, no async.
        const tex = new THREE_.Texture(spec.element)
        tex.colorSpace = THREE_.SRGBColorSpace
        tex.minFilter = THREE_.LinearFilter
        tex.magFilter = THREE_.LinearFilter
        tex.needsUpdate = true
        activeDatasetTexture = tex
        // Hide the full Earth-specific decoration stack when a
        // dataset takes over the surface — same rationale as the
        // video branch. Keep the docstring there as the reference.
        material.emissiveMap = null
        material.emissive.setHex(0x000000)
        material.specularMap = null
        material.specular.setHex(0x000000)
        cloudsShouldBeVisible = false
        if (cloudMesh) cloudMesh.visible = false
        atmosphereInner.visible = false
        atmosphereOuter.visible = false
        sunLight.intensity = 0
        datasetAmbient.intensity = 1.6
        material.map = tex
        activeKey = spec.element
        onReady?.()
      }
      material.needsUpdate = true
    },

    update() {
      // Mirror globe zoom to the shadow plane so a zoomed-in globe
      // casts a bigger shadow. Only X/Z scale — Y is the plane's
      // normal axis and doesn't matter after the 90° rotation.
      shadow.scale.x = globe.scale.x
      shadow.scale.y = globe.scale.x
      // Shadow follows the globe's world position — without this
      // sync the shadow stays at the original GLOBE_POSITION when
      // the user places the globe on a real surface in AR. Y
      // offset is scale-aware so the shadow sits just under the
      // visible bottom at any zoom level.
      shadow.position.set(
        globe.position.x,
        globe.position.y - GLOBE_RADIUS * globe.scale.x - 0.005,
        globe.position.z,
      )

      // Atmosphere shells follow the globe's position + uniform
      // scale but deliberately NOT its rotation — the atmosphere
      // doesn't spin with the planet's surface (the user's grab
      // rotation is an abstraction of Earth rotating under a
      // fixed sun, not of the sky rotating with the ground).
      atmosphereInner.position.copy(globe.position)
      atmosphereOuter.position.copy(globe.position)
      atmosphereInner.scale.copy(globe.scale)
      atmosphereOuter.scale.copy(globe.scale)

      // Refresh the subsolar point on a throttle — it changes
      // ~0.25°/min, so recomputing every 2 s is more than fast
      // enough. Gets us out of the per-frame `new Date()` + trig
      // allocations while still keeping the day/night terminator
      // current as the user lingers in VR.
      const nowMs = performance.now()
      if (nowMs - lastSunUpdateMs > SUN_UPDATE_INTERVAL_MS) {
        lastSunUpdateMs = nowMs
        const { lat, lng } = getSunPosition(new Date())
        sunDirectionFromLatLng(THREE_, lat, lng, sunLocalDirCache)
      }

      // Critically: after storing the sun direction in the globe's
      // LOCAL frame (geographic convention — a fixed direction
      // relative to the Earth's surface for a given UTC), we apply
      // the globe's current world-space quaternion to get the
      // sun's WORLD-SPACE direction each frame. This means when the
      // user grab-rotates the globe, the sun ROTATES WITH IT —
      // rather than the globe spinning under a fixed sun.
      //
      // Why this matters: a fixed-in-world sun made grab-rotate feel
      // like scrubbing time (different longitudes moved through the
      // static terminator). Rotating the sun with the globe makes
      // grab-rotate feel like orbiting the Earth-Sun system from a
      // different viewing angle — the terminator stays at the
      // correct real-world longitudes and you can literally "spin
      // the sun into view" by rotating the globe. Time stays
      // current and constant; only the user's viewing angle changes.
      sunDirScratch.copy(sunLocalDirCache).applyQuaternion(globe.quaternion)
      sunDirUniform.value.copy(sunDirScratch)
      // DirectionalLight convention: light shines FROM its position
      // TOWARD the origin. Place it along the sun direction at some
      // distance so shading matches the shader's uSunDir.
      sunLight.position.copy(sunDirScratch).multiplyScalar(10)

      // Sun sprite + glow. Positioned at `globe.position + sunDir *
      // SUN_DISTANCE` so the sun tracks the real subsolar direction
      // AND rotates when the user grab-rotates the globe AND
      // translates when the globe is placed on a real surface.
      if (sunCoreSprite && sunGlowSprite) {
        sunWorldPosScratch
          .copy(sunDirScratch)
          .multiplyScalar(SUN_DISTANCE)
          .add(globe.position)
        sunCoreSprite.position.copy(sunWorldPosScratch)
        sunGlowSprite.position.copy(sunWorldPosScratch)
      }

      // Secondary globes: position tracks the primary (critical in
      // AR — when the user anchors the primary to a real surface,
      // the secondaries must translate with it), rotation + scale
      // mirror the primary so all globes spin in tandem and
      // pinch-zoom together. SOS datasets share the same geographic
      // projection, so locked quaternions keep corresponding lat/lng
      // lines aligned across the arc.
      syncSecondaryPositions()
      for (const sg of secondaries) {
        sg.mesh.quaternion.copy(globe.quaternion)
        sg.mesh.scale.copy(globe.scale)
        const s = sg.mesh.scale.x
        sg.shadow.scale.set(s, s, 1)
        sg.shadow.position.set(
          sg.mesh.position.x,
          sg.mesh.position.y - GLOBE_RADIUS * s - 0.005,
          sg.mesh.position.z,
        )
      }
    },

    dispose() {
      // Remove any pending video-frame-wait listeners (session may
      // end before seeked/playing fires on a paused HLS stream).
      if (cancelPendingVideoListeners) {
        cancelPendingVideoListeners()
        cancelPendingVideoListeners = null
      }
      if (activeDatasetTexture) {
        activeDatasetTexture.dispose()
        activeDatasetTexture = null
        activeKey = null
      }
      baseEarthTexture.dispose()
      specularMapTexture.dispose()
      baseDiffuseTexture?.dispose()
      lightsTexture?.dispose()
      material.dispose()
      geometry.dispose()
      scene.remove(globe)
      if (cloudMesh) {
        // Clouds are a child of globe, so removing globe from scene
        // already pulled them out of the render graph — but we still
        // need to free their GPU resources explicitly.
        ;(cloudMesh.geometry as THREE.BufferGeometry).dispose()
        const cloudMat = cloudMesh.material as THREE.MeshPhongMaterial
        cloudMat.map?.dispose()
        cloudMat.dispose()
        globe.remove(cloudMesh)
        cloudMesh = null
      }
      scene.remove(atmosphereInner)
      scene.remove(atmosphereOuter)
      atmosphereInnerGeometry.dispose()
      atmosphereInnerMaterial.dispose()
      atmosphereOuterGeometry.dispose()
      atmosphereOuterMaterial.dispose()
      if (sunCoreSprite) {
        scene.remove(sunCoreSprite)
        const mat = sunCoreSprite.material as THREE.SpriteMaterial
        mat.map?.dispose()
        mat.dispose()
      }
      if (sunGlowSprite) {
        scene.remove(sunGlowSprite)
        const mat = sunGlowSprite.material as THREE.SpriteMaterial
        mat.map?.dispose()
        mat.dispose()
      }
      scene.remove(shadow)
      shadowGeometry.dispose()
      shadowMaterial.dispose()
      shadowTexture.dispose()
      // Dispose all secondary globes.
      for (const sg of secondaries) {
        disposeSecondary(sg)
      }
      secondaries.length = 0
    },
  }
}
