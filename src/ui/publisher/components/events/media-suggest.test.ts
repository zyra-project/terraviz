/**
 * Tests for the media-suggestion builders (task: media suggestion
 * engine) — the Worldview snapshot candidate's geometry, date, and
 * URL contract, plus the Wikimedia Commons nearby-photos source
 * (query URL, license filter, fetch degradation).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildCommonsQueryUrl,
  buildWorldviewSnapshot,
  fetchCommonsSuggestions,
  parseCommonsResponse,
  WORLDVIEW_SNAPSHOT_LAYER,
} from './media-suggest'

const params = (url: string): URLSearchParams => new URLSearchParams(new URL(url).search)

describe('buildWorldviewSnapshot', () => {
  it('builds a padded bbox around a point event, EPSG:4326 axis order', () => {
    const s = buildWorldviewSnapshot({
      occurredStart: '2026-06-25T12:00:00.000Z',
      geometry: { point: { lat: 25, lon: -80 } },
    })!
    expect(s.kind).toBe('worldview')
    const p = params(s.url)
    expect(p.get('TIME')).toBe('2026-06-25')
    expect(p.get('BBOX')).toBe('20,-85,30,-75') // s,w,n,e — lat first
    expect(p.get('LAYERS')).toBe(WORLDVIEW_SNAPSHOT_LAYER)
    expect(p.get('FORMAT')).toBe('image/jpeg')
    // 10° × 10° → square aspect at the fixed width.
    expect(p.get('WIDTH')).toBe('768')
    expect(p.get('HEIGHT')).toBe('768')
  })

  it('clamps padding at the poles/antimeridian and uses the event bbox when present', () => {
    const polar = buildWorldviewSnapshot({
      occurredStart: '2026-01-01T00:00:00.000Z',
      geometry: { point: { lat: 89, lon: 179 } },
    })!
    const p = params(polar.url)
    const [s2, w, n, e] = p.get('BBOX')!.split(',').map(Number)
    expect(n).toBeLessThanOrEqual(90)
    expect(e).toBeLessThanOrEqual(180)
    expect(s2).toBeLessThan(n)
    expect(w).toBeLessThan(e)

    const boxed = buildWorldviewSnapshot({
      occurredStart: '2026-06-01T00:00:00.000Z',
      geometry: { boundingBox: { n: 31, s: 18, w: -98, e: -80 } },
    })!
    expect(params(boxed.url).get('BBOX')).toBe('18,-98,31,-80')
  })

  it('resolves an antimeridian-crossing bbox (w > e) to its wider dateline half', () => {
    // "170°E east through 180° to -160°" — the eastern half is wider
    // (20° vs 10°), so the snapshot keeps [-180, -160].
    const east = buildWorldviewSnapshot({
      occurredStart: '2026-06-01T00:00:00.000Z',
      geometry: { boundingBox: { n: 60, s: 40, w: 170, e: -160 } },
    })!
    expect(params(east.url).get('BBOX')).toBe('40,-180,60,-160')

    // Mirrored: the western half is wider → keep [160, 180].
    const west = buildWorldviewSnapshot({
      occurredStart: '2026-06-01T00:00:00.000Z',
      geometry: { boundingBox: { n: 60, s: 40, w: 160, e: -170 } },
    })!
    expect(params(west.url).get('BBOX')).toBe('40,160,60,180')
  })

  it('grows a degenerate bbox to a visible span', () => {
    const s = buildWorldviewSnapshot({
      occurredStart: '2026-06-01T00:00:00.000Z',
      geometry: { boundingBox: { n: 25.1, s: 25, w: -80.1, e: -80 } },
    })!
    const [south, west, north, east] = params(s.url).get('BBOX')!.split(',').map(Number)
    expect(north - south).toBeGreaterThanOrEqual(2)
    expect(east - west).toBeGreaterThanOrEqual(2)
  })

  it('keeps the full minimum span for a degenerate bbox at a pole / the dateline', () => {
    // Sliding growth, not per-edge clamping: the window shifts inward
    // so the span survives even when the midpoint hugs the boundary.
    const polar = buildWorldviewSnapshot({
      occurredStart: '2026-06-01T00:00:00.000Z',
      geometry: { boundingBox: { n: 90, s: 89.9, w: 179.9, e: 180 } },
    })!
    const [south, west, north, east] = params(polar.url).get('BBOX')!.split(',').map(Number)
    expect(north).toBeLessThanOrEqual(90)
    expect(east).toBeLessThanOrEqual(180)
    expect(north - south).toBeGreaterThanOrEqual(2)
    expect(east - west).toBeGreaterThanOrEqual(2)
  })

  it('requires a date and a location; falls back to the publish date', () => {
    expect(buildWorldviewSnapshot({ geometry: { point: { lat: 0, lon: 0 } } })).toBeNull()
    expect(buildWorldviewSnapshot({ occurredStart: '2026-06-01T00:00:00.000Z', geometry: {} })).toBeNull()
    expect(buildWorldviewSnapshot({ occurredStart: 'not a date', geometry: { point: { lat: 0, lon: 0 } } })).toBeNull()

    const fromPublish = buildWorldviewSnapshot({
      source: { publishedAt: '2026-06-20T08:00:00.000Z' },
      geometry: { point: { lat: 10, lon: 10 } },
    })!
    expect(params(fromPublish.url).get('TIME')).toBe('2026-06-20')
  })
})

function commonsPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageinfo: [
      {
        url: 'https://upload.wikimedia.org/full.jpg',
        thumburl: 'https://upload.wikimedia.org/thumb.jpg',
        mime: 'image/jpeg',
        extmetadata: { LicenseShortName: { value: 'Public domain' } },
        ...overrides,
      },
    ],
  }
}

describe('Commons nearby photos', () => {
  it('builds an anonymous-CORS geosearch query on the File namespace', () => {
    const p = params(buildCommonsQueryUrl({ lat: 25, lon: -80 }))
    expect(p.get('origin')).toBe('*')
    expect(p.get('generator')).toBe('geosearch')
    expect(p.get('ggscoord')).toBe('25|-80')
    expect(p.get('ggsnamespace')).toBe('6')
    expect(p.get('iiprop')).toContain('extmetadata')
  })

  it('keeps only public-domain/CC0 raster images, preferring the sized thumb', () => {
    const suggestions = parseCommonsResponse({
      query: {
        pages: {
          '1': commonsPage(), // PD → kept
          '2': commonsPage({ extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } }), // attribution required → dropped
          '3': commonsPage({ mime: 'application/pdf' }), // not an image → dropped
          '4': commonsPage({ extmetadata: { LicenseShortName: { value: 'CC0' } } }), // kept
        },
      },
    })
    expect(suggestions).toHaveLength(2)
    expect(suggestions[0]).toMatchObject({ kind: 'commons', url: 'https://upload.wikimedia.org/thumb.jpg' })
  })

  it('caps the shortlist at three', () => {
    const pages = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i), commonsPage()]))
    expect(parseCommonsResponse({ query: { pages } })).toHaveLength(3)
  })

  it('orders by the generator index, not the pageid keys', () => {
    // `pages` is pageid-keyed; geosearch's nearest-first order lives in
    // each page's `index`. Pageid 9 is the NEAREST result here.
    const suggestions = parseCommonsResponse({
      query: {
        pages: {
          '1': { index: 2, ...commonsPage({ thumburl: 'https://upload.wikimedia.org/far.jpg' }) },
          '9': { index: 0, ...commonsPage({ thumburl: 'https://upload.wikimedia.org/nearest.jpg' }) },
          '5': { index: 1, ...commonsPage({ thumburl: 'https://upload.wikimedia.org/near.jpg' }) },
        },
      },
    })
    expect(suggestions.map(s => s.url)).toEqual([
      'https://upload.wikimedia.org/nearest.jpg',
      'https://upload.wikimedia.org/near.jpg',
      'https://upload.wikimedia.org/far.jpg',
    ])
  })

  it('requires the sized thumb — never the full-size original', () => {
    const suggestions = parseCommonsResponse({
      query: { pages: { '1': commonsPage({ thumburl: undefined }) } },
    })
    expect(suggestions).toEqual([])
  })

  it('returns [] for malformed bodies', () => {
    expect(parseCommonsResponse(null)).toEqual([])
    expect(parseCommonsResponse({ query: {} })).toEqual([])
  })

  it('fetches from the point (or the bbox centre) and degrades to [] on any failure', async () => {
    const ok = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ query: { pages: { '1': commonsPage() } } }),
    }) as unknown as Response)
    const fromPoint = await fetchCommonsSuggestions(
      { geometry: { point: { lat: 25, lon: -80 } } },
      ok as unknown as typeof fetch,
    )
    expect(fromPoint).toHaveLength(1)
    expect(String(ok.mock.calls[0][0])).toContain('ggscoord=25%7C-80')

    await fetchCommonsSuggestions(
      { geometry: { boundingBox: { n: 30, s: 20, w: -90, e: -80 } } },
      ok as unknown as typeof fetch,
    )
    expect(String(ok.mock.calls[1][0])).toContain('ggscoord=25%7C-85')

    // No location → no request at all.
    const idle = vi.fn()
    expect(await fetchCommonsSuggestions({ geometry: {} }, idle as unknown as typeof fetch)).toEqual([])
    expect(idle).not.toHaveBeenCalled()

    // Network / HTTP failures → [].
    const boom = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(
      await fetchCommonsSuggestions({ geometry: { point: { lat: 0, lon: 0 } } }, boom as unknown as typeof fetch),
    ).toEqual([])
    const notOk = vi.fn(async () => ({ ok: false }) as unknown as Response)
    expect(
      await fetchCommonsSuggestions({ geometry: { point: { lat: 0, lon: 0 } } }, notOk as unknown as typeof fetch),
    ).toEqual([])
  })

  it('derives an antimeridian-aware centre for a wrapped bbox', async () => {
    const ok = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({}) }) as unknown as Response)
    // 170°E → -170°E wraps through the dateline; centre is 180, folded to -180..180.
    await fetchCommonsSuggestions(
      { geometry: { boundingBox: { n: 10, s: 0, w: 170, e: -170 } } },
      ok as unknown as typeof fetch,
    )
    expect(String(ok.mock.calls[0][0])).toContain('ggscoord=5%7C180')
  })
})
