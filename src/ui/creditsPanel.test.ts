// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  composeDatasetAttribution,
  readBasemapAttributions,
  readDatasetAttribution,
  setDatasetCreditsSource,
  linkifyAttribution,
  openCreditsPanel,
  closeCreditsPanel,
  isCreditsPanelOpen,
  disposeCreditsPanel,
  DATASET_CREDITS_SOURCE_ID,
} from './creditsPanel'
import type { Dataset } from '../types'

// Top-level cleanup: any test that calls openCreditsPanel needs
// disposeCreditsPanel to run so the module-scoped `mounted` flag
// resets before the next test. Local describe-level afterEach
// blocks aren't enough — a panel left mounted in one describe
// would block opens in a later describe (the open call returns
// early when mounted is already true).
afterEach(() => {
  disposeCreditsPanel()
})

// ---------------------------------------------------------------------------
// composeDatasetAttribution — pure-function tests
// ---------------------------------------------------------------------------

function ds(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'test',
    title: 'Test Dataset',
    format: 'image/jpg',
    dataLink: 'https://example.com/data.jpg',
    ...overrides,
  }
}

describe('composeDatasetAttribution', () => {
  it('returns just the title when no other metadata is present', () => {
    expect(composeDatasetAttribution(ds())).toBe('Test Dataset')
  })

  it('includes organization as the data provider when no datasetDeveloper is set', () => {
    const result = composeDatasetAttribution(ds({ organization: 'NOAA NCEI' }))
    expect(result).toBe('Test Dataset · Data: NOAA NCEI')
  })

  it('prefers enriched.datasetDeveloper.name over organization for the data provider', () => {
    const result = composeDatasetAttribution(ds({
      organization: 'NOAA NCEI',
      enriched: { datasetDeveloper: { name: 'Eric Hackathorn' } },
    }))
    expect(result).toBe('Test Dataset · Data: Eric Hackathorn')
  })

  it('appends the visualization developer when present', () => {
    const result = composeDatasetAttribution(ds({
      organization: 'NOAA',
      enriched: { visDeveloper: { name: 'Eric Hackathorn' } },
    }))
    expect(result).toBe('Test Dataset · Data: NOAA · Vis: Eric Hackathorn')
  })

  it('uses websiteLink as the source URL when available', () => {
    const result = composeDatasetAttribution(ds({
      organization: 'NOAA',
      websiteLink: 'https://example.com/dataset',
    }))
    expect(result).toBe('Test Dataset · Data: NOAA · Source: https://example.com/dataset')
  })

  it('falls back to enriched.catalogUrl when websiteLink is absent', () => {
    const result = composeDatasetAttribution(ds({
      enriched: { catalogUrl: 'https://example.com/catalog/123' },
    }))
    expect(result).toBe('Test Dataset · Source: https://example.com/catalog/123')
  })

  it('renders all four fields together when all are populated', () => {
    const result = composeDatasetAttribution(ds({
      title: 'Sea-Surface Temperature',
      organization: 'NOAA NCEI',
      websiteLink: 'https://example.com/sst',
      enriched: {
        datasetDeveloper: { name: 'NOAA NCEI' },
        visDeveloper: { name: 'Eric Hackathorn' },
      },
    }))
    expect(result).toBe(
      'Sea-Surface Temperature · Data: NOAA NCEI · Vis: Eric Hackathorn · Source: https://example.com/sst'
    )
  })

  it('skips empty / whitespace fields rather than rendering empty parts', () => {
    const result = composeDatasetAttribution(ds({
      organization: '   ',
      websiteLink: '',
      enriched: { datasetDeveloper: { name: '' }, visDeveloper: { name: '  ' } },
    }))
    expect(result).toBe('Test Dataset')
  })
})

// ---------------------------------------------------------------------------
// setDatasetCreditsSource — phantom-source register / clear
// ---------------------------------------------------------------------------

/** Minimal MapLibre map mock with the four methods the helper calls. */
function makeMockMap() {
  const sources = new Map<string, { type: string; data: unknown; attribution?: string }>()
  return {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, src: { type: string; data: unknown; attribution?: string }) => {
      sources.set(id, src)
    },
    removeSource: (id: string) => {
      sources.delete(id)
    },
    getStyle: () => ({
      sources: Object.fromEntries(sources.entries()),
    }),
    /** Test-only inspection. */
    _sources: sources,
  }
}

describe('setDatasetCreditsSource', () => {
  it('adds a phantom GeoJSON source with the composed attribution string', () => {
    const map = makeMockMap()
    setDatasetCreditsSource(map, ds({ organization: 'NOAA' }))

    const src = map.getSource(DATASET_CREDITS_SOURCE_ID) as { type: string; attribution: string }
    expect(src).toBeDefined()
    expect(src.type).toBe('geojson')
    expect(src.attribution).toBe('Test Dataset · Data: NOAA')
  })

  it('replaces an existing credits source when called with a different dataset', () => {
    const map = makeMockMap()
    setDatasetCreditsSource(map, ds({ id: 'a', title: 'Old Dataset' }))
    setDatasetCreditsSource(map, ds({ id: 'b', title: 'New Dataset' }))

    const src = map.getSource(DATASET_CREDITS_SOURCE_ID) as { attribution: string }
    expect(src.attribution).toBe('New Dataset')
    // Single source — replace, not accumulate.
    expect(map._sources.size).toBe(1)
  })

  it('removes the credits source when called with null', () => {
    const map = makeMockMap()
    setDatasetCreditsSource(map, ds({ organization: 'NOAA' }))
    expect(map.getSource(DATASET_CREDITS_SOURCE_ID)).toBeDefined()

    setDatasetCreditsSource(map, null)
    expect(map.getSource(DATASET_CREDITS_SOURCE_ID)).toBeUndefined()
  })

  it('is a no-op when called with null on a map that has no credits source', () => {
    const map = makeMockMap()
    setDatasetCreditsSource(map, null)
    expect(map._sources.size).toBe(0)
  })

  it('tolerates a null map (no-op, no throw)', () => {
    expect(() => setDatasetCreditsSource(null, ds())).not.toThrow()
    expect(() => setDatasetCreditsSource(null, null)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// readBasemapAttributions / readDatasetAttribution
// ---------------------------------------------------------------------------

function makeReadOnlyMap(sources: Record<string, { attribution?: string }>) {
  return { getStyle: () => ({ sources }) }
}

describe('readBasemapAttributions', () => {
  it('returns every basemap source attribution declared on the style, de-duped', () => {
    const map = makeReadOnlyMap({
      'blue-marble': { attribution: 'NASA Blue Marble' },
      'black-marble': { attribution: 'NASA Black Marble' },
      'openmaptiles': { attribution: '© OpenMapTiles · © OSM' },
    })
    expect(readBasemapAttributions(map)).toEqual([
      'NASA Blue Marble',
      'NASA Black Marble',
      '© OpenMapTiles · © OSM',
    ])
  })

  it('excludes the phantom dataset-credits source', () => {
    const map = makeReadOnlyMap({
      'blue-marble': { attribution: 'NASA Blue Marble' },
      [DATASET_CREDITS_SOURCE_ID]: { attribution: 'Some Dataset · Data: NOAA' },
    })
    expect(readBasemapAttributions(map)).toEqual(['NASA Blue Marble'])
  })

  it('de-duplicates identical attribution strings', () => {
    const map = makeReadOnlyMap({
      'a': { attribution: 'Same' },
      'b': { attribution: 'Same' },
    })
    expect(readBasemapAttributions(map)).toEqual(['Same'])
  })

  it('skips sources whose attribution is missing or whitespace', () => {
    const map = makeReadOnlyMap({
      'a': { attribution: '   ' },
      'b': {},
      'c': { attribution: 'Real' },
    })
    expect(readBasemapAttributions(map)).toEqual(['Real'])
  })

  it('returns empty for null map', () => {
    expect(readBasemapAttributions(null)).toEqual([])
  })
})

describe('readDatasetAttribution', () => {
  it('returns the phantom dataset-credits source attribution when present', () => {
    const map = makeReadOnlyMap({
      [DATASET_CREDITS_SOURCE_ID]: { attribution: 'Test · Data: NOAA' },
    })
    expect(readDatasetAttribution(map)).toBe('Test · Data: NOAA')
  })

  it('returns null when no dataset is loaded', () => {
    const map = makeReadOnlyMap({ 'blue-marble': { attribution: 'NASA' } })
    expect(readDatasetAttribution(map)).toBeNull()
  })

  it('returns null for null map', () => {
    expect(readDatasetAttribution(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// linkifyAttribution — render attribution with safe clickable URLs
// ---------------------------------------------------------------------------

describe('linkifyAttribution', () => {
  it('returns escaped plain text when no URL is present', () => {
    expect(linkifyAttribution('NASA Blue Marble')).toBe('NASA Blue Marble')
    // HTML special chars in surrounding text are still escaped.
    expect(linkifyAttribution('Some <thing>')).toBe('Some &lt;thing&gt;')
  })

  it('wraps a bare https URL in an anchor with target=_blank and rel=noopener noreferrer', () => {
    const out = linkifyAttribution('https://example.com/dataset')
    expect(out).toContain('<a href="https://example.com/dataset"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('>https://example.com/dataset</a>')
  })

  it('preserves and anchors a URL embedded in attribution context', () => {
    const out = linkifyAttribution('SST · Data: NOAA · Source: https://example.com/sst')
    expect(out).toContain('SST · Data: NOAA · Source: ')
    expect(out).toContain('<a href="https://example.com/sst"')
  })

  it('does not anchor non-http(s) schemes — javascript: passes through as escaped text', () => {
    // javascript: doesn't match URL_RE, so it gets escaped as plain text.
    const out = linkifyAttribution('Click javascript:alert(1) here')
    expect(out).not.toContain('<a ')
    expect(out).toBe('Click javascript:alert(1) here')
  })

  it('does not anchor data: URLs', () => {
    const out = linkifyAttribution('See data:text/html,<script>alert(1)</script>')
    expect(out).not.toContain('<a ')
    // The HTML in the data: URL is escaped as plain text.
    expect(out).toContain('&lt;script&gt;')
  })

  it('escapes the href value to prevent attribute-quote breakout', () => {
    // A URL containing a quote could otherwise close the href
    // attribute and inject markup. escapeAttr neutralises it.
    const out = linkifyAttribution('https://example.com/"><img src=x>')
    // The literal " inside the URL is escaped before landing in href.
    expect(out).toContain('&quot;')
    // The "><img src=x> tail is text-escaped, not rendered.
    expect(out).not.toContain('<img src=x>')
  })

  it('escapes HTML in the visible URL text segment', () => {
    // Even though the regex stops at whitespace, the URL itself
    // may contain `<`/`>`/`&` if the publisher mis-typed. The
    // anchor's text content escapes them.
    const out = linkifyAttribution('https://example.com/<script>')
    expect(out).toContain('&lt;script&gt;')
    // No actual <script> tag in the rendered output.
    const div = document.createElement('div')
    div.innerHTML = out
    expect(div.querySelector('script')).toBeNull()
  })

  it('handles multiple URLs in one attribution string', () => {
    const out = linkifyAttribution('A: https://a.example · B: https://b.example')
    expect((out.match(/<a /g) || []).length).toBe(2)
    expect(out).toContain('href="https://a.example"')
    expect(out).toContain('href="https://b.example"')
  })

  it('integrates into the rendered panel — datasets with a websiteLink get a clickable Source', () => {
    const viewports = makeViewports([
      makeReadOnlyMap({
        [DATASET_CREDITS_SOURCE_ID]: { attribution: 'SST · Data: NOAA · Source: https://example.com/sst' },
      }),
    ])
    openCreditsPanel(viewports)

    const datasetEl = document.querySelector('.credits-dataset')!
    const anchor = datasetEl.querySelector('a')
    expect(anchor).not.toBeNull()
    expect(anchor!.getAttribute('href')).toBe('https://example.com/sst')
    expect(anchor!.getAttribute('target')).toBe('_blank')
    expect(anchor!.getAttribute('rel')).toBe('noopener noreferrer')
    expect(anchor!.textContent).toBe('https://example.com/sst')
  })

  it('integrates with the XSS-shape attribution from openCreditsPanel — no script execution', () => {
    const viewports = makeViewports([
      makeReadOnlyMap({
        [DATASET_CREDITS_SOURCE_ID]: { attribution: '<img onerror=alert(1)> · Source: javascript:alert(2)' },
      }),
    ])
    openCreditsPanel(viewports)

    // No anchor was generated for the javascript: URL.
    const dataset = document.querySelector('.credits-dataset')!
    expect(dataset.querySelector('a')).toBeNull()
    // The raw <img> markup is text-escaped, not rendered.
    expect(dataset.innerHTML).toContain('&lt;img')
    expect(dataset.querySelector('img')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// openCreditsPanel — DOM rendering + lifecycle
// ---------------------------------------------------------------------------

/** Builds a minimal viewports stub satisfying the openCreditsPanel
 *  interface — getAll() returns renderers; each renderer's getMap()
 *  returns one of the read-only mocks above. */
function makeViewports(maps: Array<{ getStyle: () => { sources: Record<string, { attribution?: string }> } }>) {
  return {
    getAll: () => maps.map(m => ({ getMap: () => m })),
    getPanelCount: () => maps.length,
  } as unknown as Parameters<typeof openCreditsPanel>[0]
}

describe('openCreditsPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    disposeCreditsPanel()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders a single Basemap section listing every source attribution', () => {
    const viewports = makeViewports([
      makeReadOnlyMap({
        'blue-marble': { attribution: 'NASA Blue Marble' },
        'osm': { attribution: '© OpenStreetMap contributors' },
      }),
    ])

    openCreditsPanel(viewports)

    const items = Array.from(document.querySelectorAll('.credits-list li')).map(el => el.textContent)
    expect(items).toContain('NASA Blue Marble')
    expect(items).toContain('© OpenStreetMap contributors')
  })

  it('does not render a Loaded section when no dataset is loaded on a single panel', () => {
    const viewports = makeViewports([
      makeReadOnlyMap({ 'blue-marble': { attribution: 'NASA' } }),
    ])
    openCreditsPanel(viewports)

    // Only the Basemap section header should be present.
    const titles = Array.from(document.querySelectorAll('.credits-section-title')).map(el => el.textContent)
    expect(titles).toEqual(['Basemap'])
  })

  it('renders a "Loaded dataset" section when a dataset is loaded on a single panel', () => {
    const viewports = makeViewports([
      makeReadOnlyMap({
        'blue-marble': { attribution: 'NASA Blue Marble' },
        [DATASET_CREDITS_SOURCE_ID]: { attribution: 'SST · Data: NOAA' },
      }),
    ])
    openCreditsPanel(viewports)

    const titles = Array.from(document.querySelectorAll('.credits-section-title')).map(el => el.textContent)
    expect(titles).toEqual(['Basemap', 'Loaded dataset'])

    const datasetEl = document.querySelector('.credits-dataset')
    expect(datasetEl?.textContent).toBe('SST · Data: NOAA')
  })

  it('groups dataset attributions per panel in multi-panel layouts', () => {
    const viewports = makeViewports([
      makeReadOnlyMap({
        'blue-marble': { attribution: 'NASA Blue Marble' },
        [DATASET_CREDITS_SOURCE_ID]: { attribution: 'SST · Data: NOAA' },
      }),
      makeReadOnlyMap({
        'blue-marble': { attribution: 'NASA Blue Marble' },
        [DATASET_CREDITS_SOURCE_ID]: { attribution: 'SSP5 · Data: IPCC' },
      }),
    ])
    openCreditsPanel(viewports)

    const titles = Array.from(document.querySelectorAll('.credits-section-title')).map(el => el.textContent)
    expect(titles).toEqual(['Basemap', 'Loaded — Panel 1', 'Loaded — Panel 2'])

    const datasets = Array.from(document.querySelectorAll('.credits-dataset')).map(el => el.textContent)
    expect(datasets).toEqual(['SST · Data: NOAA', 'SSP5 · Data: IPCC'])
  })

  it('shows "No dataset loaded" placeholders for empty panels in multi-panel layouts', () => {
    const viewports = makeViewports([
      makeReadOnlyMap({ 'blue-marble': { attribution: 'NASA' } }),
      makeReadOnlyMap({
        'blue-marble': { attribution: 'NASA' },
        [DATASET_CREDITS_SOURCE_ID]: { attribution: 'Loaded' },
      }),
    ])
    openCreditsPanel(viewports)

    const titles = Array.from(document.querySelectorAll('.credits-section-title')).map(el => el.textContent)
    expect(titles).toEqual(['Basemap', 'Loaded — Panel 1', 'Loaded — Panel 2'])
    const empties = Array.from(document.querySelectorAll('.credits-empty')).map(el => el.textContent)
    expect(empties).toContain('No dataset loaded.')
  })

  it('merges identical basemap attributions across panels', () => {
    const viewports = makeViewports([
      makeReadOnlyMap({ 'blue-marble': { attribution: 'NASA Blue Marble' } }),
      makeReadOnlyMap({ 'blue-marble': { attribution: 'NASA Blue Marble' } }),
    ])
    openCreditsPanel(viewports)

    const items = Array.from(document.querySelectorAll('.credits-list li'))
      .map(el => el.textContent)
      .filter(t => t === 'NASA Blue Marble')
    expect(items.length).toBe(1)
  })

  it('escapes HTML in attribution strings to prevent XSS', () => {
    const viewports = makeViewports([
      makeReadOnlyMap({ 'evil': { attribution: '<img onerror=alert(1)>' } }),
    ])
    openCreditsPanel(viewports)

    const item = document.querySelector('.credits-list li')!
    // Rendered text is the literal escaped string, not an <img> tag.
    expect(item.innerHTML).toContain('&lt;img')
    expect(document.querySelector('.credits-list img')).toBeNull()
  })

  it('is idempotent — a second call while open is a no-op', () => {
    const viewports = makeViewports([
      makeReadOnlyMap({ 'blue-marble': { attribution: 'NASA' } }),
    ])
    openCreditsPanel(viewports)
    openCreditsPanel(viewports)

    expect(document.querySelectorAll('#credits-panel').length).toBe(1)
  })

  it('isCreditsPanelOpen reports the open state', () => {
    const viewports = makeViewports([makeReadOnlyMap({ 'b': { attribution: 'A' } })])
    expect(isCreditsPanelOpen()).toBe(false)
    openCreditsPanel(viewports)
    expect(isCreditsPanelOpen()).toBe(true)
    closeCreditsPanel()
    expect(isCreditsPanelOpen()).toBe(false)
  })

  it('clicking the close button closes the panel', () => {
    const viewports = makeViewports([makeReadOnlyMap({ 'b': { attribution: 'A' } })])
    openCreditsPanel(viewports)

    const closeBtn = document.getElementById('credits-panel-close') as HTMLButtonElement
    closeBtn.click()

    expect(document.getElementById('credits-panel')).toBeNull()
    expect(isCreditsPanelOpen()).toBe(false)
  })

  it('Escape key closes the panel', () => {
    const viewports = makeViewports([makeReadOnlyMap({ 'b': { attribution: 'A' } })])
    openCreditsPanel(viewports)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(document.getElementById('credits-panel')).toBeNull()
    expect(isCreditsPanelOpen()).toBe(false)
  })

  it('clicking the backdrop closes the panel', () => {
    const viewports = makeViewports([makeReadOnlyMap({ 'b': { attribution: 'A' } })])
    openCreditsPanel(viewports)

    const backdrop = document.getElementById('credits-backdrop') as HTMLElement
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.getElementById('credits-panel')).toBeNull()
  })

  it('Tab cycles focus from the last focusable back to the first (focus trap)', () => {
    const viewports = makeViewports([makeReadOnlyMap({ 'b': { attribution: 'A' } })])
    openCreditsPanel(viewports)

    const focusables = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#credits-panel button:not([disabled]), #credits-panel [href], #credits-panel [tabindex]:not([tabindex="-1"])',
      ),
    )
    expect(focusables.length).toBeGreaterThanOrEqual(2)

    const last = focusables[focusables.length - 1]
    last.focus()
    expect(document.activeElement).toBe(last)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(focusables[0])
  })

  it('Shift-Tab cycles focus from the first focusable back to the last (focus trap)', () => {
    const viewports = makeViewports([makeReadOnlyMap({ 'b': { attribution: 'A' } })])
    openCreditsPanel(viewports)

    const focusables = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#credits-panel button:not([disabled]), #credits-panel [href], #credits-panel [tabindex]:not([tabindex="-1"])',
      ),
    )
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    first.focus()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(last)
  })

  it('Escape stops propagation so global ESC handlers above document do not also fire', () => {
    const viewports = makeViewports([makeReadOnlyMap({ 'b': { attribution: 'A' } })])
    openCreditsPanel(viewports)

    let outerSawEscape = false
    const outer = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') outerSawEscape = true
    }
    window.addEventListener('keydown', outer)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    window.removeEventListener('keydown', outer)
    expect(outerSawEscape).toBe(false)
    expect(isCreditsPanelOpen()).toBe(false)
  })

  it('restores focus to the trigger element when closed', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const viewports = makeViewports([makeReadOnlyMap({ 'b': { attribution: 'A' } })])
    openCreditsPanel(viewports, trigger)
    closeCreditsPanel()

    expect(document.activeElement).toBe(trigger)
  })

  it('labels the panel as a modal dialog with an accessible name', () => {
    const viewports = makeViewports([makeReadOnlyMap({ 'b': { attribution: 'A' } })])
    openCreditsPanel(viewports)

    const panel = document.getElementById('credits-panel')!
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.getAttribute('aria-labelledby')).toBe('credits-panel-title')
    expect(document.getElementById('credits-panel-title')?.textContent).toBe('Credits')
  })
})
