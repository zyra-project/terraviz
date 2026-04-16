/**
 * Spatial placement — anchor the globe to a real-world surface in
 * AR mode via WebXR `hit-test`.
 *
 * UX flow (Phase 2.1, Option 1 from the plan — explicit Place mode):
 *   1. User taps the floating Place button (small target icon
 *      near the HUD).
 *   2. Place mode activates: reticle appears wherever the
 *      controller ray intersects a real-world surface.
 *   3. User taps trigger anywhere → globe snaps to the reticle
 *      position (lifted a few cm so it visually rests on top of
 *      the surface rather than intersecting it).
 *   4. Place mode exits automatically; Place button returns.
 *
 * Falls back gracefully when `hit-test` is unavailable (VR mode,
 * older browsers, devices without scene understanding) — the Place
 * button stays hidden and the globe keeps its default position.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}
 * Phase 2.1 — spatial placement design.
 */

import type * as THREE from 'three'

// --- Reticle dimensions ---
/** Outer radius of the reticle ring. ~7 cm reads well at floor distance. */
const RETICLE_OUTER_RADIUS = 0.07
const RETICLE_TUBE = 0.004
/** Small filled centre dot so the reticle has a visible target point. */
const RETICLE_CENTER_RADIUS = 0.008

// --- Place button dimensions (a small floating disc near the HUD) ---
const PLACE_BUTTON_WIDTH = 0.06
const PLACE_BUTTON_HEIGHT = 0.06
const PLACE_BUTTON_CANVAS_SIZE = 256

/**
 * Base vertical offset added to the reticle position when placing
 * the globe at unit scale. The hit-test point is on the surface
 * itself; lifting by GLOBE_RADIUS (0.5 m) puts the globe's centre
 * half a metre above the surface so the visible bottom rests on
 * the table. The actual lift is scaled by the globe's current
 * uniform scale at placement time — see `liftedPlacementPosition`.
 */
const PLACE_LIFT_Y = 0.5

/**
 * Where the floating Place button sits relative to the globe.
 * Positioned just above the HUD (HUD is at y=1.0, z=-1.0) so it's
 * close enough to feel related but not overlapping.
 */
const PLACE_BUTTON_POSITION = { x: 0, y: 1.18, z: -1.0 }

const ACCENT_COLOR = 0x4da6ff // --color-accent

export interface VrPlacementHandle {
  /** Reticle group — caller adds to scene. Hidden until in Place mode + hit available. */
  readonly reticleGroup: THREE.Group
  /** Floating Place button mesh — caller adds to scene. Used as a raycast target. */
  readonly placeButtonMesh: THREE.Mesh
  /** True while user is in Place mode. */
  isPlacing(): boolean
  /** Programmatically toggle Place mode. */
  setPlacing(active: boolean): void
  /**
   * Per-frame update — call from the VR session render loop. Reads
   * a hit-test result from the controller's viewer-space ray and
   * positions the reticle there. No-op when not in Place mode or
   * when hit-test is unavailable.
   */
  update(frame: XRFrame, refSpace: XRReferenceSpace): void
  /**
   * Last successful reticle world position, or null if none. Used
   * by the placement-confirm flow to know where to put the globe.
   */
  getReticlePosition(): THREE.Vector3 | null
  /**
   * Latest XR hit-test result from the most recent successful
   * reticle frame, or null. Used by vrSession to create a
   * system-tracked anchor on placement — the anchor stays bolted
   * to the real surface across local-floor coord-system re-bases
   * (which happen every session on Quest), making the globe
   * actually stay put when the user exits and re-enters VR.
   */
  getLastHitTestResult(): XRHitTestResult | null
  /**
   * UV-space hit test on the Place button — analogous to vrHud's
   * hitTest. Returns 'place' if the UV falls inside the button,
   * null otherwise.
   */
  hitTestButton(uv: { x: number; y: number }): 'place' | null
  /** Release every GPU resource. Safe to call multiple times. */
  dispose(): void
}

/**
 * Draw the Place button canvas — a target / crosshair icon
 * inside a dark translucent disc with an accent border.
 */
function drawPlaceButton(ctx: CanvasRenderingContext2D, active: boolean): void {
  const w = PLACE_BUTTON_CANVAS_SIZE
  const h = PLACE_BUTTON_CANVAS_SIZE
  ctx.clearRect(0, 0, w, h)

  // Background disc
  ctx.fillStyle = active ? 'rgba(77, 166, 255, 0.85)' : 'rgba(13, 13, 18, 0.75)'
  ctx.beginPath()
  ctx.arc(w / 2, h / 2, w / 2 - 8, 0, Math.PI * 2)
  ctx.fill()

  // Accent ring border
  ctx.strokeStyle = active ? '#fff' : `rgba(77, 166, 255, 0.85)`
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.arc(w / 2, h / 2, w / 2 - 8, 0, Math.PI * 2)
  ctx.stroke()

  // Inner crosshair / target icon
  ctx.strokeStyle = active ? '#fff' : '#e8eaf0'
  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  const center = w / 2
  const armLen = 36
  const innerGap = 12
  // Horizontal
  ctx.beginPath()
  ctx.moveTo(center - innerGap - armLen, center)
  ctx.lineTo(center - innerGap, center)
  ctx.moveTo(center + innerGap, center)
  ctx.lineTo(center + innerGap + armLen, center)
  ctx.stroke()
  // Vertical
  ctx.beginPath()
  ctx.moveTo(center, center - innerGap - armLen)
  ctx.lineTo(center, center - innerGap)
  ctx.moveTo(center, center + innerGap)
  ctx.lineTo(center, center + innerGap + armLen)
  ctx.stroke()
  // Center dot
  ctx.fillStyle = active ? '#fff' : '#e8eaf0'
  ctx.beginPath()
  ctx.arc(center, center, 6, 0, Math.PI * 2)
  ctx.fill()
}

export function createVrPlacement(
  THREE_: typeof THREE,
  hitTestSource: XRHitTestSource | null,
): VrPlacementHandle {
  // --- Reticle ---
  // Thin ring + center dot, lying flat on whatever surface the
  // hit-test resolves to. Lit additively so it pops against both
  // dark VR void and bright AR passthrough.
  const reticleGroup = new THREE_.Group()

  const ringGeometry = new THREE_.TorusGeometry(RETICLE_OUTER_RADIUS, RETICLE_TUBE, 8, 48)
  const ringMaterial = new THREE_.MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  })
  const ring = new THREE_.Mesh(ringGeometry, ringMaterial)
  // Torus default plane is XY; rotate so it lies flat on XZ (floor).
  ring.rotation.x = -Math.PI / 2
  reticleGroup.add(ring)

  const centerGeometry = new THREE_.SphereGeometry(RETICLE_CENTER_RADIUS, 12, 12)
  const centerMaterial = new THREE_.MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  })
  const center = new THREE_.Mesh(centerGeometry, centerMaterial)
  reticleGroup.add(center)

  reticleGroup.renderOrder = 11 // above HUD (10), below the laser dot (12)
  reticleGroup.visible = false

  // --- Place button ---
  // Floating disc with target/crosshair icon. Renders as a flat
  // billboard plane via CanvasTexture; vrInteraction raycasts it
  // alongside the HUD and globe.
  const placeCanvas = document.createElement('canvas')
  placeCanvas.width = PLACE_BUTTON_CANVAS_SIZE
  placeCanvas.height = PLACE_BUTTON_CANVAS_SIZE
  const placeCtxOrNull = placeCanvas.getContext('2d')
  if (!placeCtxOrNull) throw new Error('[VR placement] 2D canvas context unavailable')
  // Reassign to a non-nullable local so the closure below can use
  // it without the TypeScript narrowing being lost.
  const placeCtx: CanvasRenderingContext2D = placeCtxOrNull
  drawPlaceButton(placeCtx, false)

  const placeTexture = new THREE_.CanvasTexture(placeCanvas)
  placeTexture.colorSpace = THREE_.SRGBColorSpace
  placeTexture.minFilter = THREE_.LinearFilter
  placeTexture.magFilter = THREE_.LinearFilter

  const placeMaterial = new THREE_.MeshBasicMaterial({
    map: placeTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const placeGeometry = new THREE_.PlaneGeometry(PLACE_BUTTON_WIDTH, PLACE_BUTTON_HEIGHT)
  const placeButtonMesh = new THREE_.Mesh(placeGeometry, placeMaterial)
  placeButtonMesh.position.set(
    PLACE_BUTTON_POSITION.x,
    PLACE_BUTTON_POSITION.y,
    PLACE_BUTTON_POSITION.z,
  )
  placeButtonMesh.renderOrder = 10
  // Hidden by default — vrSession reveals it once it confirms
  // hit-test is supported on this session.
  placeButtonMesh.visible = false

  // --- State ---
  let placing = false
  /**
   * Latest hit position from per-frame hit-test. Single allocated
   * Vector3 reused each frame via `.copy()` — previous version
   * re-allocated with `scratch.clone()` every frame during Place
   * mode, which shows up as GC churn during a long placement
   * hold. `lastHitValid` tracks whether the stored pose is current.
   */
  const lastHitPosition = new THREE_.Vector3()
  let lastHitValid = false
  /**
   * The raw XR hit-test result from the most recent frame. Kept so
   * vrSession can call `createAnchor()` on it at placement-confirm
   * time. Cleared when the reticle loses its surface.
   */
  let lastHitResult: XRHitTestResult | null = null
  /** Scratch vector for hit-test result extraction. */
  const scratch = new THREE_.Vector3()

  function refreshPlaceButtonAppearance(): void {
    drawPlaceButton(placeCtx, placing)
    placeTexture.needsUpdate = true
  }

  return {
    reticleGroup,
    placeButtonMesh,

    isPlacing() {
      return placing
    },

    setPlacing(active) {
      if (placing === active) return
      placing = active
      refreshPlaceButtonAppearance()
      if (!active) {
        reticleGroup.visible = false
        lastHitValid = false
        lastHitResult = null
      }
    },

    update(frame, refSpace) {
      // Only do hit-test work while in Place mode — saves the
      // per-frame WebXR call when the user isn't actively placing.
      if (!placing || !hitTestSource) {
        if (reticleGroup.visible) reticleGroup.visible = false
        return
      }
      const hits = frame.getHitTestResults(hitTestSource)
      if (hits.length === 0) {
        // Lost the surface — keep reticle hidden, lastHitPosition
        // stays null so a confirm tap won't place spuriously.
        reticleGroup.visible = false
        lastHitValid = false
        lastHitResult = null
        return
      }
      const pose = hits[0].getPose(refSpace)
      if (!pose) {
        reticleGroup.visible = false
        lastHitValid = false
        lastHitResult = null
        return
      }
      // Keep the raw hit-test result around — vrSession will call
      // `createAnchor()` on it at placement-confirm time.
      lastHitResult = hits[0]
      scratch.set(
        pose.transform.position.x,
        pose.transform.position.y,
        pose.transform.position.z,
      )
      reticleGroup.position.copy(scratch)
      reticleGroup.visible = true
      // Reuse the same Vector3 instead of cloning every frame.
      lastHitPosition.copy(scratch)
      lastHitValid = true
    },

    getReticlePosition() {
      // Clone here (not per-frame) so callers can safely store the
      // returned Vector3 without worrying about us mutating it the
      // next frame. Called once per placement-confirm tap — cheap.
      return lastHitValid ? lastHitPosition.clone() : null
    },

    getLastHitTestResult() {
      return lastHitResult
    },

    hitTestButton(uv) {
      if (!placeButtonMesh.visible) return null
      // Inside the disc — UV in the unit square, treat as inside if
      // we're roughly within the visible disc region (no fancy
      // circular hit-test; full square is fine for a button this
      // small).
      if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return null
      return 'place'
    },

    dispose() {
      ringGeometry.dispose()
      ringMaterial.dispose()
      centerGeometry.dispose()
      centerMaterial.dispose()
      placeGeometry.dispose()
      placeMaterial.dispose()
      placeTexture.dispose()
    },
  }
}

/**
 * Compute the world position the globe should occupy when placed at
 * a hit-test point. The hit point is ON the surface; lifting by
 * `PLACE_LIFT_Y * scale` puts the globe's centre above the surface
 * so the visible bottom rests on top — the multiplication by scale
 * is critical because the globe is user-zoomable and a constant
 * lift would leave a zoomed-up globe floating above the surface
 * (or a zoomed-down globe sunken into it).
 *
 * Accepts any object with {x, y, z} numeric fields — lets callers
 * pass either a `THREE.Vector3` (placement-confirm callback) or a
 * `DOMPointReadOnly` direct from `anchorPose.transform.position`
 * (per-frame anchor sync) without conversion.
 *
 * @param scale Current uniform globe scale (e.g. `globe.scale.x`).
 *   Used to scale the lift so the visible bottom stays on the
 *   surface at any zoom level.
 * @param out Optional target to write into. Hot paths (per-frame
 *   anchor pose sync) pass the globe's own position vector to
 *   avoid allocation; one-shot paths can omit and get a new one.
 */
export function liftedPlacementPosition(
  THREE_: typeof THREE,
  hitPosition: { x: number; y: number; z: number },
  scale: number,
  out?: THREE.Vector3,
): THREE.Vector3 {
  const target = out ?? new THREE_.Vector3()
  target.set(hitPosition.x, hitPosition.y + PLACE_LIFT_Y * scale, hitPosition.z)
  return target
}
