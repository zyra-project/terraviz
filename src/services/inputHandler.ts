/**
 * Input handling for the 3D globe: mouse/touch rotation, zoom, and lat/lng raycasting.
 *
 * Extracted from SphereRenderer to separate interaction concerns from rendering.
 */

import * as THREE from 'three'
import type { ControlsState } from '../types'
import { debounce } from '../utils/debounce'

// --- Input constants ---
const DAMPING = 0.88
const SENSITIVITY = 0.005
const AUTO_ROTATE_SPEED = 0.0015
const INERTIA_THRESHOLD = 0.0001
export const ZOOM_MIN = 1.15
export const ZOOM_MAX = 3.6
const ZOOM_STEP_FACTOR = 0.12
const SPHERE_SURFACE_RADIUS = 1.0
const PINCH_SENSITIVITY = 0.002
const CAMERA_DEFAULT_Z = 1.8
const RESIZE_DEBOUNCE_MS = 150
const EARTH_RADIUS_KM = 6371
const FLY_TO_DURATION_MS = 2500

export class InputHandler {
  private camera: THREE.PerspectiveCamera
  private webglRenderer: THREE.WebGLRenderer
  private controls: ControlsState = {
    isRotating: false,
    autoRotate: false,
    zoomLevel: 1
  }

  /** Set by the parent after sphere creation. */
  sphere: THREE.Mesh | null = null

  private velocityX = 0
  private velocityY = 0

  private raycaster = new THREE.Raycaster()
  private mouseNDC = new THREE.Vector2()
  private mouseOverSphere = false

  private onLatLng: ((lat: number, lng: number) => void) | null = null
  private onLatLngClear: (() => void) | null = null

  // Touch state
  private lastTouchX = 0
  private lastTouchY = 0
  private lastPinchDistance = 0

  // Fly-to animation state
  private flyAnim: {
    startRotX: number; startRotY: number; startZ: number
    targetRotX: number; targetRotY: number; targetZ: number
    startTime: number; duration: number
    resolve: () => void
  } | null = null
  private savedAutoRotate = false

  constructor(
    container: HTMLElement,
    camera: THREE.PerspectiveCamera,
    webglRenderer: THREE.WebGLRenderer,
  ) {
    this.camera = camera
    this.webglRenderer = webglRenderer
    this.setupEventListeners(container)
    window.addEventListener('resize', debounce(() => this.onWindowResize(container), RESIZE_DEBOUNCE_MS))
  }

  setLatLngCallbacks(
    onUpdate: (lat: number, lng: number) => void,
    onClear: () => void
  ): void {
    this.onLatLng = onUpdate
    this.onLatLngClear = onClear
  }

  toggleAutoRotate(): boolean {
    this.controls.autoRotate = !this.controls.autoRotate
    return this.controls.autoRotate
  }

  // --- Event setup ---

  private setupEventListeners(container: HTMLElement): void {
    container.addEventListener('mousedown', (e) => this.onMouseDown(e))
    container.addEventListener('mousemove', (e) => this.onMouseMove(e))
    container.addEventListener('mouseup', () => this.onMouseUp())
    container.addEventListener('wheel', (e) => this.onMouseWheel(e), { passive: false })

    container.addEventListener('touchstart', (e) => this.onTouchStart(e))
    container.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false })
    container.addEventListener('touchend', () => this.onTouchEnd())

    container.addEventListener('mouseleave', () => {
      this.mouseOverSphere = false
      this.onLatLngClear?.()
    })

    container.addEventListener('dblclick', () => this.resetView())
  }

  // --- Mouse handlers ---

  private onMouseDown(e: MouseEvent): void {
    if (e.target !== this.webglRenderer.domElement) return
    if (this.flyAnim) this.cancelFlyTo()
    this.controls.isRotating = true
    this.velocityX = 0
    this.velocityY = 0
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.controls.isRotating && this.sphere) {
      this.velocityX = e.movementX * SENSITIVITY
      this.velocityY = e.movementY * SENSITIVITY

      this.sphere.rotation.y += this.velocityX
      this.sphere.rotation.x += this.velocityY
      this.sphere.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.sphere.rotation.x))
    }

    // Store NDC for continuous raycasting during auto-rotate
    const rect = this.webglRenderer.domElement.getBoundingClientRect()
    this.mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.mouseOverSphere = true

    this.updateLatLng()
  }

  private onMouseUp(): void {
    this.controls.isRotating = false
  }

  private onMouseWheel(e: WheelEvent): void {
    if ((e.target as HTMLElement).closest?.('.ui-panel')) return
    e.preventDefault()

    const currentZ = this.camera.position.z
    const distFromSurface = currentZ - SPHERE_SURFACE_RADIUS
    const step = distFromSurface * ZOOM_STEP_FACTOR * (e.deltaY > 0 ? 1 : -1)
    this.camera.position.z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, currentZ + step))
  }

  // --- Touch handlers ---

  private isTouchOnUI(e: TouchEvent): boolean {
    const target = e.target as HTMLElement
    return !!target?.closest?.('#ui .ui-panel, #playback-controls')
  }

  private onTouchStart(e: TouchEvent): void {
    if (this.isTouchOnUI(e)) return
    if (this.flyAnim) this.cancelFlyTo()

    if (e.touches.length === 1) {
      this.controls.isRotating = true
      this.velocityX = 0
      this.velocityY = 0
      this.lastTouchX = e.touches[0].clientX
      this.lastTouchY = e.touches[0].clientY
    } else if (e.touches.length === 2) {
      this.controls.isRotating = false
      this.lastPinchDistance = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      )
    }
  }

  private onTouchMove(e: TouchEvent): void {
    if (this.isTouchOnUI(e)) return
    e.preventDefault()

    if (e.touches.length === 1 && this.controls.isRotating && this.sphere) {
      const touch = e.touches[0]
      this.velocityX = (touch.clientX - this.lastTouchX) * SENSITIVITY
      this.velocityY = (touch.clientY - this.lastTouchY) * SENSITIVITY

      this.sphere.rotation.y += this.velocityX
      this.sphere.rotation.x += this.velocityY
      this.sphere.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.sphere.rotation.x))

      this.lastTouchX = touch.clientX
      this.lastTouchY = touch.clientY

    } else if (e.touches.length === 2) {
      const distance = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      )
      const pinchDelta = (distance - this.lastPinchDistance) * PINCH_SENSITIVITY
      const distFromSurface = this.camera.position.z - SPHERE_SURFACE_RADIUS
      this.camera.position.z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.camera.position.z - distFromSurface * pinchDelta))
      this.lastPinchDistance = distance
    }
  }

  private onTouchEnd(): void {
    this.controls.isRotating = false
    this.lastPinchDistance = 0
  }

  // --- Resize ---

  private onWindowResize(container: HTMLElement): void {
    const width = container.clientWidth
    const height = container.clientHeight
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.webglRenderer.setSize(width, height)
  }

  private resetView(): void {
    if (this.sphere) {
      this.sphere.rotation.set(0, 0, 0)
    }
    this.controls.zoomLevel = 1
    this.camera.position.z = CAMERA_DEFAULT_Z
  }

  // --- Lat/lng raycasting ---

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

  // --- Fly-to animation ---

  /** Whether a fly-to animation is currently in progress. */
  get isAnimating(): boolean {
    return this.flyAnim !== null
  }

  /**
   * Smoothly animate the globe to center on a geographic location.
   * @param lat Latitude in degrees (-90 to 90)
   * @param lon Longitude in degrees (-180 to 180)
   * @param altitude Optional viewing altitude in km above the surface
   */
  flyTo(lat: number, lon: number, altitude?: number): Promise<void> {
    // Cancel any in-progress animation
    this.cancelFlyTo()

    if (!this.sphere) return Promise.resolve()

    const targetRotX = lat * Math.PI / 180
    // The sphere's default rotation.y=0 faces 90°W (the raycasting formula
    // is lng = atan2(-z_local, x_local), and at rotY=0 the camera-facing
    // local point is (0,0,1), giving atan2(-1,0) = -90°).
    // So to center on longitude L: rotY = -L_rad - PI/2.
    const targetRotY = -lon * Math.PI / 180 - Math.PI / 2

    const targetZ = altitude !== undefined
      ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, SPHERE_SURFACE_RADIUS + altitude / EARTH_RADIUS_KM))
      : this.camera.position.z

    // Normalize starting Y rotation to [-PI, PI] so shortest-path works
    let startRotY = this.sphere.rotation.y % (2 * Math.PI)
    if (startRotY > Math.PI) startRotY -= 2 * Math.PI
    if (startRotY < -Math.PI) startRotY += 2 * Math.PI

    // Choose shortest rotation path for Y
    let deltaY = targetRotY - startRotY
    if (deltaY > Math.PI) deltaY -= 2 * Math.PI
    if (deltaY < -Math.PI) deltaY += 2 * Math.PI
    const adjustedTargetRotY = startRotY + deltaY

    // Save and disable auto-rotate; zero velocity
    this.savedAutoRotate = this.controls.autoRotate
    this.controls.autoRotate = false
    this.velocityX = 0
    this.velocityY = 0

    return new Promise<void>((resolve) => {
      this.flyAnim = {
        startRotX: this.sphere!.rotation.x,
        startRotY: startRotY,
        startZ: this.camera.position.z,
        targetRotX: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, targetRotX)),
        targetRotY: adjustedTargetRotY,
        targetZ,
        startTime: performance.now(),
        duration: FLY_TO_DURATION_MS,
        resolve,
      }
    })
  }

  /** Cancel any in-progress fly-to animation, snapping to the current interpolated position. */
  cancelFlyTo(): void {
    if (this.flyAnim) {
      this.flyAnim.resolve()
      this.flyAnim = null
      // Restore auto-rotate if it was active before
      this.controls.autoRotate = this.savedAutoRotate
    }
  }

  // --- Animate loop helper ---

  /**
   * Apply auto-rotation, inertia, and lat/lng updates. Called each frame.
   */
  applyFrameUpdate(): void {
    if (!this.sphere) return

    // Fly-to animation takes priority
    if (this.flyAnim) {
      const elapsed = performance.now() - this.flyAnim.startTime
      const rawT = Math.min(1, elapsed / this.flyAnim.duration)
      const t = easeInOutCubic(rawT)

      this.sphere.rotation.x = this.flyAnim.startRotX + (this.flyAnim.targetRotX - this.flyAnim.startRotX) * t
      this.sphere.rotation.y = this.flyAnim.startRotY + (this.flyAnim.targetRotY - this.flyAnim.startRotY) * t
      this.camera.position.z = this.flyAnim.startZ + (this.flyAnim.targetZ - this.flyAnim.startZ) * t

      if (rawT >= 1) {
        const { resolve } = this.flyAnim
        this.flyAnim = null
        this.controls.autoRotate = this.savedAutoRotate
        resolve()
      }

      // Update lat/lng display during animation
      if (this.mouseOverSphere) this.updateLatLng()
      return
    }

    if (this.controls.autoRotate) {
      this.sphere.rotation.y += AUTO_ROTATE_SPEED
    }

    // Inertia when not dragging
    if (!this.controls.isRotating) {
      const speed = Math.abs(this.velocityX) + Math.abs(this.velocityY)
      if (speed > INERTIA_THRESHOLD) {
        this.sphere.rotation.y += this.velocityX
        this.sphere.rotation.x += this.velocityY
        this.sphere.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.sphere.rotation.x))

        this.velocityX *= DAMPING
        this.velocityY *= DAMPING
      } else {
        this.velocityX = 0
        this.velocityY = 0
      }
    }

    if (this.mouseOverSphere) {
      this.updateLatLng()
    }
  }
}

/** Smooth acceleration and deceleration curve. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
