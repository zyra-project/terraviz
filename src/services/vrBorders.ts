/**
 * VR country/coastline borders overlay — a thin transparent shell
 * rendered just outside the globe surface so boundary lines sit on
 * top of whatever dataset texture is currently mapped to the globe.
 *
 * Parity goal: the 2D MapLibre app has a Tools menu "Borders" toggle
 * (also driven by tour `envShowWorldBorder` tasks) that layers
 * Natural Earth boundaries over the current dataset. Tours like
 * Carbon Tracker and SSP are genuinely hard to read without that
 * reference — the data texture alone shows a sphere of abstract
 * color, with no cue for where continents and oceans are. Before
 * this module, toggling borders in VR was a no-op because the 2D
 * Tools menu iterates MapLibre renderers only and the VR globe is
 * a Three.js sphere.
 *
 * Implementation: an equirectangular PNG (black lines on transparent
 * alpha) painted onto a sphere at radius * 1.001. Scales with the
 * globe via `setScale()`, tracks position and rotation via
 * `setPosition()` + `setQuaternion()` — kept as a sibling mesh
 * rather than a child of the globe so the caller (vrScene) can
 * batch transform updates at the same time as ground shadow sync.
 *
 * Texture is loaded lazily on first {@link VrBordersHandle.setVisible}
 * call — users who never enable borders never pay the ~635 KB
 * download. The texture is also shared across all globe slots in a
 * multi-globe arc via {@link setSharedBordersTexture} so a 4-globe
 * session fetches the asset once, not four times.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}
 * Phase 3.5 section.
 */

import type * as THREE from 'three'
import { getBordersTextureUrl } from '../utils/deviceCapability'
import { logger } from '../utils/logger'

/**
 * Radius multiplier relative to the globe. Just above 1 so the
 * shell sits visibly over the surface without obvious parallax
 * when the user leans in close.
 */
const BORDERS_RADIUS_FACTOR = 1.001

/**
 * Sphere tessellation. Borders use the same resolution as the
 * globe (64 × 64) so the lines don't ripple across low-poly edges
 * when the user rotates.
 */
const BORDERS_SEGMENTS = 64

/**
 * Lazy-loaded shared texture + promise. Returned by
 * {@link loadSharedBordersTexture}; disposed when the process-
 * level handle count drops to zero so repeated enter/exit cycles
 * don't leak.
 */
let sharedTexture: THREE.Texture | null = null
let sharedTexturePromise: Promise<THREE.Texture> | null = null
let sharedHandleRefCount = 0

/**
 * Fetch + cache the borders texture. Subsequent callers reuse the
 * same `Texture` instance — not a `.clone()`, because multiple
 * meshes sharing a single texture is well-supported in Three.js
 * and avoids duplicate GPU uploads.
 */
function loadSharedBordersTexture(THREE_: typeof THREE): Promise<THREE.Texture> {
  if (sharedTexture) return Promise.resolve(sharedTexture)
  if (sharedTexturePromise) return sharedTexturePromise
  const url = getBordersTextureUrl()
  sharedTexturePromise = new Promise<THREE.Texture>((resolve, reject) => {
    const loader = new THREE_.TextureLoader()
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE_.SRGBColorSpace
        tex.minFilter = THREE_.LinearFilter
        tex.magFilter = THREE_.LinearFilter
        tex.anisotropy = 4
        // Race: if every VrBorders handle was disposed while the
        // load was in flight, `sharedHandleRefCount` has already
        // reached 0 and the dispose() path took its cleanup shot
        // on a null `sharedTexture`. Releasing here prevents the
        // just-loaded texture from being cached + uploaded to the
        // GPU for a scene with no consumers; the next session
        // restart will kick a fresh load.
        if (sharedHandleRefCount === 0) {
          tex.dispose()
          sharedTexturePromise = null
          resolve(tex)
          return
        }
        sharedTexture = tex
        resolve(tex)
      },
      undefined,
      (err) => {
        sharedTexturePromise = null
        logger.warn('[VR borders] Failed to load texture:', err)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
  return sharedTexturePromise
}

export interface VrBordersHandle {
  readonly mesh: THREE.Mesh
  /**
   * Set visibility. First call to `true` triggers the lazy
   * texture load — the mesh stays invisible until the texture
   * arrives to avoid showing an untextured white sphere.
   */
  setVisible(visible: boolean): void
  /** Mirror the globe's world position each frame. */
  setPosition(x: number, y: number, z: number): void
  /** Mirror the globe's rotation so boundary lines stay aligned to landmasses. */
  setQuaternion(q: THREE.Quaternion): void
  /** Mirror the globe's uniform scale so pinch-zoom pulls borders along. */
  setScale(scalar: number): void
  dispose(): void
}

/**
 * Build a borders shell for one globe. `globeRadius` is the base
 * radius of the globe mesh in metres (0.5 for the VR default). The
 * shell is sized at `globeRadius * BORDERS_RADIUS_FACTOR`; scale
 * tracking in {@link VrBordersHandle.setScale} keeps the offset
 * proportional as the user pinch-zooms.
 *
 * The caller is responsible for adding {@link VrBordersHandle.mesh}
 * to the scene, calling the transform setters each frame, and
 * `dispose()` on session end.
 */
export function createVrBorders(
  THREE_: typeof THREE,
  globeRadius: number,
): VrBordersHandle {
  const geometry = new THREE_.SphereGeometry(
    globeRadius * BORDERS_RADIUS_FACTOR,
    BORDERS_SEGMENTS,
    BORDERS_SEGMENTS,
  )
  const material = new THREE_.MeshBasicMaterial({
    transparent: true,
    // Texture slot is filled in asynchronously once the PNG loads.
    // Until then, the mesh stays invisible via the .visible flag
    // below so we never flash an untextured shell.
    map: null,
    depthWrite: false,
    // `depthTest` STAYS enabled — unlike the HUD panels, borders
    // must read the globe's depth so lines on the back of the
    // sphere don't bleed through when the user is looking at the
    // near side. The 0.1% radius offset gives us the depth
    // headroom to avoid z-fighting with the globe surface.
  })
  const mesh = new THREE_.Mesh(geometry, material)
  mesh.visible = false
  // Render after the globe's dataset texture so alpha blend layers
  // lines on top rather than the globe writing over the shell.
  mesh.renderOrder = 1

  let textureLoadKicked = false
  /**
   * True iff this handle has incremented {@link sharedHandleRefCount}
   * at least once and hasn't yet decremented in dispose. Tracked
   * separately from `textureLoadKicked` so a failed-then-retried
   * load doesn't double-count, and a successful-then-disposed
   * handle decrements exactly once. Without this, a load-failure
   * path (`textureLoadKicked` reset to false, refcount still up)
   * would leak the refcount — the shared texture would never
   * decrement to zero across session cycles and would live in
   * GPU memory past its useful life.
   */
  let refIncremented = false
  let disposed = false

  function ensureTextureLoaded(): void {
    if (textureLoadKicked || disposed) return
    textureLoadKicked = true
    if (!refIncremented) {
      sharedHandleRefCount++
      refIncremented = true
    }
    void loadSharedBordersTexture(THREE_).then(
      (tex) => {
        if (disposed) return
        material.map = tex
        material.needsUpdate = true
      },
      () => {
        // loadSharedBordersTexture already logged; stay invisible on
        // failure rather than showing a broken white sphere. Clear
        // textureLoadKicked so a subsequent setVisible(true) can
        // retry (transient network failure during session entry).
        // Deliberately do NOT decrement `sharedHandleRefCount` here
        // — `refIncremented` stays true so dispose() decrements
        // exactly once, and a retry that succeeds reuses the ref
        // rather than double-counting.
        textureLoadKicked = false
        mesh.visible = false
      },
    )
  }

  return {
    mesh,

    setVisible(visible) {
      if (visible) {
        ensureTextureLoaded()
        // Only flip `visible` true if the texture is already ready —
        // otherwise wait for the load callback above to set the map
        // first (prevents a one-frame white sphere while the PNG
        // downloads).
        if (material.map) mesh.visible = true
        else {
          // Promise-based: become visible the instant the texture
          // resolves. Repeated setVisible(true) calls while loading
          // piggyback on the same promise thanks to the shared-cache
          // short-circuit at the top of loadSharedBordersTexture.
          void loadSharedBordersTexture(THREE_).then(() => {
            if (!disposed && material.map) mesh.visible = true
          }).catch(() => { /* handled above */ })
        }
      } else {
        mesh.visible = false
      }
    },

    setPosition(x, y, z) {
      mesh.position.set(x, y, z)
    },

    setQuaternion(q) {
      mesh.quaternion.copy(q)
    },

    setScale(scalar) {
      mesh.scale.setScalar(scalar)
    },

    dispose() {
      if (disposed) return
      disposed = true
      geometry.dispose()
      material.dispose()
      // Decrement based on `refIncremented` (whether we ever took
      // a ref) rather than `textureLoadKicked` (current load state):
      // a load that failed and reset `textureLoadKicked` must still
      // release its ref here.
      if (refIncremented) {
        refIncremented = false
        sharedHandleRefCount = Math.max(0, sharedHandleRefCount - 1)
        // Last consumer out of the process — drop the shared
        // texture so a subsequent cold session starts fresh. This
        // is rare in practice (user exits VR) but avoids a slow
        // GPU-memory leak across many session cycles.
        if (sharedHandleRefCount === 0 && sharedTexture) {
          sharedTexture.dispose()
          sharedTexture = null
          sharedTexturePromise = null
        }
      }
    },
  }
}
