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
import { createVrScene, type VrSceneHandle } from './vrScene'
import { createVrHud, type VrHudHandle } from './vrHud'
import { createVrInteraction, type VrInteractionHandle } from './vrInteraction'
import { logger } from '../utils/logger'

/**
 * Contract the hosting app must provide. Pull-based: the session
 * polls these getters once per frame and reflects the values in the
 * HUD / scene. Keeps the VR modules decoupled from the specifics of
 * MapLibre / HLSService / viewportManager.
 */
export interface VrSessionContext {
  /** Live HLS video element, if a video dataset is loaded. */
  getVideo(): HTMLVideoElement | null
  /** Dataset title for the HUD; null/empty → "No dataset loaded". */
  getDatasetTitle(): string | null
  /** Drives the HUD play/pause icon. */
  isPlaying(): boolean
  /** Called when the user taps play/pause in VR. */
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
  /** Video currently bound as VideoTexture — tracked so we only swap on change. */
  currentVideo: HTMLVideoElement | null
}

let active: ActiveSession | null = null

/** True while a VR session is live. */
export function isVrActive(): boolean {
  return active !== null
}

/**
 * Request an `immersive-vr` session, build the Three.js scene,
 * attach controllers, and start the render loop. Rejects if the
 * browser refuses the session (user denied permission, no device,
 * etc.). On success, resolves once the session is fully live — the
 * user will be in VR at that point.
 *
 * Calling while a session is already active is a no-op.
 */
export async function enterVr(ctx: VrSessionContext): Promise<void> {
  if (active) {
    logger.warn('[VR] enterVr called while a session is already active')
    return
  }
  if (!navigator.xr) {
    throw new Error('WebXR is not available in this browser')
  }

  const THREE_ = await loadThree()

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
    alpha: false,
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
    session = await navigator.xr.requestSession('immersive-vr', {
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
  const scene = createVrScene(THREE_)
  const hud = createVrHud(THREE_)
  scene.scene.add(hud.mesh)

  // Initial HUD state + video (before the first frame, so the first
  // render already shows real data).
  const initialVideo = ctx.getVideo()
  scene.setVideo(initialVideo)
  hud.setState({
    datasetTitle: ctx.getDatasetTitle(),
    isPlaying: ctx.isPlaying(),
    hasVideo: !!initialVideo,
  })

  const interaction = createVrInteraction(THREE_, {
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
    currentVideo: initialVideo,
  }

  // --- Render loop ---
  let lastTime = performance.now()
  renderer.setAnimationLoop((time) => {
    const now = time || performance.now()
    const delta = Math.min(0.1, (now - lastTime) / 1000)
    lastTime = now

    if (!active) return

    // Swap the VideoTexture if the app switched datasets while
    // we're in VR. Cheap check (pointer compare); the scene only
    // rebuilds the texture when it actually changes.
    const nowVideo = ctx.getVideo()
    if (nowVideo !== active.currentVideo) {
      active.scene.setVideo(nowVideo)
      active.currentVideo = nowVideo
    }

    // HUD reflects the latest app state every frame. setState is
    // internally debounced — it only redraws when a field changes.
    active.hud.setState({
      datasetTitle: ctx.getDatasetTitle(),
      isPlaying: ctx.isPlaying(),
      hasVideo: !!nowVideo,
    })

    active.interaction.update(delta)
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
    a.scene.dispose()
    a.renderer.dispose()
    a.renderer.domElement.remove()
    ctx.onSessionEnd?.()
  })

  logger.info('[VR] Session started')
}

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
