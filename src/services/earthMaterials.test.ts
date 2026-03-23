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

  class MockTextureLoader {
    load = vi.fn().mockReturnValue(new THREE.Texture())
  }

  return { ...THREE, WebGLRenderer: MockWebGLRenderer, TextureLoader: MockTextureLoader }
})

vi.stubGlobal('requestAnimationFrame', vi.fn())

import * as THREE from 'three'
import { EarthMaterials } from './earthMaterials'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeEarthMaterials(): EarthMaterials {
  const scene = new THREE.Scene()
  const ambient = new THREE.AmbientLight(0xffffff, 0.6)
  const directional = new THREE.DirectionalLight(0xffffff, 0.8)
  return new EarthMaterials(scene, ambient, directional)
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------
describe('EarthMaterials — construction', () => {
  it('constructs without throwing', () => {
    expect(() => makeEarthMaterials()).not.toThrow()
  })

  it('starts with sun mode disabled', () => {
    const em = makeEarthMaterials()
    expect(em.sunMode).toBe(false)
    expect(em.defaultEarthActive).toBe(false)
  })

  it('starts with no cloud or atmosphere meshes', () => {
    const em = makeEarthMaterials()
    expect(em.getCloudMesh()).toBeNull()
    expect(em.getAtmosphereInner()).toBeNull()
    expect(em.getAtmosphereOuter()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// enableSunLighting — sun direction calculation
// ---------------------------------------------------------------------------
describe('EarthMaterials.enableSunLighting', () => {
  it('sets sunMode to true', () => {
    const em = makeEarthMaterials()
    em.enableSunLighting(0, 0)
    expect(em.sunMode).toBe(true)
  })

  it('calculates correct sun direction at equator/prime meridian (0°, 0°)', () => {
    const em = makeEarthMaterials()
    em.enableSunLighting(0, 0)

    // lat=0, lng=0: x = cos(0)*cos(0) = 1, y = sin(0) = 0, z = -cos(0)*sin(0) = 0
    expect(em.sunLocalDir.x).toBeCloseTo(1, 5)
    expect(em.sunLocalDir.y).toBeCloseTo(0, 5)
    expect(em.sunLocalDir.z).toBeCloseTo(0, 5)
  })

  it('calculates correct sun direction at north pole (90°N, 0°E)', () => {
    const em = makeEarthMaterials()
    em.enableSunLighting(90, 0)

    // lat=90°: x = cos(90°)*cos(0) ≈ 0, y = sin(90°) = 1, z ≈ 0
    expect(em.sunLocalDir.x).toBeCloseTo(0, 4)
    expect(em.sunLocalDir.y).toBeCloseTo(1, 5)
    expect(em.sunLocalDir.z).toBeCloseTo(0, 4)
  })

  it('calculates correct sun direction at 23.44°N (summer solstice)', () => {
    const em = makeEarthMaterials()
    em.enableSunLighting(23.44, 0)

    const latRad = 23.44 * Math.PI / 180
    expect(em.sunLocalDir.x).toBeCloseTo(Math.cos(latRad), 5)
    expect(em.sunLocalDir.y).toBeCloseTo(Math.sin(latRad), 5)
    expect(em.sunLocalDir.z).toBeCloseTo(0, 5)
  })

  it('calculates correct sun direction at (0°, 90°E)', () => {
    const em = makeEarthMaterials()
    em.enableSunLighting(0, 90)

    // lat=0, lng=90°: x = cos(0)*cos(90°) ≈ 0, y = 0, z = -cos(0)*sin(90°) = -1
    expect(em.sunLocalDir.x).toBeCloseTo(0, 4)
    expect(em.sunLocalDir.y).toBeCloseTo(0, 5)
    expect(em.sunLocalDir.z).toBeCloseTo(-1, 4)
  })

  it('calculates correct sun direction at (0°, 90°W)', () => {
    const em = makeEarthMaterials()
    em.enableSunLighting(0, -90)

    // lat=0, lng=-90°: x ≈ 0, y = 0, z = -cos(0)*sin(-90°) = 1
    expect(em.sunLocalDir.x).toBeCloseTo(0, 4)
    expect(em.sunLocalDir.y).toBeCloseTo(0, 5)
    expect(em.sunLocalDir.z).toBeCloseTo(1, 4)
  })

  it('dims ambient light for night side', () => {
    const scene = new THREE.Scene()
    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    const directional = new THREE.DirectionalLight(0xffffff, 0.8)
    const em = new EarthMaterials(scene, ambient, directional)

    em.enableSunLighting(0, 0)

    expect(ambient.intensity).toBe(0.08)
    expect(directional.intensity).toBe(1.8)
  })
})

// ---------------------------------------------------------------------------
// disableSunLighting — revert to even lighting
// ---------------------------------------------------------------------------
describe('EarthMaterials.disableSunLighting', () => {
  it('restores default lighting values', () => {
    const scene = new THREE.Scene()
    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    const directional = new THREE.DirectionalLight(0xffffff, 0.8)
    const em = new EarthMaterials(scene, ambient, directional)

    em.enableSunLighting(45, 90)
    em.disableSunLighting()

    expect(em.sunMode).toBe(false)
    expect(ambient.intensity).toBe(0.6)
    expect(directional.intensity).toBe(0.8)
  })
})

// ---------------------------------------------------------------------------
// removeNightLights
// ---------------------------------------------------------------------------
describe('EarthMaterials.removeNightLights', () => {
  it('sets defaultEarthActive to false', () => {
    const em = makeEarthMaterials()
    em.defaultEarthActive = true
    em.removeNightLights()
    expect(em.defaultEarthActive).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// removeCloudOverlay
// ---------------------------------------------------------------------------
describe('EarthMaterials.removeCloudOverlay', () => {
  it('does nothing when no cloud mesh exists', () => {
    const em = makeEarthMaterials()
    expect(() => em.removeCloudOverlay()).not.toThrow()
    expect(em.getCloudMesh()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// syncRotation
// ---------------------------------------------------------------------------
describe('EarthMaterials.syncRotation', () => {
  it('does nothing when no child meshes exist', () => {
    const em = makeEarthMaterials()
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 8), new THREE.MeshBasicMaterial())
    sphere.rotation.set(0.5, 1.0, 0.2)

    expect(() => em.syncRotation(sphere)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// updateSunFrame
// ---------------------------------------------------------------------------
describe('EarthMaterials.updateSunFrame', () => {
  it('does nothing when sphere is null', () => {
    const em = makeEarthMaterials()
    expect(() => em.updateSunFrame(null)).not.toThrow()
  })

  it('does nothing when sun mode is off', () => {
    const em = makeEarthMaterials()
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 8), new THREE.MeshBasicMaterial())
    expect(() => em.updateSunFrame(sphere)).not.toThrow()
  })

  it('updates directional light position when sun mode is on', () => {
    const scene = new THREE.Scene()
    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    const directional = new THREE.DirectionalLight(0xffffff, 0.8)
    const em = new EarthMaterials(scene, ambient, directional)

    em.enableSunLighting(0, 0) // sunLocalDir = (1, 0, 0)

    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 8), new THREE.MeshBasicMaterial())
    scene.add(sphere)

    em.updateSunFrame(sphere)

    // With no sphere rotation, world dir = local dir = (1, 0, 0)
    // Light should be at (50, 0, 0) approximately
    expect(directional.position.x).toBeCloseTo(50, 0)
    expect(directional.position.y).toBeCloseTo(0, 0)
    expect(directional.position.z).toBeCloseTo(0, 0)
  })
})
