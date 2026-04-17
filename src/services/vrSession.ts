/**
 * WebXR session lifecycle.
 *
 * Orchestrates the Three.js import, renderer creation, XR session
 * request, per-frame loop, and teardown. This is the only module
 * that `main.ts` talks to directly — everything else
 * (scene / hud / interaction) is built and torn down here.
 *
 * Three.js is lazy-imported on the first call to {@link enterVr} —
 * desktop web, Tauri, and mobile browsers (where
 * {@link isImmersiveVrSupported} returns false) never fetch the
 * chunk. Same pattern used for Tauri plugins elsewhere in the
 * codebase.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}.
 */

import type * as THREE from 'three'
import { createVrScene, type VrSceneHandle, type VrDatasetTexture } from './vrScene'
import { createVrHud, type VrHudHandle } from './vrHud'
import { createVrInteraction, type VrInteractionHandle } from './vrInteraction'
import { createVrLoading, type VrLoadingHandle } from './vrLoading'
import { createVrPlacement, liftedPlacementPosition, type VrPlacementHandle } from './vrPlacement'
import {
  clearPersistedAnchorHandle,
  loadPersistedAnchorHandle,
  savePersistedAnchorHandle,
} from '../utils/vrPersistence'
import { logger } from '../utils/logger'

/**
 * Contract the hosting app must provide. Pull-based: the session
 * polls these getters once per frame and reflects the values in the
 * HUD / scene. Keeps the VR modules decoupled from the specifics of
 * MapLibre / HLSService / viewportManager.
 */
export interface VrSessionContext {
  /**
   * The currently-loaded dataset's surface texture for the PRIMARY
   * panel. Backward-compatible convenience that equals
   * `getPanelTexture(getPrimaryIndex())`. Kept for single-globe
   * callers that don't care about the multi-panel model.
   */
  getDatasetTexture(): VrDatasetTexture | null
  /** Dataset title for the HUD (primary panel). null/empty → "No dataset loaded". */
  getDatasetTitle(): string | null
  /** True iff a video dataset is loaded on the primary — drives the HUD play/pause button visibility. */
  hasVideoDataset(): boolean
  /** Drives the HUD play/pause icon. Reflects the primary panel's state. */
  isPlaying(): boolean
  /** Called when the user taps play/pause in VR. Toggles the primary's video. */
  togglePlayPause(): void

  // --- Phase 2.5 multi-panel getters ---
  //
  // These let vrSession mirror the 2D app's viewport manager
  // inside VR. When the 2D app is in 2-globe layout, `getPanelCount`
  // returns 2, each panel has its own texture / title, and one
  // slot is designated primary (drives the HUD + playback
  // transport). Hitting a non-primary globe in VR promotes its
  // slot via `promotePanel` (Phase 2.5 commit 5).

  /** Current number of globe panels (1/2/4). Sourced from the 2D viewport manager. */
  getPanelCount(): number
  /** Which slot is currently primary — drives the HUD + singular playback transport. */
  getPrimaryIndex(): number
  /** Dataset texture for a specific slot, or null if no dataset loaded in that slot. */
  getPanelTexture(slot: number): VrDatasetTexture | null
  /** Dataset title for a specific slot, for per-panel labels; null if no dataset. */
  getPanelTitle(slot: number): string | null
  /**
   * Promote a slot to primary. Called by vrInteraction when the
   * user taps a non-primary globe. The 2D app's viewportManager
   * owns the primary-index state; this callback forwards the
   * change so both sides stay in sync.
   */
  promotePanel(slot: number): void

  /** Optional — fired after the session ends + resources are torn down. */
  onSessionEnd?: () => void
}

/**
 * Lazy Three.js loader. First call triggers the dynamic import and
 * kicks off the bundle fetch; subsequent calls reuse the cached
 * promise. Safe to call from feature-detect warm-up paths too.
 */
let threePromise: Promise<typeof import('three')> | null = null
export function loadThree(): Promise<typeof import('three')> {
  return (threePromise ??= import('three'))
}

/**
 * Handles for the current session. Single-session design — we don't
 * support entering VR twice concurrently, so a module-level ref is
 * fine and simplifies `isActive()` / teardown.
 */
interface ActiveSession {
  session: XRSession
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  scene: VrSceneHandle
  hud: VrHudHandle
  interaction: VrInteractionHandle
  /** Loading scene shown during entry; null after fade-out + dispose. */
  loading: VrLoadingHandle | null
  /** AR-only spatial placement (hit-test reticle + Place button). Null when hit-test unavailable. */
  placement: VrPlacementHandle | null
  /** Reference space passed to per-frame hit-test resolution. */
  refSpace: XRReferenceSpace | null
  /**
   * The viewer-space hit-test source used by placement. Stored
   * here so the session-end teardown can explicitly cancel it and
   * release platform-side tracking resources.
   */
  hitTestSource: XRHitTestSource | null
}

let active: ActiveSession | null = null

/** True while a VR session is live. */
export function isVrActive(): boolean {
  return active !== null
}

/** Which immersive mode to enter. `vr` = full immersive, `ar` = passthrough. */
export type VrMode = 'vr' | 'ar'

/**
 * Request an immersive WebXR session (VR or AR passthrough), build
 * the Three.js scene, attach controllers, and start the render loop.
 * Rejects if the browser refuses the session (user denied permission,
 * no device, etc.). On success, resolves once the session is fully
 * live — the user will be in the headset at that point.
 *
 * Calling while a session is already active is a no-op.
 *
 * AR mode (`mode === 'ar'`) requests `immersive-ar` and configures
 * the renderer + scene for transparent rendering, so the Quest
 * passthrough camera feed shows behind the floating globe and HUD.
 * Visually identical to VR mode for everything in the scene; only
 * the surrounding "void" changes from black to the user's room.
 */
export async function enterImmersive(mode: VrMode, ctx: VrSessionContext): Promise<void> {
  if (active) {
    logger.warn(`[VR] enterImmersive(${mode}) called while a session is already active`)
    return
  }
  if (!navigator.xr) {
    throw new Error('WebXR is not available in this browser')
  }

  const THREE_ = await loadThree()
  const isAr = mode === 'ar'
  const sessionMode = isAr ? 'immersive-ar' : 'immersive-vr'

  // --- Renderer + canvas ---
  // The canvas doesn't display anything while the session is live
  // (the headset takes over), but Three.js still needs a DOM-
  // attached canvas for the WebGL context to behave correctly. We
  // inject a small offscreen-like host and remove it on teardown.
  const canvas = document.createElement('canvas')
  canvas.id = 'vr-canvas'
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.pointerEvents = 'none'
  // Hide under the existing 2D UI so it doesn't flash during the
  // transition. Display:none would prevent GL context creation, so
  // use zero opacity instead.
  canvas.style.opacity = '0'
  document.body.appendChild(canvas)

  const renderer = new THREE_.WebGLRenderer({
    canvas,
    antialias: true,
    // AR passthrough requires alpha so the framebuffer can clear to
    // transparent and reveal the camera feed; VR keeps it disabled
    // for a slight performance edge (one less blend pass per pixel).
    alpha: isAr,
  })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.xr.enabled = true

  // Camera: a default perspective is fine — Three.js' XR layer
  // overrides projection / view matrices from the XR views, so
  // these values are only used for inline rendering (which we skip).
  const camera = new THREE_.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100)

  // --- Request the session ---
  // hit-test is requested as OPTIONAL for AR sessions so the
  // session still starts on browsers/devices without the feature
  // — placement just won't be available in that case. Skipped
  // entirely for VR (no real-world geometry to hit-test against).
  const optionalFeatures: string[] = []
  if (isAr) {
    optionalFeatures.push('hit-test')
    // Anchors let us bolt the globe to a real-world surface and
    // have it stay there across tracking adjustments (within a
    // session) and across sessions (via Meta's persistent-handle
    // extension). Core to the "globe actually stays on my table"
    // UX. Optional because not all UAs implement anchors yet.
    optionalFeatures.push('anchors')
  }
  let session: XRSession
  try {
    session = await navigator.xr.requestSession(sessionMode, {
      requiredFeatures: ['local-floor'],
      ...(optionalFeatures.length > 0 ? { optionalFeatures } : {}),
    })
  } catch (err) {
    canvas.remove()
    renderer.dispose()
    throw err instanceof Error ? err : new Error(String(err))
  }

  // Bind the session to the renderer. Three.js handles
  // makeXRCompatible + baseLayer setup internally.
  try {
    await renderer.xr.setSession(session as unknown as XRSession)
  } catch (err) {
    await session.end().catch(() => { /* already gone */ })
    canvas.remove()
    renderer.dispose()
    throw err instanceof Error ? err : new Error(String(err))
  }

  // Lazy-load the controller-model addon alongside Three.js. The
  // factory fetches per-controller glTF models from a CDN at runtime
  // (e.g. Quest Touch), so the addon itself is small but enables a
  // big polish win: users see their actual controllers in VR.
  //
  // IMPORTANT: this import must complete before `setTexture`'s
  // synchronous onReady callback can schedule the loading-scene
  // fade-out. If we awaited this AFTER setTexture, a cold-cache
  // download could exceed the fade-out setTimeout's 250 ms delay
  // — `active` would still be null when the timeout fires and the
  // loading scene would get stuck visible. Moving the import here
  // guarantees it's resolved before `active` needs to be set.
  const { XRControllerModelFactory } = await import(
    'three/examples/jsm/webxr/XRControllerModelFactory.js'
  )

  // --- Build the scene ---
  // AR mode → transparent background so the passthrough camera feed
  // shows behind everything we render.
  const scene = createVrScene(THREE_, isAr)
  const hud = createVrHud(THREE_)
  scene.scene.add(hud.mesh)

  // --- Spatial placement (AR-only) + local-floor ref space ---
  // Two separable capabilities:
  //
  //   (a) local-floor reference space — used for resolving ANCHOR
  //       poses each frame (`frame.getPose(anchor.anchorSpace,
  //       refSpace)`). An anchor restored from a persistent handle
  //       needs this even if the user never enters Place mode in
  //       the current session. Requesting it independently means
  //       anchor-based placement keeps working on devices that
  //       expose anchors but not hit-test.
  //
  //   (b) hit-test source — used by Place mode to project a
  //       reticle onto real-world geometry. Optional; older
  //       browsers may not support it. When unavailable, the
  //       Place button stays hidden but restored anchors still
  //       track via (a).
  //
  // Both are AR-only; VR sessions have no real-world geometry.
  let hitTestSource: XRHitTestSource | null = null
  let placementRefSpace: XRReferenceSpace | null = null
  if (isAr) {
    try {
      placementRefSpace = await session.requestReferenceSpace('local-floor')
    } catch (err) {
      logger.debug('[VR] local-floor reference space unavailable:', err)
    }

    if ('requestHitTestSource' in session) {
      try {
        const viewerSpace = await session.requestReferenceSpace('viewer')
        // requestHitTestSource is on the session interface but not
        // in all type defs; cast to get a typed handle.
        const reqHts = (session as unknown as {
          requestHitTestSource?: (init: { space: XRReferenceSpace }) => Promise<XRHitTestSource>
        }).requestHitTestSource
        if (reqHts) {
          hitTestSource = await reqHts.call(session, { space: viewerSpace })
        }
      } catch (err) {
        logger.debug('[VR] hit-test setup failed; spatial placement disabled:', err)
      }
    }
  }
  const placement = isAr ? createVrPlacement(THREE_, hitTestSource) : null
  if (placement) {
    scene.scene.add(placement.reticleGroup)
    scene.scene.add(placement.placeButtonMesh)
    // Reveal the Place button only if we actually have a hit-test
    // source to back it up. Without one, tapping it would be a
    // no-op and confusing.
    if (hitTestSource) {
      placement.placeButtonMesh.visible = true
    }
  }

  // --- Restore persisted placement via WebXR Anchor (AR only) ---
  // See src/utils/vrPersistence.ts for why we use anchors instead of
  // saved coordinates: Quest's local-floor space is re-based every
  // session, so a saved (x, y, z) corresponds to a different
  // physical location each time. Anchors are system-tracked and
  // stable across sessions.
  //
  // Kept as a mutable session-level handle because the anchor is
  // created/restored asynchronously (may land after the first
  // render frame) and then drives the globe position per-frame.
  let currentAnchor: XRAnchor | null = null
  if (isAr) {
    const savedHandle = loadPersistedAnchorHandle()
    if (savedHandle) {
      const restoreFn = (session as unknown as {
        restorePersistentAnchor?: (uuid: string) => Promise<XRAnchor>
      }).restorePersistentAnchor
      if (restoreFn) {
        try {
          currentAnchor = await restoreFn.call(session, savedHandle)
          logger.info('[VR] Restored persistent placement anchor')
        } catch (err) {
          logger.warn('[VR] Failed to restore persistent anchor; clearing handle:', err)
          clearPersistedAnchorHandle()
        }
      }
    }
  }

  // --- Loading scene ---
  // Visible from the moment the session starts until the dataset
  // texture has a decoded frame on the globe. Hides the real globe
  // + HUD initially so the user sees a clean transition.
  const loading = createVrLoading(THREE_)
  scene.scene.add(loading.group)
  scene.globe.visible = false
  hud.mesh.visible = false
  // Most of the slow part (Three.js download, session request) is
  // already done by the time we reach this point — most of the visible
  // loading time is the texture-decode wait. Start at a meaningful
  // baseline so the user sees motion not "stuck at 0%".
  loading.setProgress(0.6, 'Building scene\u2026')

  // Initial HUD state + texture. Wait for texture readiness before
  // hiding the loading scene; for video this can take several hundred
  // ms (the forced seek decode). For images / no dataset the
  // callback fires synchronously during setTexture — BEFORE `active`
  // is assigned below, so we can't reference it directly in the
  // callback. Work with the captured `loading` handle instead and
  // defer the lifecycle work to a setTimeout where `active` is
  // guaranteed to exist.
  loading.setProgress(0.8, 'Loading dataset\u2026')
  let loadingFinalized = false
  /**
   * True once the loading scene has been removed + disposed — by
   * either the fade-out path or the session-end teardown path.
   * Guards against double-disposal if both fire (session ends
   * during fade-out).
   */
  let loadingDisposed = false
  /**
   * Handle for the fade-out setTimeout, captured so the session-end
   * teardown can cancel it if the user exits during the 250 ms
   * pre-fade pause. Without this the setTimeout would still fire
   * and call loading.fadeOut() on an already-disposed handle.
   */
  let fadeTimeoutId: ReturnType<typeof setTimeout> | null = null
  scene.setTexture(ctx.getDatasetTexture(), () => {
    // Idempotent — a follow-up texture swap could re-fire this;
    // we only want to drive the fade once per session.
    if (loadingFinalized) return
    loadingFinalized = true
    loading.setProgress(1.0, 'Ready')
    // Brief pause at 100% so the user perceives completion, then
    // fade. Work with the captured `loading` + `scene` + `hud`
    // references rather than `active` here — those exist from the
    // moment createVrScene/Hud return, whereas `active` is only
    // populated later in the function and may not be set yet when
    // the synchronous onReady path fires. Previous version tested
    // `if (!active) return` here and got stuck on first AR entry
    // when the controller-factory import exceeded the 250 ms delay.
    fadeTimeoutId = setTimeout(() => {
      fadeTimeoutId = null
      // If the session ended while we were waiting, the end handler
      // already disposed loading — skip the fade work entirely.
      if (loadingDisposed) return
      void loading.fadeOut().then(() => {
        // Session-end during fade: same guard, same reason.
        if (loadingDisposed) return
        loadingDisposed = true
        scene.scene.remove(loading.group)
        loading.dispose()
        if (active) active.loading = null
        // Reveal the real scene now that loading has cleared.
        scene.globe.visible = true
        hud.mesh.visible = true
      })
    }, 250)
  })
  hud.setState({
    datasetTitle: ctx.getDatasetTitle(),
    isPlaying: ctx.isPlaying(),
    hasVideo: ctx.hasVideoDataset(),
  })

  // XRControllerModelFactory was imported earlier (before scene
  // construction) so the loading-scene fade-out timing stays
  // predictable — see the comment at that import.
  const interaction = createVrInteraction(THREE_, XRControllerModelFactory, {
    scene: scene.scene,
    globe: scene.globe,
    hud,
    placement,
    renderer,
    onHudAction: (action) => {
      if (action === 'play-pause') {
        ctx.togglePlayPause()
      } else if (action === 'exit-vr') {
        // Programmatic exit — fires the 'end' event, which routes
        // through the same teardown path as headset-initiated exits.
        void session.end().catch(err =>
          logger.warn('[VR] session.end() from exit-vr button failed:', err),
        )
      }
    },
    onPlaceButton: () => {
      // Toggle Place mode. Re-tap exits without placing.
      placement?.setPlacing(!placement.isPlacing())
    },
    onPlaceConfirm: () => {
      const hit = placement?.getReticlePosition()
      if (!hit) return
      // Move the globe right away so the visual response is
      // immediate. The anchor creation (below) is async; if it
      // succeeds, per-frame anchor-pose tracking will take over
      // the globe's position next frame with no visible jump
      // since the anchor's pose matches the hit point we just set.
      const target = liftedPlacementPosition(THREE_, hit, scene.globe.scale.x)
      scene.globe.position.copy(target)
      placement?.setPlacing(false)

      // Create a system-tracked anchor from the raw hit-test
      // result. The anchor stays bolted to the real surface even
      // when the local-floor coord frame shifts (which happens
      // every new session). Replaces any previous anchor.
      const hitResult = placement?.getLastHitTestResult()
      const createFn = hitResult?.createAnchor
      if (!hitResult || !createFn) return

      void createFn.call(hitResult).then(async anchor => {
        // Swap out any prior anchor. Only one active at a time —
        // the previous placement's anchor is no longer needed.
        if (currentAnchor) {
          try { currentAnchor.delete() } catch { /* already gone */ }
        }
        currentAnchor = anchor

        // Persistent handle for cross-session restore. Meta Quest
        // exposes this via the Anchors module extension; other
        // browsers may not. Non-fatal if it throws — the anchor
        // still tracks within this session.
        const requestFn = anchor.requestPersistentHandle
        if (!requestFn) return
        try {
          const handle = await requestFn.call(anchor)
          savePersistedAnchorHandle(handle)
          logger.info('[VR] Saved persistent placement anchor')
        } catch (err) {
          logger.debug('[VR] Anchor persistent handle not available:', err)
        }
      }).catch(err => {
        logger.warn('[VR] Failed to create placement anchor:', err)
      })
    },
    onExit: () => {
      void session.end().catch(err =>
        logger.warn('[VR] session.end() from grip failed:', err),
      )
    },
  })

  active = {
    session,
    renderer,
    camera,
    scene,
    hud,
    interaction,
    loading,
    placement,
    refSpace: placementRefSpace,
    hitTestSource,
  }

  // --- Render loop ---
  //
  // HUD + Place button follow the globe via these offsets — so when
  // the user places the globe on a real surface (AR mode), the
  // controls track underneath it rather than staying at some fixed
  // spot in mid-air. Large -y offset (more negative than globe
  // radius) ensures they're clearly BELOW the globe's visible
  // silhouette even when looking straight at the globe. Small +z
  // offset pulls them slightly closer to the user than the globe
  // for comfortable reading.
  const hudOffset = new THREE_.Vector3(0, -0.65, 0.15)
  const placeOffset = new THREE_.Vector3(0, -0.5, 0.15)
  /** Scratch reused per-frame for position math; avoids GC churn. */
  const scratchPos = new THREE_.Vector3()
  // `lastTime` starts null so the very first frame uses its own
  // timestamp as "previous" and computes a 0-duration delta —
  // rather than mixing XR's frame timestamp (first callback arg)
  // with performance.now() from pre-loop init, which can be on a
  // different clock and produce a huge first delta.
  let lastTime: number | null = null
  renderer.setAnimationLoop((time, frame) => {
    // `??` instead of `||` — some XR implementations emit a valid
    // timestamp of 0 on the very first frame, which `||` would
    // falsely treat as "no time" and fall back to performance.now(),
    // mixing clocks.
    const now = time ?? performance.now()
    const previousTime = lastTime ?? now
    const delta = Math.min(0.1, (now - previousTime) / 1000)
    lastTime = now

    if (!active) return

    // Spatial placement: per-frame hit-test against the room. Only
    // does work while in Place mode; cheap when idle.
    if (active.placement && frame && active.refSpace) {
      active.placement.update(frame, active.refSpace)
    }

    // Sync globe position from the system-tracked anchor, if any.
    // The anchor's anchorSpace is resolved in local-floor coords
    // each frame — but critically, the system adjusts what
    // "(anchor.x, anchor.y, anchor.z)" means as local-floor gets
    // re-based, so the globe stays bolted to the real surface.
    // Lift offset (PLACE_LIFT_Y, owned by vrPlacement) keeps the
    // visible bottom resting on the surface. Writing directly into
    // globe.position avoids per-frame allocation.
    if (currentAnchor && frame && active.refSpace) {
      const anchorPose = frame.getPose(currentAnchor.anchorSpace, active.refSpace)
      if (anchorPose) {
        // Lift is scaled by globe's current uniform scale so the
        // visible bottom stays on the real surface even when the
        // user has zoomed the globe larger or smaller.
        liftedPlacementPosition(
          THREE_,
          anchorPose.transform.position,
          active.scene.globe.scale.x,
          active.scene.globe.position,
        )
      }
    }

    // Swap the dataset texture if the app loaded/changed something
    // while we're in VR. The scene's setTexture is internally
    // debounced (compares against its own active key) so polling
    // every frame is cheap in the steady state.
    active.scene.setTexture(ctx.getDatasetTexture())

    // HUD reflects the latest app state every frame. setState is
    // internally debounced — it only redraws when a field changes.
    active.hud.setState({
      datasetTitle: ctx.getDatasetTitle(),
      isPlaying: ctx.isPlaying(),
      hasVideo: ctx.hasVideoDataset(),
    })

    active.interaction.update(delta)
    // Scene-level per-frame sync (e.g. ground shadow scale matching
    // globe zoom). Cheap and always runs even when the loading
    // scene is still up so the shadow is correct the moment the
    // globe becomes visible.
    active.scene.update()

    // Track HUD + Place button to the globe's current position so
    // when the user places the globe on a real surface in AR, the
    // controls go with it rather than floating in mid-air at their
    // initial spot. Deliberately NOT parented to the globe (would
    // inherit rotation + wobble with user grab); manual sync via
    // offset vectors lets us keep position while leaving orientation
    // globe-independent.
    scratchPos.copy(active.scene.globe.position).add(hudOffset)
    active.hud.mesh.position.copy(scratchPos)
    if (active.placement) {
      scratchPos.copy(active.scene.globe.position).add(placeOffset)
      active.placement.placeButtonMesh.position.copy(scratchPos)
    }

    // Drive the loading scene's animation (rings spin, sphere
    // pulses, fade-out tween, progress bar ease) — only while the
    // loading group is still alive.
    active.loading?.update(delta)
    active.renderer.render(active.scene.scene, active.camera)
  })

  // --- Teardown ---
  session.addEventListener('end', () => {
    logger.info('[VR] Session ended, disposing resources')
    if (!active) return
    const a = active
    active = null
    a.renderer.setAnimationLoop(null)
    a.interaction.dispose()
    a.hud.dispose()
    // If the fade-out setTimeout is still pending, cancel it —
    // otherwise it would fire after the loading handle is disposed
    // and try to run fade-out on stale state.
    if (fadeTimeoutId !== null) {
      clearTimeout(fadeTimeoutId)
      fadeTimeoutId = null
    }
    // Loading scene may still be present if the user exited before
    // dataset finished loading. Dispose it explicitly so we don't
    // leak the canvases + textures. Flag handshake with the fade-out
    // path ensures we never double-dispose.
    if (a.loading && !loadingDisposed) {
      loadingDisposed = true
      a.scene.scene.remove(a.loading.group)
      a.loading.dispose()
    }
    if (a.placement) {
      a.scene.scene.remove(a.placement.reticleGroup)
      a.scene.scene.remove(a.placement.placeButtonMesh)
      a.placement.dispose()
    }
    // Anchors are bound to the XR session; deleting is optional
    // (they're implicitly cleaned up when the session ends) but
    // explicit disposal avoids a brief "still tracked" state if
    // anything else held a reference.
    if (currentAnchor) {
      try { currentAnchor.delete() } catch { /* already gone */ }
      currentAnchor = null
    }
    // Cancel the hit-test source so the platform releases the
    // viewer-space tracking subscription. The subscription
    // otherwise lives until session-end garbage-collects it
    // implicitly, which wastes work during the teardown window.
    if (a.hitTestSource) {
      try { a.hitTestSource.cancel() } catch { /* already cancelled */ }
    }
    a.scene.dispose()
    a.renderer.dispose()
    a.renderer.domElement.remove()
    ctx.onSessionEnd?.()
  })

  logger.info(`[VR] ${isAr ? 'AR passthrough' : 'VR'} session started`)
}

/** Convenience wrapper — request `immersive-vr` (full virtual environment). */
export const enterVr = (ctx: VrSessionContext): Promise<void> =>
  enterImmersive('vr', ctx)

/** Convenience wrapper — request `immersive-ar` (passthrough mixed reality). */
export const enterAr = (ctx: VrSessionContext): Promise<void> =>
  enterImmersive('ar', ctx)

/**
 * End the current VR session if one is active. Safe to call
 * unconditionally. Resource cleanup happens inside the 'end' handler
 * registered in `enterVr`, so this is just a thin wrapper.
 */
export async function exitVr(): Promise<void> {
  if (!active) return
  try {
    await active.session.end()
  } catch (err) {
    logger.warn('[VR] exitVr: session.end() failed:', err)
  }
}
