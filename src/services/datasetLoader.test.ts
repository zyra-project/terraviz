import { describe, it, expect, vi, beforeEach } from 'vitest'
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
    expect(thumb.getAttribute('aria-label')).toBe('Enlarge legend')
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
    expect(link.textContent).toContain('View on NOAA SOS')
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
