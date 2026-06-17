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
 * no GPU, so a server-side 3D render isn't possible. Three.js +
 * `createPhotorealEarth` are lazy-imported (mirrors the VR / Orbit
 * lazy-load pattern) so the publisher portal bundle is unchanged
 * until a publisher actually generates a thumbnail.
 *
 * The render reuses the live globe's `createPhotorealEarth` stack in
 * dataset mode, so the thumbnail matches the real globe: data lit
 * uniformly (no day/night terminator), regional data clipped to its
 * `boundingBox` over a base Earth, `lonOrigin` / `isFlippedInY`
 * honored, non-Earth bodies handled. An orthographic camera frames
 * the globe; the background is transparent so the round globe sits
 * cleanly on the card surface.
 */

import type * as THREE from 'three'
import type { DatasetOverlayOptions } from '../types'
import { isEarthBody } from './datasetOverlayOptions'
import type {
  PhotorealEarthHandle,
  PhotorealEarthOptions,
} from './photorealEarth'

/** Source frame — anything Three can turn into a texture. In
 *  practice an `HTMLImageElement` (decoded from the picked file or
 *  the dataset's data asset) or a `HTMLCanvasElement` (a frame
 *  grabbed from the dataset's video). */
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
  /** The dataset's own render hints — bounding box, longitude
   *  origin, Y-flip, celestial body. When the source IS the
   *  dataset's data, passing these makes the thumbnail match how
   *  the dataset actually renders on the globe (regional data clips
   *  to its bbox over a base Earth, flipped data isn't upside-down,
   *  etc.). Omit for a generic hand-picked frame (full-globe
   *  equirectangular). */
  overlay?: DatasetOverlayOptions
  /** Max time to wait for the colour base-Earth diffuse to stream in
   *  before capturing a *regional* (bbox) Earth dataset — otherwise
   *  the base would freeze on the low-detail grey fallback. Ignored
   *  for global / non-Earth datasets (no base is shown). Default
   *  4000 ms; on timeout we capture with whatever base has loaded. */
  baseDiffuseTimeoutMs?: number
}

/** Injection seam — WebGL / the photoreal-Earth shaders can't run
 *  under happy-dom, so tests pass a fake `three` module, canvas
 *  factory, and earth factory to exercise the orchestration without
 *  a real GL context. Production defaults lazy-import the real
 *  Three.js + `createPhotorealEarth` and use `document.createElement`. */
export interface GlobeThumbnailDeps {
  loadThree?: () => Promise<typeof import('three')>
  createCanvas?: (width: number, height: number) => HTMLCanvasElement
  /** Builds the dataset-on-globe render stack. Defaults to the
   *  shared `createPhotorealEarth` so the thumbnail matches the live
   *  globe (same shaders / overlay projection / uniform dataset
   *  lighting). */
  createEarth?: (
    three: typeof import('three'),
    options: PhotorealEarthOptions,
  ) => PhotorealEarthHandle
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
  // Round to an integer so a fractional factor (e.g. 1.5) can't yield
  // fractional canvas / renderer dimensions. PR #208 Copilot review.
  const supersample = Math.round(clamp(opts.supersample ?? DEFAULTS.supersample, 1, 4))
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

/** Default ceiling on the base-Earth diffuse wait for regional
 *  datasets — long enough for the 2K tier on a typical connection,
 *  short enough that a slow/unreachable CDN doesn't hang thumbnail
 *  generation (we capture with the grey fallback on timeout). */
const DEFAULT_BASE_DIFFUSE_TIMEOUT_MS = 4000

/**
 * Resolve once the base-Earth colour diffuse has loaded (the handle
 * exposes a "tier upgraded" subscription), or after `timeoutMs` —
 * whichever comes first. Resolves immediately if a tier already
 * landed. Used only for regional Earth datasets, where the area
 * outside the bbox shows the base Earth.
 */
function waitForBaseDiffuse(earth: PhotorealEarthHandle, timeoutMs: number): Promise<void> {
  if (earth.baseDiffuseTexture) return Promise.resolve()
  return new Promise<void>(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      unsubscribe()
      clearTimeout(timer)
      resolve()
    }
    const unsubscribe = earth.onBaseDiffuseChange(() => finish())
    const timer = setTimeout(finish, timeoutMs)
    // The texture may have landed between the guard above and the
    // subscribe — capture that so we don't wait the full timeout.
    if (earth.baseDiffuseTexture) finish()
  })
}

/**
 * Render `source` onto the globe and capture a square thumbnail.
 *
 * The render reuses the live globe's `createPhotorealEarth` stack in
 * dataset mode, so the thumbnail matches how the dataset actually
 * looks on the globe: the data is lit uniformly (no day/night
 * terminator), regional data clips to its `boundingBox` and reveals
 * a base Earth outside it, `lonOrigin` / `isFlippedInY` are honored,
 * and non-Earth bodies skip the Earth base. The sun / clouds /
 * shadow / atmosphere decoration is switched off — a thumbnail wants
 * the data, not the planet dressing.
 *
 * Always disposes the earth handle + renderer it creates — a
 * publisher may generate several previews in a row, and a leaked
 * WebGL context would exhaust the browser's small context pool.
 */
export async function generateGlobeThumbnail(
  source: GlobeThumbnailSource,
  options: GlobeThumbnailOptions = {},
  deps: GlobeThumbnailDeps = {},
): Promise<Blob> {
  const opts = resolveGlobeThumbnailOptions(options)
  const THREE_ = await (deps.loadThree ?? defaultLoadThree)()
  const createCanvas = deps.createCanvas ?? defaultCreateCanvas
  const createEarth =
    deps.createEarth ?? (await import('./photorealEarth')).createPhotorealEarth

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

  // Unit-radius globe at the origin; the decoration is off because a
  // thumbnail wants the data uniformly lit, not the planet dressing
  // (and `setTexture` hides it in dataset mode anyway). Lighting is
  // left on so the dataset-mode ambient fill renders the data bright.
  const earth = createEarth(THREE_, {
    radius: 1,
    position: { x: 0, y: 0, z: 0 },
    includeSun: false,
    includeClouds: false,
    includeShadow: false,
    includeAtmosphere: false,
  })
  earth.addTo(scene)
  // Publisher framing: spin/tilt the whole globe. The dataset's own
  // `lonOrigin` is applied inside the shader via `overlay`; these are
  // the publisher's extra rotation on top to centre an area of focus.
  earth.globe.rotation.y = (opts.lonOrigin * Math.PI) / 180
  earth.globe.rotation.x = (opts.latOrigin * Math.PI) / 180

  const half = orthoHalfExtent(opts.fill)
  const camera = new THREE_.OrthographicCamera(-half, half, half, -half, 0.1, 10)
  camera.position.set(0, 0, 3)
  camera.lookAt(0, 0, 0)

  try {
    // `setTexture` (image branch) is synchronous — `onReady` fires in
    // the same tick — but we await it so a future async source path
    // (or a stubbed deferred handle) stays correct.
    await new Promise<void>(resolve => {
      earth.setTexture({ kind: 'image', element: source, options: options.overlay }, resolve)
    })

    // A regional Earth dataset shows a base Earth outside its bbox,
    // which streams 2K→4K→8K from a CDN. A thumbnail is a one-shot
    // capture, so wait (bounded) for the colour diffuse to land —
    // otherwise the base freezes on the low-detail grey fallback.
    // Global / non-Earth datasets never show a base, so skip the wait.
    const overlay = options.overlay
    const needsBase = !!overlay?.boundingBox && isEarthBody(overlay.celestialBody)
    if (needsBase && !earth.baseDiffuseTexture) {
      await waitForBaseDiffuse(
        earth,
        options.baseDiffuseTimeoutMs ?? DEFAULT_BASE_DIFFUSE_TIMEOUT_MS,
      )
    }

    earth.update()
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
    earth.removeFrom(scene)
    earth.dispose()
    renderer.dispose()
    // Drop the GL context eagerly — `dispose()` alone leaves it
    // alive until GC, and the browser caps live contexts.
    renderer.forceContextLoss()
  }
}
