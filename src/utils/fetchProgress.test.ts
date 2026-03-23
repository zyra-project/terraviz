import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchWithProgress, fetchImageWithProgress } from './fetchProgress'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock ReadableStream that yields the given chunks. */
function mockReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++])
      } else {
        controller.close()
      }
    }
  })
}

function mockFetchResponse(opts: {
  body?: ReadableStream<Uint8Array> | null
  contentLength?: number | null
  blob?: Blob
}): Response {
  const headers = new Headers()
  if (opts.contentLength != null) {
    headers.set('content-length', String(opts.contentLength))
  }
  return {
    headers,
    body: opts.body ?? null,
    ok: true,
    status: 200,
    blob: vi.fn().mockResolvedValue(opts.blob ?? new Blob(['fallback'])),
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// fetchWithProgress
// ---------------------------------------------------------------------------
describe('fetchWithProgress', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('streams chunks and reports byte-level progress', async () => {
    const chunk1 = new Uint8Array([1, 2, 3])
    const chunk2 = new Uint8Array([4, 5])
    const stream = mockReadableStream([chunk1, chunk2])
    const response = mockFetchResponse({ body: stream, contentLength: 5 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const progress: Array<[number, number]> = []
    const blob = await fetchWithProgress('https://example.com/data', (loaded, total) => {
      progress.push([loaded, total])
    })

    expect(progress).toEqual([
      [3, 5],  // after chunk1
      [5, 5],  // after chunk2
    ])
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBe(5)
  })

  it('falls back to plain blob when no content-length', async () => {
    const fallbackBlob = new Blob(['hello'])
    const response = mockFetchResponse({ contentLength: null, blob: fallbackBlob })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const progress = vi.fn()
    const blob = await fetchWithProgress('https://example.com/data', progress)

    expect(progress).not.toHaveBeenCalled()
    expect(blob).toBe(fallbackBlob)
  })

  it('falls back to plain blob when content-length is 0', async () => {
    const fallbackBlob = new Blob(['data'])
    const response = mockFetchResponse({ contentLength: 0, blob: fallbackBlob })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const blob = await fetchWithProgress('https://example.com/data')
    expect(blob).toBe(fallbackBlob)
  })

  it('falls back to plain blob when body is null', async () => {
    const fallbackBlob = new Blob(['data'])
    const response = mockFetchResponse({ body: null, contentLength: 100, blob: fallbackBlob })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const blob = await fetchWithProgress('https://example.com/data')
    expect(blob).toBe(fallbackBlob)
  })

  it('works without an onProgress callback', async () => {
    const chunk = new Uint8Array([10, 20])
    const stream = mockReadableStream([chunk])
    const response = mockFetchResponse({ body: stream, contentLength: 2 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const blob = await fetchWithProgress('https://example.com/data')
    expect(blob.size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// fetchImageWithProgress
// ---------------------------------------------------------------------------
describe('fetchImageWithProgress', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns an HTMLImageElement on success', async () => {
    const stream = mockReadableStream([new Uint8Array([1, 2, 3])])
    const response = mockFetchResponse({ body: stream, contentLength: 3 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const fakeUrl = 'blob:test-url'
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue(fakeUrl),
      revokeObjectURL,
    })

    // happy-dom doesn't fire onload for blob URLs — stub Image to auto-fire
    const OrigImage = globalThis.Image
    vi.stubGlobal('Image', class extends OrigImage {
      set src(val: string) {
        Object.defineProperty(this, 'src', { value: val, writable: true, configurable: true })
        setTimeout(() => this.onload?.(new Event('load') as any), 0)
      }
      get src() { return '' }
    })

    const img = await fetchImageWithProgress('https://example.com/image.png')
    expect(img).toBeInstanceOf(HTMLImageElement)
    expect(revokeObjectURL).toHaveBeenCalledWith(fakeUrl)

    vi.stubGlobal('Image', OrigImage)
  })

  it('rejects when image fails to decode', async () => {
    const stream = mockReadableStream([new Uint8Array([1])])
    const response = mockFetchResponse({ body: stream, contentLength: 1 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const fakeUrl = 'blob:bad-url'
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue(fakeUrl),
      revokeObjectURL,
    })

    const OrigImage = globalThis.Image
    vi.stubGlobal('Image', class extends OrigImage {
      set src(_val: string) {
        setTimeout(() => this.onerror?.(new Event('error') as any), 0)
      }
      get src() { return '' }
    })

    await expect(fetchImageWithProgress('https://example.com/bad.png'))
      .rejects.toThrow('Failed to decode image')

    expect(revokeObjectURL).toHaveBeenCalledWith(fakeUrl)
    vi.stubGlobal('Image', OrigImage)
  })

  it('passes progress through to the underlying fetch', async () => {
    const chunk = new Uint8Array([1, 2, 3, 4])
    const stream = mockReadableStream([chunk])
    const response = mockFetchResponse({ body: stream, contentLength: 4 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue('blob:x'),
      revokeObjectURL,
    })

    const OrigImage = globalThis.Image
    vi.stubGlobal('Image', class extends OrigImage {
      set src(val: string) {
        Object.defineProperty(this, 'src', { value: val, writable: true, configurable: true })
        setTimeout(() => this.onload?.(new Event('load') as any), 0)
      }
      get src() { return '' }
    })

    const progress = vi.fn()
    await fetchImageWithProgress('https://example.com/img.jpg', progress)

    expect(progress).toHaveBeenCalledWith(4, 4)
    vi.stubGlobal('Image', OrigImage)
  })
})
