/**
 * Sphere renderer - handles Three.js WebGL rendering.
 *
 * Delegates earth materials/atmosphere/sun to EarthMaterials,
 * and input handling to InputHandler.
 */

import * as THREE from 'three'
import type { SphereOptions } from '../types'
import { EarthMaterials } from './earthMaterials'
import { InputHandler } from './inputHandler'

// --- Scene constants ---
const CAMERA_FOV = 75
const CAMERA_NEAR = 0.1
const CAMERA_FAR = 10000
const CAMERA_INITIAL_Z = 1.8
const SKYBOX_SIZE = 9000
const STAR_BRIGHTNESS = 0.02
const SHADOW_MAP_SIZE = 2048
const AMBIENT_LIGHT_DEFAULT = 0.6
const DIRECTIONAL_LIGHT_DEFAULT = 0.8
const MAX_PIXEL_RATIO = 2

export class SphereRenderer {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private sphere: THREE.Mesh | null = null
  private skyboxMesh: THREE.Mesh | null = null

  private ambientLight!: THREE.AmbientLight
  private directionalLight!: THREE.DirectionalLight

  private earthMaterials: EarthMaterials
  private inputHandler: InputHandler

  private readonly isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)

  constructor(container: HTMLElement) {
    // Scene setup
    this.scene = new THREE.Scene()
    this.loadSkybox()

    // Camera setup
    const width = container.clientWidth
    const height = container.clientHeight
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, width / height, CAMERA_NEAR, CAMERA_FAR)
    this.camera.position.z = CAMERA_INITIAL_Z

    // Renderer setup
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isMobile,
      alpha: true,
      preserveDrawingBuffer: true
    })
    this.renderer.setSize(width, height)
    this.renderer.setPixelRatio(this.isMobile ? 1 : Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO))
    this.renderer.shadowMap.enabled = !this.isMobile
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // Accessibility: mark canvas as decorative image with description
    const canvas = this.renderer.domElement
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', 'Interactive 3D globe visualization')
    canvas.id = 'globe-canvas'
    container.appendChild(canvas)

    // Lighting setup
    this.setupLighting()

    // Initialise extracted modules
    this.earthMaterials = new EarthMaterials(this.scene, this.ambientLight, this.directionalLight)
    this.inputHandler = new InputHandler(container, this.camera, this.renderer)

    // Start animation loop
    this.animate()
  }

  private loadSkybox(): void {
    this.scene.background = new THREE.Color(0x000000)

    const loader = new THREE.TextureLoader()
    const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz']
    const materials = faces.map(face => {
      const tex = loader.load(`/assets/skybox/${face}.jpg`)
      return new THREE.MeshBasicMaterial({
        map: tex,
        side: THREE.BackSide,
        color: new THREE.Color(STAR_BRIGHTNESS, STAR_BRIGHTNESS, STAR_BRIGHTNESS)
      })
    })

    const geometry = new THREE.BoxGeometry(SKYBOX_SIZE, SKYBOX_SIZE, SKYBOX_SIZE)
    this.skyboxMesh = new THREE.Mesh(geometry, materials)

    // The cubemap faces were generated with astronomical Z-up convention (ICRS/J2000),
    // meaning the North Celestial Pole (NCP) is at the +Z face. Three.js is Y-up, so
    // the NCP must be at +Y to align with Earth's geographic north pole on the sphere.
    this.skyboxMesh.rotation.x = -Math.PI / 2

    this.scene.add(this.skyboxMesh)
  }

  private setupLighting(): void {
    this.ambientLight = new THREE.AmbientLight(0xffffff, AMBIENT_LIGHT_DEFAULT)
    this.scene.add(this.ambientLight)

    this.directionalLight = new THREE.DirectionalLight(0xffffff, DIRECTIONAL_LIGHT_DEFAULT)
    this.directionalLight.position.set(5, 5, 5)
    this.directionalLight.castShadow = true
    this.directionalLight.shadow.mapSize.width = SHADOW_MAP_SIZE
    this.directionalLight.shadow.mapSize.height = SHADOW_MAP_SIZE
    this.scene.add(this.directionalLight)
  }

  // --- Delegated Earth material methods ---

  async loadDefaultEarthMaterials(onProgress?: (fraction: number) => void): Promise<void> {
    return this.earthMaterials.loadDefaultEarthMaterials(this.sphere, onProgress)
  }

  removeNightLights(): void {
    this.earthMaterials.removeNightLights()
  }

  enableSunLighting(lat: number, lng: number): void {
    this.earthMaterials.enableSunLighting(lat, lng)
  }

  disableSunLighting(): void {
    this.earthMaterials.disableSunLighting()
  }

  async loadCloudOverlay(url: string, onProgress?: (fraction: number) => void): Promise<void> {
    return this.earthMaterials.loadCloudOverlay(url, onProgress)
  }

  removeCloudOverlay(): void {
    this.earthMaterials.removeCloudOverlay()
  }

  // --- Delegated input methods ---

  setLatLngCallbacks(
    onUpdate: (lat: number, lng: number) => void,
    onClear: () => void
  ): void {
    this.inputHandler.setLatLngCallbacks(onUpdate, onClear)
  }

  toggleAutoRotate(): boolean {
    return this.inputHandler.toggleAutoRotate()
  }

  // --- Sphere management ---

  createSphere(options: SphereOptions): THREE.Mesh {
    // Remove old sphere
    if (this.sphere) {
      this.scene.remove(this.sphere)
      if (this.sphere.geometry) this.sphere.geometry.dispose()
      if (this.sphere.material) {
        const materials = Array.isArray(this.sphere.material) ? this.sphere.material : [this.sphere.material]
        materials.forEach(m => m.dispose())
      }
    }

    const geometry = new THREE.SphereGeometry(
      options.radius,
      options.widthSegments,
      options.heightSegments
    )

    let material: THREE.Material
    if (options.texture instanceof THREE.Texture) {
      material = new THREE.MeshPhongMaterial({ map: options.texture })
    } else if (options.texture instanceof HTMLCanvasElement || options.texture instanceof HTMLImageElement) {
      const texture = new THREE.CanvasTexture(options.texture as any)
      texture.colorSpace = THREE.SRGBColorSpace
      material = new THREE.MeshPhongMaterial({ map: texture })
    } else {
      material = new THREE.MeshPhongMaterial({
        color: 0x4488ff,
        emissive: 0x112244,
        shininess: 50
      })
    }

    this.sphere = new THREE.Mesh(geometry, material)
    this.sphere.castShadow = true
    this.sphere.receiveShadow = true
    this.scene.add(this.sphere)

    // Share sphere reference with input handler
    this.inputHandler.sphere = this.sphere

    return this.sphere
  }

  // --- Texture management ---

  updateTexture(texture: THREE.Texture | HTMLCanvasElement | HTMLImageElement): void {
    if (!this.sphere) return

    let material = this.sphere.material as THREE.MeshPhongMaterial
    if (Array.isArray(material)) {
      material = material[0] as THREE.MeshPhongMaterial
    }

    if (material.map && material.map !== texture) {
      material.map.dispose()
    }

    if (texture instanceof THREE.Texture) {
      material.map = texture
    } else if (texture instanceof HTMLCanvasElement || texture instanceof HTMLImageElement) {
      const canvasTexture = new THREE.CanvasTexture(texture as any)
      canvasTexture.colorSpace = THREE.SRGBColorSpace
      material.map = canvasTexture
    }

    // Strip advanced Earth maps so dataset renders with simple unlit material
    if (material.normalMap) { material.normalMap.dispose(); material.normalMap = null }
    if (material.specularMap) { material.specularMap.dispose(); material.specularMap = null }
    if (material.emissiveMap) { material.emissiveMap.dispose(); material.emissiveMap = null }
    material.shininess = 0
    material.specular.set(0x000000)

    material.color.set(0xffffff)
    material.emissive.set(0x000000)
    material.needsUpdate = true

    this.earthMaterials.defaultEarthActive = false
  }

  setVideoTexture(video: HTMLVideoElement): THREE.VideoTexture {
    if (!this.sphere) throw new Error('Sphere not initialized')

    let material = this.sphere.material as THREE.MeshPhongMaterial
    if (Array.isArray(material)) {
      material = material[0] as THREE.MeshPhongMaterial
    }

    if (material.map) {
      material.map.dispose()
    }

    const videoTexture = new THREE.VideoTexture(video)
    videoTexture.colorSpace = THREE.SRGBColorSpace
    material.map = videoTexture

    if (material.normalMap) { material.normalMap.dispose(); material.normalMap = null }
    if (material.specularMap) { material.specularMap.dispose(); material.specularMap = null }
    if (material.emissiveMap) { material.emissiveMap.dispose(); material.emissiveMap = null }
    material.shininess = 0
    material.specular.set(0x000000)

    material.color.set(0xffffff)
    material.emissive.set(0x000000)
    material.needsUpdate = true

    this.earthMaterials.defaultEarthActive = false

    return videoTexture
  }

  // --- Canvas description ---

  setCanvasDescription(text: string): void {
    this.renderer.domElement.setAttribute('aria-label', text)
  }

  getSphere(): THREE.Mesh | null {
    return this.sphere
  }

  // --- Animation loop ---

  private animate = (): void => {
    requestAnimationFrame(this.animate)

    // Input: auto-rotate, inertia, lat/lng
    this.inputHandler.applyFrameUpdate()

    // Sync skybox rotation with sphere
    if (this.sphere) {
      if (this.skyboxMesh) {
        this.skyboxMesh.rotation.set(
          this.sphere.rotation.x - Math.PI / 2,
          this.sphere.rotation.y,
          this.sphere.rotation.z
        )
      }

      // Sync cloud and atmosphere rotation
      this.earthMaterials.syncRotation(this.sphere)

      // Update sun position relative to sphere rotation
      this.earthMaterials.updateSunFrame(this.sphere)
    }

    this.renderer.render(this.scene, this.camera)

    // Expose camera distance for vision context (read by captureViewContext)
    this.renderer.domElement.dataset.cameraZ = this.camera.position.z.toFixed(2)
  }

  // --- Disposal ---

  dispose(): void {
    if (this.sphere?.geometry) this.sphere.geometry.dispose()
    if (this.sphere?.material) {
      const materials = Array.isArray(this.sphere.material) ? this.sphere.material : [this.sphere.material]
      materials.forEach(m => m.dispose())
    }
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
