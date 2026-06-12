import { describe, it, expect, beforeEach } from 'vitest'
import {
  dataService,
  deriveAvailableFor,
  HIDDEN_TOUR_IDS,
  normaliseSourceFormat,
  sosOnlyIdSlug,
  synthesizeSosOnlyDatasets,
  tourWireToDataset,
  tourWireToTour,
} from './dataService'
import type { Dataset } from '../types'

const lowerTitle = (t: string): string => t.toLowerCase().trim()

// Helper to build a minimal Dataset
function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'test-id',
    title: 'Test Dataset',
    format: 'image/png',
    dataLink: 'https://example.com/image.png',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// extractVimeoId
// ---------------------------------------------------------------------------
describe('DataService.extractVimeoId', () => {
  it('extracts ID from a full Vimeo URL', () => {
    expect(dataService.extractVimeoId('https://vimeo.com/123456789')).toBe('123456789')
  })

  it('extracts ID from a proxy URL containing vimeo.com', () => {
    expect(dataService.extractVimeoId('https://video-proxy.example.org/video/987654321/vimeo.com/987654321')).toBe('987654321')
  })

  it('returns null for a non-Vimeo URL', () => {
    expect(dataService.extractVimeoId('https://example.com/video.mp4')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(dataService.extractVimeoId('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// isVideoDataset / isImageDataset
// ---------------------------------------------------------------------------
describe('DataService.isVideoDataset', () => {
  it('returns true for video/mp4', () => {
    expect(dataService.isVideoDataset(makeDataset({ format: 'video/mp4' }))).toBe(true)
  })

  it('returns false for image/png', () => {
    expect(dataService.isVideoDataset(makeDataset({ format: 'image/png' }))).toBe(false)
  })
})

describe('DataService.isImageDataset', () => {
  it('returns true for image/png', () => {
    expect(dataService.isImageDataset(makeDataset({ format: 'image/png' }))).toBe(true)
  })

  it('returns true for image/jpg', () => {
    expect(dataService.isImageDataset(makeDataset({ format: 'image/jpg' }))).toBe(true)
  })

  it('returns true for image/jpeg (the publisher-API canonical form)', () => {
    // Phase 1f follow-up — without this case, every JPEG dataset
    // imported via the cutover snapshot pipeline (29 of them at
    // last count, including INTERNAL_SOS_119_ONLINE "Age of the
    // Seafloor") was filtered out of the browse list because the
    // importer canonicalises image/jpg → image/jpeg but the SPA
    // only recognised the legacy non-standard typo'd variants.
    expect(dataService.isImageDataset(makeDataset({ format: 'image/jpeg' }))).toBe(true)
  })

  it('returns true for images/jpg (legacy SOS double-typo)', () => {
    expect(dataService.isImageDataset(makeDataset({ format: 'images/jpg' }))).toBe(true)
  })

  it('returns true for image/webp (validator FORMAT_VALUES surface, Phase 1f/M)', () => {
    // The publisher API's validator accepts image/webp but no
    // current catalog row uses it. Keeping the gate in sync with
    // the validator means a future publisher uploading WebP
    // doesn't get silently dropped from the browse list, the same
    // class of bug 1f/K caught for canonical JPEG.
    expect(dataService.isImageDataset(makeDataset({ format: 'image/webp' }))).toBe(true)
  })

  it('returns false for video/mp4', () => {
    expect(dataService.isImageDataset(makeDataset({ format: 'video/mp4' }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// normaliseSourceFormat (Phase 1f/L)
// ---------------------------------------------------------------------------
describe('normaliseSourceFormat', () => {
  it('rewrites image/jpg to the canonical image/jpeg', () => {
    const out = normaliseSourceFormat(makeDataset({ format: 'image/jpg' }))
    expect(out.format).toBe('image/jpeg')
  })

  it('rewrites the legacy SOS images/jpg double-typo to image/jpeg', () => {
    const out = normaliseSourceFormat(makeDataset({ format: 'images/jpg' }))
    expect(out.format).toBe('image/jpeg')
  })

  it('passes the canonical image/jpeg through unchanged', () => {
    const ds = makeDataset({ format: 'image/jpeg' })
    expect(normaliseSourceFormat(ds).format).toBe('image/jpeg')
  })

  it('passes other formats through unchanged', () => {
    expect(normaliseSourceFormat(makeDataset({ format: 'video/mp4' })).format).toBe('video/mp4')
    expect(normaliseSourceFormat(makeDataset({ format: 'image/png' })).format).toBe('image/png')
    expect(normaliseSourceFormat(makeDataset({ format: 'image/webp' })).format).toBe('image/webp')
    expect(normaliseSourceFormat(makeDataset({ format: 'tour/json' })).format).toBe('tour/json')
  })

  it('does not mutate the input object', () => {
    const ds = makeDataset({ format: 'image/jpg' })
    const out = normaliseSourceFormat(ds)
    expect(ds.format).toBe('image/jpg')
    expect(out).not.toBe(ds)
  })
})

// ---------------------------------------------------------------------------
// parseTimeMetadata
// ---------------------------------------------------------------------------
describe('DataService.parseTimeMetadata', () => {
  it('returns static displayMode when no temporal fields', () => {
    const result = dataService.parseTimeMetadata(makeDataset())
    expect(result.displayMode).toBe('static')
    expect(result.hasTemporalData).toBe(false)
  })

  it('returns temporal mode with startTime + endTime + period', () => {
    const dataset = makeDataset({
      startTime: '2020-01-01T00:00:00',
      endTime: '2021-01-01T00:00:00',
      period: 'P1D',
      format: 'video/mp4'
    })
    const result = dataService.parseTimeMetadata(dataset)
    expect(result.displayMode).toBe('temporal')
    expect(result.hasTemporalData).toBe(true)
    expect(result.startTime).toBeInstanceOf(Date)
    expect(result.endTime).toBeInstanceOf(Date)
  })

  it('parses period into typed object', () => {
    const dataset = makeDataset({
      startTime: '2020-01-01T00:00:00',
      endTime: '2021-01-01T00:00:00',
      period: 'P1W',
      format: 'video/mp4'
    })
    const result = dataService.parseTimeMetadata(dataset)
    expect(result.period?.type).toBe('week')
    expect(result.period?.days).toBe(7)
  })

  it('returns temporal for video with only startTime', () => {
    const dataset = makeDataset({
      format: 'video/mp4',
      startTime: '2020-06-01T00:00:00'
    })
    const result = dataService.parseTimeMetadata(dataset)
    expect(result.displayMode).toBe('temporal')
    expect(result.hasTemporalData).toBe(true)
  })

  it('returns unknown on unparseable period', () => {
    const dataset = makeDataset({
      startTime: '2020-01-01T00:00:00',
      endTime: '2021-01-01T00:00:00',
      // 'PXXX' starts with P (passes datetime guard) but doesn't match
      // the duration regex, so parseISO8601Duration throws → 'unknown'.
      period: 'PXXX'
    })
    const result = dataService.parseTimeMetadata(dataset)
    expect(result.displayMode).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// getDatasetById — requires populated cache (returns undefined before fetch)
// ---------------------------------------------------------------------------
describe('DataService.getDatasetById', () => {
  it('returns undefined when cache is empty', () => {
    dataService.clearCache()
    expect(dataService.getDatasetById('any-id')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Phase 4 §6.4 — SOS-only data widening
// ---------------------------------------------------------------------------

describe('deriveAvailableFor', () => {
  it('returns undefined for missing or empty arrays', () => {
    expect(deriveAvailableFor(undefined)).toBeUndefined()
    expect(deriveAvailableFor([])).toBeUndefined()
  })

  it('maps ["SOS"] only to "SOS"', () => {
    expect(deriveAvailableFor(['SOS'])).toBe('SOS')
  })

  it('maps ["Explorer"] only to "Explorer"', () => {
    expect(deriveAvailableFor(['Explorer'])).toBe('Explorer')
  })

  it('maps both surfaces to "Both"', () => {
    expect(deriveAvailableFor(['SOS', 'Explorer'])).toBe('Both')
    expect(deriveAvailableFor(['Explorer', 'SOS'])).toBe('Both')
  })

  it('ignores unrecognised values when neither flag is present', () => {
    expect(deriveAvailableFor(['Mars'])).toBeUndefined()
  })
})

describe('synthesizeSosOnlyDatasets', () => {
  it('synthesises a Dataset for an SOS-only entry with movie_preview', () => {
    const synthesised = synthesizeSosOnlyDatasets(
      [
        {
          title: 'Tsunami Wave Heights',
          description: 'A reconstruction of tsunami wave heights.',
          available_for: ['SOS'],
          movie_preview: 'https://sos.noaa.gov/videos/tsunami.mov',
          thumbnail_image: 'https://sos.noaa.gov/thumb/tsunami.jpg',
          dataset_developer: { name: 'NOAA NCEI' },
          keywords: ['tsunami', 'ocean'],
          url: 'https://sos.noaa.gov/catalog/tsunami',
        },
      ],
      new Set(),
      lowerTitle,
    )
    expect(synthesised).toHaveLength(1)
    const ds = synthesised[0]
    expect(ds.id).toMatch(/^SOS_ONLY_/)
    expect(ds.title).toBe('Tsunami Wave Heights')
    expect(ds.format).toBe('video/mp4')
    expect(ds.dataLink).toBe('https://sos.noaa.gov/videos/tsunami.mov')
    expect(ds.thumbnailLink).toBe('https://sos.noaa.gov/thumb/tsunami.jpg')
    expect(ds.abstractTxt).toBe('A reconstruction of tsunami wave heights.')
    expect(ds.organization).toBe('NOAA NCEI')
    expect(ds.tags).toEqual(['tsunami', 'ocean'])
    expect(ds.websiteLink).toBe('https://sos.noaa.gov/catalog/tsunami')
    expect(ds.availableFor).toBe('SOS')
  })

  it('skips entries that lack a movie_preview URL', () => {
    expect(
      synthesizeSosOnlyDatasets(
        [{ title: 'No Preview', available_for: ['SOS'] }],
        new Set(),
        lowerTitle,
      ),
    ).toEqual([])
  })

  it('skips entries marked "Explorer" or "Both" (already in live catalog)', () => {
    const entries = [
      { title: 'Explorer Only', available_for: ['Explorer'], movie_preview: 'x' },
      { title: 'Both', available_for: ['SOS', 'Explorer'], movie_preview: 'x' },
      { title: 'SOS Only', available_for: ['SOS'], movie_preview: 'x' },
    ]
    const synthesised = synthesizeSosOnlyDatasets(entries, new Set(), lowerTitle)
    expect(synthesised.map((d) => d.title)).toEqual(['SOS Only'])
  })

  it('de-dupes against the existing live-catalog title keys', () => {
    const synthesised = synthesizeSosOnlyDatasets(
      [{ title: 'Sea Ice', available_for: ['SOS'], movie_preview: 'x' }],
      new Set([lowerTitle('Sea Ice')]),
      lowerTitle,
    )
    expect(synthesised).toEqual([])
  })

  it('derives a stable title-slug ID (not iteration-order dependent)', () => {
    const entries = [
      { title: 'Tsunami Wave Heights', available_for: ['SOS'], movie_preview: 'a' },
      { title: 'Arctic Sea Ice 2020', available_for: ['SOS'], movie_preview: 'b' },
    ]
    const synthesised = synthesizeSosOnlyDatasets(entries, new Set(), lowerTitle)
    expect(synthesised.map((d) => d.id)).toEqual([
      'SOS_ONLY_tsunami_wave_heights',
      'SOS_ONLY_arctic_sea_ice_2020',
    ])
  })

  it('keeps IDs stable when the enriched list is reordered', () => {
    const entries = [
      { title: 'Alpha', available_for: ['SOS'], movie_preview: 'a' },
      { title: 'Beta', available_for: ['SOS'], movie_preview: 'b' },
    ]
    const a = synthesizeSosOnlyDatasets(entries, new Set(), lowerTitle)
    const b = synthesizeSosOnlyDatasets([entries[1], entries[0]], new Set(), lowerTitle)
    // Same titles → same IDs, regardless of input order.
    const idsA = a.reduce<Record<string, string>>((acc, d) => ((acc[d.title] = d.id), acc), {})
    const idsB = b.reduce<Record<string, string>>((acc, d) => ((acc[d.title] = d.id), acc), {})
    expect(idsA).toEqual(idsB)
  })

  it('disambiguates collision-only slug pairs with a numeric suffix', () => {
    // Two titles that slugify identically (special chars stripped).
    const entries = [
      { title: 'Foo Bar', available_for: ['SOS'], movie_preview: 'a' },
      { title: 'Foo  Bar', available_for: ['SOS'], movie_preview: 'b' },
    ]
    // Force the title-key dedupe to NOT collide so both survive
    // to ID assignment — title normaliser uses lowerTitle which
    // collapses double-space differently than the slugifier.
    const customNormalize = (t: string) => t  // keep both distinct
    const synthesised = synthesizeSosOnlyDatasets(entries, new Set(), customNormalize)
    expect(synthesised[0].id).toBe('SOS_ONLY_foo_bar')
    expect(synthesised[1].id).toBe('SOS_ONLY_foo_bar_2')
  })
})

describe('sosOnlyIdSlug', () => {
  it('lowercases and replaces non-alphanumeric runs with underscores', () => {
    expect(sosOnlyIdSlug('Sea Ice (Movie)')).toBe('sea_ice_movie')
    expect(sosOnlyIdSlug('120 Years of Earthquakes: 1901–2020'))
      .toBe('120_years_of_earthquakes_1901_2020')
  })

  it('trims edge underscores', () => {
    expect(sosOnlyIdSlug('  hello  ')).toBe('hello')
    expect(sosOnlyIdSlug('!!! Wow !!!')).toBe('wow')
  })

  it('caps length so deep-link URLs stay reasonable', () => {
    const long = 'a'.repeat(200)
    expect(sosOnlyIdSlug(long).length).toBeLessThanOrEqual(60)
  })

  it('returns synthesised rows tagged with weight 0', () => {
    const synthesised = synthesizeSosOnlyDatasets(
      [{ title: 'A', available_for: ['SOS'], movie_preview: 'a' }],
      new Set(),
      lowerTitle,
    )
    expect(synthesised[0].weight).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// HIDDEN_TOUR_IDS — client-side denylist for unsupported SOS tours
// ---------------------------------------------------------------------------
describe('HIDDEN_TOUR_IDS', () => {
  it('suppresses the 360 Media tour (uses unsupported task types)', () => {
    expect(HIDDEN_TOUR_IDS.has('INTERNAL_SOS_687')).toBe(true)
  })

  it('suppresses the HRRR-Smoke tour (uses unsupported task types)', () => {
    expect(HIDDEN_TOUR_IDS.has('INTERNAL_SOS_HRRR_Smoke_Tour_Mobile')).toBe(true)
  })

  it('does not suppress the built-in Climate Connections tour', () => {
    expect(HIDDEN_TOUR_IDS.has('SAMPLE_TOUR')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// tourWireToDataset / tourWireToTour — Phase 3pt/G follow-up
// ---------------------------------------------------------------------------
describe('tourWireToDataset', () => {
  const wire = {
    id: '01HXTOUR000000000000000000',
    slug: 'hurricane-tour',
    title: 'Hurricane Tour',
    description: 'A guided look at hurricane formation.',
    tour_json_url: 'https://r2.example.com/tours/01HX/published/01HY.json',
    thumbnail_url: 'https://r2.example.com/tours/01HX/thumb.jpg',
    visibility: 'public',
    schema_version: 1,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    published_at: '2026-05-01T00:00:00.000Z',
    origin_node: 'NODE000',
  }

  it('maps the wire shape to a tour/json-format Dataset', () => {
    const d = tourWireToDataset(wire)
    expect(d.id).toBe(wire.id)
    expect(d.format).toBe('tour/json')
    expect(d.title).toBe(wire.title)
    expect(d.tourJsonUrl).toBe(wire.tour_json_url)
    expect(d.dataLink).toBe(wire.tour_json_url)
    expect(d.abstractTxt).toBe(wire.description)
    expect(d.thumbnailLink).toBe(wire.thumbnail_url)
    expect(d.tags).toEqual(['Tours'])
  })

  it('handles null thumbnail / description defensively', () => {
    // Note: tours with null `tour_json_url` are filtered out
    // by `fetchToursFromNode` before this mapper runs (a card
    // pointing at no URL is unlaunchable); the mapper still
    // tolerates the field nullably as a defensive layer for
    // any consumer that bypasses the filter.
    const d = tourWireToDataset({
      ...wire,
      description: null,
      thumbnail_url: null,
    })
    expect(d.abstractTxt).toBeUndefined()
    expect(d.thumbnailLink).toBeUndefined()
  })

  it('round-trips through tourWireToTour with the same metadata', () => {
    const tour = tourWireToTour(wire)
    expect(tour.id).toBe(wire.id)
    expect(tour.title).toBe(wire.title)
    expect(tour.tourJsonUrl).toBe(wire.tour_json_url)
    expect(tour.publishedAt).toBe(wire.published_at)
  })
})

describe('effectiveCatalogTtl (Phase Z4)', () => {
  const HOUR = 60 * 60 * 1000
  const NOW = Date.parse('2026-06-11T12:00:00Z')
  const RECENT = '2026-06-11T00:00:00Z' // within 2 cadences for sub-daily+ periods

  it('keeps the default TTL for static catalogs', async () => {
    const { effectiveCatalogTtl } = await import('./dataService')
    expect(effectiveCatalogTtl([{ id: 'a' } as never], HOUR, NOW)).toBe(HOUR)
  })

  it('shrinks to the shortest LIVE period present, never grows', async () => {
    const { effectiveCatalogTtl } = await import('./dataService')
    const datasets = [
      { id: 'a', period: 'P1W', endTime: RECENT },
      { id: 'b', period: 'PT30M', endTime: '2026-06-11T11:45:00Z' },
    ] as never[]
    // PT30M wins; P1W (longer than the default) cannot grow the TTL.
    expect(effectiveCatalogTtl(datasets, HOUR, NOW)).toBe(30 * 60 * 1000)
    expect(effectiveCatalogTtl([{ id: 'a', period: 'P1W', endTime: RECENT } as never], HOUR, NOW)).toBe(HOUR)
  })

  it('ignores historical time-series rows (stale endTime) despite period', async () => {
    const { effectiveCatalogTtl } = await import('./dataService')
    const archived = [{ id: 'a', period: 'PT30M', endTime: '2020-01-01T00:00:00Z' } as never]
    expect(effectiveCatalogTtl(archived, HOUR, NOW)).toBe(HOUR)
  })

  it('rejects calendar-fuzzy periods (P1M/P1Y) for cadence decisions', async () => {
    const { effectiveCatalogTtl } = await import('./dataService')
    const monthly = [{ id: 'a', period: 'P1M', endTime: RECENT } as never]
    const yearly = [{ id: 'a', period: 'P1Y', endTime: RECENT } as never]
    expect(effectiveCatalogTtl(monthly, HOUR, NOW)).toBe(HOUR)
    expect(effectiveCatalogTtl(yearly, HOUR, NOW)).toBe(HOUR)
  })

  it('treats malformed periods as no cadence signal instead of throwing', async () => {
    const { effectiveCatalogTtl } = await import('./dataService')
    const bad = [{ id: 'a', period: 'not-a-duration', endTime: RECENT } as never]
    expect(() => effectiveCatalogTtl(bad, HOUR, NOW)).not.toThrow()
    expect(effectiveCatalogTtl(bad, HOUR, NOW)).toBe(HOUR)
  })

  it('never grows past the caller default, even below the floor', async () => {
    const { effectiveCatalogTtl } = await import('./dataService')
    const ONE_MIN = 60 * 1000
    const live = [{ id: 'a', period: 'PT1M', endTime: '2026-06-11T11:59:30Z' } as never]
    expect(effectiveCatalogTtl(live, ONE_MIN, NOW)).toBe(ONE_MIN)
  })

  it('tracks sub-hour cadences and floors at five minutes', async () => {
    const { effectiveCatalogTtl } = await import('./dataService')
    const at = (period: string) => [{ id: 'a', period, endTime: '2026-06-11T11:59:00Z' } as never]
    expect(effectiveCatalogTtl(at('PT15M'), HOUR, NOW)).toBe(15 * 60 * 1000)
    expect(effectiveCatalogTtl(at('PT1M'), HOUR, NOW)).toBe(5 * 60 * 1000)
  })
})
