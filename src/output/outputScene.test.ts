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
  VIDEO_FRAME_MS,
  STATIC_FRAME_MS,
  createOutputScene,
} from './outputScene'
import { EQUIRECT_ASPECT, EQUIRECT_UNIFORMS } from './equirectRtt'

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

describe('frame pacing', () => {
  it('paces video at 30 fps and everything else at 1 Hz', () => {
    expect(frameIntervalMs('video')).toBe(VIDEO_FRAME_MS)
    expect(frameIntervalMs('image')).toBe(STATIC_FRAME_MS)
    expect(frameIntervalMs('idle')).toBe(STATIC_FRAME_MS)
  })

  it('draws immediately when something changed, whatever the pace', () => {
    expect(shouldRenderFrame({ kind: 'image', sinceLastFrameMs: 0, dirty: true })).toBe(true)
  })

  it('skips an unchanged static frame inside its interval', () => {
    expect(shouldRenderFrame({ kind: 'image', sinceLastFrameMs: 500, dirty: false })).toBe(false)
  })

  it('still draws a static frame once its interval elapses', () => {
    // Not an optimisation to remove: a static output that never
    // redraws cannot tell a dropped upload or a lost context from a
    // correct frame, so the read-back layer would have nothing to
    // catch. 1 Hz keeps it observable.
    expect(shouldRenderFrame({ kind: 'image', sinceLastFrameMs: 1000, dirty: false })).toBe(true)
  })

  it('draws video roughly every 33 ms', () => {
    expect(shouldRenderFrame({ kind: 'video', sinceLastFrameMs: 20, dirty: false })).toBe(false)
    expect(shouldRenderFrame({ kind: 'video', sinceLastFrameMs: 34, dirty: false })).toBe(true)
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

  function fakeThree() {
    const uniformsSeen: Array<Record<string, { value: unknown }>> = []
    const disposed: string[] = []
    const THREE_ = {
      WebGLRenderer: class {
        setSize(): void {}
        setClearColor(): void {}
        render(): void {}
        dispose(): void { disposed.push('renderer') }
        forceContextLoss(): void {}
      },
      Scene: class { add(): void {} },
      OrthographicCamera: class {},
      Vector3: class {
        constructor(public x = 0, public y = 0, public z = 0) {}
        set(x: number, y: number, z: number): void {
          this.x = x; this.y = y; this.z = z
        }
      },
      ShaderMaterial: class {
        uniforms: Record<string, { value: unknown }>
        constructor(args: { uniforms: Record<string, { value: unknown }> }) {
          this.uniforms = args.uniforms
          uniformsSeen.push(args.uniforms)
        }
        dispose(): void { disposed.push('material') }
      },
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
    return { THREE_: THREE_ as never, uniformsSeen, disposed }
  }

  function fakeEarth(base: FakeTexture, upgrade?: FakeTexture) {
    let subscriber: ((t: unknown) => void) | null = null
    const earthDisposed = { value: false }
    const unsubscribed = { value: false }
    const createEarth = ((_three: unknown, options: Record<string, boolean>) => {
      return {
        baseEarthTexture: base,
        baseDiffuseTexture: null,
        optionsSeen: options,
        onBaseDiffuseChange(cb: (t: unknown) => void) {
          subscriber = cb
          return () => { unsubscribed.value = true }
        },
        dispose() { earthDisposed.value = true },
      }
    }) as never
    return {
      createEarth,
      upgradeNow: () => subscriber?.(upgrade),
      earthDisposed,
      unsubscribed,
    }
  }

  const canvas = () => ({}) as HTMLCanvasElement

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
        onBaseDiffuseChange: () => () => {},
        dispose() {},
      }
    }) as never

    await createOutputScene(
      { canvas: canvas() },
      { loadThree: async () => three.THREE_, createEarth },
    )

    // The equirect pass never rasterises a mesh, so anything that only
    // exists on one is built and thrown away — and half of them are
    // meaningless on an unwrap anyway.
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
