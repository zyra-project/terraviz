// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Reading one texel of a data-encoded frame through WebGL.
 *
 * The probe used to sample with a 1×1 `drawImage` into a 2D canvas.
 * That path is wrong on iOS Safari: measured against a known 0..255
 * ramp it returns a smooth transform with the endpoints preserved and
 * up to 11 codes of error in between (gain ~1.003, offset ~+6), on
 * every variant — tagged, untagged, limited or full range alike.
 * `colorSpace: 'srgb'` on the context and the `getImageData` call does
 * not change it, and neither does reading from one full-size blit
 * instead of per-texel draws, so the transform is applied in the
 * video→canvas step itself rather than in anything the caller controls.
 * On a 0-50 mg m-2 scale that is ±2.2, and it is silent: the globe
 * still looks right, only the number under the cursor is wrong.
 *
 * The same measurement showed the WebGL path exact on iOS, Chrome and
 * Firefox. So the probe reads the way the globe renders — which is what
 * `docs/DATA_ENCODED_VIDEO_PLAN.md` wanted in the first place, so that
 * the value reported and the colour drawn cannot disagree.
 *
 * This deliberately builds its **own** context rather than borrowing
 * MapLibre's or Three's. That is exactly the configuration
 * `scripts/luma-range-check` validated — separate WebGL2 context,
 * `texImage2D` from the video element, render, `readPixels` — so what
 * ships is what was measured. Reusing a renderer's live texture would
 * be a different path, unmeasured, and would need per-renderer plumbing
 * for no gain the probe can observe.
 */

import type { ProbeSource, TexelUv } from './datasetProbe'
import { logger } from '../utils/logger'

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`

// One texel, chosen by uniform. The whole 1×1 viewport is that texel,
// so there is nothing to interpolate and no dependence on quad
// orientation — which is where a V-flip would otherwise creep in.
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uUv;
out vec4 outColor;
void main() { outColor = vec4(texture(uTex, uUv).rgb, 1.0); }`

// The whole frame, for `snapshot`. The fullscreen triangle's clip
// position maps straight onto texture UV, and the orientation is
// load-bearing: `vUv = p * 0.5 + 0.5` puts texture v == 0 (the image's
// TOP row) at clip y == -1, i.e. the framebuffer's BOTTOM. `readPixels`
// returns rows bottom-up, so row 0 of the returned buffer is the
// image's top row — the same image-space convention
// `latLonToTexelUv` uses. Flipping either the UV expression or the
// readback would mirror every statistic across the equator while
// leaving the globe looking perfectly normal.
const SNAPSHOT_VERT = `#version 300 es
in vec2 p;
out vec2 vUv;
void main() {
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`

const SNAPSHOT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = vec4(texture(uTex, vUv).r, 0.0, 0.0, 1.0); }`

/** A whole decoded frame's luma plane, row-major, `v == 0` first.
 *  The same image-space orientation `latLonToTexelUv` returns, so a
 *  texel index maps to a UV with no flip in between.
 *
 *  **Treat `data` as read-only.** The sampler caches and re-hands the
 *  same buffer for repeated reads of one frame; copying it per caller
 *  would defeat the cache it exists to provide. Every reducer in
 *  `datasetStats.ts` only reads. */
export interface LumaSnapshot {
  /** One byte per texel — `data[y * width + x]`. */
  data: Uint8Array
  width: number
  height: number
}

export interface GlLumaSampler {
  /** Luma 0-255 at `uv`, or null when there is nothing to read. */
  sample(source: ProbeSource, uv: TexelUv): number | null
  /**
   * The entire current frame's luma plane, or null when there is
   * nothing to read.
   *
   * **Never call this from a pointer handler.** `sample` exists
   * because a full-frame read per `mousemove` is not a slow path but a
   * broken one; this is the same read done once, deliberately, for a
   * user-initiated computation. At 4096×2048 it allocates ~8.4 MB and
   * costs a synchronous GPU stall. The result is cached against the
   * same frame key `sample` uses, so repeated statistics over a paused
   * frame pay for it once.
   */
  snapshot(source: ProbeSource): LumaSnapshot | null
  dispose(): void
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    logger.warn('[probe] shader compile failed:', gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/**
 * Build a sampler, or `null` if WebGL2 is unavailable.
 *
 * A null return is not a degraded readout, it is no readout — callers
 * drop the value line entirely. There is no 2D-canvas fallback on
 * purpose: it is the path this module exists to replace, and silently
 * falling back to it would reintroduce wrong numbers on the one
 * platform that motivated the change.
 */
export function createGlLumaSampler(): GlLumaSampler | null {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    // Read back in the same call as the draw; without this the
    // implicit swap can clear the buffer before readPixels runs.
    preserveDrawingBuffer: true,
  })
  if (!gl) {
    logger.warn('[probe] no webgl2 context; value readout unavailable')
    return null
  }

  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  const prog = vs && fs ? gl.createProgram() : null
  if (!vs || !fs || !prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    logger.warn('[probe] program link failed:', gl.getProgramInfoLog(prog))
    return null
  }
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  const uUv = gl.getUniformLocation(prog, 'uUv')
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  // NONE, not the default BROWSER_DEFAULT_WEBGL: the browser's own
  // colour conversion on upload is the class of transform that breaks
  // the 2D path, and the value must arrive as the encoder wrote it.
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  // flipY stays false so texture v == 0 is the image's top row, which
  // is the convention `latLonToTexelUv` returns.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  for (const [k, v] of [
    ['TEXTURE_MIN_FILTER', 'NEAREST'],
    ['TEXTURE_MAG_FILTER', 'NEAREST'],
    ['TEXTURE_WRAP_S', 'CLAMP_TO_EDGE'],
    ['TEXTURE_WRAP_T', 'CLAMP_TO_EDGE'],
  ] as const) {
    gl.texParameteri(gl.TEXTURE_2D, gl[k] as number, gl[v] as number)
  }
  gl.viewport(0, 0, 1, 1)

  const px = new Uint8Array(4)
  let uploadedKey = ''
  let lastSource: ProbeSource | null = null
  let disposed = false

  // Two programs share one quad buffer. The attribute location is
  // whatever each linker chose, so the pointer is re-established on
  // every program switch rather than assuming both landed on 0.
  let activeProgram: WebGLProgram | null = prog
  const bindQuad = (p: WebGLProgram, attrib: number): void => {
    if (activeProgram === p) return
    gl.useProgram(p)
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.enableVertexAttribArray(attrib)
    gl.vertexAttribPointer(attrib, 2, gl.FLOAT, false, 0, 0)
    activeProgram = p
  }

  const sourceSize = (source: ProbeSource): { width: number; height: number } =>
    source instanceof HTMLVideoElement
      ? { width: source.videoWidth, height: source.videoHeight }
      : source instanceof HTMLImageElement
        ? { width: source.naturalWidth, height: source.naturalHeight }
        : { width: source.width, height: source.height }

  /** The frame key `sample` and `snapshot` agree on. A video is keyed
   *  by playhead; anything else re-uploads or is fixed once decoded. */
  const frameKey = (source: ProbeSource): string =>
    source instanceof HTMLVideoElement ? `${source.currentTime}` : ''

  /**
   * Upload the source if the frame changed. Returns false when the
   * upload failed (a tainted cross-origin source) so callers bail
   * rather than reading whatever was in the texture before.
   *
   * Identity is checked first and separately, because the callers keep
   * one sampler for the life of the renderer and swap the source
   * underneath it on every dataset change. Two videos of the same size
   * both sitting at currentTime 0 — the normal state right after a
   * load — produce the same key, so a key-only check would skip the
   * upload and report the *previous* dataset's values against the new
   * dataset's globe. Silent, and exactly the failure this module exists
   * to prevent.
   */
  const ensureUploaded = (source: ProbeSource): boolean => {
    const changed =
      source !== lastSource ||
      // A canvas can be redrawn in place with no observable change to
      // identity or size, so it is never assumed current. An <img> is
      // fixed once decoded, so identity alone settles it.
      !(source instanceof HTMLVideoElement || source instanceof HTMLImageElement) ||
      (source instanceof HTMLVideoElement && frameKey(source) !== uploadedKey)
    if (!changed) return true
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    } catch {
      // A cross-origin source without CORS taints the upload. That is a
      // configuration problem, not a per-pixel one, but it must not take
      // the pointer handler down with it.
      uploadedKey = ''
      lastSource = null
      return false
    }
    lastSource = source
    uploadedKey = frameKey(source)
    // A new frame invalidates any snapshot taken from the old one.
    cached = null
    cachedKey = null
    return true
  }

  // --- snapshot state, built lazily -----------------------------------
  //
  // A page that never opens an analysis surface should not pay for a
  // second program or an 8 MB render target, so none of this is
  // allocated until the first `snapshot` call.

  let snapProg: WebGLProgram | null = null
  let snapVs: WebGLShader | null = null
  let snapFs: WebGLShader | null = null
  let snapAttrib = 0
  let fbo: WebGLFramebuffer | null = null
  let fboTex: WebGLTexture | null = null
  let fboWidth = 0
  let fboHeight = 0
  /** True when the attachment is R8 and `readPixels` will accept
   *  RED/UNSIGNED_BYTE — one byte per texel instead of four. */
  let fboSingleChannel = false
  let snapshotUnavailable = false
  let cached: LumaSnapshot | null = null
  let cachedKey: string | null = null

  const buildSnapshotProgram = (): boolean => {
    if (snapProg) return true
    snapVs = compile(gl, gl.VERTEX_SHADER, SNAPSHOT_VERT)
    snapFs = compile(gl, gl.FRAGMENT_SHADER, SNAPSHOT_FRAG)
    const p = snapVs && snapFs ? gl.createProgram() : null
    if (!snapVs || !snapFs || !p) return false
    gl.attachShader(p, snapVs)
    gl.attachShader(p, snapFs)
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      logger.warn('[probe] snapshot program link failed:', gl.getProgramInfoLog(p))
      return false
    }
    snapProg = p
    snapAttrib = gl.getAttribLocation(p, 'p')
    return true
  }

  /**
   * Size the render target, preferring a single-channel attachment.
   *
   * R8 is colour-renderable in core WebGL2, but `readPixels` only
   * guarantees the format the driver advertises through
   * `IMPLEMENTATION_COLOR_READ_FORMAT`. So the R8 path is *asked for*,
   * then verified against what the driver will actually hand back, and
   * an RGBA8 attachment is used when the answer is anything else. That
   * costs 4× the readback and a compaction pass — worth having as a
   * real fallback rather than a theoretical one, because the failure
   * mode of guessing wrong is an INVALID_OPERATION on every snapshot.
   */
  const ensureTarget = (width: number, height: number): boolean => {
    if (fbo && fboWidth === width && fboHeight === height) return true
    if (fboTex) gl.deleteTexture(fboTex)
    if (!fbo) fbo = gl.createFramebuffer()
    if (!fbo) return false

    const attach = (internal: number, format: number): boolean => {
      fboTex = gl.createTexture()
      if (!fboTex) return false
      gl.bindTexture(gl.TEXTURE_2D, fboTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0)
      return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    }

    fboSingleChannel = false
    if (attach(gl.R8, gl.RED)) {
      const f = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number
      const t = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number
      fboSingleChannel = f === gl.RED && t === gl.UNSIGNED_BYTE
    }
    if (!fboSingleChannel) {
      if (fboTex) gl.deleteTexture(fboTex)
      if (!attach(gl.RGBA8, gl.RGBA)) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        logger.warn('[probe] no readable render target; snapshot unavailable')
        return false
      }
    }
    fboWidth = width
    fboHeight = height
    return true
  }

  return {
    sample(source: ProbeSource, uv: TexelUv): number | null {
      if (disposed) return null
      if (!sourceSize(source).width) return null
      if (!ensureUploaded(source)) return null
      try {
        bindQuad(prog, loc)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, 1, 1)
        // Explicit rather than inherited: `snapshot` binds a render
        // target to the same unit, and a pointer read that silently
        // sampled it would return the previous frame with no symptom.
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.uniform2f(uUv, uv.u, uv.v)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      } catch {
        uploadedKey = ''
        lastSource = null
        return null
      }
      return px[0]
    },

    snapshot(source: ProbeSource): LumaSnapshot | null {
      if (disposed || snapshotUnavailable) return null
      const { width, height } = sourceSize(source)
      if (!width || !height) return null

      // Served before the upload check so a paused frame under repeated
      // statistics pays the readback once. `ensureUploaded` clears this
      // whenever the frame moves.
      const key = `${width}x${height}@${frameKey(source)}`
      if (cached && cachedKey === key && lastSource === source) return cached

      if (!ensureUploaded(source)) return null
      if (!buildSnapshotProgram() || !ensureTarget(width, height)) {
        snapshotUnavailable = true
        return null
      }

      let data: Uint8Array
      try {
        bindQuad(snapProg!, snapAttrib)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.viewport(0, 0, width, height)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        // Rows are not guaranteed to be a multiple of four bytes wide
        // on the single-channel path, so alignment cannot be left at
        // its default.
        gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
        if (fboSingleChannel) {
          data = new Uint8Array(width * height)
          gl.readPixels(0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, data)
        } else {
          const rgba = new Uint8Array(width * height * 4)
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
          data = new Uint8Array(width * height)
          for (let i = 0, n = width * height; i < n; i++) data[i] = rgba[i * 4]
        }
      } catch {
        uploadedKey = ''
        lastSource = null
        return null
      } finally {
        // Whatever happened, the next `sample` must find the default
        // framebuffer and its 1×1 viewport. Leaving the FBO bound here
        // would send every subsequent pointer read into the snapshot
        // target and return stale bytes.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, 1, 1)
      }

      cached = { data, width, height }
      cachedKey = key
      return cached
    },

    dispose() {
      disposed = true
      lastSource = null
      cached = null
      cachedKey = null
      gl.deleteTexture(tex)
      gl.deleteBuffer(buf)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      if (fboTex) gl.deleteTexture(fboTex)
      if (fbo) gl.deleteFramebuffer(fbo)
      if (snapProg) gl.deleteProgram(snapProg)
      if (snapVs) gl.deleteShader(snapVs)
      if (snapFs) gl.deleteShader(snapFs)
    },
  }
}

// --- shared instance -------------------------------------------------

/**
 * One sampler for the whole page.
 *
 * Each instance owns a WebGL2 context, and `ViewportManager` runs up to
 * four `MapRenderer`s at once. One sampler apiece meant a 4-globe
 * layout held eight contexts — four MapLibre plus four probes — before
 * VR adds its own. Browsers cap contexts per page (Chrome around 16)
 * and do not politely refuse past the limit: they drop the oldest live
 * context, which would blank a globe rather than the probe that caused
 * it.
 *
 * Sharing is safe because the sampler holds no per-caller state beyond
 * its texture cache, and that cache is keyed on source identity — so
 * two panels alternating simply re-upload, which is the correct result
 * and irrelevant at pointer speed.
 *
 * Deliberately never disposed in normal operation: it is one context
 * for the lifetime of the page, which is the point. `dispose` exists
 * for tests and teardown.
 */
let shared: GlLumaSampler | null | undefined

export function getSharedLumaSampler(): GlLumaSampler | null {
  if (shared === undefined) shared = createGlLumaSampler()
  return shared
}

/** Drop the shared sampler. For tests and teardown, not for renderers —
 *  a renderer disposing it would pull the context out from under every
 *  other panel still using it. */
export function disposeSharedLumaSampler(): void {
  shared?.dispose()
  shared = undefined
}
