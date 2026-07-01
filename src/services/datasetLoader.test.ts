import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { displayDatasetInfo } from './datasetLoader'
import type { Dataset } from '../types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'test-1',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data.mp4',
    ...overrides,
  }
}

function setupInfoDOM(): void {
  document.body.innerHTML = `
    <div id="info-panel" class="hidden">
      <div id="info-header" tabindex="0" aria-expanded="false">
        <span id="info-title"></span>
      </div>
      <div id="info-body"></div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// displayDatasetInfo — HTML rendering and event wiring
// ---------------------------------------------------------------------------
describe('displayDatasetInfo', () => {
  beforeEach(() => {
    setupInfoDOM()
    // `displayDatasetInfo` fires an async semantic-related fetch
    // (Phase 3b progressive enhancement). Stub it to a degraded
    // response so the enhancement no-ops on the lexical list these
    // tests assert on — and so no real socket is opened in CI.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ datasets: [], degraded: 'unconfigured' }) }) as unknown as Response),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the info panel and sets the title', () => {
    const dataset = makeDataset({ title: 'Ocean Currents' })
    displayDatasetInfo(dataset, [], vi.fn())

    const panel = document.getElementById('info-panel')!
    expect(panel.classList.contains('hidden')).toBe(false)
    expect(document.getElementById('info-title')!.textContent).toBe('Ocean Currents')
  })

  it('displays source from enriched metadata', () => {
    const dataset = makeDataset({
      enriched: {
        datasetDeveloper: { name: 'NOAA PMEL' },
      },
    })
    displayDatasetInfo(dataset, [], vi.fn())

    const body = document.getElementById('info-body')!
    expect(body.innerHTML).toContain('NOAA PMEL')
  })

  it('falls back to organization when no enriched developer', () => {
    const dataset = makeDataset({ organization: 'NASA JPL' })
    displayDatasetInfo(dataset, [], vi.fn())

    const body = document.getElementById('info-body')!
    expect(body.innerHTML).toContain('NASA JPL')
  })

  it('truncates long descriptions', () => {
    const longDesc = 'A'.repeat(700)
    const dataset = makeDataset({
      enriched: { description: longDesc },
    })
    displayDatasetInfo(dataset, [], vi.fn())

    const body = document.getElementById('info-body')!
    const desc = body.querySelector('.info-description')!
    expect(desc.textContent!.length).toBeLessThan(700)
    expect(desc.textContent).toContain('…')
  })

  it('renders legend image with accessible attributes', () => {
    const dataset = makeDataset({
      legendLink: 'https://example.com/legend.png',
    })
    displayDatasetInfo(dataset, [], vi.fn())

    const thumb = document.querySelector('.info-legend-thumb') as HTMLImageElement
    expect(thumb).not.toBeNull()
    expect(thumb.src).toContain('legend.png')
    expect(thumb.getAttribute('role')).toBe('button')
    expect(thumb.getAttribute('aria-label')).toBe('Enlarge Sea Surface Temperature legend')
  })

  it('renders categories from enriched metadata', () => {
    const dataset = makeDataset({
      enriched: {
        categories: { 'Atmosphere': ['Temperature', 'Pressure'] },
      },
    })
    displayDatasetInfo(dataset, [], vi.fn())

    const cats = document.querySelector('.info-categories')!
    expect(cats.textContent).toContain('Atmosphere')
    expect(cats.textContent).toContain('Temperature')
  })

  it('renders keyword chips', () => {
    const dataset = makeDataset({
      enriched: {
        keywords: ['SST', 'ocean', 'climate'],
      },
    })
    displayDatasetInfo(dataset, [], vi.fn())

    const keywords = document.querySelectorAll('.info-keyword')
    expect(keywords.length).toBe(3)
    expect(keywords[0].textContent).toBe('SST')
  })

  it('renders related datasets as clickable links', () => {
    const allDatasets = [
      makeDataset({ id: 'related-1', title: 'Ocean Currents' }),
    ]
    const dataset = makeDataset({
      enriched: {
        relatedDatasets: [{ title: 'Ocean Currents', url: '' }],
      },
    })

    displayDatasetInfo(dataset, allDatasets, vi.fn())

    const link = document.querySelector('a[data-dataset-id="related-1"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.textContent).toBe('Ocean Currents')
  })

  it('calls onLoadDataset when a related dataset link is clicked', () => {
    const onLoad = vi.fn()
    const allDatasets = [
      makeDataset({ id: 'related-1', title: 'Wind Patterns' }),
    ]
    const dataset = makeDataset({
      enriched: {
        relatedDatasets: [{ title: 'Wind Patterns', url: '' }],
      },
    })

    displayDatasetInfo(dataset, allDatasets, onLoad)

    const link = document.querySelector('a[data-dataset-id="related-1"]') as HTMLAnchorElement
    link.click()

    expect(onLoad).toHaveBeenCalledWith('related-1')
  })

  it('swaps in the semantic ordering and re-wires the new links when the endpoint returns matches', async () => {
    // Non-degraded semantic response, deliberately reversed vs. the
    // lexical (alphabetical) order so the assertion proves the SEMANTIC
    // ordering won, not just that some list rendered.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ datasets: [{ id: 'sem-B' }, { id: 'sem-A' }] }),
      }) as unknown as Response),
    )

    const onLoad = vi.fn()
    const target = makeDataset({ id: 'target', enriched: { categories: { Ocean: ['Temperature'] } } })
    const catalog = [
      target,
      makeDataset({ id: 'sem-A', title: 'Aaa Semantic', enriched: { categories: { Ocean: ['Temperature'] } } }),
      makeDataset({ id: 'sem-B', title: 'Bbb Semantic', enriched: { categories: { Ocean: ['Temperature'] } } }),
    ]

    displayDatasetInfo(target, catalog, onLoad)
    // The lexical list renders synchronously in catalog order (A, B);
    // drain the async semantic enhancement (fetch → json → re-render).
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

    const ids = Array.from(document.querySelectorAll('.info-related a[data-dataset-id]')).map(
      l => l.getAttribute('data-dataset-id'),
    )
    expect(ids).toEqual(['sem-B', 'sem-A']) // semantic ordering, replacing the lexical A,B

    // The freshly-rendered links are wired to onLoadDataset.
    const first = document.querySelector('.info-related a[data-dataset-id="sem-B"]') as HTMLAnchorElement
    first.click()
    expect(onLoad).toHaveBeenCalledWith('sem-B')
  })

  it('renders catalog link when available', () => {
    const dataset = makeDataset({
      enriched: { catalogUrl: 'https://sos.noaa.gov/catalog/datasets/sst/' },
    })
    displayDatasetInfo(dataset, [], vi.fn())

    const link = document.querySelector('.info-catalog-link') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.href).toContain('sos.noaa.gov')
    expect(link.textContent).toContain('View in SOS catalog')
  })

  // ---------------------------------------------------------------
  // Phase 2 §4 — info panel completeness
  // ---------------------------------------------------------------

  it('renders the source organisation as its own row', () => {
    const dataset = makeDataset({ organization: 'NASA JPL' })
    displayDatasetInfo(dataset, [], vi.fn())
    const source = document.querySelector('.info-source')
    expect(source).not.toBeNull()
    expect(source!.textContent).toBe('NASA JPL')
  })

  it('renders Developed by + Visualization by + Added in the credits section', () => {
    const dataset = makeDataset({
      enriched: {
        datasetDeveloper: { name: 'NOAA PMEL', affiliationUrl: 'https://pmel.noaa.gov' },
        visDeveloper: { name: 'CIRES' },
        dateAdded: '2024-06-15',
      },
    })
    displayDatasetInfo(dataset, [], vi.fn())

    const labels = Array.from(document.querySelectorAll('.info-credit-label')).map((el) => el.textContent)
    expect(labels).toEqual(['Developed by', 'Visualization by', 'Added'])

    const values = Array.from(document.querySelectorAll('.info-credit-value')).map((el) => el.textContent)
    expect(values).toEqual(['NOAA PMEL', 'CIRES', '2024-06-15'])

    // Affiliation URL renders as a clickable link when present.
    const link = document.querySelector('.info-credit-value a') as HTMLAnchorElement
    expect(link.href).toBe('https://pmel.noaa.gov/')
    expect(link.textContent).toBe('NOAA PMEL')
  })

  it('omits the credits section entirely when no credit fields are populated', () => {
    displayDatasetInfo(makeDataset(), [], vi.fn())
    expect(document.querySelector('.info-credits')).toBeNull()
    // The label is still allowed elsewhere (e.g. "Links" section);
    // assert specifically against the Credits heading.
    const labels = Array.from(document.querySelectorAll('.info-section-label')).map((el) => el.textContent)
    expect(labels).not.toContain('Credits')
  })

  it('renders a "Show more" toggle and swaps to the full description on click', () => {
    const longDesc = 'A'.repeat(900)
    const dataset = makeDataset({ enriched: { description: longDesc } })
    displayDatasetInfo(dataset, [], vi.fn())

    const desc = document.querySelector('.info-description') as HTMLElement
    const toggle = document.querySelector('.info-description-toggle') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.textContent).toBe('Show more')
    expect(desc.textContent!.endsWith('…')).toBe(true)

    toggle.click()
    expect(toggle.textContent).toBe('Show less')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(desc.textContent).toBe(longDesc)

    toggle.click()
    expect(toggle.textContent).toBe('Show more')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(desc.textContent!.endsWith('…')).toBe(true)
  })

  it('does not render a toggle for short descriptions', () => {
    const dataset = makeDataset({ enriched: { description: 'Brief description.' } })
    displayDatasetInfo(dataset, [], vi.fn())
    expect(document.querySelector('.info-description-toggle')).toBeNull()
  })

  it('renders the thumbnail with a download link', () => {
    const dataset = makeDataset({
      title: 'Sea Ice',
      thumbnailLink: 'https://example.com/thumb.jpg',
    })
    displayDatasetInfo(dataset, [], vi.fn())

    const wrapper = document.querySelector('.info-thumbnail-download') as HTMLAnchorElement
    expect(wrapper).not.toBeNull()
    expect(wrapper.href).toContain('thumb.jpg')
    expect(wrapper.hasAttribute('download')).toBe(true)
    expect(wrapper.getAttribute('aria-label')).toBe('Download thumbnail')

    const img = wrapper.querySelector('img.info-thumbnail') as HTMLImageElement
    expect(img.src).toContain('thumb.jpg')
    expect(img.alt).toBe('Sea Ice thumbnail')
  })

  it('augments related datasets with algorithmic recommendations', () => {
    const target = makeDataset({
      id: 'target',
      title: 'Sea Surface Temperature',
      enriched: {
        categories: { Ocean: ['Temperature'] },
        keywords: ['sst', 'climate'],
      },
    })
    const manualMatch = makeDataset({
      id: 'manual',
      title: 'Manually Curated',
      enriched: { categories: { Ocean: ['Temperature'] } },
    })
    const algorithmicMatch = makeDataset({
      id: 'algorithmic',
      title: 'Ocean Currents',
      enriched: { categories: { Ocean: ['Temperature'] }, keywords: ['climate'] },
    })

    const targetWithManual = {
      ...target,
      enriched: {
        ...target.enriched!,
        relatedDatasets: [{ title: 'Manually Curated', url: '' }],
      },
    } as Dataset

    displayDatasetInfo(targetWithManual, [targetWithManual, manualMatch, algorithmicMatch], vi.fn())

    const links = Array.from(document.querySelectorAll('.info-related a[data-dataset-id]'))
    const ids = links.map((l) => (l as HTMLElement).dataset.datasetId)
    // Manual entry renders first, algorithmic recommendation second.
    expect(ids).toEqual(['manual', 'algorithmic'])
  })

  it('renders a "Captions available" badge when closedCaptionLink is set', () => {
    const dataset = makeDataset({ closedCaptionLink: 'https://example.com/captions.srt' })
    displayDatasetInfo(dataset, [], vi.fn())
    const badge = document.querySelector('.info-captions-badge')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toContain('Captions available')
  })

  it('omits the captions badge when closedCaptionLink is empty', () => {
    displayDatasetInfo(makeDataset(), [], vi.fn())
    expect(document.querySelector('.info-captions-badge')).toBeNull()
  })

  it('preserves ?catalog=true when a related-dataset link is clicked', () => {
    const onLoad = vi.fn()
    const target = makeDataset({
      id: 'target',
      enriched: { relatedDatasets: [{ title: 'Wind', url: '' }] },
    })
    const related = makeDataset({ id: 'related-1', title: 'Wind' })

    window.history.replaceState({}, '', '/?catalog=true&dataset=target')
    displayDatasetInfo(target, [related], onLoad)

    const link = document.querySelector('a[data-dataset-id="related-1"]') as HTMLAnchorElement
    link.click()

    expect(onLoad).toHaveBeenCalledWith('related-1')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('catalog')).toBe('true')
    expect(params.get('dataset')).toBe('related-1')
  })

  it('toggles expand/collapse when header is clicked', () => {
    displayDatasetInfo(makeDataset(), [], vi.fn())

    const panel = document.getElementById('info-panel')!
    const header = document.getElementById('info-header')!

    expect(panel.classList.contains('expanded')).toBe(false)

    header.click()
    expect(panel.classList.contains('expanded')).toBe(true)
    expect(header.getAttribute('aria-expanded')).toBe('true')

    header.click()
    expect(panel.classList.contains('expanded')).toBe(false)
    expect(header.getAttribute('aria-expanded')).toBe('false')
  })

  it('does nothing when DOM elements are missing', () => {
    document.body.innerHTML = ''
    expect(() => displayDatasetInfo(makeDataset(), [], vi.fn())).not.toThrow()
  })
})

describe('displayDatasetInfo — "In the news"', () => {
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)) }
  const NEWS_EVENT = {
    id: 'E1',
    title: 'Marine heatwave off the coast',
    source: { name: 'NOAA', url: 'https://example.gov/heatwave', publishedAt: '2026-06-25T00:00:00Z' },
    occurredStart: '2026-06-25T12:00:00Z',
    geometry: {},
    datasetIds: ['ds-news'],
  }

  /** Route the per-dataset events endpoint to `events`; everything else
   *  (the semantic-related enhancement) degrades. */
  function stubFetchWithEvents(events: unknown[]): void {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/events') ? { events } : { datasets: [], degraded: 'unconfigured' }
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    }))
  }

  beforeEach(() => { setupInfoDOM() })
  afterEach(async () => { vi.unstubAllGlobals(); await import('./eventsService').then(m => m.resetDatasetEventsCacheForTests()) })

  it('renders an "In the news" section when the dataset has approved events', async () => {
    stubFetchWithEvents([NEWS_EVENT])
    displayDatasetInfo(makeDataset({ id: 'ds-news' }), [], vi.fn())
    await flush()
    const body = document.getElementById('info-body')!
    const section = body.querySelector('.info-in-the-news-section')
    expect(section).not.toBeNull()
    expect(section!.querySelector('.info-news-title')!.textContent).toBe('Marine heatwave off the coast')
    const link = section!.querySelector('.info-news-source') as HTMLAnchorElement
    expect(link.href).toContain('example.gov/heatwave')
  })

  it('removes the placeholder when the dataset has no events (graceful absence)', async () => {
    stubFetchWithEvents([])
    displayDatasetInfo(makeDataset({ id: 'ds-quiet' }), [], vi.fn())
    await flush()
    expect(document.getElementById('info-body')!.querySelector('.info-in-the-news-section')).toBeNull()
  })

  it('renders a "View on globe" button when the event has a place/time', async () => {
    stubFetchWithEvents([NEWS_EVENT])
    displayDatasetInfo(makeDataset({ id: 'ds-news' }), [], vi.fn(), vi.fn())
    await flush()
    const body = document.getElementById('info-body')!
    expect(body.querySelector('.info-news-locate')).not.toBeNull()
    // The out-of-range note ships hidden until a click reports it.
    expect((body.querySelector('.info-news-note') as HTMLElement).hidden).toBe(true)
  })

  it('omits the button for an event with neither geometry nor time', async () => {
    stubFetchWithEvents([{ ...NEWS_EVENT, occurredStart: undefined, geometry: {} }])
    displayDatasetInfo(makeDataset({ id: 'ds-news' }), [], vi.fn(), vi.fn())
    await flush()
    expect(document.getElementById('info-body')!.querySelector('.info-news-locate')).toBeNull()
  })

  it('invokes onNavigateToEvent with the event when the button is clicked', async () => {
    stubFetchWithEvents([NEWS_EVENT])
    const onNav = vi.fn(() => ({ navigated: true, time: 'seeked' as const }))
    displayDatasetInfo(makeDataset({ id: 'ds-news' }), [], vi.fn(), onNav)
    await flush()
    ;(document.querySelector('.info-news-locate') as HTMLButtonElement).click()
    expect(onNav).toHaveBeenCalledTimes(1)
    expect(onNav.mock.calls[0][0]).toMatchObject({ id: 'E1' })
  })

  it('reveals the note only when the seek reports out-of-range', async () => {
    stubFetchWithEvents([NEWS_EVENT])
    const onNav = vi.fn(() => ({ navigated: true, time: 'out-of-range' as const }))
    displayDatasetInfo(makeDataset({ id: 'ds-news' }), [], vi.fn(), onNav)
    await flush()
    const btn = document.querySelector('.info-news-locate') as HTMLButtonElement
    const note = btn.parentElement!.querySelector('.info-news-note') as HTMLElement
    expect(note.hidden).toBe(true)
    btn.click()
    expect(note.hidden).toBe(false)
  })

  it('keeps the note hidden when the seek succeeds', async () => {
    stubFetchWithEvents([NEWS_EVENT])
    const onNav = vi.fn(() => ({ navigated: true, time: 'seeked' as const }))
    displayDatasetInfo(makeDataset({ id: 'ds-news' }), [], vi.fn(), onNav)
    await flush()
    const btn = document.querySelector('.info-news-locate') as HTMLButtonElement
    btn.click()
    const note = btn.parentElement!.querySelector('.info-news-note') as HTMLElement
    expect(note.hidden).toBe(true)
  })
})
