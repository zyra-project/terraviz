import { describe, it, expect, beforeEach } from 'vitest'
import {
  dataService,
  deriveAvailableFor,
  HIDDEN_TOUR_IDS,
  normaliseSourceFormat,
  synthesizeSosOnlyDatasets,
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

  it('assigns monotonically-increasing IDs', () => {
    const entries = [
      { title: 'A', available_for: ['SOS'], movie_preview: 'a' },
      { title: 'B', available_for: ['SOS'], movie_preview: 'b' },
      { title: 'C', available_for: ['SOS'], movie_preview: 'c' },
    ]
    const synthesised = synthesizeSosOnlyDatasets(entries, new Set(), lowerTitle)
    expect(synthesised.map((d) => d.id)).toEqual(['SOS_ONLY_1', 'SOS_ONLY_2', 'SOS_ONLY_3'])
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
