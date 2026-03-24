/**
 * Earth materials, atmosphere, sun lighting, and cloud overlay.
 *
 * Extracted from SphereRenderer to keep rendering concerns separated.
 */

import * as THREE from 'three'
import { fetchImageWithProgress } from '../utils/fetchProgress'
import { logger } from '../utils/logger'

// --- Earth material constants ---
const NORMAL_MAP_SCALE = 0.4
const EARTH_SHININESS = 40
const NIGHT_LIGHT_STRENGTH = 0.5

// --- Atmosphere constants ---
const ATMOSPHERE_INNER_RADIUS = 1.003
const ATMOSPHERE_OUTER_RADIUS = 1.012
const ATMOSPHERE_SEGMENTS = 64

// --- Cloud constants ---
const CLOUD_RADIUS = 1.005
const CLOUD_SEGMENTS = 64
const CLOUD_OPACITY = 0.9
const CLOUD_ALPHA_GAMMA = 0.55

// --- Sun visual constants ---
const GLOW_TEXTURE_SIZE = 256
const SUN_CORE_SCALE = 4
const SUN_GLOW_SCALE = 12
const SUN_GLOW_OPACITY = 0.35
const SUN_SPRITE_DISTANCE = 30
const SUN_LIGHT_DISTANCE = 50

// --- Sun lighting constants ---
const SUN_LIGHT_INTENSITY = 1.8
const SUN_AMBIENT_INTENSITY = 0.08
const DEFAULT_DIRECTIONAL_INTENSITY = 0.8
const DEFAULT_AMBIENT_INTENSITY = 0.6

export class EarthMaterials {
  private scene: THREE.Scene
  private ambientLight: THREE.AmbientLight
  private directionalLight: THREE.DirectionalLight

  // Cloud overlay
  private cloudMesh: THREE.Mesh | null = null

  // Atmosphere
  private atmosphereInner: THREE.Mesh | null = null
  private atmosphereOuter: THREE.Mesh | null = null

  // Sun visual
  private sunSprite: THREE.Sprite | null = null
  private sunGlowSprite: THREE.Sprite | null = null

  // Shader uniforms shared between earth material, clouds, and atmosphere
  earthShaderUniforms: { uSunDir?: { value: THREE.Vector3 } } = {}

  // State
  defaultEarthActive = false
  sunMode = false
  sunLocalDir = new THREE.Vector3()

  constructor(scene: THREE.Scene, ambientLight: THREE.AmbientLight, directionalLight: THREE.DirectionalLight) {
    this.scene = scene
    this.ambientLight = ambientLight
    this.directionalLight = directionalLight
  }

  // --- Cloud mesh access for rotation sync in animate loop ---

  getCloudMesh(): THREE.Mesh | null { return this.cloudMesh }
  getAtmosphereInner(): THREE.Mesh | null { return this.atmosphereInner }
  getAtmosphereOuter(): THREE.Mesh | null { return this.atmosphereOuter }

  // --- Default Earth materials ---

  /**
   * Load enhanced Earth materials: diffuse, normal, specular maps + night lights.
   * Night lights use emissiveMap with a custom shader patch so they only appear
   * on the dark (unlit) side of the sphere.
   */
  async loadDefaultEarthMaterials(sphere: THREE.Mesh | null, onProgress?: (fraction: number) => void): Promise<void> {
    if (!sphere) return

    // Track combined download progress across all textures
    const sizes = [0, 0, 0, 0]
    const loaded = [0, 0, 0, 0]
    const reportProgress = () => {
      const totalBytes = sizes.reduce((a, b) => a + b, 0)
      if (totalBytes > 0 && onProgress) {
        onProgress(loaded.reduce((a, b) => a + b, 0) / totalBytes)
      }
    }
    const makeProgress = (index: number) => (l: number, t: number) => {
      sizes[index] = t; loaded[index] = l; reportProgress()
    }

    const urls = [
      '/assets/Earth_Diffuse_6K.jpg',
      '/assets/Earth_Normal_2K.jpg',
      '/assets/Earth_Specular_2K.jpg',
      '/assets/Earth_Lights_6K.jpg',
    ]
    const images = await Promise.all(
      urls.map((url, i) => fetchImageWithProgress(url, makeProgress(i)))
    )

    const toTexture = (img: HTMLImageElement, srgb = false) => {
      const tex = new THREE.Texture(img)
      if (srgb) tex.colorSpace = THREE.SRGBColorSpace
      tex.needsUpdate = true
      return tex
    }
    const diffuse = toTexture(images[0], true)
    const normal = toTexture(images[1])
    const specular = toTexture(images[2])
    const nightLights = toTexture(images[3], true)

    const material = new THREE.MeshPhongMaterial({
      map: diffuse,
      normalMap: normal,
      normalScale: new THREE.Vector2(NORMAL_MAP_SCALE, NORMAL_MAP_SCALE),
      specularMap: specular,
      specular: new THREE.Color(0xaaaaaa),
      shininess: EARTH_SHININESS,
      emissiveMap: nightLights,
      emissive: new THREE.Color(0xffffff),
    })

    // Patch the shader so emissive (night lights) only shows on the unlit side.
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
           totalEmissiveRadiance *= emissiveColor.rgb * nightFactor * ${NIGHT_LIGHT_STRENGTH};
         #endif`
      )
    }

    // Dispose old material
    if (sphere.material) {
      const mats = Array.isArray(sphere.material) ? sphere.material : [sphere.material]
      mats.forEach(m => m.dispose())
    }
    sphere.material = material

    this.defaultEarthActive = true
    this.createAtmosphere()
    logger.info('[Renderer] Enhanced Earth materials loaded')
  }

  /**
   * Reset default earth material state
   */
  removeNightLights(): void {
    this.defaultEarthActive = false
    this.removeAtmosphere()
  }

  // --- Atmosphere ---

  /**
   * Create inner and outer atmosphere shells with simplified Rayleigh scattering.
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

    const scatteringConstants = `
      const vec3 betaR = vec3(5.5e-6, 13.0e-6, 22.4e-6);
      const vec3 betaNorm = betaR / 22.4e-6;
      const float kMie = 21e-6;
    `

    // Inner glow
    const innerFragShader = `
      uniform vec3 uSunDir;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      ${scatteringConstants}

      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        vec3 N = normalize(vWorldNormal);

        float NdotV = dot(viewDir, N);
        float rim = exp(-8.0 * NdotV * NdotV);

        float sunNdot = dot(N, uSunDir);
        float atmosphereLit = smoothstep(-0.15, 0.4, sunNdot);

        float opticalDepth = 1.0 / max(NdotV, 0.05);

        vec3 extinction = exp(-betaR * opticalDepth * 4e5);
        vec3 rayleighColor = betaNorm * (1.0 - extinction);

        float terminator = exp(-6.0 * sunNdot * sunNdot);
        vec3 sunsetWarm = vec3(1.0, 0.4, 0.1);
        vec3 color = mix(rayleighColor, sunsetWarm, terminator * rim * 0.5);

        float alpha = rim * atmosphereLit * 0.35;
        gl_FragColor = vec4(color, alpha);
      }
    `

    // Outer glow
    const outerFragShader = `
      uniform vec3 uSunDir;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      ${scatteringConstants}

      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        vec3 N = normalize(vWorldNormal);

        float fresnel = 1.0 - dot(viewDir, N);
        float rim = pow(fresnel, 1.5);

        float sunNdot = dot(N, uSunDir);
        float atmosphereLit = smoothstep(-0.15, 0.4, sunNdot);

        float cosTheta = dot(viewDir, uSunDir);
        float rayleighPhase = 0.75 * (1.0 + cosTheta * cosTheta);

        float g = 0.758;
        float g2 = g * g;
        float miePhase = (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
        miePhase *= 0.12;

        vec3 scatterColor = betaNorm * rayleighPhase;
        scatterColor += vec3(1.0, 0.95, 0.85) * miePhase;

        float terminator = exp(-8.0 * sunNdot * sunNdot);
        vec3 sunsetColor = vec3(1.0, 0.4, 0.08);
        scatterColor = mix(scatterColor, sunsetColor, terminator * 0.35);

        float alpha = rim * atmosphereLit * 0.18;
        gl_FragColor = vec4(scatterColor, alpha);
      }
    `

    const sunDir = this.earthShaderUniforms.uSunDir || { value: new THREE.Vector3(1, 0, 0) }

    const innerGeo = new THREE.SphereGeometry(ATMOSPHERE_INNER_RADIUS, ATMOSPHERE_SEGMENTS, ATMOSPHERE_SEGMENTS)
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

    const outerGeo = new THREE.SphereGeometry(ATMOSPHERE_OUTER_RADIUS, ATMOSPHERE_SEGMENTS, ATMOSPHERE_SEGMENTS)
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

  // --- Sun visual ---

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

    const coreTexture = this.createGlowTexture(GLOW_TEXTURE_SIZE, 0.08, [255, 250, 230])
    const coreMaterial = new THREE.SpriteMaterial({
      map: coreTexture,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 1.0
    })
    this.sunSprite = new THREE.Sprite(coreMaterial)
    this.sunSprite.scale.set(SUN_CORE_SCALE, SUN_CORE_SCALE, 1)
    this.scene.add(this.sunSprite)

    const glowTexture = this.createGlowTexture(GLOW_TEXTURE_SIZE, 0.02, [255, 210, 140])
    const glowMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: SUN_GLOW_OPACITY
    })
    this.sunGlowSprite = new THREE.Sprite(glowMaterial)
    this.sunGlowSprite.scale.set(SUN_GLOW_SCALE, SUN_GLOW_SCALE, 1)
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

  // --- Sun lighting ---

  enableSunLighting(lat: number, lng: number): void {
    this.sunMode = true

    const latRad = lat * (Math.PI / 180)
    const lngRad = lng * (Math.PI / 180)
    this.sunLocalDir.set(
      Math.cos(latRad) * Math.cos(lngRad),
      Math.sin(latRad),
      -Math.cos(latRad) * Math.sin(lngRad)
    )

    this.directionalLight.color.set(0xfff5e0)
    this.directionalLight.intensity = SUN_LIGHT_INTENSITY

    this.ambientLight.intensity = SUN_AMBIENT_INTENSITY
    this.ambientLight.color.set(0x334466)

    this.createSunVisual()
  }

  disableSunLighting(): void {
    this.sunMode = false
    this.directionalLight.position.set(5, 5, 5)
    this.directionalLight.color.set(0xffffff)
    this.directionalLight.intensity = DEFAULT_DIRECTIONAL_INTENSITY
    this.ambientLight.intensity = DEFAULT_AMBIENT_INTENSITY
    this.ambientLight.color.set(0xffffff)
    this.removeSunVisual()
  }

  // --- Cloud overlay ---

  async loadCloudOverlay(url: string, onProgress?: (fraction: number) => void): Promise<void> {
    let img: HTMLImageElement
    try {
      img = await fetchImageWithProgress(url, (loaded, total) => {
        onProgress?.(loaded / total)
      })
    } catch {
      logger.warn('[Renderer] Cloud overlay failed to load — continuing without clouds')
      return
    }

    {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, img.width, img.height)

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const data = imageData.data

      for (let i = 0; i < data.length; i += 4) {
        const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
        const alpha = Math.pow(lum, CLOUD_ALPHA_GAMMA)
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
        data[i + 3] = Math.round(alpha * 255)
      }

      ctx.putImageData(imageData, 0, 0)

      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace

      const geometry = new THREE.SphereGeometry(CLOUD_RADIUS, CLOUD_SEGMENTS, CLOUD_SEGMENTS)
      const material = new THREE.MeshPhongMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        opacity: CLOUD_OPACITY
      })

      // On the night side, darken clouds so they obscure city lights below
      if (this.earthShaderUniforms?.uSunDir) {
        const sunDir = this.earthShaderUniforms.uSunDir
        material.onBeforeCompile = (shader) => {
          shader.uniforms.uSunDir = sunDir

          shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `#include <common>
             uniform vec3 uSunDir;
             varying float vCloudNdotL;`
          )
          shader.vertexShader = shader.vertexShader.replace(
            '#include <worldpos_vertex>',
            `#include <worldpos_vertex>
             vec3 wN = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
             vCloudNdotL = dot(wN, uSunDir);`
          )

          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            `#include <common>
             varying float vCloudNdotL;`
          )
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `#include <map_fragment>
             float nightMask = smoothstep(0.0, -0.2, vCloudNdotL);
             diffuseColor.rgb *= mix(vec3(1.0), vec3(0.08), nightMask);`
          )
        }
      }

      // Remove previous cloud mesh if any
      if (this.cloudMesh) {
        this.scene.remove(this.cloudMesh)
        this.cloudMesh.geometry.dispose()
        ;(this.cloudMesh.material as THREE.Material).dispose()
      }

      this.cloudMesh = new THREE.Mesh(geometry, material)
      this.scene.add(this.cloudMesh)

      logger.info('[Renderer] Cloud overlay loaded')
    }
  }

  removeCloudOverlay(): void {
    if (this.cloudMesh) {
      this.scene.remove(this.cloudMesh)
      this.cloudMesh.geometry.dispose()
      ;(this.cloudMesh.material as THREE.Material).dispose()
      this.cloudMesh = null
    }
  }

  // --- Animate loop helper ---

  /**
   * Called each frame to update sun-related positions when sun mode is active.
   * Keeps the sun fixed relative to geography as the sphere rotates.
   */
  updateSunFrame(sphere: THREE.Mesh | null): void {
    if (!sphere || !this.sunMode) return

    const worldDir = this.sunLocalDir.clone().applyQuaternion(sphere.quaternion)
    this.directionalLight.position.copy(worldDir.clone().multiplyScalar(SUN_LIGHT_DISTANCE))

    if (this.earthShaderUniforms.uSunDir) {
      this.earthShaderUniforms.uSunDir.value.copy(worldDir).normalize()
    }

    const spritePos = worldDir.multiplyScalar(SUN_SPRITE_DISTANCE)
    if (this.sunSprite) this.sunSprite.position.copy(spritePos)
    if (this.sunGlowSprite) this.sunGlowSprite.position.copy(spritePos)
  }

  /**
   * Sync cloud and atmosphere rotation with the sphere.
   */
  syncRotation(sphere: THREE.Mesh): void {
    if (this.cloudMesh) {
      this.cloudMesh.rotation.copy(sphere.rotation)
    }
    if (this.atmosphereInner) {
      this.atmosphereInner.rotation.copy(sphere.rotation)
    }
    if (this.atmosphereOuter) {
      this.atmosphereOuter.rotation.copy(sphere.rotation)
    }
  }
}
