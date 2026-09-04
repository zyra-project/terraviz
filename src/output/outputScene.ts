// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output window's scene and render loop.
 *
 * `main.ts` is a thin entry over this, the same shape `orbitMain.ts`
 * has over `orbitCharacter/` — so the parts worth testing are
 * importable without running a page.
 *
 * What this builds: a full-bleed canvas whose drawing buffer is a 2:1
 * equirectangular framebuffer, and a loop that draws the sphere
 * through `equirectRtt`'s pass into it. v1 of this commit renders the
 * idle state — the Earth — with no dataset and no IPC.
 *
 * ## How the sphere reaches the pass, and the part the plan leaves open
 *
 * `equirectRtt` samples **one equirectangular source texture** and
 * re-projects it. It does not rasterise a mesh, and it cannot: the
 * plan's §3 rejects the cubemap-and-convert route outright, and a
 * perspective camera cannot see 360°. Read together with §3's "raycast
 * that direction against the sphere stack, sample each layer's
 * composited texture at the hit point", the equirect shader *is* the
 * renderer.
 *
 * So `photorealEarth` is used here as a **texture provider**, not as a
 * mesh to render: its progressive CDN loader is what fetches the base
 * diffuse the control globe is already showing, at 2K → 4K → 8K, and
 * `baseDiffuseTexture` / `baseEarthTexture` / `onBaseDiffuseChange`
 * are the seam for that. Reusing its loader is what "widen the
 * existing seams rather than introducing parallel ones" buys us; a
 * second Earth-tile loader is exactly the duplicated-and-subtly-wrong
 * work the Prior-art section warns about.
 *
 * **Unresolved, and deliberately not guessed at here:** day/night
 * terminator, atmosphere shells and clouds live in `photorealEarth`'s
 * *material*, not in a texture, so they do not come along for free. On
 * this reading they would have to be reimplemented inside the equirect
 * fragment shader, which is the re-derivation the plan otherwise
 * forbids. That is a real design fork and it is commit 3/4 scope, not
 * something to settle silently in a scaffold — see the commit message.
 * Until it is settled this renders the diffuse only, which is correct
 * for a loaded dataset (data is lit uniformly, exactly as
 * `globeThumbnail` does it) and incomplete for the idle Earth.
 */

import {
  EQUIRECT_FRAGMENT_SHADER,
  EQUIRECT_VERTEX_SHADER,
  EQUIRECT_UNIFORMS,
  EQUIRECT_ASPECT,
  IDENTITY_PARAMS,
  type EquirectParams,
} from './equirectRtt'

/**
 * Framebuffer widths the resolution picker offers. Heights are always
 * half — an equirectangular frame that is not 2:1 is not
 * equirectangular.
 */
export const FRAMEBUFFER_WIDTHS = [1024, 2048, 4096, 8192] as const

export type FramebufferWidth = (typeof FRAMEBUFFER_WIDTHS)[number]

export interface FramebufferSize {
  width: number
  height: number
}

/**
 * Snap a requested width to a supported rung and derive the height.
 *
 * Rounds **down** to the nearest supported rung rather than to the
 * nearest: a monitor that reports slightly under a rung should get the
 * smaller buffer, because overshooting costs GPU memory on hardware
 * that already told us it is smaller. Anything below the lowest rung
 * clamps up to it — a sub-1024 equirect is not worth driving a sphere
 * with.
 */
export function resolveFramebufferSize(requestedWidth: number): FramebufferSize {
  const rungs = FRAMEBUFFER_WIDTHS
  let width: number = rungs[0]
  for (const rung of rungs) {
    if (requestedWidth >= rung) width = rung
  }
  return { width, height: width / EQUIRECT_ASPECT }
}

/** What the loop is currently showing, which sets its pace. */
export type OutputContentKind = 'idle' | 'image' | 'video'

/** 30 fps while video is playing — the plan's target. */
export const VIDEO_FRAME_MS = 1000 / 30
/** 1 Hz for anything static. Redrawing an unchanged frame at 30 fps
 *  burns a decoder-budget's worth of GPU for no visible difference. */
export const STATIC_FRAME_MS = 1000

export function frameIntervalMs(kind: OutputContentKind): number {
  return kind === 'video' ? VIDEO_FRAME_MS : STATIC_FRAME_MS
}

export interface FrameDecisionState {
  kind: OutputContentKind
  /** ms since the last frame was drawn. */
  sinceLastFrameMs: number
  /** Set by a state diff, a texture upload, or a resize. */
  dirty: boolean
}

/**
 * Should the loop draw this tick?
 *
 * Two independent reasons to draw, and both matter: something changed
 * (`dirty`), or enough time has passed that a *playing* video has a
 * new frame to show. A static output that nothing has touched draws at
 * 1 Hz rather than never, so a dropped texture upload or a lost
 * context surfaces as a stale frame the read-back layer can catch
 * rather than as a loop that has quietly stopped.
 */
export function shouldRenderFrame(state: FrameDecisionState): boolean {
  if (state.dirty) return true
  return state.sinceLastFrameMs >= frameIntervalMs(state.kind)
}

// --- Scene construction ---

type ThreeModule = typeof import('three')

export interface OutputSceneDeps {
  /** Lazy Three import, mirroring `globeThumbnail`'s seam so the
   *  chunk is shared and the page stays light until it renders. */
  loadThree?: () => Promise<ThreeModule>
  createEarth?: typeof import('../services/photorealEarth').createPhotorealEarth
}

export interface OutputSceneOptions {
  canvas: HTMLCanvasElement
  /** Target framebuffer width; snapped by `resolveFramebufferSize`. */
  framebufferWidth?: number
  params?: EquirectParams
}

export interface OutputScene {
  readonly size: FramebufferSize
  /** Draw one frame. */
  render(): void
  /** Swap the projection parameters (camera offset / split). */
  setParams(params: EquirectParams): void
  dispose(): void
}

function defaultLoadThree(): Promise<ThreeModule> {
  return import('three')
}

/**
 * Build the output scene.
 *
 * The equirect pass is a fullscreen quad rendered with an orthographic
 * camera — the projection lives entirely in the fragment shader, so
 * the camera here is a formality that maps the quad to the viewport
 * and nothing more. Reading `EQUIRECT_VERTEX_SHADER` makes that plain:
 * it writes clip space directly and ignores the matrices.
 */
export async function createOutputScene(
  options: OutputSceneOptions,
  deps: OutputSceneDeps = {},
): Promise<OutputScene> {
  const THREE_ = await (deps.loadThree ?? defaultLoadThree)()
  const size = resolveFramebufferSize(options.framebufferWidth ?? FRAMEBUFFER_WIDTHS[2])

  const renderer = new THREE_.WebGLRenderer({ canvas: options.canvas, antialias: false })
  // `false` leaves the CSS size alone: the drawing buffer is the
  // equirect framebuffer and is deliberately independent of how large
  // the window happens to be.
  renderer.setSize(size.width, size.height, false)
  renderer.setClearColor(0x000000, 1)

  const scene = new THREE_.Scene()
  const camera = new THREE_.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  const uniforms: Record<string, { value: unknown }> = {
    [EQUIRECT_UNIFORMS.sphereTexture]: { value: null },
    [EQUIRECT_UNIFORMS.cameraOffset]: {
      value: new THREE_.Vector3(
        (options.params ?? IDENTITY_PARAMS).cameraOffset.x,
        (options.params ?? IDENTITY_PARAMS).cameraOffset.y,
        (options.params ?? IDENTITY_PARAMS).cameraOffset.z,
      ),
    },
    [EQUIRECT_UNIFORMS.split]: { value: (options.params ?? IDENTITY_PARAMS).split },
  }

  const material = new THREE_.ShaderMaterial({
    vertexShader: EQUIRECT_VERTEX_SHADER,
    fragmentShader: EQUIRECT_FRAGMENT_SHADER,
    uniforms: uniforms as never,
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE_.Mesh(new THREE_.PlaneGeometry(2, 2), material)
  // The quad covers clip space regardless of the camera; frustum
  // culling would test its (unused) world bounds and can cull it.
  quad.frustumCulled = false
  scene.add(quad)

  return {
    size,
    render() {
      renderer.render(scene, camera)
    },
    setParams(params: EquirectParams) {
      const offset = uniforms[EQUIRECT_UNIFORMS.cameraOffset].value as {
        set: (x: number, y: number, z: number) => void
      }
      offset.set(params.cameraOffset.x, params.cameraOffset.y, params.cameraOffset.z)
      uniforms[EQUIRECT_UNIFORMS.split].value = params.split
    },
    dispose() {
      quad.geometry.dispose()
      material.dispose()
      renderer.dispose()
      // Drop the GL context eagerly — `dispose()` alone leaves it alive
      // until GC, and an installation runs many of these.
      renderer.forceContextLoss()
    },
  }
}
