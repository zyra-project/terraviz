/**
 * Three.js scene for the VR view.
 *
 * Thin wrapper around `photorealEarth.ts` — that module owns the full
 * photoreal Earth stack (diffuse + night lights + atmosphere + clouds
 * + sun + ground shadow). This file's job is the VR-specific framing:
 *   - Pick a scene background (deep space for VR, transparent for AR
 *     so the passthrough camera feed shows through).
 *   - Position the globe at eye height, arm's length ahead.
 *   - Re-export the legacy `VrSceneHandle` API so `vrSession.ts` and
 *     `vrInteraction.ts` don't have to change.
 *
 * See {@link file://./photorealEarth.ts photorealEarth.ts} for the
 * Earth stack itself, and
 * {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}
 * for the broader VR plan.
 */

import type * as THREE from 'three'
import {
  createPhotorealEarth,
  type PhotorealEarthHandle,
  type VrDatasetTexture,
} from './photorealEarth'

export type { VrDatasetTexture } from './photorealEarth'

/**
 * Globe placement in the local-floor reference space. Local-floor
 * places `y=0` at the user's standing floor, so `y=1.3` is roughly
 * eye-height for a seated user. `z=-1.5` puts the globe about
 * arm's-length ahead of them.
 */
const GLOBE_POSITION = { x: 0, y: 1.3, z: -1.5 }

/** Globe radius in metres. Pinch-zoom scales the mesh, this stays fixed. */
const GLOBE_RADIUS = 0.5

/** Clamps on zoom so the globe never vanishes into the user's head or flies off. */
export const MIN_GLOBE_SCALE = 0.3
export const MAX_GLOBE_SCALE = 2.5

export interface VrSceneHandle {
  /** The Three.js scene — attach/detach objects (controllers, HUD) here. */
  readonly scene: THREE.Scene
  /** The globe mesh — the caller uses its `rotation` and `scale` for input. */
  readonly globe: THREE.Mesh
  /**
   * Swap the globe texture. Pass `null` to revert to the photoreal
   * Earth; `{ kind: 'video' }` to stream from an HTMLVideoElement;
   * or `{ kind: 'image', element }` to use a decoded
   * HTMLImageElement. Idempotent.
   *
   * @param onReady Optional callback fired the moment the dataset
   *   texture is actually visible on the globe (not the placeholder
   *   base Earth shown during video decode wait). Fires synchronously
   *   for null specs, images, and already-buffered videos. For paused
   *   video that needs decode time, fires later from the `seeked` or
   *   `playing` listener.
   */
  setTexture(spec: VrDatasetTexture | null, onReady?: () => void): void
  /** Per-frame update — sun direction, atmosphere/shadow follow globe. */
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
  if (!transparentBackground) {
    scene.background = new THREE_.Color(0x000814) // deep space blue
  }

  const earth: PhotorealEarthHandle = createPhotorealEarth(THREE_, {
    radius: GLOBE_RADIUS,
    position: GLOBE_POSITION,
  })
  earth.addTo(scene)

  let disposed = false

  return {
    scene,
    globe: earth.globe,
    setTexture(spec, onReady) {
      earth.setTexture(spec, onReady)
    },
    update() {
      earth.update()
    },
    dispose() {
      if (disposed) return
      disposed = true
      earth.removeFrom(scene)
      earth.dispose()
    },
  }
}
