/**
 * Catalog Timeline view — pure transform from a filtered catalog
 * to one row per dataset on a shared time axis.
 *
 * Phase 4 §6.8 of `docs/WEB_CATALOG_FEATURES_PLAN.md`. The Timeline
 * view in `src/ui/catalogTimelineUI.ts` consumes the result. Like
 * the Graph view's `catalogGraph.ts`, the same predicate engine
 * that drives the chip rail (`datasetFilter.ts`) filters the
 * dataset set first, so the timeline always reflects what the
 * user has narrowed to.
 *
 * Pure module — no DOM, no fetch, no d3 import, no analytics.
 * Tests run without happy-dom.
 *
 * Row model:
 *
 *  - One row per filtered dataset that carries `startTime`.
 *  - Rows without `startTime` are not rendered; the count of
 *    excluded rows surfaces via `undatedCount` so the UI can
 *    footnote "N datasets without temporal coverage — switch to
 *    Cards to see them."
 *
 * Domain:
 *
 *  - `min` / `max` are fractional years (e.g. 2020.456 for
 *    mid-June 2020). Spans year-0 reconstructions through
 *    future-dated forecast horizons; we deliberately do NOT
 *    clamp to a recent window because that lies about the
 *    catalog's actual coverage (per the plan's "log-or-piecewise
 *    axis is rejected" note).
 *  - When the filter result is empty the domain is undefined —
 *    callers render an empty-state message instead of a zero-
 *    width axis.
 *
 * Real-time marker (`isRealtime`):
 *
 *  - Set when the dataset has a LIVE update cadence — `period`
 *    parses (fixed units) AND `endTime` is within two cadences of
 *    now, or is absent (Phase Z4: workflow-maintained rows) — OR
 *    when `tags` contain `'Real-Time'` (the curated 10-dataset SOS
 *    subset), OR when `endTime` is within the last 24 hours (a
 *    heuristic for untagged real-time rows). Plan §6.8 documents
 *    the original two rules; `period` widens the window, it never
 *    blanket-marks (historical time-series rows carry `period`
 *    too).
 *  - Computed against an injectable `now` so deterministic tests
 *    pin a fixed clock. Production callers omit it and the
 *    service samples `Date.now()` once per build.
 */

import { isLiveCadence } from '../utils/time'
import type { Dataset } from '../types'
import {
  BASELINE_RESOLVERS,
  PERIOD_RESOLVER,
  filterDatasets,
  mergeFilterStates,
  parseSearchQuery,
  type FacetResolver,
  type FilterState,
} from './datasetFilter'
import type { FacetGroup } from './catalogGraph'

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * One row on the timeline canvas. The pure service emits the
 * minimum the UI needs to render and tooltip; the UI adds pixel
 * coordinates via its d3 scale.
 */
export interface TimelineRow {
  datasetId: string
  title: string
  /** Start year as a fractional year (e.g. 2020.456). Drives the
   *  bar's left edge in pixel space via the UI's linear scale. */
  start: number
  /** End year as a fractional year. For instantaneous rows (`startTime`
   *  set, `endTime` absent and not real-time) `end === start`; for
   *  real-time rows without a curated `endTime` `end` is the build
   *  clock so the bar terminates at "now"; for closed coverage rows
   *  `end` is `endTime`'s fractional year. */
  end: number
  /** Original ISO `startTime` — retained for tooltip rendering so
   *  the UI doesn't have to re-format the fractional year. */
  startIso: string
  /** Original ISO `endTime`. Undefined when the dataset row carries
   *  no endTime and was not promoted to "now" via the real-time
   *  fallback. */
  endIso?: string
  /** True when the dataset is tagged `'Real-Time'` OR `endTime`
   *  is within the last 24 h. UI renders a marker at the trailing
   *  edge for these rows. */
  isRealtime: boolean
  /** Facet group hue token the row inherits. v1 of Timeline
   *  uniformly resolves to `'category-content'` — every dataset is
   *  conceptually a Category member, and the row colour reads
   *  consistent with the §6.7 Graph view's Category cluster hue.
   *  Per-row hue variation (e.g. by primary tag) is a follow-up
   *  if review pushes back. */
  group: FacetGroup
}

/** Min / max fractional years of the visible rows. Drives the d3
 *  scale's domain. Undefined when no rows are visible. */
export interface TimelineDomain {
  min: number
  max: number
}

export interface Timeline {
  rows: TimelineRow[]
  /** Domain over the visible rows. Undefined iff `rows.length === 0`. */
  domain: TimelineDomain | undefined
  /** Datasets that passed the filter but had no `startTime`. They
   *  do not appear on the timeline; the UI footnotes the count so
   *  the user knows to switch to Cards if they need them. */
  undatedCount: number
  /** `rows.length + undatedCount` — total filtered count, useful
   *  for the region aria-label without re-summing. */
  filteredDatasetCount: number
}

export interface BuildTimelineOptions {
  /** Override the clock used for the real-time `endTime` heuristic.
   *  Production callers omit this; tests pin a deterministic
   *  millisecond timestamp. */
  now?: number
  /** Resolvers passed to `filterDatasets` — defaults to the §6.1
   *  baseline plus the search-only `period:` resolver, matching
   *  what `browseUI.ts` uses. */
  resolvers?: Readonly<Record<string, FacetResolver>>
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const DEFAULT_RESOLVERS = { ...BASELINE_RESOLVERS, period: PERIOD_RESOLVER }
/** 24 h in milliseconds — the "fresh endTime" window for the
 *  real-time fallback heuristic. */
const REALTIME_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000
/** Curated tag identifying SOS real-time datasets (10 today). */
const REALTIME_TAG = 'Real-Time'

/**
 * Parse a flexible ISO 8601 / short-ISO / year-prefix string into a
 * fractional year. Returns `undefined` when no year is recoverable.
 *
 * Examples (year + day-of-year fraction):
 *   '2020-01-01T00:00:00Z' → 2020.0
 *   '2020-07-01'           → ~2020.499
 *   '2024-12-31'           → ~2024.999
 *   '2024'                 → 2024.0
 *   '0001-01-01'           → 1.0
 *
 * The fractional component is `(Date.UTC(year, ...) - Date.UTC(year, 0, 1))
 * / Date.UTC(year+1, 0, 1) - Date.UTC(year, 0, 1)` — leap-year-aware via
 * the JS Date object. Years outside the JS Date range (e.g. year 0)
 * fall through to the integer-year extractor below.
 */
export function toFractionalYear(value: string | undefined | null): number | undefined {
  if (!value) return undefined
  const yearMatch = value.match(/^(\d{4})/)
  if (!yearMatch) return undefined
  const year = Number(yearMatch[1])
  if (!Number.isFinite(year)) return undefined

  // Year-prefix-only (no month/day) → return the integer year. Same
  // path for year 0 / 1 where JS Date's UTC year encoding is fragile.
  if (value.length < 7 || year < 100) return year

  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return year
  // Compute the fraction of the calendar year that has elapsed.
  // Date.UTC(year, 0, 1) is the start of the year; (year+1, 0, 1) is
  // the start of the next. Leap-year handled implicitly by Date.UTC.
  const yearStart = Date.UTC(year, 0, 1)
  const nextYearStart = Date.UTC(year + 1, 0, 1)
  const yearLengthMs = nextYearStart - yearStart
  if (yearLengthMs <= 0) return year
  const fraction = (ms - yearStart) / yearLengthMs
  // Clamp to [0, 1) — a Date.parse of e.g. "2020-12-31T23:59:59Z"
  // yields a fraction extremely close to 1.0; we leave it as-is
  // because the d3 scale handles boundary values fine.
  return year + Math.max(0, Math.min(1, fraction))
}

/**
 * True when the dataset should display the real-time trailing-edge
 * marker. Two qualifying conditions, both per plan §6.8:
 *
 *  1. `tags` contains the curated `'Real-Time'` tag (case-sensitive
 *     because tags are themselves canonical from the SOS taxonomy).
 *  2. `endTime` parses to a millisecond timestamp within the last
 *     24 h of `now` — catches real-time rows that aren't tagged.
 *
 * Exported so the UI can render a "real-time" affordance in
 * tooltips without re-implementing the rule.
 */
export function isRealtimeRow(dataset: Dataset, now: number): boolean {
  // Phase Z4 (docs/ZYRA_INTEGRATION_PLAN.md): `period` widens the
  // freshness window around `endTime` rather than blanket-marking —
  // historical time-series rows carry `period` too, so the marker
  // only fires when the trailing edge is within two cadences of
  // now (PR #179 review). The tag override and the 24 h heuristic
  // below are unchanged.
  if (isLiveCadence(dataset.period, dataset.endTime, now)) return true
  if ((dataset.tags ?? []).includes(REALTIME_TAG)) return true
  if (!dataset.endTime) return false
  const ms = Date.parse(dataset.endTime)
  if (!Number.isFinite(ms)) return false
  return ms >= now - REALTIME_FRESH_WINDOW_MS && ms <= now + REALTIME_FRESH_WINDOW_MS
}

/**
 * Build the timeline from a catalog + filter state + free-text query.
 *
 * Mirrors `buildGraph` from `catalogGraph.ts`: chip-rail state and
 * any `category:foo` prefix tokens in the search query merge via
 * `mergeFilterStates`, then `filterDatasets` narrows to the visible
 * set. Rows are sorted by `start` ascending so the catalog's
 * historical depth reads top-down (oldest at the top).
 *
 * @param datasets    Full catalog. Hidden datasets are excluded by
 *                    `filterDatasets` automatically.
 * @param filterState Chip-rail state from `browseUI.ts`.
 * @param searchQuery Raw search-box string. Defaults to `''`.
 * @param options     Optional `now` override (tests) + custom
 *                    resolver registry.
 */
export function buildTimeline(
  datasets: readonly Dataset[],
  filterState: FilterState,
  searchQuery: string = '',
  options: BuildTimelineOptions = {},
): Timeline {
  const resolvers = options.resolvers ?? DEFAULT_RESOLVERS
  const now = options.now ?? Date.now()
  const nowFractional = toFractionalYear(new Date(now).toISOString()) ?? new Date(now).getUTCFullYear()

  const parsed = parseSearchQuery(searchQuery)
  const effectiveState = mergeFilterStates(filterState, parsed.prefixes)
  const filtered = filterDatasets(datasets, effectiveState, parsed.freeText, resolvers)

  const rows: TimelineRow[] = []
  let undatedCount = 0
  let domainMin = Infinity
  let domainMax = -Infinity

  for (const dataset of filtered) {
    const start = toFractionalYear(dataset.startTime)
    if (start == null) {
      // No parseable start. Per §6.8 these rows don't appear on the
      // canvas; we count them so the UI can footnote the omission.
      undatedCount += 1
      continue
    }
    const realtime = isRealtimeRow(dataset, now)
    let end: number
    let endIso: string | undefined
    if (dataset.endTime) {
      const parsedEnd = toFractionalYear(dataset.endTime)
      end = parsedEnd ?? start
      endIso = dataset.endTime
    } else if (realtime) {
      // Real-time row without an explicit `endTime` extends to "now"
      // — the bar terminates at the right edge of the current
      // window. Matches the plan's "open-ended bar" intent.
      end = nowFractional
      endIso = undefined
    } else {
      // Instantaneous coverage (e.g. event-marker datasets). The
      // bar collapses to a point; the UI gives it a minimum pixel
      // width so it's still visible.
      end = start
      endIso = undefined
    }
    // Defensive: a malformed `endTime` parsing to before `start`
    // would draw a negative-width bar. Clamp `end` up to `start`
    // so the bar collapses to a point — catalog data quality is
    // variable, and the user still benefits from seeing the row
    // (the tooltip's original ISO strings still surface the raw
    // values for diagnosis).
    if (end < start) {
      end = start
    }

    rows.push({
      datasetId: dataset.id,
      title: dataset.title,
      start,
      end,
      startIso: dataset.startTime ?? '',
      endIso,
      isRealtime: realtime,
      group: 'category-content',
    })

    if (start < domainMin) domainMin = start
    if (end > domainMax) domainMax = end
  }

  // Sort by start ascending — oldest at the top so the user reads
  // historical depth first. Ties broken by title for stability;
  // d3 cares about insertion order on the y-scale's range mapping
  // (we hand rows to it positionally), so a stable sort matters.
  rows.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    if (a.end !== b.end) return a.end - b.end
    return a.title.localeCompare(b.title)
  })

  const domain: TimelineDomain | undefined =
    rows.length === 0
      ? undefined
      : { min: domainMin, max: domainMax === domainMin ? domainMax + 1 : domainMax }
  // The `domainMax === domainMin` pad is for the degenerate case
  // where every visible row is a single-point at the same year —
  // a zero-width domain would crash the d3 linear scale's `invert`.

  return {
    rows,
    domain,
    undatedCount,
    filteredDatasetCount: rows.length + undatedCount,
  }
}
