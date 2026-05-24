import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { escapeHtml, escapeAttr, showBrowseUI, hideBrowseUI, notifyBrowseOpened, type BrowseCallbacks } from './browseUI'
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

// Mock the Graph view's lazy-loaded UI module. `browseUI.ts` uses
// `import('./catalogGraphUI')` on the first toggle into Graph view
// (or boot path when localStorage has `viewMode='graph'`). The real
// module pulls in cytoscape + cytoscape-cola, which under coverage
// instrumentation timing on CI can leak past the test boundary and
// cause flakiness in subsequent tests (the same shape as the
// real-timer leak fixed in 350f05c). Stubbing the module keeps the
// promise resolution synchronous and deterministic — tests that
// verify aria-pressed / localStorage / analytics on the toggle
// don't need (and shouldn't depend on) cytoscape actually loading.
//
// `graphMockHandles` is hoisted via `vi.hoisted` so it's defined
// before the factory below runs (vi.mock hoists). Tests reach into
// `graphMockHandles.update` to assert on calls. `update.mockClear()`
// per test keeps assertions independent.
const graphMockHandles = vi.hoisted(() => ({
  update: vi.fn(),
  destroy: vi.fn(),
  createCatalogGraph: vi.fn(),
}))
vi.mock('./catalogGraphUI', () => ({
  createCatalogGraph: graphMockHandles.createCatalogGraph.mockImplementation(() => ({
    update: graphMockHandles.update,
    destroy: graphMockHandles.destroy,
  })),
}))

// Mock the Timeline view's lazy-loaded UI module (§6.8). Same shape
// + reasoning as the graph mock above — d3-scale + d3-axis + d3-brush
// don't need to actually mount for the boot / toggle / persistence /
// analytics assertions in this suite. Stubbing keeps the dynamic
// import synchronous and the chunk small under coverage.
const timelineMockHandles = vi.hoisted(() => ({
  update: vi.fn(),
  destroy: vi.fn(),
  createCatalogTimeline: vi.fn(),
}))
vi.mock('./catalogTimelineUI', () => ({
  createCatalogTimeline: timelineMockHandles.createCatalogTimeline.mockImplementation(() => ({
    update: timelineMockHandles.update,
    destroy: timelineMockHandles.destroy,
  })),
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
      <input id="browse-search" type="text">
      <button id="browse-search-clear" class="hidden"></button>
      <div id="browse-filter-rail"></div>
      <div id="browse-toolbar">
        <div id="browse-view-mode"></div>
        <div id="browse-sort"></div>
      </div>
      <div id="browse-count"></div>
      <div id="browse-grid"></div>
      <div id="browse-graph" class="hidden"></div>
      <div id="browse-timeline" class="hidden"></div>
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
    // Reset URL between tests — the chip rail boots from
    // window.location.search via readFilterStateFromUrl(), so a
    // URL written by one test would leak chip / search state
    // into the next.
    window.history.replaceState(null, '', '/')
  })

  it('removes hidden class from overlay', () => {
    const overlay = document.getElementById('browse-overlay')!
    expect(overlay.classList.contains('hidden')).toBe(true)

    showBrowseUI([], makeCallbacks())

    expect(overlay.classList.contains('hidden')).toBe(false)
  })

  it('marks the overlay as initialized so re-show paths skip duplicate listener wiring', () => {
    const overlay = document.getElementById('browse-overlay')!
    expect(overlay.dataset.browseInitialized).toBeUndefined()

    showBrowseUI([], makeCallbacks())

    // openBrowsePanel in main.ts checks this exact flag to decide
    // whether to re-call showBrowseUI. Setting it inside
    // showBrowseUI itself means every call site is covered, not
    // just the ones that remembered to set it externally.
    expect(overlay.dataset.browseInitialized).toBe('true')
  })

  it('does not double-wire container listeners when called twice (e.g. goHome path)', () => {
    // goHome and any other re-show path that calls showBrowseUI
    // directly (instead of going through openBrowsePanel's
    // browseInitialized check) would otherwise stack a fresh
    // listener on each container element. Per-element dataset.wired
    // guards keep the wiring idempotent so each click fires
    // exactly one handler — and emits exactly one browse_filter
    // event — no matter how many times the panel has been re-shown.
    //
    // Phase 4 §6.5 — the chip rail is driven by the `tags` field
    // rather than `enriched.categories`, so the test fixture
    // tags the rows accordingly.
    localStorage.clear()
    resetForTests()
    setTier('research')

    const datasets = [
      makeDataset({ id: 'a', title: 'A', tags: ['Air'] }),
      makeDataset({ id: 'b', title: 'B', tags: ['Water'] }),
    ]

    showBrowseUI(datasets, makeCallbacks())
    showBrowseUI(datasets, makeCallbacks())
    showBrowseUI(datasets, makeCallbacks())

    // Click a category chip once — the click handler should fire
    // exactly once even though showBrowseUI ran three times.
    const airChip = Array.from(document.querySelectorAll('.browse-chip'))
      .find(el => el.textContent === 'Air') as HTMLElement
    airChip.click()

    const filterEvents = __peek().filter((e) => e.event_type === 'browse_filter')
    expect(filterEvents).toHaveLength(1)
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

  it('renders multi-select category chips from the tags field (no "All" sentinel)', () => {
    // Phase 4 §6.5 — the chip rail moved from single-select with
    // an "All" sentinel (where empty selection meant "show
    // everything") to multi-select where the same default is
    // expressed by no chip being active. Chips are driven by the
    // SOS `tags` taxonomy per §6.1, not by the hierarchical
    // `enriched.categories` field.
    const datasets = [
      makeDataset({ id: 'ds-1', title: 'A', tags: ['Air'] }),
      makeDataset({ id: 'ds-2', title: 'B', tags: ['Water'] }),
    ]

    showBrowseUI(datasets, makeCallbacks())

    const chips = document.querySelectorAll('.browse-chip')
    const labels = Array.from(chips).map(c => c.textContent)
    expect(labels).not.toContain('All')
    expect(labels).toContain('Air')
    expect(labels).toContain('Water')
    // No chip is active in the default state.
    const active = Array.from(chips).filter(c => c.classList.contains('active'))
    expect(active).toHaveLength(0)
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

  it('chip clicks accumulate into a multi-select facet (OR within the group)', () => {
    // Phase 4 §6.5 — multi-select. Clicking Air then Water shows
    // both Air-tagged AND Water-tagged datasets; clicking Air
    // again removes only Air, leaving Water alone.
    const datasets = [
      makeDataset({ id: 'a', title: 'Air row', tags: ['Air'] }),
      makeDataset({ id: 'w', title: 'Water row', tags: ['Water'] }),
      makeDataset({ id: 'l', title: 'Land row', tags: ['Land'] }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    const findChip = (label: string) =>
      Array.from(document.querySelectorAll('.browse-chip'))
        .find(el => el.textContent === label) as HTMLElement

    findChip('Air').click()
    expect(findChip('Air').getAttribute('aria-pressed')).toBe('true')
    let titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    expect(titles).toEqual(['Air row'])

    findChip('Water').click()
    titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    expect(titles.sort()).toEqual(['Air row', 'Water row'])

    // Toggle Air off — should leave Water as the only chip and
    // only Water-row in the results.
    findChip('Air').click()
    expect(findChip('Air').getAttribute('aria-pressed')).toBe('false')
    expect(findChip('Water').getAttribute('aria-pressed')).toBe('true')
    titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    expect(titles).toEqual(['Water row'])
  })

  it('boolean toggle chip filters datasets without the matching field', () => {
    // Has-captions toggle — should show only rows whose
    // closedCaptionLink is non-empty.
    const datasets = [
      makeDataset({ id: 'cc', title: 'With captions', closedCaptionLink: 'https://x/cc.srt' }),
      makeDataset({ id: 'no', title: 'No captions' }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    const toggle = document.querySelector('[data-facet="hasCaptions"]') as HTMLElement
    expect(toggle).not.toBeNull()
    toggle.click()

    const titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    expect(titles).toEqual(['With captions'])
  })

  it('SOS-only datasets are excluded by default and revealed by the include-SOS toggle', () => {
    // Phase 4 §6.4 — SOS source quality toggle defaults off so
    // today's surface doesn't grow without user consent. Flipping
    // it reveals the synthesised preview-quality rows.
    const datasets = [
      makeDataset({ id: 'x', title: 'Explorer row', availableFor: 'Explorer' }),
      makeDataset({ id: 's', title: 'SOS row', availableFor: 'SOS' }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    let titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    expect(titles).toEqual(['Explorer row'])

    const toggle = document.querySelector('[data-facet="includeSos"]') as HTMLElement
    expect(toggle).not.toBeNull()
    toggle.click()

    titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    expect(titles.sort()).toEqual(['Explorer row', 'SOS row'])
  })

  it('honours search-prefix syntax (category:Water hurricane)', () => {
    // §6.2 — `category:Water` filters by tag without lighting up
    // the Water chip (prefix is a parallel overlay, not a chip
    // mutation), and the remaining "hurricane" word substring-
    // matches the title/description.
    const datasets = [
      makeDataset({ id: 'wh', title: 'Hurricane in Water', tags: ['Water'] }),
      makeDataset({ id: 'ah', title: 'Hurricane in Air', tags: ['Air'] }),
      makeDataset({ id: 'w', title: 'Just Water', tags: ['Water'] }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    const input = document.getElementById('browse-search') as HTMLInputElement
    input.value = 'category:Water hurricane'
    input.dispatchEvent(new Event('input'))

    const titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    expect(titles).toEqual(['Hurricane in Water'])

    // Chip state isn't mutated — Water chip stays inactive.
    const water = Array.from(document.querySelectorAll('.browse-chip'))
      .find(c => c.textContent === 'Water') as HTMLElement
    expect(water.getAttribute('aria-pressed')).toBe('false')
  })

  it('honours period: prefix mapping (yearly → P1Y)', () => {
    const datasets = [
      makeDataset({ id: 'y', title: 'Yearly dataset', tags: ['Air'], period: 'P1Y' }),
      makeDataset({ id: 'm', title: 'Monthly dataset', tags: ['Air'], period: 'P1M' }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    const input = document.getElementById('browse-search') as HTMLInputElement
    input.value = 'period:yearly'
    input.dispatchEvent(new Event('input'))

    const titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    expect(titles).toEqual(['Yearly dataset'])
  })

  it('persists chip + search state to the URL via history.replaceState', () => {
    // Reset URL — the previous test in the file may have left
    // params on it through happy-dom's persistent location.
    window.history.replaceState(null, '', '/?catalog=true')
    const datasets = [
      makeDataset({ id: 'a', title: 'A', tags: ['Air'] }),
      makeDataset({ id: 'w', title: 'W', tags: ['Water'] }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    const airChip = Array.from(document.querySelectorAll('.browse-chip'))
      .find(el => el.textContent === 'Air') as HTMLElement
    airChip.click()

    // Verify the URL reflects the active chip + that unrelated
    // params (catalog=true) survive.
    expect(window.location.search).toContain('catalog=true')
    expect(window.location.search).toContain('cat=Air')

    // Type into the search box — URL also gets the `q=` param.
    const input = document.getElementById('browse-search') as HTMLInputElement
    input.value = 'storm'
    input.dispatchEvent(new Event('input'))
    expect(window.location.search).toContain('q=storm')
  })

  it('boots from URL — restores chip + search state on showBrowseUI', () => {
    window.history.replaceState(null, '', '/?catalog=true&cat=Water&q=ocean')
    const datasets = [
      makeDataset({ id: 'a', title: 'Air row', tags: ['Air'] }),
      makeDataset({ id: 'wo', title: 'Ocean Water', tags: ['Water'] }),
      makeDataset({ id: 'w', title: 'Plain Water', tags: ['Water'] }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    // Search box value comes back from the URL.
    const input = document.getElementById('browse-search') as HTMLInputElement
    expect(input.value).toBe('ocean')

    // Water chip is active, Air is not.
    const water = Array.from(document.querySelectorAll('.browse-chip'))
      .find(c => c.textContent === 'Water') as HTMLElement
    expect(water.getAttribute('aria-pressed')).toBe('true')

    // Visible cards reflect both the chip filter and the search.
    const titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    expect(titles).toEqual(['Ocean Water'])
  })

  it('renders typed-group sections as collapsible accordions with sane defaults', () => {
    // Per the user's feedback in PR review — the filter rail was
    // taking too much screen real estate. Each typed group is
    // now an accordion: Category & content opens by default,
    // others collapse to save vertical space, and each section's
    // open/collapsed state persists across sessions.
    localStorage.removeItem('sos-browse-section-open.v1')
    showBrowseUI([makeDataset({ tags: ['Air'] })], makeCallbacks())

    const sections = document.querySelectorAll('.browse-filter-section')
    expect(sections.length).toBe(4)
    const findSection = (group: string) =>
      document.querySelector(`.browse-filter-section[data-group="${group}"]`) as HTMLElement

    // Default: category open; format, time, quality collapsed.
    expect(findSection('category').classList.contains('collapsed')).toBe(false)
    expect(findSection('format').classList.contains('collapsed')).toBe(true)
    expect(findSection('time').classList.contains('collapsed')).toBe(true)
    expect(findSection('quality').classList.contains('collapsed')).toBe(true)

    // Header click toggles the section open/closed and updates
    // aria-expanded — the canonical accessibility signal.
    const formatHeader = findSection('format').querySelector('.browse-filter-section-header') as HTMLElement
    expect(formatHeader.getAttribute('aria-expanded')).toBe('false')
    formatHeader.click()
    expect(findSection('format').classList.contains('collapsed')).toBe(false)
    expect(
      (findSection('format').querySelector('.browse-filter-section-header') as HTMLElement)
        .getAttribute('aria-expanded'),
    ).toBe('true')

    // Persistence — the next call to showBrowseUI reads the same
    // localStorage and keeps Format open.
    const stored = JSON.parse(localStorage.getItem('sos-browse-section-open.v1') ?? '{}')
    expect(stored.format).toBe(true)
  })

  it('auto-expands the section matching a search-prefix at boot (?q=category:Water)', () => {
    // Per Copilot pass-2 review on PR #135 — the auto-expand
    // rule documented in the boot path claimed to consider
    // both URL-decoded facets AND prefix tokens in the search
    // query, but originally only saw the chip-state. A shared
    // ?q=category:Water link should now open the Category
    // section even though no chip is set.
    localStorage.removeItem('sos-browse-section-open.v1')
    window.history.replaceState(null, '', '/?q=category%3AWater')
    showBrowseUI([makeDataset({ tags: ['Water'] })], makeCallbacks())

    const category = document.querySelector('.browse-filter-section[data-group="category"]') as HTMLElement
    expect(category.classList.contains('collapsed')).toBe(false)
  })

  it('unions chip + prefix-search values on the same facet (overlay does not override)', () => {
    // Per Copilot pass-2 review on PR #135 — when a user has
    // the Water chip active and types `category:Land` in the
    // search box, the effective filter should match either
    // Water OR Land (union), not just Land (override). The
    // chip itself stays the visual source of truth and doesn't
    // light up Land — but the filter behaves additively so the
    // chip's selection isn't silently overridden.
    const datasets = [
      makeDataset({ id: 'a', title: 'Air row', tags: ['Air'] }),
      makeDataset({ id: 'w', title: 'Water row', tags: ['Water'] }),
      makeDataset({ id: 'l', title: 'Land row', tags: ['Land'] }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    const findChip = (label: string) =>
      Array.from(document.querySelectorAll('.browse-chip'))
        .find(el => el.textContent === label) as HTMLElement

    findChip('Water').click()
    const input = document.getElementById('browse-search') as HTMLInputElement
    input.value = 'category:Land'
    input.dispatchEvent(new Event('input'))

    const titles = Array.from(document.querySelectorAll('.browse-card-title'))
      .map(el => el.textContent)
    expect(titles.sort()).toEqual(['Land row', 'Water row'])

    // Chip rail still shows Water as the only active chip — the
    // prefix doesn't light up Land.
    expect(findChip('Water').getAttribute('aria-pressed')).toBe('true')
    expect(findChip('Land').getAttribute('aria-pressed')).toBe('false')
  })

  it('auto-expands a collapsed section when its facet has active filters', () => {
    // A shared URL deep-link that activates a hasCaptions chip
    // would otherwise hide the active chip behind the collapsed
    // Quality section — surprising on a shared link. The auto-
    // expand rule forces the section open when its facet is
    // active at boot.
    localStorage.removeItem('sos-browse-section-open.v1')
    window.history.replaceState(null, '', '/?cc=1')
    showBrowseUI([makeDataset({ closedCaptionLink: 'https://x' })], makeCallbacks())

    const quality = document.querySelector('.browse-filter-section[data-group="quality"]') as HTMLElement
    expect(quality.classList.contains('collapsed')).toBe(false)
  })

  it('shows an active-filter badge in the section header when chips are set', () => {
    // Even when a section is collapsed, the user needs to see
    // "there's something filtered here". The badge surfaces the
    // active count next to the title.
    localStorage.removeItem('sos-browse-section-open.v1')
    showBrowseUI(
      [
        makeDataset({ id: 'a', title: 'A', tags: ['Air'] }),
        makeDataset({ id: 'w', title: 'W', tags: ['Water'] }),
      ],
      makeCallbacks(),
    )

    // Toggle Air on — the Category section now has 1 active chip.
    const airChip = Array.from(document.querySelectorAll('.browse-chip'))
      .find(el => el.textContent === 'Air') as HTMLElement
    airChip.click()

    const categoryHeader = document.querySelector(
      '.browse-filter-section[data-group="category"] .browse-filter-section-header',
    ) as HTMLElement
    const badge = categoryHeader.querySelector('.browse-filter-section-badge')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toBe('1')

    // Toggle Water on — badge updates to 2.
    const waterChip = Array.from(document.querySelectorAll('.browse-chip'))
      .find(el => el.textContent === 'Water') as HTMLElement
    waterChip.click()
    expect(
      document.querySelector(
        '.browse-filter-section[data-group="category"] .browse-filter-section-badge',
      )!.textContent,
    ).toBe('2')
  })

  it('accordion toggle preserves partially-typed range input value (no rail re-render)', () => {
    // Per Copilot pass-4 review on PR #135 — the earlier shape
    // of the accordion handler called renderRail() which
    // rebuilt innerHTML. A partially-typed range value (no
    // change event yet) would have been thrown away when the
    // user collapsed the Time section. The new in-place class
    // toggle keeps the DOM input alive.
    localStorage.removeItem('sos-browse-section-open.v1')
    showBrowseUI([makeDataset({ tags: ['Air'] })], makeCallbacks())

    // Open the Time section so the inputs are visible.
    const timeHeader = document.querySelector(
      '.browse-filter-section[data-group="time"] .browse-filter-section-header',
    ) as HTMLElement
    timeHeader.click()

    const minInput = document.querySelector(
      '#browse-range-dateAdded-min',
    ) as HTMLInputElement
    expect(minInput).not.toBeNull()
    // Simulate a partial type without firing change (which would
    // commit the value to filterState via setFacet).
    minInput.value = '20'

    // Collapse Time, then re-open it.
    timeHeader.click()
    expect(
      document.querySelector('.browse-filter-section[data-group="time"]')!
        .classList.contains('collapsed'),
    ).toBe(true)
    timeHeader.click()

    // The same DOM input is still alive and still carries the
    // partially-typed `20`.
    const minInputAfter = document.querySelector(
      '#browse-range-dateAdded-min',
    ) as HTMLInputElement
    expect(minInputAfter).toBe(minInput) // same DOM node
    expect(minInputAfter.value).toBe('20')
  })

  it('browse_filter event surfaces the removed value when a multi-select last-chip toggles off', () => {
    // Per Copilot pass-4 review on PR #135 — facetDiff used to
    // return `${facet}:off` whenever a facet key disappeared,
    // which lost the toggled chip's value for dashboards
    // slicing on category:Water etc. Now multi-select removal
    // of the last value reports the value (boolean toggle-off
    // still reports `:off` since there's no value).
    localStorage.clear()
    resetForTests()
    setTier('research')

    const datasets = [
      makeDataset({ id: 'a', title: 'A', tags: ['Air'] }),
      makeDataset({ id: 'w', title: 'W', tags: ['Water'] }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    const findChip = (label: string) =>
      Array.from(document.querySelectorAll('.browse-chip'))
        .find(el => el.textContent === label) as HTMLElement

    // Toggle Water on, then off — the off-toggle should report
    // `category:Water`, not `category:off`.
    findChip('Water').click()
    findChip('Water').click()

    const filterEvents = __peek().filter((e) => e.event_type === 'browse_filter')
    // Most recent event should reflect the removal of Water.
    expect(filterEvents.length).toBeGreaterThanOrEqual(2)
    const removal = filterEvents[filterEvents.length - 1]
    if (removal.event_type !== 'browse_filter') throw new Error('unreachable')
    expect(removal.category).toBe('category:Water')
  })

  it('clear-all button resets the filter state and surfaces only when something is active', () => {
    const datasets = [
      makeDataset({ id: 'a', title: 'A', tags: ['Air'] }),
      makeDataset({ id: 'w', title: 'W', tags: ['Water'] }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    // Default: no clear-all visible.
    expect(document.getElementById('browse-filter-clear')).toBeNull()

    // Activate a filter — the clear button appears.
    const airChip = Array.from(document.querySelectorAll('.browse-chip'))
      .find(el => el.textContent === 'Air') as HTMLElement
    airChip.click()
    const clearBtn = document.getElementById('browse-filter-clear') as HTMLElement
    expect(clearBtn).not.toBeNull()

    clearBtn.click()
    expect(document.getElementById('browse-filter-clear')).toBeNull()
    // All chips inactive again.
    const active = Array.from(document.querySelectorAll('.browse-chip'))
      .filter(c => c.classList.contains('active'))
    expect(active).toHaveLength(0)
  })

  it('renders the abstract markdown as HTML in the full description and as plain text in the short preview', () => {
    // Smoke-test regression: a dataset published with the
    // abstract "This is a **test**." rendered as literal
    // asterisks on the card because `browseUI.ts` ran the
    // abstract through `escapeHtml` for both the short preview
    // and the full description. The full description now runs
    // through the same sanitized markdown renderer the
    // publisher portal uses; the short preview strips the
    // markdown to plain text so the truncation cut doesn't
    // leave a half-open `**`.
    setupBrowseDOM()
    const datasets = [
      makeDataset({
        id: 'md-test',
        title: 'Markdown abstract',
        enriched: { description: 'This is a **bold** word.' },
      }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    // Short preview: plain text, no asterisks.
    const shortDesc = document.querySelector('.browse-card-desc')
    expect(shortDesc?.textContent).toBe('This is a bold word.')
    expect(shortDesc?.innerHTML).not.toContain('**')
    expect(shortDesc?.innerHTML).not.toContain('<strong>')

    // Full description: rendered HTML with a real <strong> tag.
    const fullDesc = document.querySelector('.browse-card-full-desc')
    expect(fullDesc?.querySelector('strong')?.textContent).toBe('bold')
  })

  it('does not toggle card expand/collapse when a click lands inside a markdown link (incl. nested elements)', () => {
    // PR #115 Copilot review: now that abstracts render as
    // markdown, descriptions can include links with nested
    // inline elements (e.g. `[**docs**](url)` → `<a><strong>
    // docs</strong></a>`). The literal `tagName === 'A'`
    // guard missed clicks on the inner `<strong>` and let
    // the card toggle, which then ran the link's default
    // navigation AND collapsed the card. `closest('a')`
    // catches every shape of nested-element click.
    setupBrowseDOM()
    const datasets = [
      makeDataset({
        id: 'md-link',
        title: 'Markdown link',
        enriched: {
          description: 'See the [**docs**](https://example.com/docs).',
        },
      }),
    ]
    showBrowseUI(datasets, makeCallbacks())

    // The full description should contain a link with a nested
    // <strong> — proving the test setup matches the bug shape.
    const link = document.querySelector('.browse-card-full-desc a') as HTMLAnchorElement
    expect(link).not.toBeNull()
    const strongInsideLink = link.querySelector('strong')
    expect(strongInsideLink).not.toBeNull()

    // Capture the card's expanded state, click the <strong>
    // inside the link, confirm the card state didn't change.
    const card = document.querySelector('.browse-card') as HTMLElement
    const wasExpanded = card.classList.contains('expanded')
    strongInsideLink!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(card.classList.contains('expanded')).toBe(wasExpanded)
  })
})

// ---------------------------------------------------------------------------
// notifyBrowseOpened \u2014 re-open path helper
// ---------------------------------------------------------------------------
describe('notifyBrowseOpened', () => {
  beforeEach(() => {
    setupBrowseDOM()
    localStorage.clear()
    resetForTests()
    setTier('research')
  })

  it('emits browse_opened with the supplied source', () => {
    notifyBrowseOpened('orbit')
    const evs = __peek().filter((e) => e.event_type === 'browse_opened')
    expect(evs).toHaveLength(1)
    const e = evs[0]
    if (e.event_type !== 'browse_opened') throw new Error('unreachable')
    expect(e.source).toBe('orbit')
  })

  it('starts a dwell handle and is idempotent if already running', () => {
    // First call starts the handle. Second call is a no-op for
    // the handle but still emits browse_opened \u2014 the caller is
    // responsible for gating on real transitions.
    notifyBrowseOpened('tools')
    notifyBrowseOpened('tools')
    const dwells = __peek().filter((e) => e.event_type === 'dwell')
    // No dwell event yet (we haven't stopped). The handle should
    // still be the same one \u2014 dwell on stop should fire exactly
    // once when we eventually call hideBrowseUI.
    expect(dwells).toHaveLength(0)
    hideBrowseUI()
    const dwellsAfter = __peek().filter((e) => e.event_type === 'dwell')
    expect(dwellsAfter).toHaveLength(1)
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
  beforeEach(async () => {
    setupBrowseDOM()
    window.history.replaceState(null, '', '/')
    // Drain any pending real-timer callbacks scheduled by an
    // earlier test's search-input debounce. `scheduleSearchEmit`
    // lives in a per-showBrowseUI closure, so a previous test's
    // pending timer can't be cancelled from a new test's
    // closure — but waiting past the 400 ms debounce window
    // lets the callback fire (and its emit land BEFORE
    // resetForTests clears the analytics queue below). Without
    // this drain the stale emit lands inside this test's
    // __peek() and breaks the "exactly 1 event" assertions.
    // Surfaces only under coverage instrumentation timing in CI
    // (commit 9516823 / PR #135).
    await new Promise<void>(resolve => setTimeout(resolve, 500))
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

// ---------------------------------------------------------------------------
// View-mode toggle (Cards / Graph) — Phase 4 §6.7
//
// Covers persistence, mobile-hidden fallback, and the
// `catalog_view_mode_changed` emit. Doesn't exercise the cytoscape
// mount itself — that lives behind a lazy `import('./catalogGraphUI')`
// and a real cytoscape instance needs a layout engine that
// happy-dom can't run. We assert on the toggle's DOM contract +
// telemetry, and trust the cytoscape side to be exercised in a
// real browser smoke test.
// ---------------------------------------------------------------------------
describe('view-mode toggle', () => {
  const VIEW_MODE_KEY = 'sos-browse-view-mode.v1'

  beforeEach(async () => {
    // Drain any in-flight async work from the previous test before
    // we reset analytics state — `void applyViewMode()` in
    // showBrowseUI fire-and-forgets a Promise chain that goes
    // through the (mocked) `./catalogGraphUI` import when
    // viewMode='graph'. Under coverage instrumentation on slower
    // CI this chain can resolve INSIDE the next test's body and
    // emit into the new analytics queue (same shape as the
    // real-timer leak fix in 350f05c).
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    localStorage.clear()
    resetForTests()
    setTier('research')
    // Reset URL — the chip rail boots from `window.location.search`
    // via `readFilterStateFromUrl()`, so a `?cat=…&q=…` written by
    // an earlier test would silently filter our fixture datasets to
    // empty here and the result_count_bucket assertion would see 0
    // cards rather than 2.
    window.history.replaceState(null, '', '/')
  })

  afterEach(async () => {
    // Symmetric drain so the LAST view-mode test doesn't leak its
    // async chain into whatever describe-block runs after this one.
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    localStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  it('renders Cards + Graph + Timeline buttons when not mobile, with Cards active by default', () => {
    setupBrowseDOM()
    showBrowseUI([makeDataset({ id: 'a', tags: ['Air'] })], makeCallbacks())
    const bar = document.getElementById('browse-view-mode')!
    const buttons = bar.querySelectorAll<HTMLButtonElement>('.browse-view-mode-btn')
    expect(buttons).toHaveLength(3)
    const cardsBtn = bar.querySelector('[data-view-mode="cards"]')!
    const graphBtn = bar.querySelector('[data-view-mode="graph"]')!
    const timelineBtn = bar.querySelector('[data-view-mode="timeline"]')!
    expect(cardsBtn.getAttribute('aria-pressed')).toBe('true')
    expect(graphBtn.getAttribute('aria-pressed')).toBe('false')
    expect(timelineBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('hides the view-mode toggle on portrait mobile and falls back to Cards', () => {
    setupBrowseDOM()
    // Even with `graph` persisted, portrait mobile must render only
    // Cards. Stub matchMedia so the gate's orientation half also
    // matches (`isMobile=true` alone no longer suffices since the
    // PR #138 landscape parity change — Tauri/mobile in landscape
    // is allowed; only portrait gates back).
    localStorage.setItem(VIEW_MODE_KEY, 'graph')
    const originalMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({
      media: query,
      matches: query.includes('orientation: portrait'),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })) as unknown as typeof window.matchMedia
    try {
      showBrowseUI([makeDataset({ id: 'a', tags: ['Air'] })], makeCallbacks({ isMobile: true }))
      const bar = document.getElementById('browse-view-mode')!
      expect(bar.classList.contains('hidden')).toBe(true)
      expect(bar.querySelectorAll('.browse-view-mode-btn')).toHaveLength(0)
      // Grid remains the active surface; graph container stays hidden.
      expect(document.getElementById('browse-grid')!.classList.contains('hidden')).toBe(false)
      expect(document.getElementById('browse-graph')!.classList.contains('hidden')).toBe(true)
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('shows the view-mode toggle on landscape mobile so Graph + Timeline are reachable', () => {
    // PR #138 review follow-up: landscape feature parity. A phone in
    // landscape (e.g. 667×375 iPhone SE) clears the portrait-only
    // gate so a user testing from their phone can still toggle into
    // Graph and Timeline. Vertical space is tight but the surfaces
    // are usable for smoke testing — explicit goal of the change.
    setupBrowseDOM()
    localStorage.setItem(VIEW_MODE_KEY, 'graph')
    const originalMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({
      media: query,
      // Landscape — neither portrait-only nor the compound narrow+portrait
      // query matches.
      matches: false,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })) as unknown as typeof window.matchMedia
    try {
      showBrowseUI([makeDataset({ id: 'a', tags: ['Air'] })], makeCallbacks({ isMobile: true }))
      const bar = document.getElementById('browse-view-mode')!
      expect(bar.classList.contains('hidden')).toBe(false)
      // All three buttons render and Graph is active (restored from storage).
      expect(bar.querySelectorAll('.browse-view-mode-btn')).toHaveLength(3)
      expect(bar.querySelector('[data-view-mode="graph"]')!.getAttribute('aria-pressed')).toBe('true')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('falls back to Cards when window.matchMedia reports a narrow viewport even if callbacks.isMobile=false', () => {
    // Pre-fix, the gate was just `callbacks.isMobile` (a boot-time
    // flag from main.ts), so a desktop user who resized the
    // window narrower would leave the toggle visible AND the
    // graph in JS state but the CSS would hide #browse-graph
    // entirely — blank overlay. The fix unions matchMedia with
    // callbacks.isMobile so the boot path picks the right surface.
    setupBrowseDOM()
    localStorage.setItem(VIEW_MODE_KEY, 'graph')
    // Stub matchMedia BEFORE showBrowseUI so isNarrowViewport()
    // picks it up at boot.
    const originalMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({
      media: query,
      matches: query.includes('max-width: 768px'),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })) as unknown as typeof window.matchMedia
    try {
      showBrowseUI(
        [makeDataset({ id: 'a', tags: ['Air'] })],
        makeCallbacks({ isMobile: false }),
      )
      const bar = document.getElementById('browse-view-mode')!
      expect(bar.classList.contains('hidden')).toBe(true)
      expect(document.getElementById('browse-grid')!.classList.contains('hidden')).toBe(false)
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('restores `graph` from localStorage and marks Graph button active', () => {
    setupBrowseDOM()
    localStorage.setItem(VIEW_MODE_KEY, 'graph')
    showBrowseUI([makeDataset({ id: 'a', tags: ['Air'] })], makeCallbacks())
    const bar = document.getElementById('browse-view-mode')!
    expect(bar.querySelector('[data-view-mode="graph"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(bar.querySelector('[data-view-mode="cards"]')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('restores `timeline` from localStorage and marks Timeline button active', () => {
    setupBrowseDOM()
    localStorage.setItem(VIEW_MODE_KEY, 'timeline')
    showBrowseUI([makeDataset({ id: 'a', tags: ['Air'] })], makeCallbacks())
    const bar = document.getElementById('browse-view-mode')!
    expect(bar.querySelector('[data-view-mode="timeline"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(bar.querySelector('[data-view-mode="cards"]')!.getAttribute('aria-pressed')).toBe('false')
    expect(bar.querySelector('[data-view-mode="graph"]')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('normalises stale future view-modes (map) back to Cards', () => {
    // §6.9 Map isn't shipped yet. A stale entry in localStorage
    // (manual edit / future build / shared session) must not leave
    // every button un-pressed and the user stranded without an
    // active state. The full assertion chain: stored = `map`, but
    // UI lands on Cards.
    setupBrowseDOM()
    localStorage.setItem(VIEW_MODE_KEY, 'map')
    showBrowseUI([makeDataset({ id: 'a', tags: ['Air'] })], makeCallbacks())
    const bar = document.getElementById('browse-view-mode')!
    expect(bar.querySelector('[data-view-mode="cards"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(bar.querySelector('[data-view-mode="graph"]')!.getAttribute('aria-pressed')).toBe('false')
    expect(bar.querySelector('[data-view-mode="timeline"]')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('persists the choice to localStorage on toggle', () => {
    setupBrowseDOM()
    showBrowseUI([makeDataset({ id: 'a', tags: ['Air'] })], makeCallbacks())
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBeNull()
    const graphBtn = document.querySelector<HTMLElement>('[data-view-mode="graph"]')!
    graphBtn.click()
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('graph')
  })

  it('updates aria-pressed when the user toggles', () => {
    setupBrowseDOM()
    showBrowseUI([makeDataset({ id: 'a', tags: ['Air'] })], makeCallbacks())
    // The toggle's click handler rebuilds the bar's innerHTML
    // via renderViewModeBar(), so the original button references
    // become detached. Re-query after the click to read the live
    // state.
    document.querySelector<HTMLElement>('[data-view-mode="graph"]')!.click()
    const cardsBtn = document.querySelector<HTMLElement>('[data-view-mode="cards"]')!
    const graphBtn = document.querySelector<HTMLElement>('[data-view-mode="graph"]')!
    expect(graphBtn.getAttribute('aria-pressed')).toBe('true')
    expect(cardsBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('ignores a click on the already-active button (no duplicate emit, no churn)', () => {
    setupBrowseDOM()
    showBrowseUI([makeDataset({ id: 'a', tags: ['Air'] })], makeCallbacks())
    const cardsBtn = document.querySelector<HTMLElement>('[data-view-mode="cards"]')!
    cardsBtn.click()
    // No catalog_view_mode_changed event should have fired because
    // the user clicked the surface they were already on.
    const events = __peek().filter(e => e.event_type === 'catalog_view_mode_changed')
    expect(events).toHaveLength(0)
  })

  it('emits catalog_view_mode_changed on toggle with previous + destination + count bucket', () => {
    setupBrowseDOM()
    showBrowseUI(
      [
        makeDataset({ id: 'a', tags: ['Air'] }),
        makeDataset({ id: 'b', tags: ['Water'] }),
      ],
      makeCallbacks(),
    )
    document.querySelector<HTMLElement>('[data-view-mode="graph"]')!.click()
    const events = __peek().filter(e => e.event_type === 'catalog_view_mode_changed')
    expect(events).toHaveLength(1)
    const evt = events[0] as {
      event_type: string
      view_mode: string
      from: string
      result_count_bucket: string
    }
    expect(evt.view_mode).toBe('graph')
    expect(evt.from).toBe('cards')
    expect(evt.result_count_bucket).toBe('1-10') // 2 visible cards
  })

  it('refreshes the Graph view when a chip filter changes (PR #137 regression)', async () => {
    // Regression for the stale-closure bug surfaced in PR #137
    // review: chip rail's click listener captured the FIRST
    // showBrowseUI call's `applyState`, but the catalog↔sphere
    // tab handler in main.ts re-called showBrowseUI on every
    // return-to-catalog. The fresh closure created a fresh cytoscape
    // instance attached to the same `#browse-graph` container,
    // implicitly orphaning the first closure's cy. The old
    // applyState (still bound to the rail listener) then updated
    // the orphaned cy — invisible to the user.
    //
    // The fix is in showBrowseUI's top: re-calls short-circuit
    // before re-creating the closure, so the single live
    // controller stays bound to the listener AND remains
    // attached to the visible canvas.
    setupBrowseDOM()
    graphMockHandles.createCatalogGraph.mockClear()
    graphMockHandles.update.mockClear()
    localStorage.setItem(VIEW_MODE_KEY, 'graph')

    // First showBrowseUI — graph view restored from localStorage.
    showBrowseUI(
      [
        makeDataset({ id: 'a', tags: ['Air'] }),
        makeDataset({ id: 'b', tags: ['Water'] }),
      ],
      makeCallbacks(),
    )
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    expect(graphMockHandles.createCatalogGraph).toHaveBeenCalledTimes(1)

    // Simulate the catalog↔sphere tab path: re-call showBrowseUI.
    // With the fix, this short-circuits — no second
    // createCatalogGraph call. Without the fix, this would create
    // a second controller and orphan the first.
    showBrowseUI(
      [
        makeDataset({ id: 'a', tags: ['Air'] }),
        makeDataset({ id: 'b', tags: ['Water'] }),
      ],
      makeCallbacks(),
    )
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    // CRITICAL: only ONE controller should ever have been created
    // for this overlay. Two means we've orphaned the cytoscape
    // instance attached to the canvas — pre-fix behavior that
    // made chip clicks invisible.
    expect(graphMockHandles.createCatalogGraph).toHaveBeenCalledTimes(1)

    graphMockHandles.update.mockClear()

    // Now click the Air chip. The handler funnels through the
    // single live applyState and calls update on the single
    // live controller.
    const airChip = Array.from(document.querySelectorAll<HTMLElement>('.browse-chip'))
      .find(el => el.textContent === 'Air')
    expect(airChip).toBeDefined()
    airChip!.click()

    expect(graphMockHandles.update).toHaveBeenCalledTimes(1)
    const lastCall = graphMockHandles.update.mock.calls[0][0] as {
      filterState: Record<string, { kind: string; values?: readonly string[] }>
    }
    expect(lastCall.filterState.category).toEqual({
      kind: 'multi-select',
      values: ['Air'],
    })
  })
})
