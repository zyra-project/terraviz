import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock THREE — replace WebGLRenderer (needs WebGL) and TextureLoader
// (makes network requests) while keeping all other Three.js math intact.
// ---------------------------------------------------------------------------
vi.mock('three', async (importOriginal) => {
  const THREE = await importOriginal<typeof import('three')>()

  class MockWebGLRenderer {
    shadowMap = { enabled: false, type: THREE.PCFSoftShadowMap }
    domElement = document.createElement('canvas')
    setSize = vi.fn()
    setPixelRatio = vi.fn()
    render = vi.fn()
    dispose = vi.fn()
  }

  class MockTextureLoader {
    load = vi.fn().mockReturnValue(new THREE.Texture())
  }

  return { ...THREE, WebGLRenderer: MockWebGLRenderer, TextureLoader: MockTextureLoader }
})

// Prevent the animation loop from actually running during tests
vi.stubGlobal('requestAnimationFrame', vi.fn())

import { SphereRenderer } from './sphereRenderer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeContainer(): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
  document.body.appendChild(el)
  return el
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------
describe('SphereRenderer — construction', () => {
  it('constructs without throwing', () => {
    expect(() => new SphereRenderer(makeContainer())).not.toThrow()
  })

  it('getSphere() returns null before createSphere()', () => {
    const renderer = new SphereRenderer(makeContainer())
    expect(renderer.getSphere()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// createSphere
// ---------------------------------------------------------------------------
describe('SphereRenderer.createSphere', () => {
  let renderer: SphereRenderer

  beforeEach(() => {
    renderer = new SphereRenderer(makeContainer())
  })

  it('returns a THREE.Mesh', async () => {
    const { Mesh } = await import('three')
    const mesh = renderer.createSphere({ radius: 1, widthSegments: 32, heightSegments: 16 })
    expect(mesh).toBeInstanceOf(Mesh)
  })

  it('getSphere() returns the mesh after createSphere()', async () => {
    const { Mesh } = await import('three')
    renderer.createSphere({ radius: 1, widthSegments: 32, heightSegments: 16 })
    expect(renderer.getSphere()).toBeInstanceOf(Mesh)
  })

  it('replacing sphere disposes old geometry', () => {
    const first = renderer.createSphere({ radius: 1, widthSegments: 8, heightSegments: 8 })
    const disposeSpy = vi.spyOn(first.geometry, 'dispose')
    renderer.createSphere({ radius: 1, widthSegments: 8, heightSegments: 8 })
    expect(disposeSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// toggleAutoRotate
// ---------------------------------------------------------------------------
describe('SphereRenderer.toggleAutoRotate', () => {
  it('returns true on first toggle (was false)', () => {
    const renderer = new SphereRenderer(makeContainer())
    expect(renderer.toggleAutoRotate()).toBe(true)
  })

  it('returns false on second toggle', () => {
    const renderer = new SphereRenderer(makeContainer())
    renderer.toggleAutoRotate()
    expect(renderer.toggleAutoRotate()).toBe(false)
  })

  it('toggles back and forth correctly', () => {
    const renderer = new SphereRenderer(makeContainer())
    const states = Array.from({ length: 4 }, () => renderer.toggleAutoRotate())
    expect(states).toEqual([true, false, true, false])
  })
})

// ---------------------------------------------------------------------------
// removeCloudOverlay
// ---------------------------------------------------------------------------
describe('SphereRenderer.removeCloudOverlay', () => {
  it('is a no-op when no cloud overlay is loaded', () => {
    const renderer = new SphereRenderer(makeContainer())
    expect(() => renderer.removeCloudOverlay()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Sun lighting
// ---------------------------------------------------------------------------
describe('SphereRenderer — sun lighting', () => {
  it('enableSunLighting does not throw', () => {
    const renderer = new SphereRenderer(makeContainer())
    expect(() => renderer.enableSunLighting(23.44, 0)).not.toThrow()
  })

  it('disableSunLighting does not throw when sun is off', () => {
    const renderer = new SphereRenderer(makeContainer())
    expect(() => renderer.disableSunLighting()).not.toThrow()
  })

  it('disableSunLighting is safe after enableSunLighting', () => {
    const renderer = new SphereRenderer(makeContainer())
    renderer.enableSunLighting(23.44, -120)
    expect(() => renderer.disableSunLighting()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// setLatLngCallbacks
// ---------------------------------------------------------------------------
describe('SphereRenderer.setLatLngCallbacks', () => {
  it('stores callbacks without throwing', () => {
    const renderer = new SphereRenderer(makeContainer())
    const onUpdate = vi.fn()
    const onClear = vi.fn()
    expect(() => renderer.setLatLngCallbacks(onUpdate, onClear)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------
describe('SphereRenderer.dispose', () => {
  it('disposes without throwing when no sphere created', () => {
    const renderer = new SphereRenderer(makeContainer())
    expect(() => renderer.dispose()).not.toThrow()
  })

  it('disposes without throwing after createSphere', () => {
    const renderer = new SphereRenderer(makeContainer())
    renderer.createSphere({ radius: 1, widthSegments: 8, heightSegments: 8 })
    expect(() => renderer.dispose()).not.toThrow()
  })
})
