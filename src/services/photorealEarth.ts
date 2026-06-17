/**
 * Photorealistic Earth — extracted from `vrScene.ts` so the same stack
 * can be reused outside VR (the Orbit-character standalone page is the
 * first reuse site; main-app embed is plausible later).
 *
 * The stack:
 *   - Diffuse day Earth (CDN, progressive 2K → 4K → 8K) over a
 *     monochrome specular fallback that's also reused as the specular
 *     map for ocean glint.
 *   - Emissive night-lights map (CDN, progressive 2K → 4K → 8K)
 *     gated to the dark hemisphere via a smoothstep over the sun
 *     direction, ported from the pre-MapLibre `earthMaterials.ts`.
 *   - Two concentric atmosphere shells: inner FrontSide for sunset
 *     warmth + Rayleigh in-scattering, outer BackSide for fresnel
 *     halo with a Rayleigh+Mie phase mix. Both share `uSunDir`.
 *   - Translucent cloud overlay parented to the globe (so it spins
 *     with the surface) with a luminance→alpha preprocessing step
 *     and a day/night shader patch that dims clouds on the night
 *     side so city lights remain visible underneath.
 *   - Sun sprite: bright core + softer warm halo, billboarded at
 *     `globe.position + sunDir * sunDistance`.
 *   - Ground shadow: dark radial gradient on a horizontal plane just
 *     below the globe.
 *
 * Each piece is independently optional via {@link PhotorealEarthOptions}.
 * Orbit's standalone scene drops the ground shadow (its composition
 * has multiple Earth sizes at non-zero positions, a single shadow
 * plane doesn't help) but keeps the rest. The full VR view keeps
 * everything.
 *
 * Day/night shading depends on TWO things lining up: the `uSunDir`
 * uniform, AND a `DirectionalLight` whose direction matches. When
 * `includeLighting` is true (default) the handle owns both — they
 * ride along in `addTo(scene)` and `update()` keeps them in sync.
 * Set `includeLighting: false` only if you arrange to drive a
 * matching light yourself; otherwise the lit hemisphere and the
 * night-lights gating will disagree and the terminator looks broken.
 */

import type * as THREE from 'three'
import { getSunPosition } from '../utils/time'
import { getCloudTextureUrl, isMobile } from '../utils/deviceCapability'
import { logger } from '../utils/logger'
import type { DatasetOverlayOptions } from '../types'
import { isEarthBody } from './datasetOverlayOptions'
import {
  ATMOSPHERE_GLSL_CONSTANTS,
  ATMOSPHERE_GLSL_DENSITY,
  ATMOSPHERE_GLSL_PHASE,
  ATMOSPHERE_GLSL_INTERSECT,
  ATMOSPHERE_GLSL_TONEMAP,
  ATMOSPHERE_STEPS_HIGH,
  ATMOSPHERE_STEPS_MOBILE,
  ATMOSPHERE_RADIUS_FACTOR,
  PLANET_RADIUS_KM,
  buildAtmosphereRaymarchGlsl,
} from './atmosphereConstants'
import { computeTransmittanceLut } from './atmosphereLut'
import {
  getShaderSettings,
  onShaderSettingsChange,
} from './shaderSettingsService'
import { EARTH_ASSET_BASE } from '../config/endpoints'

/** Default radius if `options.radius` is omitted — matches the VR view. */
const DEFAULT_RADIUS = 0.5

/**
 * Default position. Local-floor places `y=0` at the user's standing
 * floor, so `y=1.3` is roughly eye-height for a seated user. `z=-1.5`
 * puts the globe about arm's-length ahead of them — matches the VR
 * view defaults.
 */
const DEFAULT_POSITION = { x: 0, y: 1.3, z: -1.5 } as const

/**
 * Fallback Earth texture — monochrome specular map shipped with the
 * repo. Used as the initial `material.map` while the full diffuse
 * loads from the CDN, and as a permanent fallback if the CDN fetch
 * fails. Also serves as the specular map regardless.
 */
const BASE_EARTH_TEXTURE_URL = '/assets/Earth_Specular_2K.jpg'

/**
 * External CDN URLs for the full Earth day/night textures, in
 * progressive-enhancement tiers.
 *
 * Hosted on a CloudFront distribution (not Git LFS). The previous
 * `Earth_Diffuse_6K.jpg` asset was deliberately removed from LFS in
 * commit `34167f2` when the zyra-project account hit 9 GB / 10 GB
 * LFS bandwidth/month. CloudFront keeps that problem from recurring
 * and gives better edge-cached latency than S3 direct.
 *
 * Progressive strategy:
 *   1. 2K loads first (~500 ms on a good connection) → fast first
 *      render. Arm's-length viewing is visually indistinguishable
 *      from higher tiers at the Quest's ~40° globe FOV.
 *   2. 4K then replaces it in the background (~2-3 s) → crisp
 *      enough for moderate lean-in / zoom.
 *   3. 8K replaces 4K (~5-10 s) → the "lean in and count the
 *      coastlines" tier.
 *
 * Automatic mipmap generation (Three.js default for power-of-two
 * textures) means higher tiers don't hurt distant-view quality.
 *
 * If any tier URL 404s or fails to allocate, progression stops at
 * the previous tier and the visible texture stays at the highest
 * tier that succeeded.
 */
// Resolved from `VITE_EARTH_ASSET_BASE` (see src/config/endpoints.ts)
// so a fork can serve the basemap textures from its own host.
const EARTH_TEXTURE_BASE = EARTH_ASSET_BASE
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
// §7.2 normal-map tiers — mirrors the 2D earthTileLayer ladder
// (NORMAL_MAP_URLS there) and the diffuse / lights pattern above.
// Same CloudFront-fronted bucket, ascending order; loadProgressive
// halts at the first failure and the last successful tier stays
// applied. MeshPhongMaterial has a built-in `normalMap` slot, so
// nothing about the shader patch needs to change — only the
// material binding + `normalScale` driven by shaderSettingsService.
const EARTH_NORMAL_URLS = [
  `${EARTH_TEXTURE_BASE}/earth_normal_2048.jpg`,
  `${EARTH_TEXTURE_BASE}/earth_normal_4096.jpg`,
  `${EARTH_TEXTURE_BASE}/earth_normal_8192.jpg`,
]

const EARTH_SHININESS = 40
const NIGHT_LIGHT_STRENGTH = 0.5

/**
 * Atmosphere shell tessellation. Single shell at
 * `ATMOSPHERE_RADIUS_FACTOR` (≈ 1.0157) — matches the geometric
 * atmosphere ceiling so the shell's silhouette is the limb of the
 * atmosphere proper.
 */
const ATMOSPHERE_SEGMENTS = 64

/**
 * Multiplier applied to the ACES-tonemapped scattered colour
 * before composition. The shared `SUN_INTENSITY` sets the article-
 * style baseline; this is a per-renderer fine-tune for the
 * specific scene exposure (background brightness, other shader
 * outputs) the Three.js Earth lives in. Mirrors
 * `ATMOSPHERE_INTENSITY` in `earthTileLayer.ts`.
 */
const ATMOSPHERE_INTENSITY = 1.0

/**
 * Sun distance as a multiple of globe radius. At the VR default
 * (radius 0.5), this gives 10 — matches the original. At Orbit's
 * planetary preset (radius 4.0) it gives 80, keeping the sun
 * visually proportional to the planet.
 */
const SUN_DISTANCE_FACTOR = 20
/**
 * Sun sprite scales, expressed as fractions of `sunDistance` so the
 * sun's angular size stays constant regardless of how big the planet
 * (and therefore how far the sun) is. At VR defaults: core ≈ 1.7°
 * (readable as "a sun"), glow halo ≈ 8.5° (a soft bloom).
 */
const SUN_CORE_FRACTION = 0.03
const SUN_GLOW_FRACTION = 0.15
const SUN_GLOW_OPACITY = 0.4
const SUN_GLOW_TEXTURE_SIZE = 256

/**
 * How often to recompute the subsolar point (via `getSunPosition`).
 * The sun moves ~0.25° per minute in longitude; 2 seconds = 0.008°,
 * imperceptible. Per-frame would also allocate a new `Date` — avoid.
 */
const SUN_UPDATE_INTERVAL_MS = 2000

/** Cloud sphere radius as a multiple of globe radius. */
const CLOUD_FACTOR = 1.005
const CLOUD_SEGMENTS = 64
const CLOUD_OPACITY = 0.9
/**
 * Gamma exponent applied when converting luminance → alpha during
 * cloud texture preprocessing. Keeps thin wisps more transparent
 * than dense formations — feels more atmospheric than a uniform-alpha
 * wash.
 */
const CLOUD_ALPHA_GAMMA = 0.55

/**
 * Convert geographic lat/lng (degrees) into a world-space unit
 * direction. Matches the convention from the old
 * `EarthMaterials.setSun()` — note the negated Z so the result lines
 * up with Three.js `SphereGeometry`'s default equirectangular UV wrap.
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
 * Surface texture spec. Matches the 2D dataset model: image datasets
 * are pre-decoded `HTMLImageElement`s, video datasets stream through
 * HLS into an `HTMLVideoElement`. Null falls back to the photoreal
 * Earth stack.
 *
 * `options` carries the same Phase 3d metadata
 * (`boundingBox` / `lonOrigin` / `isFlippedInY` / `celestialBody`)
 * that the 2D renderer uses for bbox projection + non-Earth gating.
 * When absent (or when every field is at its default), the VR
 * renderer takes the legacy path: dataset texture wraps the full
 * sphere equirectangularly, all Earth decoration hides. Phase 3h
 * uses these to clip the texture to a bbox and reveal an Earth
 * base diffuse outside.
 */
export type VrDatasetTexture =
  | {
      readonly kind: 'video'
      readonly element: HTMLVideoElement
      readonly options?: DatasetOverlayOptions
    }
  | {
      readonly kind: 'image'
      /** A decoded image source. Usually an `HTMLImageElement` (the
       *  2D loader's decoded dataset image), but also accepts a
       *  `HTMLCanvasElement` / `ImageBitmap` — e.g. a frame grabbed
       *  from the dataset's video by the globe-thumbnail generator.
       *  All are valid `THREE.Texture` sources. */
      readonly element: HTMLImageElement | HTMLCanvasElement | ImageBitmap
      readonly options?: DatasetOverlayOptions
    }

export interface PhotorealEarthOptions {
  /** Globe radius in world units. Default 0.5 (VR view default). */
  readonly radius?: number
  /** Globe position in world units. Default (0, 1.3, -1.5). */
  readonly position?: { readonly x: number; readonly y: number; readonly z: number }
  /**
   * Include an ambient + directional sun light. Default true. The
   * directional light's position is updated each frame so its
   * direction matches `uSunDir`. Set false ONLY if you arrange a
   * matching light yourself; otherwise the day side and the
   * night-lights gating will disagree.
   */
  readonly includeLighting?: boolean
  /** Include the two atmosphere shells. Default true. */
  readonly includeAtmosphere?: boolean
  /** Include the cloud overlay (loaded async). Default true. */
  readonly includeClouds?: boolean
  /** Include the sun sprite (core + glow). Default true. */
  readonly includeSun?: boolean
  /** Include a ground shadow plane below the globe. Default true. */
  readonly includeShadow?: boolean
}

export interface PhotorealEarthHandle {
  /**
   * The globe mesh. Caller can rotate / scale / reposition this; the
   * stack tracks position+scale via `update()`. Cloud overlay is
   * parented to it (so spin propagates), atmosphere shells are not
   * (atmosphere shouldn't spin with the surface).
   */
  readonly globe: THREE.Mesh
  /**
   * Current base diffuse tier. Null until the first progressive CDN
   * tier (2K) lands; upgrades to 4K and then 8K in the background.
   * Exposed so multi-globe callers (the VR scene's secondary globes)
   * can share the same Earth tile as the primary without
   * re-fetching — `material.map = handle.baseDiffuseTexture ??
   * handle.baseEarthTexture`, plus an `onBaseDiffuseChange`
   * subscription to pick up tier upgrades.
   */
  readonly baseDiffuseTexture: THREE.Texture | null
  /**
   * Monochrome specular texture shipped with the repo. Stable
   * reference — returned same object every access. Used as the
   * fallback when `baseDiffuseTexture` is still null (first tier
   * not yet loaded, or all tiers 404'd).
   */
  readonly baseEarthTexture: THREE.Texture
  /**
   * Subscribe to diffuse-tier upgrades. Fires when the progressive
   * CDN loader lands a new tier (2K → 4K → 8K). Lets secondary
   * globes track the primary's tier without running their own
   * loader. Returns an unsubscribe function; the handle itself
   * disposes all subscriptions on `dispose()`.
   */
  onBaseDiffuseChange(callback: (tex: THREE.Texture) => void): () => void
  /**
   * Add every owned object — globe, atmospheres, sun, shadow, lights —
   * to the supplied scene. Cloud mesh attaches itself to `globe`
   * (which is in this list) once its async texture finishes loading.
   */
  addTo(scene: THREE.Scene): void
  /** Remove every owned object from the scene. Pair with addTo. */
  removeFrom(scene: THREE.Scene): void
  /**
   * Swap the globe surface texture. Pass `null` to revert to the
   * full photoreal Earth stack; `{ kind: 'video' }` to stream from
   * an HTMLVideoElement; or `{ kind: 'image', element }` to use an
   * already-decoded HTMLImageElement.
   *
   * When a dataset is loaded, all Earth-specific decoration (specular
   * glint, night lights, clouds, atmosphere) is hidden so the data
   * reads uniformly across the sphere.
   *
   * Idempotent — repeated calls with an unchanged spec are no-ops
   * but still fire `onReady` so callers waiting for the "live and
   * visible" signal can dedupe via their own flag.
   */
  setTexture(spec: VrDatasetTexture | null, onReady?: () => void): void
  /**
   * Current subsolar unit direction in world space — a reference to
   * the internal uniform's Vector3, refreshed by `update()` every
   * ~SUN_UPDATE_INTERVAL_MS to match the real UTC subsolar point.
   * Callers can read it to drive their own sun-aligned shading
   * (e.g. Orbit's key light direction + glass-dome specular
   * streak). Returned object is stable across calls; values are
   * mutated in place each update.
   */
  readonly sunDir: THREE.Vector3
  /**
   * Per-frame update — refreshes sun direction (throttled to
   * SUN_UPDATE_INTERVAL_MS), syncs atmosphere/shadow position+scale
   * to the globe, repositions the sun sprite + sun light. Cheap;
   * safe to call every frame.
   */
  update(): void
  /** Free GPU resources. Caller is responsible for `removeFrom(scene)` first. */
  dispose(): void
}

/**
 * Build the photoreal Earth stack. Returns a handle the caller wires
 * into a Three.js scene and drives per frame. Takes the already-
 * imported Three.js module so the lazy-loading decision lives at the
 * call site (the VR session imports it dynamically; the Orbit page
 * imports it statically).
 */
export function createPhotorealEarth(
  THREE_: typeof THREE,
  options: PhotorealEarthOptions = {},
): PhotorealEarthHandle {
  const radius = options.radius ?? DEFAULT_RADIUS
  const position = options.position ?? DEFAULT_POSITION
  const includeLighting = options.includeLighting ?? true
  const includeAtmosphere = options.includeAtmosphere ?? true
  const includeClouds = options.includeClouds ?? true
  const includeSun = options.includeSun ?? true
  const includeShadow = options.includeShadow ?? true

  const sunDistance = radius * SUN_DISTANCE_FACTOR
  const sunCoreScale = sunDistance * SUN_CORE_FRACTION
  const sunGlowScale = sunDistance * SUN_GLOW_FRACTION

  // Top-level objects that need scene parenting. Cloud mesh is
  // intentionally NOT in here — it parents to `globe` once its async
  // load resolves, and inherits via Three.js's parent chain.
  const objects: THREE.Object3D[] = []

  /**
   * Flipped by `dispose()` so in-flight async loaders (cloud texture
   * fetch, progressive diffuse/lights tiers) don't leak GPU
   * resources or mutate a teardown scene if the handle is disposed
   * before the network call lands. Every post-await code path
   * checks this and disposes anything it just created when set.
   */
  let disposed = false

  // ── Lighting ──────────────────────────────────────────────────────
  // Two modes, toggled by setTexture:
  //
  //   Planet mode (no dataset) — directional `sunLight` casts
  //     hemisphere shading and drives the day/night terminator
  //     matching real UTC time; `datasetAmbient` is off.
  //   Dataset mode — `sunLight` turns off so scientific-viz colors
  //     read uniformly across both hemispheres without lingering
  //     day/night shading or specular ocean glint; `datasetAmbient`
  //     bumps up to a flat fill so the globe isn't black on the
  //     night side.
  //
  // Base `ambientLight` stays low in either mode to prevent total
  // darkness; the planet-mode sun dominates, the dataset-mode
  // ambient dominates.
  let ambientLight: THREE.AmbientLight | null = null
  let sunLight: THREE.DirectionalLight | null = null
  let datasetAmbient: THREE.AmbientLight | null = null
  if (includeLighting) {
    ambientLight = new THREE_.AmbientLight(0xffffff, 0.35)
    objects.push(ambientLight)
    sunLight = new THREE_.DirectionalLight(0xffffff, 1.8)
    sunLight.position.set(2, 1.5, 1)
    objects.push(sunLight)
    // Off by default (planet mode); setTexture flips the pair.
    datasetAmbient = new THREE_.AmbientLight(0xffffff, 0)
    objects.push(datasetAmbient)
  }

  // ── Sun-direction state ───────────────────────────────────────────
  // Shared between the Earth material's onBeforeCompile patch, the
  // atmosphere shaders, the cloud shader patch, and the per-frame
  // update that writes the current subsolar direction.
  const sunDirUniform = { value: new THREE_.Vector3(1, 0, 0) }

  // ── §7.2 colour-correction uniforms ───────────────────────────────
  // Mirror the two uniforms `earthTileLayer.ts` Pass 0 introduces on
  // the 2D side. Identity at 1.0 / 1.0 collapses the shader patch to
  // a pass-through so the pre-§7.2 look survives a default boot.
  // Updated by a subscriber below whenever the user picks a Tools-
  // menu preset or drags a tuner slider.
  const contrastUniform = { value: getShaderSettings().contrast }
  const saturationUniform = { value: getShaderSettings().saturation }

  // ── Phase 3h dataset-overlay uniforms ─────────────────────────────
  // Mirror the four uniforms `earthTileLayer.ts` introduced for 3e/B
  // on the 2D side, plus a base-diffuse slot the bbox path samples
  // for outside-the-bbox pixels (2D gets this for free via MapLibre's
  // blue-marble layer; in VR we have one Phong material, so the
  // shader has to sample two textures and pick).
  //
  // Defaults (uHasBbox=false, uOverlayLonOrigin=0, uOverlayFlipY=false,
  // uOverlayHasBase=false) collapse the shader to the standard
  // equirectangular passthrough so legacy global datasets and the
  // planet-mode photoreal Earth render bit-identically to pre-3h.
  const overlayHasBboxUniform = { value: 0 }
  const overlayBboxUniform = { value: new THREE_.Vector4(0, 0, 0, 0) }
  const overlayLonOriginUniform = { value: 0 }
  const overlayFlipYUniform = { value: 0 }
  const overlayHasBaseUniform = { value: 0 }
  // `uOverlayBaseMap` always points at a valid texture so the sampler
  // binding is never null. `baseEarthTexture` is the always-loaded
  // monochrome specular fallback (the same one `material.map` starts
  // on); swapped to `baseDiffuseTexture` once the progressive CDN
  // lands a real Earth diffuse, and again at setTexture time when a
  // bbox+Earth dataset wants base reveal. The uniform value is only
  // sampled when `uOverlayHasBase = 1`.
  // (Initial value also serves to satisfy the GL driver that the
  // sampler is bound to a real texture before first draw.)
  // sunLocalDirCache holds the geographic (Earth-local) sun
  // direction; refreshed at SUN_UPDATE_INTERVAL_MS cadence. Per
  // frame we copy it into a scratch, apply the globe's current
  // rotation, and write into downstream targets — no allocations
  // in the hot path.
  const sunLocalDirCache = new THREE_.Vector3(1, 0, 0)
  const sunDirScratch = new THREE_.Vector3()
  const sunWorldPosScratch = new THREE_.Vector3()
  let lastSunUpdateMs = -Infinity

  // Promise-based image loader. `crossOrigin='anonymous'` is required
  // so cloud's Canvas2D `getImageData()` doesn't throw.
  const loadImage = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Failed to load ${url}`))
      img.src = url
    })

  // ── Globe mesh + day/night material ───────────────────────────────
  const textureLoader = new THREE_.TextureLoader()
  const baseEarthTexture = textureLoader.load(BASE_EARTH_TEXTURE_URL)
  baseEarthTexture.colorSpace = THREE_.SRGBColorSpace
  const specularMapTexture = textureLoader.load(BASE_EARTH_TEXTURE_URL)

  // Bbox-base sampler — always bound to a real texture so the GL
  // driver never sees a null sampler binding. Initial value is the
  // monochrome specular fallback; setTexture swaps to the progressive
  // Earth diffuse once it lands and a bbox+Earth dataset asks for
  // base reveal. The shader only samples this when
  // `uOverlayHasBase = 1`, so what's bound here for the common case
  // is functionally irrelevant — just needs to be valid.
  const overlayBaseMapUniform: { value: THREE.Texture } = { value: baseEarthTexture }

  // MeshPhongMaterial — matches the pre-MapLibre earthMaterials.ts
  // shader style. Phong is simpler than StandardMaterial (no PBR)
  // and runs faster on Quest. The `emissive: white` + `emissiveMap`
  // combination is what the shader patch uses for night-lights
  // gating; emissiveMap starts null and gets set once the lights
  // texture finishes loading.
  // Initial specular tint multiplies the texture-based specular map.
  // Wired below to shaderSettingsService so the Tools-menu specular
  // preset + the dev tuner page can dial the ocean glint up and down
  // — same uniform set the 2D MapLibre layer reads each frame
  // (§7.2). 0xaaaaaa (== ~0.667) was the pre-§7.2 hard-coded value;
  // the live value is set immediately after material construction
  // below so VR boot picks up the persisted preset (Default 0.35).
  const material = new THREE_.MeshPhongMaterial({
    map: baseEarthTexture,
    specularMap: specularMapTexture,
    specular: new THREE_.Color(0xaaaaaa),
    shininess: EARTH_SHININESS,
    emissiveMap: null,
    emissive: new THREE_.Color(0xffffff),
  })

  // Shader patch: two unrelated jobs sharing one onBeforeCompile.
  //
  //   1. Gate the emissive map (night city lights) to the dark side
  //      of the globe only via a smoothstep over the sun direction
  //      dot product. Direct port from earthMaterials.ts; we patch
  //      Three.js' standard Phong shader rather than rolling our own
  //      so lighting / shadows / etc. all still work out of the box.
  //
  //   2. (Phase 3h) UV-remap dataset overlays at <map_fragment> so
  //      `boundingBox` / `lonOrigin` / `isFlippedInY` from the
  //      catalog row reach the GPU. With every overlay uniform at
  //      its default, the math collapses to a pass-through and the
  //      shader output is bit-identical to the pre-3h sample —
  //      same fast-path discipline 3e/B brought to the 2D side.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = sunDirUniform
    shader.uniforms.uContrast = contrastUniform
    shader.uniforms.uSaturation = saturationUniform
    shader.uniforms.uOverlayHasBbox = overlayHasBboxUniform
    shader.uniforms.uOverlayBbox = overlayBboxUniform
    shader.uniforms.uOverlayLonOrigin = overlayLonOriginUniform
    shader.uniforms.uOverlayFlipY = overlayFlipYUniform
    shader.uniforms.uOverlayHasBase = overlayHasBaseUniform
    shader.uniforms.uOverlayBaseMap = overlayBaseMapUniform

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
       varying float vNdotL;
       uniform float uContrast;
       uniform float uSaturation;
       uniform int uOverlayHasBbox;
       uniform vec4 uOverlayBbox;       // (n, s, w, e) degrees
       uniform float uOverlayLonOrigin; // degrees
       uniform int uOverlayFlipY;
       uniform int uOverlayHasBase;
       uniform sampler2D uOverlayBaseMap;`,
    )
    // Replace the standard <map_fragment> chunk (which is just
    // `sampledDiffuseColor = texture2D(map, vMapUv); diffuseColor *= …`)
    // with our bbox-aware variant. Inside the bbox we sample `map`
    // (the dataset texture) with UVs remapped to the bbox extent;
    // outside the bbox we either sample `uOverlayBaseMap` (Earth +
    // bbox case — base diffuse fills the rest of the globe, matches
    // 2D's blue-marble-show rule) or discard the fragment (non-Earth
    // + bbox: 2D hides the blue marble, VR can't realistically draw
    // "a hidden raster layer" so we punch a transparent hole through
    // the sphere instead — same user-visible intent: no Earth tiles
    // showing through behind a Mars dataset's clipped region).
    //
    // No-bbox path: optionally shift U by `uOverlayLonOrigin` so a
    // dateline-centered texture wraps correctly; otherwise this is
    // the standard equirectangular sample.
    //
    // `uOverlayFlipY` applies last in either path, mirroring 2D.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
         vec4 sampledDiffuseColor;
         if (uOverlayHasBbox == 1) {
           float lat = (0.5 - vMapUv.y) * 180.0;
           float lon = (vMapUv.x - 0.5) * 360.0;
           float bn = uOverlayBbox.x;
           float bs = uOverlayBbox.y;
           float bw = uOverlayBbox.z;
           float be = uOverlayBbox.w;
           bool insideLat = (lat <= bn) && (lat >= bs);
           bool insideLon;
           float bu;
           if (bw <= be) {
             // Normal box.
             insideLon = (lon >= bw) && (lon <= be);
             bu = (lon - bw) / max(be - bw, 1e-6);
           } else {
             // Antimeridian-crossing box: inside if east of w OR west of e.
             bool eastSide = lon >= bw;
             bool westSide = lon <= be;
             insideLon = eastSide || westSide;
             float span = (360.0 - bw) + be;
             bu = eastSide ? (lon - bw) / span : (lon + 360.0 - bw) / span;
           }
           if (insideLat && insideLon) {
             float bv = (bn - lat) / max(bn - bs, 1e-6);
             if (uOverlayFlipY == 1) bv = 1.0 - bv;
             sampledDiffuseColor = texture2D(map, vec2(bu, bv));
           } else if (uOverlayHasBase == 1) {
             sampledDiffuseColor = texture2D(uOverlayBaseMap, vMapUv);
           } else {
             discard;
           }
         } else {
           // Full-globe path with optional lonOrigin shift. fract()
           // wraps so a sample at lon < lonOrigin pulls from the
           // texture's right edge (and vice versa).
           float lon = (vMapUv.x - 0.5) * 360.0;
           float fu = fract((lon - uOverlayLonOrigin) / 360.0 + 0.5);
           float fv = (uOverlayFlipY == 1) ? (1.0 - vMapUv.y) : vMapUv.y;
           sampledDiffuseColor = texture2D(map, vec2(fu, fv));
         }
         // §7.2 colour correction — applied to the SAMPLED DIFFUSE
         // (not gl_FragColor at the end of the pipeline) so the
         // semantics match the 2D earthTileLayer's Pass 0, which
         // operates on the Blue Marble framebuffer BEFORE any
         // night-darken / lights / specular / cloud / atmosphere
         // composition.
         //
         // Critical: applied in sRGB PERCEPTUAL space, not linear.
         // Three.js samples the diffuse texture with the
         // SRGBColorSpace transform, so sampledDiffuseColor.rgb at
         // this point is already linear (Three.js gamma-decoded it
         // for the lighting pipeline). The 2D Pass 0 reads the
         // MapLibre framebuffer
         // which is in sRGB display space (no gamma decode), so
         // its "contrast around 0.5" treats 0.5 as the perceptual
         // midpoint. Applying the same maths in linear space would
         // treat typical earth-brown (sRGB ~0.4 → linear ~0.13) as
         // much-darker-than-midtone and aggressively crush it at
         // any contrast > 1, which is exactly what produced the
         // "sky takes over" symptom — the surface darkened, the
         // atmosphere shell (unaffected) dominated relatively.
         // Encode to sRGB, do the maths, decode back to linear.
         // Approximate gamma 2.2 — the piecewise sRGB transfer
         // curve is a few %-points more accurate but adds branches
         // to a hot path; the 2.2 approximation is good enough for
         // a perceptual-contrast knob.
         vec3 perceptual = pow(sampledDiffuseColor.rgb, vec3(1.0 / 2.2));
         perceptual = (perceptual - 0.5) * uContrast + 0.5;
         float vrLuma = dot(perceptual, vec3(0.299, 0.587, 0.114));
         perceptual = mix(vec3(vrLuma), perceptual, uSaturation);
         perceptual = clamp(perceptual, 0.0, 1.0);
         sampledDiffuseColor.rgb = pow(perceptual, vec3(2.2));
         diffuseColor *= sampledDiffuseColor;
       #endif`,
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

  // Apply the persisted specular preset to the Phong material's
  // specular tint and subscribe to future shader-settings changes
  // (Tools-menu radio + tuner-page sliders). Multiplies the existing
  // specular MAP, so the per-texel ocean / land masking stays —
  // we're just scaling intensity. The full setSpecularFromSettings
  // logic lives once here; an unsubscribe runs in dispose() below.
  function setSpecularFromSettings() {
    const s = getShaderSettings().specularStrength
    material.specular.setRGB(s, s, s)
  }
  setSpecularFromSettings()

  // §7.2 normal-map intensity. MeshPhongMaterial scales the
  // sampled tangent-space normal by `normalScale` before perturbing
  // the surface normal, so this is the canonical knob — a value
  // of (0, 0) collapses to flat-shaded, (1, 1) is the asset's
  // authored depth, anything in between dials it. We mirror the
  // shaderSettingsService.bumpStrength scalar onto both axes so
  // VR + 2D bump intensity track each other. `material.normalMap`
  // gets bound by the progressive loader below once a tier lands;
  // until then this is a no-op (MeshPhong skips its normal-map
  // chunks when the slot is null).
  function setBumpFromSettings() {
    const s = getShaderSettings().bumpStrength
    material.normalScale.set(s, s)
  }
  setBumpFromSettings()

  const unsubscribeShaderSettings = onShaderSettingsChange(() => {
    setSpecularFromSettings()
    setBumpFromSettings()
    contrastUniform.value = getShaderSettings().contrast
    saturationUniform.value = getShaderSettings().saturation
  })

  // 64×64 is plenty for a globe filling ~40° of the viewer's FOV.
  const geometry = new THREE_.SphereGeometry(radius, 64, 64)
  const globe = new THREE_.Mesh(geometry, material)
  globe.position.set(position.x, position.y, position.z)
  objects.push(globe)

  // ── Atmosphere shell (optional) ───────────────────────────────────
  // Single transparent shell at ATMOSPHERE_RADIUS_FACTOR (≈ 1.0157),
  // so the shell's silhouette IS the atmosphere boundary the
  // raymarch integrates against. Front-faces render (default cull)
  // — each front-facing fragment is the camera-side atmosphere
  // entry point for that pixel; the fragment shader raymarches
  // inward, terminating at either the back of the atmosphere or
  // the planet surface (whichever comes first).
  //
  // Additive blending after `acesFilm` keeps the planet's surface
  // appearance underneath visible. Earth's atmosphere is thin
  // enough that ignoring view-transmittance composition (no
  // background dimming) reads correctly at every viewing angle
  // we ship.
  //
  // The shell is NOT a child of the globe — atmosphere doesn't
  // spin with the planet surface. `update()` syncs its position
  // and uniform scale (km-per-world-unit) each frame.
  //
  // Two new uniforms beyond the Tier-1 sun direction:
  //   uPlanetCenter    — globe world position (refreshed in
  //                      update() so the raymarch's "origin"
  //                      always matches the rendered globe).
  //   uKmPerWorldUnit  — PLANET_RADIUS_KM divided by the globe
  //                      radius parameter, so the shader can
  //                      convert world units to the km that the
  //                      atmospheric constants expect.
  let atmosphere: THREE.Mesh | null = null
  let atmosphereGeometry: THREE.SphereGeometry | null = null
  let atmosphereMaterial: THREE.ShaderMaterial | null = null
  let transmittanceLutTexture: THREE.DataTexture | null = null
  const planetCenterUniform = { value: new THREE_.Vector3(position.x, position.y, position.z) }
  const kmPerWorldUnitUniform = { value: PLANET_RADIUS_KM / radius }
  if (includeAtmosphere) {
    // Tier-3 transmittance LUT — precomputed on the CPU once, then
    // uploaded as a DataTexture. The raymarch's per-sample inner
    // light-march collapses into a single texture lookup. ~10× cost
    // reduction vs the Tier-2 8-step inner loop on desktop; far more
    // on mobile (the inner loop scaled with sample count).
    const lut = computeTransmittanceLut()
    transmittanceLutTexture = new THREE_.DataTexture(
      lut.pixels, lut.width, lut.height, THREE_.RGBAFormat, THREE_.UnsignedByteType,
    )
    transmittanceLutTexture.minFilter = THREE_.LinearFilter
    transmittanceLutTexture.magFilter = THREE_.LinearFilter
    transmittanceLutTexture.wrapS = THREE_.ClampToEdgeWrapping
    transmittanceLutTexture.wrapT = THREE_.ClampToEdgeWrapping
    transmittanceLutTexture.needsUpdate = true

    const atmosphereVertexShader = `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `

    // Mobile / touch devices (including Quest) get a lower step
    // count to fit their fragment-shader budget. `isMobile()`
    // matches the texture-resolution decisions made elsewhere in
    // the codebase.
    const atmosphereSteps = isMobile() ? ATMOSPHERE_STEPS_MOBILE : ATMOSPHERE_STEPS_HIGH

    // GLSL 1.00 (Three.js default) — sampleTransmittanceLut helper.
    // The shared raymarch declares the function; we provide the
    // implementation ahead of the raymarch injection. The
    // MapLibre path (earthTileLayer.ts) provides the same logic
    // with `texture()` instead of `texture2D()`.
    const lutSamplerHelper = `
      uniform sampler2D uTransmittanceLut;
      vec3 sampleTransmittanceLut(vec3 samplePos, vec3 sunDir) {
        float altitude = length(samplePos) - PLANET_RADIUS;
        float mu = dot(normalize(samplePos), sunDir);
        vec2 lutUV = vec2(
          mu * 0.5 + 0.5,
          clamp(altitude / ATMOSPHERE_HEIGHT, 0.0, 1.0)
        );
        return texture2D(uTransmittanceLut, lutUV).rgb;
      }
    `

    const atmosphereFragShader = `
      uniform vec3 uSunDir;
      uniform vec3 uPlanetCenter;
      uniform float uKmPerWorldUnit;
      uniform float uIntensity;
      varying vec3 vWorldPosition;
      ${ATMOSPHERE_GLSL_CONSTANTS}
      ${ATMOSPHERE_GLSL_DENSITY}
      ${ATMOSPHERE_GLSL_PHASE}
      ${ATMOSPHERE_GLSL_INTERSECT}
      ${ATMOSPHERE_GLSL_TONEMAP}
      ${lutSamplerHelper}
      ${buildAtmosphereRaymarchGlsl(atmosphereSteps)}

      void main() {
        // Translate world coords into planet-centred km, which is
        // what the raymarch and atmospheric constants operate in.
        vec3 fragKm = (vWorldPosition - uPlanetCenter) * uKmPerWorldUnit;
        vec3 camKm  = (cameraPosition - uPlanetCenter) * uKmPerWorldUnit;
        vec3 rayDir = normalize(fragKm - camKm);

        // result.rgb = HDR in-scattered light; result.a = view
        // transmittance scalar. Composition is article-style:
        // framebuffer becomes  scattered + bg × viewTrans
        // via the material's CustomBlending (OneFactor,
        // SrcAlphaFactor) below.
        vec4 result = computeAtmosphereScattering(camKm, rayDir, uSunDir);
        gl_FragColor = vec4(acesFilm(result.rgb) * uIntensity, result.a);
      }
    `

    atmosphereGeometry = new THREE_.SphereGeometry(
      radius * ATMOSPHERE_RADIUS_FACTOR, ATMOSPHERE_SEGMENTS, ATMOSPHERE_SEGMENTS,
    )
    atmosphereMaterial = new THREE_.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragShader,
      uniforms: {
        uSunDir: sunDirUniform,
        uPlanetCenter: planetCenterUniform,
        uKmPerWorldUnit: kmPerWorldUnitUniform,
        uIntensity: { value: ATMOSPHERE_INTENSITY },
        uTransmittanceLut: { value: transmittanceLutTexture },
      },
      transparent: true,
      // FrontSide + depthTest false: the shell front face is the
      // camera-side entry point, and we want it visible everywhere
      // it draws (over planet face AND beyond planet silhouette).
      side: THREE_.FrontSide,
      depthTest: false,
      depthWrite: false,
      // Article-style composition:
      //   result = src.rgb × 1 + dst.rgb × src.alpha
      //         = scattered + bg × viewTransmittance
      // i.e. the atmosphere ADDS in-scattered light AND DIMS the
      // planet behind it by the view-side transmittance. Pure
      // AdditiveBlending (the previous Tier-2/3 setting) only did
      // the first half; with no dimming term the noon-zenith view
      // washed out as the limb halo overlapped the planet face.
      blending: THREE_.CustomBlending,
      blendEquation: THREE_.AddEquation,
      blendSrc: THREE_.OneFactor,
      blendDst: THREE_.SrcAlphaFactor,
    })
    atmosphere = new THREE_.Mesh(atmosphereGeometry, atmosphereMaterial)
    atmosphere.position.copy(globe.position)
    // renderOrder above the globe so the shell draws after the
    // opaque globe pass; with depthTest off this is the sort key.
    atmosphere.renderOrder = 1
    objects.push(atmosphere)
  }

  // ── Sun sprite (optional) ─────────────────────────────────────────
  // Two billboard sprites: small bright core and larger soft glow
  // halo. Procedural CanvasTextures (radial gradients) so no asset
  // hosting needed. Positioned each frame at
  // `globe.position + sunDir * sunDistance` so they track the real
  // subsolar direction as UTC advances and follow the globe when
  // it's placed/translated. Direct port from earthMaterials.ts.
  let sunCoreSprite: THREE.Sprite | null = null
  let sunGlowSprite: THREE.Sprite | null = null
  if (includeSun) {
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
      if (!ctx) throw new Error('[photorealEarth] 2D canvas context unavailable')
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

    // depthTest stays ON (Three.js default) so the globe's depth
    // buffer naturally occludes the sprite when the sun is behind
    // the planet. depthWrite stays OFF because additive-blended
    // sprites shouldn't clobber depth for anything else. Same fix
    // landed separately on the VR branch; callers now see
    // consistent behavior.
    const coreTexture = buildGlowTexture(SUN_GLOW_TEXTURE_SIZE, 0.25, [255, 252, 230], 1.0)
    const coreMaterial = new THREE_.SpriteMaterial({
      map: coreTexture,
      blending: THREE_.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    })
    sunCoreSprite = new THREE_.Sprite(coreMaterial)
    sunCoreSprite.scale.set(sunCoreScale, sunCoreScale, 1)
    sunCoreSprite.renderOrder = -2
    objects.push(sunCoreSprite)

    const glowTexture = buildGlowTexture(SUN_GLOW_TEXTURE_SIZE, 0.1, [255, 220, 170], SUN_GLOW_OPACITY)
    const glowMaterial = new THREE_.SpriteMaterial({
      map: glowTexture,
      blending: THREE_.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    })
    sunGlowSprite = new THREE_.Sprite(glowMaterial)
    sunGlowSprite.scale.set(sunGlowScale, sunGlowScale, 1)
    sunGlowSprite.renderOrder = -3
    objects.push(sunGlowSprite)
  }

  // ── Cloud overlay (optional, async) ───────────────────────────────
  // Slightly-larger translucent sphere above the Earth surface.
  // Loaded asynchronously from the shared cloud bucket; mesh only
  // appears once the texture decodes so the scene never shows an
  // opaque white sphere placeholder. Direct port from
  // earthMaterials.ts including the luminance → alpha preprocessing
  // step. Parented to the globe so clouds inherit globe rotation
  // (when the user grab-spins the planet, clouds spin with it).
  let cloudMesh: THREE.Mesh | null = null
  /**
   * Desired cloud visibility — set by setTexture based on whether a
   * dataset is loaded. Tracked separately because cloud mesh is
   * created asynchronously; the async loader applies this flag on
   * creation so a "dataset loaded before clouds finished fetching"
   * race doesn't leave clouds inappropriately visible.
   */
  let cloudsShouldBeVisible = true
  if (includeClouds) {
    void (async () => {
      try {
        const img = await loadImage(getCloudTextureUrl())
        if (disposed) return

        // Convert luminance channel to alpha on an offscreen canvas:
        // solid white RGB, varying alpha from source brightness with
        // gamma to boost contrast between wisps and dense cover.
        //
        // Clamp dimensions to MAX_CLOUD_TEXTURE_SIZE: the asset is
        // 10000×5000, which exceeds gl.MAX_TEXTURE_SIZE on macOS
        // Firefox (capped at 8192) — Three.js's upload would silently
        // fail and leave the cloud mesh untextured. The clamp also
        // bounds the getImageData allocation (10000×5000×4 ≈ 200 MB).
        const MAX_CLOUD_TEXTURE_SIZE = 8192
        const scale = Math.min(1,
          MAX_CLOUD_TEXTURE_SIZE / img.width,
          MAX_CLOUD_TEXTURE_SIZE / img.height)
        const w = Math.floor(img.width * scale)
        const h = Math.floor(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('[photorealEarth] 2D canvas context unavailable')
        ctx.drawImage(img, 0, 0, w, h)
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

        // Handle may have been disposed while the image was loading
        // — the caller teardown path would otherwise miss these
        // newly-allocated GPU resources. Nothing has been attached
        // to the scene yet, so we just drop the work entirely.
        if (disposed) return

        const cloudTexture = new THREE_.CanvasTexture(canvas)
        cloudTexture.colorSpace = THREE_.SRGBColorSpace

        const cloudGeometry = new THREE_.SphereGeometry(
          radius * CLOUD_FACTOR, CLOUD_SEGMENTS, CLOUD_SEGMENTS,
        )
        const cloudMaterial = new THREE_.MeshPhongMaterial({
          map: cloudTexture,
          transparent: true,
          depthWrite: false,
          opacity: CLOUD_OPACITY,
        })

        // Shader patch: on the night side, darken cloud diffuse to
        // near-black so city lights beneath remain visible through
        // the (now-dim) cloud layer. Same smoothstep pattern as the
        // Earth material's emissive gating, applied to the diffuse
        // map_fragment chunk instead.
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
        cloudMesh.visible = cloudsShouldBeVisible
        // Child of the globe — inherits position, scale, AND
        // rotation. Rotation inheritance is intentional: clouds
        // move with Earth's surface rotation.
        globe.add(cloudMesh)
      } catch (err) {
        logger.warn('[photorealEarth] Cloud texture load failed; no cloud overlay:', err)
      }
    })()
  }

  // ── Ground shadow (optional) ──────────────────────────────────────
  // Subtle dark radial gradient on a horizontal plane below the
  // globe. Helps the globe feel spatially anchored — especially in
  // AR mode where there's no dark void to ground it visually.
  // Scales with globe scale each frame so a zoomed-in globe casts a
  // correspondingly larger shadow.
  let shadow: THREE.Mesh | null = null
  let shadowGeometry: THREE.PlaneGeometry | null = null
  let shadowMaterial: THREE.MeshBasicMaterial | null = null
  let shadowTexture: THREE.CanvasTexture | null = null
  if (includeShadow) {
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
    shadowTexture = new THREE_.CanvasTexture(shadowCanvas)
    shadowTexture.colorSpace = THREE_.SRGBColorSpace
    shadowTexture.minFilter = THREE_.LinearFilter
    shadowTexture.magFilter = THREE_.LinearFilter

    shadowMaterial = new THREE_.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      depthWrite: false, // shadow shouldn't occlude the globe or HUD
    })
    // Slightly larger than the globe's diameter so the shadow's soft
    // edges fall off well outside its silhouette.
    shadowGeometry = new THREE_.PlaneGeometry(radius * 3, radius * 3)
    shadow = new THREE_.Mesh(shadowGeometry, shadowMaterial)
    shadow.rotation.x = -Math.PI / 2
    shadow.position.set(
      position.x,
      position.y - radius - 0.005,
      position.z,
    )
    shadow.renderOrder = -1
    objects.push(shadow)
  }

  // ── Texture state ─────────────────────────────────────────────────
  let activeDatasetTexture: THREE.Texture | null = null
  /** Identity of the currently-loaded spec — element reference for change detection. */
  // Identity token for the active dataset source (compared by ===,
  // never read as an element). Accepts every `VrDatasetTexture`
  // element kind, incl. the canvas / ImageBitmap image sources.
  let activeKey:
    | HTMLVideoElement
    | HTMLImageElement
    | HTMLCanvasElement
    | ImageBitmap
    | null = null
  /**
   * Cleanup closure for pending video `seeked`/`playing` listeners.
   * Without this, a dataset swap or session end before the HLS
   * decoder produces its first frame would leak listeners.
   */
  let cancelPendingVideoListeners: (() => void) | null = null

  /**
   * Base diffuse texture once the CDN fetch lands — kept so we can
   * restore it after a dataset texture is cleared. While CDN is
   * pending or failed, this stays null and `baseEarthTexture` is
   * what `map` falls back to.
   */
  let baseDiffuseTexture: THREE.Texture | null = null
  /**
   * Night-lights emissive texture once the CDN fetch lands. Null
   * while pending or failed — the `#ifdef USE_EMISSIVEMAP` guards
   * keep the effect disabled in that case.
   */
  let lightsTexture: THREE.Texture | null = null
  /**
   * Normal-map texture once the CDN fetch lands — kept so dispose()
   * can free the GPU memory. The MeshPhongMaterial's built-in
   * `normalMap` slot drives the bump shading; intensity is set via
   * `material.normalScale` from shaderSettingsService.bumpStrength.
   * Stays null while pending or failed; the material falls back to
   * un-perturbed shading in that case (MeshPhong skips the normal-
   * map chunks when `material.normalMap` is null).
   */
  let normalTexture: THREE.Texture | null = null

  /**
   * Push `options` into the four overlay uniforms (bbox / lonOrigin /
   * flipY / has-base) and decide whether to expose a base Earth
   * diffuse for the shader's bbox-outside path:
   *
   *   - bbox absent  → all overlay state defaults; shader's
   *                    full-globe lonOrigin/flipY path runs.
   *   - bbox present, Earth → has-base on; uOverlayBaseMap follows
   *                    the current progressive diffuse tier so the
   *                    rest of the globe shows blue marble (2D parity).
   *   - bbox present, non-Earth → has-base off; shader `discard`s the
   *                    outside-bbox pixels, matching 2D's "hide blue
   *                    marble behind Mars/Moon/etc." rule.
   *
   * Idempotent — safe to call on every spec swap and on every
   * progressive diffuse tier upgrade. `undefined` resets to the
   * pre-3h passthrough.
   */
  function applyOverlayOptions(options: DatasetOverlayOptions | undefined): void {
    if (!options) {
      overlayHasBboxUniform.value = 0
      overlayBboxUniform.value.set(0, 0, 0, 0)
      overlayLonOriginUniform.value = 0
      overlayFlipYUniform.value = 0
      overlayHasBaseUniform.value = 0
      return
    }
    const bbox = options.boundingBox
    if (bbox) {
      overlayHasBboxUniform.value = 1
      overlayBboxUniform.value.set(bbox.n, bbox.s, bbox.w, bbox.e)
      if (isEarthBody(options.celestialBody)) {
        overlayHasBaseUniform.value = 1
        overlayBaseMapUniform.value = baseDiffuseTexture ?? baseEarthTexture
      } else {
        overlayHasBaseUniform.value = 0
      }
    } else {
      overlayHasBboxUniform.value = 0
      overlayHasBaseUniform.value = 0
    }
    overlayLonOriginUniform.value =
      typeof options.lonOrigin === 'number' && Number.isFinite(options.lonOrigin)
        ? options.lonOrigin
        : 0
    overlayFlipYUniform.value = options.isFlippedInY ? 1 : 0
  }

  /**
   * Walk a list of resolution tiers in ascending order, upgrading
   * the texture as each tier lands. On a tier-404 or network error,
   * progression stops and whatever tier most recently succeeded
   * stays applied.
   */
  async function loadProgressive(
    urls: string[],
    apply: (tex: THREE.Texture) => void,
    label: string,
    colorSpace: THREE.ColorSpace = THREE_.SRGBColorSpace,
  ): Promise<void> {
    for (const url of urls) {
      try {
        const img = await loadImage(url)
        // Bail (and don't build the Texture) if the handle was
        // disposed during the fetch — otherwise the `apply` callback
        // would stash a texture into the Earth material that nothing
        // will ever free.
        if (disposed) return
        const tex = new THREE_.Texture(img)
        // Set colour space BEFORE flagging needsUpdate. Three.js
        // bakes the texture's colorSpace into the shader chunks at
        // material compile time (it decides whether to insert a
        // sRGB → linear conversion at sample time). Setting it AFTER
        // needsUpdate would leave a normal-map texture compiled with
        // the sRGB path, gamma-correcting raw normal vectors into
        // garbage. SRGB is the right default for the diffuse + night-
        // lights tiers; normal maps pass NoColorSpace explicitly.
        tex.colorSpace = colorSpace
        tex.needsUpdate = true
        apply(tex)
      } catch (err) {
        logger.warn(`[photorealEarth] ${label} tier ${url} failed — stopping progression:`, err)
        return
      }
    }
  }

  /**
   * Subscribers to diffuse-tier upgrades (multi-globe callers that
   * want secondary globes to share the primary's tier). Cleared
   * on dispose.
   */
  const diffuseSubscribers = new Set<(tex: THREE.Texture) => void>()

  // Diffuse — 2K → 4K → 8K. Each tier replaces the previous;
  // previous texture disposed so GPU memory doesn't balloon.
  void loadProgressive(
    EARTH_DIFFUSE_URLS,
    tex => {
      // Phase 3h: any bbox+Earth dataset using the base-reveal path
      // should pick up the upgrade so the area outside the bbox
      // sharpens 2K → 4K → 8K just like a planet-mode globe does.
      // Safe even when `uOverlayHasBase = 0` because the sampler is
      // only read on the bbox+Earth path; mutating the binding off-
      // the-bbox-path doesn't affect anything.
      if (overlayHasBaseUniform.value === 1) {
        overlayBaseMapUniform.value = tex
      }
      // Swap only if no dataset has taken over during the fetch.
      if (activeKey !== null) {
        baseDiffuseTexture?.dispose()
        baseDiffuseTexture = tex
        // Still notify subscribers so their dataset-free globes
        // can take the upgrade when the user clears their dataset.
        for (const cb of diffuseSubscribers) cb(tex)
        return
      }
      baseDiffuseTexture?.dispose()
      baseDiffuseTexture = tex
      material.map = tex
      material.needsUpdate = true
      for (const cb of diffuseSubscribers) cb(tex)
    },
    'earth diffuse',
  )

  // Lights — 2K → 4K → 8K, mirroring the diffuse tier list. The 8K
  // tier costs ~256 MB of GPU memory before mipmaps (chunky for
  // Quest 2) but the progressive loader degrades gracefully: a
  // failed 8K allocation leaves the 4K tier resident.
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

  // Normal map — 2K → 4K → 8K. Mirrors the 2D earthTileLayer
  // ladder so a Tools-menu specular pick + bump tuner-page slide
  // produces a consistent look across the MapLibre globe and the
  // VR / Orbit Three.js sphere. material.needsUpdate is required
  // on first bind because MeshPhongMaterial only compiles its
  // normal-map shader chunks when the slot transitions from null
  // to non-null — subsequent tier swaps are texImage uploads and
  // don't need a re-compile.
  //
  // Normal maps load with `NoColorSpace` (4th arg) so Three.js
  // doesn't gamma-correct the tangent-space normal samples — they
  // encode geometry, not perceptual colour, and an sRGB→linear
  // transform would distort the slope vectors into the wrong
  // direction (the most visible symptom was Brazil reading red
  // and the Amazon reading sky-blue once the sample bled into
  // the lighting calculation).
  void loadProgressive(
    EARTH_NORMAL_URLS,
    tex => {
      const isFirstBind = material.normalMap == null
      normalTexture?.dispose()
      normalTexture = tex
      material.normalMap = tex
      if (isFirstBind) material.needsUpdate = true
    },
    'earth normal',
    THREE_.NoColorSpace,
  )

  return {
    globe,
    get sunDir() {
      return sunDirUniform.value
    },
    get baseDiffuseTexture() {
      return baseDiffuseTexture
    },
    get baseEarthTexture() {
      return baseEarthTexture
    },
    onBaseDiffuseChange(callback) {
      diffuseSubscribers.add(callback)
      return () => { diffuseSubscribers.delete(callback) }
    },

    addTo(scene) {
      for (const obj of objects) scene.add(obj)
    },

    removeFrom(scene) {
      for (const obj of objects) scene.remove(obj)
    },

    setTexture(spec, onReady) {
      // Skip texture-swap work if the spec is unchanged — repeated
      // polls from the session loop are a no-op in the steady state.
      // BUT still fire onReady: callers (vrSession) wait for the
      // "texture is live and visible" signal to trigger their
      // loading-scene fade-out, and for the initial null → null
      // case (user enters VR with no dataset loaded in 2D) the
      // state transition is trivial but the caller still needs the
      // readiness ping. Callers dedupe via their own "already
      // fired" flag so firing on every no-op is harmless.
      const nextKey = spec?.kind === 'video' ? spec.element : spec?.kind === 'image' ? spec.element : null
      if (nextKey === activeKey) {
        // Even on an unchanged-element no-op, the overlay options
        // for that element may have moved (catalog patch, tour task
        // re-loading the same dataset with new metadata). Re-apply
        // the uniforms so a stale bbox doesn't outlive its config.
        applyOverlayOptions(spec?.options)
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
      // previous spec.
      if (cancelPendingVideoListeners) {
        cancelPendingVideoListeners()
        cancelPendingVideoListeners = null
      }

      if (!spec) {
        // Restore the full photoreal Earth stack — diffuse if CDN
        // loaded, specular fallback otherwise; specular ocean glint;
        // night-lights emissive gated by the day/night shader;
        // clouds + atmosphere rim. Anything the user sees while no
        // dataset is loaded is "Earth as a planet".
        applyOverlayOptions(undefined)
        material.map = baseDiffuseTexture ?? baseEarthTexture
        material.emissiveMap = lightsTexture
        material.emissive.setHex(0xffffff)
        material.specularMap = specularMapTexture
        material.specular.setHex(0xaaaaaa)
        cloudsShouldBeVisible = true
        if (cloudMesh) cloudMesh.visible = true
        if (atmosphere) atmosphere.visible = true
        if (sunCoreSprite) sunCoreSprite.visible = true
        if (sunGlowSprite) sunGlowSprite.visible = true
        // Planet mode: directional sun on, dataset-fill off.
        if (sunLight) sunLight.intensity = 1.8
        if (datasetAmbient) datasetAmbient.intensity = 0
        activeKey = null
        // No dataset to wait for — readiness is immediate.
        onReady?.()
      } else if (spec.kind === 'video') {
        const video = spec.element
        activeKey = video
        // Overlay options (bbox / lonOrigin / flipY) are deliberately
        // NOT applied here. The video may not be ready, in which
        // case the branch below points `material.map` at
        // `baseEarthTexture` (the monochrome specular fallback) as
        // a placeholder. Applying a bbox UV remap to that
        // placeholder would briefly show a warped Earth patch in
        // the bbox shape until the first video frame lands. Apply
        // overlay options at the moment the dataset texture
        // actually replaces the placeholder — both readiness paths
        // below set them right before `material.map = tex`.

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
        if (atmosphere) atmosphere.visible = false
        if (sunCoreSprite) sunCoreSprite.visible = false
        if (sunGlowSprite) sunGlowSprite.visible = false
        // Dataset mode: directional sun off so scientific-viz colors
        // read uniformly, dataset-fill bumps ambient up so the globe
        // isn't black on what-used-to-be the night side.
        if (sunLight) sunLight.intensity = 0
        if (datasetAmbient) datasetAmbient.intensity = 1.6

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
          // Frame already decoded — apply overlay options and swap
          // in the dataset texture in one go, no placeholder phase.
          applyOverlayOptions(spec.options)
          material.map = tex
          onReady?.()
        } else {
          // No frame yet — keep the base Earth visible instead of
          // showing a black ball. We listen across four events
          // (loadeddata / canplay / seeked / playing) because any
          // one of them CAN be the first sign that a frame is
          // decodable, and HLS + different browsers fire them in
          // different orders:
          //
          //   - 'loadeddata' — media pipeline has decoded the first
          //     frame (readyState ≥ 2). Should fire shortly after
          //     load even without play.
          //   - 'canplay' — ready to play at current playback rate.
          //   - 'seeked' — our forced seek to current time landed.
          //   - 'playing' — user (or the play() below) started
          //     playback.
          //
          // We also attempt a `video.play()` to nudge the decoder
          // in case HLS needs an active pull. Autoplay may be
          // blocked — we swallow the error and rely on the listener
          // fallback. `video.muted = true` (set by hlsService) makes
          // this silent-autoplay-friendly per the browser policies.
          //
          // Overlay options reset to passthrough during this
          // placeholder window so the monochrome Earth fallback
          // renders un-warped; the onFrame listener below pushes
          // the real options just before swapping in the video
          // texture, so the user sees the bbox/lonOrigin behavior
          // appear in the same frame the video data does.
          applyOverlayOptions(undefined)
          material.map = baseEarthTexture
          const onFrame = () => {
            cancelPendingVideoListeners?.()
            cancelPendingVideoListeners = null
            if (activeKey !== video) return
            applyOverlayOptions(spec.options)
            material.map = tex
            material.needsUpdate = true
            onReady?.()
          }
          video.addEventListener('loadeddata', onFrame, { once: true })
          video.addEventListener('canplay', onFrame, { once: true })
          video.addEventListener('seeked', onFrame, { once: true })
          video.addEventListener('playing', onFrame, { once: true })
          cancelPendingVideoListeners = () => {
            video.removeEventListener('loadeddata', onFrame)
            video.removeEventListener('canplay', onFrame)
            video.removeEventListener('seeked', onFrame)
            video.removeEventListener('playing', onFrame)
          }
          // Nudge the decoder — the caller's user-gesture (browse
          // panel tap, Enter VR) transitively permits autoplay. If
          // the policy blocks it anyway, no harm done; the listener
          // pool above still catches the first frame when it lands.
          video.play().catch(() => { /* autoplay blocked — fine */ })
        }
      } else if (spec.kind === 'image') {
        applyOverlayOptions(spec.options)
        // The 2D loader already decoded this image (including the
        // resolution-fallback dance), so we wrap the live
        // HTMLImageElement directly — no re-fetch, no async.
        const tex = new THREE_.Texture(spec.element)
        tex.colorSpace = THREE_.SRGBColorSpace
        tex.minFilter = THREE_.LinearFilter
        tex.magFilter = THREE_.LinearFilter
        tex.needsUpdate = true
        activeDatasetTexture = tex
        // Hide Earth decoration — same rationale as the video branch.
        material.emissiveMap = null
        material.emissive.setHex(0x000000)
        material.specularMap = null
        material.specular.setHex(0x000000)
        cloudsShouldBeVisible = false
        if (cloudMesh) cloudMesh.visible = false
        if (atmosphere) atmosphere.visible = false
        if (sunCoreSprite) sunCoreSprite.visible = false
        if (sunGlowSprite) sunGlowSprite.visible = false
        // Dataset mode lighting — see video branch.
        if (sunLight) sunLight.intensity = 0
        if (datasetAmbient) datasetAmbient.intensity = 1.6
        material.map = tex
        activeKey = spec.element
        onReady?.()
      }
      material.needsUpdate = true
    },

    update() {
      // Shadow follows the globe's world position and scale so it
      // stays anchored beneath any zoom level / placement.
      if (shadow) {
        shadow.scale.x = globe.scale.x
        shadow.scale.y = globe.scale.x
        shadow.position.set(
          globe.position.x,
          globe.position.y - radius * globe.scale.x - 0.005,
          globe.position.z,
        )
      }

      // Atmosphere shells follow the globe's position + uniform
      // scale but deliberately NOT its rotation — the atmosphere
      // doesn't spin with the planet's surface (the user's grab
      // rotation is an abstraction of Earth rotating under a
      // fixed sun, not of the sky rotating with the ground).
      if (atmosphere) {
        atmosphere.position.copy(globe.position)
        atmosphere.scale.copy(globe.scale)
        // The raymarch needs to know where the planet is, and how
        // many km each world unit currently represents, to translate
        // fragment world-space into planet-centred km. globe.scale
        // changes at runtime under VR pinch-zoom, so the km/world
        // factor has to track it — fixing it at construction would
        // make the raymarch read the wrong altitude (and therefore
        // the wrong sky colour) at any non-unit scale.
        planetCenterUniform.value.copy(globe.position)
        kmPerWorldUnitUniform.value = PLANET_RADIUS_KM / (radius * globe.scale.x)
      }

      // Refresh the subsolar point on a throttle.
      const nowMs = performance.now()
      if (nowMs - lastSunUpdateMs > SUN_UPDATE_INTERVAL_MS) {
        lastSunUpdateMs = nowMs
        const { lat, lng } = getSunPosition(new Date())
        sunDirectionFromLatLng(THREE_, lat, lng, sunLocalDirCache)
      }

      // After storing the sun direction in the globe's LOCAL frame
      // (geographic convention — a fixed direction relative to
      // Earth's surface for a given UTC), apply the globe's
      // current world-space quaternion to get the sun's WORLD-SPACE
      // direction each frame. So when the user grab-rotates the
      // globe, the sun ROTATES WITH IT — rather than the globe
      // spinning under a fixed sun. A fixed-in-world sun made
      // grab-rotate feel like scrubbing time; rotating the sun
      // with the globe makes grab-rotate feel like orbiting the
      // Earth-Sun system from a different viewing angle. Time
      // stays current; only the user's viewing angle changes.
      sunDirScratch.copy(sunLocalDirCache).applyQuaternion(globe.quaternion)
      sunDirUniform.value.copy(sunDirScratch)

      if (sunLight) {
        // DirectionalLight convention: light shines FROM its
        // position TOWARD origin. Place along sun direction at
        // some distance so shading matches the shader's uSunDir.
        sunLight.position.copy(sunDirScratch).multiplyScalar(10)
      }

      if (sunCoreSprite && sunGlowSprite) {
        sunWorldPosScratch
          .copy(sunDirScratch)
          .multiplyScalar(sunDistance)
          .add(globe.position)
        sunCoreSprite.position.copy(sunWorldPosScratch)
        sunGlowSprite.position.copy(sunWorldPosScratch)
      }
    },

    dispose() {
      // Tell every in-flight async loader (cloud texture fetch,
      // progressive diffuse/lights tiers) to drop their result on
      // the floor instead of attaching it to a torn-down scene.
      disposed = true
      // Drop the shader-settings subscription so a Tools-menu click
      // after a VR exit doesn't keep mutating a disposed material.
      unsubscribeShaderSettings()
      // Drop all diffuse subscribers — no point firing them after
      // we're gone, and callers should re-subscribe on fresh handles.
      diffuseSubscribers.clear()
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
      normalTexture?.dispose()
      material.dispose()
      geometry.dispose()
      if (cloudMesh) {
        ;(cloudMesh.geometry as THREE.BufferGeometry).dispose()
        const cloudMat = cloudMesh.material as THREE.MeshPhongMaterial
        cloudMat.map?.dispose()
        cloudMat.dispose()
        globe.remove(cloudMesh)
        cloudMesh = null
      }
      atmosphereGeometry?.dispose()
      atmosphereMaterial?.dispose()
      transmittanceLutTexture?.dispose()
      if (sunCoreSprite) {
        const mat = sunCoreSprite.material as THREE.SpriteMaterial
        mat.map?.dispose()
        mat.dispose()
      }
      if (sunGlowSprite) {
        const mat = sunGlowSprite.material as THREE.SpriteMaterial
        mat.map?.dispose()
        mat.dispose()
      }
      shadowGeometry?.dispose()
      shadowMaterial?.dispose()
      shadowTexture?.dispose()
    },
  }
}
