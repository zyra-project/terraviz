/**
 * Browse UI — dataset discovery panel with multi-select chip
 * filters, search, sort, and card rendering.
 *
 * Phase 4 §6.1 + §6.5 of `docs/WEB_CATALOG_FEATURES_PLAN.md`.
 * Replaces the previous single-select category bar with typed
 * facet groups (Category & content / Format & medium / Time /
 * Quality & availability), and routes every visibility decision
 * through the pure {@link filterDatasets} engine so the
 * forthcoming Graph / Timeline / Map view modes (§6.7–§6.9)
 * share one source of truth.
 */

import type { Dataset } from '../types'
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
import {
  BASELINE_RESOLVERS,
  PERIOD_RESOLVER,
  filterDatasets,
  formatToBucket,
  mergeFilterStates,
  parseSearchQuery,
  setFacet,
  toggleFacet,
  type FacetPredicate,
  type FilterState,
  type FormatBucket,
} from '../services/datasetFilter'
import {
  applyFilterStateToUrl,
  readFilterStateFromUrl,
} from '../utils/catalogFilters'

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

/** The fixed order of format buckets in the Format chip group. Other
 *  comes last because it's the catch-all. */
const FORMAT_BUCKETS: readonly FormatBucket[] = ['video', 'image', 'tour', 'other']

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
 */
function renderFrameScrubber(d: Dataset): string {
  const frames = d.frames
  if (!frames || frames.count <= 0) return ''
  const countLabel = formatNumber(frames.count)
  if (!d.startTime || !d.period) {
    return `<div class="browse-card-scrubber browse-card-scrubber-pure">${escapeHtml(t('browse.card.scrubber.framesOnly', { count: countLabel }))}</div>`
  }
  const periodMs = parseIsoDurationMs(d.period)
  const startMs = Date.parse(d.startTime)
  if (periodMs == null || periodMs <= 0 || Number.isNaN(startMs)) {
    return `<div class="browse-card-scrubber browse-card-scrubber-pure">${escapeHtml(t('browse.card.scrubber.framesOnly', { count: countLabel }))}</div>`
  }
  const endMs = startMs + periodMs * frames.count
  const nowMs = Date.now()
  const rawPos = (nowMs - startMs) / (endMs - startMs)
  const pos = Math.max(0, Math.min(1, rawPos))
  const posPct = (pos * 100).toFixed(1)
  const inWindow = nowMs >= startMs && nowMs < endMs
  const nowLabel = inWindow
    ? t('browse.card.scrubber.now')
    : nowMs < startMs
      ? t('browse.card.scrubber.beforeStart')
      : t('browse.card.scrubber.afterEnd')
  const startLabel = formatDate(d.startTime)
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

// ---------------------------------------------------------------------------
// Chip rail rendering helpers
// ---------------------------------------------------------------------------

/**
 * One option inside a multi-select chip group.
 *
 * `value` is the predicate value stored in {@link FilterState}; `label`
 * is the localised display string. Kept separate so the engine can
 * stay locale-independent (the URL-encoded form is `value`, never
 * `label`).
 */
interface ChipOption {
  value: string
  label: string
}

/**
 * Render a multi-select chip group. Each chip is a `<button>` with
 * `aria-pressed` reflecting whether the value is currently in the
 * facet's `multi-select` predicate. Clicks call back into
 * {@link onToggle} with the value; the caller decides how to mutate
 * filter state and re-render.
 */
function renderChipGroup(
  facet: string,
  groupLabel: string,
  options: readonly ChipOption[],
  active: ReadonlySet<string>,
  ariaLabel: string,
): string {
  if (options.length === 0) return ''
  const chips = options
    .map(o => {
      const isActive = active.has(o.value)
      return `<button type="button" class="browse-chip${isActive ? ' active' : ''}" data-facet="${escapeAttr(facet)}" data-value="${escapeAttr(o.value)}" aria-pressed="${isActive}">${escapeHtml(o.label)}</button>`
    })
    .join('')
  return `
    <div class="browse-filter-group">
      <div class="browse-filter-label">${escapeHtml(groupLabel)}</div>
      <div class="browse-chip-row" role="group" aria-label="${escapeAttr(ariaLabel)}">${chips}</div>
    </div>`
}

/**
 * Render a boolean facet as a single toggle chip. Same shape as
 * {@link renderChipGroup} but with one option and the click semantics
 * map onto the engine's `toggleFacet(state, facet, '')` (the empty-
 * string value creates a `kind: 'boolean'` predicate per the engine
 * contract).
 */
function renderBooleanChip(
  facet: string,
  label: string,
  isActive: boolean,
  extraTitle?: string,
): string {
  const titleAttr = extraTitle ? ` title="${escapeAttr(extraTitle)}"` : ''
  return `<button type="button" class="browse-toggle-chip${isActive ? ' active' : ''}" data-facet="${escapeAttr(facet)}" data-toggle="boolean" aria-pressed="${isActive}"${titleAttr}>${escapeHtml(label)}</button>`
}

/**
 * Render a year-range filter as a pair of number inputs. Low-fi UI
 * intentional — the dual-thumb slider that §6.1 sketches is a
 * follow-up. Two numeric inputs are accessible, mobile-friendly,
 * and exercise the engine's range predicate without a new component.
 */
function renderRangeInputs(
  facet: string,
  label: string,
  fromLabel: string,
  toLabel: string,
  predicate: FacetPredicate | undefined,
  bounds: { min: number; max: number },
): string {
  const current = predicate?.kind === 'range' ? predicate : undefined
  const minVal = current?.min != null ? String(current.min) : ''
  const maxVal = current?.max != null ? String(current.max) : ''
  return `
    <div class="browse-filter-group">
      <div class="browse-filter-label">${escapeHtml(label)}</div>
      <div class="browse-range-row" role="group" aria-label="${escapeAttr(label)}">
        <label class="sr-only" for="browse-range-${escapeAttr(facet)}-min">${escapeHtml(fromLabel)}</label>
        <input
          type="number"
          id="browse-range-${escapeAttr(facet)}-min"
          class="browse-range-input"
          data-facet="${escapeAttr(facet)}"
          data-bound="min"
          inputmode="numeric"
          min="${bounds.min}"
          max="${bounds.max}"
          placeholder="${escapeAttr(String(bounds.min))}"
          value="${escapeAttr(minVal)}"
          aria-label="${escapeAttr(fromLabel)}" />
        <span class="browse-range-sep" aria-hidden="true">–</span>
        <label class="sr-only" for="browse-range-${escapeAttr(facet)}-max">${escapeHtml(toLabel)}</label>
        <input
          type="number"
          id="browse-range-${escapeAttr(facet)}-max"
          class="browse-range-input"
          data-facet="${escapeAttr(facet)}"
          data-bound="max"
          inputmode="numeric"
          min="${bounds.min}"
          max="${bounds.max}"
          placeholder="${escapeAttr(String(bounds.max))}"
          value="${escapeAttr(maxVal)}"
          aria-label="${escapeAttr(toLabel)}" />
      </div>
    </div>`
}

/**
 * Collect the unique tag values across the visible catalog, sorted
 * by frequency descending. Mirrors §6.1's audited ordering — Water
 * (80), People (63), Air (56), Land (39), … — but derives from the
 * actual dataset set so a future catalog change is reflected
 * automatically. Tags that don't appear on any visible row don't
 * surface as chips.
 */
function collectTagOptions(datasets: readonly Dataset[]): ChipOption[] {
  const counts = new Map<string, number>()
  for (const d of datasets) {
    if (d.isHidden) continue
    for (const tag of d.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => ({ value, label: value }))
}

/**
 * Year bounds for the date-added and data-coverage range inputs.
 * Lowest year + highest year across the visible catalog. Used to
 * seed the input `min`/`max` attributes so the range inputs don't
 * accept gibberish.
 */
function computeYearBounds(
  datasets: readonly Dataset[],
  extract: (d: Dataset) => number | undefined,
  fallback: { min: number; max: number },
): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const d of datasets) {
    if (d.isHidden) continue
    const year = extract(d)
    if (year == null) continue
    if (year < min) min = year
    if (year > max) max = year
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return fallback
  return { min, max }
}

function dateAddedYear(d: Dataset): number | undefined {
  const v = d.enriched?.dateAdded
  if (!v) return undefined
  const m = v.match(/^(\d{4})/)
  return m ? Number(m[1]) : undefined
}

function coverageStartYear(d: Dataset): number | undefined {
  if (!d.startTime) return undefined
  const m = d.startTime.match(/^(\d{4})/)
  return m ? Number(m[1]) : undefined
}

function coverageEndYear(d: Dataset): number | undefined {
  const source = d.endTime ?? d.startTime
  if (!source) return undefined
  const m = source.match(/^(\d{4})/)
  return m ? Number(m[1]) : undefined
}

// ---------------------------------------------------------------------------
// Main entry — show the browse overlay
// ---------------------------------------------------------------------------

/**
 * Render and display the dataset browse overlay with the new
 * typed-group chip rail, search, sort controls, and dataset cards.
 *
 * Wires every interactive element idempotently — re-calling
 * `showBrowseUI` after the overlay was hidden is safe and does not
 * duplicate listeners. Filter state lives in a closure variable
 * per-overlay-instance; future URL-persistence and search-prefix
 * wiring layer on top of this base.
 */
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

  // The full catalog the rail operates on. The engine handles
  // hidden-dataset exclusion and the SOS-default polarity, so we
  // pass the unfiltered list and trust `filterDatasets`.
  const allDatasets = [...datasets]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.title.localeCompare(b.title))

  // Count of SOS-only rows for the include-SOS toggle's help text.
  // Read once at boot — adding to the catalog mid-session is not
  // a supported flow.
  const sosOnlyCount = allDatasets.reduce(
    (acc, d) => acc + (!d.isHidden && d.availableFor === 'SOS' ? 1 : 0),
    0,
  )

  // Pre-compute chip options + year bounds from the full visible
  // set (excluding hidden and SOS-only, matching the default
  // visibility). The chip rail surfaces tags that are actually on
  // a visible row — if the SOS toggle opts in to more, the rail's
  // chip set doesn't grow, which keeps the surface stable across
  // the toggle.
  const baselineVisible = allDatasets.filter(d => !d.isHidden && d.availableFor !== 'SOS')
  const tagOptions = collectTagOptions(baselineVisible)
  const dateAddedBounds = computeYearBounds(baselineVisible, dateAddedYear, { min: 2000, max: new Date().getUTCFullYear() })
  const coverageBoundsPair = computeYearBounds(baselineVisible, coverageStartYear, { min: 1900, max: new Date().getUTCFullYear() + 100 })
  const coverageBoundsMax = computeYearBounds(baselineVisible, coverageEndYear, coverageBoundsPair)
  const coverageBounds = {
    min: Math.min(coverageBoundsPair.min, coverageBoundsMax.min),
    max: Math.max(coverageBoundsPair.max, coverageBoundsMax.max),
  }

  // Update search placeholder with actual count (baseline visible).
  const searchEl = document.getElementById('browse-search') as HTMLInputElement | null
  if (searchEl) {
    searchEl.placeholder = t('browse.search.placeholderCount', { count: baselineVisible.length })
  }

  type SortKey = 'relevance' | 'newest' | 'az'
  let activeSort: SortKey = 'relevance'
  // The raw search-box string — both free text and any
  // `category:foo` / `format:bar` / `period:yearly` prefixes the
  // user has typed. `parseSearchQuery` splits it into the free-
  // text rest and a {@link FilterState} overlay merged onto chip
  // state at filter time (§6.2).
  let searchQuery = ''
  // Chip / range / toggle state — separate from search-prefix
  // overlay so a search like `category:Water hurricane` doesn't
  // visually light up the Water chip (the prefix is a parallel
  // input, not a chip mutation). Both feed `filterDatasets` via
  // mergeFilterStates so the predicate semantics stay identical.
  let filterState: FilterState = {}

  // Boot from URL — restore filter chips + search query from
  // ?cat=…&q=… so a shared catalog link reproduces the filter
  // surface. URL params we don't recognise are ignored
  // (forward-compat). Search query case is preserved through
  // the round-trip so `category:Water` from a shared link
  // still matches the canonical `Water` tag.
  const initialUrlState = readFilterStateFromUrl()
  if (Object.keys(initialUrlState.state).length > 0) {
    filterState = initialUrlState.state
  }
  if (initialUrlState.searchQuery) {
    searchQuery = initialUrlState.searchQuery
  }

  // Resolvers passed to the engine — baseline §6.1 set plus the
  // search-only `period:` resolver so `period:yearly` actually
  // filters. Hoisted to module-local once for the lifetime of
  // this overlay instance; rebuilding per render is wasted work.
  const resolvers = { ...BASELINE_RESOLVERS, period: PERIOD_RESOLVER }

  // ----- Filter rail render -----

  const rail = document.getElementById('browse-filter-rail')

  /**
   * Render the entire filter rail from the current `filterState`.
   * Idempotent and pure-from-state — every interactive element's
   * `aria-pressed` / input value is derived from `filterState`, so
   * a re-render after any mutation is correct without diff
   * machinery.
   */
  function renderRail(): void {
    if (!rail) return
    const categoryActive = predicateValues(filterState.category)
    const formatActive = predicateValues(filterState.format)
    const formatOptions: ChipOption[] = FORMAT_BUCKETS.map(b => ({
      value: b,
      label: t(`browse.filter.format.${b}` as const),
    }))
    const hasCaptions = filterState.hasCaptions?.kind === 'boolean'
    const hasTour = filterState.hasTour?.kind === 'boolean'
    const includeSos = filterState.includeSos?.kind === 'boolean'

    const sections: string[] = []

    // Category & content
    sections.push(`<div class="browse-filter-section" data-group="category"><div class="browse-filter-group-heading">${escapeHtml(t('browse.filter.group.category'))}</div>`)
    sections.push(renderChipGroup(
      'category',
      t('browse.filter.tags.label'),
      tagOptions,
      categoryActive,
      t('browse.filter.tags.aria'),
    ))
    sections.push(`</div>`)

    // Format & medium
    sections.push(`<div class="browse-filter-section" data-group="format"><div class="browse-filter-group-heading">${escapeHtml(t('browse.filter.group.format'))}</div>`)
    sections.push(renderChipGroup(
      'format',
      t('browse.filter.format.label'),
      formatOptions,
      formatActive,
      t('browse.filter.format.aria'),
    ))
    sections.push(`</div>`)

    // Time
    sections.push(`<div class="browse-filter-section" data-group="time"><div class="browse-filter-group-heading">${escapeHtml(t('browse.filter.group.time'))}</div>`)
    sections.push(renderRangeInputs(
      'dateAdded',
      t('browse.filter.dateAdded.label'),
      t('browse.filter.dateAdded.fromLabel'),
      t('browse.filter.dateAdded.toLabel'),
      filterState.dateAdded,
      dateAddedBounds,
    ))
    sections.push(renderRangeInputs(
      'dataCoverageYear',
      t('browse.filter.dataCoverage.label'),
      t('browse.filter.dataCoverage.fromLabel'),
      t('browse.filter.dataCoverage.toLabel'),
      filterState.dataCoverageYear,
      coverageBounds,
    ))
    sections.push(`</div>`)

    // Quality & availability
    sections.push(`<div class="browse-filter-section" data-group="quality"><div class="browse-filter-group-heading">${escapeHtml(t('browse.filter.group.quality'))}</div>`)
    sections.push(`<div class="browse-toggle-row">`)
    sections.push(renderBooleanChip('hasCaptions', t('browse.filter.hasCaptions.label'), hasCaptions))
    sections.push(renderBooleanChip('hasTour', t('browse.filter.hasTour.label'), hasTour))
    if (sosOnlyCount > 0) {
      sections.push(renderBooleanChip(
        'includeSos',
        t('browse.filter.includeSos.label'),
        includeSos,
        t('browse.filter.includeSos.help', { count: formatNumber(sosOnlyCount) }),
      ))
    }
    sections.push(`</div>`)
    sections.push(`</div>`)

    // Clear-all affordance — surfaces only when there's something
    // to clear, so the rail isn't visually noisy in the default
    // state.
    if (hasAnyActiveFilter(filterState) || searchQuery) {
      sections.push(`<div class="browse-filter-clear-wrap"><button type="button" class="browse-filter-clear" id="browse-filter-clear" aria-label="${escapeAttr(t('browse.filter.clearAll.aria'))}">${escapeHtml(t('browse.filter.clearAll'))}</button></div>`)
    }

    rail.innerHTML = sections.join('')
  }

  // Wire chip / toggle / range / clear listeners on the rail once.
  // The rail is re-rendered from state on every change, but the
  // delegated click handler doesn't care because the data-* attrs
  // identify the facet + value uniquely.
  if (rail && !rail.dataset.wired) {
    rail.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('#browse-filter-clear')) {
        e.preventDefault()
        applyState({}, '')
        return
      }
      const chip = target.closest('[data-facet]') as HTMLElement | null
      if (!chip) return
      const facet = chip.dataset.facet
      if (!facet) return
      // Range inputs handled separately on `change` — clicks on the
      // input shouldn't toggle anything.
      if (chip.matches('input.browse-range-input')) return
      if (chip.dataset.toggle === 'boolean') {
        applyState(toggleFacet(filterState, facet, ''), searchQuery)
        return
      }
      const value = chip.dataset.value
      if (value == null) return
      applyState(toggleFacet(filterState, facet, value), searchQuery)
    })
    rail.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement
      if (!input.matches('input.browse-range-input')) return
      const facet = input.dataset.facet
      const bound = input.dataset.bound as 'min' | 'max' | undefined
      if (!facet || !bound) return
      const raw = input.value.trim()
      const numeric = raw === '' ? undefined : Number(raw)
      if (numeric != null && !Number.isFinite(numeric)) return
      const current = filterState[facet]
      const existing = current?.kind === 'range' ? current : { kind: 'range' as const }
      const next: FacetPredicate = {
        ...existing,
        kind: 'range',
        [bound]: numeric,
      }
      const cleaned = next.min == null && next.max == null ? undefined : next
      applyState(setFacet(filterState, facet, cleaned), searchQuery)
    })
    rail.dataset.wired = 'true'
  }

  // ----- Search input + clear button -----

  const searchInput = document.getElementById('browse-search') as HTMLInputElement | null
  const searchClear = document.getElementById('browse-search-clear')
  const updateSearchClear = () => {
    searchClear?.classList.toggle('hidden', !searchInput?.value)
  }
  /** Token guards against the async hash() call resolving for an
   * older keystroke after the user has typed more characters. */
  let searchEmitToken = 0
  let searchEmitTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSearchEmit = (raw: string) => {
    if (searchEmitTimer != null) clearTimeout(searchEmitTimer)
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
    if (searchQuery && !searchInput.value) {
      // Restore the search box from URL on boot. Lowercasing
      // happens on the way in via the URL decode; the input
      // value uses the lowercased form so the user can edit
      // from where they left off.
      searchInput.value = searchQuery
      updateSearchClear()
    }
    if (!searchInput.dataset.wired) {
      searchInput.addEventListener('input', () => {
        const value = searchInput.value
        // Preserve case so prefix-search values match canonical
        // chip values (`category:Water` vs `Water` tag). The
        // engine's matchesSearchQuery lowercases internally for
        // the free-text path, so the case of the stored query
        // doesn't affect substring matching.
        searchQuery = value.trim()
        updateSearchClear()
        renderCards()
        // Clear-all affordance visibility depends on searchQuery
        // too — re-render the rail so the button appears/hides.
        renderRail()
        // Analytics hash continues on the lowercased form so a
        // dashboard slicing by query_hash continues to bucket
        // "Hurricane" and "hurricane" together (no regression).
        scheduleSearchEmit(searchQuery.toLowerCase())
        // Persist on every keystroke so a refreshed page restores
        // the in-progress search. Cheap — applyFilterStateToUrl
        // bails out when the encoded URL hasn't changed.
        applyFilterStateToUrl(filterState, searchQuery)
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
      renderRail()
      if (searchEmitTimer != null) clearTimeout(searchEmitTimer)
      searchEmitTimer = null
      searchEmitToken++
      applyFilterStateToUrl(filterState, searchQuery)
    })
    searchClear.dataset.wired = 'true'
  }

  // ----- Sort controls -----

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

  // ----- Download buttons (unchanged from previous shape) -----

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

  async function handleDownloadClick(btn: HTMLButtonElement, allDatasetsRef: Dataset[]): Promise<void> {
    const id = btn.dataset.id
    if (!id) return
    if (btn.classList.contains('downloaded') || btn.classList.contains('downloading')) return
    const dataset = allDatasetsRef.find(d => d.id === id)
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

  // ----- State application + card render -----

  /**
   * Mutate filter state + search query in one shot, then re-render
   * the rail and the card grid. Centralised so every state change
   * goes through one place (telemetry hooks here in a follow-up
   * commit; URL persistence layers on top of this too).
   */
  function applyState(next: FilterState, nextQuery: string): void {
    const previous = filterState
    const queryChanged = nextQuery !== searchQuery
    filterState = next
    if (queryChanged) {
      searchQuery = nextQuery
      if (searchInput && searchInput.value.trim() !== nextQuery) {
        searchInput.value = nextQuery
        updateSearchClear()
      }
    }
    renderRail()
    renderCards()
    emitFilterChange(previous, next)
    // History.replaceState per §6.3 — chip clicks shouldn't clog
    // the back button, but a shared link should reproduce the
    // filter surface.
    applyFilterStateToUrl(filterState, searchQuery)
  }

  /**
   * Emit the `browse_filter` event when a facet changes. Schema is
   * the same one PR #131 ships — `category` carries the toggled
   * value (or the facet name for boolean / range mutations) so a
   * dashboard slicing by category still works for the multi-select
   * common case. Result-count bucket reports the post-change card
   * count.
   *
   * Skips when nothing changed (avoids a redundant emit when
   * `applyState` is called with the same state — e.g. on the
   * search-query path that delegates through this helper).
   */
  function emitFilterChange(prev: FilterState, next: FilterState): void {
    const diff = facetDiff(prev, next)
    if (!diff) return
    const cardCount = document.querySelectorAll('#browse-grid .browse-card').length
    emit({
      event_type: 'browse_filter',
      category: diff,
      result_count_bucket: bucketResultCount(cardCount),
    })
  }

  function renderCards(): void {
    const grid = document.getElementById('browse-grid')
    const countEl = document.getElementById('browse-count')
    if (!grid) return

    // §6.2 — parse `category:foo` / `format:bar` / `period:yearly`
    // tokens out of the search box. The remaining free text drives
    // the substring match; the prefix overlay AND-combines with the
    // chip-rail state. Chip state stays the visual source of truth
    // — the overlay never lights up chips, which matches a power-
    // user's mental model that prefix search is "extra" rather
    // than "synced".
    const parsed = parseSearchQuery(searchQuery)
    const effectiveState = mergeFilterStates(filterState, parsed.prefixes)
    const filtered = filterDatasets(allDatasets, effectiveState, parsed.freeText, resolvers)

    // Sort applies after filter. Relevance preserves the input
    // order (catalog weight + title from the initial sort above);
    // newest sorts by dateAdded descending; az by title.
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
      const fullDescRendered = renderMarkdown(rawDesc)
      const plainDesc = htmlToPlainText(fullDescRendered)
      const shortDesc = plainDesc.length > CARD_DESCRIPTION_MAX_LENGTH
        ? plainDesc.substring(0, CARD_DESCRIPTION_MAX_LENGTH).trim() + '…'
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
        ? `${formatDate(d.startTime)} – ${formatDate(d.endTime)}`
        : ''

      let metaHtml = ''
      if (org) metaHtml += `<div class="browse-card-meta"><strong>${escapeHtml(t('browse.card.meta.source'))}</strong> ${escapeHtml(org)}</div>`
      if (dev) metaHtml += `<div class="browse-card-meta"><strong>${escapeHtml(t('browse.card.meta.datasetDeveloper'))}</strong> ${escapeHtml(dev)}</div>`
      if (visDev) metaHtml += `<div class="browse-card-meta"><strong>${escapeHtml(t('browse.card.meta.visualization'))}</strong> ${escapeHtml(visDev)}</div>`
      if (timeRange) metaHtml += `<div class="browse-card-meta"><strong>${escapeHtml(t('browse.card.meta.timeRange'))}</strong> ${timeRange}</div>`
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
          handleDownloadClick(dlBtn, allDatasets)
          return
        }
        if ((e.target as HTMLElement).closest('a')) return
        // Clickable keywords — filter by the clicked keyword (via the search box, as before).
        const kwEl = (e.target as HTMLElement).closest('.browse-card-keyword') as HTMLElement | null
        if (kwEl?.dataset.keyword && searchInput) {
          e.stopPropagation()
          searchInput.value = kwEl.dataset.keyword
          searchQuery = kwEl.dataset.keyword.trim()
          updateSearchClear()
          renderCards()
          renderRail()
          applyFilterStateToUrl(filterState, searchQuery)
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
            searchQuery = kwEl.dataset.keyword.trim()
            updateSearchClear()
            renderCards()
            renderRail()
            applyFilterStateToUrl(filterState, searchQuery)
            return
          }
          e.preventDefault()
          toggleExpand()
        }
      })
    })
  }

  // Initial render
  renderRail()
  renderCards()
  updateDownloadButtons()

  // Mark the overlay as initialized so subsequent show requests
  // can skip re-running this function and avoid duplicating
  // listeners.
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
  if (browseDwellHandle) {
    browseDwellHandle.stop()
    browseDwellHandle = null
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Read the `values` array from a `multi-select` predicate as a Set
 *  for fast membership checks during chip rendering. Returns an
 *  empty Set for other predicate kinds. */
function predicateValues(predicate: FacetPredicate | undefined): ReadonlySet<string> {
  if (predicate?.kind !== 'multi-select') return new Set()
  return new Set(predicate.values)
}

/** True when any baseline facet is active. Used to decide whether
 *  to surface the "clear filters" affordance. */
function hasAnyActiveFilter(state: FilterState): boolean {
  for (const value of Object.values(state)) {
    if (value != null) return true
  }
  return false
}

/**
 * Single string summarising what changed between two filter
 * states — used as the `category` field on `browse_filter` events
 * so dashboards still get a stable signal per change. Returns
 * null when nothing changed.
 *
 * Format: `<facet>:<value>` for multi-select changes,
 * `<facet>:on` / `<facet>:off` for boolean toggles, `<facet>:range`
 * for range mutations.
 *
 * The compromise — packing into the existing `category` string —
 * keeps the analytics surface stable while the catalog work
 * proceeds. A schema bump that adds an explicit `facet` field is
 * the right cleanup once dashboards are ready.
 */
function facetDiff(prev: FilterState, next: FilterState): string | null {
  const facets = new Set([...Object.keys(prev), ...Object.keys(next)])
  for (const facet of facets) {
    const a = prev[facet]
    const b = next[facet]
    if (a === b) continue
    if (a == null && b != null) {
      if (b.kind === 'multi-select' && b.values.length > 0) return `${facet}:${b.values[b.values.length - 1]}`
      if (b.kind === 'boolean') return `${facet}:on`
      if (b.kind === 'range') return `${facet}:range`
    }
    if (a != null && b == null) {
      return `${facet}:off`
    }
    if (a?.kind === 'multi-select' && b?.kind === 'multi-select') {
      const added = b.values.find(v => !a.values.includes(v))
      if (added) return `${facet}:${added}`
      const removed = a.values.find(v => !b.values.includes(v))
      if (removed) return `${facet}:${removed}`
    }
    if (a?.kind !== b?.kind || JSON.stringify(a) !== JSON.stringify(b)) {
      return `${facet}:change`
    }
  }
  return null
}

