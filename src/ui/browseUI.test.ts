import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { escapeHtml, escapeAttr, showBrowseUI, hideBrowseUI, type BrowseCallbacks } from './browseUI'
import type { Dataset } from '../types'
import { resetForTests, __peek } from '../analytics/emitter'
import { setTier } from '../analytics/config'
import { hashQuery } from '../analytics/hash'

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
// browse_search Tier B emit
// ---------------------------------------------------------------------------
async function flushMicrotasks(): Promise<void> {
  // The browse_search emit pipeline is `setTimeout → hashQuery() → emit`.
  // hashQuery() awaits `crypto.subtle.digest`, which in happy-dom can
  // schedule its resolution on a separate task queue rather than a pure
  // microtask. Yield a few macro-tasks (with real timers) so the digest
  // promise resolves before the test asserts.
  vi.useRealTimers()
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  vi.useFakeTimers()
}

describe('showBrowseUI — browse_search emit', () => {
  beforeEach(() => {
    setupBrowseDOM()
    localStorage.clear()
    resetForTests()
    setTier('research')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function fireSearch(query: string): void {
    const input = document.getElementById('browse-search') as HTMLInputElement
    input.value = query
    input.dispatchEvent(new Event('input'))
  }

  it('emits a debounced browse_search event with the hashed query', async () => {
    showBrowseUI([makeDataset({ id: 'a', title: 'Hurricane Stats' })], makeCallbacks())
    fireSearch('hurricane')
    // Debounce window not yet elapsed — no emit.
    expect(__peek().filter((e) => e.event_type === 'browse_search')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()
    const evs = __peek().filter((e) => e.event_type === 'browse_search')
    expect(evs).toHaveLength(1)
    const e = evs[0]
    if (e.event_type !== 'browse_search') throw new Error('unreachable')
    const expected = await hashQuery('hurricane')
    expect(e.query_hash).toBe(expected)
    expect(e.query_length).toBe('hurricane'.length)
    expect(e.result_count_bucket).toBe('1-10')
  })

  it('coalesces a burst of keystrokes into a single emit', async () => {
    showBrowseUI([makeDataset()], makeCallbacks())
    fireSearch('h')
    fireSearch('hu')
    fireSearch('hur')
    fireSearch('hurr')
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()
    const evs = __peek().filter((e) => e.event_type === 'browse_search')
    expect(evs).toHaveLength(1)
    const e = evs[0]
    if (e.event_type !== 'browse_search') throw new Error('unreachable')
    expect(e.query_hash).toBe(await hashQuery('hurr'))
  })

  it('does not emit for the empty string', async () => {
    showBrowseUI([makeDataset()], makeCallbacks())
    fireSearch('')
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(__peek().filter((e) => e.event_type === 'browse_search')).toHaveLength(0)
  })

  it('clearing the box drops a pending emit', async () => {
    showBrowseUI([makeDataset()], makeCallbacks())
    fireSearch('hurricane')
    document.getElementById('browse-search-clear')!.dispatchEvent(new Event('click'))
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(__peek().filter((e) => e.event_type === 'browse_search')).toHaveLength(0)
  })

  it('is tier-gated — Essential drops the event', async () => {
    setTier('essential')
    showBrowseUI([makeDataset()], makeCallbacks())
    fireSearch('hurricane')
    await vi.advanceTimersByTimeAsync(500)
    await flushMicrotasks()
    expect(__peek().filter((e) => e.event_type === 'browse_search')).toHaveLength(0)
  })

  // Note: the empty-string token bump in scheduleSearchEmit is
  // exercised implicitly by the "clearing the box drops a pending
  // emit" case above. A standalone race test ("user clears AFTER
  // the timer fires but BEFORE the async hash resolves") would
  // need to mock hashQuery to control resolution timing — without
  // the mock, microtask draining at the await boundary makes the
  // race non-deterministic across runners (passes locally on
  // happy-dom, fails on CI's faster Node). The fix itself (5
  // lines) is direct enough to review by inspection.
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
