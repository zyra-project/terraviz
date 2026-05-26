import { describe, it, expect, beforeEach } from 'vitest'
import {
  FACET_URL_KEYS,
  applyFilterStateToUrl,
  decodeFilterState,
  encodeFilterState,
  readFilterStateFromUrl,
} from './catalogFilters'
import type { FilterState } from '../services/datasetFilter'

describe('encodeFilterState', () => {
  it('returns an empty URLSearchParams for empty state and query', () => {
    const params = encodeFilterState({}, '')
    expect(params.toString()).toBe('')
  })

  it('emits the search query under "q"', () => {
    const params = encodeFilterState({}, 'hurricane forecast')
    expect(params.get('q')).toBe('hurricane forecast')
  })

  it('trims the search query', () => {
    const params = encodeFilterState({}, '   hurricane   ')
    expect(params.get('q')).toBe('hurricane')
  })

  it('encodes multi-select facets as comma-separated values under short keys', () => {
    const state: FilterState = {
      category: { kind: 'multi-select', values: ['Water', 'Land'] },
      format: { kind: 'multi-select', values: ['video'] },
    }
    const params = encodeFilterState(state, '')
    expect(params.get('cat')).toBe('Water,Land')
    expect(params.get('fmt')).toBe('video')
  })

  it('omits multi-select facets with no values', () => {
    const state: FilterState = {
      category: { kind: 'multi-select', values: [] },
    }
    const params = encodeFilterState(state, '')
    expect(params.has('cat')).toBe(false)
  })

  it('encodes boolean facets as "1"', () => {
    const state: FilterState = {
      hasCaptions: { kind: 'boolean', value: true },
      includeSos: { kind: 'boolean', value: true },
    }
    const params = encodeFilterState(state, '')
    expect(params.get('cc')).toBe('1')
    expect(params.get('sos')).toBe('1')
  })

  it('encodes range facets as min-max', () => {
    const state: FilterState = {
      dateAdded: { kind: 'range', min: 2018, max: 2024 },
      dataCoverageYear: { kind: 'range', min: 1990 },
    }
    const params = encodeFilterState(state, '')
    expect(params.get('da')).toBe('2018-2024')
    expect(params.get('dcy')).toBe('1990-')
  })

  it('omits range facets with no bounds set', () => {
    const state: FilterState = {
      dateAdded: { kind: 'range' },
    }
    const params = encodeFilterState(state, '')
    expect(params.has('da')).toBe(false)
  })

  it('drops unknown facet keys (forward-compat with future client/peer facets)', () => {
    const state: FilterState = {
      futurePeerFacet: { kind: 'multi-select', values: ['x'] },
    }
    const params = encodeFilterState(state, '')
    expect(params.toString()).toBe('')
  })
})

describe('decodeFilterState', () => {
  it('returns empty state for empty params', () => {
    const { state, searchQuery } = decodeFilterState(new URLSearchParams(''))
    expect(state).toEqual({})
    expect(searchQuery).toBe('')
  })

  it('reads the search query from "q"', () => {
    const { searchQuery } = decodeFilterState(new URLSearchParams('q=hurricane'))
    expect(searchQuery).toBe('hurricane')
  })

  it('decodes multi-select facets from comma-separated values', () => {
    const { state } = decodeFilterState(new URLSearchParams('cat=Water,Land&fmt=video'))
    expect(state.category).toEqual({ kind: 'multi-select', values: ['Water', 'Land'] })
    expect(state.format).toEqual({ kind: 'multi-select', values: ['video'] })
  })

  it('drops empty segments in multi-select (trailing comma → no phantom value)', () => {
    const { state } = decodeFilterState(new URLSearchParams('cat=Water,'))
    expect(state.category).toEqual({ kind: 'multi-select', values: ['Water'] })
  })

  it('decodes boolean facets from "1" and accepts "true" defensively', () => {
    const a = decodeFilterState(new URLSearchParams('cc=1&tour=true'))
    expect(a.state.hasCaptions).toEqual({ kind: 'boolean', value: true })
    expect(a.state.hasTour).toEqual({ kind: 'boolean', value: true })
  })

  it('rejects non-truthy boolean values (no phantom predicate)', () => {
    const { state } = decodeFilterState(new URLSearchParams('cc=0'))
    expect(state.hasCaptions).toBeUndefined()
  })

  it('decodes range facets from min-max, including half-open forms', () => {
    expect(decodeFilterState(new URLSearchParams('da=2018-2024')).state.dateAdded)
      .toEqual({ kind: 'range', min: 2018, max: 2024 })
    expect(decodeFilterState(new URLSearchParams('da=2018-')).state.dateAdded)
      .toEqual({ kind: 'range', min: 2018 })
    expect(decodeFilterState(new URLSearchParams('da=-2024')).state.dateAdded)
      .toEqual({ kind: 'range', max: 2024 })
  })

  it('drops malformed range values without throwing', () => {
    const { state } = decodeFilterState(new URLSearchParams('da=foo-bar'))
    expect(state.dateAdded).toBeUndefined()
  })

  it('drops fully-empty ranges', () => {
    const { state } = decodeFilterState(new URLSearchParams('da=-'))
    expect(state.dateAdded).toBeUndefined()
  })

  it('silently ignores unrelated URL params (catalog=true, dataset=...)', () => {
    const { state, searchQuery } = decodeFilterState(
      new URLSearchParams('catalog=true&dataset=INTERNAL_SOS_1&q=storm&cat=Air'),
    )
    expect(searchQuery).toBe('storm')
    expect(state.category).toEqual({ kind: 'multi-select', values: ['Air'] })
    // No spurious entries for catalog/dataset.
    expect(Object.keys(state).sort()).toEqual(['category'])
  })
})

describe('encode/decode round-trip', () => {
  it('round-trips the full §6.3 example shape', () => {
    const state: FilterState = {
      category: { kind: 'multi-select', values: ['atmosphere', 'land'] },
      format: { kind: 'multi-select', values: ['video'] },
    }
    const query = 'ocean'
    const params = encodeFilterState(state, query)
    expect(params.toString()).toBe('q=ocean&cat=atmosphere%2Cland&fmt=video')
    const decoded = decodeFilterState(params)
    expect(decoded.state).toEqual(state)
    expect(decoded.searchQuery).toBe(query)
  })

  it('round-trips a mix of every predicate kind', () => {
    const state: FilterState = {
      category: { kind: 'multi-select', values: ['Water'] },
      keyword: { kind: 'multi-select', values: ['hurricane'] },
      format: { kind: 'multi-select', values: ['video', 'image'] },
      dateAdded: { kind: 'range', min: 2018, max: 2024 },
      dataCoverageYear: { kind: 'range', min: 1990 },
      hasCaptions: { kind: 'boolean', value: true },
      hasTour: { kind: 'boolean', value: true },
      includeSos: { kind: 'boolean', value: true },
    }
    const decoded = decodeFilterState(encodeFilterState(state, 'storm'))
    expect(decoded.state).toEqual(state)
    expect(decoded.searchQuery).toBe('storm')
  })

  it('every baseline facet has a registered URL key', () => {
    // Catches drift between datasetFilter.ts's BASELINE_RESOLVERS
    // and FACET_URL_KEYS — adding a baseline facet without a URL
    // key would silently disable URL persistence for it.
    const baselineFacets = [
      'category', 'keyword', 'format', 'dateAdded',
      'dataCoverageYear', 'hasCaptions', 'hasTour', 'includeSos',
      'geographicRegion',
    ]
    for (const facet of baselineFacets) {
      expect(FACET_URL_KEYS[facet]).toBeTruthy()
    }
  })

  it('round-trips a geographicRegion bbox predicate (§6.9 Map view)', () => {
    const state: FilterState = {
      geographicRegion: { kind: 'bbox', n: 40.5, s: 10.25, e: 30, w: -10.125 },
    }
    const params = encodeFilterState(state, '')
    // Compact NSEW form with comma separators; the dash separator
    // in encoded ranges doesn't collide because the bbox values
    // can be negative (the parser uses comma-splitting, not the
    // range-shape `min-max` regex).
    expect(params.get('gr')).toBe('40.5,10.25,30,-10.125')
    const decoded = decodeFilterState(params)
    expect(decoded.state).toEqual(state)
  })

  it('rejects malformed geographicRegion URL values', () => {
    // Wrong arity — three values, not four.
    expect(decodeFilterState(new URLSearchParams('gr=10,20,30')).state).toEqual({})
    // Non-numeric corner.
    expect(decodeFilterState(new URLSearchParams('gr=10,foo,30,40')).state).toEqual({})
    // Empty segment — `Number('')` is `0`, so without an explicit
    // empty-check the decoder would silently treat `gr=10,,30,40`
    // as `{n:10, s:0, e:30, w:40}` and the user wouldn't know
    // their hand-edited URL was malformed.
    expect(decodeFilterState(new URLSearchParams('gr=10,,30,40')).state).toEqual({})
    expect(decodeFilterState(new URLSearchParams('gr=,20,30,40')).state).toEqual({})
    expect(decodeFilterState(new URLSearchParams('gr=10,20,30,')).state).toEqual({})
    // Whitespace-only segments — same as empty after trim.
    expect(decodeFilterState(new URLSearchParams('gr=10, ,30,40')).state).toEqual({})
  })

  it('rounds geographicRegion bounds to 3 decimals on encode', () => {
    // Mirrors `camera.ts` precision so a high-resolution drag
    // doesn't leak fingerprinting bits into the URL.
    const state: FilterState = {
      geographicRegion: { kind: 'bbox', n: 40.123456789, s: 10, e: 30, w: -10 },
    }
    const params = encodeFilterState(state, '')
    expect(params.get('gr')).toBe('40.123,10,30,-10')
  })
})

// ---------------------------------------------------------------------------
// Side-effecting helpers — touch happy-dom's window.history/location.
// ---------------------------------------------------------------------------

describe('applyFilterStateToUrl / readFilterStateFromUrl', () => {
  beforeEach(() => {
    // Reset to a clean URL between tests so state from one test
    // can't leak into another. happy-dom preserves history across
    // the test file otherwise.
    window.history.replaceState(null, '', '/?catalog=true')
  })

  it('writes encoded params via history.replaceState', () => {
    applyFilterStateToUrl(
      { category: { kind: 'multi-select', values: ['Water'] } },
      'ocean',
    )
    expect(window.location.search).toContain('q=ocean')
    expect(window.location.search).toContain('cat=Water')
  })

  it('preserves unrelated query params (catalog=true, dataset=...)', () => {
    window.history.replaceState(null, '', '/?catalog=true&dataset=INTERNAL_SOS_1')
    applyFilterStateToUrl({ format: { kind: 'multi-select', values: ['video'] } }, '')
    expect(window.location.search).toContain('catalog=true')
    expect(window.location.search).toContain('dataset=INTERNAL_SOS_1')
    expect(window.location.search).toContain('fmt=video')
  })

  it('strips stale facet params when state no longer references them', () => {
    window.history.replaceState(null, '', '/?cat=Water&fmt=video&q=stale')
    // Apply a new state that has only the format facet — category
    // and search should both be cleared from the URL.
    applyFilterStateToUrl({ format: { kind: 'multi-select', values: ['image'] } }, '')
    expect(window.location.search).not.toContain('cat=')
    expect(window.location.search).not.toContain('q=')
    expect(window.location.search).toContain('fmt=image')
  })

  it('readFilterStateFromUrl round-trips with applyFilterStateToUrl', () => {
    const state: FilterState = {
      category: { kind: 'multi-select', values: ['Air', 'Water'] },
      hasCaptions: { kind: 'boolean', value: true },
      dateAdded: { kind: 'range', min: 2020, max: 2024 },
    }
    applyFilterStateToUrl(state, 'storm')
    const read = readFilterStateFromUrl()
    expect(read.state).toEqual(state)
    expect(read.searchQuery).toBe('storm')
  })

  it('is a no-op when the encoded URL matches current location', () => {
    applyFilterStateToUrl({ category: { kind: 'multi-select', values: ['Land'] } }, '')
    const before = window.location.search
    const historyState = window.history.state
    applyFilterStateToUrl({ category: { kind: 'multi-select', values: ['Land'] } }, '')
    expect(window.location.search).toBe(before)
    expect(window.history.state).toBe(historyState)
  })

  it('honours { replace: false } for callers that want a real history entry', () => {
    const before = window.history.length
    applyFilterStateToUrl(
      { category: { kind: 'multi-select', values: ['Water'] } },
      '',
      { replace: false },
    )
    // happy-dom increments history.length on pushState.
    expect(window.history.length).toBeGreaterThanOrEqual(before)
    expect(window.location.search).toContain('cat=Water')
  })
})
