/**
 * Tests for the og:image fallback (task: story media) — the pure
 * meta-tag extraction and the bounded article fetch (stubbed; the
 * suite never touches the network).
 */

import { describe, expect, it, vi } from 'vitest'
import { extractOgImage, fetchOgImage } from './og-image'

describe('extractOgImage', () => {
  it('reads og:image regardless of attribute order and decodes &amp;', () => {
    expect(extractOgImage('<meta property="og:image" content="https://img.ex/a.jpg">')).toBe('https://img.ex/a.jpg')
    expect(extractOgImage('<meta content="https://img.ex/b.jpg?x=1&amp;y=2" property="og:image"/>')).toBe(
      'https://img.ex/b.jpg?x=1&y=2',
    )
    expect(extractOgImage("<meta property='og:image:url' content='https://img.ex/c.jpg'>")).toBe('https://img.ex/c.jpg')
  })

  it('falls back to twitter:image only when no og:image exists', () => {
    const both =
      '<meta name="twitter:image" content="https://img.ex/tw.jpg">' +
      '<meta property="og:image" content="https://img.ex/og.jpg">'
    expect(extractOgImage(both)).toBe('https://img.ex/og.jpg')
    expect(extractOgImage('<meta name="twitter:image" content="https://img.ex/tw.jpg">')).toBe('https://img.ex/tw.jpg')
  })

  it('does not double-unescape &amp;-prefixed entities (CodeQL)', () => {
    // `&amp;quot;` must decode to the literal text `&quot;`, not `"`.
    expect(extractOgImage('<meta property="og:image" content="https://img.ex/a.jpg?q=&amp;quot;x">')).toBe(
      'https://img.ex/a.jpg?q=&quot;x',
    )
  })

  it('rejects non-http(s) and empty content', () => {
    expect(extractOgImage('<meta property="og:image" content="javascript:alert(1)">')).toBeNull()
    expect(extractOgImage('<meta property="og:image" content="">')).toBeNull()
    expect(extractOgImage('<p>no meta at all</p>')).toBeNull()
  })
})

function htmlResponse(body: string, contentType = 'text/html; charset=utf-8', ok = true): Response {
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    body: null, // exercise the no-stream fallback path
    text: async () => body,
  } as unknown as Response
}

describe('fetchOgImage', () => {
  it('extracts from an HTML response', async () => {
    const fetchFn = vi.fn(async () => htmlResponse('<head><meta property="og:image" content="https://img.ex/x.jpg"></head>'))
    expect(await fetchOgImage('https://ex.org/story', fetchFn as unknown as typeof fetch)).toBe('https://img.ex/x.jpg')
  })

  it('refuses non-HTML content types and non-OK responses', async () => {
    const pdf = vi.fn(async () => htmlResponse('%PDF-1.7', 'application/pdf'))
    expect(await fetchOgImage('https://ex.org/doc', pdf as unknown as typeof fetch)).toBeNull()
    const err = vi.fn(async () => htmlResponse('<head></head>', 'text/html', false))
    expect(await fetchOgImage('https://ex.org/missing', err as unknown as typeof fetch)).toBeNull()
  })

  it('treats a throwing fetch as no image', async () => {
    const boom = vi.fn(async () => {
      throw new Error('network down')
    })
    expect(await fetchOgImage('https://ex.org/story', boom as unknown as typeof fetch)).toBeNull()
  })
})
