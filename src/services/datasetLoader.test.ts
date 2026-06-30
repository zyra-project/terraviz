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
