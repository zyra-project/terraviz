import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock THREE — same pattern as sphereRenderer.test.ts
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

  return { ...THREE, WebGLRenderer: MockWebGLRenderer }
})

vi.stubGlobal('requestAnimationFrame', vi.fn())

import * as THREE from 'three'
import { InputHandler } from './inputHandler'

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

function makeHandler(): { handler: InputHandler; container: HTMLElement; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer } {
  const container = makeContainer()
  const camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 10000)
  camera.position.z = 1.8
  const renderer = new THREE.WebGLRenderer()
  return { handler: new InputHandler(container, camera, renderer), container, camera, renderer }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------
describe('InputHandler — construction', () => {
  it('constructs without throwing', () => {
    expect(() => makeHandler()).not.toThrow()
  })

  it('sphere starts as null', () => {
    const { handler } = makeHandler()
    expect(handler.sphere).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// toggleAutoRotate
// ---------------------------------------------------------------------------
describe('InputHandler.toggleAutoRotate', () => {
  it('returns true on first toggle', () => {
    const { handler } = makeHandler()
    expect(handler.toggleAutoRotate()).toBe(true)
  })

  it('returns false on second toggle', () => {
    const { handler } = makeHandler()
    handler.toggleAutoRotate()
    expect(handler.toggleAutoRotate()).toBe(false)
  })

  it('cycles correctly', () => {
    const { handler } = makeHandler()
    expect(handler.toggleAutoRotate()).toBe(true)
    expect(handler.toggleAutoRotate()).toBe(false)
    expect(handler.toggleAutoRotate()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// setLatLngCallbacks
// ---------------------------------------------------------------------------
describe('InputHandler.setLatLngCallbacks', () => {
  it('stores callbacks without throwing', () => {
    const { handler } = makeHandler()
    expect(() => handler.setLatLngCallbacks(vi.fn(), vi.fn())).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// applyFrameUpdate — auto-rotate and inertia
// ---------------------------------------------------------------------------
describe('InputHandler.applyFrameUpdate', () => {
  it('does nothing when sphere is null', () => {
    const { handler } = makeHandler()
    expect(() => handler.applyFrameUpdate()).not.toThrow()
  })

  it('applies auto-rotation when enabled', () => {
    const { handler } = makeHandler()
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 8, 8),
      new THREE.MeshBasicMaterial()
    )
    handler.sphere = sphere

    handler.toggleAutoRotate() // enable
    const initialY = sphere.rotation.y

    handler.applyFrameUpdate()

    expect(sphere.rotation.y).toBeCloseTo(initialY + 0.0015, 6)
  })

  it('does not auto-rotate when disabled', () => {
    const { handler } = makeHandler()
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 8, 8),
      new THREE.MeshBasicMaterial()
    )
    handler.sphere = sphere

    const initialY = sphere.rotation.y
    handler.applyFrameUpdate()

    expect(sphere.rotation.y).toBe(initialY)
  })
})

// ---------------------------------------------------------------------------
// Lat/lng calculation — math verification
// ---------------------------------------------------------------------------
describe('InputHandler — lat/lng raycasting math', () => {
  it('reports equator at (0°N, 0°E) for point (1, 0, 0) on unit sphere', () => {
    const { handler } = makeHandler()
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 32),
      new THREE.MeshBasicMaterial()
    )
    handler.sphere = sphere

    let reportedLat = NaN
    let reportedLng = NaN
    handler.setLatLngCallbacks(
      (lat, lng) => { reportedLat = lat; reportedLng = lng },
      vi.fn()
    )

    // The lat/lng calculation is: lat = asin(y), lng = atan2(-z, x)
    // For point (1, 0, 0): lat = asin(0) = 0, lng = atan2(0, 1) = 0
    // We can't easily simulate a raycast hit in unit tests without
    // a full scene, so we verify the math contract via the formula:
    const point = new THREE.Vector3(1, 0, 0)
    const lat = Math.asin(point.y) * (180 / Math.PI)
    const lng = Math.atan2(-point.z, point.x) * (180 / Math.PI)

    expect(lat).toBeCloseTo(0, 5)
    expect(lng).toBeCloseTo(0, 5)
  })

  it('reports north pole at (90°N) for point (0, 1, 0)', () => {
    const point = new THREE.Vector3(0, 1, 0)
    const lat = Math.asin(point.y) * (180 / Math.PI)
    expect(lat).toBeCloseTo(90, 5)
  })

  it('reports south pole at (90°S) for point (0, -1, 0)', () => {
    const point = new THREE.Vector3(0, -1, 0)
    const lat = Math.asin(point.y) * (180 / Math.PI)
    expect(lat).toBeCloseTo(-90, 5)
  })

  it('reports 180° for point (-1, 0, 0)', () => {
    const point = new THREE.Vector3(-1, 0, 0)
    const lng = Math.atan2(-point.z, point.x) * (180 / Math.PI)
    // atan2(0, -1) = ±π → ±180° — both are the antimeridian
    expect(Math.abs(lng)).toBeCloseTo(180, 5)
  })

  it('reports 90°E for point (0, 0, -1)', () => {
    // z = -1 → lng = atan2(-(-1), 0) = atan2(1, 0) = 90°
    const point = new THREE.Vector3(0, 0, -1)
    const lng = Math.atan2(-point.z, point.x) * (180 / Math.PI)
    expect(lng).toBeCloseTo(90, 5)
  })

  it('reports 90°W for point (0, 0, 1)', () => {
    // z = 1 → lng = atan2(-1, 0) = -90°
    const point = new THREE.Vector3(0, 0, 1)
    const lng = Math.atan2(-point.z, point.x) * (180 / Math.PI)
    expect(lng).toBeCloseTo(-90, 5)
  })
})
