// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `cli/lib/asset-fetch.ts` (Phase 3b commit D).
 *
 * Coverage:
 *   - Happy path: bytes, content-type, size, extension all
 *     populated from a clean 200 response.
 *   - Status guards: non-2xx throws AssetFetchError with the
 *     status preserved.
 *   - Size cap: pre-flight rejection via Content-Length;
 *     streaming rejection when the body overshoots without
 *     advertising a length.
 *   - Content-Type fallback: server-side `application/octet-stream`
 *     resolves to a URL-extension-derived mime.
 *   - extensionFromUrl: trailing slash, no-extension paths,
 *     query strings, fragments all handled.
 *   - mimeForExtension: known extensions; unknown falls back to
 *     octet-stream.
 *   - Network throw: wrapped as AssetFetchError with the URL.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AssetFetchError,
  extensionFromUrl,
  fetchAsset,
  mimeForExtension,
  resolveContentType,
} from './asset-fetch'

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function okResponse(
  body: Uint8Array,
  headers: Record<string, string> = {},
): Response {
  const h = new Headers(headers)
  // The DOM-lib BodyInit is parameterized differently than Node's
  // Buffer/Uint8Array types in some TS lib targets; cast to keep
  // both happy.
  return new Response(body as BodyInit, { status: 200, statusText: 'OK', headers: h })
}

describe('fetchAsset — happy path', () => {
  it('returns bytes, content-type, size, and extension from a clean response', async () => {
    const payload = bytes('\x89PNG\r\n\x1a\n' + 'fake png bytes')
    const fetchImpl = vi.fn(async () =>
      okResponse(payload, {
        'content-type': 'image/png',
        'content-length': String(payload.length),
      }),
    ) as unknown as typeof fetch
    const result = await fetchAsset({
      url: 'https://cdn.example.org/datasets/x/thumbnail.png',
      fetchImpl,
    })
    expect(result.bytes).toEqual(payload)
    expect(result.contentType).toBe('image/png')
    expect(result.sizeBytes).toBe(payload.length)
    expect(result.extension).toBe('png')
    expect(result.sourceUrl).toBe('https://cdn.example.org/datasets/x/thumbnail.png')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('strips charset / parameters from Content-Type', async () => {
    const payload = bytes('1\n00:00:00.000 --> 00:00:01.000\nhi\n')
    const fetchImpl = vi.fn(async () =>
      okResponse(payload, { 'content-type': 'text/vtt; charset=UTF-8' }),
    ) as unknown as typeof fetch
    const result = await fetchAsset({
      url: 'https://cdn.example.org/cap.vtt',
      fetchImpl,
    })
    expect(result.contentType).toBe('text/vtt')
  })

  it('decodes bytes to string when caller does the TextDecoder dance', async () => {
    // Confirms the bytes are unmodified so callers can decode
    // freely. The SRT→VTT converter in 3b/E will read the
    // .bytes field exactly this way.
    const srt = '1\n00:00:00,500 --> 00:00:01,200\nhello\n'
    const fetchImpl = vi.fn(async () =>
      okResponse(bytes(srt), { 'content-type': 'application/x-subrip' }),
    ) as unknown as typeof fetch
    const result = await fetchAsset({
      url: 'https://cdn.example.org/captions/x.srt',
      fetchImpl,
    })
    expect(new TextDecoder('utf-8').decode(result.bytes)).toBe(srt)
  })
})

describe('fetchAsset — status guards', () => {
  it('throws AssetFetchError on a 404, status preserved', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    ) as unknown as typeof fetch
    const err = await fetchAsset({
      url: 'https://cdn.example.org/missing.png',
      fetchImpl,
    }).catch(e => e)
    expect(err).toBeInstanceOf(AssetFetchError)
    expect((err as AssetFetchError).status).toBe(404)
    expect((err as AssetFetchError).url).toBe('https://cdn.example.org/missing.png')
    expect((err as Error).message).toMatch(/unexpected status 404/)
  })

  it('throws AssetFetchError on a 5xx as well', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('Down', { status: 503, statusText: 'Service Unavailable' }),
    ) as unknown as typeof fetch
    const err = await fetchAsset({
      url: 'https://cdn.example.org/x.png',
      fetchImpl,
    }).catch(e => e)
    expect(err).toBeInstanceOf(AssetFetchError)
    expect((err as AssetFetchError).status).toBe(503)
  })

  it('wraps a network throw as AssetFetchError with the URL', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const err = await fetchAsset({
      url: 'https://cdn.example.org/x.png',
      fetchImpl,
    }).catch(e => e)
    expect(err).toBeInstanceOf(AssetFetchError)
    expect((err as AssetFetchError).status).toBeNull()
    expect((err as AssetFetchError).url).toBe('https://cdn.example.org/x.png')
    expect((err as Error).message).toMatch(/fetch failed.*ECONNREFUSED/)
  })
})

describe('fetchAsset — size cap', () => {
  it('rejects pre-flight when Content-Length exceeds maxBytes', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse(bytes('x'), {
        'content-type': 'image/png',
        'content-length': '999999999',
      }),
    ) as unknown as typeof fetch
    const err = await fetchAsset({
      url: 'https://cdn.example.org/huge.png',
      maxBytes: 100,
      fetchImpl,
    }).catch(e => e)
    expect(err).toBeInstanceOf(AssetFetchError)
    expect((err as Error).message).toMatch(/Content-Length.*exceeds maxBytes 100/)
  })

  it('rejects mid-stream when body overshoots without a Content-Length', async () => {
    // Server advertised no length; we have to learn the size by
    // reading. The bounded reader stops mid-stream once total
    // > maxBytes.
    const payload = bytes('x'.repeat(500))
    const fetchImpl = vi.fn(async () =>
      okResponse(payload, { 'content-type': 'image/png' }),
    ) as unknown as typeof fetch
    const err = await fetchAsset({
      url: 'https://cdn.example.org/x.png',
      maxBytes: 100,
      fetchImpl,
    }).catch(e => e)
    expect(err).toBeInstanceOf(AssetFetchError)
    expect((err as Error).message).toMatch(/exceeded maxBytes 100 while streaming/)
  })

  it('default cap is 50 MiB and clean responses pass through', async () => {
    // A 10MB payload is comfortably under the 50MB default cap.
    const payload = new Uint8Array(10 * 1024 * 1024)
    const fetchImpl = vi.fn(async () =>
      okResponse(payload, { 'content-type': 'image/png' }),
    ) as unknown as typeof fetch
    const result = await fetchAsset({
      url: 'https://cdn.example.org/big.png',
      fetchImpl,
    })
    expect(result.sizeBytes).toBe(10 * 1024 * 1024)
  })
})

describe('fetchAsset — content-type fallback', () => {
  it('falls back to URL-extension mime when the server returns octet-stream', async () => {
    // NOAA's CloudFront serves SRT captions as octet-stream
    // occasionally — without the fallback the operator-side
    // R2 PUT would land the file with a useless mime.
    const fetchImpl = vi.fn(async () =>
      okResponse(bytes('1\n00:00:00,500 --> 00:00:01,200\nhi\n'), {
        'content-type': 'application/octet-stream',
      }),
    ) as unknown as typeof fetch
    const result = await fetchAsset({
      url: 'https://cdn.example.org/cap.srt',
      fetchImpl,
    })
    expect(result.contentType).toBe('application/x-subrip')
  })

  it('falls back to URL-extension mime when the server omits Content-Type entirely', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse(bytes('fake'), {}),
    ) as unknown as typeof fetch
    const result = await fetchAsset({
      url: 'https://cdn.example.org/x.png',
      fetchImpl,
    })
    expect(result.contentType).toBe('image/png')
  })
})

describe('extensionFromUrl', () => {
  it('extracts a simple file extension', () => {
    expect(extensionFromUrl('https://cdn.example.org/thumbnail.png')).toBe('png')
  })

  it('lowercases the extension', () => {
    expect(extensionFromUrl('https://cdn.example.org/PHOTO.JPG')).toBe('jpg')
  })

  it('ignores query strings and fragments', () => {
    expect(extensionFromUrl('https://cdn.example.org/x.png?v=2#frag')).toBe('png')
  })

  it('returns empty string for a path with no dot', () => {
    expect(extensionFromUrl('https://cdn.example.org/path/to/asset')).toBe('')
  })

  it('returns empty string for a trailing-dot path', () => {
    expect(extensionFromUrl('https://cdn.example.org/path/')).toBe('')
    expect(extensionFromUrl('https://cdn.example.org/x.')).toBe('')
  })

  it('does not treat a leading dot (`.htaccess` style) as an extension', () => {
    expect(extensionFromUrl('https://cdn.example.org/.htaccess')).toBe('')
  })

  it('returns empty string for a non-URL input', () => {
    expect(extensionFromUrl('not-a-url')).toBe('')
  })

  it('handles deeply-nested paths', () => {
    expect(
      extensionFromUrl('https://d3sik7mbbzunjo.cloudfront.net/atmosphere/carbontracker/colorbar.png'),
    ).toBe('png')
  })
})

describe('resolveContentType', () => {
  it('prefers a well-typed server header', () => {
    expect(resolveContentType('image/jpeg', 'png')).toBe('image/jpeg')
  })

  it('falls back to URL-extension when server says octet-stream', () => {
    expect(resolveContentType('application/octet-stream', 'png')).toBe('image/png')
  })

  it('falls back to URL-extension when server header is null', () => {
    expect(resolveContentType(null, 'srt')).toBe('application/x-subrip')
  })

  it('returns octet-stream when both server and extension are unknown', () => {
    expect(resolveContentType(null, '')).toBe('application/octet-stream')
    expect(resolveContentType(null, 'unknown')).toBe('application/octet-stream')
  })
})

describe('mimeForExtension', () => {
  it('maps known extensions to their canonical mime', () => {
    expect(mimeForExtension('png')).toBe('image/png')
    expect(mimeForExtension('jpg')).toBe('image/jpeg')
    expect(mimeForExtension('jpeg')).toBe('image/jpeg')
    expect(mimeForExtension('webp')).toBe('image/webp')
    expect(mimeForExtension('vtt')).toBe('text/vtt')
    expect(mimeForExtension('srt')).toBe('application/x-subrip')
  })

  it('is case-insensitive', () => {
    expect(mimeForExtension('PNG')).toBe('image/png')
    expect(mimeForExtension('JPEG')).toBe('image/jpeg')
  })

  it('falls back to octet-stream for unknown extensions', () => {
    expect(mimeForExtension('exe')).toBe('application/octet-stream')
    expect(mimeForExtension('')).toBe('application/octet-stream')
  })
})
