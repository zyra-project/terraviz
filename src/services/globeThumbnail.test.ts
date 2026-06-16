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
  class SphereGeometry {
    dispose() {
      events.push('geometry.dispose')
    }
  }
  class Texture {
    colorSpace = ''
    needsUpdate = false
    constructor(public image: unknown) {}
    dispose() {
      events.push('texture.dispose')
    }
  }
  class MeshBasicMaterial {
    constructor(public opts: unknown) {}
    dispose() {
      events.push('material.dispose')
    }
  }
  class Mesh {
    rotation = { y: 0 }
    constructor(
      public geometry: unknown,
      public material: unknown,
    ) {}
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
    SphereGeometry,
    Texture,
    MeshBasicMaterial,
    Mesh,
    OrthographicCamera,
    SRGBColorSpace: 'srgb',
  } as unknown as typeof import('three')

  return { three, events, blob }
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
  it('renders, captures a blob, and releases every GPU resource', async () => {
    const { three, events, blob } = fakeThree()
    const source = { width: 2048, height: 1024 } as unknown as HTMLImageElement

    const result = await generateGlobeThumbnail(
      source,
      { size: 256, supersample: 2 },
      { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob) },
    )

    expect(result).toBe(blob)
    // The render fired before teardown, and every GPU handle was
    // disposed (a leaked context would exhaust the browser pool
    // after a few previews).
    expect(events).toContain('render')
    expect(events).toEqual(
      expect.arrayContaining([
        'render',
        'geometry.dispose',
        'material.dispose',
        'texture.dispose',
        'renderer.dispose',
        'renderer.forceContextLoss',
      ]),
    )
    // render happens before any dispose.
    expect(events.indexOf('render')).toBeLessThan(events.indexOf('renderer.dispose'))
  })

  it('still disposes resources when the render throws', async () => {
    const { three, events, blob } = fakeThree()
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
        { loadThree: async () => three, createCanvas: fakeCanvasFactory(blob) },
      ),
    ).rejects.toThrow('gl boom')

    expect(events).toEqual(
      expect.arrayContaining([
        'geometry.dispose',
        'material.dispose',
        'texture.dispose',
        'renderer.dispose',
        'renderer.forceContextLoss',
      ]),
    )
  })
})
