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
import { createVrBrowse, type VrBrowseHandle } from './vrBrowse'
import { createVrTourControls, type VrTourControlsHandle } from './vrTourControls'
import { createVrTourOverlay, type VrTourOverlayHandle } from './vrTourOverlay'
import { createVrTimeLabel, type VrTimeLabelHandle } from './vrTimeLabel'
import { setVrTourOverlaySink } from '../ui/tourUI'
import { createVrInteraction, type VrInteractionHandle } from './vrInteraction'
import { createVrLoading, type VrLoadingHandle } from './vrLoading'
import { createVrPlacement, liftedPlacementPosition, type VrPlacementHandle } from './vrPlacement'
import {
  clearPersistedAnchorHandle,
  loadPersistedAnchorHandle,
  savePersistedAnchorHandle,
} from '../utils/vrPersistence'
import { getBordersVisible, getGazeFollowOverlays } from '../utils/viewPreferences'
import { logger } from '../utils/logger'
import { emit, emitCameraSettled } from '../analytics'
import type { VrExitReason } from '../types'

/** Coarse device classifier for `vr_session_started.device_class`.
 * Substring match on the UA — only the bucket leaves this function;
 * the raw UA is never emitted. Order matters: more-specific
 * variants come first so `Quest Pro` doesn't fall through to the
 * generic `Quest` branch. */
function classifyXrDevice(ua: string): string {
  if (/Quest\s*Pro/i.test(ua)) return 'quest-pro'
  if (/Quest/i.test(ua)) return 'quest'
  if (/Vision/i.test(ua)) return 'vision-pro'
  if (/Windows|Mac OS X|Macintosh|X11|Linux/i.test(ua)) return 'pcvr'
  return 'unknown'
}

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
  /** Dataset id for the primary panel — used by analytics events
   * fired from inside VR (e.g. `vr_placement.layer_id`). Null when
   * no dataset is loaded. Telemetry-only: the HUD itself uses
   * `getDatasetTitle()` for human display. */
  getDatasetId(): string | null
  /**
   * Formatted time-label string for the current primary dataset —
   * mirrors the 2D `#time-label` overlay (e.g. `"2023-06-15"` or
   * `"2023-06-15 18:00"` for sub-daily). null when the dataset
   * lacks `startTime` metadata or no dataset is loaded.
   *
   * Polled per XR frame. The host MUST derive the string from the
   * current playback state (for video datasets, compute from
   * `video.currentTime`) rather than reusing a cached
   * `appState.timeLabel` — WebXR pauses `window.requestAnimationFrame`
   * for the duration of an immersive session, so the 2D
   * `startPlaybackLoop` that normally updates `appState.timeLabel`
   * is frozen and any consumer reading that cache sees the value
   * from the instant VR was entered and stays there forever. See
   * `main.ts`'s implementation for the expected pattern.
   */
  getDatasetTimeLabel(): string | null
  /** True iff a video dataset is loaded on the primary — drives the HUD play/pause button visibility. */
  hasVideoDataset(): boolean
  /** Drives the HUD play/pause icon. Reflects the primary panel's state. */
  isPlaying(): boolean
  /** Called when the user taps play/pause in VR. Toggles the primary's video. */
  togglePlayPause(): void
  /** Drives the HUD mute icon variant (speaker vs speaker-slash). */
  isMuted(): boolean
  /** Called when the user taps the HUD mute button. Flips `video.muted`. */
  toggleMute(): void

  // --- Phase 2.5 multi-panel getters ---
  //
  // These let vrSession mirror the 2D app's viewport manager
  // inside VR. When the 2D app is in 2-globe layout, `getPanelCount`
  // returns 2, each panel has its own texture / title, and one
  // slot is designated primary (drives the HUD + playback
  // transport). The original Phase 2.5 plan also included a
  // `promotePanel` hook for tap-to-promote (trigger on a secondary
  // globe → that slot becomes primary), but the behaviour was
  // intentionally removed in favour of "grab any globe to rotate,
  // all spin in lockstep" — the original created a ping-pong loop
  // where promoting swapped textures underneath the user's ray,
  // which then promoted again on the next tap. A replacement UX
  // (long-press, HUD-dot taps, Phase 3 browse panel routing) is
  // future work; the context surface stays trimmed until then.

  /** Current number of globe panels (1/2/4). Sourced from the 2D viewport manager. */
  getPanelCount(): number
  /** Which slot is currently primary — drives the HUD + singular playback transport. */
  getPrimaryIndex(): number
  /** Dataset texture for a specific slot, or null if no dataset loaded in that slot. */
  getPanelTexture(slot: number): VrDatasetTexture | null
  /** Dataset title for a specific slot, for per-panel labels; null if no dataset. */
  getPanelTitle(slot: number): string | null

  // --- Phase 3: in-VR browse ---
  /** Full dataset catalog for the browse panel. */
  getDatasets(): VrDatasetEntry[]
  /** Load a dataset by ID without leaving VR. */
  loadDataset(id: string): void

  // --- Phase 3.5: in-VR tour controls ---
  /**
   * Snapshot of the current tour state — the VR session polls this
   * each frame and updates the in-VR tour-control strip accordingly.
   * `active` is false when no tour is running; the other fields are
   * ignored in that case. Callers wire this to `TourEngine.state` /
   * `.currentIndex` / `.totalSteps` in main.ts.
   */
  getTourState(): VrTourState
  /** Resume or pause the running tour. No-op if no tour is active. */
  tourTogglePlayPause(): void
  /** Step the running tour backward one segment. No-op if no tour is active. */
  tourPrev(): void
  /** Skip the current task and move to the next. No-op if no tour is active. */
  tourNext(): void
  /** Stop the running tour entirely. No-op if no tour is active. */
  tourStop(): void

  /** Optional — fired after the session ends + resources are torn down. */
  onSessionEnd?: () => void
}

/**
 * Snapshot consumed by the in-VR tour-control strip. `active` gates
 * every other field — when false, the strip is hidden and the other
 * values aren't rendered. A tour that is paused (after `pauseForInput`
 * or an explicit user pause) is still `active`, just not `isPlaying`.
 */
export interface VrTourState {
  active: boolean
  isPlaying: boolean
  step: number
  totalSteps: number
}

/**
 * Lightweight dataset descriptor for the VR browse panel. Avoids
 * importing the full `Dataset` type into the VR modules — they only
 * need what they render.
 */
export interface VrDatasetEntry {
  id: string
  title: string
  /**
   * Every category/tag this dataset belongs to — union of
   * `enriched.categories` keys and `Dataset.tags`, matching the 2D
   * browse UI's chip-building model. Empty when the dataset has
   * neither. Lets the VR browse panel surface chips like "Tours"
   * and "Real-Time" that live in `tags`, not just in enriched
   * categories.
   */
  categories: string[]
  /** Thumbnail URL from the SOS catalog, if available. */
  thumbnailUrl: string | null
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
  /** In-VR dataset browse panel. */
  browse: VrBrowseHandle
  /** In-VR tour control strip — visible only while a tour is active. */
  tourControls: VrTourControlsHandle
  /** In-VR tour overlay manager (text / popup / ... panels). Always present; hosts per-tour overlays. */
  tourOverlay: VrTourOverlayHandle
  /** Floating date readout above the globe for datasets with time metadata. */
  timeLabel: VrTimeLabelHandle
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

/**
 * In-flight flyTo animation driven by the render loop. The tour
 * engine awaits the returned promise so the "next" task doesn't run
 * until the rotation settles. A new `flyToOnGlobe` call while one
 * is running resolves the previous one and replaces it — the last
 * call wins.
 */
interface PendingFlyTo {
  startQuat: THREE.Quaternion
  endQuat: THREE.Quaternion
  startTime: number
  durationMs: number
  resolve: () => void
}
let pendingFlyTo: PendingFlyTo | null = null

/**
 * Default flyTo animation length. Matches `MapRenderer.flyTo`'s
 * current 2.5 s pacing so tours that run `Promise.all([2D, VR])`
 * settle at roughly the same instant in both surfaces — the tour
 * engine awaits the longer of the two, and a mismatched default
 * would make VR-only sessions feel either abrupt (shorter) or
 * sluggish (longer) relative to the same tour in 2D.
 */
const FLY_TO_DEFAULT_DURATION_MS = 2500

/**
 * Rotate the VR globe so `(lat, lng)` faces the user's head. No-op
 * when no VR session is active.
 *
 * In 2D, `flyTo` moves the camera to look at a lat/lng. VR can't
 * move the user's head (WebXR owns the view transform — moving it
 * would induce motion sickness), so we rotate the globe instead:
 * the point on the sphere corresponding to `(lat, lng)` rotates to
 * the surface position closest to the user's current head position.
 *
 * Captured at animation start:
 * - `startQuat`: globe's current orientation.
 * - `endQuat`: orientation that maps the local unit vector of
 *   `(lat, lng)` onto the world-space direction from globe center
 *   to the camera. If the user walks to the other side of the
 *   globe in AR mode, re-calling `flyToOnGlobe` captures the new
 *   head position and rotates accordingly.
 *
 * Slerp + ease-in-out drives the interpolation each frame until the
 * duration elapses, at which point the returned promise resolves.
 * Tour engine's `execFlyTo` awaits both this and the 2D renderer's
 * `flyTo` via `Promise.all`, so the longer of the two paces the
 * next task.
 */
export async function flyToOnGlobe(
  lat: number,
  lng: number,
  durationMs: number = FLY_TO_DEFAULT_DURATION_MS,
): Promise<void> {
  if (!active) return
  const THREE_ = await loadThree()
  if (!active) return // session may have ended between await + resume

  // Target direction in world space = unit vector from globe center
  // to the user's head. `camera.getWorldPosition` accounts for the
  // XR view matrix, so this is the actual user position in
  // local-floor coords (not a fixed nominal spot).
  const camPos = new THREE_.Vector3()
  active.camera.getWorldPosition(camPos)
  const worldDir = camPos.clone().sub(active.scene.globe.position).normalize()

  // Local-space target point for (lat, lng). Matches the
  // convention `photorealEarth.sunDirectionFromLatLng` uses
  // internally so the orientation lines up with the dataset /
  // photoreal Earth texture's equirectangular wrap on the sphere
  // (including the negated Z that Three.js SphereGeometry's
  // default phiStart introduces).
  const latRad = (lat * Math.PI) / 180
  const lngRad = (lng * Math.PI) / 180
  const localTarget = new THREE_.Vector3(
    Math.cos(latRad) * Math.cos(lngRad),
    Math.sin(latRad),
    -Math.cos(latRad) * Math.sin(lngRad),
  )

  // Resolve any prior flyTo first so callers that awaited it don't
  // hang waiting on a superseded animation.
  if (pendingFlyTo) {
    const prior = pendingFlyTo
    pendingFlyTo = null
    prior.resolve()
  }

  return new Promise<void>((resolve) => {
    pendingFlyTo = {
      startQuat: active!.scene.globe.quaternion.clone(),
      endQuat: new THREE_.Quaternion().setFromUnitVectors(localTarget, worldDir),
      startTime: performance.now(),
      durationMs,
      resolve,
    }
  })
}

/** Cancel any in-flight flyTo animation — used by session teardown. */
function cancelFlyTo(): void {
  if (!pendingFlyTo) return
  const prior = pendingFlyTo
  pendingFlyTo = null
  prior.resolve()
}

/**
 * Push the non-primary panels' textures into scene slots 1..N-1.
 * Scene slot 0 holds the 2D app's primary panel (set via
 * `scene.setTexture`); the remaining scene slots are filled from the
 * 2D panel list in order, skipping the primary index. Separated so
 * the initial-setup path and the per-frame poll path stay in sync.
 */
function syncSecondaryTextures(
  scene: VrSceneHandle,
  ctx: VrSessionContext,
  panelCount: number,
): void {
  if (panelCount <= 1) return
  const primary = ctx.getPrimaryIndex()
  let sceneSlot = 1
  for (let panelSlot = 0; panelSlot < panelCount; panelSlot++) {
    if (panelSlot === primary) continue
    scene.setSlotTexture(sceneSlot, ctx.getPanelTexture(panelSlot))
    sceneSlot++
  }
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

  // Wall-clock anchor for `vr_session_started.entry_load_ms` and the
  // matching `vr_session_ended.duration_ms`. Captured before the
  // Three.js chunk load so a slow first-time fetch shows up in the
  // entry-load metric.
  const entryStartedAtWall = Date.now()
  const sessionTelemetry: {
    sessionStartedAtWall: number
    frames: number
    exitReason: VrExitReason
  } = {
    sessionStartedAtWall: 0,
    frames: 0,
    exitReason: 'user',
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
    sessionTelemetry.exitReason = 'error'
    await session.end().catch(() => { /* already gone */ })
    canvas.remove()
    renderer.dispose()
    throw err instanceof Error ? err : new Error(String(err))
  }

  // The session is bound; emit `vr_session_started` now so
  // entry_load_ms reflects the user-perceived "tap → in-VR" latency
  // including the Three.js chunk load + setSession round-trip. The
  // layer_id snapshot is the dataset loaded at entry time; if the
  // user loads a different dataset mid-session the
  // `vr_session_ended` event captures the post-change value.
  sessionTelemetry.sessionStartedAtWall = Date.now()
  emit({
    event_type: 'vr_session_started',
    mode,
    device_class: classifyXrDevice(
      typeof navigator !== 'undefined' ? navigator.userAgent : '',
    ),
    entry_load_ms: Math.max(0, sessionTelemetry.sessionStartedAtWall - entryStartedAtWall),
    layer_id: ctx.getDatasetId() ?? '',
  })

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

  const browse = createVrBrowse(THREE_)
  browse.setDatasets(ctx.getDatasets())
  scene.scene.add(browse.mesh)

  // Tour control strip — added to the scene now, hidden until the
  // per-frame poll sees an active tour. Starts with an "inactive"
  // state so the mesh is invisible on session start; polling below
  // flips it on when main.ts reports a running tour.
  const tourControls = createVrTourControls(THREE_)
  scene.scene.add(tourControls.mesh)

  // Tour overlay manager — the parent Group is always in the scene;
  // individual overlay meshes are added / removed by its show/hide
  // methods. The sink registered below forwards every DOM overlay
  // op from `tourUI` into this manager.
  const tourOverlay = createVrTourOverlay(THREE_)
  scene.scene.add(tourOverlay.group)

  // Floating date readout above the globe. Hidden by default;
  // per-frame setText(ctx.getDatasetTimeLabel()) flips it on when
  // a time-metadata-bearing dataset is loaded and drives it
  // forward each XR frame (2D's playback loop is paused during
  // the session so we can't rely on appState.timeLabel — we
  // recompute from video.currentTime directly instead).
  const timeLabel = createVrTimeLabel(THREE_)
  scene.scene.add(timeLabel.mesh)
  setVrTourOverlaySink({
    showText: (params) => tourOverlay.showText(params),
    hideText: (id) => tourOverlay.hideOverlay(id),
    hideAllText: () => tourOverlay.hideAllText(),
    showPopup: (params) => tourOverlay.showPopup(params),
    hidePopup: (id) => tourOverlay.hideOverlay(id),
    hideAllPopups: () => tourOverlay.hideAllPopups(),
    showImage: (params) => tourOverlay.showImage(params),
    hideImage: (id) => tourOverlay.hideOverlay(id),
    hideAllImages: () => tourOverlay.hideAllImages(),
    showVideo: (params, video, videoID) => tourOverlay.showVideo({
      id: videoID,
      video,
      anchor: params.anchor,
    }),
    hideVideo: (id) => tourOverlay.hideOverlay(id),
    hideAllVideos: () => tourOverlay.hideAllVideos(),
    showQuestion: (params) => tourOverlay.showQuestion({
      id: params.id,
      questionImageUrl: params.questionImageUrl,
      answerImageUrl: params.answerImageUrl,
      numberOfAnswers: params.numberOfAnswers,
      correctAnswerIndex: params.correctAnswerIndex,
      anchor: params.anchor,
      // `onComplete` was already wrapped by tourUI.showTourQuestion
      // to call hideAllTourQuestions before resolving the engine
      // promise — we just pass it through as the VR overlay's
      // "Continue tap" handler.
      onContinue: params.onComplete,
    }),
    hideAllQuestions: () => tourOverlay.hideAllQuestions(),
  })

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
  // Mirror the 2D app's viewport layout inside VR. Count=1 is the
  // backward-compatible single-globe path; count=2/4 builds the arc
  // with secondary globes. Scene slot 0 always reflects the 2D app's
  // *current* primary panel (drives the photoreal stack + HUD +
  // loading fade-out); scene slots 1..N hold the non-primary panels
  // in 2D order. VR follows the 2D app's layout in lockstep —
  // tapping a globe in VR does not, by itself, reorder panels here;
  // grab-rotate acts on every globe uniformly (see cead66d for why
  // the original tap-to-promote path was ripped out).
  const initialPanelCount = ctx.getPanelCount()
  logger.info(`[VR] Entering with ${initialPanelCount} panel(s), primary: ${ctx.getPrimaryIndex()}`)
  scene.setPanelCount(initialPanelCount)
  syncSecondaryTextures(scene, ctx, initialPanelCount)
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
    isMuted: ctx.isMuted(),
    panelCount: ctx.getPanelCount(),
    primaryIndex: ctx.getPrimaryIndex(),
    browseOpen: browse.isVisible(),
  })

  // XRControllerModelFactory was imported earlier (before scene
  // construction) so the loading-scene fade-out timing stays
  // predictable — see the comment at that import.
  const vrProjection: 'vr' | 'ar' = isAr ? 'ar' : 'vr'

  /** Compute the lat/lon under the camera's central forward ray
   * where it hits the globe, along with the current scale-derived
   * zoom and head-to-globe orientation. Returns null when the ray
   * misses the sphere (e.g. user looking away from the globe).
   * Kept inline so `scene.globe`, `camera`, and `THREE_` stay in
   * scope without threading them through another helper file. */
  function captureVrCameraState(): {
    center_lat: number
    center_lon: number
    zoom: number
    bearing: number
    pitch: number
  } | null {
    const headOrigin = new THREE_.Vector3()
    const headDir = new THREE_.Vector3(0, 0, -1)
    camera.getWorldPosition(headOrigin)
    camera.getWorldDirection(headDir)
    const ray = new THREE_.Ray(headOrigin, headDir)
    const sphereCenter = new THREE_.Vector3()
    scene.globe.getWorldPosition(sphereCenter)
    const radius = scene.globe.scale.x
    const sphere = new THREE_.Sphere(sphereCenter, radius)
    const hit = new THREE_.Vector3()
    if (!ray.intersectSphere(sphere, hit)) return null
    // Translate the hit into the globe's local frame, then undo
    // the globe's rotation so the vector represents the Earth-
    // fixed point under the user's gaze.
    const local = hit.clone().sub(sphereCenter).divideScalar(radius)
    const inverse = scene.globe.quaternion.clone().invert()
    local.applyQuaternion(inverse)
    // Spherical coords on a unit sphere. lat = asin(y), lon =
    // atan2(x, -z) — matches MapLibre's +X east, +Y up, +Z south
    // convention used by photorealEarth.ts.
    const lat = (Math.asin(local.y) * 180) / Math.PI
    const lon = (Math.atan2(local.x, -local.z) * 180) / Math.PI
    // Derive a MapLibre-comparable zoom from the head-to-globe
    // distance. A neutral view (scale 1, viewing distance ≈ 3m)
    // maps to zoom 2 to echo the photo-realistic default. Clamped
    // to MapLibre's typical 0-20 range for dashboard parity.
    const viewDistance = headOrigin.distanceTo(sphereCenter)
    const approxZoom = Math.log2(Math.max(0.1, radius / Math.max(0.1, viewDistance))) + 4
    const zoom = Math.max(0, Math.min(20, approxZoom))
    // Decompose globe rotation into bearing (yaw) + pitch. Y-axis
    // euler in world space represents how far the user has spun
    // the globe; X-axis represents tilt.
    const euler = new THREE_.Euler().setFromQuaternion(scene.globe.quaternion, 'YXZ')
    const bearing = (euler.y * 180) / Math.PI
    const pitch = (euler.x * 180) / Math.PI
    return {
      center_lat: lat,
      center_lon: lon,
      zoom,
      bearing: ((bearing % 360) + 360) % 360,
      pitch,
    }
  }

  const interaction = createVrInteraction(THREE_, XRControllerModelFactory, {
    scene: scene.scene,
    globe: scene.globe,
    // Raycast target list: primary + every secondary. vrInteraction
    // treats them uniformly (grab any globe → rotate primary →
    // scene.update copies the quaternion to all secondaries).
    getAllGlobes: () => scene.allGlobes,
    hud,
    browse,
    tourControls,
    tourOverlay,
    placement,
    renderer,
    onCameraSettled: () => {
      const state = captureVrCameraState()
      if (!state) return
      emitCameraSettled({
        slot_index: '0',
        projection: vrProjection,
        layer_id: ctx.getDatasetId() ?? '',
        ...state,
      })
    },
    onBrowseAction: (action) => {
      if (action.kind === 'close') {
        browse.setVisible(false)
      } else if (action.kind === 'select') {
        ctx.loadDataset(action.datasetId)
        browse.setVisible(false)
      } else if (action.kind === 'category') {
        // null = user tapped the dedicated "All" chip → clear filter.
        // non-null = filter to that category (re-tapping the
        // already-active chip re-applies the same filter; no toggle-
        // off, see VrBrowseAction docstring).
        browse.setCategoryFilter(action.category)
      }
    },
    onTourAction: (action) => {
      // Thin pass-through: the strip's button layout and the tour-
      // engine's control surface are 1:1, so the VR session doesn't
      // need to interpret anything here. main.ts owns the engine and
      // fans these out to TourEngine.play/pause/next/prev/stop.
      switch (action) {
        case 'tour-play-pause':
          ctx.tourTogglePlayPause()
          break
        case 'tour-prev':
          ctx.tourPrev()
          break
        case 'tour-next':
          ctx.tourNext()
          break
        case 'tour-stop':
          ctx.tourStop()
          break
      }
    },
    onHudAction: (action) => {
      if (action === 'play-pause') {
        ctx.togglePlayPause()
      } else if (action === 'mute') {
        // Flip the primary video's muted flag. The per-frame
        // hud.setState pipes ctx.isMuted() back through so the
        // icon updates on the next redraw.
        ctx.toggleMute()
      } else if (action === 'browse') {
        // Toggle the in-VR dataset browse panel. Its `isVisible`
        // feeds `hud.setState({ browseOpen })` each frame, so the
        // next render shows the button in its active-state color.
        browse.setVisible(!browse.isVisible())
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
        let persisted = false
        if (requestFn) {
          try {
            const handle = await requestFn.call(anchor)
            savePersistedAnchorHandle(handle)
            persisted = true
            logger.info('[VR] Saved persistent placement anchor')
          } catch (err) {
            logger.debug('[VR] Anchor persistent handle not available:', err)
          }
        }
        emit({
          event_type: 'vr_placement',
          layer_id: ctx.getDatasetId() ?? '',
          persisted,
        })
      }).catch(err => {
        logger.warn('[VR] Failed to create placement anchor:', err)
        emit({
          event_type: 'vr_placement',
          layer_id: ctx.getDatasetId() ?? '',
          persisted: false,
        })
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
    browse,
    tourControls,
    tourOverlay,
    timeLabel,
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
  /**
   * Minimal fingerprint to detect "catalog has changed in a way the
   * browse panel cares about" — the array length plus the number of
   * entries that carry a category. Captures both the initial
   * populate (length goes from 0 to N) and the enriched-metadata
   * arrival (length stable, category-count goes from 0 to N). main.ts
   * returns a fresh array every call to `getDatasets()`, so we don't
   * bother with an identity check.
   */
  let lastBrowseDatasetsLen = -1
  let lastBrowseCategoryCount = -1
  /**
   * Last wall-clock ms we polled `ctx.getDatasets()`. main.ts rebuilds
   * the catalog array (filter + map + Set + Array.from) every call,
   * so we don't want to hit it at XR frame rate. Poll at 1 Hz while
   * the browse panel is open; skip entirely while it's closed.
   */
  let lastBrowseDatasetsPollMs = -Infinity
  /** True last frame — forces a poll on the frame the panel opens. */
  let lastBrowseVisible = false
  const BROWSE_POLL_INTERVAL_MS = 1000

  const hudOffset = new THREE_.Vector3(0, -0.65, 0.15)
  const placeOffset = new THREE_.Vector3(0, -0.5, 0.15)
  const browseOffset = new THREE_.Vector3(0.7, 0, 0.3)
  /**
   * Tour-control strip sits just below the dataset HUD, close
   * enough to feel like part of the same control cluster. The
   * HUD itself is at globe + (0, -0.65, 0.15); this offset keeps
   * the same x/z and adds another ~12 cm of y-drop so the two
   * panels don't overlap even when the user has zoomed the globe.
   */
  const tourControlsOffset = new THREE_.Vector3(0, -0.80, 0.15)
  /** Scratch reused per-frame for position math; avoids GC churn. */
  const scratchPos = new THREE_.Vector3()
  /** Scratch vector reused every frame by the billboard-lookAt block below. */
  const scratchCamPos = new THREE_.Vector3()
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
    sessionTelemetry.frames++

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
    // every frame is cheap in the steady state. Also mirror the
    // 2D viewport's panel count + per-slot textures — setPanelCount
    // is idempotent when the count hasn't changed, and per-slot
    // setSlotTexture shares the same debounce path as the primary.
    const panelCount = ctx.getPanelCount()
    active.scene.setPanelCount(panelCount)
    active.scene.setTexture(ctx.getDatasetTexture())
    syncSecondaryTextures(active.scene, ctx, panelCount)

    // Poll the 2D catalog only while the browse panel is open, and
    // only at 1 Hz once open — main.ts rebuilds the catalog array
    // (filter + map + Set + Array.from) on every getDatasets() call,
    // and at XR frame rate (72–90 Hz) that adds up to pointless
    // per-frame allocation. A 1-second refresh is fast enough for
    // the user to notice new chips when enriched metadata lands or
    // the 2D app updates the catalog. Always poll the moment the
    // panel becomes visible so the first render has fresh data.
    const browseVisibleNow = active.browse.isVisible()
    if (browseVisibleNow) {
      const becameVisible = !lastBrowseVisible
      const sinceLastPoll = now - lastBrowseDatasetsPollMs
      if (becameVisible || sinceLastPoll >= BROWSE_POLL_INTERVAL_MS) {
        lastBrowseDatasetsPollMs = now
        const currentDatasets = ctx.getDatasets()
        let categoryCount = 0
        for (let i = 0; i < currentDatasets.length; i++) {
          categoryCount += currentDatasets[i].categories.length
        }
        if (
          becameVisible ||
          currentDatasets.length !== lastBrowseDatasetsLen ||
          categoryCount !== lastBrowseCategoryCount
        ) {
          lastBrowseDatasetsLen = currentDatasets.length
          lastBrowseCategoryCount = categoryCount
          active.browse.setDatasets(currentDatasets)
        }
      }
    }
    lastBrowseVisible = browseVisibleNow

    // HUD reflects the latest app state every frame. setState is
    // internally debounced — it only redraws when a field changes.
    active.hud.setState({
      datasetTitle: ctx.getDatasetTitle(),
      isPlaying: ctx.isPlaying(),
      hasVideo: ctx.hasVideoDataset(),
      isMuted: ctx.isMuted(),
      panelCount,
      primaryIndex: ctx.getPrimaryIndex(),
      browseOpen: active.browse.isVisible(),
    })

    // Tour strip mirrors the engine state. Always poll; the strip's
    // setState is internally debounced, so a per-frame call with an
    // unchanged state is a cheap equality check. `active` toggling
    // to false hides the mesh without further work.
    active.tourControls.setState(ctx.getTourState())

    // Time label — recompute from video.currentTime every XR frame
    // (the 2D playback loop that normally drives appState.timeLabel
    // is paused while WebXR is active, so we can't read a cached
    // value). setText is idempotent when the string is unchanged,
    // so this is cheap in the steady state. Pause behaviour falls
    // out naturally — a paused video's currentTime doesn't advance.
    active.timeLabel.setText(ctx.getDatasetTimeLabel())
    active.timeLabel.update(active.camera, active.scene.globe.position)

    // Borders overlay mirrors the shared view preference. 2D toggles
    // (Tools menu / tour envShowWorldBorder) write to the same
    // preference, so the VR globe stays in sync without a dedicated
    // callback. `scene.setBordersVisible` is internally idempotent.
    active.scene.setBordersVisible(getBordersVisible())

    active.interaction.update(delta)

    // flyTo animation — drives the globe quaternion toward the
    // captured target each frame. Must run AFTER interaction.update
    // (which writes user-grab rotations) and BEFORE scene.update
    // (which propagates the primary's quaternion to secondaries).
    // A fresh user grab mid-animation will overwrite globe.quaternion,
    // but the very next frame slerp reads `startQuat` not the current
    // quat — so flyTo "wins" until the duration elapses. Good enough
    // for v1; a user-grab interrupt is cheap follow-up if requested.
    if (pendingFlyTo) {
      const elapsed = now - pendingFlyTo.startTime
      // Guard the instant-jump case: durationMs = 0 (from
      // `animated: false` tour tasks) would divide by zero and on
      // the first frame where elapsed === 0 produce NaN, leaving
      // the slerp in an undefined state. Collapse to t=1 so the
      // snap completes on the first tick.
      const t = pendingFlyTo.durationMs > 0
        ? Math.min(1, elapsed / pendingFlyTo.durationMs)
        : 1
      // Ease-in-out cubic — matches MapLibre flyTo's perceived pacing.
      const eased = t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2
      active.scene.globe.quaternion.slerpQuaternions(
        pendingFlyTo.startQuat,
        pendingFlyTo.endQuat,
        eased,
      )
      if (t >= 1) {
        const done = pendingFlyTo
        pendingFlyTo = null
        done.resolve()
      }
    }

    // Scene-level per-frame sync (e.g. ground shadow scale matching
    // globe zoom). Cheap and always runs even when the loading
    // scene is still up so the shadow is correct the moment the
    // globe becomes visible.
    active.scene.update()

    // Tour overlay pose resolution — world-anchored overlays track
    // the globe, gaze-follow overlays lerp toward a camera-local
    // target. No-op when no overlays exist, which is the common
    // case (most users aren't on a tour).
    //
    // Multi-globe hint shifts NEW overlay default placement above
    // the primary when an arc is visible — keeps wide popup /
    // image / question panels from landing between globes and
    // occluding the sibling data. Idempotent; cheap to call every
    // frame. Existing overlays keep their stored offset.
    active.tourOverlay.setMultiGlobeHint(panelCount > 1)
    // Global default anchor mode — per-overlay `anchor` hints in
    // the tour JSON still win over this. No runtime UI toggles
    // this yet; the preference is settable programmatically (or
    // via a future Tools-menu checkbox) so power users can flip
    // their default without losing the tour-author's specific
    // overrides.
    active.tourOverlay.setGazeFollowDefault(getGazeFollowOverlays())
    active.tourOverlay.update(active.camera, active.scene.globe.position, delta)

    // Track HUD + Place button to the globe's current position so
    // when the user places the globe on a real surface in AR, the
    // controls go with it rather than floating in mid-air at their
    // initial spot. Deliberately NOT parented to the globe (would
    // inherit rotation + wobble with user grab); manual sync via
    // offset vectors lets us keep position while leaving orientation
    // globe-independent.
    //
    // Each panel also billboards toward the camera via lookAt — if
    // the user walks around a placed globe in AR (or starts from a
    // non-default standing position), the panel would otherwise
    // stay facing -z world and end up edge-on to the viewer. Same
    // pattern as vrTimeLabel above and the tour-overlay's
    // world-anchor billboard — user always sees panels face-on.
    active.camera.getWorldPosition(scratchCamPos)

    scratchPos.copy(active.scene.globe.position).add(hudOffset)
    active.hud.mesh.position.copy(scratchPos)
    active.hud.mesh.lookAt(scratchCamPos)
    if (active.browse.isVisible()) {
      scratchPos.copy(active.scene.globe.position).add(browseOffset)
      active.browse.mesh.position.copy(scratchPos)
      active.browse.mesh.lookAt(scratchCamPos)
    }
    if (active.tourControls.isVisible()) {
      scratchPos.copy(active.scene.globe.position).add(tourControlsOffset)
      active.tourControls.mesh.position.copy(scratchPos)
      active.tourControls.mesh.lookAt(scratchCamPos)
    }
    if (active.placement) {
      scratchPos.copy(active.scene.globe.position).add(placeOffset)
      active.placement.placeButtonMesh.position.copy(scratchPos)
      active.placement.placeButtonMesh.lookAt(scratchCamPos)
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

    // Telemetry: emit `vr_session_ended` once per session, before
    // any disposal happens so frame counters / timestamps still
    // exist. mean_fps = total frames / wall-clock duration (a true
    // arithmetic mean, not a median — the name reflects what we
    // compute). 0 when the session was too short for a meaningful
    // sample; dashboards filter `mean_fps > 0` to exclude these.
    // For per-window medians, the perf_sampler emits
    // fps_median_10s during the session.
    if (sessionTelemetry.sessionStartedAtWall > 0) {
      const durationMs = Math.max(0, Date.now() - sessionTelemetry.sessionStartedAtWall)
      const meanFps = durationMs >= 1000
        ? Math.round((sessionTelemetry.frames * 1000) / durationMs)
        : 0
      emit({
        event_type: 'vr_session_ended',
        mode,
        exit_reason: sessionTelemetry.exitReason,
        duration_ms: durationMs,
        mean_fps: meanFps,
        // Snapshot of the loaded dataset at end-of-session. May
        // differ from `vr_session_started.layer_id` when the user
        // loaded something different while in VR.
        layer_id: ctx.getDatasetId() ?? '',
      })
    }

    if (!active) return
    const a = active
    active = null
    a.renderer.setAnimationLoop(null)
    // Resolve any in-flight flyTo so awaiting callers don't hang
    // after the session ends (tour engine's execFlyTo, chat's
    // onFlyTo handler).
    cancelFlyTo()
    a.interaction.dispose()
    a.hud.dispose()
    a.browse.dispose()
    a.scene.scene.remove(a.tourControls.mesh)
    a.tourControls.dispose()
    a.scene.scene.remove(a.timeLabel.mesh)
    a.timeLabel.dispose()
    // Clear the tourUI sink first so any in-flight `hideAll*` calls
    // from the tour engine (e.g. tour cleanup fired by stopTour()
    // during exit) don't land on the about-to-be-disposed manager.
    setVrTourOverlaySink(null)
    a.scene.scene.remove(a.tourOverlay.group)
    a.tourOverlay.dispose()
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
