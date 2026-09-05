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
 * through `equirectRtt`'s pass into it. It renders the idle state —
 * the Earth's base diffuse, re-projected — with no dataset and no IPC.
 *
 * That claim is load-bearing and was once false: the sampler was left
 * bound to `null`, so the page rendered black while this comment said
 * otherwise. Black is the worst possible placeholder here, because on
 * an output it is indistinguishable from a dropped upload or a lost
 * context — the exact failure the 1 Hz static floor below exists to
 * make visible. The sampler is now bound to `baseEarthTexture`, which
 * `photorealEarth` loads unconditionally and never leaves null, from
 * the first frame.
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
 * **The fork this scaffold left open is now settled**, in the plan's
 * "What the equirect path does to the Earth decoration". Day/night
 * terminator, clouds and night lights live in `photorealEarth`'s
 * *material* rather than in a texture, so they do not arrive for free
 * — but they are cheap rather than a re-derivation: the terminator is
 * `dot(hit, uSunDir)` because the ray-march's hit point on the unit
 * sphere already *is* the surface normal, and the other two are
 * samplers. Specular, atmosphere, ground shadow and the sun sprite do
 * not cross at all, and are not meant to: each depends on a viewer or
 * a silhouette, and an equirectangular unwrap has neither.
 *
 * Of that, only the base diffuse is wired here. Terminator, night
 * lights and clouds are not — which is correct for a loaded dataset
 * (data is lit uniformly, exactly as `globeThumbnail` does it) and
 * still incomplete for the idle Earth. What changed is that finishing
 * it is a known small job against a settled design rather than an open
 * question, and that the gap is now visible: the sphere shows Earth,
 * so a missing terminator reads as a missing terminator instead of
 * hiding inside a black page.
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
  /** Whether something changed since the last call — read once and
   *  cleared, so the render loop can feed `shouldRenderFrame`'s
   *  `dirty` input without the scene needing a callback into it. */
  consumeDirty(): boolean
  /** Draw one frame. */
  render(): void
  /** Swap the projection parameters (camera offset / split). */
  setParams(params: EquirectParams): void
  dispose(): void
}

function defaultLoadThree(): Promise<ThreeModule> {
  return import('three')
}

type CreateEarth = typeof import('../services/photorealEarth').createPhotorealEarth

/**
 * Lazy, for the same reason `loadThree` is.
 *
 * `photorealEarth` imports Three as a *type* only, so it does not drag
 * the runtime in — but it does pull `utils/time`, `deviceCapability`,
 * the atmosphere constants and the LUT, all real code. A static import
 * would put them in the output **entry** chunk, which is currently
 * ~3 KB and is the measurement behind this bundle's decoupling claim.
 */
function defaultCreateEarth(): Promise<CreateEarth> {
  return import('../services/photorealEarth').then(m => m.createPhotorealEarth)
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

  // The Earth is consumed as a *texture provider*: `photorealEarth`
  // owns the progressive 2K → 4K → 8K CDN loader, and reusing it is
  // what keeps a second Earth-tile loader from existing. Every mesh it
  // would otherwise build is switched off — this path never rasterises
  // one, so lighting, atmosphere, clouds, sun and shadow would all be
  // built and thrown away (and half of them are meaningless on an
  // unwrap anyway; see the plan's "What the equirect path does to the
  // Earth decoration").
  const createEarth = deps.createEarth ?? (await defaultCreateEarth())
  const earth = createEarth(THREE_, {
    includeLighting: false,
    includeAtmosphere: false,
    includeClouds: false,
    includeSun: false,
    includeShadow: false,
  })

  const uniforms: Record<string, { value: unknown }> = {
    // `baseEarthTexture` is loaded unconditionally and is never null,
    // so the sampler is bound from the first frame. A `null` here
    // renders black, which on an output is indistinguishable from a
    // dropped upload or a lost context — the one failure mode this
    // module's 1 Hz floor exists to make visible.
    [EQUIRECT_UNIFORMS.sphereTexture]: {
      value: earth.baseDiffuseTexture ?? earth.baseEarthTexture,
    },
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

  // The CDN loader upgrades 2K → 4K → 8K after first paint. Swap the
  // sampler and mark the scene dirty: at the 1 Hz static floor an
  // un-flagged upgrade would not reach the sphere for up to a second,
  // which on a projector reads as a resolution pop.
  let textureUpgraded = false
  const unsubscribeDiffuse = earth.onBaseDiffuseChange(tex => {
    uniforms[EQUIRECT_UNIFORMS.sphereTexture].value = tex
    textureUpgraded = true
  })

  return {
    size,
    /** True once since the last `render()` — drives `shouldRenderFrame`'s
     *  `dirty` input so an upgraded texture paints immediately. */
    consumeDirty() {
      const was = textureUpgraded
      textureUpgraded = false
      return was
    },
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
      unsubscribeDiffuse()
      // Disposes the textures this scene's sampler was bound to, so it
      // must come before the renderer loses its context.
      earth.dispose()
      quad.geometry.dispose()
      material.dispose()
      renderer.dispose()
      // Drop the GL context eagerly — `dispose()` alone leaves it alive
      // until GC, and an installation runs many of these.
      renderer.forceContextLoss()
    },
  }
}
