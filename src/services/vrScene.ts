/**
 * Three.js scene for the VR view.
 *
 * Builds a unit sphere in front of the user and swaps its texture
 * between a baked base Earth image and a live HLS `HTMLVideoElement`
 * depending on what the 2D app has loaded. The HUD (play/pause,
 * dataset title, exit button) lives in `vrHud.ts` and is attached by
 * the caller.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}.
 */

import type * as THREE from 'three'

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
 * Placeholder base Earth texture. Monochrome specular map shipped
 * with the repo; swapping this for a real Blue Marble equirectangular
 * is Phase 2 polish.
 */
const BASE_EARTH_TEXTURE_URL = '/assets/Earth_Specular_2K.jpg'

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

  // Ambient + directional. The base specular texture is monochrome
  // and looks dead flat without some shading; a single directional
  // light from "the sun" gives it enough form to read as a globe.
  // Once we swap in the video dataset, the directional light still
  // helps hint at the sphere's roundness.
  scene.add(new THREE_.AmbientLight(0xffffff, 0.6))
  const sun = new THREE_.DirectionalLight(0xffffff, 0.8)
  sun.position.set(2, 1.5, 1)
  scene.add(sun)

  // Load the base Earth texture. The TextureLoader fires async but
  // the material starts visible immediately (black sphere) and
  // updates when the decode lands — fine for MVP.
  const textureLoader = new THREE_.TextureLoader()
  const baseEarthTexture = textureLoader.load(BASE_EARTH_TEXTURE_URL)
  baseEarthTexture.colorSpace = THREE_.SRGBColorSpace

  const material = new THREE_.MeshStandardMaterial({
    map: baseEarthTexture,
    roughness: 0.95,
    metalness: 0.0,
  })

  // 64×64 is plenty for a globe that fills ~40° of the viewer's FOV.
  const geometry = new THREE_.SphereGeometry(GLOBE_RADIUS, 64, 64)
  const globe = new THREE_.Mesh(geometry, material)
  globe.position.set(GLOBE_POSITION.x, GLOBE_POSITION.y, GLOBE_POSITION.z)
  scene.add(globe)

  // Current dataset texture + a key for change detection. The key
  // lets vrSession compare cheaply each frame and call setTexture
  // only when the dataset actually changed.
  let activeDatasetTexture: THREE.Texture | null = null
  /** Identity of the currently-loaded spec — element reference for change detection. */
  let activeKey: HTMLVideoElement | HTMLImageElement | null = null

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
        material.map = baseEarthTexture
        activeKey = null
        // No dataset to wait for — readiness is immediate.
        onReady?.()
      } else if (spec.kind === 'video') {
        const video = spec.element
        activeKey = video

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
        material.map = tex
        activeKey = spec.element
        onReady?.()
      }
      material.needsUpdate = true
    },

    dispose() {
      if (activeDatasetTexture) {
        activeDatasetTexture.dispose()
        activeDatasetTexture = null
        activeKey = null
      }
      baseEarthTexture.dispose()
      material.dispose()
      geometry.dispose()
      scene.remove(globe)
    },
  }
}
