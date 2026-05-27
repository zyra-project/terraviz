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
import { openAddToPlaylistPopover } from './playlistUI'
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
  mergeFilterStates,
  parseSearchQuery,
  setFacet,
  toggleBooleanFacet,
  toggleFacet,
  type FacetPredicate,
  type FilterState,
  type FormatBucket,
} from '../services/datasetFilter'
import {
  applyFilterStateToUrl,
  readFilterStateFromUrl,
} from '../utils/catalogFilters'
import type { CatalogGraphController } from './catalogGraphUI'
import type { CatalogTimelineController } from './catalogTimelineUI'
import type { CatalogMapController } from './catalogMapUI'

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
 * Catalog view-mode (Phase 4 §6.7+). Cards is the baseline grid,
 * Graph is the §6.7 network view, Timeline is the §6.8 horizontal
 * coverage view, Map is the §6.9 bounding-box-on-mercator view. All
 * four are rendered as buttons in the segmented control.
 */
type ViewMode = 'cards' | 'graph' | 'timeline' | 'map'

/** localStorage key holding the user's selected view mode.
 *  Versioned so a future schema change can ignore stale shapes. */
const VIEW_MODE_STORAGE_KEY = 'sos-browse-view-mode.v1'

/**
 * Read the persisted view mode, falling back to `'cards'`. SSR-safe.
 *
 * All four view-modes — `'cards'`, `'graph'`, `'timeline'`, `'map'`
 * — are accepted from storage. Unknown modes normalise to `'cards'`
 * so the toggle's active state is always meaningful.
 */
function loadViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'cards'
  try {
    const raw = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)
    if (raw === 'graph') return 'graph'
    if (raw === 'timeline') return 'timeline'
    if (raw === 'map') return 'map'
    return 'cards'
  } catch {
    return 'cards'
  }
}

/** Persist the view mode. Best-effort — silent on storage failure. */
function saveViewMode(mode: ViewMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    /* ignore */
  }
}

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
 * The four typed-group section keys. Listed in §6.1's display
 * order; the accordion state map is keyed off these strings.
 */
type SectionKey = 'category' | 'format' | 'time' | 'quality'
const SECTION_KEYS: readonly SectionKey[] = ['category', 'format', 'time', 'quality']

/** Section open/collapsed state. Persisted to localStorage so the
 *  user's expand/collapse choices stick across sessions. */
type SectionOpenState = Record<SectionKey, boolean>

/** localStorage key holding the SectionOpenState JSON blob.
 *  Versioned suffix so a future schema change can ignore stale
 *  shapes without crashing the rail. */
const SECTION_OPEN_STORAGE_KEY = 'sos-browse-section-open.v1'

/**
 * Default open/collapsed state for each typed group on first
 * visit. Category & content opens because it's the highest-
 * frequency surface; the rest collapse to save vertical space
 * per the user's accordion request. Active filters auto-expand
 * their section so a shared URL or prefix-search never leaves
 * filtered state hidden — that logic lives in
 * {@link computeSectionOpenState}.
 */
const SECTION_OPEN_DEFAULT: SectionOpenState = {
  category: true,
  format: false,
  time: false,
  quality: false,
}

/**
 * Load the persisted section open/collapsed map. Returns the
 * default when localStorage is unavailable or the stored value
 * is unparseable / from a previous schema. SSR-safe — guards on
 * `typeof window`.
 */
function loadSectionOpenState(): SectionOpenState {
  if (typeof window === 'undefined') return { ...SECTION_OPEN_DEFAULT }
  try {
    const raw = window.localStorage.getItem(SECTION_OPEN_STORAGE_KEY)
    if (!raw) return { ...SECTION_OPEN_DEFAULT }
    const parsed = JSON.parse(raw) as Partial<SectionOpenState>
    const result: SectionOpenState = { ...SECTION_OPEN_DEFAULT }
    for (const key of SECTION_KEYS) {
      if (typeof parsed[key] === 'boolean') result[key] = parsed[key] as boolean
    }
    return result
  } catch {
    return { ...SECTION_OPEN_DEFAULT }
  }
}

/** Persist the section open/collapsed state. Best-effort — swallow
 *  storage failures (private-mode browsers, quota exceeded) so the
 *  rail keeps working. */
function saveSectionOpenState(state: SectionOpenState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SECTION_OPEN_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

/**
 * Count active facet predicates within a section. Used both to
 * decide whether to auto-expand a collapsed section and to render
 * the badge in the section header (so a collapsed section still
 * signals "you have something filtered here").
 *
 *  - multi-select  → `values.length`
 *  - boolean       → 1 when present
 *  - range         → 1 when min or max is set
 *  - bbox          → 1 when present
 */
function countSectionActive(section: SectionKey, state: FilterState): number {
  const facets = SECTION_FACETS[section]
  let count = 0
  for (const facet of facets) {
    const predicate = state[facet]
    if (predicate == null) continue
    if (predicate.kind === 'multi-select') count += predicate.values.length
    else if (predicate.kind === 'boolean') count += 1
    else if (predicate.kind === 'range') {
      if (predicate.min != null || predicate.max != null) count += 1
    } else if (predicate.kind === 'bbox') count += 1
  }
  return count
}

/** Map from typed-group section to the facets it owns. Single
 *  source of truth for the section ↔ facet association. */
const SECTION_FACETS: Readonly<Record<SectionKey, readonly string[]>> = {
  category: ['category'],
  format: ['format'],
  time: ['dateAdded', 'dataCoverageYear'],
  quality: ['hasCaptions', 'hasTour', 'includeSos'],
}

/**
 * Merge the persisted open state with the auto-expand rule:
 * sections whose facets are active are forced open, since hiding
 * filtered chips behind a collapsed header would surprise the
 * user (especially on a shared link). The user can still
 * collapse the section by clicking the header — the auto-expand
 * only applies when reading from persistence, not after the user
 * has explicitly toggled.
 */
function computeSectionOpenState(
  persisted: SectionOpenState,
  filterState: FilterState,
): SectionOpenState {
  const result = { ...persisted }
  for (const section of SECTION_KEYS) {
    if (countSectionActive(section, filterState) > 0) result[section] = true
  }
  return result
}

/**
 * Render an accordion-style section header. Clickable button with
 * a `▸`/`▾` indicator and an `aria-expanded` state. Includes an
 * active-filter badge when the section has chips set so a
 * collapsed section still signals filtered state. The arrow
 * indicator is hardcoded — it's a visual glyph, not a label, and
 * doesn't need to flip in RTL (RTL accordion conventions still
 * use `▸`/`▾` going down rather than `◂`/`▾`).
 */
function renderSectionHeader(
  section: SectionKey,
  title: string,
  isOpen: boolean,
  activeCount: number,
): string {
  const badge = activeCount > 0
    ? ` <span class="browse-filter-section-badge">${escapeHtml(formatNumber(activeCount))}</span>`
    : ''
  const indicator = isOpen ? '▾' : '▸'
  return `<button type="button" class="browse-filter-section-header" data-section="${escapeAttr(section)}" aria-expanded="${isOpen}"><span class="browse-filter-section-indicator" aria-hidden="true">${indicator}</span><span class="browse-filter-section-title">${escapeHtml(title)}</span>${badge}</button>`
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
  const wasCollapsed = overlay.classList.contains('collapsed')
  overlay.classList.remove('hidden')
  overlay.classList.remove('collapsed')
  document.body.classList.add('browse-open')
  closeDownloadPanel()
  if (wasHidden || wasCollapsed) {
    notifyBrowseOpened(source)
  }

  // Re-call short-circuit. The chip rail, search input, sort
  // buttons and view-mode toggle wire their listeners once via
  // `dataset.wired` checks — those listeners CAPTURE this
  // function's closure-local `filterState`, `viewMode`,
  // `graphController`, and `applyState`. A second showBrowseUI
  // call (e.g. via main.ts's catalog↔sphere tab handler, which
  // re-runs showBrowseUI after a Sphere round-trip) creates a
  // fresh closure but the listeners stay bound to the original
  // one, so chip clicks would call the OLD applyState — reading
  // a stale `viewMode='cards'` and `graphController=null` even
  // though the user has since toggled into Graph view. That
  // exact bug surfaced in PR #137 review ("clicking a chip
  // doesn't update the graph").
  //
  // The fix: subsequent calls only un-hide the overlay (above)
  // and emit `browse_opened`; rendering and listener wiring are
  // skipped. The original openBrowsePanel call site in main.ts
  // already gated on `browseInitialized`, but other call sites
  // (catalog-empty boot, catalog↔sphere tab) didn't. Centralising
  // the gate here makes the invariant uniform regardless of caller.
  if (overlay.dataset.browseInitialized === 'true') return

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
  // Live narrow-viewport check. Graph + Timeline views need
  // horizontal room (force-directed layout / time bars span the
  // available width), AND vertical room for the chip rail sitting
  // above them — both of which a portrait phone runs out of.
  //
  // The gate is portrait-only: below 768px wide AND in portrait,
  // hide the toggle and force Cards. A phone in landscape (e.g.
  // 667 × 375 SE, 852 × 393 iPhone 15) clears the gate so a user
  // testing from a phone can still reach the non-Cards surfaces.
  // Vertical space is tight in phone landscape — Timeline shows
  // only ~10–15 rows at the comfortable height and the Graph's
  // canvas is cramped — but the views are usable for smoke
  // testing, which is the explicit goal of allowing them here.
  //
  // matchMedia gives a live signal that re-fires on both width
  // changes (resize) AND orientation changes (rotate). We union
  // with `callbacks.isMobile` (Tauri's boot-time flag), gated on
  // portrait via a second matchMedia so a Tauri mobile user in
  // landscape doesn't get force-funnelled back to Cards either.
  const narrowVpQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 768px) and (orientation: portrait)')
    : null
  const portraitOnlyQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(orientation: portrait)')
    : null
  const isNarrowViewport = (): boolean => {
    if (narrowVpQuery?.matches) return true
    // Tauri mobile shell — `callbacks.isMobile` alone would gate
    // away even in landscape. Require portrait too so the
    // landscape parity holds across both delivery surfaces.
    if (callbacks.isMobile) {
      return portraitOnlyQuery?.matches ?? true
    }
    return false
  }
  // View-mode (§6.7+). Initial value falls back to Cards when the
  // viewport is currently narrow so a `viewMode='graph'` or
  // `'timeline'` left in localStorage from a desktop session doesn't
  // boot into an unusable canvas on a phone. Map view stays
  // available at every breakpoint per §6.9 — so a phone user who
  // last left Map view stays in Map on next launch.
  function bootViewMode(): ViewMode {
    const persisted = loadViewMode()
    if (isNarrowViewport() && (persisted === 'graph' || persisted === 'timeline')) {
      return 'cards'
    }
    return persisted
  }
  let viewMode: ViewMode = bootViewMode()
  // Lazy-mounted graph controller — populated on first toggle into
  // Graph view. Module-loaded once per overlay instance; the
  // controller itself handles re-renders on filter changes.
  let graphController: CatalogGraphController | null = null
  let graphLoadPromise: Promise<CatalogGraphController | null> | null = null
  // Same shape for the Timeline (§6.8). Lazy-loaded on first toggle
  // so the d3 chunk only ships when the user actually opens
  // Timeline view; mirrors the graph controller's lifecycle.
  let timelineController: CatalogTimelineController | null = null
  let timelineLoadPromise: Promise<CatalogTimelineController | null> | null = null
  // Same shape for the Map view (§6.9). Lazy-loaded on first toggle
  // so the second MapRenderer instance only mounts when the user
  // opens Map view; mirrors the graph + timeline controllers'
  // lifecycle. MapLibre itself is already in the bundle (the main
  // globe uses it), so the lazy mount only avoids the second
  // instance's tile-fetch warm-up cost.
  let mapController: CatalogMapController | null = null
  let mapLoadPromise: Promise<CatalogMapController | null> | null = null
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

  // Accordion section open/collapsed state — persisted to
  // localStorage so the user's expand/collapse choices stick
  // across sessions. The user explicitly asked for an accordion
  // to save screen real estate; defaults open Category & content
  // and collapse the other three groups. Sections with active
  // facets auto-expand at boot so a shared URL or prefix-search
  // never leaves filtered state hidden. Auto-expand considers
  // both URL-decoded facets AND any prefix tokens in the search
  // query (e.g. `?q=category:Water` opens Category even though
  // the chip state is empty), so the rule matches the comment.
  const bootEffectiveState = mergeFilterStates(
    filterState,
    parseSearchQuery(searchQuery).prefixes,
  )
  let sectionOpen: SectionOpenState = computeSectionOpenState(
    loadSectionOpenState(),
    bootEffectiveState,
  )

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

    /** Wrap a section's body in the accordion shell — clickable
     *  header + collapsible body. The body markup is always
     *  emitted; CSS `.collapsed .browse-filter-section-body
     *  { display: none }` hides it when the section is closed.
     *  The accordion-toggle handler flips the `collapsed` class
     *  in place rather than calling `renderRail()` so DOM input
     *  state (e.g. a partially-typed range-input value) survives
     *  a collapse-and-reopen cycle. */
    const wrapSection = (
      key: SectionKey,
      title: string,
      bodyHtml: string,
    ): string => {
      const isOpen = sectionOpen[key]
      const activeCount = countSectionActive(key, filterState)
      const header = renderSectionHeader(key, title, isOpen, activeCount)
      return `<div class="browse-filter-section${isOpen ? '' : ' collapsed'}" data-group="${escapeAttr(key)}">${header}<div class="browse-filter-section-body">${bodyHtml}</div></div>`
    }

    // Category & content
    sections.push(wrapSection(
      'category',
      t('browse.filter.group.category'),
      renderChipGroup(
        'category',
        t('browse.filter.tags.label'),
        tagOptions,
        categoryActive,
        t('browse.filter.tags.aria'),
      ),
    ))

    // Format & medium
    sections.push(wrapSection(
      'format',
      t('browse.filter.group.format'),
      renderChipGroup(
        'format',
        t('browse.filter.format.label'),
        formatOptions,
        formatActive,
        t('browse.filter.format.aria'),
      ),
    ))

    // Time
    sections.push(wrapSection(
      'time',
      t('browse.filter.group.time'),
      renderRangeInputs(
        'dateAdded',
        t('browse.filter.dateAdded.label'),
        t('browse.filter.dateAdded.fromLabel'),
        t('browse.filter.dateAdded.toLabel'),
        filterState.dateAdded,
        dateAddedBounds,
      ) + renderRangeInputs(
        'dataCoverageYear',
        t('browse.filter.dataCoverage.label'),
        t('browse.filter.dataCoverage.fromLabel'),
        t('browse.filter.dataCoverage.toLabel'),
        filterState.dataCoverageYear,
        coverageBounds,
      ),
    ))

    // Quality & availability
    const qualityChips: string[] = []
    qualityChips.push(renderBooleanChip('hasCaptions', t('browse.filter.hasCaptions.label'), hasCaptions))
    qualityChips.push(renderBooleanChip('hasTour', t('browse.filter.hasTour.label'), hasTour))
    if (sosOnlyCount > 0) {
      qualityChips.push(renderBooleanChip(
        'includeSos',
        t('browse.filter.includeSos.label'),
        includeSos,
        t('browse.filter.includeSos.help', { count: formatNumber(sosOnlyCount) }),
      ))
    }
    sections.push(wrapSection(
      'quality',
      t('browse.filter.group.quality'),
      `<div class="browse-toggle-row">${qualityChips.join('')}</div>`,
    ))

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
      // Accordion section header — toggle open/collapsed. Marked
      // before the [data-facet] match so a header click doesn't
      // also fire as a chip click (headers carry no data-facet
      // anyway, but the early-return pattern is clearer).
      const sectionHeader = target.closest('.browse-filter-section-header') as HTMLElement | null
      if (sectionHeader) {
        e.preventDefault()
        const key = sectionHeader.dataset.section as SectionKey | undefined
        if (!key) return
        const nextOpen = !sectionOpen[key]
        sectionOpen = { ...sectionOpen, [key]: nextOpen }
        saveSectionOpenState(sectionOpen)
        // Toggle the section's collapsed class + header state in
        // place rather than re-rendering the rail. The earlier
        // shape called renderRail() which rebuilt innerHTML on
        // every toggle — that thrashes the DOM and would lose any
        // partially-typed (uncommitted) range-input value if the
        // user collapsed Time before the change event fired.
        const section = sectionHeader.closest('.browse-filter-section') as HTMLElement | null
        section?.classList.toggle('collapsed', !nextOpen)
        sectionHeader.setAttribute('aria-expanded', String(nextOpen))
        const indicator = sectionHeader.querySelector('.browse-filter-section-indicator')
        if (indicator) indicator.textContent = nextOpen ? '▾' : '▸'
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
        applyState(toggleBooleanFacet(filterState, facet), searchQuery)
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
      // Restore the search box from URL on boot. The URL decoder
      // preserves the query's original case (see catalogFilters.ts)
      // so a shared `?q=Hurricane` link survives the round-trip
      // and a `category:Water` prefix still matches the canonical
      // `Water` tag.
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

  // ----- View-mode toggle (§6.7) — hidden on mobile -----

  const viewModeBar = document.getElementById('browse-view-mode')
  const graphContainer = document.getElementById('browse-graph')
  const timelineContainer = document.getElementById('browse-timeline')
  const mapContainer = document.getElementById('browse-map')
  const gridContainer = document.getElementById('browse-grid')

  /** Render the segmented Cards/Graph/Timeline/Map control. The
   *  Cards / Graph / Timeline buttons hide on narrow portrait
   *  phones (Graph + Timeline both need horizontal room the gate
   *  doesn't provide). Map stays available at every breakpoint —
   *  per §6.9 it's "the most mobile-friendly of the four
   *  view-modes" — but is rendered alongside Cards so the user can
   *  still reach the grid. The narrow-viewport branch therefore
   *  renders a two-button (Cards + Map) bar rather than going
   *  silent. */
  function renderViewModeBar(): void {
    if (!viewModeBar) return
    const narrow = isNarrowViewport()
    viewModeBar.classList.remove('hidden')
    viewModeBar.removeAttribute('aria-hidden')
    const options: Array<{ key: 'cards' | 'graph' | 'timeline' | 'map'; label: string; aria: string }> = narrow
      ? [
          { key: 'cards', label: t('browse.viewMode.cards'), aria: t('browse.viewMode.cards.aria') },
          { key: 'map', label: t('browse.viewMode.map'), aria: t('browse.viewMode.map.aria') },
        ]
      : [
          { key: 'cards', label: t('browse.viewMode.cards'), aria: t('browse.viewMode.cards.aria') },
          { key: 'graph', label: t('browse.viewMode.graph'), aria: t('browse.viewMode.graph.aria') },
          { key: 'timeline', label: t('browse.viewMode.timeline'), aria: t('browse.viewMode.timeline.aria') },
          { key: 'map', label: t('browse.viewMode.map'), aria: t('browse.viewMode.map.aria') },
        ]
    viewModeBar.innerHTML = options
      .map(o => {
        const active = o.key === viewMode
        return `<button type="button" class="browse-view-mode-btn${active ? ' active' : ''}" data-view-mode="${o.key}" aria-pressed="${active}" aria-label="${escapeAttr(o.aria)}">${escapeHtml(o.label)}</button>`
      })
      .join('')
  }

  /**
   * Apply the active view-mode to the DOM — show one container,
   * hide the others. On first activation of Graph / Timeline view
   * this also lazy-imports the corresponding module, instantiates
   * the controller, and asks it to render. Subsequent activations
   * just show the existing canvas and ask the controller to
   * refresh.
   *
   * `mountIfNeeded` defaults to true so the boot path mounts the
   * graph/timeline when `viewMode` restores from localStorage.
   * Filter-change paths can pass `false` to skip the dynamic
   * import when the off-screen view isn't visible.
   */
  async function applyViewMode(mountIfNeeded: boolean = true): Promise<void> {
    if (!gridContainer || !graphContainer || !timelineContainer) return
    const hideContainer = (el: HTMLElement): void => {
      el.classList.add('hidden')
      el.setAttribute('aria-hidden', 'true')
    }
    const showContainer = (el: HTMLElement): void => {
      el.classList.remove('hidden')
      el.removeAttribute('aria-hidden')
    }
    // Body-class hook for view-aware CSS — Graph, Timeline, and
    // Map all benefit from a slimmer browse-header (less decorative
    // chrome, more canvas) while Cards keeps the welcoming title +
    // subtitle. Centralised here so every `applyViewMode` call stays
    // in sync; hideBrowseUI / collapseBrowseUI clear the classes
    // alongside `browse-open` so the body stays clean when the
    // overlay closes.
    document.body.classList.toggle('browse-view-graph', viewMode === 'graph')
    document.body.classList.toggle('browse-view-timeline', viewMode === 'timeline')
    document.body.classList.toggle('browse-view-map', viewMode === 'map')
    document.body.classList.toggle('browse-view-cards', viewMode === 'cards')
    // Drawer only applies to non-Cards views. Switching to Cards
    // shows the inline rail unconditionally, so the drawer's open
    // state would just be stale JS bookkeeping. Close it here so
    // the `filter-drawer-open` class doesn't linger.
    if (viewMode === 'cards' && overlay?.classList.contains('filter-drawer-open')) {
      overlay.classList.remove('filter-drawer-open')
      if (rail) rail.style.removeProperty('--browse-drawer-top')
      const filtersBtnEl = document.getElementById('browse-filters-btn')
      filtersBtnEl?.setAttribute('aria-expanded', 'false')
    }
    if (viewMode === 'graph') {
      hideContainer(gridContainer)
      hideContainer(timelineContainer)
      if (mapContainer) hideContainer(mapContainer)
      showContainer(graphContainer)
      if (mountIfNeeded) await ensureGraphMounted()
      const parsed = parseSearchQuery(searchQuery)
      const effectiveState = mergeFilterStates(filterState, parsed.prefixes)
      graphController?.update({
        datasets: allDatasets,
        filterState: effectiveState,
        searchQuery: parsed.freeText,
      })
    } else if (viewMode === 'timeline') {
      hideContainer(gridContainer)
      hideContainer(graphContainer)
      if (mapContainer) hideContainer(mapContainer)
      showContainer(timelineContainer)
      if (mountIfNeeded) await ensureTimelineMounted()
      const parsed = parseSearchQuery(searchQuery)
      const effectiveState = mergeFilterStates(filterState, parsed.prefixes)
      timelineController?.update({
        datasets: allDatasets,
        filterState: effectiveState,
        searchQuery: parsed.freeText,
      })
    } else if (viewMode === 'map' && mapContainer) {
      hideContainer(gridContainer)
      hideContainer(graphContainer)
      hideContainer(timelineContainer)
      showContainer(mapContainer)
      if (mountIfNeeded) await ensureMapMounted()
      const parsed = parseSearchQuery(searchQuery)
      const effectiveState = mergeFilterStates(filterState, parsed.prefixes)
      mapController?.update({
        datasets: allDatasets,
        filterState: effectiveState,
        searchQuery: parsed.freeText,
      })
    } else {
      hideContainer(graphContainer)
      hideContainer(timelineContainer)
      if (mapContainer) hideContainer(mapContainer)
      showContainer(gridContainer)
    }
  }

  /**
   * Surface a dataset's card with all its metadata expanded. Wired
   * to the Graph view's dataset-node click (see `onPreviewDataset`
   * in the `createCatalogGraph` call below) per PR #137 review
   * feedback — directly loading on graph-node click skipped the
   * description / source / time-range / keywords most users want
   * to skim first.
   *
   * Switches the view to Cards (the card UI is the established
   * metadata surface), waits for `applyViewMode` to make the grid
   * visible, finds the matching `<div class="browse-card">` by
   * data-id, expands it, scrolls it into view, and focuses it for
   * keyboard users. From there the user clicks the existing Load
   * button if they want — that still funnels through
   * `callbacks.onSelectDataset`, same path the card grid has
   * always used.
   *
   * No-ops if the dataset is missing from the filtered set (the
   * card wouldn't be in the DOM anyway); the chip rail must be
   * loose enough to surface it.
   */
  function previewDatasetInCards(datasetId: string): void {
    if (viewMode !== 'cards') {
      const previous = viewMode
      viewMode = 'cards'
      saveViewMode(viewMode)
      renderViewModeBar()
      // Emit the view-mode-change telemetry so the dashboard sees
      // graph→cards preview pivots distinctly from explicit toggle
      // clicks. Same shape as the user-clicked-the-toggle path.
      const cardCount = document.querySelectorAll('#browse-grid .browse-card').length
      emit({
        event_type: 'catalog_view_mode_changed',
        view_mode: viewMode,
        from: previous,
        result_count_bucket: bucketResultCount(cardCount),
      })
    }
    void applyViewMode().then(() => expandCardById(datasetId))
  }

  /** Find a card by its dataset id, collapse any other expanded
   *  card, expand the target, scroll it into view, and focus it.
   *  Safe to call when the card isn't in the DOM (filtered out) —
   *  silently no-ops.
   *
   *  Iterates `.browse-card` and matches on `dataset.id` rather
   *  than using a CSS attribute selector, because dataset IDs can
   *  contain characters that would need escaping inside `[data-id="..."]`
   *  (ULIDs are safe but `legacyId` strings like `INTERNAL_SOS_768`
   *  aren't always — defensive code paths in the codebase prefer
   *  property reads). */
  function expandCardById(datasetId: string): void {
    const grid = document.getElementById('browse-grid')
    if (!grid) return
    let card: HTMLElement | null = null
    const cards = grid.querySelectorAll<HTMLElement>('.browse-card')
    for (const candidate of cards) {
      if (candidate.dataset.id === datasetId) {
        card = candidate
        break
      }
    }
    if (!card) return
    grid.querySelectorAll<HTMLElement>('.browse-card.expanded').forEach(c => {
      c.classList.remove('expanded')
      c.setAttribute('aria-expanded', 'false')
    })
    card.classList.add('expanded')
    card.setAttribute('aria-expanded', 'true')
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    card.focus()
  }

  /**
   * Lazy-import `catalogGraphUI` on first activation. Mirrors the
   * Three.js pattern in `vrSession.ts` — cytoscape is ~70 KB
   * gzipped and only users who toggle into Graph view pay that
   * cost. On import failure (network blip, bundle stripped) the
   * graph container shows an inline error and the controller stays
   * null so subsequent toggles can retry.
   */
  async function ensureGraphMounted(): Promise<void> {
    if (graphController || !graphContainer) return
    if (graphLoadPromise) {
      await graphLoadPromise
      return
    }
    graphContainer.innerHTML = `<div class="browse-graph-status" role="status">${escapeHtml(t('browse.graph.loading'))}</div>`
    const loadPromise = import('./catalogGraphUI')
      .then(({ createCatalogGraph }) => {
        graphContainer.innerHTML = ''
        graphController = createCatalogGraph(graphContainer, {
          onToggleFacet: (facet, value) => {
            applyState(toggleFacet(filterState, facet, value), searchQuery)
          },
          onPreviewDataset: (datasetId: string) => {
            previewDatasetInCards(datasetId)
          },
        })
        return graphController
      })
      .catch((err) => {
        console.error('[browse] failed to load Graph view', err)
        graphContainer.innerHTML = `<div class="browse-graph-status browse-graph-status-error" role="alert">${escapeHtml(t('browse.graph.loadError'))}</div>`
        return null
      })
    graphLoadPromise = loadPromise
    const result = await loadPromise
    // Clear the in-flight handle once it settles so a failed import
    // doesn't permanently block retry. The docstring above promises
    // "subsequent toggles can retry"; without this clear, the
    // memoised `null`-resolving promise would short-circuit forever.
    // On success the early-return at the top of `ensureGraphMounted`
    // (graphController is now set) prevents a duplicate import, so
    // clearing the handle in both branches is safe.
    if (graphLoadPromise === loadPromise) {
      graphLoadPromise = null
    }
    void result
  }

  /**
   * Lazy-import `catalogTimelineUI` on first activation. Mirrors
   * `ensureGraphMounted` — same memoised in-flight handle pattern,
   * same retry-on-error semantics. On import failure (network blip
   * in production, bundle stripped in some federated build) the
   * timeline container shows an inline error and the controller
   * stays null so a subsequent toggle into Timeline can retry.
   */
  async function ensureTimelineMounted(): Promise<void> {
    if (timelineController || !timelineContainer) return
    if (timelineLoadPromise) {
      await timelineLoadPromise
      return
    }
    timelineContainer.innerHTML = `<div class="browse-timeline-status" role="status">${escapeHtml(t('browse.timeline.loading'))}</div>`
    const loadPromise = import('./catalogTimelineUI')
      .then(({ createCatalogTimeline }) => {
        timelineContainer.innerHTML = ''
        timelineController = createCatalogTimeline(timelineContainer, {
          onBrushChange: (range) => {
            // Brush gestures funnel through `setFacet` — same single
            // mutation path the chip rail's range inputs use. The
            // resulting `applyState` re-renders the chip rail (so
            // the inputs follow the brush) AND the timeline (so the
            // brush selection re-syncs from filterState — see the
            // controller's `syncBrushFromFilterState`).
            const next = range == null
              ? setFacet(filterState, 'dataCoverageYear', undefined)
              : setFacet(filterState, 'dataCoverageYear', {
                  kind: 'range',
                  min: range.min,
                  max: range.max,
                })
            applyState(next, searchQuery)
          },
          onPreviewDataset: (datasetId: string) => {
            previewDatasetInCards(datasetId)
          },
        })
        return timelineController
      })
      .catch((err) => {
        console.error('[browse] failed to load Timeline view', err)
        timelineContainer.innerHTML = `<div class="browse-timeline-status browse-timeline-status-error" role="alert">${escapeHtml(t('browse.timeline.loadError'))}</div>`
        return null
      })
    timelineLoadPromise = loadPromise
    const result = await loadPromise
    if (timelineLoadPromise === loadPromise) {
      timelineLoadPromise = null
    }
    void result
  }

  /**
   * Lazy-import `catalogMapUI` on first activation. Mirrors
   * `ensureGraphMounted` / `ensureTimelineMounted` — same memoised
   * in-flight handle pattern, same retry-on-error semantics.
   * MapLibre is already in the bundle (the main globe imports it
   * eagerly) so the chunk cost here is the new module code only;
   * the lazy mount mostly avoids paying the second MapRenderer
   * instance's GIBS-tile warm-up until the user actually opens
   * Map view.
   */
  async function ensureMapMounted(): Promise<void> {
    if (mapController || !mapContainer) return
    if (mapLoadPromise) {
      await mapLoadPromise
      return
    }
    mapContainer.innerHTML = `<div class="browse-map-status" role="status">${escapeHtml(t('browse.map.loading'))}</div>`
    const loadPromise = import('./catalogMapUI')
      .then(({ createCatalogMap }) => {
        mapContainer.innerHTML = ''
        mapController = createCatalogMap(mapContainer, {
          onRegionChange: (bounds) => {
            // Draw gestures funnel through `setFacet` —
            // same single mutation path the chip rail's range
            // inputs and the Timeline brush both use. Clearing
            // passes undefined.
            const next = bounds == null
              ? setFacet(filterState, 'geographicRegion', undefined)
              : setFacet(filterState, 'geographicRegion', {
                  kind: 'bbox',
                  n: bounds.n,
                  s: bounds.s,
                  e: bounds.e,
                  w: bounds.w,
                })
            applyState(next, searchQuery)
          },
          onPreviewDataset: (datasetId: string) => {
            previewDatasetInCards(datasetId)
          },
        })
        return mapController
      })
      .catch((err) => {
        console.error('[browse] failed to load Map view', err)
        mapContainer.innerHTML = `<div class="browse-map-status browse-map-status-error" role="alert">${escapeHtml(t('browse.map.loadError'))}</div>`
        return null
      })
    mapLoadPromise = loadPromise
    const result = await loadPromise
    if (mapLoadPromise === loadPromise) {
      mapLoadPromise = null
    }
    void result
  }

  if (viewModeBar && !viewModeBar.dataset.wired) {
    viewModeBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.browse-view-mode-btn') as HTMLElement | null
      if (!btn || !btn.dataset.viewMode) return
      const next = btn.dataset.viewMode as ViewMode
      if (next === viewMode) return
      const previous = viewMode
      viewMode = next
      saveViewMode(viewMode)
      renderViewModeBar()
      const cardCount = document.querySelectorAll('#browse-grid .browse-card').length
      emit({
        event_type: 'catalog_view_mode_changed',
        view_mode: viewMode,
        from: previous,
        result_count_bucket: bucketResultCount(cardCount),
      })
      void applyViewMode()
    })
    viewModeBar.dataset.wired = 'true'
  }

  // ----- Filters drawer (small-screen, non-Cards views) -----

  const filtersBtn = document.getElementById('browse-filters-btn') as HTMLButtonElement | null
  const filtersBadge = filtersBtn?.querySelector('.browse-filters-btn-badge') as HTMLElement | null
  const filtersLabel = filtersBtn?.querySelector('.browse-filters-btn-label') as HTMLElement | null
  const activeFiltersHost = document.getElementById('browse-active-filters')

  /**
   * Render the Filters button's active-count badge AND the active-
   * filter chip strip together. Both surfaces visualise the same
   * underlying `filterState`, so a single function keeps them in
   * lockstep. Called from `applyState` on every state change; the
   * CSS handles which of them is actually visible (badge only when
   * the drawer button is shown; chip strip only when the drawer
   * is closed in drawer mode).
   *
   * Chips funnel removals through the same `toggleFacet` /
   * `toggleBooleanFacet` / `setFacet` mutations the chip rail uses,
   * so there's exactly one mutation path no matter where the user
   * clicks.
   */
  function renderActiveFilters(): void {
    const chips = collectActiveFilterChips(filterState)
    if (filtersLabel) filtersLabel.textContent = t('browse.filters.toggle.label')
    if (filtersBadge) {
      if (chips.length === 0) {
        filtersBadge.classList.add('hidden')
        filtersBadge.textContent = ''
      } else {
        filtersBadge.classList.remove('hidden')
        filtersBadge.textContent = formatNumber(chips.length)
      }
    }
    if (!activeFiltersHost) return
    if (chips.length === 0) {
      activeFiltersHost.innerHTML = ''
      activeFiltersHost.classList.add('empty')
      return
    }
    activeFiltersHost.classList.remove('empty')
    activeFiltersHost.innerHTML = chips
      .map(chip => {
        const ariaLabel = t('browse.activeFilters.remove.aria', { label: chip.label })
        return `<button type="button" class="browse-active-filter-chip" data-facet="${escapeAttr(chip.facet)}" data-kind="${escapeAttr(chip.kind)}"${chip.value != null ? ` data-value="${escapeAttr(chip.value)}"` : ''} aria-label="${escapeAttr(ariaLabel)}">${escapeHtml(chip.label)}<span class="browse-active-filter-chip-x" aria-hidden="true">×</span></button>`
      })
      .join('')
  }

  // Delegated click handler on the active-filter strip — removes the
  // facet predicate the clicked chip represents. Wired once per
  // overlay instance; the strip's HTML is re-rendered freely.
  if (activeFiltersHost && !activeFiltersHost.dataset.wired) {
    activeFiltersHost.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.browse-active-filter-chip') as HTMLElement | null
      if (!btn) return
      const facet = btn.dataset.facet
      const kind = btn.dataset.kind as 'multi-select' | 'boolean' | 'range' | 'bbox' | undefined
      if (!facet || !kind) return
      if (kind === 'multi-select') {
        const value = btn.dataset.value
        if (value == null) return
        applyState(toggleFacet(filterState, facet, value), searchQuery)
      } else if (kind === 'boolean') {
        applyState(toggleBooleanFacet(filterState, facet), searchQuery)
      } else if (kind === 'range' || kind === 'bbox') {
        // Range + bbox both clear via `setFacet(..., undefined)`.
        // The Map view's draw gesture and the chip rail's range
        // inputs both write via setFacet; clearing matches.
        applyState(setFacet(filterState, facet, undefined), searchQuery)
      }
    })
    activeFiltersHost.dataset.wired = 'true'
  }

  // Filters button wiring — toggles `.filter-drawer-open` on the
  // overlay; CSS controls the rail's positioning + visibility from
  // there. Click-outside-to-close and Escape-to-close are wired
  // once at the document level. The button's visibility itself is
  // CSS-controlled (drawer mode only); the click handler is a no-op
  // when the button isn't visible.
  if (filtersBtn && !filtersBtn.dataset.wired) {
    filtersBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleFilterDrawer()
    })
    filtersBtn.dataset.wired = 'true'
  }

  function isFilterDrawerOpen(): boolean {
    return overlay?.classList.contains('filter-drawer-open') ?? false
  }

  function setFilterDrawerOpen(open: boolean): void {
    if (!overlay) return
    overlay.classList.toggle('filter-drawer-open', open)
    if (filtersBtn) filtersBtn.setAttribute('aria-expanded', String(open))
    // Anchor the drawer-positioned rail just below the toolbar.
    // `offsetTop` is relative to the offset parent (#browse-inner,
    // made `position: relative` in CSS); adding `offsetHeight` puts
    // the drawer's leading edge a hair below the toolbar with a
    // small visual gap. Recompute on each open so a re-layout (e.g.
    // search-result count changed the count line height) doesn't
    // leave the drawer floating in mid-air.
    if (open && rail) {
      const toolbar = document.getElementById('browse-toolbar')
      if (toolbar) {
        const top = toolbar.offsetTop + toolbar.offsetHeight + 8
        rail.style.setProperty('--browse-drawer-top', `${top}px`)
      }
    } else if (rail) {
      rail.style.removeProperty('--browse-drawer-top')
    }
  }

  function toggleFilterDrawer(): void {
    setFilterDrawerOpen(!isFilterDrawerOpen())
  }

  // Document-level dismissal — click outside the rail (or Escape)
  // closes the drawer. Wired once on the overlay via a dataset
  // flag so a second `showBrowseUI` call doesn't double up.
  if (overlay && !overlay.dataset.drawerWired) {
    document.addEventListener('click', (e) => {
      if (!isFilterDrawerOpen()) return
      const target = e.target as HTMLElement
      // Ignore clicks inside the rail itself OR on the Filters
      // button (its own handler manages the toggle).
      if (rail?.contains(target)) return
      if (filtersBtn?.contains(target)) return
      setFilterDrawerOpen(false)
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isFilterDrawerOpen()) {
        setFilterDrawerOpen(false)
        filtersBtn?.focus()
      }
    })
    overlay.dataset.drawerWired = 'true'
  }

  // Live viewport listener — when the user resizes across the 768px
  // breakpoint, snap the view-mode state back to Cards if they were
  // in Graph and the viewport is now narrow. Without this the
  // overlay would show neither Cards (hidden by JS) nor Graph
  // (the toggle is gone) — a blank surface. Also re-render the
  // toggle bar so it appears / disappears symmetrically with the
  // breakpoint.
  // Type alias for the dedupe + legacy listener path.
  type NarrowVpQuery = MediaQueryList & {
    __terravizWired?: boolean
    addListener?: (cb: () => void) => void
  }
  const narrowVpQueryTyped = narrowVpQuery as NarrowVpQuery | null
  if (narrowVpQueryTyped && !narrowVpQueryTyped.__terravizWired) {
    const onNarrowChange = (): void => {
      renderViewModeBar()
      // Map view stays available at all breakpoints per §6.9 ("the
      // most mobile-friendly of the four view-modes") — only Graph
      // and Timeline snap back to Cards on narrow viewports.
      if (isNarrowViewport() && (viewMode === 'graph' || viewMode === 'timeline')) {
        viewMode = 'cards'
        saveViewMode(viewMode)
        void applyViewMode()
      }
    }
    // Newer browsers use addEventListener; older Safari falls back
    // to the deprecated addListener. The Tauri webview on iOS 14
    // still needs the deprecated form.
    if (typeof narrowVpQueryTyped.addEventListener === 'function') {
      narrowVpQueryTyped.addEventListener('change', onNarrowChange)
    } else if (typeof narrowVpQueryTyped.addListener === 'function') {
      narrowVpQueryTyped.addListener(onNarrowChange)
    }
    narrowVpQueryTyped.__terravizWired = true
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
    renderActiveFilters()
    renderCards()
    // Graph / Timeline / Map re-render only when their canvas is
    // the active surface — no sense paying the layout cost for an
    // off-screen canvas. All three controllers' `update()` is
    // incremental: cytoscape preserves node positions across chip-
    // toggle thrashes (the §6.7 "graph thrash" risk), the timeline's
    // d3 scale + brush sync is idempotent, and the map view's
    // bbox-overlay layer swaps its GeoJSON source data in place
    // without re-mounting MapLibre.
    if (viewMode === 'graph' && graphController) {
      const parsed = parseSearchQuery(searchQuery)
      const effectiveState = mergeFilterStates(filterState, parsed.prefixes)
      graphController.update({
        datasets: allDatasets,
        filterState: effectiveState,
        searchQuery: parsed.freeText,
      })
    } else if (viewMode === 'timeline' && timelineController) {
      const parsed = parseSearchQuery(searchQuery)
      const effectiveState = mergeFilterStates(filterState, parsed.prefixes)
      timelineController.update({
        datasets: allDatasets,
        filterState: effectiveState,
        searchQuery: parsed.freeText,
      })
    } else if (viewMode === 'map' && mapController) {
      const parsed = parseSearchQuery(searchQuery)
      const effectiveState = mergeFilterStates(filterState, parsed.prefixes)
      mapController.update({
        datasets: allDatasets,
        filterState: effectiveState,
        searchQuery: parsed.freeText,
      })
    }
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

      // "+" glyph reads as "add" without needing an icon font; the
      // aria-label carries the dataset title for screen readers.
      const playlistAddBtn = `<button class="add-to-playlist-btn browse-card-add-to-playlist"`
        + ` data-dataset-id="${escapeAttr(d.id)}"`
        + ` aria-label="${escapeAttr(t('playlist.action.addToPlaylist.aria', { title: d.title }))}"`
        + ` title="${escapeAttr(t('playlist.action.addToPlaylist'))}"`
        + `>+</button>`

      return `<div class="browse-card" data-id="${escapeAttr(d.id)}" role="listitem" tabindex="0" aria-label="${escapeAttr(d.title)}" aria-expanded="false">
          ${thumbHtml}
          <div class="browse-card-body">
            <div class="browse-card-header">
              <span class="browse-card-title">${escapeHtml(d.title)}</span>
              ${playlistAddBtn}
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
        const addBtn = (e.target as HTMLElement).closest('.browse-card-add-to-playlist') as HTMLButtonElement | null
        if (addBtn) {
          e.stopPropagation()
          const id = addBtn.dataset.datasetId
          if (id) openAddToPlaylistPopover(id, addBtn)
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
  renderActiveFilters()
  renderCards()
  renderViewModeBar()
  // Restore the persisted view mode — if Graph was the last
  // surface the user had open, lazy-import on this boot path so
  // the canvas is ready when they look at it. The grid is also
  // hidden behind .hidden so we don't have a moment of layout
  // flicker.
  void applyViewMode()
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
  // View-aware classes get set by `applyViewMode`; clear them
  // alongside `browse-open` so the body stays clean once the
  // overlay closes.
  document.body.classList.remove('browse-view-cards', 'browse-view-graph', 'browse-view-timeline', 'browse-view-map')
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
  // Mirror hideBrowseUI: drop the view-aware classes so a collapsed
  // overlay doesn't leak its last view-mode styling onto the body.
  document.body.classList.remove('browse-view-cards', 'browse-view-graph', 'browse-view-timeline', 'browse-view-map')
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
 * One renderable entry in the active-filter chip strip. `facet` +
 * `kind` (+ `value` for multi-select) carry the info the click
 * handler needs to remove the predicate via the same mutation
 * helpers the chip rail uses. `label` is the localised display
 * string — every variant is built here so the active-filter strip
 * never has to re-derive vocabulary.
 */
interface ActiveFilterChip {
  facet: string
  kind: 'multi-select' | 'boolean' | 'range' | 'bbox'
  value?: string
  label: string
}

/**
 * Friendly localised label for each boolean facet. Switch (not a
 * lookup table) so `t()` evaluates against the live locale at
 * chip-build time rather than at module load.
 */
function booleanFacetLabel(facet: string): string {
  switch (facet) {
    case 'hasCaptions': return t('browse.filter.hasCaptions.label')
    case 'hasTour': return t('browse.filter.hasTour.label')
    case 'includeSos': return t('browse.filter.includeSos.label')
    default: return facet
  }
}

function formatBucketLabel(value: string): string {
  switch (value) {
    case 'video': return t('browse.filter.format.video')
    case 'image': return t('browse.filter.format.image')
    case 'tour': return t('browse.filter.format.tour')
    case 'other': return t('browse.filter.format.other')
    default: return value
  }
}

function rangeFacetLabel(facet: string, predicate: FacetPredicate): string {
  if (predicate.kind !== 'range') return facet
  const start = predicate.min != null ? String(predicate.min) : '…'
  const end = predicate.max != null ? String(predicate.max) : '…'
  if (facet === 'dataCoverageYear') {
    return t('browse.activeFilters.range.dataCoverage', { start, end })
  }
  if (facet === 'dateAdded') {
    return t('browse.activeFilters.range.dateAdded', { start, end })
  }
  return `${facet} ${start}–${end}`
}

/**
 * Format a bbox predicate for the active-filter chip strip — the
 * only surface that renders the §6.9 geographicRegion predicate's
 * label today. Latitudes use N/S suffixes, longitudes E/W. Single
 * decimal of precision is enough for the chip; the underlying
 * predicate retains 3-decimal precision via the URL round-trip.
 */
function bboxFacetLabel(facet: string, predicate: FacetPredicate): string {
  if (predicate.kind !== 'bbox') return facet
  const latLabel = (v: number): string => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`
  const lonLabel = (v: number): string => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}`
  const ns = `${latLabel(predicate.s)}–${latLabel(predicate.n)}`
  const ew = `${lonLabel(predicate.w)}–${lonLabel(predicate.e)}`
  if (facet === 'geographicRegion') {
    return t('browse.activeFilters.bbox.region', { ns, ew })
  }
  return `${facet} ${ns}, ${ew}`
}

/**
 * Walk `filterState` and emit one chip per active predicate
 * (multi-select facets contribute one chip per value so the user
 * can remove them individually — matching the chip-rail's per-
 * value interaction model).
 */
function collectActiveFilterChips(state: FilterState): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = []
  for (const [facet, predicate] of Object.entries(state)) {
    if (predicate == null) continue
    if (predicate.kind === 'multi-select') {
      for (const value of predicate.values) {
        chips.push({
          facet,
          kind: 'multi-select',
          value,
          label: facet === 'format' ? formatBucketLabel(value) : value,
        })
      }
    } else if (predicate.kind === 'boolean') {
      chips.push({ facet, kind: 'boolean', label: booleanFacetLabel(facet) })
    } else if (predicate.kind === 'range') {
      const hasBound = predicate.min != null || predicate.max != null
      if (!hasBound) continue
      chips.push({ facet, kind: 'range', label: rangeFacetLabel(facet, predicate) })
    } else if (predicate.kind === 'bbox') {
      // §6.9 Map view writes `geographicRegion` via setFacet. The
      // chip removes itself by clearing the predicate, same path
      // a range chip uses.
      chips.push({ facet, kind: 'bbox', label: bboxFacetLabel(facet, predicate) })
    }
  }
  return chips
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
      // Multi-select: removing the last value also deletes the
      // facet entirely (toggleFacet contract). Surface the
      // removed value so a category-slice dashboard still sees
      // which chip was un-toggled. Reserve `:off` for boolean
      // disappearance (where there's no value to surface).
      if (a.kind === 'multi-select' && a.values.length === 1) {
        return `${facet}:${a.values[0]}`
      }
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

