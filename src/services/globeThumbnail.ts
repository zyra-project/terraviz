/**
 * Globe thumbnail generator.
 *
 * Renders a 2:1 equirectangular data frame onto a sphere and
 * captures a square "globe viewed from a distance" image, suitable
 * for a dataset's browse-card thumbnail (`thumbnail_ref`). Most
 * publishers can't produce a globe render by hand, so this turns a
 * flat data frame — which they already have — into the wrapped-on-a-
 * sphere thumbnail the catalog wants.
 *
 * Runs entirely in the publisher's browser: Cloudflare Workers have
 * no GPU, so a server-side 3D render isn't possible. Three.js is
 * lazy-imported (mirrors the VR / Orbit lazy-load pattern) so the
 * publisher portal bundle is unchanged until a publisher actually
 * generates a thumbnail.
 *
 * The render is deliberately flat-lit (`MeshBasicMaterial`, no
 * scene lights) so the data reads faithfully — colour isn't
 * darkened by a light direction. The equirectangular pole-pinching
 * plus an orthographic camera already make the disc read as a
 * globe. Background is transparent so the round globe sits cleanly
 * on the card surface.
 */

import type * as THREE from 'three'

/** Source frame — anything Three can turn into a texture. In
 *  practice an `HTMLImageElement` (decoded from the picked file or
 *  the dataset's data asset) or an `ImageBitmap`. */
export type GlobeThumbnailSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap

export interface GlobeThumbnailOptions {
  /** Output edge length in px (square). Default 512. */
  size?: number
  /** Supersample factor applied before the downscale pass — the
   *  render runs at `size * supersample` then shrinks, which is a
   *  cheap, reliable antialias for the globe limb. Default 2. */
  supersample?: number
  /** Fraction of the frame's half-extent the globe disc fills
   *  (0..1). 0.92 leaves a small margin so the limb isn't clipped.
   *  Default 0.92. */
  fill?: number
  /** Output mime. WebP (with alpha) is smallest; PNG is the
   *  lossless fallback. Default `'image/webp'`. */
  mime?: 'image/webp' | 'image/png'
  /** Encoder quality for `image/webp` (0..1). Ignored for PNG.
   *  Default 0.92. */
  quality?: number
  /** Longitude rotation in degrees applied to the sphere so a
   *  chosen meridian faces the camera. Default 0 (the texture's
   *  horizontal centre faces front). */
  lonOrigin?: number
  /** Latitude tilt in degrees — tilts the globe up/down so a
   *  chosen parallel faces the camera. Paired with `lonOrigin`,
   *  this lets a publisher bring any region to the centre of the
   *  capture. Default 0. */
  latOrigin?: number
}

/** Injection seam — WebGL can't run under happy-dom, so tests pass
 *  a fake `three` module + canvas factory to exercise the
 *  orchestration without a real GL context. Production defaults
 *  lazy-import the real Three.js and use `document.createElement`. */
export interface GlobeThumbnailDeps {
  loadThree?: () => Promise<typeof import('three')>
  createCanvas?: (width: number, height: number) => HTMLCanvasElement
}

interface ResolvedOptions {
  size: number
  supersample: number
  fill: number
  mime: 'image/webp' | 'image/png'
  quality: number
  lonOrigin: number
  latOrigin: number
}

const DEFAULTS: ResolvedOptions = {
  size: 512,
  supersample: 2,
  fill: 0.92,
  mime: 'image/webp',
  quality: 0.92,
  lonOrigin: 0,
  latOrigin: 0,
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Normalise + clamp caller options. Exported for direct unit
 * testing of the bounds (sizes round to integers; fill/quality are
 * fractions; supersample is bounded so a typo can't request a
 * 50×-supersampled render that blows the GPU budget).
 */
export function resolveGlobeThumbnailOptions(
  opts: GlobeThumbnailOptions = {},
): ResolvedOptions {
  const size = Math.round(clamp(opts.size ?? DEFAULTS.size, 16, 2048))
  const supersample = clamp(opts.supersample ?? DEFAULTS.supersample, 1, 4)
  const fill = clamp(opts.fill ?? DEFAULTS.fill, 0.1, 1)
  const mime = opts.mime === 'image/png' ? 'image/png' : DEFAULTS.mime
  const quality = clamp(opts.quality ?? DEFAULTS.quality, 0, 1)
  const lonOrigin = opts.lonOrigin ?? DEFAULTS.lonOrigin
  const latOrigin = clamp(opts.latOrigin ?? DEFAULTS.latOrigin, -90, 90)
  return { size, supersample, fill, mime, quality, lonOrigin, latOrigin }
}

/**
 * Half-extent of the orthographic frustum for a unit-radius sphere
 * that should fill `fill` of the frame. The sphere has radius 1, so
 * a frustum half-extent of `1 / fill` leaves `(1 - fill)` margin on
 * each side. Pure — unit-tested directly.
 */
export function orthoHalfExtent(fill: number): number {
  return 1 / clamp(fill, 0.1, 1)
}

/** Promisified `canvas.toBlob`. Rejects rather than resolving null
 *  so callers get a clear failure instead of a silent empty blob. */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => {
        if (blob) resolve(blob)
        else reject(new Error(`canvas.toBlob returned null for ${mime}`))
      },
      mime,
      quality,
    )
  })
}

/**
 * Decode a Blob into a loaded `HTMLImageElement`. Convenience for
 * callers that have raw bytes (a picked file or a fetched data
 * asset) and need a texture source. Revokes the object URL once the
 * image resolves or fails.
 */
export function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to decode image for globe thumbnail.'))
    }
    img.src = url
  })
}

let threePromise: Promise<typeof import('three')> | null = null
function defaultLoadThree(): Promise<typeof import('three')> {
  return (threePromise ??= import('three'))
}

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

/**
 * Render `source` onto a sphere and capture a square thumbnail.
 *
 * Always disposes the geometry / material / texture / renderer it
 * creates — a publisher may generate several previews in a row, and
 * a leaked WebGL context would exhaust the browser's small context
 * pool after ~16 generations.
 */
export async function generateGlobeThumbnail(
  source: GlobeThumbnailSource,
  options: GlobeThumbnailOptions = {},
  deps: GlobeThumbnailDeps = {},
): Promise<Blob> {
  const opts = resolveGlobeThumbnailOptions(options)
  const THREE_ = await (deps.loadThree ?? defaultLoadThree)()
  const createCanvas = deps.createCanvas ?? defaultCreateCanvas

  const renderSize = opts.size * opts.supersample
  const renderCanvas = createCanvas(renderSize, renderSize)

  const renderer = new THREE_.WebGLRenderer({
    canvas: renderCanvas,
    antialias: true,
    alpha: true,
    // Needed so the drawing buffer survives until we read it out
    // into the downscale canvas / toBlob.
    preserveDrawingBuffer: true,
  })
  renderer.setSize(renderSize, renderSize, false)
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE_.Scene()

  const geometry = new THREE_.SphereGeometry(1, 96, 64)
  const texture = new THREE_.Texture(source as unknown as HTMLImageElement)
  texture.colorSpace = THREE_.SRGBColorSpace
  texture.needsUpdate = true
  const material = new THREE_.MeshBasicMaterial({ map: texture })
  const mesh = new THREE_.Mesh(geometry, material)
  // Longitude spins around the polar axis; latitude tilts the globe
  // so the chosen parallel faces the camera. Together they bring any
  // region to the centre of the capture.
  mesh.rotation.y = (opts.lonOrigin * Math.PI) / 180
  mesh.rotation.x = (opts.latOrigin * Math.PI) / 180
  scene.add(mesh)

  const half = orthoHalfExtent(opts.fill)
  const camera = new THREE_.OrthographicCamera(-half, half, half, -half, 0.1, 10)
  camera.position.set(0, 0, 3)
  camera.lookAt(0, 0, 0)

  try {
    renderer.render(scene, camera)

    // Downscale the supersampled render into the target-size canvas
    // for a clean limb. happy-dom stubs the 2D context, so this path
    // is exercised (without real pixels) under test too.
    const out = createCanvas(opts.size, opts.size)
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable for globe thumbnail downscale.')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(renderer.domElement, 0, 0, opts.size, opts.size)

    return await canvasToBlob(out, opts.mime, opts.quality)
  } finally {
    geometry.dispose()
    material.dispose()
    texture.dispose()
    renderer.dispose()
    // Drop the GL context eagerly — `dispose()` alone leaves it
    // alive until GC, and the browser caps live contexts.
    renderer.forceContextLoss()
  }
}
