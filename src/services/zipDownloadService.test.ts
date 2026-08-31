// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for zipDownloadService — §8.2 web-only zip downloader.
 *
 * Covers buildZip, estimateZipSize, listDownloadableAssets, plus the
 * pure helpers (manifest notes, filename sanitization). The fetch
 * surface is mocked end-to-end; no real network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'
import {
  ZIP_HARD_CAP_BYTES,
  ZIP_WARNING_BYTES,
  buildZip,
  estimateZipSize,
  listDownloadableAssets,
  saveBlobAsDownload,
  __test__,
} from './zipDownloadService'
import type { Dataset } from '../types'
import type { ResolvedAsset } from './downloadService'

const { buildManifestNotes, sanitizeFilenameStem } = __test__

function makeAsset(overrides: Partial<ResolvedAsset> = {}): ResolvedAsset {
  return {
    kind: 'primary',
    url: 'https://r2.terraviz.zyra-project.org/datasets/DS01/source.mp4',
    filename: 'video.mp4',
    sizeBytes: 1024,
    sourceOfTruth: 'publisher',
    ...overrides,
  }
}

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'DS01',
    title: 'Demo Dataset',
    format: 'video/mp4',
    dataLink: '/api/v1/datasets/DS01/manifest',
    ...overrides,
  } as Dataset
}

function mockFetchOk(body: ArrayBuffer | string, headers: Record<string, string> = {}): typeof globalThis.fetch {
  return vi.fn(async () => {
    const buf =
      typeof body === 'string'
        ? new TextEncoder().encode(body).buffer
        : body
    return new Response(buf, { status: 200, headers })
  }) as unknown as typeof globalThis.fetch
}

function mockFetchSequence(responses: Response[]): typeof globalThis.fetch {
  let i = 0
  return vi.fn(async () => {
    const res = responses[i++]
    if (!res) throw new Error('mock fetch out of responses')
    return res
  }) as unknown as typeof globalThis.fetch
}

describe('sanitizeFilenameStem', () => {
  it('preserves ULID-shaped ids verbatim', () => {
    expect(sanitizeFilenameStem('DS01HXAAAAAAAAAAAAAAAAAAAA')).toBe('DS01HXAAAAAAAAAAAAAAAAAAAA')
  })

  it('preserves legacy INTERNAL_SOS_* ids verbatim', () => {
    expect(sanitizeFilenameStem('INTERNAL_SOS_768')).toBe('INTERNAL_SOS_768')
  })

  it('replaces path separators and unsafe chars with underscore', () => {
    expect(sanitizeFilenameStem('foo/bar baz?')).toBe('foo_bar_baz_')
  })

  it('clamps to 64 chars', () => {
    const long = 'a'.repeat(100)
    expect(sanitizeFilenameStem(long).length).toBe(64)
  })

  it('falls back to "dataset" when the stem sanitizes to empty', () => {
    expect(sanitizeFilenameStem('!!!!')).toBe('dataset')
  })
})

describe('buildManifestNotes', () => {
  it('labels a publisher-source primary explicitly', () => {
    const notes = buildManifestNotes(
      [{ kind: 'primary', filename: 'v.mp4', url: 'x', sourceOfTruth: 'publisher' }],
      makeDataset(),
    )
    expect(notes[0]).toMatch(/canonical upload/i)
  })

  it('labels a Vimeo-proxy primary as a transcode', () => {
    const notes = buildManifestNotes(
      [{ kind: 'primary', filename: 'v.mp4', url: 'x', sourceOfTruth: 'vimeo' }],
      makeDataset(),
    )
    expect(notes[0]).toMatch(/best-quality MP4 from the Vimeo proxy/)
    expect(notes[0]).toMatch(/not the original source/i)
  })

  it('mentions sos.noaa.gov for legacy assets', () => {
    const notes = buildManifestNotes(
      [{ kind: 'primary', filename: 'v.jpg', url: 'x', sourceOfTruth: 'sos' }],
      makeDataset(),
    )
    expect(notes[0]).toMatch(/legacy SOS/i)
  })

  it('appends a frames-count note when frame entries are present', () => {
    const notes = buildManifestNotes(
      [
        { kind: 'primary', filename: 'v.mp4', url: 'x', sourceOfTruth: 'publisher' },
        { kind: 'frame', filename: 'frames/00000.png', url: 'x', sourceOfTruth: 'publisher' },
        { kind: 'frame', filename: 'frames/00001.png', url: 'x', sourceOfTruth: 'publisher' },
      ],
      makeDataset({ frames: { count: 2, urlTemplate: 'x', framesDigest: 'abc' } }),
    )
    expect(notes.some(n => /2 source frames/.test(n))).toBe(true)
    expect(notes.some(n => /framesDigest/.test(n))).toBe(true)
  })
})

describe('estimateZipSize', () => {
  it('sums the known sizeBytes without fetching when every asset is pre-sized', async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch
    const result = await estimateZipSize(
      [
        makeAsset({ sizeBytes: 100 }),
        makeAsset({ kind: 'legend', filename: 'legend.png', sizeBytes: 50 }),
      ],
      { fetchImpl },
    )
    expect(result.bytes).toBe(150)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('HEADs assets that have no known size', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200, headers: { 'content-length': '7000' } }),
    ) as unknown as typeof globalThis.fetch
    const result = await estimateZipSize(
      [makeAsset({ sizeBytes: undefined, kind: 'thumbnail', filename: 'thumb.jpg' })],
      { fetchImpl },
    )
    expect(result.bytes).toBe(7000)
    expect((fetchImpl as any).mock.calls[0][1].method).toBe('HEAD')
  })

  it('returns 0 for assets whose HEAD fails or returns no content-length', async () => {
    // Both the HEAD and the Range-GET fallback need to fail (no
    // Content-Length, no Content-Range) for the size to land at 0.
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200 }),
    ) as unknown as typeof globalThis.fetch
    const result = await estimateZipSize(
      [makeAsset({ sizeBytes: undefined })],
      { fetchImpl },
    )
    expect(result.bytes).toBe(0)
  })

  it('falls back to a Range-GET when HEAD returns no Content-Length', async () => {
    // Mirrors Cloudflare Images' /cdn-cgi/image/ behaviour: HEAD
    // returns 200 OK without Content-Length (the resized image
    // isn't generated for HEAD), so the probe falls through to a
    // `Range: bytes=0-0` GET and reads the size from Content-Range.
    let call = 0
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      call++
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200 })
      }
      // The Range-GET. Server responds 206 with Content-Range.
      const range = (init?.headers as Record<string, string> | undefined)?.Range
      expect(range).toBe('bytes=0-0')
      return new Response(new ArrayBuffer(1), {
        status: 206,
        headers: { 'content-range': 'bytes 0-0/12345' },
      })
    }) as unknown as typeof globalThis.fetch
    const result = await estimateZipSize(
      [makeAsset({ sizeBytes: undefined })],
      { fetchImpl },
    )
    expect(call).toBe(2)
    expect(result.bytes).toBe(12345)
  })

  it('also falls back to Range-GET when HEAD itself rejects with an error', async () => {
    // Some origins reject HEAD method outright (405 Method Not
    // Allowed, or a CORS-driven TypeError). The Range-GET path
    // still kicks in.
    let saw: 'HEAD' | 'GET' | null = null
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        throw new TypeError('CORS preflight failed')
      }
      saw = 'GET'
      return new Response(new ArrayBuffer(1), {
        status: 206,
        headers: { 'content-range': 'bytes 0-0/9000' },
      })
    }) as unknown as typeof globalThis.fetch
    const result = await estimateZipSize(
      [makeAsset({ sizeBytes: undefined })],
      { fetchImpl },
    )
    expect(saw).toBe('GET')
    expect(result.bytes).toBe(9000)
  })

  it('trusts Content-Length on a 200 OK fallback (server ignored the Range header)', async () => {
    // Small files where the server returns the whole body even on
    // a Range request: Content-Length is the actual file size.
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 })
      return new Response(new ArrayBuffer(800), {
        status: 200,
        headers: { 'content-length': '800' },
      })
    }) as unknown as typeof globalThis.fetch
    const result = await estimateZipSize(
      [makeAsset({ sizeBytes: undefined })],
      { fetchImpl },
    )
    expect(result.bytes).toBe(800)
  })

  it('samples frame sizes above the threshold rather than HEADing every one', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200, headers: { 'content-length': '2000' } }),
    ) as unknown as typeof globalThis.fetch
    const N = 1000
    const frames: ResolvedAsset[] = Array.from({ length: N }, (_, i) => ({
      kind: 'frame',
      url: `https://r2.example/frame_${i}.png`,
      filename: `frames/frame_${i}.png`,
      sourceOfTruth: 'publisher',
    }))
    const result = await estimateZipSize(frames, { fetchImpl })
    // Should HEAD at most __test__.FRAME_SAMPLE_SIZE frames, not N.
    expect((fetchImpl as any).mock.calls.length).toBeLessThanOrEqual(__test__.FRAME_SAMPLE_SIZE)
    expect(result.sampled).toBe(true)
    expect(result.bytes).toBe(2000 * N) // avg 2000 × N
  })

  it('HEADs every frame when the count is below the sample threshold', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 200, headers: { 'content-length': '1000' } }),
    ) as unknown as typeof globalThis.fetch
    const N = 4
    const frames: ResolvedAsset[] = Array.from({ length: N }, (_, i) => ({
      kind: 'frame',
      url: `https://r2.example/frame_${i}.png`,
      filename: `frames/frame_${i}.png`,
      sourceOfTruth: 'publisher',
    }))
    const result = await estimateZipSize(frames, { fetchImpl })
    expect((fetchImpl as any).mock.calls.length).toBe(N)
    expect(result.sampled).toBe(false)
    expect(result.bytes).toBe(1000 * N)
  })
})

describe('buildZip — happy path', () => {
  it('packages every selected asset and a manifest.json into the archive', async () => {
    const body1 = new TextEncoder().encode('PRIMARY DATA').buffer
    const body2 = new TextEncoder().encode('LEGEND').buffer
    const fetchImpl = mockFetchSequence([
      new Response(body1, { status: 200 }),
      new Response(body2, { status: 200 }),
    ])
    const result = await buildZip(
      makeDataset(),
      [
        makeAsset({ kind: 'primary', filename: 'video.mp4', sourceOfTruth: 'publisher' }),
        makeAsset({ kind: 'legend', filename: 'legend.png', sourceOfTruth: 'publisher' }),
      ],
      { fetchImpl },
    )
    expect(result.filename).toBe('DS01.zip')
    expect(result.failures).toHaveLength(0)
    expect(result.bytesWritten).toBe(body1.byteLength + body2.byteLength)

    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual(['legend.png', 'manifest.json', 'video.mp4'])

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest.datasetId).toBe('DS01')
    expect(manifest.assets).toHaveLength(2)
    expect(manifest.assets[0].bytes).toBe(body1.byteLength)
    expect(manifest.notes[0]).toMatch(/canonical upload/i)
  })

  it('respects the selectedKinds filter', async () => {
    const body = new TextEncoder().encode('PRIMARY').buffer
    const fetchImpl = mockFetchSequence([new Response(body, { status: 200 })])
    const result = await buildZip(
      makeDataset(),
      [
        makeAsset({ kind: 'primary', filename: 'video.mp4' }),
        makeAsset({ kind: 'legend', filename: 'legend.png' }),
        makeAsset({ kind: 'thumbnail', filename: 'thumbnail.jpg' }),
      ],
      { fetchImpl, selectedKinds: new Set(['primary']) },
    )
    expect((fetchImpl as any).mock.calls.length).toBe(1)
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual(['manifest.json', 'video.mp4'])
  })

  it('records source-of-truth on every asset in the manifest', async () => {
    const fetchImpl = mockFetchSequence([
      new Response(new ArrayBuffer(4), { status: 200 }),
      new Response(new ArrayBuffer(4), { status: 200 }),
    ])
    const result = await buildZip(
      makeDataset(),
      [
        makeAsset({ kind: 'primary', filename: 'video.mp4', sourceOfTruth: 'vimeo' }),
        makeAsset({ kind: 'legend', filename: 'legend.png', sourceOfTruth: 'publisher' }),
      ],
      { fetchImpl },
    )
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest.assets[0].sourceOfTruth).toBe('vimeo')
    expect(manifest.assets[1].sourceOfTruth).toBe('publisher')
  })

  it('fires onProgress at least at fetching and packaging phases', async () => {
    const fetchImpl = mockFetchSequence([new Response(new ArrayBuffer(4), { status: 200 })])
    const phases: string[] = []
    await buildZip(
      makeDataset(),
      [makeAsset()],
      { fetchImpl, onProgress: (p) => phases.push(p.phase) },
    )
    expect(phases).toContain('fetching')
    expect(phases).toContain('packaging')
    expect(phases[phases.length - 1]).toBe('done')
  })
})

describe('buildZip — error tolerance', () => {
  it('skips a non-primary asset that 404s, recording the failure in the manifest', async () => {
    const fetchImpl = mockFetchSequence([
      new Response(new ArrayBuffer(8), { status: 200 }),
      new Response(null, { status: 404, statusText: 'Not Found' }),
    ])
    const result = await buildZip(
      makeDataset(),
      [
        makeAsset({ kind: 'primary', filename: 'video.mp4' }),
        makeAsset({ kind: 'legend', filename: 'legend.png' }),
      ],
      { fetchImpl },
    )
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].filename).toBe('legend.png')
    expect(result.failures[0].reason).toMatch(/404/)
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    // legend.png is omitted; manifest still records it with `error`.
    expect(zip.files['legend.png']).toBeUndefined()
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    const legendEntry = manifest.assets.find((a: any) => a.filename === 'legend.png')
    expect(legendEntry?.error).toMatch(/404/)
  })

  it('throws when the primary asset fails — a manifest-only zip would mislead the user', async () => {
    const fetchImpl = mockFetchSequence([
      new Response(null, { status: 500, statusText: 'Server Error' }),
    ])
    await expect(
      buildZip(makeDataset(), [makeAsset({ kind: 'primary', filename: 'video.mp4' })], { fetchImpl }),
    ).rejects.toThrow(/primary asset/)
  })

  it('treats a thrown network error on a non-primary asset as a recorded failure, not a crash', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(new ArrayBuffer(8), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('NetworkError when attempting to fetch resource.')) as unknown as typeof globalThis.fetch
    const result = await buildZip(
      makeDataset(),
      [
        makeAsset({ kind: 'primary', filename: 'video.mp4' }),
        makeAsset({ kind: 'caption', filename: 'captions.srt' }),
      ],
      { fetchImpl },
    )
    expect(result.failures[0].filename).toBe('captions.srt')
    expect(result.failures[0].reason).toMatch(/NetworkError/)
  })
})

describe('buildZip — cancel via AbortController', () => {
  it('throws AbortError when the signal is aborted before the first fetch', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const fetchImpl = mockFetchSequence([new Response(new ArrayBuffer(4), { status: 200 })])
    await expect(
      buildZip(makeDataset(), [makeAsset()], { fetchImpl, signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('propagates an AbortError raised by an in-flight fetch', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new DOMException('aborted', 'AbortError')
      throw err
    }) as unknown as typeof globalThis.fetch
    await expect(
      buildZip(makeDataset(), [makeAsset()], { fetchImpl }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('buildZip — empty selection', () => {
  it('throws when the user unchecks every asset', async () => {
    await expect(
      buildZip(makeDataset(), [makeAsset()], { selectedKinds: new Set() }),
    ).rejects.toThrow(/No assets selected/)
  })
})

describe('buildZip — pre-arrayBuffer cap enforcement', () => {
  it('throws on a declared Content-Length over cap WITHOUT touching the response body', async () => {
    // Regression: the post-arrayBuffer check runs only after
    // `res.arrayBuffer()` has materialised the whole body in
    // memory. A 5 GB response would OOM the tab during that
    // allocation even though the post-fetch guard would reject.
    // The pre-check inspects Content-Length and throws before
    // touching the body when the server declares an over-cap
    // size.
    const fetchImpl = vi.fn(async () => {
      let arrayBufferCalls = 0
      return {
        ok: true,
        statusText: 'OK',
        headers: {
          get(name: string) {
            return name.toLowerCase() === 'content-length'
              ? String(2 * 1024 * 1024 * 1024)
              : null
          },
        },
        arrayBuffer: async () => {
          arrayBufferCalls++
          throw new Error('arrayBuffer should not be called for over-cap declared sizes')
        },
        __arrayBufferCalls: () => arrayBufferCalls,
      } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    await expect(
      buildZip(makeDataset(), [makeAsset({ kind: 'primary', filename: 'huge.bin' })], { fetchImpl }),
    ).rejects.toThrow(/cap/)
  })

  it('still falls through to the post-arrayBuffer check when Content-Length is missing', async () => {
    // Faked `byteLength: 2 GiB` simulates an origin that elides
    // Content-Length (e.g., chunked transfer-encoding). The
    // pre-check skips, the post-arrayBuffer check catches it.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      statusText: 'OK',
      headers: { get() { return null } },
      arrayBuffer: async () => ({ byteLength: 2 * 1024 * 1024 * 1024 } as unknown as ArrayBuffer),
    })) as unknown as typeof globalThis.fetch
    await expect(
      buildZip(makeDataset(), [makeAsset({ kind: 'primary', filename: 'huge.bin' })], { fetchImpl }),
    ).rejects.toThrow(/cap/)
  })
})

describe('buildZip — mid-download cap enforcement', () => {
  // The cap check reads `buf.byteLength` off the awaited arrayBuffer
  // — it doesn't actually walk the bytes. We fake the byteLength so
  // the test runner doesn't have to allocate 1.5+ GiB of memory.
  // Real-world Response.arrayBuffer() returns an actual buffer
  // whose byteLength matches the bytes; the buildZip code path
  // treats byteLength as opaque, so the fake is faithful to
  // production behaviour without the allocation.
  //
  // The mocked response also exposes an empty `headers.get()` so
  // the pre-arrayBuffer Content-Length check skips for these
  // tests — they specifically exercise the *post-arrayBuffer*
  // fallback guard.
  function fakeFetchOfSize(byteLength: number): typeof globalThis.fetch {
    return vi.fn(async () => ({
      ok: true,
      statusText: 'OK',
      headers: { get() { return null } },
      arrayBuffer: async () => ({ byteLength } as unknown as ArrayBuffer),
    })) as unknown as typeof globalThis.fetch
  }

  it('throws when the first asset alone would exceed the hard cap', async () => {
    // The check fires before zip.file() is called, so no partial
    // archive bytes accumulate. Using a fake 2-GiB-byteLength
    // buffer instead of allocating 2 GiB in the test runner.
    const fetchImpl = fakeFetchOfSize(2 * 1024 * 1024 * 1024)
    await expect(
      buildZip(makeDataset(), [makeAsset({ kind: 'primary', filename: 'huge.bin' })], { fetchImpl }),
    ).rejects.toThrow(/cap/)
  })

  it('throws when cumulative bytesWritten would exceed the cap on a later asset', async () => {
    // First asset is ~1.4 GiB (under the 1.5 GiB cap on its own);
    // second is 0.5 GiB so the cumulative trips the check. Pins
    // the running-total semantics of the in-loop guard.
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      const size = call === 1 ? 1.4 * 1024 * 1024 * 1024 : 0.5 * 1024 * 1024 * 1024
      // The first asset DOES enter the archive (1.4 GiB is under
      // the cap), so we need a real buffer for the JSZip.file()
      // call. Make it tiny but lie about the byteLength via
      // Object.defineProperty so the cap check reads the inflated
      // value and the JSZip call doesn't allocate gigabytes.
      // `headers.get()` returns null so the pre-arrayBuffer
      // Content-Length guard skips; this test specifically pins
      // the post-arrayBuffer cumulative-size enforcement.
      const buf = new ArrayBuffer(0)
      Object.defineProperty(buf, 'byteLength', { value: size })
      return {
        ok: true,
        statusText: 'OK',
        headers: { get() { return null } },
        arrayBuffer: async () => buf,
      } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    await expect(
      buildZip(
        makeDataset(),
        [
          makeAsset({ kind: 'primary', filename: 'a.bin' }),
          makeAsset({ kind: 'legend', filename: 'b.bin' }),
        ],
        { fetchImpl },
      ),
    ).rejects.toThrow(/cap/)
    expect(call).toBe(2)
  })
})

describe('buildZip — packaging-phase cancel', () => {
  it('throws AbortError if the signal is aborted before generateAsync runs', async () => {
    // Mirrors a user clicking Cancel after every fetch completed but
    // before JSZip starts packaging. Pre-abort the signal, expect
    // the throw to land at the post-fetch / pre-generate check.
    const ctrl = new AbortController()
    const fetchImpl = vi.fn(async () => {
      // Abort right before returning, so the next loop iteration's
      // signal check catches it. We only have one asset, so the
      // post-loop check is what fires.
      ctrl.abort()
      return new Response(new ArrayBuffer(4), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    await expect(
      buildZip(makeDataset(), [makeAsset()], { fetchImpl, signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('throws AbortError if the signal is aborted during generateAsync', async () => {
    // generateAsync calls the onUpdate callback per chunk; the
    // abort check inside that callback rejects the generate
    // promise. Manufacture the race by aborting from a sibling
    // microtask once the fetches complete.
    const ctrl = new AbortController()
    const fetchImpl = mockFetchSequence([
      new Response(new ArrayBuffer(128), { status: 200 }),
    ])
    const buildPromise = buildZip(
      makeDataset(),
      [makeAsset({ filename: 'big.bin' })],
      {
        fetchImpl,
        signal: ctrl.signal,
        onProgress: (p) => {
          if (p.phase === 'packaging') ctrl.abort()
        },
      },
    )
    // Either the post-loop check, an in-callback throw, or the
    // post-generate check fires — all surface AbortError.
    await expect(buildPromise).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('buildZip — primary-equivalent kind for frame datasets', () => {
  it('throws when every frame fails on a frames-only selection (no rendered primary)', async () => {
    // Frame-mode datasets that opt out of the rendered primary
    // (listDownloadableAssets({ includeFrames: true })) consist of
    // frame + auxiliary assets only. Without the frame role being
    // "primary-equivalent", every frame could 404 and the dialog
    // would happily produce a manifest-only zip.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404, statusText: 'Not Found' })) as unknown as typeof globalThis.fetch
    await expect(
      buildZip(
        makeDataset(),
        [
          makeAsset({ kind: 'frame', filename: 'frames/00000.png' }),
          makeAsset({ kind: 'frame', filename: 'frames/00001.png' }),
        ],
        { fetchImpl },
      ),
    ).rejects.toThrow(/primary asset/)
  })

  it('refuses to produce a manifest-only zip even when only auxiliary kinds are selected and all fail', async () => {
    // Defensive: a user who unchecked the primary AND every probe
    // for the auxiliary kinds also failed. Without the bytesWritten
    // === 0 safety net at the end of the fetch loop, the zip would
    // contain only manifest.json — the worst kind of "successful"
    // download.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404, statusText: 'Not Found' })) as unknown as typeof globalThis.fetch
    await expect(
      buildZip(
        makeDataset(),
        [
          makeAsset({ kind: 'legend', filename: 'legend.png' }),
          makeAsset({ kind: 'thumbnail', filename: 'thumbnail.jpg' }),
        ],
        { fetchImpl },
      ),
    ).rejects.toThrow(/no data/)
  })
})

describe('listDownloadableAssets — abort signal threading', () => {
  it('aborts an in-flight manifest fetch when the signal fires before resolution', async () => {
    // Regression: previously listDownloadableAssets didn't accept
    // a signal, so closing the dialog mid-resolve left the
    // manifest fetch running. The fix plumbs the signal through
    // resolveAssets → resolveImagePrimary → apiFetch. Confirm by
    // making the manifest fetch a long-pending promise and
    // aborting the signal once the fetch starts; the resolve
    // promise should reject with AbortError.
    const ctrl = new AbortController()
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      // Return a promise that rejects only when the signal aborts.
      // Mirrors a slow upstream that hasn't yet responded.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }) as unknown as typeof globalThis.fetch
    try {
      const dataset: Dataset = {
        id: 'D', title: 'T', format: 'image/jpeg',
        dataLink: '/api/v1/datasets/D/manifest',
      } as Dataset
      const promise = listDownloadableAssets(dataset, { signal: ctrl.signal })
      ctrl.abort()
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('listDownloadableAssets — frames mode for HLS-only video', () => {
  it('skips resolveAssets() and offers frame URLs even when the video manifest is HLS-only', async () => {
    // Regression: previously listDownloadableAssets called
    // resolveAssets() unconditionally before deciding whether to
    // expand frames. For post-transcode publisher datasets the
    // video manifest is HLS-only, so `pickBestVideoFile()` would
    // throw "HLS-streamed and not yet available for offline
    // download" and the dialog would never see the frame URLs —
    // even though the frames ARE the canonical downloadable data
    // for that shape. Pin the fix by making the manifest fetch
    // produce a `files: []` HLS-only envelope; without the
    // frame-mode bypass this would throw.
    const frameMode: Dataset = {
      ...makeDataset({
        dataLink: '/api/v1/datasets/DS01/manifest',
        legendLink: 'https://r2.terraviz.zyra-project.org/legend.png',
      }),
      frames: {
        count: 3,
        urlTemplate: 'https://r2.terraviz.zyra-project.org/frames/DS01/{index}.png',
      },
    }
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      // HLS-only envelope: `files: []` — this is what triggered
      // the throw before the fix.
      new Response(JSON.stringify({ kind: 'video', files: [] }), { status: 200 }),
    ) as unknown as typeof fetch
    try {
      const assets = await listDownloadableAssets(frameMode, { includeFrames: true })
      // Expect: 3 frames + 1 legend, and no primary entry.
      expect(assets.filter(a => a.kind === 'frame')).toHaveLength(3)
      expect(assets.some(a => a.kind === 'legend')).toBe(true)
      expect(assets.some(a => a.kind === 'primary')).toBe(false)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('listDownloadableAssets', () => {
  it('returns only the rendered primary when frames-mode is off', async () => {
    // listDownloadableAssets defers to resolveAssets which requires
    // network. Construct a dataset whose dataLink is the legacy
    // direct-Vimeo path and stub the proxy fetch — that's the
    // shortest path to a happy resolveAssets() in tests.
    const legacy = makeDataset({
      dataLink: 'https://vimeo.com/12345',
      legendLink: 'https://r2.terraviz.zyra-project.org/legend.png',
    })
    const proxyResponse = {
      id: '12345', title: '', duration: 0, hls: '', dash: '',
      files: [{ quality: '1080p', width: 1920, height: 1080, size: 5000, type: 'video/mp4', link: 'https://video-proxy.zyra-project.org/v/12345.mp4' }],
    }
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(proxyResponse), { status: 200 })) as unknown as typeof fetch
    try {
      const assets = await listDownloadableAssets(legacy)
      const kinds = assets.map(a => a.kind)
      expect(kinds).toContain('primary')
      // No `frame` entries when includeFrames is omitted.
      expect(kinds).not.toContain('frame')
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('cap thresholds', () => {
  it('exports a hard cap > the warning threshold', () => {
    expect(ZIP_HARD_CAP_BYTES).toBeGreaterThan(ZIP_WARNING_BYTES)
  })
})

describe('saveBlobAsDownload', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:fake'
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
  })

  it('appends and immediately clicks an anchor with the right name', () => {
    const blob = new Blob(['data'], { type: 'application/zip' })
    saveBlobAsDownload(blob, 'foo.zip')
    // Anchor is removed on next tick via setTimeout(0); but at the
    // moment of the click the document had one anchor with the right
    // `download` attribute. happy-dom's `click()` is synchronous, so
    // by here the timeout hasn't fired yet — verify the anchor exists.
    const a = document.querySelector('a[download="foo.zip"]') as HTMLAnchorElement | null
    expect(a).not.toBeNull()
    expect(a!.href).toBe('blob:fake')
  })
})
