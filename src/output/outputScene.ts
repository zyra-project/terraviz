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
  latLonToDirection,
  type EquirectParams,
} from './equirectRtt'
import { getSunPosition } from '../utils/time'
import { getCloudTextureUrl, isMobile } from '../utils/deviceCapability'
import { logger } from '../utils/logger'
import { NADIR_LUT_SIZE, buildNadirScatterLut } from './atmosphereNadir'
import {
  ATMOSPHERE_STEPS_HIGH,
  ATMOSPHERE_STEPS_MOBILE,
} from '../services/atmosphereConstants'
import {
  DECORATION_UNIFORMS,
  MAX_OUTPUT_LAYERS,
  buildOutputFragmentShader,
  overlayUniformNames,
} from './layerStack'
// The rung ladder lives in `protocol.ts` because the Outputs panel
// offers it and this module snaps to it, and the panel cannot import
// the output bundle. Re-exported so the scene's own callers do not have
// to know that.
import {
  DEFAULT_BLEND_GAMMA,
  DEFAULT_OUTPUT_MODE,
  FRAMEBUFFER_WIDTHS,
  isBlendGamma,
  type FramebufferWidth,
  type OutputMode,
  type OutputWarpSet,
} from '../services/multiOutput/protocol'
import {
  WARP_ATTRIBUTES,
  WARP_UNIFORMS,
  WARP_VERTEX_SHADER,
  buildWarpGeometry,
  placeWarpSet,
  type WarpSetRefusal,
} from './projectorWarp'
export { FRAMEBUFFER_WIDTHS, type FramebufferWidth }
import { COLOR_SCALE_LUT_SIZE, buildColorScaleLut } from '../types/color-scale'
import { buildDisplayLut, type ColorScaleDisplay } from '../services/colorScaleDisplay'
import type { DatasetOverlayOptions } from '../types'

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

/**
 * How fast the loop should redraw for the media currently loaded.
 *
 * **A paused video is static.** `kind` cannot be latched from the
 * dataset: an output holding one frame — the operator paused, or the
 * date is outside this dataset's span, both of which `outputSync`
 * expresses by pausing the element — would redraw that identical frame
 * 30 times a second, which is 30× the GPU for no picture change on
 * hardware that may be driving sixteen of these.
 *
 * Read off the element rather than off the sync outcome, because the
 * element is the ground truth: a dataset with no time axis is left
 * looping by design (`outputSync` returns `no-range` and does not touch
 * it), and pacing that at the static floor would judder an animation
 * nothing is wrong with.
 *
 * Structural in its parameter so a test needs no media element.
 */
export function contentKindFor(
  media: { kind: 'image' | 'video'; video: { paused: boolean } | null } | null,
): OutputContentKind {
  if (!media) return 'idle'
  if (media.kind === 'video' && media.video !== null && !media.video.paused) return 'video'
  // Everything that is not `'video'` buckets at the static floor in
  // `frameIntervalMs`, which is what a held frame wants.
  return 'image'
}

export function frameIntervalMs(kind: OutputContentKind): number {
  return kind === 'video' ? VIDEO_FRAME_MS : STATIC_FRAME_MS
}

export interface FrameDecisionState {
  kind: OutputContentKind
  /** The rAF timestamp for this callback. */
  nowMs: number
  /** When the next frame is due — from the last answer
   *  `advanceFrameDeadline` gave, carried across callbacks by the loop. */
  dueMs: number
  /** The interval `dueMs` was set for: the frame interval of the kind
   *  drawn when the deadline last moved, 0 before the first draw. A
   *  deadline is stale only when it was set for a slower kind than the
   *  one now showing — see `isStaleDeadline`. */
  dueIntervalMs: number
  /**
   * ms since the previous render-loop callback — how often the browser
   * is *offering* a frame. Required rather than optional, because a
   * default of zero is exactly the bug this field was added to fix and
   * a silent default is how a call site inherits it.
   */
  sinceLastCallbackMs: number
  /** Set by a state diff, a texture upload, or a resize. */
  dirty: boolean
}

/**
 * Should the loop draw this tick?
 *
 * Two independent reasons to draw, and both matter: something changed
 * (`dirty`), or a *playing* video's next frame is due. A static output
 * that nothing has touched draws at 1 Hz rather than never, so a
 * dropped texture upload or a lost context surfaces as a stale frame
 * the read-back layer can catch rather than as a loop that has quietly
 * stopped.
 *
 * ## Why this is a deadline, and why the deadline is carried
 *
 * A plain `sinceLastFrame >= interval` **aliases** against a display
 * whose refresh equals the cap, and hardware found it: an output on a
 * 30 Hz monitor was offered 30 callbacks a second — 33.33 ms apart —
 * against a video interval of 33.33 ms, so whether a callback cleared
 * the gate came down to jitter in the last decimal. The ones that
 * missed waited a whole further callback, turning a 33 ms frame into a
 * 67 ms one, and the loop settled at ~22 fps while being offered
 * exactly 30.
 *
 * The first fix asked the better question — *is this callback closer to
 * the target than the next one will be* — but asked it of
 * `sinceLastFrame`, which is measured from the **previous draw**. That
 * throws the phase away every frame, so the answer is still a knife
 * edge wherever `interval / offered` lands near a half-integer, and
 * simulation over a sweep of refresh rates says the edge is where most
 * real displays are: 75 Hz gave 25 fps, 48 and 50 gave 24 and 25, 144
 * and 165 gave 28.8 and 28.7, and 33 / 35 / 40 / 100 drew on *every*
 * callback and so ran over the cap they exist to respect. Only exact
 * multiples of 30 — 30, 60, 90, 120, 240 — came out right, which is
 * exactly the set the original tests sampled.
 *
 * So the deadline is carried instead of re-derived. `advanceFrameDeadline`
 * moves it on by one whole interval from **where it was due**, not from
 * when the frame happened to be drawn, so an early or late draw costs
 * that frame's phase rather than the rate: at 45 Hz the loop alternates
 * one and two callbacks per draw and averages 30. A tie in the last
 * decimal now changes which side of a boundary one frame lands on, and
 * nothing else — which is what removes the whole class of bug rather
 * than moving it to a different refresh rate.
 *
 * Carried only for the frames it paces, though, which took a third go.
 * A draw made because something changed is **out of band**, and moving
 * the deadline on from where it was due then put it more than one
 * interval out, which the stale-deadline clause then read as an
 * interval that just shrank and drew at once. That draw moved it out
 * again, so one dataset load, `#` change or camera move left the loop
 * drawing on every callback for good: 60 fps over a paused frame, the
 * static floor and a playing video alike, found from a Second Life
 * globe's readout and reproduced in simulation. `advanceFrameDeadline`
 * now tells the three kinds of draw apart (see there).
 */
export function shouldRenderFrame(state: FrameDecisionState): boolean {
  if (state.dirty) return true
  // The content has started moving (static → video) under a deadline
  // set a second out; holding it would stall the first video frame by
  // up to that long.
  if (isStaleDeadline(state)) return true
  // Nearest deadline: draw when waiting for the next callback would
  // overshoot by more than drawing now undershoots. No tolerance
  // constant, because the offered interval is the scale the comparison
  // belongs at.
  return state.dueMs - state.nowMs <= state.sinceLastCallbackMs / 2
}

/**
 * A deadline set for a slower kind than the one now showing, and still
 * more than one of this kind's intervals out: the interval shrank
 * (static → video), and the deadline is the old kind's, not this one's.
 * One already within an interval of the new kind is kept, so the first
 * video frame lands on the phase it was going to have rather than at
 * once.
 *
 * The label is the half that matters. Distance alone was the first
 * version, and a paced draw can legitimately leave the next deadline a
 * little more than an interval out (it may be up to half a callback
 * early); a callback that then came soon after read that as stale and
 * drew again. A cadence alternating short and long callbacks did that
 * on every pair, 66 fps on a 165 Hz display against a cap of 30 (found
 * in review by simulation). Only a deadline set for a longer interval
 * can be stale.
 */
function isStaleDeadline(state: Omit<FrameDecisionState, 'dirty'>): boolean {
  const interval = frameIntervalMs(state.kind)
  return state.dueIntervalMs > interval && state.dueMs - state.nowMs > interval
}

/** A deadline and the interval it was set for, which the loop carries
 *  whole from one draw to the next. */
export type FrameDeadline = Pick<FrameDecisionState, 'dueMs' | 'dueIntervalMs'>

/**
 * When the frame after this one is due, given a frame just drawn. Takes
 * the state `shouldRenderFrame` was given, so the two agree on which
 * draws were paced, and returns the deadline with the interval it was
 * set for, so the label changes only when the deadline moves. The loop
 * once set the two itself, in an order that mattered and that nothing
 * tested: labelled first, a stale draw read as out of band and the first
 * video frame waited up to a second (found in review).
 *
 * Three kinds of draw, told apart by where the deadline stood:
 *
 * - **Paced**: the deadline had arrived, which is `shouldRenderFrame`'s
 *   own test. The next is one whole interval on from the deadline just
 *   met, **not** from the moment it was met — that is the entire
 *   mechanism above, and the reason the rate survives a display whose
 *   refresh is not a multiple of the cap. A deadline already behind is
 *   clamped to `nowMs`, so a display slower than the cap draws on
 *   every callback without accumulating debt for as long as the
 *   installation runs, and a hitch costs one catch-up frame on the next
 *   callback rather than the frame it delayed. One more than
 *   `STATIC_FRAME_MS` behind is a gap in drawing, not a hitch (a hidden
 *   tab, a lost context), and starts again one interval from now: there
 *   the catch-up was a second frame back to back. Restarting after any
 *   lateness, the first fix for that, dropped the owed frame on every
 *   hitch, and a loaded host read 24–27 fps (found in review).
 * - **Out of band**: drawn early because something changed. The paced
 *   frame it came ahead of is still owed, so its deadline stands, and
 *   so does the interval it was set for.
 *   Moving it on an interval from where it was due put it more than an
 *   interval out, and the runaway that started is the third paragraph
 *   above.
 * - **Stale**: the deadline was set for a slower kind and sits more
 *   than one of this kind's intervals out (`isStaleDeadline`), which is
 *   static → video. It starts again from now; carrying it on would
 *   leave it out of reach for good. So does the first draw, which has
 *   no deadline to carry.
 */
export function advanceFrameDeadline(state: Omit<FrameDecisionState, 'dirty'>): FrameDeadline {
  const interval = frameIntervalMs(state.kind)
  const fromNow = { dueMs: state.nowMs + interval, dueIntervalMs: interval }
  if (state.dueIntervalMs === 0 || isStaleDeadline(state)) return fromNow
  if (state.dueMs - state.nowMs > state.sinceLastCallbackMs / 2) {
    return { dueMs: state.dueMs, dueIntervalMs: state.dueIntervalMs }
  }
  const next = state.dueMs + interval
  if (state.nowMs - next > STATIC_FRAME_MS) return fromNow
  return { dueMs: Math.max(next, state.nowMs), dueIntervalMs: interval }
}

// --- Scene construction ---

type ThreeModule = typeof import('three')

export interface OutputSceneDeps {
  /** Lazy Three import, mirroring `globeThumbnail`'s seam so the
   *  chunk is shared and the page stays light until it renders. */
  loadThree?: () => Promise<ThreeModule>
  createEarth?: typeof import('../services/photorealEarth').createPhotorealEarth
  /**
   * The cloud asset, as a raw decoded image.
   *
   * Its own seam rather than a branch of `createEarth`, because this
   * module wants the source luminance and that module hands out alpha
   * baked at a gamma tuned for a different surface. Resolving `null`
   * means "no clouds", which is a correct Earth rather than a failure.
   */
  loadCloudImage?: () => Promise<TexImageSource | null>
  /**
   * Watch the canvas's size, for a `projector-warp` window's native
   * sizing. Calls `onResize` once straight away and again on every
   * change; returns the unwatch. A seam because the default is a
   * `ResizeObserver`, which a test environment has without the layout
   * engine that would ever fire it.
   */
  observeSize?: (canvas: HTMLCanvasElement, onResize: () => void) => () => void
}

function defaultObserveSize(canvas: HTMLCanvasElement, onResize: () => void): () => void {
  onResize()
  if (typeof ResizeObserver === 'undefined') return () => {}
  const observer = new ResizeObserver(() => onResize())
  observer.observe(canvas)
  return () => observer.disconnect()
}

/**
 * What a `projector-warp` window is drawing, for the HUD — and, when it
 * is drawing nothing, why. `null` from `warpState()` for any other mode.
 */
export type WarpDrawState =
  /** No set has been sent: the operator has not imported one. */
  | { readonly state: 'none' }
  /** A set arrived and the warp check refused it. */
  | { readonly state: 'refused'; readonly refusal: WarpSetRefusal }
  | {
      readonly state: 'drawn'
      readonly id: string
      readonly meshes: number
      readonly triangles: number
      /** Triangles dropped as too wide for any real cell — never on a sphere, so a number here means a mesh surface's UV islands. */
      readonly droppedWide: number
    }

/** Decodes the shared cloud asset. `crossOrigin` because the CDN copy
 *  is another origin and a tainted image cannot be uploaded. */
function defaultLoadCloudImage(): Promise<TexImageSource | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = getCloudTextureUrl()
  })
}

export interface OutputSceneOptions {
  canvas: HTMLCanvasElement
  /** Target framebuffer width; snapped by `resolveFramebufferSize`. */
  framebufferWidth?: number
  params?: EquirectParams
  /**
   * The geometry this window was spawned as, read from its URL. Absent
   * is `sos-equirect`. A `projector-warp` window draws nothing until it
   * holds a warp set (rung 16): an unwarped equirect thrown across
   * projectors calibrated for a warp is worse than black.
   */
  mode?: OutputMode
}

/**
 * One composited overlay: the mirrored dataset, or one of its layers.
 *
 * `kind` is carried rather than sniffed with `instanceof`. A
 * `HTMLVideoElement` check is unavailable to a test running in
 * happy-dom against a plain object, so sniffing would make the video
 * path — the one that needs a per-frame-updating `VideoTexture` —
 * exactly the path no test could reach.
 */
export interface OutputLayerInput {
  kind: 'image' | 'video'
  /**
   * A canvas is accepted alongside the two media elements because rung
   * 14b's calibration pattern is one, and the point of that pattern is
   * that it rides the *same* slot a dataset does — through the bbox
   * clipping, the `lonOrigin` shift and the flip — so that a pattern
   * which lands right proves a dataset will. Three's `Texture` takes
   * any of the three unchanged, so this costs the type and nothing
   * else; `kind: 'image'` is what a canvas carries, since what the
   * distinction selects is `Texture` versus a per-frame `VideoTexture`.
   */
  element: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
  overlay: DatasetOverlayOptions
  /**
   * The operator's palette / stretch / threshold, for a data-encoded
   * layer. Absent leaves the dataset's own palette — which is the right
   * answer for a stacked layer, since the operator's controls act on
   * the primary.
   */
  display?: ColorScaleDisplay | null
}

/**
 * What this window has observed about its GPU context — facts, not a
 * verdict on the picture (`docs/MULTI_MONITOR_PLAN.md` §3, case 5).
 *
 * Deliberately three observations rather than a healthy/broken pair,
 * because the useful distinction on a projector is between "there was
 * a GPU event and it is still out" and "there was one and it came
 * back". Neither says the sphere is correct: this module can see the
 * two DOM events and cannot see the glass.
 */
export type GpuContextState =
  /** No loss seen since this scene was built. */
  | 'live'
  /** `webglcontextlost` fired and no restore has followed. Three's
   *  renderer makes `render()` a no-op in this state, so nothing is
   *  reaching the drawing buffer at all. */
  | 'lost'
  /** A loss was followed by `webglcontextrestored`. Three rebuilds its
   *  GL state and re-uploads lazily on the next draw; this state does
   *  not claim it succeeded, only that the browser handed the context
   *  back. */
  | 'restored'

export interface OutputScene {
  readonly size: FramebufferSize
  /** Whether something changed since the last call — read once and
   *  cleared, so the render loop can feed `shouldRenderFrame`'s
   *  `dirty` input without the scene needing a callback into it. */
  consumeDirty(): boolean
  /** Draw one frame. */
  render(): void
  /**
   * What this window last observed about its GPU context.
   *
   * The render loop reads it to stop counting frames it did not draw:
   * while the context is lost `render()` returns immediately, so a
   * loop that went on ticking its fps meter would report a healthy
   * rate over a blank projector — the exact shape of invisible failure
   * this feature exists to remove.
   */
  gpuState(): GpuContextState
  /**
   * Subscribe to transitions. Returns an unsubscribe.
   *
   * A subscription rather than a constructor option because the
   * consumer that most wants it — the IPC link, which tells the
   * manager — does not exist yet when the scene is built, and a window
   * that lost its context during boot is precisely the one worth
   * hearing about.
   */
  onGpuStateChange(listener: (state: GpuContextState) => void): () => void
  /**
   * Turn the day/night terminator (and with it the night lights) on or
   * off — the mirrored `view.dayNight`.
   *
   * Off is not "no decoration": clouds stay, in their day colouring,
   * because cloud cover is geography rather than illumination. The flag
   * collapses to a night factor of zero, which is a no-op multiply
   * rather than a branch.
   */
  setDayNight(on: boolean): void
  /** Swap the projection parameters (camera offset / split). */
  setParams(params: EquirectParams): void
  /**
   * Composite these overlays over the base Earth, in array order.
   *
   * Array order *is* z-order — one fragment shader, no depth buffer to
   * disagree with it. Called on a state change, never per frame: it
   * can rebuild the shader.
   */
  setLayers(layers: readonly OutputLayerInput[]): void
  /**
   * Resize the drawing buffer, snapping to the supported ladder.
   *
   * The **framebuffer**, never the window: an output is fullscreen on
   * its monitor and stays there. A rung below the window's own pixel
   * count scales up rather than shrinking into a corner, which is the
   * "preview an 8K sphere on a 1080p desk monitor" workflow.
   *
   * A no-op when the snapped size is unchanged, so an operator
   * re-picking the current rung does not reallocate a 128 MiB buffer.
   */
  setFramebufferWidth(width: number): void
  /**
   * Replace the cloud image — a refresh, since the upstream image is
   * replaced every ten minutes and the first load is otherwise the only
   * one (`docs/SECOND_LIFE_COMPAT.md` §7 item 8). The old texture is
   * freed and the next frame draws the new one without waiting out the
   * 1 Hz static floor.
   */
  setCloudImage(image: TexImageSource): void
  /**
   * Draw this warp set, or — for `null` or a set the warp check refuses
   * — nothing, which is what a `projector-warp` window with no usable
   * set must show: an unwarped frame across calibrated projectors is
   * worse than black. Geometry is rebuilt only when the set's content
   * id changes, since the render config resends the set whole on every
   * resync. A no-op in any other mode.
   */
  setWarp(warp: OutputWarpSet | null): void
  /** The gamma a warp's blend weight is applied through. One that is
   *  not a gamma falls back to the default rather than drawing black. */
  setBlendGamma(gamma: number): void
  /** What the warp is drawing, or why not — `null` in any other mode. */
  warpState(): WarpDrawState | null
  /**
   * The GPU this webview actually got, or `null` when the driver will
   * not say.
   *
   * Surfaced because the app cannot choose: a spike found the webview
   * silently on the iGPU of a machine with a 4090, `powerPreference` is
   * inert, and neither wry nor tauri reads an override — so an
   * unattended installation can run at a fraction of its provisioned
   * capacity, undiagnosable from logs. Seeing the string is the whole
   * mitigation (plan §Risks).
   */
  rendererName(): string | null
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
/** The slice of a Three texture this module touches. */
interface TextureLike {
  needsUpdate?: boolean
  // Sampler state, optional because only the LUT upload sets it: a
  // `DataTexture` defaults to nearest filtering and every other
  // texture here arrives already configured by whoever loaded it.
  minFilter?: unknown
  magFilter?: unknown
  wrapS?: unknown
  wrapT?: unknown
  // Written by `useDisplaySpace`, which is the whole reason this is
  // not `readonly`: the textures arrive tagged for another material.
  colorSpace?: unknown
  dispose(): void
}

interface ShaderMaterialLike {
  dispose(): void
}

/**
 * The integration tier for this machine's scattering table.
 *
 * Mirrors `earthTileLayer`'s own `isMobile() ? MOBILE : HIGH` choice
 * rather than picking independently, because the whole point of the
 * table is that the output and the control globe agree — and
 * `isMobile()` is `innerWidth <= 768 || maxTouchPoints > 0`, so it is
 * true of a touchscreen desktop, not only a phone. An output that
 * hard-coded HIGH there would integrate more finely than the globe
 * beside it and render a bluer ocean, which is the failure this whole
 * path exists to remove.
 */
function atmosphereStepsForDevice(): { primarySteps: number } {
  return isMobile() ? ATMOSPHERE_STEPS_MOBILE : ATMOSPHERE_STEPS_HIGH
}

/**
 * Put a texture into the colour space this shader actually works in.
 *
 * `photorealEarth` tags its diffuse and night-lights `SRGBColorSpace`,
 * which is right for *its* material: Three uploads those with an sRGB
 * internal format, so the sampler decodes to linear and the lighting
 * pipeline downstream expects exactly that. This module has no such
 * pipeline. It renders one quad with a hand-written `ShaderMaterial`
 * straight to the default framebuffer — no `colorspace_fragment`
 * chunk, so nothing re-encodes on the way out — and every constant in
 * `layerStack` is copied from `earthTileLayer`, which grades and
 * composites in sRGB **display** space because it reads the MapLibre
 * framebuffer (see `photorealEarth`'s own note at the contrast knob).
 *
 * Decoded-linear input under display-space constants is a real,
 * measured error and not a subtlety: lit daytime land
 * `rgb(181, 150, 103)` reached the framebuffer as `rgb(112, 68, 31)` —
 * about 60% brightness, crushed toward red — and contrast-around-0.5
 * in linear space drove the ocean to black. It predates the colour
 * grade; rung 12c's decoration inherited it the same way.
 *
 * So the decode is removed rather than compensated for, which makes
 * every copied constant correct by construction instead of correct
 * after an offsetting transform. The cloud texture already works this
 * way — it is built here by `new Texture(img)` and left at Three's
 * default `NoColorSpace` — so this brings the other two into line with
 * the one that was never wrong.
 *
 * Mutating a texture another module created is the part to be uneasy
 * about. It is safe here because `createPhotorealEarth` builds these
 * per call and this window holds its own instance: VR and Orbit have
 * theirs, and an output page never constructs one of those anyway.
 * `colorSpace` is set *before* `needsUpdate` because Three bakes the
 * space in at upload, so the flag is what forces the re-upload.
 */
function useDisplaySpace<T extends TextureLike>(
  three: unknown,
  tex: T | null | undefined,
): T | null | undefined {
  if (!tex) return tex
  tex.colorSpace = (three as { NoColorSpace?: unknown }).NoColorSpace
  tex.needsUpdate = true
  return tex
}

/** What is currently bound to one overlay slot. */
interface LayerSlot {
  /** Identity, so a metadata-only `setLayers` keeps the map texture. */
  element: unknown
  map: TextureLike
  lut: TextureLike | null
}

/**
 * A still image needs `needsUpdate` set once; a `VideoTexture` sets it
 * itself every frame, which is the whole reason the two are different
 * classes.
 */
function imageTexture(THREE_: ThreeModule, element: unknown): TextureLike {
  const tex = new (THREE_ as unknown as { Texture: new (i: unknown) => TextureLike }).Texture(
    element,
  )
  tex.needsUpdate = true
  return tex
}

/**
 * The 256×1 palette a data-encoded layer is coloured through, or `null`
 * when the layer is already a picture.
 *
 * When the operator has a display transform, it is built *through*
 * `buildDisplayLut` rather than by post-processing
 * `buildColorScaleLut`: the transform has to keep the dataset's own
 * alpha profile, and a palette swap that dropped it would paint the
 * no-data band instead of leaving it clear.
 */
function paletteTexture(
  THREE_: ThreeModule,
  overlay: DatasetOverlayOptions,
  display: ColorScaleDisplay | null,
): TextureLike | null {
  const scale = overlay.colorScale
  if (!scale) return null
  const bytes = display ? buildDisplayLut(scale, display) : buildColorScaleLut(scale)
  const api = THREE_ as unknown as {
    DataTexture: new (d: Uint8Array, w: number, h: number, f: unknown) => TextureLike
    RGBAFormat: unknown
  }
  const tex = new api.DataTexture(bytes, COLOR_SCALE_LUT_SIZE, 1, api.RGBAFormat)
  tex.needsUpdate = true
  return tex
}

/** Uniforms are created lazily: a slot's entry does not exist until the
 *  shader that declares it has been built. */
function setUniform(
  uniforms: Record<string, { value: unknown }>,
  name: string,
  value: unknown,
): void {
  const existing = uniforms[name]
  if (existing) existing.value = value
  else uniforms[name] = { value }
}

export async function createOutputScene(
  options: OutputSceneOptions,
  deps: OutputSceneDeps = {},
): Promise<OutputScene> {
  const THREE_ = await (deps.loadThree ?? defaultLoadThree)()
  const warpMode = (options.mode ?? DEFAULT_OUTPUT_MODE) === 'projector-warp'
  /**
   * A `projector-warp` window's drawing buffer is the **window's own
   * pixels**, not a rung (rung 16): a projector raster is whatever shape
   * the spanned display is, and no rung of a 2:1 ladder is 3840×2160.
   * Client size times the pixel ratio, rounded — the buffer then maps
   * one-to-one onto the display, so a viewport's fraction of it is the
   * same fraction of the projectors.
   */
  const nativeSize = (): FramebufferSize => {
    const ratio = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    return {
      width: Math.max(1, Math.round(options.canvas.clientWidth * ratio)),
      height: Math.max(1, Math.round(options.canvas.clientHeight * ratio)),
    }
  }
  const size = warpMode
    ? nativeSize()
    : resolveFramebufferSize(options.framebufferWidth ?? FRAMEBUFFER_WIDTHS[2])

  const renderer = new THREE_.WebGLRenderer({ canvas: options.canvas, antialias: false })
  // `false` leaves the CSS size alone: the drawing buffer is the
  // equirect framebuffer and is deliberately independent of how large
  // the window happens to be.
  renderer.setSize(size.width, size.height, false)
  renderer.setClearColor(0x000000, 1)

  // --- GPU context loss (plan §3, case 5) ---
  //
  // Registered here rather than beside the rest of the mutable state
  // below, because everything between this line and there is awaited
  // (`createEarth`, the cloud fetch) and a context lost in that window
  // would be seen by Three and missed by us — leaving `gpuState()`
  // reporting `live` over a renderer that had already stopped drawing.
  //
  // **No `preventDefault()` here, and that is not an omission.** The
  // plan prescribes one; Three's `WebGLRenderer` already calls it from
  // its own listener, registered inside the constructor above (and
  // before the context exists, which is why it catches a creation-time
  // loss). It also sets the flag that makes `render()` return
  // immediately, and rebuilds its GL state on restore. Adding a second
  // `preventDefault()` would be harmless and would imply this module
  // works without Three's, which it does not: if that behaviour ever
  // went away, `render()` would throw on a dead context long before a
  // missing `preventDefault()` mattered. The dependency is real, so it
  // is written down rather than papered over.
  let gpuState: GpuContextState = 'live'
  const gpuListeners = new Set<(state: GpuContextState) => void>()
  const setGpuState = (next: GpuContextState): void => {
    if (gpuState === next) return
    gpuState = next
    // Isolated for `globeStateEvents`' reason: these run from a DOM
    // event handler, and one listener throwing must not stop the rest
    // hearing about the one event they exist for.
    for (const listener of gpuListeners) {
      try {
        listener(next)
      } catch (err) {
        logger.warn('[Output] a GPU-state listener threw:', err)
      }
    }
  }
  const onContextLost = (): void => {
    logger.error(
      '[Output] WebGL context lost — this window is drawing nothing until it returns',
    )
    setGpuState('lost')
  }
  const onContextRestored = (): void => {
    // A warning, not an info: it sits above the level production
    // filters to, for the reason #403 gives — the device this matters
    // on has no console attached and the log is read after the fact.
    logger.warn('[Output] WebGL context restored — Three is rebuilding its GL state')
    setGpuState('restored')
  }
  options.canvas.addEventListener('webglcontextlost', onContextLost, false)
  options.canvas.addEventListener('webglcontextrestored', onContextRestored, false)
  // Reconciled, not merely subscribed. Three's listeners go on inside
  // the constructor above and this module's go on after it returns, so
  // a context already gone by this line would leave Three's renderer
  // refusing to draw while `gpuState` reported `live` — and the HUD,
  // the manager and the telemetry would all miss the incident.
  //
  // The spec queues `webglcontextlost` as a task rather than firing it
  // synchronously, so in practice nothing can run between the
  // constructor and this line. That is an argument, and `isContextLost()`
  // is an observation: it costs one call at construction and does not
  // depend on the event loop behaving the way the argument says.
  // Raised in review on the PR that added this block.
  try {
    const gl = (
      renderer as unknown as { getContext?: () => { isContextLost?: () => boolean } | null }
    ).getContext?.()
    if (gl?.isContextLost?.()) onContextLost()
  } catch (err) {
    // A driver that will not answer costs the reconciliation, not the
    // scene — the listeners above are still installed and a later loss
    // is still seen.
    logger.warn('[Output] could not check the initial context state:', err)
  }

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
    // Off, and the clouds are loaded here instead — see
    // `loadCloudImage`. This module needs the *raw* asset: that
    // loader bakes luminance to alpha at a gamma tuned for a lit shell
    // seen from outside, and splicing it into this composite's opacity
    // washed the whole day side grey.
    includeClouds: false,
    includeSun: false,
    includeShadow: false,
  })

  // Static by construction (see the uniform's note below), so this is
  // the one texture built eagerly rather than on an asset arriving.
  // A failure costs the ocean its colour, not the render loop.
  //
  // The tier is read *here* rather than defaulted inside the builder,
  // because `earthTileLayer` picks its own from `isMobile()` and that
  // is true of any touch-capable machine, not just a phone — a
  // touchscreen desktop would otherwise run the control globe at 10
  // steps and this output at 16, making the output's ocean bluer than
  // the globe it exists to match. `atmosphereNadir` stays pure; this
  // module already reads the environment for `getCloudTextureUrl`.
  //
  // Both filters are set explicitly because `THREE.DataTexture`
  // defaults to `NearestFilter` — unlike `Texture` — which would
  // quantise the sun-angle lookup into 256 bands and stop the shader
  // agreeing with `sampleNadirLut`, the TS mirror it is tested
  // against. Same four properties `photorealEarth` sets on both of
  // its own LUT uploads.
  let atmosphereLut: TextureLike | null = null
  try {
    const api = THREE_ as unknown as {
      DataTexture: new (d: Uint8Array, w: number, h: number, f: unknown) => TextureLike
      RGBAFormat: unknown
      LinearFilter: unknown
      ClampToEdgeWrapping: unknown
    }
    atmosphereLut = new api.DataTexture(
      buildNadirScatterLut(NADIR_LUT_SIZE, atmosphereStepsForDevice().primarySteps),
      NADIR_LUT_SIZE,
      1,
      api.RGBAFormat,
    )
    atmosphereLut.minFilter = api.LinearFilter
    atmosphereLut.magFilter = api.LinearFilter
    atmosphereLut.wrapS = api.ClampToEdgeWrapping
    atmosphereLut.wrapT = api.ClampToEdgeWrapping
    atmosphereLut.needsUpdate = true
  } catch (err) {
    logger.warn('[outputScene] atmosphere LUT unavailable', err)
    atmosphereLut = null
  }

  // Everything this shader samples must be in display space; see
  // `useDisplaySpace`. Done once here so the placeholder binds below
  // (which reuse `baseEarthTexture`) pick up the same retagged object,
  // and again in each change callback, since a tier upgrade hands over
  // a texture this has never seen.
  useDisplaySpace(THREE_, earth.baseEarthTexture)
  useDisplaySpace(THREE_, earth.baseDiffuseTexture)
  useDisplaySpace(THREE_, earth.nightLightsTexture)

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
    // `set` takes its nine arguments row-major, which is how
    // `EquirectParams.orientation` is laid out; Three stores and uploads
    // column-major, as a GLSL `mat3` expects.
    [EQUIRECT_UNIFORMS.orientation]: {
      value: new THREE_.Matrix3().set(...(options.params ?? IDENTITY_PARAMS).orientation),
    },
    [EQUIRECT_UNIFORMS.split]: { value: (options.params ?? IDENTITY_PARAMS).split },
    [EQUIRECT_UNIFORMS.rotationOffset]: {
      value: (options.params ?? IDENTITY_PARAMS).rotationOffsetRad,
    },
    // Derived here through `latLonToDirection`, **not** copied from
    // `earth.sunDir`. Sharing `getSunPosition` is not enough: that
    // handle's vector is built for the globe *mesh*'s frame, which
    // negates Z relative to this one, so borrowing it put the sun at
    // the mirrored longitude and lit the wrong hemisphere. Running the
    // subsolar point through the same function `cameraOffsetForCamera`
    // uses puts the sun and the camera in one frame by construction,
    // which is the property that actually matters.
    [DECORATION_UNIFORMS.sunDir]: { value: new THREE_.Vector3(1, 0, 0) },
    [DECORATION_UNIFORMS.dayNight]: { value: 1 },
    // Bound to the base Earth until the real maps land, never to
    // `null`, for the reason the sphere sampler is: an unbound sampler
    // is a driver-dependent read on a surface where black is
    // indistinguishable from a fault. The `has*` flags are what
    // actually gate them, so what is bound meanwhile is never sampled.
    [DECORATION_UNIFORMS.lightsMap]: { value: earth.baseEarthTexture },
    [DECORATION_UNIFORMS.hasLights]: { value: earth.nightLightsTexture ? 1 : 0 },
    [DECORATION_UNIFORMS.cloudMap]: { value: earth.baseEarthTexture },
    [DECORATION_UNIFORMS.hasCloud]: { value: 0 },
    // Atmospheric scattering, reduced to a static 1 KiB table. It is
    // indexed by the *sun cosine*, which the shader derives per
    // fragment from `uSunDir` — the sun's position never enters the
    // table, so unlike every other texture here it is built once and
    // never rebuilt, not even as the sun moves. See `atmosphereNadir`.
    // Falls back to the base texture rather than `null` for the reason
    // the two samplers above do: a null sampler is undefined behaviour
    // that some drivers answer with black, and black here would tint
    // the whole sphere rather than fail visibly.
    [DECORATION_UNIFORMS.atmosphereLut]: {
      value: atmosphereLut ?? earth.baseEarthTexture,
    },
    [DECORATION_UNIFORMS.hasAtmosphere]: { value: atmosphereLut ? 1 : 0 },
    // Declared by the warp variant only, and harmless beside the others.
    [WARP_UNIFORMS.blendGamma]: { value: DEFAULT_BLEND_GAMMA },
  }
  if (earth.nightLightsTexture) {
    uniforms[DECORATION_UNIFORMS.lightsMap].value = earth.nightLightsTexture
  }

  /**
   * Rebuilt whenever the slot *count* changes, and only then.
   *
   * GLSL ES 1.00 has no dynamic sampler indexing, so `layerStack`
   * unrolls one block per slot at build time — which means the shader
   * text is a function of the count and a new count is a recompile.
   * Everything else about a layer (its texture, bbox, palette) is a
   * uniform write, so an operator changing a palette costs an upload
   * rather than a compile.
   */
  const buildMaterial = (layerCount: number): ShaderMaterialLike =>
    new THREE_.ShaderMaterial({
      // A warp window's vertex stage hands the fragment a direction and
      // a weight rather than a texel, and its fragment turns the
      // direction back into `vUv` before the pass runs (rung 16).
      vertexShader: warpMode ? WARP_VERTEX_SHADER : EQUIRECT_VERTEX_SHADER,
      // The same `uniforms` object every time: the base sphere sampler
      // and the projection params must survive a recompile, and
      // rebuilding them would reset the camera on every layer change.
      fragmentShader: buildOutputFragmentShader(layerCount, { warp: warpMode }),
      uniforms: uniforms as never,
      depthTest: false,
      depthWrite: false,
    }) as unknown as ShaderMaterialLike

  let slotCount = 0
  let material = buildMaterial(slotCount)
  const quad = new THREE_.Mesh(new THREE_.PlaneGeometry(2, 2), material as never)
  // The quad covers clip space regardless of the camera; frustum
  // culling would test its (unused) world bounds and can cull it.
  quad.frustumCulled = false
  // A `projector-warp` window draws nothing until it holds a usable set
  // — the quad is the unwarped frame, which must never reach projector
  // rasters. The renderer still clears to black every frame, which
  // keeps the loop, the HUD and the 1 Hz floor honest about a window
  // that is running. `setWarp` swaps in the set's geometry and shows it.
  quad.visible = !warpMode
  scene.add(quad)
  /** The content id of the set last handed to `setWarp`, drawn or refused. */
  let warpId: string | null = null
  let warp: WarpDrawState = { state: 'none' }

  // The CDN loader upgrades 2K → 4K → 8K after first paint. Swap the
  // sampler and mark the scene dirty: at the 1 Hz static floor an
  // un-flagged upgrade would not reach the sphere for up to a second,
  // which on a projector reads as a resolution pop.
  let textureUpgraded = false
  /** Set once the async cloud fetch lands, so `dispose` can free it and
   *  a teardown mid-fetch can drop it. */
  let cloudTexture: (TextureLike & { needsUpdate: boolean }) | null = null
  let disposed = false
  const unsubscribeDiffuse = earth.onBaseDiffuseChange(tex => {
    uniforms[EQUIRECT_UNIFORMS.sphereTexture].value = useDisplaySpace(THREE_, tex)
    textureUpgraded = true
  })
  // Same treatment for the decoration maps: they arrive after first
  // paint too, and an un-flagged arrival would wait out the 1 Hz floor
  // before the city lights or the clouds appeared.
  const unsubscribeLights = earth.onNightLightsChange(tex => {
    uniforms[DECORATION_UNIFORMS.lightsMap].value = useDisplaySpace(THREE_, tex)
    uniforms[DECORATION_UNIFORMS.hasLights].value = 1
    textureUpgraded = true
  })
  // Loaded here rather than through the Earth handle: this composite
  // needs the raw asset, not that module's pre-baked alpha. Failure
  // costs the clouds and nothing else — an Earth without them is a
  // correct picture, and an output that refused to boot is not.
  const loadCloudImage = deps.loadCloudImage ?? defaultLoadCloudImage
  /** Bind a cloud image, freeing the one it replaces — the first load
   *  and every refresh after it take the same path. */
  const installCloud = (img: TexImageSource): void => {
    if (disposed) return
    const tex = new (THREE_ as unknown as {
      Texture: new (i: unknown) => TextureLike & { needsUpdate: boolean }
    }).Texture(img)
    tex.needsUpdate = true
    const replaced = cloudTexture
    cloudTexture = tex
    uniforms[DECORATION_UNIFORMS.cloudMap].value = tex
    uniforms[DECORATION_UNIFORMS.hasCloud].value = 1
    replaced?.dispose()
    textureUpgraded = true
  }
  void loadCloudImage()
    .then((img: TexImageSource | null) => {
      // A refresh that landed first already holds a newer image.
      if (img && !cloudTexture) installCloud(img)
    })
    .catch((err: unknown) => logger.warn('[Output] cloud texture unavailable:', err))

  /** What is bound to each slot, so a `setLayers` that changes only
   *  metadata can keep the decoder's texture rather than rebuilding
   *  it — the same reason `datasetMirror` keeps the decoder. */
  let slots: LayerSlot[] = []

  const disposeSlot = (slot: LayerSlot): void => {
    slot.map.dispose()
    slot.lut?.dispose()
  }

  let currentSize = size
  // Native sizing, tracked rather than read once: a window spawned
  // hidden has no size until it is shown, and a boot that races the
  // manager's `setFullscreen` corrects itself on the first resize
  // instead of rendering at a stale size.
  const unobserveSize = warpMode
    ? (deps.observeSize ?? defaultObserveSize)(options.canvas, () => {
        const next = nativeSize()
        if (next.width === currentSize.width && next.height === currentSize.height) return
        currentSize = next
        renderer.setSize(next.width, next.height, false)
        textureUpgraded = true
      })
    : () => {}

  return {
    get size() {
      return currentSize
    },
    /** True once since the last `render()` — drives `shouldRenderFrame`'s
     *  `dirty` input so an upgraded texture paints immediately. */
    consumeDirty() {
      const was = textureUpgraded
      textureUpgraded = false
      return was
    },
    gpuState() {
      return gpuState
    },
    onGpuStateChange(listener) {
      gpuListeners.add(listener)
      return () => gpuListeners.delete(listener)
    },
    render() {
      // On drawn frames only, and unthrottled: `getSunPosition` is pure
      // arithmetic, so recomputing it at the draw rate costs less than
      // the machinery to avoid it. Deliberately no dirty flag — the sun
      // moves ~0.004 degrees a second, and the 1 Hz static floor
      // already redraws faster than that is visible.
      const sun = getSunPosition(new Date())
      const dir = latLonToDirection(sun.lat, sun.lng)
      ;(
        uniforms[DECORATION_UNIFORMS.sunDir].value as {
          set: (x: number, y: number, z: number) => void
        }
      ).set(dir.x, dir.y, dir.z)
      renderer.render(scene, camera)
    },
    setDayNight(on: boolean) {
      const next = on ? 1 : 0
      if (uniforms[DECORATION_UNIFORMS.dayNight].value === next) return
      uniforms[DECORATION_UNIFORMS.dayNight].value = next
      textureUpgraded = true
    },
    setParams(params: EquirectParams) {
      const offset = uniforms[EQUIRECT_UNIFORMS.cameraOffset].value as {
        set: (x: number, y: number, z: number) => void
      }
      offset.set(params.cameraOffset.x, params.cameraOffset.y, params.cameraOffset.z)
      // Written in place, as the offset above is, so a camera move — one
      // per control-window frame during a drag — allocates nothing.
      const orientation = uniforms[EQUIRECT_UNIFORMS.orientation].value as {
        set: (...m: EquirectParams['orientation']) => unknown
      }
      orientation.set(...params.orientation)
      uniforms[EQUIRECT_UNIFORMS.split].value = params.split
      // Rung 14. A uniform write, not a shader rebuild: the rotation is
      // a scalar the fragment shader already reads, so an operator
      // dragging the slider costs an upload per frame rather than a
      // recompile — which is what makes a live nudge usable while
      // watching the sphere.
      uniforms[EQUIRECT_UNIFORMS.rotationOffset].value = params.rotationOffsetRad
    },
    setLayers(layers) {
      // Capped rather than an error: WebGL guarantees only 8 fragment
      // texture units and each slot spends two (map + palette), so the
      // ceiling is the hardware's. Dropping the tail is what the plan
      // asks for; failing the whole composite because a fifth shell
      // arrived would take the sphere down over a nicety.
      const wanted = layers.slice(0, MAX_OUTPUT_LAYERS)

      const nextSlots: LayerSlot[] = wanted.map((layer, i) => {
        const previous = slots[i]
        // The palette is rebuilt every time — a 1 KB array — while the
        // *map* is reused when the element is identical. That is the
        // split that matters: rebuilding a `VideoTexture` restarts the
        // upload path for a change the decoder never saw.
        const reusable = previous && previous.element === layer.element
        if (previous && !reusable) disposeSlot(previous)
        else if (previous) previous.lut?.dispose()

        const map = reusable
          ? previous.map
          : layer.kind === 'video'
            ? (new THREE_.VideoTexture(layer.element as never) as unknown as TextureLike)
            : imageTexture(THREE_, layer.element)
        const lut = paletteTexture(THREE_, layer.overlay, layer.display ?? null)
        return { element: layer.element, map, lut }
      })

      // Slots the new set no longer has. Each holds a GPU texture, and
      // an installation switching datasets all day leaks them all.
      for (const stale of slots.slice(wanted.length)) disposeSlot(stale)
      slots = nextSlots

      // Disposing the texture is only half of it: `uniforms` is
      // long-lived and keyed by slot name, so a removed slot's entry
      // keeps pointing at the disposed texture — and a Three texture
      // holds its `image`, which is the decoded video element. The
      // shader stops declaring these samplers on the rebuild below, so
      // nothing uploads them, but the reference alone pins one media
      // element per removed slot for the life of the window.
      for (let i = wanted.length; i < MAX_OUTPUT_LAYERS; i++) {
        const n = overlayUniformNames(i)
        if (uniforms[n.map]) uniforms[n.map].value = null
        if (uniforms[n.lut]) uniforms[n.lut].value = null
      }

      if (wanted.length !== slotCount) {
        slotCount = wanted.length
        const previousMaterial = material
        material = buildMaterial(slotCount)
        ;(quad as { material: unknown }).material = material
        previousMaterial.dispose()
      }

      wanted.forEach((layer, i) => {
        const n = overlayUniformNames(i)
        const slot = nextSlots[i]
        const bbox = layer.overlay.boundingBox
        setUniform(uniforms, n.map, slot.map)
        setUniform(uniforms, n.lut, slot.lut)
        setUniform(
          uniforms,
          n.bbox,
          new THREE_.Vector4(bbox?.n ?? 0, bbox?.s ?? 0, bbox?.w ?? 0, bbox?.e ?? 0),
        )
        setUniform(uniforms, n.hasBbox, bbox ? 1 : 0)
        setUniform(uniforms, n.lonOrigin, layer.overlay.lonOrigin ?? 0)
        setUniform(uniforms, n.flipY, layer.overlay.isFlippedInY ? 1 : 0)
        // `colorScale`'s presence *is* data-encoded mode — it is the
        // field the protocol carries the mode across on, so the shader
        // asks the same question every other render surface does.
        setUniform(uniforms, n.dataEncoded, layer.overlay.colorScale ? 1 : 0)
        // Per-layer opacity is out of scope (plan §MVP): the output
        // surfaces what the operator already configured, and nothing
        // upstream configures this.
        setUniform(uniforms, n.opacity, 1)
      })

      // A composite change that did not also upgrade a texture would
      // otherwise wait out the 1 Hz static floor before appearing.
      textureUpgraded = true
    },
    setCloudImage(image) {
      installCloud(image)
    },
    setFramebufferWidth(width) {
      // A warp window sizes itself from its canvas; the ladder is
      // `sos-equirect`'s, and a rung here would squeeze the projectors.
      if (warpMode) return
      const next = resolveFramebufferSize(width)
      if (next.width === currentSize.width && next.height === currentSize.height) return
      currentSize = next
      // `false` leaves the CSS size alone — the canvas stays full-bleed
      // on its monitor and `object-fit` reconciles the two, which is
      // what makes a rung smaller than the window scale up rather than
      // shrink into a corner.
      renderer.setSize(next.width, next.height, false)
      // The projection is per-pixel, so a resized buffer is a different
      // image even with nothing else changed; without this the new
      // resolution waits out the 1 Hz static floor.
      textureUpgraded = true
    },
    setWarp(set) {
      if (!warpMode) return
      if (set === null) {
        if (warp.state === 'none') return
        warpId = null
        warp = { state: 'none' }
        quad.visible = false
        textureUpgraded = true
        return
      }
      // Resent whole on every resync; the id is how a resend of the set
      // already drawn — or already refused — costs nothing.
      if (set.id === warpId) return
      warpId = set.id
      const checked = placeWarpSet(set.meshes)
      if (!checked.ok) {
        logger.error(`[Output] refusing warp set ${set.id} (${checked.refusal.code}); drawing nothing`)
        warp = { state: 'refused', refusal: checked.refusal }
        quad.visible = false
        textureUpgraded = true
        return
      }
      const built = buildWarpGeometry(checked.placed)
      const geometry = new THREE_.BufferGeometry()
      geometry.setAttribute('position', new THREE_.BufferAttribute(built.positions, 3))
      geometry.setAttribute(WARP_ATTRIBUTES.direction, new THREE_.BufferAttribute(built.directions, 3))
      geometry.setAttribute(WARP_ATTRIBUTES.weight, new THREE_.BufferAttribute(built.weights, 1))
      const mesh = quad as unknown as { geometry: { dispose(): void } }
      mesh.geometry.dispose()
      mesh.geometry = geometry
      quad.visible = built.vertexCount > 0
      warp = {
        state: 'drawn',
        id: set.id,
        meshes: checked.placed.length,
        triangles: built.vertexCount / 3,
        droppedWide: built.meshes.reduce((sum, m) => sum + m.droppedWide, 0),
      }
      textureUpgraded = true
    },
    setBlendGamma(gamma) {
      const next = isBlendGamma(gamma) ? gamma : DEFAULT_BLEND_GAMMA
      if (uniforms[WARP_UNIFORMS.blendGamma].value === next) return
      uniforms[WARP_UNIFORMS.blendGamma].value = next
      textureUpgraded = true
    },
    warpState() {
      return warpMode ? warp : null
    },
    rendererName() {
      try {
        const gl = (
          renderer as unknown as { getContext?: () => WebGLRenderingContext | null }
        ).getContext?.()
        if (!gl) return null
        // Masked on most browsers and unmasked in a packaged webview,
        // which is the case that matters — this exists for an operator
        // standing in front of an installation, not for the web build.
        const ext = gl.getExtension('WEBGL_debug_renderer_info') as {
          UNMASKED_RENDERER_WEBGL: number
        } | null
        if (!ext) return null
        const name = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        return typeof name === 'string' && name.length > 0 ? name : null
      } catch {
        // A driver that refuses the query must cost the readout, not
        // the frame it was going to be drawn over.
        return null
      }
    },
    dispose() {
      // Unhooked first, and the *order* is the correctness: this method
      // ends with `renderer.forceContextLoss()`, which fires
      // `webglcontextlost` on the canvas — the same event a driver
      // crash fires. Unhook after that and every ordinary teardown
      // reports a GPU failure, so closing four outputs at the end of a
      // show would look like four crashes to a manager that treats
      // absence as the crash signal. Same shape as the manager setting
      // `departing` before the close it is expecting.
      options.canvas.removeEventListener('webglcontextlost', onContextLost, false)
      options.canvas.removeEventListener('webglcontextrestored', onContextRestored, false)
      gpuListeners.clear()
      unobserveSize()
      unsubscribeDiffuse()
      for (const slot of slots) disposeSlot(slot)
      slots = []
      // Disposes the textures this scene's sampler was bound to, so it
      // must come before the renderer loses its context.
      disposed = true
      unsubscribeLights()
      cloudTexture?.dispose()
      atmosphereLut?.dispose()
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
