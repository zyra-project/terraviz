import { describe, it, expect } from 'vitest'
import {
  BASELINE_RESOLVERS,
  PERIOD_RESOLVER,
  PERIOD_TOKEN_TO_ISO,
  extractYear,
  filterDatasets,
  formatToBucket,
  matchesSearchQuery,
  mergeFilterStates,
  parseSearchQuery,
  setFacet,
  toggleBooleanFacet,
  toggleFacet,
  type FacetPredicate,
  type FilterState,
} from './datasetFilter'
import type { Dataset } from '../types'

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'test-1',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data.mp4',
    ...overrides,
  }
}

describe('formatToBucket', () => {
  it('buckets video MIME types to "video"', () => {
    expect(formatToBucket('video/mp4')).toBe('video')
    expect(formatToBucket('video/webm')).toBe('video')
  })

  it('buckets image MIME types to "image" (including the legacy "images/" variant)', () => {
    expect(formatToBucket('image/jpeg')).toBe('image')
    expect(formatToBucket('image/png')).toBe('image')
    expect(formatToBucket('image/webp')).toBe('image')
    expect(formatToBucket('images/jpg')).toBe('image')
  })

  it('buckets tour/json to "tour"', () => {
    expect(formatToBucket('tour/json')).toBe('tour')
  })

  it('falls through to "other" for unrecognised and missing formats', () => {
    expect(formatToBucket(undefined)).toBe('other')
    expect(formatToBucket('')).toBe('other')
    expect(formatToBucket('audio/mpeg')).toBe('other')
  })
})

describe('extractYear', () => {
  it('reads a four-digit prefix from ISO 8601 timestamps', () => {
    expect(extractYear('2024-01-15T00:00:00Z')).toBe(2024)
    expect(extractYear('2024-01-15')).toBe(2024)
    expect(extractYear('2024')).toBe(2024)
  })

  it('tolerates historical reconstruction years (no clamp to modern era)', () => {
    expect(extractYear('0000-01-01')).toBe(0)
    expect(extractYear('1500-06-01')).toBe(1500)
    expect(extractYear('1800-01-01')).toBe(1800)
  })

  it('returns undefined for unparseable input', () => {
    expect(extractYear(undefined)).toBeUndefined()
    expect(extractYear(null)).toBeUndefined()
    expect(extractYear('')).toBeUndefined()
    expect(extractYear('not-a-date')).toBeUndefined()
    expect(extractYear('99-01-01')).toBeUndefined() // not 4 digits
  })
})

describe('BASELINE_RESOLVERS.category', () => {
  const resolve = BASELINE_RESOLVERS.category

  it('matches when any selected tag is on the dataset (OR within facet)', () => {
    const d = makeDataset({ tags: ['Water', 'Real-Time'] })
    expect(resolve({ kind: 'multi-select', values: ['Land', 'Water'] }, d)).toBe(true)
    expect(resolve({ kind: 'multi-select', values: ['Land'] }, d)).toBe(false)
  })

  it('matches everything when the chip group is empty (degenerate)', () => {
    const d = makeDataset({ tags: ['Water'] })
    expect(resolve({ kind: 'multi-select', values: [] }, d)).toBe(true)
  })

  it('returns false for datasets without tags', () => {
    const d = makeDataset({ tags: undefined })
    expect(resolve({ kind: 'multi-select', values: ['Water'] }, d)).toBe(false)
  })

  it('rejects non-multi-select predicate kinds', () => {
    const d = makeDataset({ tags: ['Water'] })
    expect(resolve({ kind: 'boolean', value: true }, d)).toBe(false)
  })
})

describe('BASELINE_RESOLVERS.keyword', () => {
  const resolve = BASELINE_RESOLVERS.keyword

  it('matches enriched.keywords case-insensitively', () => {
    const d = makeDataset({ enriched: { keywords: ['Hurricane', 'Storm Surge'] } })
    expect(resolve({ kind: 'multi-select', values: ['hurricane'] }, d)).toBe(true)
    expect(resolve({ kind: 'multi-select', values: ['STORM SURGE'] }, d)).toBe(true)
    expect(resolve({ kind: 'multi-select', values: ['tornado'] }, d)).toBe(false)
  })

  it('falls back to tags for SOS-only synthesised rows that have tags but no enriched keywords', () => {
    const d = makeDataset({
      tags: ['hurricane', 'wind'],
      enriched: undefined,
    })
    expect(resolve({ kind: 'multi-select', values: ['Hurricane'] }, d)).toBe(true)
  })

  it('prefers enriched.keywords over tags when both are present', () => {
    const d = makeDataset({
      tags: ['fallback-tag'],
      enriched: { keywords: ['real-keyword'] },
    })
    // 'fallback-tag' should NOT match because enriched.keywords takes precedence.
    expect(resolve({ kind: 'multi-select', values: ['fallback-tag'] }, d)).toBe(false)
    expect(resolve({ kind: 'multi-select', values: ['real-keyword'] }, d)).toBe(true)
  })
})

describe('BASELINE_RESOLVERS.format', () => {
  const resolve = BASELINE_RESOLVERS.format

  it('matches buckets, not raw MIME strings', () => {
    const video = makeDataset({ format: 'video/mp4' })
    const image = makeDataset({ format: 'image/jpeg' })
    const tour = makeDataset({ format: 'tour/json' })
    expect(resolve({ kind: 'multi-select', values: ['video'] }, video)).toBe(true)
    expect(resolve({ kind: 'multi-select', values: ['video'] }, image)).toBe(false)
    expect(resolve({ kind: 'multi-select', values: ['image', 'tour'] }, tour)).toBe(true)
  })
})

describe('BASELINE_RESOLVERS.dateAdded', () => {
  const resolve = BASELINE_RESOLVERS.dateAdded

  it('matches when the dataset year falls within the inclusive range', () => {
    const d = makeDataset({ enriched: { dateAdded: '2020-03-15' } })
    expect(resolve({ kind: 'range', min: 2018, max: 2024 }, d)).toBe(true)
    expect(resolve({ kind: 'range', min: 2020, max: 2020 }, d)).toBe(true)
    expect(resolve({ kind: 'range', min: 2021 }, d)).toBe(false)
    expect(resolve({ kind: 'range', max: 2019 }, d)).toBe(false)
  })

  it('honours half-open ranges (only min, only max)', () => {
    const d = makeDataset({ enriched: { dateAdded: '2020' } })
    expect(resolve({ kind: 'range', min: 2015 }, d)).toBe(true)
    expect(resolve({ kind: 'range', max: 2025 }, d)).toBe(true)
  })

  it('excludes datasets with no parseable dateAdded', () => {
    expect(
      resolve({ kind: 'range', min: 2010, max: 2030 }, makeDataset({ enriched: undefined })),
    ).toBe(false)
    expect(
      resolve(
        { kind: 'range', min: 2010, max: 2030 },
        makeDataset({ enriched: { dateAdded: 'sometime' } }),
      ),
    ).toBe(false)
  })
})

describe('BASELINE_RESOLVERS.dataCoverageYear', () => {
  const resolve = BASELINE_RESOLVERS.dataCoverageYear

  it('treats coverage as an interval and matches on overlap', () => {
    const d = makeDataset({ startTime: '1990-01-01', endTime: '2010-12-31' })
    // Range fully inside coverage → overlap.
    expect(resolve({ kind: 'range', min: 1995, max: 2000 }, d)).toBe(true)
    // Range partially overlapping the start → overlap.
    expect(resolve({ kind: 'range', min: 1985, max: 1992 }, d)).toBe(true)
    // Range partially overlapping the end → overlap.
    expect(resolve({ kind: 'range', min: 2008, max: 2015 }, d)).toBe(true)
    // Range entirely before coverage → no overlap.
    expect(resolve({ kind: 'range', min: 1970, max: 1980 }, d)).toBe(false)
    // Range entirely after coverage → no overlap.
    expect(resolve({ kind: 'range', min: 2020, max: 2025 }, d)).toBe(false)
  })

  it('treats startTime-only rows as instantaneous', () => {
    const d = makeDataset({ startTime: '2015-06-01' })
    expect(resolve({ kind: 'range', min: 2014, max: 2016 }, d)).toBe(true)
    expect(resolve({ kind: 'range', min: 2016, max: 2018 }, d)).toBe(false)
  })

  it('excludes datasets without temporal metadata', () => {
    expect(
      resolve({ kind: 'range', min: 2000, max: 2020 }, makeDataset({})),
    ).toBe(false)
  })

  it('supports historical reconstructions (year 0 onwards)', () => {
    const d = makeDataset({ startTime: '0000-01-01', endTime: '2024-01-01' })
    expect(resolve({ kind: 'range', min: 1000, max: 1500 }, d)).toBe(true)
  })
})

describe('BASELINE_RESOLVERS.hasCaptions', () => {
  const resolve = BASELINE_RESOLVERS.hasCaptions

  it('matches when closedCaptionLink is a non-empty string', () => {
    expect(
      resolve({ kind: 'boolean', value: true }, makeDataset({ closedCaptionLink: 'https://x' })),
    ).toBe(true)
  })

  it('excludes datasets with empty or missing caption link', () => {
    expect(
      resolve({ kind: 'boolean', value: true }, makeDataset({ closedCaptionLink: '' })),
    ).toBe(false)
    expect(
      resolve({ kind: 'boolean', value: true }, makeDataset({ closedCaptionLink: undefined })),
    ).toBe(false)
  })
})

describe('BASELINE_RESOLVERS.hasTour', () => {
  const resolve = BASELINE_RESOLVERS.hasTour

  it('matches datasets whose format is `tour/json` (publisher tours, SOS tour files)', () => {
    expect(
      resolve({ kind: 'boolean', value: true }, makeDataset({ format: 'tour/json' })),
    ).toBe(true)
  })

  it('excludes video / image / other formats regardless of runTourOnLoad', () => {
    // PR #137: the original resolver tested runTourOnLoad, which
    // the publisher pipeline overloaded to mean "auto-play on
    // load" rather than "this is a curated tour". A video
    // dataset with runTourOnLoad set must NOT pass — that's the
    // bug the resolver change fixes.
    expect(
      resolve(
        { kind: 'boolean', value: true },
        makeDataset({ format: 'video/mp4', runTourOnLoad: 'some-tour-id' }),
      ),
    ).toBe(false)
    expect(
      resolve({ kind: 'boolean', value: true }, makeDataset({ format: 'image/jpeg' })),
    ).toBe(false)
  })
})

describe('BASELINE_RESOLVERS.includeSos', () => {
  it('returns true for every dataset when the predicate is present (opt-in to everything)', () => {
    const resolve = BASELINE_RESOLVERS.includeSos
    expect(resolve({ kind: 'boolean', value: true }, makeDataset({ availableFor: 'SOS' }))).toBe(true)
    expect(resolve({ kind: 'boolean', value: true }, makeDataset({ availableFor: 'Explorer' }))).toBe(true)
  })

  it('returns false for non-boolean predicates (defensive)', () => {
    const resolve = BASELINE_RESOLVERS.includeSos
    expect(resolve({ kind: 'multi-select', values: ['x'] }, makeDataset({}))).toBe(false)
  })
})

describe('BASELINE_RESOLVERS.geographicRegion', () => {
  const resolve = BASELINE_RESOLVERS.geographicRegion

  it('matches when the dataset bbox overlaps the predicate bbox', () => {
    expect(
      resolve(
        { kind: 'bbox', n: 40, s: 0, e: 30, w: -10 },
        makeDataset({ boundingBox: { n: 20, s: -10, e: 0, w: -20 } }),
      ),
    ).toBe(true)
  })

  it('matches when the bboxes share only an edge (inclusive)', () => {
    // Touching but not overlapping in the interior is still "in
    // contact"; a user who brushes a coast deserves a hit on the
    // coast-line dataset. The dataCoverageYear resolver uses the
    // same inclusive convention.
    expect(
      resolve(
        { kind: 'bbox', n: 50, s: 20, e: 0, w: -30 },
        makeDataset({ boundingBox: { n: 20, s: 0, e: 10, w: 0 } }),
      ),
    ).toBe(true)
  })

  it('rejects when the dataset bbox is entirely north of the predicate', () => {
    expect(
      resolve(
        { kind: 'bbox', n: 10, s: -10, e: 10, w: -10 },
        makeDataset({ boundingBox: { n: 40, s: 20, e: 10, w: -10 } }),
      ),
    ).toBe(false)
  })

  it('rejects when the dataset bbox is entirely east of the predicate', () => {
    expect(
      resolve(
        { kind: 'bbox', n: 10, s: -10, e: 10, w: -10 },
        makeDataset({ boundingBox: { n: 10, s: -10, e: 90, w: 60 } }),
      ),
    ).toBe(false)
  })

  it('matches when the predicate fully contains the dataset bbox', () => {
    expect(
      resolve(
        { kind: 'bbox', n: 90, s: -90, e: 180, w: -180 },
        makeDataset({ boundingBox: { n: 20, s: -10, e: 30, w: 0 } }),
      ),
    ).toBe(true)
  })

  it('matches when the dataset bbox fully contains the predicate', () => {
    expect(
      resolve(
        { kind: 'bbox', n: 5, s: -5, e: 5, w: -5 },
        makeDataset({ boundingBox: { n: 90, s: -90, e: 180, w: -180 } }),
      ),
    ).toBe(true)
  })

  it('handles antimeridian-crossing dataset bboxes', () => {
    // Dataset bbox wraps east through the dateline from 170° to -170°.
    // A predicate at longitude 175 should match (lies inside the wrap);
    // a predicate at longitude 0 should not (outside the wrap).
    expect(
      resolve(
        { kind: 'bbox', n: 40, s: -40, e: 178, w: 172 },
        makeDataset({ boundingBox: { n: 30, s: -30, e: -170, w: 170 } }),
      ),
    ).toBe(true)
    expect(
      resolve(
        { kind: 'bbox', n: 40, s: -40, e: 5, w: -5 },
        makeDataset({ boundingBox: { n: 30, s: -30, e: -170, w: 170 } }),
      ),
    ).toBe(false)
  })

  it('handles antimeridian-crossing predicate bboxes', () => {
    expect(
      resolve(
        { kind: 'bbox', n: 30, s: -30, e: -170, w: 170 },
        makeDataset({ boundingBox: { n: 40, s: -40, e: 178, w: 172 } }),
      ),
    ).toBe(true)
  })

  it('rejects datasets without boundingBox', () => {
    expect(
      resolve(
        { kind: 'bbox', n: 40, s: 0, e: 30, w: -10 },
        makeDataset({ boundingBox: undefined }),
      ),
    ).toBe(false)
  })

  it('rejects non-bbox predicates', () => {
    expect(
      resolve(
        { kind: 'multi-select', values: ['x'] },
        makeDataset({ boundingBox: { n: 10, s: 0, e: 10, w: 0 } }),
      ),
    ).toBe(false)
  })

  it('rejects datasets with malformed bbox (NaN corner or n < s)', () => {
    expect(
      resolve(
        { kind: 'bbox', n: 90, s: -90, e: 180, w: -180 },
        makeDataset({ boundingBox: { n: NaN, s: 0, e: 10, w: 0 } }),
      ),
    ).toBe(false)
    expect(
      resolve(
        { kind: 'bbox', n: 90, s: -90, e: 180, w: -180 },
        makeDataset({ boundingBox: { n: -45, s: 45, e: 10, w: 0 } }),
      ),
    ).toBe(false)
  })
})

describe('matchesSearchQuery', () => {
  it('matches against title, description, keywords, tags, and category names', () => {
    const d = makeDataset({
      title: 'Sea Ice Concentration',
      abstractTxt: 'Daily product showing ice extent.',
      tags: ['Water', 'Snow and Ice'],
      enriched: {
        description: 'Daily product showing ice extent over the polar regions.',
        keywords: ['arctic', 'cryosphere'],
        categories: { Atmosphere: ['Temperature'] },
      },
    })
    expect(matchesSearchQuery(d, 'sea ice')).toBe(true)        // title
    expect(matchesSearchQuery(d, 'polar')).toBe(true)          // description
    expect(matchesSearchQuery(d, 'arctic')).toBe(true)         // keywords
    expect(matchesSearchQuery(d, 'snow')).toBe(true)           // tags
    expect(matchesSearchQuery(d, 'atmosphere')).toBe(true)     // category name
    expect(matchesSearchQuery(d, 'mars')).toBe(false)
  })

  it('empty query matches everything', () => {
    expect(matchesSearchQuery(makeDataset({}), '')).toBe(true)
  })

  it('falls back to abstractTxt when enriched.description is absent', () => {
    const d = makeDataset({
      enriched: undefined,
      abstractTxt: 'Sea surface salinity dataset.',
    })
    expect(matchesSearchQuery(d, 'salinity')).toBe(true)
  })
})

describe('filterDatasets', () => {
  const water = makeDataset({
    id: 'water',
    title: 'Ocean Currents',
    tags: ['Water'],
    availableFor: 'Explorer',
  })
  const land = makeDataset({
    id: 'land',
    title: 'Land Cover',
    tags: ['Land'],
    availableFor: 'Explorer',
  })
  const sosOnly = makeDataset({
    id: 'sos',
    title: 'SOS Only Atmospheric Snapshot',
    tags: ['Air'],
    availableFor: 'SOS',
  })
  const hidden = makeDataset({
    id: 'hidden',
    title: 'Hidden Internal',
    tags: ['Water'],
    isHidden: true,
  })

  const catalog = [water, land, sosOnly, hidden]

  it('always excludes hidden datasets', () => {
    const result = filterDatasets(catalog, {}, '')
    expect(result.map(d => d.id)).not.toContain('hidden')
  })

  it('excludes SOS-only datasets by default (inverse-default for includeSos)', () => {
    const result = filterDatasets(catalog, {}, '')
    expect(result.map(d => d.id).sort()).toEqual(['land', 'water'])
  })

  it('includes SOS-only datasets when includeSos opts in', () => {
    const state: FilterState = { includeSos: { kind: 'boolean', value: true } }
    const result = filterDatasets(catalog, state, '')
    expect(result.map(d => d.id).sort()).toEqual(['land', 'sos', 'water'])
  })

  it('AND-combines facets across categories and search', () => {
    const state: FilterState = {
      category: { kind: 'multi-select', values: ['Water'] },
    }
    expect(filterDatasets(catalog, state, '').map(d => d.id)).toEqual(['water'])
    expect(filterDatasets(catalog, state, 'mars').map(d => d.id)).toEqual([])
    expect(filterDatasets(catalog, state, 'ocean').map(d => d.id)).toEqual(['water'])
  })

  it('silently ignores unknown facet keys (federation forward-compat)', () => {
    const state: FilterState = {
      futurePeerFacet: { kind: 'multi-select', values: ['x'] } as FacetPredicate,
    }
    // Unknown facet doesn't break filtering — the rest of the predicates apply.
    const result = filterDatasets(catalog, state, '')
    expect(result.length).toBeGreaterThan(0)
  })

  it('preserves input order', () => {
    const ordered = [land, water] // reversed from catalog
    const result = filterDatasets(ordered, {}, '')
    expect(result.map(d => d.id)).toEqual(['land', 'water'])
  })

  it('accepts a custom resolver map without losing baseline behaviour when composed', () => {
    const ngssDataset = makeDataset({ id: 'ng', tags: ['Water'] })
    const ngssGrade: (p: FacetPredicate, d: Dataset) => boolean = (predicate, d) =>
      predicate.kind === 'multi-select' && d.id === 'ng' && predicate.values.includes('5')
    const state: FilterState = {
      ngssGrade: { kind: 'multi-select', values: ['5'] },
    }
    const result = filterDatasets([ngssDataset, water], state, '', {
      ...BASELINE_RESOLVERS,
      ngssGrade,
    })
    expect(result.map(d => d.id)).toEqual(['ng'])
  })
})

describe('toggleFacet', () => {
  it('adds a new multi-select facet when absent', () => {
    const next = toggleFacet({}, 'category', 'Water')
    expect(next.category).toEqual({ kind: 'multi-select', values: ['Water'] })
  })

  it('adds a value to an existing multi-select', () => {
    const state: FilterState = { category: { kind: 'multi-select', values: ['Water'] } }
    const next = toggleFacet(state, 'category', 'Land')
    expect(next.category).toEqual({ kind: 'multi-select', values: ['Water', 'Land'] })
  })

  it('removes a value from an existing multi-select', () => {
    const state: FilterState = {
      category: { kind: 'multi-select', values: ['Water', 'Land'] },
    }
    const next = toggleFacet(state, 'category', 'Water')
    expect(next.category).toEqual({ kind: 'multi-select', values: ['Land'] })
  })

  it('removes the facet entirely when toggling the last value off', () => {
    const state: FilterState = { category: { kind: 'multi-select', values: ['Water'] } }
    const next = toggleFacet(state, 'category', 'Water')
    expect(next.category).toBeUndefined()
    expect('category' in next).toBe(false)
  })

  it('treats "on" and empty-string as ordinary multi-select values (no boolean magic)', () => {
    // Regression — earlier shape of toggleFacet treated
    // value === '' and value === 'on' as a signal to create a
    // boolean predicate. That collided with legitimate
    // multi-select values (e.g. a keyword called "on"). Boolean
    // facets now have a dedicated helper via toggleBooleanFacet.
    expect(toggleFacet({}, 'keyword', 'on')).toEqual({
      keyword: { kind: 'multi-select', values: ['on'] },
    })
    expect(toggleFacet({}, 'keyword', '')).toEqual({
      keyword: { kind: 'multi-select', values: [''] },
    })
  })

  it('clears an existing boolean facet when toggleFacet is called on it', () => {
    // The other half of the no-magic refactor: calling
    // toggleFacet on a boolean facet drops it. Callers that
    // want to flip a boolean use toggleBooleanFacet — splitting
    // the operations means the value string can never collide
    // with a control token.
    const state: FilterState = { hasCaptions: { kind: 'boolean', value: true } }
    const next = toggleFacet(state, 'hasCaptions', 'anything')
    expect(next.hasCaptions).toBeUndefined()
  })

  it('does not mutate the input state', () => {
    const state: FilterState = { category: { kind: 'multi-select', values: ['Water'] } }
    const snapshot = JSON.parse(JSON.stringify(state))
    toggleFacet(state, 'category', 'Land')
    expect(state).toEqual(snapshot)
  })

  it('leaves range and bbox facets unchanged (setFacet is the right entry point)', () => {
    const state: FilterState = {
      dateAdded: { kind: 'range', min: 2018, max: 2024 },
    }
    const next = toggleFacet(state, 'dateAdded', '2020')
    expect(next).toEqual(state)
  })
})

describe('toggleBooleanFacet', () => {
  it('adds a boolean predicate when the facet is absent', () => {
    expect(toggleBooleanFacet({}, 'hasCaptions')).toEqual({
      hasCaptions: { kind: 'boolean', value: true },
    })
  })

  it('removes the facet when an existing boolean predicate is toggled', () => {
    const state: FilterState = { hasCaptions: { kind: 'boolean', value: true } }
    const next = toggleBooleanFacet(state, 'hasCaptions')
    expect(next.hasCaptions).toBeUndefined()
  })

  it('replaces a non-boolean predicate with a boolean one', () => {
    // Edge case — if a multi-select predicate somehow exists
    // for a facet that's now treated as boolean, the toggle
    // converts it. Should be rare in practice (a facet's kind
    // is decided at resolver-registration time) but the
    // semantics need to be defined for the helper to be safe
    // to call indiscriminately.
    const state: FilterState = { hasCaptions: { kind: 'multi-select', values: ['x'] } }
    const next = toggleBooleanFacet(state, 'hasCaptions')
    expect(next.hasCaptions).toEqual({ kind: 'boolean', value: true })
  })

  it('does not mutate the input state', () => {
    const state: FilterState = { hasCaptions: { kind: 'boolean', value: true } }
    const snapshot = JSON.parse(JSON.stringify(state))
    toggleBooleanFacet(state, 'hasCaptions')
    expect(state).toEqual(snapshot)
  })
})

describe('setFacet', () => {
  it('sets a range predicate outright', () => {
    const next = setFacet({}, 'dateAdded', { kind: 'range', min: 2010, max: 2024 })
    expect(next.dateAdded).toEqual({ kind: 'range', min: 2010, max: 2024 })
  })

  it('replaces an existing predicate', () => {
    const state: FilterState = { dateAdded: { kind: 'range', min: 2010, max: 2020 } }
    const next = setFacet(state, 'dateAdded', { kind: 'range', min: 2018 })
    expect(next.dateAdded).toEqual({ kind: 'range', min: 2018 })
  })

  it('clears the facet when passed undefined', () => {
    const state: FilterState = { dateAdded: { kind: 'range', min: 2010 } }
    const next = setFacet(state, 'dateAdded', undefined)
    expect(next.dateAdded).toBeUndefined()
  })

  it('does not mutate the input', () => {
    const state: FilterState = { dateAdded: { kind: 'range', min: 2010 } }
    const snapshot = JSON.parse(JSON.stringify(state))
    setFacet(state, 'dateAdded', undefined)
    expect(state).toEqual(snapshot)
  })
})

describe('parseSearchQuery', () => {
  it('returns free-text unchanged when no prefixes are present', () => {
    const parsed = parseSearchQuery('hurricane forecast')
    expect(parsed.freeText).toBe('hurricane forecast')
    expect(parsed.prefixes).toEqual({})
  })

  it('extracts a category prefix', () => {
    const parsed = parseSearchQuery('category:Water hurricane')
    expect(parsed.freeText).toBe('hurricane')
    expect(parsed.prefixes.category).toEqual({ kind: 'multi-select', values: ['Water'] })
  })

  it('combines multiple prefixes of the same key into one multi-select', () => {
    const parsed = parseSearchQuery('category:Water category:Land storm')
    expect(parsed.prefixes.category).toEqual({
      kind: 'multi-select',
      values: ['Water', 'Land'],
    })
    expect(parsed.freeText).toBe('storm')
  })

  it('supports quoted values for multi-word category names', () => {
    const parsed = parseSearchQuery('category:"snow and ice"')
    expect(parsed.prefixes.category).toEqual({
      kind: 'multi-select',
      values: ['snow and ice'],
    })
  })

  it('maps period: tokens to ISO 8601 durations', () => {
    const parsed = parseSearchQuery('period:yearly period:monthly climate')
    expect(parsed.prefixes.period).toEqual({
      kind: 'multi-select',
      values: ['P1Y', 'P1M'],
    })
    expect(parsed.freeText).toBe('climate')
  })

  it('treats unrecognised period vocab as free-text', () => {
    const parsed = parseSearchQuery('period:fortnightly')
    expect(parsed.prefixes.period).toBeUndefined()
    expect(parsed.freeText).toBe('period:fortnightly')
  })

  it('treats unknown prefixes as literal substring search', () => {
    const parsed = parseSearchQuery('temp:hot')
    expect(parsed.prefixes).toEqual({})
    expect(parsed.freeText).toBe('temp:hot')
  })

  it('treats tokens with empty key or value as free-text', () => {
    expect(parseSearchQuery(':orphan').freeText).toBe(':orphan')
    expect(parseSearchQuery('category:').freeText).toBe('category:')
  })

  it('exports PERIOD_TOKEN_TO_ISO so callers can introspect the vocabulary', () => {
    expect(PERIOD_TOKEN_TO_ISO.yearly).toBe('P1Y')
    expect(PERIOD_TOKEN_TO_ISO.daily).toBe('P1D')
    expect(PERIOD_TOKEN_TO_ISO.hourly).toBe('PT1H')
  })
})

describe('PERIOD_RESOLVER', () => {
  it('matches Dataset.period against the parsed ISO values', () => {
    const d = makeDataset({ period: 'P1Y' })
    expect(PERIOD_RESOLVER({ kind: 'multi-select', values: ['P1Y'] }, d)).toBe(true)
    expect(PERIOD_RESOLVER({ kind: 'multi-select', values: ['P1M'] }, d)).toBe(false)
  })

  it('integrates with filterDatasets when registered alongside baseline resolvers', () => {
    const yearly = makeDataset({ id: 'y', period: 'P1Y' })
    const monthly = makeDataset({ id: 'm', period: 'P1M' })
    const parsed = parseSearchQuery('period:yearly')
    const result = filterDatasets([yearly, monthly], parsed.prefixes, parsed.freeText, {
      ...BASELINE_RESOLVERS,
      period: PERIOD_RESOLVER,
    })
    expect(result.map(d => d.id)).toEqual(['y'])
  })

  it('predicate is silently dropped when no resolver is registered (forward-compat)', () => {
    const d = makeDataset({ period: 'P1Y' })
    const parsed = parseSearchQuery('period:yearly')
    // Filter without PERIOD_RESOLVER — the predicate is unknown so the engine skips it.
    const result = filterDatasets([d], parsed.prefixes, parsed.freeText)
    expect(result.map(x => x.id)).toEqual(['test-1'])
  })
})

describe('mergeFilterStates', () => {
  it('unions multi-select values when both states key the same facet', () => {
    // Chip Water + prefix Land should match either, not just
    // the overlay — otherwise the chip rail (which renders from
    // `base` alone) would show Water as active while only Land
    // filters, surprising the user.
    const base: FilterState = {
      category: { kind: 'multi-select', values: ['Water'] },
    }
    const overlay: FilterState = {
      category: { kind: 'multi-select', values: ['Land'] },
    }
    const merged = mergeFilterStates(base, overlay)
    expect(merged.category).toEqual({
      kind: 'multi-select',
      values: ['Water', 'Land'],
    })
  })

  it('de-duplicates when the same value appears in both states', () => {
    const base: FilterState = {
      category: { kind: 'multi-select', values: ['Water', 'Air'] },
    }
    const overlay: FilterState = {
      category: { kind: 'multi-select', values: ['Air', 'Land'] },
    }
    const merged = mergeFilterStates(base, overlay)
    expect(merged.category).toEqual({
      kind: 'multi-select',
      values: ['Water', 'Air', 'Land'],
    })
  })

  it('overlay wins per-facet when the predicate kinds differ', () => {
    // Prefix search only emits multi-select today, so a
    // differing-kind merge isn't reachable through the production
    // pipeline. Spec'd here so future predicate kinds we add to
    // the prefix parser fall into the override branch by default
    // rather than silently doing the wrong thing.
    const base: FilterState = {
      dateAdded: { kind: 'range', min: 2010, max: 2020 },
    }
    const overlay: FilterState = {
      dateAdded: { kind: 'multi-select', values: ['x'] },
    }
    const merged = mergeFilterStates(base, overlay)
    expect(merged.dateAdded).toEqual({ kind: 'multi-select', values: ['x'] })
  })

  it('passes through facets present only in base or overlay', () => {
    const base: FilterState = {
      category: { kind: 'multi-select', values: ['Water'] },
    }
    const overlay: FilterState = {
      hasCaptions: { kind: 'boolean', value: true },
    }
    const merged = mergeFilterStates(base, overlay)
    expect(merged.category).toEqual({ kind: 'multi-select', values: ['Water'] })
    expect(merged.hasCaptions).toEqual({ kind: 'boolean', value: true })
  })

  it('returns a new object (no mutation)', () => {
    const base: FilterState = { category: { kind: 'multi-select', values: ['Water'] } }
    const snapshot = JSON.parse(JSON.stringify(base))
    mergeFilterStates(base, { hasCaptions: { kind: 'boolean', value: true } })
    expect(base).toEqual(snapshot)
  })
})
