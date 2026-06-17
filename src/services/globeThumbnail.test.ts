import { describe, expect, it, vi } from 'vitest'
import {
  canvasToBlob,
  generateGlobeThumbnail,
  orthoHalfExtent,
  resolveGlobeThumbnailOptions,
} from './globeThumbnail'

describe('resolveGlobeThumbnailOptions', () => {
  it('fills in the documented defaults', () => {
    expect(resolveGlobeThumbnailOptions()).toEqual({
      size: 512,
      supersample: 2,
      fill: 0.92,
      mime: 'image/webp',
      quality: 0.92,
      lonOrigin: 0,
      latOrigin: 0,
    })
  })

  it('passes longitude through and clamps latitude tilt to ±90', () => {
    expect(resolveGlobeThumbnailOptions({ lonOrigin: 200 }).lonOrigin).toBe(200)
    expect(resolveGlobeThumbnailOptions({ latOrigin: 45 }).latOrigin).toBe(45)
    expect(resolveGlobeThumbnailOptions({ latOrigin: 200 }).latOrigin).toBe(90)
    expect(resolveGlobeThumbnailOptions({ latOrigin: -200 }).latOrigin).toBe(-90)
  })

  it('rounds and clamps the output size into the supported range', () => {
    expect(resolveGlobeThumbnailOptions({ size: 100.6 }).size).toBe(101)
    expect(resolveGlobeThumbnailOptions({ size: 4 }).size).toBe(16)
    expect(resolveGlobeThumbnailOptions({ size: 99999 }).size).toBe(2048)
  })

  it('bounds supersample, fill, and quality to their valid fractions', () => {
    expect(resolveGlobeThumbnailOptions({ supersample: 50 }).supersample).toBe(4)
    expect(resolveGlobeThumbnailOptions({ supersample: 0 }).supersample).toBe(1)
    expect(resolveGlobeThumbnailOptions({ fill: 5 }).fill).toBe(1)
    expect(resolveGlobeThumbnailOptions({ fill: 0 }).fill).toBe(0.1)
    expect(resolveGlobeThumbnailOptions({ quality: 2 }).quality).toBe(1)
  })

  it('rounds supersample to an integer (no fractional render dimensions)', () => {
    expect(resolveGlobeThumbnailOptions({ supersample: 1.5 }).supersample).toBe(2)
    expect(resolveGlobeThumbnailOptions({ supersample: 2.4 }).supersample).toBe(2)
  })

  it('only accepts png as an alternative mime, else falls back to webp', () => {
    expect(resolveGlobeThumbnailOptions({ mime: 'image/png' }).mime).toBe('image/png')
    expect(
      resolveGlobeThumbnailOptions({ mime: 'image/gif' as unknown as 'image/png' }).mime,
    ).toBe('image/webp')
  })
})

describe('orthoHalfExtent', () => {
  it('is 1/fill so a unit sphere leaves the requested margin', () => {
    expect(orthoHalfExtent(1)).toBe(1)
    expect(orthoHalfExtent(0.5)).toBe(2)
    expect(orthoHalfExtent(0.92)).toBeCloseTo(1.087, 3)
  })

  it('clamps degenerate fills', () => {
    expect(orthoHalfExtent(0)).toBe(10) // 1/0.1
    expect(orthoHalfExtent(5)).toBe(1) // 1/1
  })
})

describe('canvasToBlob', () => {
  it('resolves with the produced blob', async () => {
    const blob = new Blob(['x'], { type: 'image/webp' })
    const canvas = {
      toBlob: (cb: BlobCallback) => cb(blob),
    } as unknown as HTMLCanvasElement
    await expect(canvasToBlob(canvas, 'image/webp', 0.9)).resolves.toBe(blob)
  })

  it('rejects when the encoder returns null', async () => {
    const canvas = {
      toBlob: (cb: BlobCallback) => cb(null),
    } as unknown as HTMLCanvasElement
    await expect(canvasToBlob(canvas, 'image/webp', 0.9)).rejects.toThrow(/returned null/)
  })
})

/**
 * Fake Three.js module. WebGL can't run under happy-dom, so the
 * orchestration is exercised against a stand-in that records the
 * calls + disposals we care about (render fired, every GPU resource
 * released).
 */
function fakeThree() {
  const events: string[] = []
  const blob = new Blob(['rendered'], { type: 'image/webp' })
  class WebGLRenderer {
    domElement: unknown
    constructor(opts: { canvas: unknown }) {
      this.domElement = opts.canvas
    }
    setSize() {}
    setClearColor() {}
    render() {
      events.push('render')
    }
    dispose() {
      events.push('renderer.dispose')
    }
    forceContextLoss() {
      events.push('renderer.forceContextLoss')
    }
  }
  class Scene {
    add() {}
  }
  class OrthographicCamera {
    position = { set: vi.fn() }
    constructor(
      public left: number,
      public right: number,
      public top: number,
      public bottom: number,
      public near: number,
      public far: number,
    ) {}
    lookAt() {}
  }

  const three = {
    WebGLRenderer,
    Scene,
    OrthographicCamera,
    SRGBColorSpace: 'srgb',
    LinearFilter: 'linear',
  } as unknown as typeof import('three')

  return { three, events, blob }
}

/**
 * Fake earth factory — records lifecycle (addTo / setTexture /
 * update / removeFrom / dispose) and the texture spec it's handed
 * (so a test can assert the dataset overlay was forwarded), and
 * fires `onReady` synchronously like the real image branch.
 */
function fakeEarthFactory(events: string[], opts: { baseDeferred?: boolean } = {}) {
  const specs: Array<{ kind?: string; options?: unknown }> = []
  // `baseDeferred` models a regional dataset whose colour base-Earth
  // diffuse hasn't streamed in yet — `baseDiffuseTexture` is null
  // until `fireBaseLoaded()`.
  let baseLoaded = !opts.baseDeferred
  let baseCb: (() => void) | null = null
  const createEarth = (() => ({
    globe: { rotation: { x: 0, y: 0 } },
    get baseDiffuseTexture() {
      return baseLoaded ? {} : null
    },
    baseEarthTexture: {},
    onBaseDiffuseChange: (cb: () => void) => {
      baseCb = cb
      return () => {
        baseCb = null
      }
    },
    addTo: () => events.push('earth.addTo'),
    removeFrom: () => events.push('earth.removeFrom'),
    setTexture: (spec: { kind?: string; options?: unknown }, onReady?: () => void) => {
      specs.push(spec)
      events.push('earth.setTexture')
      onReady?.()
    },
    sunDir: {},
    update: () => events.push('earth.update'),
    dispose: () => events.push('earth.dispose'),
  })) as unknown as NonNullable<
    Parameters<typeof generateGlobeThumbnail>[2]
  >['createEarth']
  const fireBaseLoaded = (): void => {
    baseLoaded = true
    baseCb?.()
  }
  return { createEarth, specs, fireBaseLoaded }
}

function fakeCanvasFactory(blob: Blob) {
  const ctx = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    drawImage: vi.fn(),
  }
  return (width: number, height: number) =>
    ({
      width,
      height,
      getContext: () => ctx,
      toBlob: (cb: BlobCallback) => cb(blob),
    }) as unknown as HTMLCanvasElement
}

describe('generateGlobeThumbnail', () => {
  it('renders via the earth stack, captures a blob, and releases every resource', async () => {
    const { three, events, blob } = fakeThree()
    const { createEarth } = fakeEarthFactory(events)
    const source = { width: 2048, height: 1024 } as unknown as HTMLImageElement

    const result = await generateGlobeThumbnail(
      source,
      { size: 256, supersample: 2 },
      { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob), createEarth },
    )

    expect(result).toBe(blob)
    // The dataset texture is set + the render fires before teardown,
    // and every resource is released (a leaked context would exhaust
    // the browser pool after a few previews).
    expect(events).toEqual(
      expect.arrayContaining([
        'earth.addTo',
        'earth.setTexture',
        'earth.update',
        'render',
        'earth.removeFrom',
        'earth.dispose',
        'renderer.dispose',
        'renderer.forceContextLoss',
      ]),
    )
    expect(events.indexOf('earth.setTexture')).toBeLessThan(events.indexOf('render'))
    expect(events.indexOf('render')).toBeLessThan(events.indexOf('earth.dispose'))
  })

  it('forwards the dataset overlay (bbox / flip / lonOrigin) to the earth texture', async () => {
    const { three, events, blob } = fakeThree()
    const { createEarth, specs } = fakeEarthFactory(events)
    const source = { width: 2048, height: 1024 } as unknown as HTMLImageElement
    const overlay = { boundingBox: { n: 50, s: 10, w: -20, e: 20 }, isFlippedInY: true }

    await generateGlobeThumbnail(
      source,
      { overlay },
      { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob), createEarth },
    )

    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ kind: 'image', options: overlay })
  })

  it('waits for the colour base-Earth diffuse before capturing a regional dataset', async () => {
    const { three, events, blob } = fakeThree()
    const { createEarth, fireBaseLoaded } = fakeEarthFactory(events, { baseDeferred: true })
    const source = { width: 2048, height: 1024 } as unknown as HTMLImageElement

    const p = generateGlobeThumbnail(
      source,
      // Regional Earth dataset → base Earth shows outside the bbox.
      { overlay: { boundingBox: { n: 60, s: 20, w: -10, e: 30 } }, baseDiffuseTimeoutMs: 10_000 },
      { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob), createEarth },
    )
    // Let setTexture + the base-diffuse subscribe settle.
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))
    // The render is gated on the base diffuse — it hasn't fired yet.
    expect(events).not.toContain('render')

    fireBaseLoaded()
    const result = await p
    expect(result).toBe(blob)
    expect(events).toContain('render')
  })

  it('captures with the fallback base after the timeout when the diffuse never loads', async () => {
    const { three, events, blob } = fakeThree()
    const { createEarth } = fakeEarthFactory(events, { baseDeferred: true })
    const source = { width: 2048, height: 1024 } as unknown as HTMLImageElement

    // Never fire base-loaded; a short timeout must still let it capture.
    const result = await generateGlobeThumbnail(
      source,
      { overlay: { boundingBox: { n: 60, s: 20, w: -10, e: 30 } }, baseDiffuseTimeoutMs: 5 },
      { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob), createEarth },
    )
    expect(result).toBe(blob)
    expect(events).toContain('render')
  })

  it('does NOT wait for the base on a global dataset (no bbox)', async () => {
    const { three, events, blob } = fakeThree()
    // Deferred base, but no bbox → no base is shown, so no wait.
    const { createEarth } = fakeEarthFactory(events, { baseDeferred: true })
    const source = { width: 2048, height: 1024 } as unknown as HTMLImageElement

    const result = await generateGlobeThumbnail(
      source,
      { baseDiffuseTimeoutMs: 10_000 },
      { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob), createEarth },
    )
    // Resolved immediately (didn't hang on the 10s base wait).
    expect(result).toBe(blob)
    expect(events).toContain('render')
  })

  it('still disposes resources when the render throws', async () => {
    const { three, events, blob } = fakeThree()
    const { createEarth } = fakeEarthFactory(events)
    // Force the render to throw.
    ;(three as unknown as { WebGLRenderer: { prototype: { render: () => void } } }).WebGLRenderer.prototype.render =
      () => {
        throw new Error('gl boom')
      }
    const source = { width: 2048, height: 1024 } as unknown as HTMLImageElement

    await expect(
      generateGlobeThumbnail(
        source,
        {},
        { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob), createEarth },
      ),
    ).rejects.toThrow('gl boom')

    expect(events).toEqual(
      expect.arrayContaining([
        'earth.removeFrom',
        'earth.dispose',
        'renderer.dispose',
        'renderer.forceContextLoss',
      ]),
    )
  })
})
