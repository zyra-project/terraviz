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
import { logger } from '../utils/logger'

/**
 * Contract the hosting app must provide. Pull-based: the session
 * polls these getters once per frame and reflects the values in the
 * HUD / scene. Keeps the VR modules decoupled from the specifics of
 * MapLibre / HLSService / viewportManager.
 */
export interface VrSessionContext {
  /**
   * The currently-loaded dataset's surface texture, in whichever
   * form the 2D app has it: video element for HLS streams, URL for
   * static image datasets, or null when nothing is loaded.
   */
  getDatasetTexture(): VrDatasetTexture | null
  /** Dataset title for the HUD; null/empty → "No dataset loaded". */
  getDatasetTitle(): string | null
  /** True iff a video dataset is loaded — drives the HUD play/pause button visibility. */
  hasVideoDataset(): boolean
  /** Drives the HUD play/pause icon. No-op for image datasets. */
  isPlaying(): boolean
  /** Called when the user taps play/pause in VR. No-op for image datasets. */
  togglePlayPause(): void
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
  let session: XRSession
  try {
    session = await navigator.xr.requestSession(sessionMode, {
      requiredFeatures: ['local-floor'],
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

  // --- Build the scene ---
  // AR mode → transparent background so the passthrough camera feed
  // shows behind everything we render.
  const scene = createVrScene(THREE_, isAr)
  const hud = createVrHud(THREE_)
  scene.scene.add(hud.mesh)

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
  // ms (the forced seek decode). For images / no dataset it's instant.
  loading.setProgress(0.8, 'Loading dataset\u2026')
  scene.setTexture(ctx.getDatasetTexture(), () => {
    if (!active) return // session already ended
    loading.setProgress(1.0, 'Ready')
    // Brief pause at 100% so the user perceives completion, then fade.
    setTimeout(() => {
      if (!active || !active.loading) return
      void active.loading.fadeOut().then(() => {
        if (!active || !active.loading) return
        active.scene.scene.remove(active.loading.group)
        active.loading.dispose()
        active.loading = null
        // Reveal the real scene now that loading has cleared.
        active.scene.globe.visible = true
        active.hud.mesh.visible = true
      })
    }, 250)
  })
  hud.setState({
    datasetTitle: ctx.getDatasetTitle(),
    isPlaying: ctx.isPlaying(),
    hasVideo: ctx.hasVideoDataset(),
  })

  // Lazy-load the controller-model addon alongside Three.js. The
  // factory fetches per-controller glTF models from a CDN at runtime
  // (e.g. Quest Touch), so the addon itself is small but enables a
  // big polish win: users see their actual controllers in VR.
  const { XRControllerModelFactory } = await import(
    'three/examples/jsm/webxr/XRControllerModelFactory.js'
  )

  const interaction = createVrInteraction(THREE_, XRControllerModelFactory, {
    scene: scene.scene,
    globe: scene.globe,
    hud,
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
  }

  // --- Render loop ---
  let lastTime = performance.now()
  renderer.setAnimationLoop((time) => {
    const now = time || performance.now()
    const delta = Math.min(0.1, (now - lastTime) / 1000)
    lastTime = now

    if (!active) return

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
    // Loading scene may still be present if the user exited before
    // dataset finished loading. Dispose it explicitly so we don't
    // leak the canvases + textures.
    if (a.loading) {
      a.scene.scene.remove(a.loading.group)
      a.loading.dispose()
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
