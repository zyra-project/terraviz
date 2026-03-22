/**
 * Sphere renderer - handles Three.js WebGL rendering
 */

import * as THREE from 'three'
import type { SphereOptions, ControlsState } from '../types'

export class SphereRenderer {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private sphere: THREE.Mesh | null = null
  private cloudMesh: THREE.Mesh | null = null
  private skyboxMesh: THREE.Mesh | null = null
  private controls: ControlsState = {
    isRotating: false,
    autoRotate: false,
    zoomLevel: 1
  }
  private velocityX = 0
  private velocityY = 0
  private readonly DAMPING = 0.88
  private readonly SENSITIVITY = 0.005
  private raycaster = new THREE.Raycaster()
  private mouseNDC = new THREE.Vector2()
  private mouseOverSphere = false
  private onLatLng: ((lat: number, lng: number) => void) | null = null
  private onLatLngClear: (() => void) | null = null
  private ambientLight!: THREE.AmbientLight
  private directionalLight!: THREE.DirectionalLight
  private sunMode = false
  private sunLocalDir = new THREE.Vector3() // sun direction in sphere-local space
  private sunSprite: THREE.Sprite | null = null
  private sunGlowSprite: THREE.Sprite | null = null
  private defaultEarthActive = false
  private earthShaderUniforms: { uSunDir?: { value: THREE.Vector3 } } = {}
  private atmosphereInner: THREE.Mesh | null = null
  private atmosphereOuter: THREE.Mesh | null = null

  private readonly isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)

  constructor(container: HTMLElement) {
    // Scene setup
    this.scene = new THREE.Scene()
    this.loadSkybox()

    // Camera setup
    const width = container.clientWidth
    const height = container.clientHeight
    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 10000)
    this.camera.position.z = 1.8

    // Renderer setup
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isMobile,  // MSAA is expensive on mobile GPUs
      alpha: true,
      preserveDrawingBuffer: true
    })
    this.renderer.setSize(width, height)
    // Mobile: cap at 1× — retina pixel ratio doubles the framebuffer and kills perf
    this.renderer.setPixelRatio(this.isMobile ? 1 : Math.min(window.devicePixelRatio, 2))
    // Shadow maps are GPU-expensive and barely perceptible on small screens
    this.renderer.shadowMap.enabled = !this.isMobile
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(this.renderer.domElement)

    // Lighting setup
    this.setupLighting()

    // Event listeners
    this.setupEventListeners(container)

    // Handle window resize
    window.addEventListener('resize', () => this.onWindowResize(container))

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
        color: new THREE.Color(0.3, 0.3, 0.3) // Dim the stars
      })
    })

    const geometry = new THREE.BoxGeometry(9000, 9000, 9000)
    this.skyboxMesh = new THREE.Mesh(geometry, materials)
    this.scene.add(this.skyboxMesh)
  }

  private setupLighting(): void {
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    this.scene.add(this.ambientLight)

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
    this.directionalLight.position.set(5, 5, 5)
    this.directionalLight.castShadow = true
    this.directionalLight.shadow.mapSize.width = 2048
    this.directionalLight.shadow.mapSize.height = 2048
    this.scene.add(this.directionalLight)
  }

  /**
   * Enable realistic sun lighting positioned at the given subsolar lat/lng.
   * Dims ambient so the night side is dark.
   */
  /**
   * Load enhanced Earth materials: diffuse, normal, specular maps + night lights.
   * Night lights use emissiveMap with a custom shader patch so they only appear
   * on the dark (unlit) side of the sphere.
   */
  loadDefaultEarthMaterials(): Promise<void> {
    if (!this.sphere) return Promise.resolve()

    const loader = new THREE.TextureLoader()

    return new Promise((resolve) => {
      let loaded = 0
      const total = 4
      const onLoad = () => { if (++loaded >= total) resolve() }

      const diffuse = loader.load('/assets/Earth_Diffuse_6K.jpg', onLoad)
      const normal = loader.load('/assets/Earth_Normal_2K.jpg', onLoad)
      const specular = loader.load('/assets/Earth_Specular_2K.jpg', onLoad)
      const nightLights = loader.load('/assets/Earth_Lights_6K.jpg', onLoad)

      diffuse.colorSpace = THREE.SRGBColorSpace
      nightLights.colorSpace = THREE.SRGBColorSpace

      const material = new THREE.MeshPhongMaterial({
        map: diffuse,
        normalMap: normal,
        normalScale: new THREE.Vector2(0.4, 0.4),
        specularMap: specular,
        specular: new THREE.Color(0xaaaaaa),
        shininess: 40,
        emissiveMap: nightLights,
        emissive: new THREE.Color(0xffffff),
      })

      // Patch the shader so emissive (night lights) only shows on the unlit side.
      // Use a custom uniform for sun direction (updated each frame in animate loop).
      const sunDirUniform = { value: new THREE.Vector3(1, 0, 0) }
      this.earthShaderUniforms = { uSunDir: sunDirUniform }

      material.onBeforeCompile = (shader) => {
        shader.uniforms.uSunDir = sunDirUniform

        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `#include <common>
           uniform vec3 uSunDir;
           varying float vNdotL;`
        )
        shader.vertexShader = shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
           vec3 wNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
           vNdotL = dot(wNormal, uSunDir);`
        )

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>
           varying float vNdotL;`
        )
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `#ifdef USE_EMISSIVEMAP
             vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
             float nightFactor = smoothstep( 0.0, -0.2, vNdotL );
             totalEmissiveRadiance *= emissiveColor.rgb * nightFactor;
           #endif`
        )
      }

      // Dispose old material
      if (this.sphere!.material) {
        const mats = Array.isArray(this.sphere!.material)
          ? this.sphere!.material : [this.sphere!.material]
        mats.forEach(m => m.dispose())
      }
      this.sphere!.material = material

      this.defaultEarthActive = true
      this.createAtmosphere()
      console.log('[Renderer] Enhanced Earth materials loaded')
    })
  }

  /**
   * Reset default earth material state
   */
  removeNightLights(): void {
    this.defaultEarthActive = false
    this.removeAtmosphere()
  }

  /**
   * Create inner and outer atmosphere shells with simplified Rayleigh scattering.
   *
   * Physics approximated:
   *  - Rayleigh scattering intensity ∝ 1 + cos²(θ) where θ = scatter angle
   *  - Limb brightening via Fresnel (optical path length increases at grazing angles)
   *  - Atmosphere only visible where sunlight reaches it
   *  - Warm color shift at the terminator (long optical path = red/orange survives)
   *  - Forward scattering creates a bright halo when looking sunward
   */
  private createAtmosphere(): void {
    this.removeAtmosphere()

    const atmosphereVertexShader = `
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `

    // Rayleigh scattering coefficients for Earth's atmosphere (m⁻¹)
    // β_R = (5.5, 13.0, 22.4) × 10⁻⁶  — blue scatters ~4x more than red
    // Normalized to [0,1] for color weighting: divide by max component
    // These determine the natural blue color of the atmosphere
    const scatteringConstants = `
      const vec3 betaR = vec3(5.5e-6, 13.0e-6, 22.4e-6); // Rayleigh coefficients
      const vec3 betaNorm = betaR / 22.4e-6;               // Normalized scatter color
      const float kMie = 21e-6;                             // Mie coefficient
    `

    // Inner glow — very thin feathered rim, no hard edges
    const innerFragShader = `
      uniform vec3 uSunDir;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      ${scatteringConstants}

      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        vec3 N = normalize(vWorldNormal);

        // Soft exponential falloff — no hard edge
        float NdotV = dot(viewDir, N);
        float rim = exp(-8.0 * NdotV * NdotV);

        // Sunlight illumination
        float sunNdot = dot(N, uSunDir);
        float atmosphereLit = smoothstep(-0.15, 0.4, sunNdot);

        // Optical depth increases at grazing angles (limb)
        // Long path = more scattering = red/green scattered away, leaving warm tones
        float opticalDepth = 1.0 / max(NdotV, 0.05);

        // Rayleigh extinction along the optical path
        // At normal incidence: blue dominates. At limb: blue is scattered away
        vec3 extinction = exp(-betaR * opticalDepth * 4e5);
        vec3 rayleighColor = betaNorm * (1.0 - extinction);

        // Terminator: long horizontal path through atmosphere
        float terminator = exp(-6.0 * sunNdot * sunNdot);
        vec3 sunsetWarm = vec3(1.0, 0.4, 0.1); // surviving long-wavelength light
        vec3 color = mix(rayleighColor, sunsetWarm, terminator * rim * 0.5);

        float alpha = rim * atmosphereLit * 0.35;
        gl_FragColor = vec4(color, alpha);
      }
    `

    // Outer glow — upper atmosphere scattering halo
    const outerFragShader = `
      uniform vec3 uSunDir;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      ${scatteringConstants}

      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        vec3 N = normalize(vWorldNormal);

        // Fresnel for limb glow
        float fresnel = 1.0 - dot(viewDir, N);
        float rim = pow(fresnel, 1.5);

        // Sun illumination
        float sunNdot = dot(N, uSunDir);
        float atmosphereLit = smoothstep(-0.15, 0.4, sunNdot);

        // Rayleigh phase: P(θ) = 3/4 (1 + cos²θ)
        float cosTheta = dot(viewDir, uSunDir);
        float rayleighPhase = 0.75 * (1.0 + cosTheta * cosTheta);

        // Mie phase: Henyey-Greenstein with g = 0.758
        float g = 0.758;
        float g2 = g * g;
        float miePhase = (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
        miePhase *= 0.12; // scale down — Mie is a subtle addition at this scale

        // Wavelength-dependent scatter color from Rayleigh coefficients
        vec3 scatterColor = betaNorm * rayleighPhase;
        // Mie adds a white/warm forward-scatter component
        scatterColor += vec3(1.0, 0.95, 0.85) * miePhase;

        // Terminator warm tones from extinction
        float terminator = exp(-8.0 * sunNdot * sunNdot);
        vec3 sunsetColor = vec3(1.0, 0.4, 0.08);
        scatterColor = mix(scatterColor, sunsetColor, terminator * 0.35);

        float alpha = rim * atmosphereLit * 0.18;
        gl_FragColor = vec4(scatterColor, alpha);
      }
    `

    const sunDir = this.earthShaderUniforms.uSunDir || { value: new THREE.Vector3(1, 0, 0) }

    // Inner atmosphere — very tight to surface, soft feathered edge
    // Real atmosphere visible rim is ~0.3% of radius at most
    const innerGeo = new THREE.SphereGeometry(1.003, 64, 64)
    const innerMat = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: innerFragShader,
      uniforms: { uSunDir: sunDir },
      transparent: true,
      side: THREE.FrontSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.atmosphereInner = new THREE.Mesh(innerGeo, innerMat)
    this.scene.add(this.atmosphereInner)

    // Outer atmosphere — ~0.8% of Earth radius (stratosphere boundary)
    const outerGeo = new THREE.SphereGeometry(1.012, 64, 64)
    const outerMat = new THREE.ShaderMaterial({
      vertexShader: atmosphereVertexShader,
      fragmentShader: outerFragShader,
      uniforms: { uSunDir: sunDir },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.atmosphereOuter = new THREE.Mesh(outerGeo, outerMat)
    this.scene.add(this.atmosphereOuter)
  }

  private removeAtmosphere(): void {
    if (this.atmosphereInner) {
      this.scene.remove(this.atmosphereInner)
      this.atmosphereInner.geometry.dispose()
      ;(this.atmosphereInner.material as THREE.Material).dispose()
      this.atmosphereInner = null
    }
    if (this.atmosphereOuter) {
      this.scene.remove(this.atmosphereOuter)
      this.atmosphereOuter.geometry.dispose()
      ;(this.atmosphereOuter.material as THREE.Material).dispose()
      this.atmosphereOuter = null
    }
  }

  /**
   * Generate a radial gradient texture for sun glow
   */
  private createGlowTexture(size: number, coreRadius: number, color: [number, number, number]): THREE.Texture {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const center = size / 2

    const gradient = ctx.createRadialGradient(center, center, 0, center, center, center)
    gradient.addColorStop(0, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 1.0)`)
    gradient.addColorStop(coreRadius, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.6)`)
    gradient.addColorStop(coreRadius + 0.15, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.15)`)
    gradient.addColorStop(1, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.0)`)

    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, size, size)

    const texture = new THREE.CanvasTexture(canvas)
    texture.needsUpdate = true
    return texture
  }

  private createSunVisual(): void {
    this.removeSunVisual()

    // Bright core
    const coreTexture = this.createGlowTexture(256, 0.08, [255, 250, 230])
    const coreMaterial = new THREE.SpriteMaterial({
      map: coreTexture,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 1.0
    })
    this.sunSprite = new THREE.Sprite(coreMaterial)
    this.sunSprite.scale.set(4, 4, 1)
    this.scene.add(this.sunSprite)

    // Outer glow halo
    const glowTexture = this.createGlowTexture(256, 0.02, [255, 210, 140])
    const glowMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.35
    })
    this.sunGlowSprite = new THREE.Sprite(glowMaterial)
    this.sunGlowSprite.scale.set(12, 12, 1)
    this.scene.add(this.sunGlowSprite)
  }

  private removeSunVisual(): void {
    if (this.sunSprite) {
      this.scene.remove(this.sunSprite)
      this.sunSprite.material.map?.dispose()
      this.sunSprite.material.dispose()
      this.sunSprite = null
    }
    if (this.sunGlowSprite) {
      this.scene.remove(this.sunGlowSprite)
      this.sunGlowSprite.material.map?.dispose()
      this.sunGlowSprite.material.dispose()
      this.sunGlowSprite = null
    }
  }

  enableSunLighting(lat: number, lng: number): void {
    this.sunMode = true

    // Store sun direction in sphere-local (geographic) space
    // Matches the coordinate system used in updateLatLng:
    //   x = cos(lat) * cos(lng), z = -cos(lat) * sin(lng), y = sin(lat)
    const latRad = lat * (Math.PI / 180)
    const lngRad = lng * (Math.PI / 180)
    this.sunLocalDir.set(
      Math.cos(latRad) * Math.cos(lngRad),
      Math.sin(latRad),
      -Math.cos(latRad) * Math.sin(lngRad)
    )

    // Warm sunlight color, strong intensity
    this.directionalLight.color.set(0xfff5e0)
    this.directionalLight.intensity = 1.8

    // Low ambient for visible night side
    this.ambientLight.intensity = 0.08
    this.ambientLight.color.set(0x334466) // Subtle blue-ish earthshine

    this.createSunVisual()
  }

  /**
   * Revert to even lighting for dataset viewing
   */
  disableSunLighting(): void {
    this.sunMode = false
    this.directionalLight.position.set(5, 5, 5)
    this.directionalLight.color.set(0xffffff)
    this.directionalLight.intensity = 0.8
    this.ambientLight.intensity = 0.6
    this.ambientLight.color.set(0xffffff)
    this.removeSunVisual()
  }

  private setupEventListeners(container: HTMLElement): void {
    // Mouse events for rotation
    container.addEventListener('mousedown', (e) => this.onMouseDown(e))
    container.addEventListener('mousemove', (e) => this.onMouseMove(e))
    container.addEventListener('mouseup', () => this.onMouseUp())
    container.addEventListener('wheel', (e) => this.onMouseWheel(e), { passive: false })

    // Touch events for mobile
    container.addEventListener('touchstart', (e) => this.onTouchStart(e))
    container.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false })
    container.addEventListener('touchend', () => this.onTouchEnd())

    // Clear lat/lng when mouse leaves
    container.addEventListener('mouseleave', () => {
      this.mouseOverSphere = false
      this.onLatLngClear?.()
    })

    // Double-click to reset
    container.addEventListener('dblclick', () => this.resetView())
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.target !== this.renderer.domElement) return
    this.controls.isRotating = true
    this.velocityX = 0
    this.velocityY = 0
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.controls.isRotating && this.sphere) {
      this.velocityX = e.movementX * this.SENSITIVITY
      this.velocityY = e.movementY * this.SENSITIVITY

      this.sphere.rotation.y += this.velocityX
      this.sphere.rotation.x += this.velocityY
      this.sphere.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.sphere.rotation.x))
    }

    // Store NDC for continuous raycasting during auto-rotate
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.mouseOverSphere = true

    this.updateLatLng()
  }

  private onMouseUp(): void {
    this.controls.isRotating = false
    // velocity carries over into the animate loop for inertia
  }

  private onMouseWheel(e: WheelEvent): void {
    // Let UI panels handle their own scrolling
    if ((e.target as HTMLElement).closest?.('.ui-panel')) return

    e.preventDefault()

    // Zoom step proportional to distance from surface — slows as you get closer
    const currentZ = this.camera.position.z
    const distFromSurface = currentZ - 1.0
    const step = distFromSurface * 0.12 * (e.deltaY > 0 ? 1 : -1)

    this.camera.position.z = Math.max(1.15, Math.min(3.6, currentZ + step))
  }

  private lastTouchX = 0
  private lastTouchY = 0

  private onTouchStart(e: TouchEvent): void {
    if (e.touches.length === 1) {
      this.controls.isRotating = true
      this.velocityX = 0
      this.velocityY = 0
      this.lastTouchX = e.touches[0].clientX
      this.lastTouchY = e.touches[0].clientY
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault()

    if (e.touches.length === 1 && this.controls.isRotating && this.sphere) {
      const touch = e.touches[0]
      this.velocityX = (touch.clientX - this.lastTouchX) * this.SENSITIVITY
      this.velocityY = (touch.clientY - this.lastTouchY) * this.SENSITIVITY

      this.sphere.rotation.y += this.velocityX
      this.sphere.rotation.x += this.velocityY
      this.sphere.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.sphere.rotation.x))

      this.lastTouchX = touch.clientX
      this.lastTouchY = touch.clientY
      
    } else if (e.touches.length === 2) {
      // Two finger pinch zoom
      const touch1 = e.touches[0]
      const touch2 = e.touches[1]
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      )
      
      const prevDistance = (e as any).previousDistance || distance
      const pinchDelta = (distance - prevDistance) * 0.002
      const distFromSurface = this.camera.position.z - 1.0
      const step = distFromSurface * pinchDelta

      this.camera.position.z = Math.max(1.15, Math.min(3.6, this.camera.position.z - step))
      
      ;(e as any).previousDistance = distance
    }
  }

  private onTouchEnd(): void {
    this.controls.isRotating = false
    ;(window as any).previousDistance = null
  }

  private onWindowResize(container: HTMLElement): void {
    const width = container.clientWidth
    const height = container.clientHeight
    
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  private resetView(): void {
    if (this.sphere) {
      this.sphere.rotation.set(0, 0, 0)
    }
    this.controls.zoomLevel = 1
    this.camera.position.z = 1.8
  }

  /**
   * Create and render a sphere with the given options
   */
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

    // Create geometry
    const geometry = new THREE.SphereGeometry(
      options.radius,
      options.widthSegments,
      options.heightSegments
    )

    // Create material with texture if provided
    let material: THREE.Material
    if (options.texture instanceof THREE.Texture) {
      material = new THREE.MeshPhongMaterial({ map: options.texture })
    } else if (options.texture instanceof HTMLCanvasElement || options.texture instanceof HTMLImageElement) {
      const texture = new THREE.CanvasTexture(options.texture as any)
      texture.colorSpace = THREE.SRGBColorSpace
      material = new THREE.MeshPhongMaterial({ map: texture })
    } else {
      // Default material with colors
      material = new THREE.MeshPhongMaterial({
        color: 0x4488ff,
        emissive: 0x112244,
        shininess: 50
      })
    }

    // Create mesh
    this.sphere = new THREE.Mesh(geometry, material)
    this.sphere.castShadow = true
    this.sphere.receiveShadow = true
    this.scene.add(this.sphere)

    return this.sphere
  }

  /**
   * Update sphere texture
   */
  updateTexture(texture: THREE.Texture | HTMLCanvasElement | HTMLImageElement): void {
    if (!this.sphere) return

    let material = this.sphere.material as THREE.MeshPhongMaterial
    if (Array.isArray(material)) {
      material = material[0] as THREE.MeshPhongMaterial
    }

    if (texture instanceof THREE.Texture) {
      material.map = texture
    } else if (texture instanceof HTMLCanvasElement || texture instanceof HTMLImageElement) {
      const canvasTexture = new THREE.CanvasTexture(texture as any)
      canvasTexture.colorSpace = THREE.SRGBColorSpace
      material.map = canvasTexture
    }

    // Reset color so texture shows true colors
    material.color.set(0xffffff)
    material.emissive.set(0x000000)
    material.needsUpdate = true
  }

  /**
   * Set callbacks for lat/lng display
   */
  setLatLngCallbacks(
    onUpdate: (lat: number, lng: number) => void,
    onClear: () => void
  ): void {
    this.onLatLng = onUpdate
    this.onLatLngClear = onClear
  }

  /**
   * Raycast from screen coordinates to sphere, compute lat/lng
   */
  /**
   * Raycast from stored mouse NDC to sphere, compute lat/lng.
   * Called on mouse move and each animation frame during rotation.
   */
  private updateLatLng(): void {
    if (!this.sphere || !this.onLatLng || !this.mouseOverSphere) return

    this.raycaster.setFromCamera(this.mouseNDC, this.camera)
    const hits = this.raycaster.intersectObject(this.sphere)

    if (hits.length > 0) {
      const localPoint = this.sphere.worldToLocal(hits[0].point.clone())

      const lat = Math.asin(localPoint.y) * (180 / Math.PI)
      const lng = Math.atan2(-localPoint.z, localPoint.x) * (180 / Math.PI)

      this.onLatLng(lat, lng)
    } else {
      this.onLatLngClear?.()
    }
  }

  /**
   * Load a cloud overlay layer on top of the sphere.
   * Black pixels become transparent, white pixels become opaque clouds.
   */
  loadCloudOverlay(url: string): void {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      // Process the cloud image to create a non-linear alpha channel
      // Boost midtones so finer cloud details are preserved
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, img.width, img.height)

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const data = imageData.data

      for (let i = 0; i < data.length; i += 4) {
        // Get luminance from RGB
        const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255

        // Non-linear curve: power < 1 boosts midtones
        // lum^0.55 preserves fine cloud detail without over-hazing
        const alpha = Math.pow(lum, 0.55)

        // Set RGB to white, alpha from curve
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
        data[i + 3] = Math.round(alpha * 255)
      }

      ctx.putImageData(imageData, 0, 0)

      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace

      const geometry = new THREE.SphereGeometry(1.005, 64, 64)
      const material = new THREE.MeshPhongMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        opacity: 0.9
      })

      // Remove previous cloud mesh if any
      if (this.cloudMesh) {
        this.scene.remove(this.cloudMesh)
        this.cloudMesh.geometry.dispose()
        ;(this.cloudMesh.material as THREE.Material).dispose()
      }

      this.cloudMesh = new THREE.Mesh(geometry, material)
      this.scene.add(this.cloudMesh)

      console.log('[Renderer] Cloud overlay loaded')
    }
    img.src = url
  }

  /**
   * Remove the cloud overlay (e.g. when loading a dataset)
   */
  removeCloudOverlay(): void {
    if (this.cloudMesh) {
      this.scene.remove(this.cloudMesh)
      this.cloudMesh.geometry.dispose()
      ;(this.cloudMesh.material as THREE.Material).dispose()
      this.cloudMesh = null
    }
  }

  /**
   * Toggle auto-rotation and return the new state
   */
  toggleAutoRotate(): boolean {
    this.controls.autoRotate = !this.controls.autoRotate
    return this.controls.autoRotate
  }

  /**
   * Get current sphere
   */
  getSphere(): THREE.Mesh | null {
    return this.sphere
  }

  /**
   * Animation loop
   */
  private animate = (): void => {
    requestAnimationFrame(this.animate)

    if (this.controls.autoRotate && this.sphere) {
      this.sphere.rotation.y += 0.0015
    }

    // Apply inertia when not dragging
    if (!this.controls.isRotating && this.sphere) {
      const speed = Math.abs(this.velocityX) + Math.abs(this.velocityY)
      if (speed > 0.0001) {
        this.sphere.rotation.y += this.velocityX
        this.sphere.rotation.x += this.velocityY
        this.sphere.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.sphere.rotation.x))

        this.velocityX *= this.DAMPING
        this.velocityY *= this.DAMPING
      } else {
        this.velocityX = 0
        this.velocityY = 0
      }
    }

    // Sync skybox and cloud layer rotation with sphere
    if (this.sphere) {
      if (this.skyboxMesh) {
        this.skyboxMesh.rotation.copy(this.sphere.rotation)
      }
      if (this.cloudMesh) {
        this.cloudMesh.rotation.copy(this.sphere.rotation)
      }
      if (this.atmosphereInner) {
        this.atmosphereInner.rotation.copy(this.sphere.rotation)
      }
      if (this.atmosphereOuter) {
        this.atmosphereOuter.rotation.copy(this.sphere.rotation)
      }
      // Keep sun fixed relative to geography by rotating local dir with sphere
      if (this.sunMode) {
        const worldDir = this.sunLocalDir.clone().applyQuaternion(this.sphere.quaternion)
        this.directionalLight.position.copy(worldDir.clone().multiplyScalar(50))

        // Update the shader uniform so night lights track the sun
        if (this.earthShaderUniforms.uSunDir) {
          this.earthShaderUniforms.uSunDir.value.copy(worldDir).normalize()
        }

        // Position sun sprites along the same direction, far from the sphere
        const spritePos = worldDir.multiplyScalar(30)
        if (this.sunSprite) this.sunSprite.position.copy(spritePos)
        if (this.sunGlowSprite) this.sunGlowSprite.position.copy(spritePos)
      }
    }

    // Re-raycast lat/lng each frame so it stays current during rotation
    if (this.mouseOverSphere) {
      this.updateLatLng()
    }

    this.renderer.render(this.scene, this.camera)
  }

  /**
   * Dispose of resources
   */
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
