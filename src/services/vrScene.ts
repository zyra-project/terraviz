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
 * Hosted on the same S3 bucket as the cloud texture (see
 * `getCloudTextureUrl()` in `utils/deviceCapability.ts`). **Not**
 * LFS-tracked — the previous `Earth_Diffuse_6K.jpg` asset was
 * deliberately removed from LFS in commit `34167f2` when the
 * zyra-project account hit 9 GB / 10 GB LFS bandwidth/month.
 * External CDN keeps that problem from recurring.
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
 * Lights uses 2K + 4K only — night-side detail matters less than
 * day-side, and GPU memory adds up quickly (8K RGBA = 256 MB on
 * the GPU before mipmaps).
 *
 * If any tier URL 404s, progression stops at the previous tier
 * and the visible texture stays at the highest-successful tier.
 */
const EARTH_DIFFUSE_URLS = [
  'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/earth_diffuse_2048.jpg',
  'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/earth_diffuse_4096.jpg',
  'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/earth_diffuse_8192.jpg',
]
const EARTH_LIGHTS_URLS = [
  'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/earth_lights_2048.jpg',
  'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/earth_lights_4096.jpg',
]

// --- Day/night material constants (ported from earthMaterials.ts) ---
const EARTH_SHININESS = 40
const NIGHT_LIGHT_STRENGTH = 0.5

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
): THREE.Vector3 {
  const latRad = (lat * Math.PI) / 180
  const lngRad = (lng * Math.PI) / 180
  return new THREE_.Vector3(
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
  /** The globe mesh — the caller uses its `rotation` and `scale` for input. */
  readonly globe: THREE.Mesh
  /** World position the globe is anchored at (constant across session). */
  readonly globeAnchor: THREE.Vector3
  /**
   * Swap the globe texture. Pass `null` to revert to the base Earth
   * texture; `{ kind: 'video' }` to stream from an HTMLVideoElement
   * (live HLS stream); or `{ kind: 'image', element }` to use an
   * already-decoded HTMLImageElement. Idempotent — repeated calls
   * with an unchanged spec are no-ops.
   *
   * @param onReady Optional callback fired the moment the dataset
   *   texture is actually visible on the globe (not the placeholder
   *   base Earth shown during video decode wait). Fires synchronously
   *   for null specs (instant), images (already decoded), and videos
   *   that already have a frame buffered. For paused video that
   *   needs decode time, fires later from the `seeked` or `playing`
   *   listener.
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

  // Shader-uniform handle for the sun direction. Shared between the
  // Earth material's `onBeforeCompile` patch and the per-frame
  // `update()` which writes the current subsolar direction.
  const sunDirUniform = { value: new THREE_.Vector3(1, 0, 0) }

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
  const loadImage = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Failed to load ${url}`))
      img.src = url
    })

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
    },
    'earth diffuse',
  )

  // Lights — 2K → 4K only. 8K lights would be 256 MB on the GPU
  // for a detail the user rarely inspects closely.
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

  return {
    scene,
    globe,
    globeAnchor: globe.position.clone(),

    setTexture(spec, onReady) {
      // Skip if the spec is unchanged — repeated polls from the
      // session loop are a no-op in the steady state. Don't fire
      // onReady on a no-op either; the caller already saw the
      // previous ready signal.
      const nextKey = spec?.kind === 'video' ? spec.element : spec?.kind === 'image' ? spec.element : null
      if (nextKey === activeKey) return

      // Dispose any previously-loaded dataset texture. VideoTexture
      // holds a reference to the source <video> element and an
      // internal update scheduler; image Textures own a GPU buffer.
      if (activeDatasetTexture) {
        activeDatasetTexture.dispose()
        activeDatasetTexture = null
      }

      if (!spec) {
        // Restore the base Earth — diffuse if CDN loaded, specular
        // fallback otherwise — AND the night-lights emissive so the
        // day/night shader becomes visible again.
        material.map = baseDiffuseTexture ?? baseEarthTexture
        material.emissiveMap = lightsTexture
        material.emissive.setHex(0xffffff)
        activeKey = null
        // No dataset to wait for — readiness is immediate.
        onReady?.()
      } else if (spec.kind === 'video') {
        const video = spec.element
        activeKey = video

        // Dataset textures cover the entire globe uniformly, so
        // hide the night-lights emissive — otherwise they'd bleed
        // ADDITIVELY on top of the dataset's dark regions.
        material.emissiveMap = null
        material.emissive.setHex(0x000000)

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
          // each listener self-removes after firing.
          material.map = baseEarthTexture
          const onFrame = () => {
            // Guard: dataset may have changed while we waited.
            if (activeKey !== video) return
            material.map = tex
            material.needsUpdate = true
            onReady?.()
          }
          video.addEventListener('seeked', onFrame, { once: true })
          video.addEventListener('playing', onFrame, { once: true })
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
        // Dataset covers the globe uniformly — disable day/night
        // emissive gating (same rationale as the video branch).
        material.emissiveMap = null
        material.emissive.setHex(0x000000)
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

      // Refresh sun direction from real UTC time. The subsolar
      // point moves ~0.25° per minute, so updating every frame is
      // overkill but cheap; keeping it per-frame avoids a separate
      // throttled timer and guarantees the day/night terminator
      // stays correct if the user lingers in VR.
      const { lat, lng } = getSunPosition(new Date())
      const sunDir = sunDirectionFromLatLng(THREE_, lat, lng)
      sunDirUniform.value.copy(sunDir)
      // DirectionalLight convention: light shines FROM its position
      // TOWARD the origin. Place it along the sun direction at some
      // distance so shading matches the shader's uSunDir.
      sunLight.position.copy(sunDir).multiplyScalar(10)
    },

    dispose() {
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
      scene.remove(shadow)
      shadowGeometry.dispose()
      shadowMaterial.dispose()
      shadowTexture.dispose()
    },
  }
}
