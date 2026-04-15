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

export interface VrSceneHandle {
  /** The Three.js scene — attach/detach objects (controllers, HUD) here. */
  readonly scene: THREE.Scene
  /** The globe mesh — the caller uses its `rotation` and `scale` for input. */
  readonly globe: THREE.Mesh
  /** World position the globe is anchored at (constant across session). */
  readonly globeAnchor: THREE.Vector3
  /** Swap the globe texture between VideoTexture and the base Earth image. Pass null to restore the base. */
  setVideo(video: HTMLVideoElement | null): void
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
 */
export function createVrScene(THREE_: typeof THREE): VrSceneHandle {
  const scene = new THREE_.Scene()
  scene.background = new THREE_.Color(0x000814) // deep space blue

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

  let activeVideoTexture: THREE.VideoTexture | null = null

  return {
    scene,
    globe,
    globeAnchor: globe.position.clone(),

    setVideo(video) {
      // Dispose any previous video texture — VideoTextures hold a
      // reference to the HTMLVideoElement and an internal scheduler.
      if (activeVideoTexture) {
        activeVideoTexture.dispose()
        activeVideoTexture = null
      }

      if (video) {
        const tex = new THREE_.VideoTexture(video)
        tex.colorSpace = THREE_.SRGBColorSpace
        tex.minFilter = THREE_.LinearFilter
        tex.magFilter = THREE_.LinearFilter
        activeVideoTexture = tex
        material.map = tex
      } else {
        material.map = baseEarthTexture
      }
      material.needsUpdate = true
    },

    dispose() {
      if (activeVideoTexture) {
        activeVideoTexture.dispose()
        activeVideoTexture = null
      }
      baseEarthTexture.dispose()
      material.dispose()
      geometry.dispose()
      scene.remove(globe)
    },
  }
}
