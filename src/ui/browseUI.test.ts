import { describe, it, expect, vi, beforeEach } from 'vitest'
import { escapeHtml, escapeAttr, showBrowseUI, hideBrowseUI, type BrowseCallbacks } from './browseUI'
import type { Dataset } from '../types'

// Mock dataService — used only for isVideoDataset check in card rendering
vi.mock('../services/dataService', () => ({
  dataService: {
    isVideoDataset: vi.fn((d: Dataset) => d.format === 'video/mp4'),
  }
}))

// ---------------------------------------------------------------------------
// escapeHtml / escapeAttr
// ---------------------------------------------------------------------------
describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
  })

  it('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;')
  })

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('handles multiple special characters', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;')
  })
})

describe('escapeAttr', () => {
  it('escapes double quotes', () => {
    expect(escapeAttr('say "hello"')).toBe('say &quot;hello&quot;')
  })

  it('escapes single quotes', () => {
    expect(escapeAttr("it's")).toBe("it&#39;s")
  })

  it('escapes both quote types', () => {
    expect(escapeAttr(`"it's"`)).toBe('&quot;it&#39;s&quot;')
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'test-1',
    title: 'Test Dataset',
    format: 'image/jpg',
    dataLink: 'https://example.com/data.jpg',
    ...overrides,
  }
}

function setupBrowseDOM(): void {
  document.body.innerHTML = `
    <div id="browse-overlay" class="hidden">
      <div id="browse-category-bar"></div>
      <div id="browse-subcategory-bar"></div>
      <div id="browse-toolbar">
        <input id="browse-search" type="text">
        <button id="browse-search-clear" class="hidden"></button>
        <div id="browse-sort"></div>
      </div>
      <div id="browse-count"></div>
      <div id="browse-grid"></div>
    </div>
  `
}

function makeCallbacks(overrides: Partial<BrowseCallbacks> = {}): BrowseCallbacks {
  return {
    onSelectDataset: vi.fn(),
    announce: vi.fn(),
    isMobile: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// showBrowseUI
// ---------------------------------------------------------------------------
describe('showBrowseUI', () => {
  beforeEach(() => {
    setupBrowseDOM()
  })

  it('removes hidden class from overlay', () => {
    const overlay = document.getElementById('browse-overlay')!
    expect(overlay.classList.contains('hidden')).toBe(true)

    showBrowseUI([], makeCallbacks())

    expect(overlay.classList.contains('hidden')).toBe(false)
  })

  it('filters out hidden datasets', () => {
    const datasets = [
      makeDataset({ id: 'visible', title: 'Visible' }),
      makeDataset({ id: 'hidden', title: 'Hidden', isHidden: true }),
    ]

    showBrowseUI(datasets, makeCallbacks())

    const countEl = document.getElementById('browse-count')!
    expect(countEl.textContent).toBe('1 dataset')
  })

  it('shows "No datasets match" for empty results', () => {
    showBrowseUI([], makeCallbacks())

    const grid = document.getElementById('browse-grid')!
    expect(grid.innerHTML).toContain('No datasets match')
  })

  it('renders dataset cards with correct data attributes', () => {
    const datasets = [
      makeDataset({ id: 'ds-123', title: 'Ocean Temp' }),
    ]

    showBrowseUI(datasets, makeCallbacks())

    const card = document.querySelector('.browse-card') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.dataset.id).toBe('ds-123')
    expect(card.getAttribute('aria-label')).toBe('Ocean Temp')
  })

  it('renders category chips including "All"', () => {
    const datasets = [
      makeDataset({
        id: 'ds-1', title: 'A',
        enriched: { categories: { 'Atmosphere': ['Temperature'] } },
      }),
      makeDataset({
        id: 'ds-2', title: 'B',
        enriched: { categories: { 'Ocean': ['Currents'] } },
      }),
    ]

    showBrowseUI(datasets, makeCallbacks())

    const chips = document.querySelectorAll('.browse-chip')
    const labels = Array.from(chips).map(c => c.textContent)
    expect(labels).toContain('All')
    expect(labels).toContain('Atmosphere')
    expect(labels).toContain('Ocean')
  })

  it('sorts datasets by weight then title in relevance mode', () => {
    const datasets = [
      makeDataset({ id: 'a', title: 'Zebra', weight: 10 }),
      makeDataset({ id: 'b', title: 'Alpha', weight: 10 }),
      makeDataset({ id: 'c', title: 'Beta', weight: 20 }),
    ]

    showBrowseUI(datasets, makeCallbacks())

    const titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    // weight 20 first, then weight 10 alphabetically
    expect(titles).toEqual(['Beta', 'Alpha', 'Zebra'])
  })

  it('renders sort buttons', () => {
    showBrowseUI([makeDataset()], makeCallbacks())

    const sortBtns = document.querySelectorAll('.browse-sort-btn')
    expect(sortBtns.length).toBe(3)
    const labels = Array.from(sortBtns).map(b => b.textContent)
    expect(labels).toContain('Relevance')
    expect(labels).toContain('Newest')
    expect(labels).toContain('A\u2013Z')
  })

  it('calls onSelectDataset when Load button is clicked', () => {
    const callbacks = makeCallbacks()
    showBrowseUI([makeDataset({ id: 'ds-abc' })], callbacks)

    const loadBtn = document.querySelector('.browse-card-load') as HTMLElement
    loadBtn.click()

    expect(callbacks.onSelectDataset).toHaveBeenCalledWith('ds-abc')
  })

  it('escapes HTML in dataset titles to prevent XSS', () => {
    const datasets = [
      makeDataset({ id: 'xss', title: '<img onerror=alert(1)>' }),
    ]

    showBrowseUI(datasets, makeCallbacks())

    const titleEl = document.querySelector('.browse-card-title')!
    expect(titleEl.textContent).toBe('<img onerror=alert(1)>')
    // Should be escaped in HTML, not rendered as a tag
    expect(titleEl.innerHTML).toContain('&lt;img')
  })

  it('renders keywords as clickable chips', () => {
    const datasets = [
      makeDataset({
        id: 'kw-test', title: 'Keywords Test',
        enriched: { keywords: ['climate', 'temperature'] },
      }),
    ]

    showBrowseUI(datasets, makeCallbacks())

    // Expand the card first to see keywords
    const card = document.querySelector('.browse-card') as HTMLElement
    card.click()

    const kwEls = document.querySelectorAll('.browse-card-keyword')
    expect(kwEls.length).toBe(2)
    expect((kwEls[0] as HTMLElement).dataset.keyword).toBe('climate')
  })

  it('updates search placeholder with dataset count', () => {
    const datasets = [
      makeDataset({ id: 'a', title: 'A' }),
      makeDataset({ id: 'b', title: 'B' }),
      makeDataset({ id: 'c', title: 'C' }),
    ]

    showBrowseUI(datasets, makeCallbacks())

    const searchEl = document.getElementById('browse-search') as HTMLInputElement
    expect(searchEl.placeholder).toBe('Search 3 datasets\u2026')
  })
})

// ---------------------------------------------------------------------------
// hideBrowseUI
// ---------------------------------------------------------------------------
describe('hideBrowseUI', () => {
  it('adds hidden class to overlay', () => {
    document.body.innerHTML = '<div id="browse-overlay"></div>'
    hideBrowseUI()
    expect(document.getElementById('browse-overlay')!.classList.contains('hidden')).toBe(true)
  })

  it('does not throw when overlay is missing', () => {
    document.body.innerHTML = ''
    expect(() => hideBrowseUI()).not.toThrow()
  })
})
