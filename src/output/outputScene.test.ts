// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output scene's pure logic, plus a regression guard on
 * the Vite entry list.
 *
 * The Three.js construction needs no GL context here: both seams
 * (`loadThree`, `createEarth`) are injectable, so the scene is built
 * against fakes. That matters — the sampler once shipped bound to
 * `null`, rendering a black page while the module header claimed it
 * drew the Earth, and it survived because nothing in this file had
 * ever built a scene at all.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  FRAMEBUFFER_WIDTHS,
  resolveFramebufferSize,
  frameIntervalMs,
  shouldRenderFrame,
  advanceFrameDeadline,
  VIDEO_FRAME_MS,
  STATIC_FRAME_MS,
  contentKindFor,
  createOutputScene,
  type OutputLayerInput,
} from './outputScene'
import { MAX_OUTPUT_LAYERS } from './layerStack'
import { EQUIRECT_ASPECT, EQUIRECT_UNIFORMS, latLonToDirection } from './equirectRtt'
import { getSunPosition } from '../utils/time'
import { until } from '../test-utils'
import { DECORATION_UNIFORMS } from './layerStack'
import { NADIR_LUT_SIZE } from './atmosphereNadir'

import { DEFAULT_FRAMEBUFFER_WIDTH } from '../services/multiOutput/protocol'

/** A 60 Hz display's callback interval, the ordinary case. */
const AT_60_HZ = 1000 / 60

describe('resolveFramebufferSize', () => {
  it('keeps every rung 2:1', () => {
    // An equirectangular frame that is not 2:1 is not equirectangular,
    // and a sphere fed a 16:9 buffer stretches without erroring.
    for (const w of FRAMEBUFFER_WIDTHS) {
      const size = resolveFramebufferSize(w)
      expect(size.width).toBe(w)
      expect(size.width / size.height).toBe(EQUIRECT_ASPECT)
    }
  })

  it('rounds down to the supported rung, never up', () => {
    // A monitor reporting just under a rung gets the smaller buffer:
    // overshooting spends GPU memory on hardware that already said it
    // is smaller, and memory is the thing the decoder budget rations.
    expect(resolveFramebufferSize(4095).width).toBe(2048)
    expect(resolveFramebufferSize(4096).width).toBe(4096)
    expect(resolveFramebufferSize(9000).width).toBe(8192)
  })

  it('clamps below the lowest rung up to it', () => {
    expect(resolveFramebufferSize(1).width).toBe(1024)
    expect(resolveFramebufferSize(0).width).toBe(1024)
    expect(resolveFramebufferSize(-1).width).toBe(1024)
  })
})

describe('contentKindFor', () => {
  it('is idle with nothing loaded', () => {
    expect(contentKindFor(null)).toBe('idle')
  })

  it('paces a playing video at the video rate', () => {
    expect(contentKindFor({ kind: 'video', video: { paused: false } })).toBe('video')
  })

  it('paces a PAUSED video at the static floor', () => {
    // The bug this exists for: `kind` latched from the dataset stays
    // 'video' when `outputSync` pauses the element, so an output
    // holding one frame redraws it 30 times a second — 30x the GPU for
    // an identical picture, on hardware that may drive sixteen of
    // these.
    expect(frameIntervalMs(contentKindFor({ kind: 'video', video: { paused: true } }))).toBe(
      STATIC_FRAME_MS,
    )
  })

  it('paces a still image at the static floor', () => {
    expect(frameIntervalMs(contentKindFor({ kind: 'image', video: null }))).toBe(STATIC_FRAME_MS)
  })

  it('reads the element, not the sync outcome, so a no-range loop keeps its rate', () => {
    // A dataset with no time axis is left looping by design —
    // `outputSync` returns `no-range` and does not touch the element.
    // Pacing off the outcome would drop that animation to 1 Hz.
    expect(contentKindFor({ kind: 'video', video: { paused: false } })).toBe('video')
  })
})

describe('frame pacing', () => {
  it('paces video at 30 fps and everything else at 1 Hz', () => {
    expect(frameIntervalMs('video')).toBe(VIDEO_FRAME_MS)
    expect(frameIntervalMs('image')).toBe(STATIC_FRAME_MS)
    expect(frameIntervalMs('idle')).toBe(STATIC_FRAME_MS)
  })

  it('draws immediately when something changed, whatever the pace', () => {
    expect(
      shouldRenderFrame({
        kind: 'image',
        nowMs: 0,
        dueMs: 1000,
        sinceLastCallbackMs: AT_60_HZ,
        dirty: true,
      }),
    ).toBe(true)
  })

  it('skips an unchanged static frame inside its interval', () => {
    expect(
      shouldRenderFrame({
        kind: 'image',
        nowMs: 500,
        dueMs: 1000,
        sinceLastCallbackMs: AT_60_HZ,
        dirty: false,
      }),
    ).toBe(false)
  })

  it('still draws a static frame once its interval elapses', () => {
    // Not an optimisation to remove: a static output that never
    // redraws cannot tell a dropped upload or a lost context from a
    // correct frame, so the read-back layer would have nothing to
    // catch. 1 Hz keeps it observable.
    expect(
      shouldRenderFrame({
        kind: 'image',
        nowMs: 1000,
        dueMs: 1000,
        sinceLastCallbackMs: AT_60_HZ,
        dirty: false,
      }),
    ).toBe(true)
  })

  it('draws a frame that is nearly due rather than waiting a whole callback', () => {
    // Nearest deadline: 4 ms short of due with a 16.7 ms callback
    // interval, so waiting overshoots by 12.7 and drawing undershoots
    // by 4.
    expect(
      shouldRenderFrame({
        kind: 'video',
        nowMs: 29,
        dueMs: 33,
        sinceLastCallbackMs: AT_60_HZ,
        dirty: false,
      }),
    ).toBe(true)
    expect(
      shouldRenderFrame({
        kind: 'video',
        nowMs: 20,
        dueMs: 33,
        sinceLastCallbackMs: AT_60_HZ,
        dirty: false,
      }),
    ).toBe(false)
  })

  // Static → video: the deadline standing was set a whole second out
  // and the content has started moving. Without this the first video
  // frame waits out the static floor.
  it('does not hold a video frame behind a deadline set for static content', () => {
    expect(
      shouldRenderFrame({
        kind: 'video',
        nowMs: 10,
        dueMs: 1000,
        sinceLastCallbackMs: AT_60_HZ,
        dirty: false,
      }),
    ).toBe(true)
  })

  describe('advanceFrameDeadline', () => {
    it('moves on from the deadline met, not from when it was met', () => {
      // The whole mechanism. Drawing 4 ms early must not push the next
      // frame 4 ms late as well, or the error compounds every frame and
      // the rate drifts off the cap.
      expect(advanceFrameDeadline(33, 29, 'video')).toBeCloseTo(33 + VIDEO_FRAME_MS)
    })

    it('does not let a display slower than the cap accumulate debt', () => {
      // 20 Hz offers a callback every 50 ms against a 33.33 ms
      // interval, so the deadline can never be met. Unclamped it would
      // fall further behind for as long as the installation runs. It
      // changes no decision — every callback draws either way.
      expect(advanceFrameDeadline(33, 200, 'video')).toBe(200)
    })
  })

  // Simulate a loop being offered callbacks at a fixed rate and count
  // how many it draws on. This is the only way to see the aliasing:
  // every individual decision looks defensible in isolation, and the
  // shipped behaviour was wrong at most refresh rates while passing a
  // test that sampled 30, 60 and 120.
  function drawnPerSecond(offeredHz: number, kind: 'video' | 'image', seconds = 4): number {
    const offered = 1000 / offeredHz
    // The real loop's very first tick always draws, on `dirty`, and
    // that is what sets the first deadline. Priming it here keeps the
    // count measuring the steady state rather than that one frame.
    let dueMs = advanceFrameDeadline(0, 0, kind)
    let drawn = 0
    for (let i = 1; i <= Math.round(offeredHz * seconds); i++) {
      const now = i * offered
      if (shouldRenderFrame({ kind, nowMs: now, dueMs, sinceLastCallbackMs: offered, dirty: false })) {
        drawn++
        dueMs = advanceFrameDeadline(dueMs, now, kind)
      }
    }
    return drawn / seconds
  }

  it('draws on every callback when the display refreshes at the cap', () => {
    // The bug hardware found. A 30 Hz monitor offers callbacks 33.33 ms
    // apart against a 33.33 ms video interval, so a plain `>=` came down
    // to jitter in the last decimal — and the callbacks that missed
    // waited a whole further one, turning a 33 ms frame into a 67 ms
    // frame. The loop settled at ~22 fps while being offered exactly 30,
    // identically on RGB and data-encoded video.
    expect(drawnPerSecond(30, 'video')).toBe(30)
  })

  // The sweep, rather than three samples. The first fix passed at 30,
  // 60 and 120 — every exact multiple of the cap — and was wrong almost
  // everywhere else, because measuring from the last *draw* throws the
  // phase away and leaves the rate decided by where `interval / offered`
  // falls against a half-integer. Measured on the shipped version: 75 Hz
  // gave 25 fps, 48 and 50 gave 24 and 25, 144 and 165 gave 28.8 and
  // 28.7, and 33 / 35 / 40 / 100 drew on every callback, running over
  // the cap they exist to respect.
  it.each([30, 33, 35, 40, 45, 48, 50, 55, 60, 75, 90, 100, 120, 144, 165, 240])(
    'holds ~30 fps on a %i Hz display',
    hz => {
      expect(drawnPerSecond(hz, 'video')).toBeCloseTo(30, 0)
    },
  )

  it('falls back to the display rate below the cap rather than stalling', () => {
    // 24 Hz cannot produce 30 frames. Every callback should draw.
    expect(drawnPerSecond(24, 'video')).toBe(24)
    expect(drawnPerSecond(20, 'video')).toBe(20)
  })

  it('holds the static floor at 1 Hz whatever the display does', () => {
    expect(drawnPerSecond(30, 'image')).toBe(1)
    expect(drawnPerSecond(60, 'image')).toBe(1)
    expect(drawnPerSecond(144, 'image')).toBe(1)
  })
})

describe('the sphere texture binding', () => {
  // This whole block exists because of a regression that shipped: the
  // sampler was left bound to `null`, so the page rendered black while
  // the module header said it rendered the Earth. Nothing here had
  // ever *built* a scene, so nothing caught it. Black is the worst
  // placeholder on an output — indistinguishable from a dropped upload
  // or a lost context, the failure the 1 Hz floor exists to surface.

  interface FakeTexture { readonly id: string }

  function fakeThree(gl?: unknown) {
    const uniformsSeen: Array<Record<string, { value: unknown }>> = []
    const shadersSeen: string[] = []
    const disposed: string[] = []
    /** Every `setSize`, so a resize can be checked for what it actually
     *  asked the renderer for — including the third argument, which is
     *  what keeps the CSS size alone. */
    const sized: Array<[number, number, boolean | undefined]> = []
    const THREE_ = {
      WebGLRenderer: class {
        /** Captured so `forceContextLoss` can fire on it, below. */
        private readonly canvas: { dispatchEvent?: (type: string) => void }
        constructor(opts: { canvas: unknown }) {
          this.canvas = opts.canvas as { dispatchEvent?: (type: string) => void }
        }
        setSize(w: number, h: number, updateStyle?: boolean): void {
          sized.push([w, h, updateStyle])
        }
        setClearColor(): void {}
        render(): void {}
        getContext(): unknown { return gl ?? null }
        dispose(): void { disposed.push('renderer') }
        /**
         * Fires `webglcontextlost`, as the real one does.
         *
         * A no-op here until case 5, and the no-op is what made the
         * first version of the dispose test pass with its guard
         * deleted: the hazard is that tearing a scene down drops the
         * context on purpose and looks exactly like a driver crash,
         * and a fake that never drops it cannot reproduce that. Fired
         * synchronously, which is stricter than the browser's queued
         * task and so catches an unhook that happens too late.
         */
        forceContextLoss(): void {
          this.canvas.dispatchEvent?.('webglcontextlost')
        }
      },
      Scene: class { add(): void {} },
      OrthographicCamera: class {},
      Vector3: class {
        constructor(public x = 0, public y = 0, public z = 0) {}
        set(x: number, y: number, z: number): void {
          this.x = x; this.y = y; this.z = z
        }
        copy(v: { x: number; y: number; z: number }): this {
          this.x = v.x; this.y = v.y; this.z = v.z
          return this
        }
      },
      ShaderMaterial: class {
        uniforms: Record<string, { value: unknown }>
        fragmentShader: string
        constructor(args: {
          uniforms: Record<string, { value: unknown }>
          fragmentShader: string
        }) {
          this.uniforms = args.uniforms
          this.fragmentShader = args.fragmentShader
          uniformsSeen.push(args.uniforms)
          shadersSeen.push(args.fragmentShader)
        }
        dispose(): void { disposed.push('material') }
      },
      Vector4: class {
        constructor(public x = 0, public y = 0, public z = 0, public w = 0) {}
      },
      Texture: class {
        needsUpdate = false
        constructor(public image: unknown) {}
        dispose(): void { disposed.push('texture') }
      },
      VideoTexture: class {
        needsUpdate = false
        constructor(public image: unknown) {}
        dispose(): void { disposed.push('videoTexture') }
      },
      DataTexture: class {
        needsUpdate = false
        constructor(
          public data: Uint8Array,
          public width: number,
          public height: number,
          public format: unknown,
        ) {}
        dispose(): void { disposed.push('dataTexture') }
      },
      RGBAFormat: 'RGBAFormat',
      LinearFilter: 'LinearFilter',
      NoColorSpace: 'NoColorSpace',
      ClampToEdgeWrapping: 'ClampToEdgeWrapping',
      PlaneGeometry: class { dispose(): void { disposed.push('geometry') } },
      // Retains its constructor args, as the real Mesh does: `dispose()`
      // reaches through `quad.geometry`, and a fake that drops them
      // would make the teardown path untestable.
      Mesh: class {
        frustumCulled = true
        constructor(
          public geometry: { dispose(): void },
          public material: { dispose(): void },
        ) {}
      },
    }
    return { THREE_: THREE_ as never, uniformsSeen, shadersSeen, disposed, sized }
  }

  function fakeEarth(base: FakeTexture, upgrade?: FakeTexture) {
    let subscriber: ((t: unknown) => void) | null = null
    let lightsSubscriber: ((t: unknown) => void) | null = null
    const earthDisposed = { value: false }
    const unsubscribed = { value: false }
    const updates = { count: 0 }
    const sunDir = { x: 1, y: 0, z: 0 }
    const createEarth = ((_three: unknown, options: Record<string, boolean>) => {
      return {
        baseEarthTexture: base,
        baseDiffuseTexture: null,
        nightLightsTexture: null,
        sunDir,
        optionsSeen: options,
        onBaseDiffuseChange(cb: (t: unknown) => void) {
          subscriber = cb
          return () => { unsubscribed.value = true }
        },
        onNightLightsChange(cb: (t: unknown) => void) {
          lightsSubscriber = cb
          return () => {}
        },
        update() { updates.count++ },
        dispose() { earthDisposed.value = true },
      }
    }) as never
    return {
      createEarth,
      upgradeNow: () => subscriber?.(upgrade),
      lightsNow: (tex: unknown) => lightsSubscriber?.(tex),
      updates,
      sunDir,
      earthDisposed,
      unsubscribed,
    }
  }

  /**
   * A canvas that records its listeners so a test can fire the two
   * context events.
   *
   * This was `{}` until case 5, and the upgrade is the point: the
   * scene subscribes through `options.canvas` rather than reaching for
   * a global, so the whole context-loss path is drivable with no GL
   * context, no driver and no page — which is the only way it is ever
   * going to be exercised, since forcing a real loss needs hardware.
   */
  const fakeCanvas = () => {
    const listeners = new Map<string, Set<() => void>>()
    const el = {
      addEventListener(type: string, fn: () => void) {
        const set = listeners.get(type) ?? new Set<() => void>()
        set.add(fn)
        listeners.set(type, set)
      },
      removeEventListener(type: string, fn: () => void) {
        listeners.get(type)?.delete(fn)
      },
    }
    const fire = (type: string) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn()
    }
    // The scene passes this object straight to the fake renderer, whose
    // `forceContextLoss` dispatches through here — so `dispose()`
    // really does drop the context in a test, the way it does on a
    // projector.
    ;(el as unknown as { dispatchEvent: (t: string) => void }).dispatchEvent = fire
    return {
      el: el as unknown as HTMLCanvasElement,
      fire,
      count(type: string) {
        return listeners.get(type)?.size ?? 0
      },
    }
  }

  const canvas = () => fakeCanvas().el

  it('binds a real texture from the first frame, never null', async () => {
    const three = fakeThree()
    const base: FakeTexture = { id: 'base-2k' }
    const earth = fakeEarth(base)

    await createOutputScene(
      { canvas: canvas() },
      { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
    )

    const uniforms = three.uniformsSeen[0]
    expect(uniforms[EQUIRECT_UNIFORMS.sphereTexture].value).toBe(base)
    expect(uniforms[EQUIRECT_UNIFORMS.sphereTexture].value).not.toBeNull()
  })

  it('builds the Earth as a texture provider, with every mesh-only effect off', async () => {
    const three = fakeThree()
    let seen: Record<string, boolean> | undefined
    const createEarth = ((_t: unknown, options: Record<string, boolean>) => {
      seen = options
      return {
        baseEarthTexture: { id: 'base' },
        baseDiffuseTexture: null,
        nightLightsTexture: null,
        sunDir: { x: 1, y: 0, z: 0 },
        onBaseDiffuseChange: () => () => {},
        onNightLightsChange: () => () => {},
        update() {},
        dispose() {},
      }
    }) as never

    await createOutputScene(
      { canvas: canvas() },
      { loadThree: async () => three.THREE_, createEarth },
    )

    // The equirect pass never rasterises a mesh, so anything that only
    // exists on one is built and thrown away — and half of them are
    // meaningless on an unwrap anyway. Clouds included: rung 12c wants
    // the *raw* asset and loads it through its own seam, because that
    // module's loader bakes alpha at a gamma tuned for a lit shell.
    expect(seen).toEqual({
      includeLighting: false,
      includeAtmosphere: false,
      includeClouds: false,
      includeSun: false,
      includeShadow: false,
    })
  })

  it('swaps the sampler when the CDN upgrades, and reports itself dirty', async () => {
    const three = fakeThree()
    const base: FakeTexture = { id: 'base-2k' }
    const better: FakeTexture = { id: 'diffuse-8k' }
    const earth = fakeEarth(base, better)

    const scene = await createOutputScene(
      { canvas: canvas() },
      { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
    )

    expect(scene.consumeDirty()).toBe(false)
    earth.upgradeNow()

    const uniforms = three.uniformsSeen[0]
    expect(uniforms[EQUIRECT_UNIFORMS.sphereTexture].value).toBe(better)
    // Without the dirty flag the upgrade waits out the 1 Hz static
    // floor and pops on a projector.
    expect(scene.consumeDirty()).toBe(true)
    // Read once and cleared, so one upgrade cannot force every frame.
    expect(scene.consumeDirty()).toBe(false)
  })

  it('unsubscribes and disposes the Earth before dropping the GL context', async () => {
    const three = fakeThree()
    const earth = fakeEarth({ id: 'base' })

    const scene = await createOutputScene(
      { canvas: canvas() },
      { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
    )
    scene.dispose()

    expect(earth.unsubscribed.value).toBe(true)
    expect(earth.earthDisposed.value).toBe(true)
  })

  describe('compositing layers', () => {
    const build = async () => {
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base' })
      const scene = await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )
      return { three, scene }
    }

    const layer = (over: Partial<OutputLayerInput> = {}): OutputLayerInput => ({
      kind: 'video',
      element: { tag: 'video-a' } as never,
      overlay: { datasetId: 'SST' },
      ...over,
    })

    const SCALE = {
      vmin: 0,
      vmax: 1,
      units: 'K',
      stops: [
        { t: 0, rgba: [0, 0, 0, 255] as [number, number, number, number] },
        { t: 1, rgba: [255, 255, 255, 255] as [number, number, number, number] },
      ],
    }

    it('starts with no overlay slots at all', async () => {
      const { three } = await build()
      // Zero layers must hand back the projection pass untouched, not a
      // rewritten tail carrying unused hit variables.
      expect(three.shadersSeen[0]).not.toContain('uLayer0Map')
    })

    it('recompiles when the slot count changes, because the shader is unrolled', async () => {
      const { three, scene } = await build()

      scene.setLayers([layer()])

      expect(three.shadersSeen).toHaveLength(2)
      expect(three.shadersSeen[1]).toContain('uLayer0Map')
      // The old material is released — an installation switching
      // layouts all day would otherwise accumulate compiled programs.
      expect(three.disposed).toContain('material')
    })

    it('keeps the projection across a recompile', async () => {
      const { three, scene } = await build()
      scene.setParams({ cameraOffset: { x: 0.4, y: 0, z: 0 }, split: true, rotationOffsetRad: 0 })

      scene.setLayers([layer()])

      // Same uniforms object, so the operator's camera survives. A
      // rebuild that made fresh uniforms would snap every output back
      // to centred whenever a layer appeared.
      expect(three.uniformsSeen[1]).toBe(three.uniformsSeen[0])
      const offset = three.uniformsSeen[1][EQUIRECT_UNIFORMS.cameraOffset].value as {
        x: number
      }
      expect(offset.x).toBe(0.4)
      expect(three.uniformsSeen[1][EQUIRECT_UNIFORMS.split].value).toBe(true)
    })

    it('does not recompile for a metadata-only change', async () => {
      const { three, scene } = await build()
      const element = { tag: 'video-a' } as never
      scene.setLayers([layer({ element })])
      const compiles = three.shadersSeen.length

      // Same element, new overlay — an operator nudging a palette.
      scene.setLayers([layer({ element, overlay: { datasetId: 'SST', lonOrigin: 20 } })])

      expect(three.shadersSeen).toHaveLength(compiles)
    })

    it('keeps the map texture when the element is unchanged', async () => {
      const { three, scene } = await build()
      const element = { tag: 'video-a' } as never
      scene.setLayers([layer({ element })])
      const first = three.uniformsSeen[0].uLayer0Map.value

      scene.setLayers([layer({ element, overlay: { datasetId: 'SST', lonOrigin: 20 } })])

      // Rebuilding a VideoTexture restarts the upload path for a change
      // the decoder never saw.
      expect(three.uniformsSeen[0].uLayer0Map.value).toBe(first)
      expect(three.disposed).not.toContain('videoTexture')
    })

    it('replaces and releases the map texture when the element changes', async () => {
      const { three, scene } = await build()
      scene.setLayers([layer({ element: { tag: 'a' } as never })])
      const first = three.uniformsSeen[0].uLayer0Map.value

      scene.setLayers([layer({ element: { tag: 'b' } as never })])

      expect(three.uniformsSeen[0].uLayer0Map.value).not.toBe(first)
      expect(three.disposed).toContain('videoTexture')
    })

    it('uses a VideoTexture for video and a self-updating Texture for an image', async () => {
      const { three, scene } = await build()

      scene.setLayers([
        layer({ kind: 'video', element: { tag: 'v' } as never }),
        layer({ kind: 'image', element: { tag: 'i' } as never }),
      ])

      // A still needs `needsUpdate` set once; a VideoTexture sets it
      // itself every frame, which is why they are different classes.
      const still = three.uniformsSeen[0].uLayer1Map.value as { needsUpdate: boolean }
      expect(still.needsUpdate).toBe(true)
      expect(three.uniformsSeen[0].uLayer0Map.value).not.toBe(still)
    })

    it('binds a palette and the data-encoded flag only for a data-encoded layer', async () => {
      const { three, scene } = await build()

      scene.setLayers([
        layer({ overlay: { datasetId: 'AOD', colorScale: SCALE } }),
        layer({ kind: 'image', element: { tag: 'pic' } as never }),
      ])

      // `colorScale`'s presence *is* data-encoded mode — the field the
      // protocol carries it across on.
      expect(three.uniformsSeen[0].uLayer0DataEncoded.value).toBe(1)
      expect(three.uniformsSeen[0].uLayer0Lut.value).not.toBeNull()
      expect(three.uniformsSeen[0].uLayer1DataEncoded.value).toBe(0)
      expect(three.uniformsSeen[0].uLayer1Lut.value).toBeNull()
    })

    it('builds the palette through the operator’s display transform', async () => {
      const { three, scene } = await build()
      scene.setLayers([layer({ overlay: { datasetId: 'AOD', colorScale: SCALE } })])
      const plain = (three.uniformsSeen[0].uLayer0Lut.value as { data: Uint8Array }).data

      scene.setLayers([
        layer({
          element: { tag: 'video-a' } as never,
          overlay: { datasetId: 'AOD', colorScale: SCALE },
          display: {
            palette: 'magma',
            stretch: { lo: 0, hi: 1 },
            threshold: { min: null, max: null },
          },
        }),
      ])
      const magma = (three.uniformsSeen[0].uLayer0Lut.value as { data: Uint8Array }).data

      // Built *through* buildDisplayLut rather than by post-processing,
      // so the dataset's own alpha profile survives a palette swap.
      expect(Array.from(magma)).not.toEqual(Array.from(plain))
    })

    it('passes the bbox through, and flags its absence', async () => {
      const { three, scene } = await build()

      scene.setLayers([
        layer({ overlay: { datasetId: 'US', boundingBox: { n: 50, s: 24, w: -125, e: -66 } } }),
        layer({ element: { tag: 'global' } as never, overlay: { datasetId: 'G' } }),
      ])

      const bbox = three.uniformsSeen[0].uLayer0Bbox.value as Record<string, number>
      expect([bbox.x, bbox.y, bbox.z, bbox.w]).toEqual([50, 24, -125, -66])
      expect(three.uniformsSeen[0].uLayer0HasBbox.value).toBe(1)
      expect(three.uniformsSeen[0].uLayer1HasBbox.value).toBe(0)
    })

    it('passes lonOrigin and the Y flip', async () => {
      const { three, scene } = await build()

      scene.setLayers([
        layer({ overlay: { datasetId: 'X', lonOrigin: 20, isFlippedInY: true } }),
      ])

      expect(three.uniformsSeen[0].uLayer0LonOrigin.value).toBe(20)
      expect(three.uniformsSeen[0].uLayer0FlipY.value).toBe(1)
    })

    it('caps at the guaranteed texture-unit budget rather than failing', async () => {
      const { three, scene } = await build()

      scene.setLayers(
        Array.from({ length: MAX_OUTPUT_LAYERS + 2 }, (_, i) =>
          layer({ element: { tag: `l${i}` } as never }),
        ),
      )

      // WebGL guarantees only 8 fragment texture units and each slot
      // spends two. Dropping the tail beats taking the sphere down.
      expect(three.shadersSeen[1]).toContain(`uLayer${MAX_OUTPUT_LAYERS - 1}Map`)
      expect(three.shadersSeen[1]).not.toContain(`uLayer${MAX_OUTPUT_LAYERS}Map`)
    })

    it('releases the textures of a slot that goes away', async () => {
      const { three, scene } = await build()
      // One element object, reused: identity is the reuse test, and two
      // literals with the same contents are deliberately not the same
      // element — the mirror hands back the element it holds.
      const kept = { tag: 'a' } as never
      scene.setLayers([
        layer({ element: kept }),
        layer({ element: { tag: 'b' } as never, overlay: { datasetId: 'B', colorScale: SCALE } }),
      ])
      const before = three.disposed.filter(d => d === 'videoTexture').length

      scene.setLayers([layer({ element: kept })])

      expect(three.disposed.filter(d => d === 'videoTexture').length).toBe(before + 1)
      expect(three.disposed).toContain('dataTexture')
    })

    it('drops the uniform’s reference to a slot that goes away', async () => {
      const { three, scene } = await build()
      const kept = { tag: 'a' } as never
      scene.setLayers([
        layer({ element: kept }),
        layer({ element: { tag: 'b' } as never, overlay: { datasetId: 'B', colorScale: SCALE } }),
      ])
      expect(three.uniformsSeen[0].uLayer1Map.value).not.toBeNull()

      scene.setLayers([layer({ element: kept })])

      // Disposing the texture is only half of it. `uniforms` is
      // long-lived and keyed by slot name, and a Three texture holds
      // its `image` — so leaving the value in place pins one decoded
      // video element per removed slot for the life of the window,
      // even though the rebuilt shader no longer samples it.
      expect(three.uniformsSeen[0].uLayer1Map.value).toBeNull()
      expect(three.uniformsSeen[0].uLayer1Lut.value).toBeNull()
    })

    it('drops every slot’s reference when the layers go away entirely', async () => {
      const { three, scene } = await build()
      scene.setLayers([layer({ overlay: { datasetId: 'AOD', colorScale: SCALE } })])

      scene.setLayers([])

      expect(three.uniformsSeen[0].uLayer0Map.value).toBeNull()
      expect(three.uniformsSeen[0].uLayer0Lut.value).toBeNull()
    })

    it('marks the scene dirty so a composite change does not wait out the 1 Hz floor', async () => {
      const { scene } = await build()
      scene.consumeDirty()

      scene.setLayers([layer()])

      expect(scene.consumeDirty()).toBe(true)
    })

    it('releases every slot texture on dispose', async () => {
      const { three, scene } = await build()
      scene.setLayers([layer({ overlay: { datasetId: 'AOD', colorScale: SCALE } })])

      scene.dispose()

      expect(three.disposed).toContain('videoTexture')
      expect(three.disposed).toContain('dataTexture')
    })
  })

  describe('setFramebufferWidth', () => {
    async function build(gl?: unknown) {
      const three = fakeThree(gl)
      const scene = await createOutputScene(
        { canvas: canvas() },
        {
          loadThree: async () => three.THREE_,
          createEarth: fakeEarth({ id: 'base' }).createEarth,
        },
      )
      return { three, scene }
    }

    it('resizes the drawing buffer and leaves the CSS size alone', async () => {
      const { three, scene } = await build()
      three.sized.length = 0

      scene.setFramebufferWidth(8192)

      // The third argument is the whole point: `true` would write the
      // canvas's CSS size and shrink an 8K buffer into an 8K-sized
      // element on a 1080p monitor. `false` keeps the canvas full-bleed
      // and lets `object-fit` reconcile the two, which is what makes a
      // rung below the monitor scale *up*.
      expect(three.sized).toEqual([[8192, 4096, false]])
      expect(scene.size).toEqual({ width: 8192, height: 4096 })
    })

    it('reports the new size, because that is what the HUD reads', async () => {
      const { scene } = await build()

      scene.setFramebufferWidth(1024)

      // `size` was a fixed property until rung 11. A stale reading here
      // is a debug overlay confidently naming a resolution the output
      // is not running at, which is worse than no overlay.
      expect(scene.size).toEqual({ width: 1024, height: 512 })
    })

    it('snaps an unsupported width rather than allocating it', async () => {
      const { three, scene } = await build()
      three.sized.length = 0

      scene.setFramebufferWidth(3000)

      expect(three.sized).toEqual([[2048, 1024, false]])
    })

    it('clamps a nonsense width up to the lowest rung', async () => {
      const { three, scene } = await build()
      three.sized.length = 0

      scene.setFramebufferWidth(0)

      // Never zero-by-zero: a drawing buffer with no pixels is a black
      // window, the one failure indistinguishable from a lost context.
      expect(three.sized).toEqual([[1024, 512, false]])
    })

    it('does nothing when the snapped size is already in force', async () => {
      const { three, scene } = await build()
      three.sized.length = 0

      // The default rung, re-picked. Reallocating would spend 128 MiB
      // and a frame on a change of nothing.
      scene.setFramebufferWidth(DEFAULT_FRAMEBUFFER_WIDTH)

      expect(three.sized).toEqual([])
    })

    it('marks the scene dirty, so a resize does not wait out the 1 Hz floor', async () => {
      const { scene } = await build()
      scene.consumeDirty()

      scene.setFramebufferWidth(1024)

      // The projection is per-pixel, so a resized buffer is a different
      // image even with nothing else changed.
      expect(scene.consumeDirty()).toBe(true)
    })
  })

  describe('rendererName', () => {
    async function build(gl?: unknown) {
      const three = fakeThree(gl)
      const scene = await createOutputScene(
        { canvas: canvas() },
        {
          loadThree: async () => three.THREE_,
          createEarth: fakeEarth({ id: 'base' }).createEarth,
        },
      )
      return scene
    }

    const glWith = (over: Record<string, unknown>) => ({
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
      getParameter: () => 'NVIDIA GeForce RTX 4090',
      ...over,
    })

    it('reads the unmasked renderer string', async () => {
      const scene = await build(glWith({}))

      // The entire mitigation for a risk the app cannot fix: a spike
      // found the webview silently on the iGPU of a machine with a
      // 4090, and `powerPreference` is inert.
      expect(scene.rendererName()).toBe('NVIDIA GeForce RTX 4090')
    })

    it('returns null when the driver will not offer the extension', async () => {
      const scene = await build(glWith({ getExtension: () => null }))
      expect(scene.rendererName()).toBeNull()
    })

    it('returns null rather than an empty string', async () => {
      const scene = await build(glWith({ getParameter: () => '' }))
      // The HUD prints "unreported" for null. An empty string would
      // print a blank field, which reads as a broken overlay.
      expect(scene.rendererName()).toBeNull()
    })

    it('survives a driver that throws on the query', async () => {
      const scene = await build(
        glWith({
          getExtension: () => {
            throw new Error('context lost')
          },
        }),
      )
      // A refused query must cost the readout, not the frame it was
      // going to be drawn over.
      expect(scene.rendererName()).toBeNull()
    })

    it('returns null with no context at all', async () => {
      const scene = await build()
      expect(scene.rendererName()).toBeNull()
    })
  })

  describe('the Earth decoration (rung 12c)', () => {
    it('binds both decoration samplers from the first frame, never null', async () => {
      // The rule the sphere sampler already follows: an unbound sampler
      // is a driver-dependent read, and on an output black is
      // indistinguishable from a fault. The `has*` flags are what gate
      // them, so what is bound before they load is never sampled.
      const three = fakeThree()
      const base = { id: 'base' } as FakeTexture
      const earth = fakeEarth(base)

      await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )

      const u = three.uniformsSeen[0]
      expect(u[DECORATION_UNIFORMS.lightsMap].value).toBe(base)
      expect(u[DECORATION_UNIFORMS.cloudMap].value).toBe(base)
      expect(u[DECORATION_UNIFORMS.hasLights].value).toBe(0)
      expect(u[DECORATION_UNIFORMS.hasCloud].value).toBe(0)
    })

    it('strips the sRGB decode off every texture it samples', async () => {
      // `photorealEarth` tags its diffuse and night lights
      // `SRGBColorSpace`, which is right for its own material and wrong
      // here: Three uploads those with an sRGB internal format, so the
      // sampler decodes to linear, while every constant in
      // `layerStack` is copied from `earthTileLayer` and calibrated for
      // sRGB *display* space. Nothing re-encodes on the way out either
      // — one `render()` to the default framebuffer with a hand-written
      // ShaderMaterial, so no `colorspace_fragment` chunk.
      //
      // Measured cost of getting this wrong, through the real composed
      // shader: lit land `rgb(181, 150, 103)` reached the framebuffer
      // as `rgb(112, 68, 30)`, and dark vegetation `rgb(27, 47, 19)`
      // came out `rgb(2, 5, 17)` — byte-identical to ocean. Forest and
      // sea were the same colour on the sphere.
      const three = fakeThree()
      const base = { id: 'base' } as FakeTexture
      const earth = fakeEarth(base)

      await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )

      expect((base as unknown as { colorSpace: unknown }).colorSpace).toBe('NoColorSpace')
      expect((base as unknown as { needsUpdate: unknown }).needsUpdate).toBe(true)
    })

    it('retags a tier upgrade too, not just what it started with', async () => {
      // The 2K -> 4K -> 8K progression hands over textures this module
      // has never seen. Retagging only at construction would leave the
      // output correct until the first upgrade landed and wrong after,
      // which is the worst shape for a bug like this: it would look
      // fixed for the first few seconds of every launch.
      const three = fakeThree()
      const upgrade = { id: 'upgrade' } as FakeTexture
      const lights = { id: 'lights' } as FakeTexture
      const earth = fakeEarth({ id: 'base' } as FakeTexture, upgrade)

      await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )
      earth.upgradeNow()
      earth.lightsNow(lights)

      for (const tex of [upgrade, lights]) {
        expect((tex as unknown as { colorSpace: unknown }).colorSpace).toBe('NoColorSpace')
        expect((tex as unknown as { needsUpdate: unknown }).needsUpdate).toBe(true)
      }
    })

    it('builds the scattering table eagerly and switches it on', async () => {
      // Unlike the two samplers above, this one has nothing to wait
      // for: the table is a function of the shared constants alone, so
      // there is no asset arrival that would flip the flag later. If it
      // is not on at construction it is never on.
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base' } as FakeTexture)

      await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )

      const u = three.uniformsSeen[0]
      expect(u[DECORATION_UNIFORMS.hasAtmosphere].value).toBe(1)
      const lut = u[DECORATION_UNIFORMS.atmosphereLut].value as {
        data: Uint8Array
        width: number
        height: number
      }
      expect(lut.width).toBe(NADIR_LUT_SIZE)
      expect(lut.height).toBe(1)
      expect(lut.data.length).toBe(NADIR_LUT_SIZE * 4)
    })

    it('sets both filters, because DataTexture defaults to nearest', async () => {
      // `THREE.DataTexture` defaults `magFilter`/`minFilter` to
      // `NearestFilter` — unlike `Texture`, which defaults to linear.
      // Left alone, the shader quantises the sun-angle lookup into 256
      // bands and stops agreeing with `sampleNadirLut`, the TS mirror
      // it is tested against. Caught in review after a GL harness that
      // bound the LUT through raw WebGL with `gl.LINEAR` set by hand,
      // so the measurement never exercised the shipped defaults.
      // `photorealEarth` sets the same four properties on both of its
      // own LUT uploads.
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base' } as FakeTexture)

      await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )

      const lut = three.uniformsSeen[0][DECORATION_UNIFORMS.atmosphereLut].value as {
        minFilter: unknown
        magFilter: unknown
        wrapS: unknown
        wrapT: unknown
      }
      expect(lut.minFilter).toBe('LinearFilter')
      expect(lut.magFilter).toBe('LinearFilter')
      expect(lut.wrapS).toBe('ClampToEdgeWrapping')
      expect(lut.wrapT).toBe('ClampToEdgeWrapping')
    })

    it('falls back to the base texture, not null, if the table fails', async () => {
      // Same never-bind-null rule as the two samplers above, and the
      // one place it is reachable: the table is built inside a
      // try/catch because a Three build without `DataTexture` would
      // otherwise take down the whole scene for a decoration.
      const three = fakeThree()
      const base = { id: 'base' } as FakeTexture
      const earth = fakeEarth(base)
      const broken = {
        ...(three.THREE_ as Record<string, unknown>),
        DataTexture: class {
          constructor() {
            throw new Error('no DataTexture')
          }
        },
      }

      await createOutputScene(
        { canvas: canvas() },
        {
          loadThree: async () => broken as unknown as typeof three.THREE_,
          createEarth: earth.createEarth,
        },
      )

      const u = three.uniformsSeen[0]
      expect(u[DECORATION_UNIFORMS.hasAtmosphere].value).toBe(0)
      expect(u[DECORATION_UNIFORMS.atmosphereLut].value).toBe(base)
    })

    it('takes the night lights when they land, and reports itself dirty', async () => {
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base' } as FakeTexture)
      const scene = await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )
      scene.consumeDirty()

      const lights = { id: 'lights' }
      earth.lightsNow(lights)

      const u = three.uniformsSeen[0]
      expect(u[DECORATION_UNIFORMS.lightsMap].value).toBe(lights)
      expect(u[DECORATION_UNIFORMS.hasLights].value).toBe(1)
      // Without the flag the arrival would wait out the 1 Hz static
      // floor before the city lights appeared on a projector.
      expect(scene.consumeDirty()).toBe(true)
    })

    it('takes the clouds when they land, and reports itself dirty', async () => {
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base' } as FakeTexture)
      const image = { id: 'cloud-image' } as unknown as TexImageSource
      const scene = await createOutputScene(
        { canvas: canvas() },
        {
          loadThree: async () => three.THREE_,
          createEarth: earth.createEarth,
          loadCloudImage: async () => image,
        },
      )
      await until(
        () => three.uniformsSeen[0][DECORATION_UNIFORMS.hasCloud].value === 1,
        'the cloud texture to be bound',
      )

      const u = three.uniformsSeen[0]
      expect((u[DECORATION_UNIFORMS.cloudMap].value as { image: unknown }).image).toBe(image)
      expect(scene.consumeDirty()).toBe(true)
    })

    it('renders a correct Earth when the cloud asset will not load', async () => {
      // An output that refused to boot over a missing decoration texture
      // would be a worse failure than one without clouds.
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base' } as FakeTexture)
      const scene = await createOutputScene(
        { canvas: canvas() },
        {
          loadThree: async () => three.THREE_,
          createEarth: earth.createEarth,
          loadCloudImage: async () => null,
        },
      )

      expect(three.uniformsSeen[0][DECORATION_UNIFORMS.hasCloud].value).toBe(0)
      expect(() => scene.render()).not.toThrow()
    })

    it("puts the sun in the ray-march's frame, not the globe mesh's", async () => {
      // The bug this replaced. `photorealEarth.sunDir` negates Z — it is
      // built for the globe *mesh*'s frame — so borrowing it mirrored the
      // sun in longitude and lit the opposite hemisphere: on hardware the
      // Americas went dark while the control globe had them in daylight.
      // Sharing `getSunPosition` was never the property that mattered;
      // sharing the frame is, so this derives the direction through the
      // same `latLonToDirection` `cameraOffsetForCamera` uses.
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base' } as FakeTexture)
      const scene = await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )

      // Deliberately wrong, and deliberately ignored.
      earth.sunDir.x = 0
      earth.sunDir.z = -1
      scene.render()

      const solar = getSunPosition(new Date())
      const expected = latLonToDirection(solar.lat, solar.lng)
      const sun = three.uniformsSeen[0][DECORATION_UNIFORMS.sunDir].value as {
        x: number
        y: number
        z: number
      }
      expect(sun.x).toBeCloseTo(expected.x, 4)
      expect(sun.y).toBeCloseTo(expected.y, 4)
      expect(sun.z).toBeCloseTo(expected.z, 4)
    })

    it('does not mark itself dirty just because the sun moved', async () => {
      // The sun advances ~0.004 degrees a second. Flagging that would
      // hold a static output at the render rate forever to animate
      // something nobody can see move.
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base' } as FakeTexture)
      const scene = await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )
      scene.consumeDirty()

      scene.render()

      expect(scene.consumeDirty()).toBe(false)
    })

    it('turns day/night off and back on, and no-ops on an unchanged flag', async () => {
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base' } as FakeTexture)
      const scene = await createOutputScene(
        { canvas: canvas() },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )
      const u = three.uniformsSeen[0]
      expect(u[DECORATION_UNIFORMS.dayNight].value).toBe(1)

      scene.consumeDirty()
      scene.setDayNight(false)
      expect(u[DECORATION_UNIFORMS.dayNight].value).toBe(0)
      expect(scene.consumeDirty()).toBe(true)

      // Repeated from a heartbeat snapshot: nothing changed, so nothing
      // is redrawn for it.
      scene.setDayNight(false)
      expect(scene.consumeDirty()).toBe(false)
    })
  })

  describe('GPU context loss (rung 13, case 5)', () => {
    const build = async (cv: HTMLCanvasElement) => {
      const three = fakeThree()
      const earth = fakeEarth({ id: 'base-2k' })
      const scene = await createOutputScene(
        { canvas: cv },
        { loadThree: async () => three.THREE_, createEarth: earth.createEarth },
      )
      return scene
    }

    it('starts live and reports a loss', async () => {
      const cv = fakeCanvas()
      const scene = await build(cv.el)
      expect(scene.gpuState()).toBe('live')

      cv.fire('webglcontextlost')
      expect(scene.gpuState()).toBe('lost')
    })

    it('reports a restore as its own state, not back to live', async () => {
      // `restored` is a third observation rather than a return to
      // `live` because the two are different things to read off a
      // projector: one window has had a GPU event this session and one
      // has not, and that is worth knowing when the picture looks
      // wrong for some other reason.
      const cv = fakeCanvas()
      const scene = await build(cv.el)

      cv.fire('webglcontextlost')
      cv.fire('webglcontextrestored')
      expect(scene.gpuState()).toBe('restored')
    })

    it('notifies subscribers on each transition, and stops on unsubscribe', async () => {
      const cv = fakeCanvas()
      const scene = await build(cv.el)
      const seen: string[] = []
      const off = scene.onGpuStateChange(s => seen.push(s))

      cv.fire('webglcontextlost')
      cv.fire('webglcontextrestored')
      expect(seen).toEqual(['lost', 'restored'])

      off()
      cv.fire('webglcontextlost')
      expect(seen).toEqual(['lost', 'restored'])
    })

    it('does not re-notify when the same event fires twice', async () => {
      const cv = fakeCanvas()
      const scene = await build(cv.el)
      const seen: string[] = []
      scene.onGpuStateChange(s => seen.push(s))

      cv.fire('webglcontextlost')
      cv.fire('webglcontextlost')
      expect(seen).toEqual(['lost'])
    })

    it('keeps notifying the other listeners when one throws', async () => {
      const cv = fakeCanvas()
      const scene = await build(cv.el)
      const seen: string[] = []
      scene.onGpuStateChange(() => {
        throw new Error('listener blew up')
      })
      scene.onGpuStateChange(s => seen.push(s))

      cv.fire('webglcontextlost')
      expect(seen).toEqual(['lost'])
    })

    it('does NOT report the loss that dispose() causes itself', async () => {
      // `dispose()` ends with `renderer.forceContextLoss()`, which
      // fires the very event a driver crash fires. Unhook too late and
      // closing four outputs at the end of a show reports four GPU
      // crashes — to a manager that treats absence as the crash signal
      // and cannot tell them apart afterwards.
      //
      // This asserts on `dispose()` alone, with no manual `fire`: the
      // fake renderer dispatches the event for real, so the ordering
      // inside `dispose()` is what the test is actually pinning. It
      // passed against a broken implementation while the fake's
      // `forceContextLoss` was a no-op.
      const cv = fakeCanvas()
      const scene = await build(cv.el)
      const seen: string[] = []
      scene.onGpuStateChange(s => seen.push(s))

      scene.dispose()

      expect(seen).toEqual([])
      expect(scene.gpuState()).toBe('live')
    })

    it('unhooks both canvas listeners on dispose', async () => {
      const cv = fakeCanvas()
      const scene = await build(cv.el)
      expect(cv.count('webglcontextlost')).toBe(1)
      expect(cv.count('webglcontextrestored')).toBe(1)

      scene.dispose()
      expect(cv.count('webglcontextlost')).toBe(0)
      expect(cv.count('webglcontextrestored')).toBe(0)
    })
  })
})

describe('vite entry list', () => {
  const config = readFileSync(resolve(__dirname, '../../vite.config.ts'), 'utf8')

  it('still declares every entry, including the ones this commit did not add', () => {
    // §7 of the plan names this exact trap: authoring a fresh
    // `rollupOptions.input` instead of adding to the existing object
    // silently drops the other pages, and the build stays green while
    // /orbit 404s in production.
    for (const entry of ['main:', 'orbit:', 'output:']) {
      expect(config).toContain(entry)
    }
  })

  it('points the output entry at a page under src/, as root: ./src requires', () => {
    expect(config).toContain("'src/output/output.html'")
  })
})

describe('the output page', () => {
  const html = readFileSync(resolve(__dirname, 'output.html'), 'utf8')

  it('is not indexable', () => {
    expect(html).toContain('name="robots" content="noindex"')
  })

  it('requests the manifest with credentials, like the other entries', () => {
    // An Access-protected host serves a login redirect instead of the
    // manifest without this.
    expect(html).toContain('crossorigin="use-credentials"')
  })

  it('loads its entry module relative to itself', () => {
    expect(html).toContain('src="./main.ts"')
  })


})
