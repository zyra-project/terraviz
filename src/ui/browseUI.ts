/**
 * Browse UI — dataset discovery panel with categories, search, sort, and card rendering.
 *
 * Extracted from InteractiveSphere to isolate the browse/discovery UI.
 */

import type { Dataset } from '../types'
import { dataService } from '../services/dataService'
import {
  isDownloadAvailable, downloadDataset, getDownload,
  isDownloading, formatBytes,
} from '../services/downloadService'
import { closeDownloadPanel } from './downloadUI'
import { toggleHelp } from './helpUI'
import { escapeHtml, escapeAttr } from './domUtils'

// Re-export so existing callers (chatUI, downloadUI, datasetLoader)
// continue to import these from browseUI.
export { escapeHtml, escapeAttr }

// --- Browse UI constants ---
const CARD_DESCRIPTION_MAX_LENGTH = 120
const MAX_CARD_CATEGORIES = 3
const MAX_CARD_KEYWORDS = 12
const SEARCH_FOCUS_DELAY_MS = 200

/** Callbacks the browse UI uses to communicate with the main app. */
export interface BrowseCallbacks {
  onSelectDataset: (id: string) => void
  announce: (message: string) => void
  isMobile: boolean
  onOpenChat?: (query?: string) => void
}

/**
 * Render and display the dataset browse overlay with category filters,
 * search, sort controls, and dataset cards.
 */
export function showBrowseUI(datasets: Dataset[], callbacks: BrowseCallbacks): void {
  const overlay = document.getElementById('browse-overlay')
  if (!overlay) return
  overlay.classList.remove('hidden')
  document.body.classList.add('browse-open')
  closeDownloadPanel()

  // Wire the in-header help trigger once (idempotent)
  const helpBtn = document.getElementById('help-trigger-browse')
  if (helpBtn && !helpBtn.dataset.wired) {
    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleHelp(helpBtn)
    })
    helpBtn.dataset.wired = 'true'
  }

  // Wire the in-header close button once (idempotent). Always fully
  // hides the overlay — the Tools menu's Browse button re-opens it.
  const closeBtn = document.getElementById('browse-close')
  if (closeBtn && !closeBtn.dataset.wired) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      hideBrowseUI()
      callbacks.announce('Dataset browser closed')
    })
    closeBtn.dataset.wired = 'true'
  }

  const visible = datasets
    .filter(d => !d.isHidden)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.title.localeCompare(b.title))

  // Update search placeholder with actual count
  const searchEl = document.getElementById('browse-search') as HTMLInputElement | null
  if (searchEl) {
    searchEl.placeholder = `Search ${visible.length} datasets\u2026`
  }

  // Collect unique category keys
  const catSet = new Set<string>()
  for (const d of visible) {
    if (d.enriched?.categories) {
      Object.keys(d.enriched.categories).forEach(c => catSet.add(c))
    }
    if (d.tags) {
      d.tags.forEach(t => catSet.add(t))
    }
  }
  catSet.delete('Movies')
  catSet.delete('Layers')
  const categories = ['All', ...Array.from(catSet).sort()]

  let activeCategory = 'All'
  let activeSubCategory: string | null = null
  type SortKey = 'relevance' | 'newest' | 'az'
  let activeSort: SortKey = 'relevance'
  let searchQuery = ''

  // Build sub-category lookup
  const subCatMap = new Map<string, Set<string>>()
  for (const d of visible) {
    if (d.enriched?.categories) {
      for (const [cat, subs] of Object.entries(d.enriched.categories)) {
        if (!subCatMap.has(cat)) subCatMap.set(cat, new Set())
        for (const sub of subs) {
          if (sub) subCatMap.get(cat)!.add(sub)
        }
      }
    }
  }

  // Render category chips
  const chipBar = document.getElementById('browse-category-bar')
  if (chipBar) {
    chipBar.innerHTML = categories
      .map(cat => `<button class="browse-chip${cat === 'All' ? ' active' : ''}" data-cat="${escapeAttr(cat)}" aria-pressed="${cat === 'All'}">${escapeHtml(cat)}</button>`)
      .join('')

    chipBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.browse-chip') as HTMLElement | null
      if (!btn) return
      activeCategory = btn.dataset.cat ?? 'All'
      activeSubCategory = null
      chipBar.querySelectorAll('.browse-chip').forEach(c => {
        c.classList.remove('active')
        c.setAttribute('aria-pressed', 'false')
      })
      btn.classList.add('active')
      btn.setAttribute('aria-pressed', 'true')
      renderSubChips()
      renderCards()
    })
  }

  // Sub-category chip bar
  const subChipBar = document.getElementById('browse-subcategory-bar')
  const renderSubChips = () => {
    if (!subChipBar) return
    if (activeCategory === 'All' || !subCatMap.has(activeCategory)) {
      subChipBar.innerHTML = ''
      return
    }
    const subs = Array.from(subCatMap.get(activeCategory)!).sort()
    if (subs.length === 0) { subChipBar.innerHTML = ''; return }
    subChipBar.innerHTML = subs
      .map(s => `<button class="browse-subchip${activeSubCategory === s ? ' active' : ''}" data-sub="${escapeAttr(s)}" aria-pressed="${activeSubCategory === s}">${escapeHtml(s)}</button>`)
      .join('')
  }
  if (subChipBar) {
    subChipBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.browse-subchip') as HTMLElement | null
      if (!btn) return
      const sub = btn.dataset.sub ?? null
      activeSubCategory = (activeSubCategory === sub) ? null : sub
      renderSubChips()
      renderCards()
    })
  }

  // Search input + clear button
  const searchInput = document.getElementById('browse-search') as HTMLInputElement | null
  const searchClear = document.getElementById('browse-search-clear')
  const updateSearchClear = () => {
    searchClear?.classList.toggle('hidden', !searchInput?.value)
  }
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim().toLowerCase()
      updateSearchClear()
      renderCards()
    })
    if (!callbacks.isMobile) {
      setTimeout(() => searchInput.focus(), SEARCH_FOCUS_DELAY_MS)
    }
  }
  if (searchClear && searchInput) {
    searchClear.addEventListener('click', () => {
      searchInput.value = ''
      searchQuery = ''
      updateSearchClear()
      searchInput.focus()
      renderCards()
    })
  }

  // Sort controls
  const sortBar = document.getElementById('browse-sort')
  const sortOptions: Array<{ key: SortKey; label: string }> = [
    { key: 'relevance', label: 'Relevance' },
    { key: 'newest', label: 'Newest' },
    { key: 'az', label: 'A\u2013Z' },
  ]
  if (sortBar) {
    sortBar.innerHTML = sortOptions
      .map(o => `<button class="browse-sort-btn${o.key === activeSort ? ' active' : ''}" data-sort="${o.key}" aria-pressed="${o.key === activeSort}">${o.label}</button>`)
      .join('')
    sortBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.browse-sort-btn') as HTMLElement | null
      if (!btn || !btn.dataset.sort) return
      activeSort = btn.dataset.sort as SortKey
      sortBar.querySelectorAll('.browse-sort-btn').forEach(b => {
        b.classList.remove('active')
        b.setAttribute('aria-pressed', 'false')
      })
      btn.classList.add('active')
      btn.setAttribute('aria-pressed', 'true')
      renderCards()
    })
  }

  // Update download button states after render
  const updateDownloadButtons = async () => {
    if (!isDownloadAvailable()) return
    const buttons = document.querySelectorAll<HTMLButtonElement>('.browse-card-download')
    for (const btn of buttons) {
      const id = btn.dataset.id
      if (!id) continue
      const downloaded = await getDownload(id)
      const active = await isDownloading(id)
      if (active) {
        btn.classList.add('downloading')
        btn.classList.remove('downloaded')
        btn.innerHTML = '&#8987;'
        btn.title = 'Downloading…'
      } else if (downloaded) {
        btn.classList.add('downloaded')
        btn.classList.remove('downloading')
        btn.innerHTML = '&#10003;'
        btn.title = `Downloaded (${formatBytes(downloaded.total_bytes)})`
      }
    }
  }

  async function handleDownloadClick(btn: HTMLButtonElement, allDatasets: Dataset[]): Promise<void> {
    const id = btn.dataset.id
    if (!id) return

    // If already downloaded or downloading, ignore
    if (btn.classList.contains('downloaded') || btn.classList.contains('downloading')) return

    const dataset = allDatasets.find(d => d.id === id)
    if (!dataset) return

    btn.classList.add('downloading')
    btn.innerHTML = '&#8987;'
    btn.title = 'Downloading…'

    try {
      await downloadDataset(dataset)
    } catch {
      btn.classList.remove('downloading')
      btn.innerHTML = '&#8615;'
      btn.title = 'Download for offline use'
    }
  }

  const renderCards = () => {
    const grid = document.getElementById('browse-grid')
    const countEl = document.getElementById('browse-count')
    if (!grid) return

    let filtered = [...visible]

    // Category filter
    if (activeCategory !== 'All') {
      filtered = filtered.filter(d =>
        (d.enriched?.categories != null && activeCategory in d.enriched.categories) ||
        (d.tags != null && d.tags.includes(activeCategory))
      )
      if (activeSubCategory) {
        filtered = filtered.filter(d => {
          const subs = d.enriched?.categories?.[activeCategory]
          return subs != null && subs.includes(activeSubCategory!)
        })
      }
    }

    // Text search
    if (searchQuery) {
      filtered = filtered.filter(d => {
        const title = d.title.toLowerCase()
        const desc = (d.enriched?.description ?? d.abstractTxt ?? '').toLowerCase()
        const keywords = [...(d.enriched?.keywords ?? []), ...(d.tags ?? [])].join(' ').toLowerCase()
        const cats = Object.keys(d.enriched?.categories ?? {}).join(' ').toLowerCase()
        return title.includes(searchQuery) || desc.includes(searchQuery) ||
               keywords.includes(searchQuery) || cats.includes(searchQuery)
      })
    }

    // Sort
    switch (activeSort) {
      case 'newest':
        filtered.sort((a, b) => {
          const da = a.enriched?.dateAdded ?? ''
          const db = b.enriched?.dateAdded ?? ''
          return db.localeCompare(da)
        })
        break
      case 'az':
        filtered.sort((a, b) => a.title.localeCompare(b.title))
        break
    }

    if (countEl) {
      countEl.textContent = `${filtered.length.toLocaleString()} dataset${filtered.length !== 1 ? 's' : ''}`
    }

    if (filtered.length === 0) {
      const docentHint = callbacks.onOpenChat
        ? `<button class="browse-docent-hint">Not sure what you need? Ask Orbit \u2192</button>`
        : ''
      grid.innerHTML = `<div class="browse-no-results" role="status">No datasets match your search.${docentHint ? `<br>${docentHint}` : ''}</div>`
      if (callbacks.onOpenChat) {
        grid.querySelector('.browse-docent-hint')?.addEventListener('click', () => {
          callbacks.onOpenChat!(searchQuery || undefined)
        })
      }
      return
    }

    grid.innerHTML = filtered.map(d => {
      const cats = d.enriched?.categories ? Object.keys(d.enriched.categories).slice(0, MAX_CARD_CATEGORIES) : []
      const rawDesc = d.enriched?.description ?? d.abstractTxt ?? ''
      const shortDesc = rawDesc.length > CARD_DESCRIPTION_MAX_LENGTH ? rawDesc.substring(0, CARD_DESCRIPTION_MAX_LENGTH).trim() + '\u2026' : rawDesc

      const catsHtml = cats.length
        ? `<div class="browse-card-cats">${cats.map(c => `<span class="browse-card-cat">${escapeHtml(c)}</span>`).join('')}</div>`
        : ''
      const shortDescHtml = shortDesc
        ? `<p class="browse-card-desc">${escapeHtml(shortDesc)}</p>`
        : ''

      const fullDescHtml = rawDesc
        ? `<div class="browse-card-full-desc">${escapeHtml(rawDesc)}</div>`
        : ''
      const org = d.organization
      const dev = d.enriched?.datasetDeveloper?.name
      const visDev = d.enriched?.visDeveloper?.name
      const dateAdded = d.enriched?.dateAdded
      const keywords = [...(d.enriched?.keywords ?? []), ...(d.tags ?? [])]
      const catalogUrl = d.enriched?.catalogUrl
      const timeRange = d.startTime && d.endTime
        ? `${new Date(d.startTime).toLocaleDateString()} \u2013 ${new Date(d.endTime).toLocaleDateString()}`
        : ''

      let metaHtml = ''
      if (org) metaHtml += `<div class="browse-card-meta"><strong>Source:</strong> ${escapeHtml(org)}</div>`
      if (dev) metaHtml += `<div class="browse-card-meta"><strong>Dataset developer:</strong> ${escapeHtml(dev)}</div>`
      if (visDev) metaHtml += `<div class="browse-card-meta"><strong>Visualization:</strong> ${escapeHtml(visDev)}</div>`
      if (timeRange) metaHtml += `<div class="browse-card-meta"><strong>Time range:</strong> ${timeRange}</div>`
      if (dateAdded) metaHtml += `<div class="browse-card-meta"><strong>Added:</strong> ${escapeHtml(dateAdded)}</div>`
      if (catalogUrl) metaHtml += `<div class="browse-card-meta"><a href="${escapeAttr(catalogUrl)}" target="_blank" rel="noopener" style="color: #4da6ff; text-decoration: none; font-size: 0.65rem;">View in SOS catalog \u2197</a></div>`

      const keywordsHtml = keywords.length
        ? `<div class="browse-card-keywords">${keywords.slice(0, MAX_CARD_KEYWORDS).map(k => `<span class="browse-card-keyword" data-keyword="${escapeAttr(k)}" role="button" tabindex="0" aria-label="Filter by ${escapeAttr(k)}">${escapeHtml(k)}</span>`).join('')}</div>`
        : ''

      const thumbHtml = d.thumbnailLink
        ? `<img class="browse-card-thumb" src="${escapeAttr(d.thumbnailLink)}" alt="${escapeAttr(d.title)} thumbnail" loading="lazy">`
        : ''

      const downloadBtn = isDownloadAvailable()
        ? `<button class="browse-card-download" data-id="${escapeAttr(d.id)}" aria-label="Download ${escapeAttr(d.title)} for offline use" title="Download for offline use">&#8615;</button>`
        : ''

      return `<div class="browse-card" data-id="${escapeAttr(d.id)}" role="listitem" tabindex="0" aria-label="${escapeAttr(d.title)}" aria-expanded="false">
          ${thumbHtml}
          <div class="browse-card-body">
            <div class="browse-card-header">
              <span class="browse-card-title">${escapeHtml(d.title)}</span>
              ${downloadBtn}
              <button class="browse-card-load" data-id="${escapeAttr(d.id)}" aria-label="Load ${escapeAttr(d.title)}">Load</button>
            </div>
            ${catsHtml}${shortDescHtml}
            <div class="browse-card-details">
              ${fullDescHtml}${metaHtml}${keywordsHtml}
            </div>
          </div>
        </div>`
    }).join('')

    // Wire up click + keyboard handlers
    grid.querySelectorAll<HTMLElement>('.browse-card').forEach(card => {
      const toggleExpand = () => {
        const wasExpanded = card.classList.contains('expanded')
        grid.querySelectorAll<HTMLElement>('.browse-card.expanded').forEach(c => {
          c.classList.remove('expanded')
          c.setAttribute('aria-expanded', 'false')
        })
        if (!wasExpanded) {
          card.classList.add('expanded')
          card.setAttribute('aria-expanded', 'true')
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
      }

      card.addEventListener('click', (e) => {
        const loadBtn = (e.target as HTMLElement).closest('.browse-card-load') as HTMLElement | null
        if (loadBtn) {
          e.stopPropagation()
          const id = loadBtn.dataset.id
          if (id) callbacks.onSelectDataset(id)
          return
        }
        const dlBtn = (e.target as HTMLElement).closest('.browse-card-download') as HTMLButtonElement | null
        if (dlBtn) {
          e.stopPropagation()
          handleDownloadClick(dlBtn, visible)
          return
        }
        if ((e.target as HTMLElement).tagName === 'A') return
        // Clickable keywords — filter by the clicked keyword
        const kwEl = (e.target as HTMLElement).closest('.browse-card-keyword') as HTMLElement | null
        if (kwEl?.dataset.keyword && searchInput) {
          e.stopPropagation()
          searchInput.value = kwEl.dataset.keyword
          searchQuery = kwEl.dataset.keyword.trim().toLowerCase()
          updateSearchClear()
          renderCards()
          return
        }
        toggleExpand()
      })

      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if ((e.target as HTMLElement).closest('.browse-card-load')) return
          const kwEl = (e.target as HTMLElement).closest('.browse-card-keyword') as HTMLElement | null
          if (kwEl?.dataset.keyword && searchInput) {
            e.preventDefault()
            e.stopPropagation()
            searchInput.value = kwEl.dataset.keyword
            searchQuery = kwEl.dataset.keyword.trim().toLowerCase()
            updateSearchClear()
            renderCards()
            return
          }
          e.preventDefault()
          toggleExpand()
        }
      })
    })
  }

  renderCards()
  updateDownloadButtons()
}

/** Hide the browse overlay entirely (aside becomes `display: none`). */
export function hideBrowseUI(): void {
  const overlay = document.getElementById('browse-overlay')
  overlay?.classList.add('hidden')
  document.body.classList.remove('browse-open')
}

/**
 * Collapse the browse overlay — keeps the aside rendered and its
 * toggle-button tab visible at the right edge of the viewport, but
 * slides the panel itself off-screen via `.collapsed`. The user can
 * click the toggle to slide it back in. Use this in multi-view mode
 * where the user needs to come back to the browse panel repeatedly
 * to load datasets into additional panels.
 */
export function collapseBrowseUI(): void {
  const overlay = document.getElementById('browse-overlay')
  const toggle = document.getElementById('browse-toggle')
  if (!overlay) return
  overlay.classList.remove('hidden')
  overlay.classList.add('collapsed')
  if (toggle) {
    toggle.innerHTML = '&#9656;'
    toggle.setAttribute('aria-label', 'Open dataset browser')
    toggle.setAttribute('aria-expanded', 'false')
  }
}
