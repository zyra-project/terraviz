// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Guards for the GL probe's upload configuration.
 *
 * These flags look like boilerplate and are not. The probe exists
 * because iOS Safari applies a colour transform when a video reaches a
 * 2D canvas; leaving `UNPACK_COLORSPACE_CONVERSION_WEBGL` at its
 * `BROWSER_DEFAULT_WEBGL` default invites the same class of transform
 * on the GL path, and the symptom would be identical — a globe that
 * looks correct and a number under the cursor that is quietly wrong.
 *
 * A real WebGL2 context is not available under happy-dom, so this
 * stubs one and asserts the calls. That is enough to catch the failure
 * this is written for: someone tidying away lines that look redundant.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createGlLumaSampler,
  disposeSharedLumaSampler,
  getSharedLumaSampler,
} from './glLumaSampler'

interface Recorded {
  pixelStorei: [number, unknown][]
  texParameteri: [number, number][]
  uniforms: [number, number][]
  readPixelsCalls: number
  uploads: number
  throwOnNextUpload: boolean
  /** Every `readPixels` format, so the R8-preferred / RGBA-fallback
   *  choice can be asserted rather than assumed. */
  readFormats: number[]
  /** Framebuffer bindings in order; `null` is the default target. */
  fbBindings: (object | null)[]
  /** Viewport sizes in order, so a snapshot leaving the full-frame
   *  viewport behind is visible to a test. */
  viewports: [number, number][]
  /** Colour-attachment internal formats requested, in order. */
  attachments: number[]
}

const K = {
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 37443,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441,
  UNPACK_FLIP_Y_WEBGL: 37440,
  NONE: 0,
  NEAREST: 9728,
  CLAMP_TO_EDGE: 33071,
  TEXTURE_MIN_FILTER: 10241,
  TEXTURE_MAG_FILTER: 10240,
  TEXTURE_WRAP_S: 10242,
  TEXTURE_WRAP_T: 10243,
}

/** `readable` controls what the fake driver claims `readPixels` will
 *  accept, so both the single-channel path and the RGBA fallback can be
 *  exercised. */
function stubGl(luma = 200, readable: 'red' | 'rgba' = 'red') {
  const rec: Recorded = {
    pixelStorei: [], texParameteri: [], uniforms: [], readPixelsCalls: 0, uploads: 0,
    throwOnNextUpload: false,
    readFormats: [], fbBindings: [], viewports: [], attachments: [],
  }
  const gl = {
    ...K,
    TEXTURE_2D: 3553, RGBA: 6408, UNSIGNED_BYTE: 5121, ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044, FLOAT: 5126, TRIANGLES: 4,
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713, LINK_STATUS: 35714,
    FRAMEBUFFER: 36160, COLOR_ATTACHMENT0: 36064, FRAMEBUFFER_COMPLETE: 36053,
    R8: 33321, RED: 6403, RGBA8: 32856, PACK_ALIGNMENT: 3333,
    IMPLEMENTATION_COLOR_READ_FORMAT: 35738, IMPLEMENTATION_COLOR_READ_TYPE: 35739,
    createShader: () => ({}), shaderSource: () => {}, compileShader: () => {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader: () => {},
    createProgram: () => ({}), attachShader: () => {}, linkProgram: () => {},
    getProgramParameter: () => true, getProgramInfoLog: () => '', useProgram: () => {},
    createBuffer: () => ({}), bindBuffer: () => {}, bufferData: () => {},
    getAttribLocation: () => 0, enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    getUniformLocation: () => ({}),
    createTexture: () => ({}), bindTexture: () => {},
    pixelStorei: (k: number, v: unknown) => rec.pixelStorei.push([k, v]),
    texParameteri: (_t: number, k: number, v: number) => rec.texParameteri.push([k, v]),
    texImage2D: () => {
      if (rec.throwOnNextUpload) throw new DOMException('tainted', 'SecurityError')
      rec.uploads++
    },
    uniform2f: (_l: unknown, u: number, v: number) => rec.uniforms.push([u, v]),
    viewport: (_x: number, _y: number, w: number, h: number) => rec.viewports.push([w, h]),
    drawArrays: () => {},
    readPixels: (_x: number, _y: number, w: number, h: number, f: number, _t: number, out: Uint8Array) => {
      rec.readPixelsCalls++
      rec.readFormats.push(f)
      // Fill as the real driver would for the format asked for, so a
      // channel-stride mistake in the RGBA fallback shows up as wrong
      // values rather than as zeros nobody checks.
      if (f === 6403) for (let i = 0; i < w * h; i++) out[i] = luma
      else for (let i = 0; i < w * h; i++) { out[i * 4] = luma; out[i * 4 + 3] = 255 }
    },
    createFramebuffer: () => ({}),
    bindFramebuffer: (_t: number, fb: object | null) => rec.fbBindings.push(fb),
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => 36053,
    getParameter: (p: number) => {
      if (p === 35738) return readable === 'red' ? 6403 : 6408
      if (p === 35739) return 5121
      return 0
    },
    texStorage2D: () => {},
    deleteTexture: () => {}, deleteBuffer: () => {}, deleteProgram: () => {},
    deleteFramebuffer: () => {},
  }
  // texImage2D doubles as the render-target allocator; record the
  // internal format when it is called with dimensions rather than a
  // source element.
  const rawTexImage2D = gl.texImage2D
  gl.texImage2D = ((...args: unknown[]) => {
    if (args.length > 6) { rec.attachments.push(args[2] as number); return }
    return (rawTexImage2D as () => void)()
  }) as typeof gl.texImage2D
  // The real factory is captured *before* the spy replaces it. Calling
  // `document.createElement` from inside the mock would re-enter the
  // spy and recurse until the stack gives out — latent here only
  // because these tests happen to ask for canvases, and a trap for the
  // next test that asks for anything else.
  const realCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return realCreateElement(tag)
    return { width: 0, height: 0, getContext: () => gl } as unknown as HTMLCanvasElement
  }) as typeof document.createElement)
  return rec
}

const video = (w = 4096, h = 2048) =>
  Object.assign(Object.create(HTMLVideoElement.prototype) as HTMLVideoElement, {
    videoWidth: w, videoHeight: h, currentTime: 0,
  })

describe('createGlLumaSampler', () => {
  it('disables the browser colour conversion on upload', () => {
    const rec = stubGl()
    createGlLumaSampler()
    const conv = rec.pixelStorei.find(([k]) => k === K.UNPACK_COLORSPACE_CONVERSION_WEBGL)
    expect(conv, 'UNPACK_COLORSPACE_CONVERSION_WEBGL must be set').toBeDefined()
    // NONE, not BROWSER_DEFAULT_WEBGL — the whole point of the module.
    expect(conv?.[1]).toBe(K.NONE)
    vi.restoreAllMocks()
  })

  it('uploads unpremultiplied and unflipped', () => {
    const rec = stubGl()
    createGlLumaSampler()
    // Premultiplying scales the value by its own alpha. Flipping Y
    // mirrors the data across the equator — the bug that has shipped
    // twice here.
    expect(rec.pixelStorei).toContainEqual([K.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false])
    expect(rec.pixelStorei).toContainEqual([K.UNPACK_FLIP_Y_WEBGL, false])
    vi.restoreAllMocks()
  })

  it('filters NEAREST so no neighbouring texel is blended in', () => {
    const rec = stubGl()
    createGlLumaSampler()
    expect(rec.texParameteri).toContainEqual([K.TEXTURE_MIN_FILTER, K.NEAREST])
    expect(rec.texParameteri).toContainEqual([K.TEXTURE_MAG_FILTER, K.NEAREST])
    expect(rec.texParameteri).toContainEqual([K.TEXTURE_WRAP_S, K.CLAMP_TO_EDGE])
    expect(rec.texParameteri).toContainEqual([K.TEXTURE_WRAP_T, K.CLAMP_TO_EDGE])
    vi.restoreAllMocks()
  })

  it('samples the requested UV and returns the red channel', () => {
    const rec = stubGl(137)
    const s = createGlLumaSampler()!
    expect(s.sample(video(), { u: 0.25, v: 0.75 })).toBe(137)
    expect(rec.uniforms.at(-1)).toEqual([0.25, 0.75])
    expect(rec.readPixelsCalls).toBe(1)
    vi.restoreAllMocks()
  })

  it('re-uploads only when the frame changed', () => {
    const rec = stubGl()
    const s = createGlLumaSampler()!
    const v = video()
    s.sample(v, { u: 0.1, v: 0.1 })
    s.sample(v, { u: 0.9, v: 0.9 })
    // A pointer stream over a paused video must not re-upload a 4096x2048
    // frame per event.
    expect(rec.uploads).toBe(1)
    v.currentTime = 1.5
    s.sample(v, { u: 0.5, v: 0.5 })
    expect(rec.uploads).toBe(2)
    vi.restoreAllMocks()
  })

  it('re-uploads when the source is swapped, even at an identical frame key', () => {
    const rec = stubGl()
    const s = createGlLumaSampler()!
    // Two datasets of the same size, both at currentTime 0 — the normal
    // state right after a load. A key-only cache reports the previous
    // dataset's values against the new dataset's globe, silently.
    const a = video()
    const b = video()
    s.sample(a, { u: 0.5, v: 0.5 })
    s.sample(b, { u: 0.5, v: 0.5 })
    expect(rec.uploads).toBe(2)
    vi.restoreAllMocks()
  })

  it('never assumes a canvas is current, since it can be redrawn in place', () => {
    const rec = stubGl()
    const s = createGlLumaSampler()!
    const c = { width: 64, height: 32 } as unknown as HTMLCanvasElement
    s.sample(c, { u: 0.5, v: 0.5 })
    s.sample(c, { u: 0.5, v: 0.5 })
    // Same object, same size, but the pixels may have changed underneath.
    expect(rec.uploads).toBe(2)
    vi.restoreAllMocks()
  })

  it('forgets the cached source when an upload throws', () => {
    const rec = stubGl()
    const s = createGlLumaSampler()!
    const v = video()
    s.sample(v, { u: 0.5, v: 0.5 })
    expect(rec.uploads).toBe(1)
    // Advance the frame so an upload is genuinely attempted, then make
    // it throw. A tainted upload must not leave the sampler believing
    // the texture holds this frame.
    v.currentTime = 1.5
    rec.throwOnNextUpload = true
    expect(s.sample(v, { u: 0.5, v: 0.5 })).toBeNull()
    // Same source, same currentTime — but the cache was invalidated, so
    // this must re-attempt rather than sample a texture holding the
    // previous frame.
    rec.throwOnNextUpload = false
    s.sample(v, { u: 0.5, v: 0.5 })
    expect(rec.uploads).toBe(2)
    vi.restoreAllMocks()
  })

  it('returns null before a frame has decoded', () => {
    stubGl()
    const s = createGlLumaSampler()!
    expect(s.sample(video(0, 0), { u: 0.5, v: 0.5 })).toBeNull()
    vi.restoreAllMocks()
  })

  it('returns null after dispose rather than touching a freed context', () => {
    stubGl()
    const s = createGlLumaSampler()!
    s.dispose()
    expect(s.sample(video(), { u: 0.5, v: 0.5 })).toBeNull()
    vi.restoreAllMocks()
  })

  it('returns null when WebGL2 is unavailable, rather than falling back to 2D', () => {
    const realCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return realCreateElement(tag)
      return { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement
    }) as typeof document.createElement)
    // A 2D fallback is the path this module replaces; reintroducing one
    // would put wrong numbers back on iOS.
    expect(createGlLumaSampler()).toBeNull()
    vi.restoreAllMocks()
  })
})

describe('getSharedLumaSampler', () => {
  it('hands every caller the same instance', () => {
    stubGl()
    disposeSharedLumaSampler()
    const a = getSharedLumaSampler()
    const b = getSharedLumaSampler()
    // One WebGL2 context for the page. Four MapRenderers in a 4-globe
    // layout previously meant four probe contexts on top of MapLibre's
    // four, and browsers drop the oldest live context past their limit
    // rather than refusing the new one — so the cost of getting this
    // wrong is a blanked globe, not a dead probe.
    expect(a).toBe(b)
    disposeSharedLumaSampler()
    vi.restoreAllMocks()
  })

  it('builds a fresh one after the shared instance is disposed', () => {
    stubGl()
    disposeSharedLumaSampler()
    const first = getSharedLumaSampler()
    disposeSharedLumaSampler()
    const second = getSharedLumaSampler()
    expect(second).not.toBe(first)
    disposeSharedLumaSampler()
    vi.restoreAllMocks()
  })

  it('still samples correctly through the shared instance', () => {
    stubGl(88)
    disposeSharedLumaSampler()
    const s = getSharedLumaSampler()!
    expect(s.sample(video(), { u: 0.5, v: 0.5 })).toBe(88)
    disposeSharedLumaSampler()
    vi.restoreAllMocks()
  })
})

describe('snapshot', () => {
  it('reads the whole frame into one byte per texel', () => {
    const rec = stubGl(191)
    const s = createGlLumaSampler()!
    const snap = s.snapshot(video(8, 4))!
    expect(snap.width).toBe(8)
    expect(snap.height).toBe(4)
    expect(snap.data).toHaveLength(32)
    expect([...snap.data].every((v) => v === 191)).toBe(true)
    expect(rec.readFormats.at(-1)).toBe(6403) // RED, the single-channel path
    vi.restoreAllMocks()
  })

  it('prefers an R8 attachment when the driver will read it back', () => {
    const rec = stubGl(100, 'red')
    createGlLumaSampler()!.snapshot(video(4, 2))
    expect(rec.attachments).toContain(33321) // R8
    expect(rec.attachments).not.toContain(32856) // never fell back
    vi.restoreAllMocks()
  })

  it('falls back to RGBA when the driver will not read RED back', () => {
    // The fallback has to be real: guessing R8 and being wrong is an
    // INVALID_OPERATION on every snapshot, not a slow path.
    const rec = stubGl(77, 'rgba')
    const s = createGlLumaSampler()!
    const snap = s.snapshot(video(4, 2))!
    expect(rec.attachments).toContain(32856) // RGBA8
    expect(rec.readFormats.at(-1)).toBe(6408)
    // The compaction must take the red channel, not every fourth byte
    // starting somewhere else.
    expect([...snap.data]).toEqual(Array(8).fill(77))
    vi.restoreAllMocks()
  })

  it('caches within a frame and re-reads when the playhead moves', () => {
    const rec = stubGl()
    const s = createGlLumaSampler()!
    const v = video(4, 2)
    const first = s.snapshot(v)
    const second = s.snapshot(v)
    expect(second).toBe(first) // same object, no second readback
    expect(rec.readPixelsCalls).toBe(1)

    v.currentTime = 2.5
    const third = s.snapshot(v)
    expect(third).not.toBe(first)
    expect(rec.readPixelsCalls).toBe(2)
    vi.restoreAllMocks()
  })

  it('restores the default framebuffer and the 1x1 viewport', () => {
    // Otherwise the next pointer read lands in the snapshot target and
    // silently reports the analysed frame instead of the playing one.
    const rec = stubGl()
    const s = createGlLumaSampler()!
    s.snapshot(video(4, 2))
    expect(rec.fbBindings.at(-1)).toBeNull()
    expect(rec.viewports.at(-1)).toEqual([1, 1])
    vi.restoreAllMocks()
  })

  it('leaves the pointer read correct after a snapshot', () => {
    const rec = stubGl(64)
    const s = createGlLumaSampler()!
    const v = video(4, 2)
    s.snapshot(v)
    expect(s.sample(v, { u: 0.5, v: 0.5 })).toBe(64)
    expect(rec.viewports.at(-1)).toEqual([1, 1])
    vi.restoreAllMocks()
  })

  it('returns null before a frame has decoded', () => {
    stubGl()
    const s = createGlLumaSampler()!
    expect(s.snapshot(video(0, 0))).toBeNull()
    vi.restoreAllMocks()
  })

  it('returns null after dispose rather than touching a freed context', () => {
    stubGl()
    const s = createGlLumaSampler()!
    s.dispose()
    expect(s.snapshot(video(4, 2))).toBeNull()
    vi.restoreAllMocks()
  })

  it('does not build a render target until it is asked for one', () => {
    // A page that never opens an analysis surface should not pay for a
    // second program or an 8 MB target.
    const rec = stubGl()
    const s = createGlLumaSampler()!
    s.sample(video(4, 2), { u: 0.5, v: 0.5 })
    expect(rec.attachments).toHaveLength(0)
    s.snapshot(video(4, 2))
    expect(rec.attachments.length).toBeGreaterThan(0)
    vi.restoreAllMocks()
  })
})
