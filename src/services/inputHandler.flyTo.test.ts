import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock THREE
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
import { InputHandler, ZOOM_MIN, ZOOM_MAX } from './inputHandler'

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

function makeHandler(): { handler: InputHandler; camera: THREE.PerspectiveCamera; sphere: THREE.Mesh } {
  const container = makeContainer()
  const camera = new THREE.PerspectiveCamera(75, 800 / 600, 0.1, 10000)
  camera.position.z = 1.8
  const renderer = new THREE.WebGLRenderer()
  const handler = new InputHandler(container, camera, renderer)
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 8, 8),
    new THREE.MeshBasicMaterial()
  )
  handler.sphere = sphere
  return { handler, camera, sphere }
}

// ---------------------------------------------------------------------------
// flyTo — coordinate math
// ---------------------------------------------------------------------------
describe('InputHandler.flyTo — coordinate math', () => {
  it('sets correct target rotation for equator/prime-meridian (0, 0)', async () => {
    const { handler, sphere, camera } = makeHandler()

    // Start a fly animation
    const promise = handler.flyTo(0, 0)

    // Advance to completion by simulating elapsed time
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 3000)
    handler.applyFrameUpdate()

    await promise

    // Target: rotX = 0, rotY = -0 - PI/2 = -PI/2
    expect(sphere.rotation.x).toBeCloseTo(0, 4)
    expect(sphere.rotation.y).toBeCloseTo(-Math.PI / 2, 4)
  })

  it('sets correct target rotation for New Orleans (~30N, ~-90W)', async () => {
    const { handler, sphere } = makeHandler()

    const promise = handler.flyTo(30, -90)

    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 3000)
    handler.applyFrameUpdate()

    await promise

    // Target: rotX = 30 * PI/180, rotY = -(-90)*PI/180 - PI/2 = PI/2 - PI/2 = 0
    expect(sphere.rotation.x).toBeCloseTo(30 * Math.PI / 180, 3)
    expect(sphere.rotation.y).toBeCloseTo(0, 3)
  })

  it('clamps latitude rotation to ±PI/2', async () => {
    const { handler, sphere } = makeHandler()

    // Request exactly the pole
    const promise = handler.flyTo(90, 0)

    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 3000)
    handler.applyFrameUpdate()

    await promise

    expect(sphere.rotation.x).toBeCloseTo(Math.PI / 2, 4)
  })
})

// ---------------------------------------------------------------------------
// flyTo — shortest path
// ---------------------------------------------------------------------------
describe('InputHandler.flyTo — shortest path', () => {
  it('takes the short way around when crossing the antimeridian', async () => {
    const { handler, sphere } = makeHandler()

    // Start at a rotation corresponding to lon=170°
    // rotY for lon=170 = -170*PI/180 - PI/2
    sphere.rotation.y = -170 * Math.PI / 180 - Math.PI / 2

    const promise = handler.flyTo(0, -170)

    // Target rotY for lon=-170 = 170*PI/180 - PI/2
    // Delta should be ~20° (0.349 rad), not ~340°

    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 3000)
    handler.applyFrameUpdate()

    await promise

    // Expected target: 170*PI/180 - PI/2
    const expectedRotY = 170 * Math.PI / 180 - Math.PI / 2
    let finalY = sphere.rotation.y % (2 * Math.PI)
    if (finalY > Math.PI) finalY -= 2 * Math.PI
    if (finalY < -Math.PI) finalY += 2 * Math.PI

    let expectedNorm = expectedRotY % (2 * Math.PI)
    if (expectedNorm > Math.PI) expectedNorm -= 2 * Math.PI
    if (expectedNorm < -Math.PI) expectedNorm += 2 * Math.PI

    expect(finalY).toBeCloseTo(expectedNorm, 2)
  })
})

// ---------------------------------------------------------------------------
// flyTo — altitude mapping
// ---------------------------------------------------------------------------
describe('InputHandler.flyTo — altitude', () => {
  it('maps altitude in km to camera Z', async () => {
    const { handler, camera } = makeHandler()

    // 6371 km altitude → cameraZ = 1.0 + 6371/6371 = 2.0
    const promise = handler.flyTo(0, 0, 6371)

    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 3000)
    handler.applyFrameUpdate()

    await promise

    expect(camera.position.z).toBeCloseTo(2.0, 3)
  })

  it('clamps altitude to ZOOM_MIN', async () => {
    const { handler, camera } = makeHandler()

    // Very low altitude → should clamp to ZOOM_MIN
    const promise = handler.flyTo(0, 0, 10)

    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 3000)
    handler.applyFrameUpdate()

    await promise

    expect(camera.position.z).toBeCloseTo(ZOOM_MIN, 3)
  })

  it('clamps altitude to ZOOM_MAX', async () => {
    const { handler, camera } = makeHandler()

    // Very high altitude → should clamp to ZOOM_MAX
    const promise = handler.flyTo(0, 0, 100000)

    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 3000)
    handler.applyFrameUpdate()

    await promise

    expect(camera.position.z).toBeCloseTo(ZOOM_MAX, 3)
  })

  it('keeps current altitude when not specified', async () => {
    const { handler, camera } = makeHandler()
    camera.position.z = 2.5

    const promise = handler.flyTo(0, 0)

    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 3000)
    handler.applyFrameUpdate()

    await promise

    expect(camera.position.z).toBeCloseTo(2.5, 3)
  })
})

// ---------------------------------------------------------------------------
// flyTo — cancellation
// ---------------------------------------------------------------------------
describe('InputHandler.flyTo — cancellation', () => {
  it('resolves the first promise when flyTo is called again', async () => {
    const { handler } = makeHandler()

    const first = handler.flyTo(10, 20)
    const second = handler.flyTo(30, 40)

    // First should resolve immediately (cancelled)
    await first

    // Complete second
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 3000)
    handler.applyFrameUpdate()
    await second
  })

  it('cancelFlyTo resolves promise and stops animation', async () => {
    const { handler } = makeHandler()

    const promise = handler.flyTo(45, 90)
    expect(handler.isAnimating).toBe(true)

    handler.cancelFlyTo()
    expect(handler.isAnimating).toBe(false)

    await promise // should resolve
  })
})

// ---------------------------------------------------------------------------
// isAnimating
// ---------------------------------------------------------------------------
describe('InputHandler.isAnimating', () => {
  it('is false initially', () => {
    const { handler } = makeHandler()
    expect(handler.isAnimating).toBe(false)
  })

  it('is true during flyTo animation', () => {
    const { handler } = makeHandler()
    handler.flyTo(0, 0)
    expect(handler.isAnimating).toBe(true)
  })
})
