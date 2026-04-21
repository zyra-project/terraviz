/**
 * Three.js scene for the VR view.
 *
 * Splits responsibilities cleanly between two modules:
 *
 *   - `photorealEarth.ts` owns the photoreal Earth stack (diffuse +
 *     night lights + specular glint + atmosphere + clouds + sun +
 *     ground shadow + day/night shader gated by real UTC sun
 *     position) for one globe. The primary globe delegates to it.
 *
 *   - This file owns the VR-specific framing (AR vs VR background,
 *     globe placement at eye height + arm's length), and the
 *     Phase 2.5 multi-globe scaffolding: up to 4 secondary globes
 *     laid out in an arc beside the primary, each driving its own
 *     dataset texture, all spinning in lockstep with the primary's
 *     quaternion (so SOS datasets' geographic projection stays
 *     aligned across the arc).
 *
 * Secondary globes use a simpler `MeshPhongMaterial` (no day/night
 * shader patch, no atmosphere, no clouds — those stay primary-only
 * decoration). They share the primary's progressive-CDN diffuse
 * texture via `earth.onBaseDiffuseChange`, so a secondary never
 * re-fetches the 2K/4K/8K tiers independently. Lockstep rotation
 * is per-frame in `update()`; promote-to-primary was removed in
 * `cead66d` and isn't reintroduced here.
 *
 * See {@link file://./photorealEarth.ts photorealEarth.ts} and
 * {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}.
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

/** Max simultaneous globes. Quest 2 has 1-2 H.264 decoders; 4 at
 *  the 4K/8K tier will push those hard. Capped defensively; the
 *  2D viewportManager typically drives 1/2/4. */
const MAX_PANELS = 4

export interface VrSceneHandle {
  /** The Three.js scene — attach/detach objects (controllers, HUD) here. */
  readonly scene: THREE.Scene
  /** The primary globe mesh — backward-compatible handle. vrInteraction uses this for single-hand drag. */
  readonly globe: THREE.Mesh
  /**
   * All globe meshes including the primary at index 0. Used by
   * vrInteraction for multi-globe raycast — grab-rotate picks up
   * whichever globe the controller is pointing at so surface-
   * pinned math stays correct across the arc. Rotation is always
   * written to the primary; secondaries copy its quaternion each
   * frame in scene.update(), so all globes spin in lockstep.
   */
  readonly allGlobes: THREE.Mesh[]
  /**
   * Set the number of visible globe slots. 1 = primary-only
   * (default, backward-compatible). 2+ = arc layout with
   * secondary globes alongside the primary. Creates/destroys
   * secondary globes as needed; the primary is always slot 0.
   * Idempotent — calls with an unchanged count are cheap no-ops.
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
   * Per-frame update — delegates to the photoreal Earth handle for
   * sun direction + atmosphere/shadow sync, then propagates the
   * primary's position/rotation/scale to every secondary globe so
   * the arc stays locked.
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
  if (!transparentBackground) {
    scene.background = new THREE_.Color(0x000814) // deep space blue
  }

  // Primary globe — delegate the photoreal stack to the factory.
  // Factory owns: material + day/night shader patch, atmosphere
  // shells, sun sprite, ground shadow, cloud overlay, progressive
  // diffuse/lights loading, ambient + sun light, per-frame
  // sun-direction update.
  const earth: PhotorealEarthHandle = createPhotorealEarth(THREE_, {
    radius: GLOBE_RADIUS,
    position: GLOBE_POSITION,
  })
  earth.addTo(scene)
  const globe = earth.globe

  // --- Secondary globes (Phase 2.5 multi-globe support) ---
  // When panelCount > 1, additional globe meshes are created at
  // arc positions alongside the primary. Each secondary gets a
  // basic MeshPhongMaterial (no day/night shader patch, no
  // atmosphere, no clouds — those are primary-only decoration).
  // All globes rotate in lockstep — grab-rotate writes to the
  // primary's quaternion; scene.update() copies it to each
  // secondary every frame. No tap-to-promote path ships in
  // Phase 2.5 (see cead66d for the ping-pong-bug rationale).

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

  /**
   * Shared shadow texture for all secondary globes (the primary has
   * its own managed by the factory). Created once and reused across
   * secondaries so we don't generate a canvas gradient per secondary.
   * Disposed in the scene's dispose().
   */
  const secondaryShadowTexture = (() => {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
      grad.addColorStop(0, 'rgba(0, 0, 0, 0.55)')
      grad.addColorStop(0.35, 'rgba(0, 0, 0, 0.28)')
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, 256, 256)
    }
    const tex = new THREE_.CanvasTexture(canvas)
    tex.colorSpace = THREE_.SRGBColorSpace
    tex.minFilter = THREE_.LinearFilter
    tex.magFilter = THREE_.LinearFilter
    return tex
  })()

  const secondaries: SecondaryGlobe[] = []
  /**
   * Stable array exposed as `VrSceneHandle.allGlobes` — mutated
   * (push/pop) by setPanelCount when secondaries are added or
   * removed. Returning the same reference each access avoids the
   * per-frame allocation that `[globe, ...secondaries.map(...)]`
   * would produce; vrInteraction reads this in its raycast and
   * ray-visuals hot paths.
   */
  const allGlobesArr: THREE.Mesh[] = [globe]

  /**
   * Nominal world-space position for slot `i` in an arc of `total`
   * globes, if the arc were laid out centered on `GLOBE_POSITION`.
   * Slots spread horizontally at 1.2 m center-to-center (0.2 m gap
   * between 0.5 m-radius spheres), same y + z.
   *
   * Only used internally by `syncSecondaryPositions()`, which
   * subtracts `arcPosition(0)` from higher slots to get slot offsets
   * relative to the primary — the primary's *actual* world position
   * is authoritative (written by AR anchoring or inherited from
   * `GLOBE_POSITION`), and the arc is placed as offsets from there.
   * Net effect: the layout is NOT centered on the primary — on a
   * 1→2 transition, the primary stays put and the new secondary
   * fans 1.2 m to its right. Centering by shifting primary on
   * panel-count changes is future work (needs reconciliation with
   * AR anchor preservation).
   */
  function arcPosition(i: number, total: number): { x: number; y: number; z: number } {
    if (total <= 1) return GLOBE_POSITION
    const spacing = GLOBE_RADIUS * 2 + 0.2
    const totalWidth = (total - 1) * spacing
    const x = GLOBE_POSITION.x - totalWidth / 2 + i * spacing
    return { x, y: GLOBE_POSITION.y, z: GLOBE_POSITION.z }
  }

  /** Build a simple secondary globe — basic Phong, no shader patches. */
  function createSecondaryGlobe(): SecondaryGlobe {
    const mat = new THREE_.MeshPhongMaterial({
      // Share the primary's current diffuse tier; the
      // `onBaseDiffuseChange` subscription below keeps this
      // up-to-date as higher tiers load.
      map: earth.baseDiffuseTexture ?? earth.baseEarthTexture,
      specular: new THREE_.Color(0x444444),
      shininess: 30,
    })
    const mesh = new THREE_.Mesh(
      new THREE_.SphereGeometry(GLOBE_RADIUS, 64, 64),
      mat,
    )
    scene.add(mesh)

    // Per-secondary ground shadow (same design as primary's shadow,
    // but using the shared `secondaryShadowTexture` above).
    const sMat = new THREE_.MeshBasicMaterial({
      map: secondaryShadowTexture,
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
   *
   * Note: primary stays at its current world position. The arc is
   * laid out RELATIVE to that position, so on a 1→2 transition
   * the new secondary fans 1.2 m to the primary's right rather
   * than both globes sliding to sit ±0.6 m about a common center.
   * Preserves AR anchoring (the user's placed globe doesn't jump)
   * at the cost of a slightly rightward-biased layout in
   * unanchored VR. Centering is follow-up polish.
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

  // Keep secondary globes' diffuse texture tracking the primary's
  // progressive tier — a secondary created before the 2K tier landed
  // would otherwise be stuck on the monochrome specular fallback
  // forever. Only updates dataset-free secondaries (those with a
  // loaded video/image keep their dataset texture until cleared).
  const unsubscribeDiffuse = earth.onBaseDiffuseChange(tex => {
    for (const sg of secondaries) {
      if (sg.activeKey === null) {
        sg.material.map = tex
        sg.material.needsUpdate = true
      }
    }
  })

  return {
    scene,
    globe,
    allGlobes: allGlobesArr,

    setPanelCount(count) {
      const desired = Math.max(1, Math.min(MAX_PANELS, count))
      const neededSecondaries = desired - 1
      // Early-return when the count hasn't changed. vrSession calls
      // this every frame, so this IS the common case; without the
      // guard the per-frame syncSecondaryPositions below would run
      // even in steady state.
      //
      // Critically: we DO NOT reposition the primary globe here.
      // globe.position is written by the AR anchor-pose sync and by
      // pinch-zoom-driven placement adjustments — those writes are
      // authoritative, and a per-frame reset to GLOBE_POSITION would
      // snap the globe back to its nominal spot every frame.
      if (secondaries.length === neededSecondaries) return
      while (secondaries.length < neededSecondaries) {
        const sg = createSecondaryGlobe()
        secondaries.push(sg)
        allGlobesArr.push(sg.mesh)
      }
      while (secondaries.length > neededSecondaries) {
        const sg = secondaries.pop()!
        disposeSecondary(sg)
        allGlobesArr.pop()
      }
      // Position the new secondaries relative to the primary's
      // current position. syncSecondaryPositions also runs every
      // frame in update(), so this first placement just avoids a
      // one-frame pop at the nominal spot when a secondary is
      // first created.
      syncSecondaryPositions()
    },

    setSlotTexture(slot, spec, onReady) {
      if (slot === 0) {
        earth.setTexture(spec, onReady)
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
      if (sg.cancelPendingVideoListeners) {
        sg.cancelPendingVideoListeners()
        sg.cancelPendingVideoListeners = null
      }
      if (sg.activeTexture) {
        sg.activeTexture.dispose()
        sg.activeTexture = null
      }

      if (!spec) {
        sg.material.map = earth.baseDiffuseTexture ?? earth.baseEarthTexture
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
          sg.material.map = earth.baseDiffuseTexture ?? earth.baseEarthTexture
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
      earth.setTexture(spec, onReady)
    },

    update() {
      // Factory handles: sun direction refresh (throttled), atmosphere
      // / cloud / shadow follow, sun sprite position, sun light
      // position. All of it tracks `globe.position` + `globe.scale`
      // which we preserve (grab-rotate writes to `globe.quaternion`,
      // not position).
      earth.update()

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
      unsubscribeDiffuse()
      earth.removeFrom(scene)
      earth.dispose()
      // Dispose all secondary globes and clear the shared
      // allGlobes array so any lingering references (debug
      // tooling, a late raycast from an in-flight XR frame) see
      // an empty layout instead of dangling mesh pointers.
      for (const sg of secondaries) {
        disposeSecondary(sg)
      }
      secondaries.length = 0
      allGlobesArr.length = 0
      secondaryShadowTexture.dispose()
    },
  }
}
