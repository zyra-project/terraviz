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
import { emit, startDwell, hashQuery, type DwellHandle } from '../analytics'
import { plural, t } from '../i18n'
import { formatDate, formatNumber } from '../i18n/format'
import { parseIsoDurationMs } from '../utils/frames'
import { renderMarkdown } from '../services/markdownRenderer'

/** Tier B dwell handle for the browse overlay — non-null while the
 * overlay is visible. Started on showBrowseUI when the overlay
 * transitions from hidden, stopped on hideBrowseUI / collapseBrowseUI.
 * Tier-gated at emit time so the wiring is unconditional. */
let browseDwellHandle: DwellHandle | null = null

/** Bucket a result count for the `browse_filter.result_count_bucket`
 * schema — we want coarse buckets so the telemetry can't be used to
 * fingerprint a specific search's uniqueness. */
function bucketResultCount(n: number): '0' | '1-10' | '11-50' | '50+' {
  if (n <= 0) return '0'
  if (n <= 10) return '1-10'
  if (n <= 50) return '11-50'
  return '50+'
}

// Re-export so existing callers (chatUI, downloadUI, datasetLoader)
// continue to import these from browseUI.
export { escapeHtml, escapeAttr }

// --- Browse UI constants ---
const CARD_DESCRIPTION_MAX_LENGTH = 120
const MAX_CARD_CATEGORIES = 3
const MAX_CARD_KEYWORDS = 12

/**
 * Strip HTML tags from a rendered-markdown string via a detached
 * element's `textContent`. The result is safe to truncate at an
 * arbitrary character offset without leaving a half-open tag.
 * Used for the card-preview teaser. Empty input returns ''. The
 * DOM operation is offline — the element is never attached, so
 * no layout / style work runs.
 *
 * Takes already-rendered HTML rather than markdown source so the
 * caller can render the markdown once and pass the result to
 * both the full-description rendering and this helper. `renderCards()`
 * re-runs on every keystroke during search; rendering the
 * markdown twice per card was wasted parse + sanitize work on
 * every keystroke.
 */
function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return ''
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return (tmp.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Phase 3pg/D — render a one-line "frame timeline" for an image-
 * sequence dataset's browse card. Shows the frame count + first /
 * last timestamps + a "closest to now" marker on a thin horizontal
 * track. Returns an empty string for non-sequence rows so the
 * caller can unconditionally interpolate the result.
 *
 * Display rule:
 *   - Pure-sequence rows (no `period`) → just the frame count;
 *     no track, since there's no time axis to scrub.
 *   - Time-series rows (parseable `startTime` + `period`) →
 *     count + first / last labels + the track + the `now` dot
 *     clamped to [0%, 100%]. The clamp keeps datasets whose
 *     time window has elapsed from rendering the dot off-screen.
 *
 * The DOM is a tiny SVG so it scales cleanly across browse-card
 * widths without media-query gymnastics. No click handler — the
 * scrubber is purely informational in v1; a future commit can
 * wire the click position back through `loadFrameFromChat` or a
 * sibling `loadFrameFromBrowse` callback.
 */
function renderFrameScrubber(d: Dataset): string {
  const frames = d.frames
  if (!frames || frames.count <= 0) return ''
  const countLabel = formatNumber(frames.count)
  // Pure-sequence (no period) — show count only.
  if (!d.startTime || !d.period) {
    return `<div class="browse-card-scrubber browse-card-scrubber-pure">${escapeHtml(t('browse.card.scrubber.framesOnly', { count: countLabel }))}</div>`
  }
  const periodMs = parseIsoDurationMs(d.period)
  const startMs = Date.parse(d.startTime)
  if (periodMs == null || periodMs <= 0 || Number.isNaN(startMs)) {
    // Parse failed — degrade to the pure-sequence label rather
    // than rendering a broken track.
    return `<div class="browse-card-scrubber browse-card-scrubber-pure">${escapeHtml(t('browse.card.scrubber.framesOnly', { count: countLabel }))}</div>`
  }
  const endMs = startMs + periodMs * frames.count
  const nowMs = Date.now()
  // Clamp the "now" position to [0, 1]. The label below the track
  // distinguishes the three cases (before / inside / after the
  // window) so users can tell whether the marker is meaningful.
  const rawPos = (nowMs - startMs) / (endMs - startMs)
  const pos = Math.max(0, Math.min(1, rawPos))
  const posPct = (pos * 100).toFixed(1)
  const inWindow = nowMs >= startMs && nowMs < endMs
  const nowLabel = inWindow
    ? t('browse.card.scrubber.now')
    : nowMs < startMs
      ? t('browse.card.scrubber.beforeStart')
      : t('browse.card.scrubber.afterEnd')
  // Raw formatted strings here — `t(...)` interpolates them into
  // the localised template, and the single `escapeAttr` on the
  // resulting aria-label below handles attribute-context encoding
  // exactly once. Escaping the inputs first would double-encode
  // entities (e.g. `&` → `&amp;` → `&amp;amp;`) and corrupt the
  // screen-reader label. Phase 3pg-review/E — Copilot
  // discussion_r3282216335.
  const startLabel = formatDate(d.startTime)
  // Last frame's timestamp (not `end_time`) — `period × (count - 1)`
  // is the moment of the final frame; `period × count` is one
  // period past the last frame and used only as the right edge of
  // the scrub track.
  const lastFrameIso = new Date(startMs + periodMs * (frames.count - 1)).toISOString()
  const endLabel = formatDate(lastFrameIso)
  return `
    <div class="browse-card-scrubber" role="img" aria-label="${escapeAttr(
      t('browse.card.scrubber.aria', { count: countLabel, start: startLabel, end: endLabel }),
    )}">
      <div class="browse-card-scrubber-label">
        <span class="browse-card-scrubber-count">${escapeHtml(t('browse.card.scrubber.frames', { count: countLabel }))}</span>
        <span class="browse-card-scrubber-now">${escapeHtml(nowLabel)}</span>
      </div>
      <svg class="browse-card-scrubber-track" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
        <rect x="0" y="2" width="100" height="2" rx="1" class="browse-card-scrubber-bar"></rect>
        <circle cx="${posPct}" cy="3" r="1.6" class="browse-card-scrubber-dot${inWindow ? '' : ' browse-card-scrubber-dot-outside'}"></circle>
      </svg>
      <div class="browse-card-scrubber-ends">
        <span>${escapeHtml(formatDate(d.startTime))}</span>
        <span>${escapeHtml(formatDate(lastFrameIso))}</span>
      </div>
    </div>`
}
const SEARCH_FOCUS_DELAY_MS = 200
/** Debounce window between the last keystroke and the
 * `browse_search` Tier B emit. 400 ms feels right for a search-as-you
 * type box: long enough that `"hurricane"` is one event instead of
 * nine, short enough that the event lands while the user is still
 * looking at the results. */
const BROWSE_SEARCH_DEBOUNCE_MS = 400

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
/**
 * Notify analytics that the browse overlay just transitioned from
 * hidden / collapsed to visible. Caller is responsible for deciding
 * whether the transition actually happened — this just emits the
 * event and (re)starts the dwell handle if it isn't already running.
 *
 * Exported so the main app's "re-open from collapsed" path
 * (`openBrowsePanel` in main.ts, which skips `showBrowseUI` to
 * avoid duplicating event listeners) can still book-keep telemetry
 * cleanly.
 */
export function notifyBrowseOpened(
  source: 'tools' | 'orbit' | 'shortcut' = 'tools',
): void {
  emit({ event_type: 'browse_opened', source })
  if (!browseDwellHandle) {
    browseDwellHandle = startDwell('browse')
  }
}

export function showBrowseUI(
  datasets: Dataset[],
  callbacks: BrowseCallbacks,
  source: 'tools' | 'orbit' | 'shortcut' = 'tools',
): void {
  const overlay = document.getElementById('browse-overlay')
  if (!overlay) return
  const wasHidden = overlay.classList.contains('hidden')
  overlay.classList.remove('hidden')
  document.body.classList.add('browse-open')
  closeDownloadPanel()
  if (wasHidden) {
    notifyBrowseOpened(source)
  }

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
      callbacks.announce(t('browse.announce.closed'))
    })
    closeBtn.dataset.wired = 'true'
  }

  // Default exclusion of SOS-only synthesised rows (Phase 4 §6.4).
  // The chip rail toggle (a follow-up commit) will let visitors
  // opt in to see all 520 datasets including the
  // `movie_preview`-quality SOS-only set; until then the browse
  // surface matches the previous 204-dataset SOSx subset.
  const visible = datasets
    .filter(d => !d.isHidden && d.availableFor !== 'SOS')
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.title.localeCompare(b.title))

  // Update search placeholder with actual count
  const searchEl = document.getElementById('browse-search') as HTMLInputElement | null
  if (searchEl) {
    searchEl.placeholder = t('browse.search.placeholderCount', { count: visible.length })
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
  // 'All' is the programmatic sentinel for "no category filter" — kept
  // as a literal string in code (data attributes, comparisons) so the
  // logic is locale-independent. The visible label is translated below.
  const ALL = 'All'
  const categories = [ALL, ...Array.from(catSet).sort()]

  let activeCategory = ALL
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
      .map(cat => {
        const display = cat === ALL ? t('browse.category.all') : cat
        return `<button class="browse-chip${cat === ALL ? ' active' : ''}" data-cat="${escapeAttr(cat)}" aria-pressed="${cat === ALL}">${escapeHtml(display)}</button>`
      })
      .join('')

    if (!chipBar.dataset.wired) {
      chipBar.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.browse-chip') as HTMLElement | null
        if (!btn) return
        activeCategory = btn.dataset.cat ?? ALL
        activeSubCategory = null
        chipBar.querySelectorAll('.browse-chip').forEach(c => {
          c.classList.remove('active')
          c.setAttribute('aria-pressed', 'false')
        })
        btn.classList.add('active')
        btn.setAttribute('aria-pressed', 'true')
        renderSubChips()
        renderCards()
        const cardCount = document.querySelectorAll('#browse-grid .browse-card').length
        emit({
          event_type: 'browse_filter',
          category: activeCategory,
          result_count_bucket: bucketResultCount(cardCount),
        })
      })
      chipBar.dataset.wired = 'true'
    }
  }

  // Sub-category chip bar
  const subChipBar = document.getElementById('browse-subcategory-bar')
  const renderSubChips = () => {
    if (!subChipBar) return
    if (activeCategory === ALL || !subCatMap.has(activeCategory)) {
      subChipBar.innerHTML = ''
      return
    }
    const subs = Array.from(subCatMap.get(activeCategory)!).sort()
    if (subs.length === 0) { subChipBar.innerHTML = ''; return }
    subChipBar.innerHTML = subs
      .map(s => `<button class="browse-subchip${activeSubCategory === s ? ' active' : ''}" data-sub="${escapeAttr(s)}" aria-pressed="${activeSubCategory === s}">${escapeHtml(s)}</button>`)
      .join('')
  }
  if (subChipBar && !subChipBar.dataset.wired) {
    subChipBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.browse-subchip') as HTMLElement | null
      if (!btn) return
      const sub = btn.dataset.sub ?? null
      activeSubCategory = (activeSubCategory === sub) ? null : sub
      renderSubChips()
      renderCards()
    })
    subChipBar.dataset.wired = 'true'
  }

  // Search input + clear button
  const searchInput = document.getElementById('browse-search') as HTMLInputElement | null
  const searchClear = document.getElementById('browse-search-clear')
  const updateSearchClear = () => {
    searchClear?.classList.toggle('hidden', !searchInput?.value)
  }
  /** Token guards against the async hash() call resolving for an
   * older keystroke after the user has typed more characters. Each
   * scheduled emit captures the current token; the emit is dropped
   * if the token has moved on. */
  let searchEmitToken = 0
  let searchEmitTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSearchEmit = (raw: string) => {
    if (searchEmitTimer != null) clearTimeout(searchEmitTimer)
    // Empty string isn't a search — bump the token to invalidate any
    // in-flight hash from a prior keystroke. Without this, typing
    // "h" then immediately backspacing could still emit the "h"
    // event once its async hash settles.
    if (raw.length === 0) {
      searchEmitToken++
      return
    }
    const token = ++searchEmitToken
    searchEmitTimer = setTimeout(() => {
      searchEmitTimer = null
      const cardCount = document.querySelectorAll('#browse-grid .browse-card').length
      void hashQuery(raw).then((query_hash) => {
        if (token !== searchEmitToken) return
        emit({
          event_type: 'browse_search',
          query_hash,
          query_length: raw.length,
          result_count_bucket: bucketResultCount(cardCount),
        })
      })
    }, BROWSE_SEARCH_DEBOUNCE_MS)
  }
  if (searchInput) {
    if (!searchInput.dataset.wired) {
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value.trim().toLowerCase()
        updateSearchClear()
        renderCards()
        scheduleSearchEmit(searchQuery)
      })
      searchInput.dataset.wired = 'true'
    }
    if (!callbacks.isMobile) {
      setTimeout(() => searchInput.focus(), SEARCH_FOCUS_DELAY_MS)
    }
  }
  if (searchClear && searchInput && !searchClear.dataset.wired) {
    searchClear.addEventListener('click', () => {
      searchInput.value = ''
      searchQuery = ''
      updateSearchClear()
      searchInput.focus()
      renderCards()
      // Clearing is not a search — drop any pending emit so an
      // in-flight debounce can't fire after the box is empty.
      if (searchEmitTimer != null) clearTimeout(searchEmitTimer)
      searchEmitTimer = null
      searchEmitToken++
    })
    searchClear.dataset.wired = 'true'
  }

  // Sort controls
  const sortBar = document.getElementById('browse-sort')
  const sortOptions: Array<{ key: SortKey; label: string }> = [
    { key: 'relevance', label: t('browse.sort.relevance') },
    { key: 'newest', label: t('browse.sort.newest') },
    { key: 'az', label: t('browse.sort.az') },
  ]
  if (sortBar) {
    sortBar.innerHTML = sortOptions
      .map(o => `<button class="browse-sort-btn${o.key === activeSort ? ' active' : ''}" data-sort="${o.key}" aria-pressed="${o.key === activeSort}">${o.label}</button>`)
      .join('')
    if (!sortBar.dataset.wired) {
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
      sortBar.dataset.wired = 'true'
    }
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
        btn.title = t('browse.download.downloading.title')
      } else if (downloaded) {
        btn.classList.add('downloaded')
        btn.classList.remove('downloading')
        btn.innerHTML = '&#10003;'
        btn.title = t('browse.download.downloaded.title', { size: formatBytes(downloaded.total_bytes) })
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
    btn.title = t('browse.download.downloading.title')

    try {
      await downloadDataset(dataset)
    } catch {
      btn.classList.remove('downloading')
      btn.innerHTML = '&#8615;'
      btn.title = t('browse.download.title')
    }
  }

  const renderCards = () => {
    const grid = document.getElementById('browse-grid')
    const countEl = document.getElementById('browse-count')
    if (!grid) return

    let filtered = [...visible]

    // Category filter
    if (activeCategory !== ALL) {
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
      countEl.textContent = plural(
        filtered.length,
        { one: 'browse.count.one', other: 'browse.count.other' },
        { count: formatNumber(filtered.length) },
      )
    }

    if (filtered.length === 0) {
      const docentHint = callbacks.onOpenChat
        ? `<button class="browse-docent-hint">${escapeHtml(t('browse.docentHint'))}</button>`
        : ''
      grid.innerHTML = `<div class="browse-no-results" role="status">${escapeHtml(t('browse.noResults'))}${docentHint ? `<br>${docentHint}` : ''}</div>`
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
      // The description field is publisher-authored markdown (the
      // dataset form's abstract editor produces markdown source).
      // The card has two surfaces:
      //   - short preview: a truncated single-line teaser. Markdown
      //     symbols (**, *, _, `, #, etc.) just clutter the snippet
      //     and a mid-token truncation could leave a literal `**` or
      //     unclosed link in the visible text, so the preview shows
      //     the markdown rendered to a plain text version with the
      //     formatting stripped.
      //   - full description (revealed on card expand): proper
      //     rendered markdown so the publisher's formatting actually
      //     shows up. Goes through the same sanitized renderer the
      //     publisher portal's preview uses, so the XSS surface is
      //     identical.
      // Found during a production smoke test where a published
      // dataset's "**test**" abstract appeared as literal asterisks
      // on the browse card.
      //
      // Render the markdown ONCE and derive both surfaces from
      // the result. `renderCards()` re-runs on every keystroke
      // during search, and the previous shape ran the parser +
      // sanitizer twice per card per render (once for the full
      // HTML, once inside `markdownToPlainText` for the teaser) \u2014
      // wasted parse + sanitize work on every keystroke. PR #115
      // Copilot review.
      const fullDescRendered = renderMarkdown(rawDesc)
      const plainDesc = htmlToPlainText(fullDescRendered)
      const shortDesc = plainDesc.length > CARD_DESCRIPTION_MAX_LENGTH
        ? plainDesc.substring(0, CARD_DESCRIPTION_MAX_LENGTH).trim() + '\u2026'
        : plainDesc

      const catsHtml = cats.length
        ? `<div class="browse-card-cats">${cats.map(c => `<span class="browse-card-cat">${escapeHtml(c)}</span>`).join('')}</div>`
        : ''
      const shortDescHtml = shortDesc
        ? `<p class="browse-card-desc">${escapeHtml(shortDesc)}</p>`
        : ''

      const fullDescHtml = fullDescRendered
        ? `<div class="browse-card-full-desc">${fullDescRendered}</div>`
        : ''
      const org = d.organization
      const dev = d.enriched?.datasetDeveloper?.name
      const visDev = d.enriched?.visDeveloper?.name
      const dateAdded = d.enriched?.dateAdded
      const keywords = [...(d.enriched?.keywords ?? []), ...(d.tags ?? [])]
      const catalogUrl = d.enriched?.catalogUrl
      const timeRange = d.startTime && d.endTime
        ? `${formatDate(d.startTime)} \u2013 ${formatDate(d.endTime)}`
        : ''

      let metaHtml = ''
      if (org) metaHtml += `<div class="browse-card-meta"><strong>${escapeHtml(t('browse.card.meta.source'))}</strong> ${escapeHtml(org)}</div>`
      if (dev) metaHtml += `<div class="browse-card-meta"><strong>${escapeHtml(t('browse.card.meta.datasetDeveloper'))}</strong> ${escapeHtml(dev)}</div>`
      if (visDev) metaHtml += `<div class="browse-card-meta"><strong>${escapeHtml(t('browse.card.meta.visualization'))}</strong> ${escapeHtml(visDev)}</div>`
      if (timeRange) metaHtml += `<div class="browse-card-meta"><strong>${escapeHtml(t('browse.card.meta.timeRange'))}</strong> ${timeRange}</div>`
      // Phase 3pg/D — date scrubber for image-sequence rows. Renders
      // a thin horizontal track showing the frame timeline with a
      // "closest-to-now" marker. Pure visualization; clicking is a
      // follow-up (would route through Orbit's load-frame path or a
      // future per-card load-at-time action).
      const scrubberHtml = renderFrameScrubber(d)
      if (scrubberHtml) metaHtml += scrubberHtml
      if (dateAdded) metaHtml += `<div class="browse-card-meta"><strong>${escapeHtml(t('browse.card.meta.added'))}</strong> ${escapeHtml(dateAdded)}</div>`
      if (catalogUrl) metaHtml += `<div class="browse-card-meta"><a href="${escapeAttr(catalogUrl)}" target="_blank" rel="noopener" style="color: #4da6ff; text-decoration: none; font-size: 0.65rem;">${escapeHtml(t('browse.card.catalogLink'))}</a></div>`

      const keywordsHtml = keywords.length
        ? `<div class="browse-card-keywords">${keywords.slice(0, MAX_CARD_KEYWORDS).map(k => `<span class="browse-card-keyword" data-keyword="${escapeAttr(k)}" role="button" tabindex="0" aria-label="${escapeAttr(t('browse.card.keyword.aria', { keyword: k }))}">${escapeHtml(k)}</span>`).join('')}</div>`
        : ''

      const thumbHtml = d.thumbnailLink
        ? `<img class="browse-card-thumb" src="${escapeAttr(d.thumbnailLink)}" alt="${escapeAttr(t('browse.card.thumb.alt', { title: d.title }))}" loading="lazy">`
        : ''

      const downloadBtn = isDownloadAvailable()
        ? `<button class="browse-card-download" data-id="${escapeAttr(d.id)}" aria-label="${escapeAttr(t('browse.download.aria', { title: d.title }))}" title="${escapeAttr(t('browse.download.title'))}">&#8615;</button>`
        : ''

      return `<div class="browse-card" data-id="${escapeAttr(d.id)}" role="listitem" tabindex="0" aria-label="${escapeAttr(d.title)}" aria-expanded="false">
          ${thumbHtml}
          <div class="browse-card-body">
            <div class="browse-card-header">
              <span class="browse-card-title">${escapeHtml(d.title)}</span>
              ${downloadBtn}
              <button class="browse-card-load" data-id="${escapeAttr(d.id)}" aria-label="${escapeAttr(t('browse.card.load.aria', { title: d.title }))}">${escapeHtml(t('browse.card.load'))}</button>
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
        // Markdown-rendered descriptions can contain links with
        // nested inline elements (`<a><strong>label</strong></a>`
        // from `[**label**](url)`). The literal `tagName === 'A'`
        // check missed clicks on the inner `<strong>`/`<em>`, so
        // a click on bold text inside a link still toggled the
        // card. `closest('a')` walks up from the click target to
        // the nearest anchor ancestor — catches every shape of
        // nested-element click within a link. PR #115 Copilot
        // review.
        if ((e.target as HTMLElement).closest('a')) return
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

  // Mark the overlay as initialized so subsequent show requests
  // (e.g. openBrowsePanel) can skip re-running this function and
  // avoid duplicating the click / input / sort listeners wired
  // above. The check on the read side lives in main.ts'
  // openBrowsePanel — keeping the marker set here means every
  // call site is covered automatically (boot path, go-home,
  // tools-menu re-show), not just the ones that remembered to
  // set it themselves.
  overlay.dataset.browseInitialized = 'true'
}

/** Hide the browse overlay entirely (aside becomes `display: none`). */
export function hideBrowseUI(): void {
  const overlay = document.getElementById('browse-overlay')
  overlay?.classList.add('hidden')
  document.body.classList.remove('browse-open')
  if (browseDwellHandle) {
    browseDwellHandle.stop()
    browseDwellHandle = null
  }
}

/**
 * Collapse the browse overlay while keeping it rendered so it can be
 * restored later by removing the `.collapsed` class. Use this in
 * multi-view mode where the user needs to come back to the browse
 * panel repeatedly to load datasets into additional panels.
 */
export function collapseBrowseUI(): void {
  const overlay = document.getElementById('browse-overlay')
  if (!overlay) return
  overlay.classList.remove('hidden')
  overlay.classList.add('collapsed')
  document.body.classList.remove('browse-open')
  // Collapsing hides the overlay from the user's view even though
  // it stays in the DOM — treat it as a dwell stop so the
  // "browse panel time" metric reflects user-visible time only.
  if (browseDwellHandle) {
    browseDwellHandle.stop()
    browseDwellHandle = null
  }
}
