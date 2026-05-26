/**
 * Catalog Map view — pure transform from a filtered catalog to one
 * rectangular bbox overlay per dataset with geographic coverage.
 *
 * Phase 4 §6.9 of `docs/WEB_CATALOG_FEATURES_PLAN.md`. The Map view
 * in `src/ui/catalogMapUI.ts` consumes the result. Like the Graph
 * view's `catalogGraph.ts` and the Timeline view's
 * `catalogTimeline.ts`, the same predicate engine that drives the
 * chip rail (`datasetFilter.ts`) filters the dataset set first, so
 * the map always reflects what the user has narrowed to.
 *
 * Pure module — no DOM, no fetch, no MapLibre import, no analytics.
 * Tests run without happy-dom.
 *
 * Overlay model:
 *
 *  - One bbox per filtered dataset that carries `boundingBox`.
 *  - Datasets without a `boundingBox` are excluded; the count of
 *    excluded rows surfaces via `undatedCount` (named for symmetry
 *    with `catalogTimeline.ts`; "undated" reads as "no spatial
 *    extent" here) so the UI can footnote "N datasets without
 *    geographic coverage — switch to Cards to see them."
 *  - Pure-global bboxes (`north ≥ 89 && south ≤ -89 && east-west
 *    span ≥ 358`) are suppressed by default because they crowd the
 *    canvas with overlapping world-rectangles that signal "no
 *    spatial filter" rather than meaningful regional coverage. The
 *    plan calls for a toggle to surface them; `hiddenGlobalCount`
 *    is the input to the "N global datasets hidden — toggle to
 *    include" footer label. Set `options.includeGlobal = true` to
 *    surface every box uniformly.
 *
 * Antimeridian-crossing boxes:
 *
 *  - Some catalog rows are centred on the Pacific and encode their
 *    east longitude as a smaller value than their west longitude
 *    (e.g. `{w: 170, e: -170}` meaning "wrap east through 180 to
 *    -170"). The pure transform preserves the bbox as-is — wrapping
 *    longitudes past 180 for polygon rendering is the UI's job
 *    (MapLibre handles wrapped polygon coordinates natively when
 *    you encode the east longitude as `170 + 360 - (180+170) = 190`
 *    rather than `-170`). `crossesAntimeridian` is exported so the
 *    UI can apply the wrap consistently.
 *
 * Real-time marker (`isRealtime`):
 *
 *  - Mirrors `catalogTimeline.ts` semantics — tagged `'Real-Time'`
 *    or `endTime` within ±24 h of `now`. The plan §6.9 notes this
 *    as "optional" UI affordance (a small green dot on the bbox);
 *    the pure transform always emits the flag, the UI can choose
 *    whether to render it.
 */

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
 * One rectangular overlay on the map canvas. The pure service
 * emits the minimum the UI needs to render the polygon and the
 * hover tooltip; the UI adds projected pixel coordinates and
 * antimeridian wrapping via MapLibre.
 */
export interface MapBboxOverlay {
  datasetId: string
  title: string
  /** Geographic bounding box (NSWE in degrees) from the dataset's
   *  `boundingBox` field. Preserved verbatim — the UI handles
   *  antimeridian wrapping for rendering (`crossesAntimeridian`
   *  surfaces the cue without mutating the bbox). */
  bounds: { n: number; s: number; e: number; w: number }
  /** True when the bbox spans every longitude (`e - w ≥ 358`) AND
   *  every latitude (`n ≥ 89 && s ≤ -89`). Pure-global bboxes are
   *  hidden by default; the UI footer reads "N global datasets
   *  hidden — toggle to include." */
  global: boolean
  /** True when the dataset is tagged `'Real-Time'` OR `endTime`
   *  is within the last 24 h. Mirrors `catalogTimeline.ts`'s
   *  `isRealtime` so the two views share the same real-time
   *  taxonomy. The UI can render an accent dot or amber border;
   *  optional per the plan. */
  isRealtime: boolean
  /** Facet group hue token the overlay inherits. v1 of Map view
   *  uniformly resolves to `'category-content'` — same teal the
   *  Graph and Timeline views use for Category-tagged rows so all
   *  three view-modes read as one visual system. Per-overlay hue
   *  variation by primary tag is a follow-up. */
  group: FacetGroup
  /** True when the bbox crosses the antimeridian (180° / -180°),
   *  detected via `w > e`. The UI uses this to wrap east-longitude
   *  past 180° when building the polygon coordinates so MapLibre
   *  renders the rectangle continuously across the dateline. */
  crossesAntimeridian: boolean
}

export interface CatalogMap {
  bboxes: MapBboxOverlay[]
  /** Filtered datasets that are pure-global and were suppressed by
   *  the default `includeGlobal: false` toggle. The UI uses this to
   *  render "N global datasets hidden — toggle to include." */
  hiddenGlobalCount: number
  /** Filtered datasets without a parseable `boundingBox` field.
   *  Hidden from the canvas; the UI footnotes the count so the
   *  user knows to switch to Cards if they need them. Named
   *  `undatedCount` for symmetry with `catalogTimeline.ts`
   *  ("undated" reads here as "no spatial extent"). */
  undatedCount: number
  /** `bboxes.length + hiddenGlobalCount + undatedCount` — total
   *  filtered count, useful for the region aria-label without
   *  re-summing. */
  filteredDatasetCount: number
}

export interface BuildMapOptions {
  /** Surface pure-global bboxes alongside regional ones. Default
   *  `false`: hide-globals is the plan's recommended default
   *  because a catalog dominated by full-globe rectangles reads
   *  as "no spatial filter" rather than meaningful coverage. */
  includeGlobal?: boolean
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
 * Detect a pure-global bbox per the §6.9 threshold. `north ≥ 89`,
 * `south ≤ -89`, and east-west span `≥ 358` together capture both
 * the canonical `{n:90, s:-90, w:-180, e:180}` shape (~26 of the
 * 27 populated SOS rows) and the slight rounding variants the
 * enriched-metadata pipeline occasionally produces. Anything
 * narrower in either axis is "regional" and surfaces by default.
 *
 * Exported for tests + the UI footer label.
 */
export function isGlobalBbox(bounds: { n: number; s: number; e: number; w: number }): boolean {
  if (bounds.n < 89 || bounds.s > -89) return false
  // East-west span. Antimeridian-crossing boxes (w > e) encode
  // their span as `(e + 360) - w`; pure-global rows in the SOS
  // snapshot always use the canonical `w=-180, e=180` shape so
  // `e - w = 360` falls through the non-crossing branch.
  const span = bounds.e >= bounds.w
    ? bounds.e - bounds.w
    : (bounds.e + 360) - bounds.w
  return span >= 358
}

/**
 * Detect an antimeridian-crossing bbox. The catalog encodes a
 * Pacific-centred dataset as `{w: 170, e: -170}` meaning "wrap
 * east through 180° to -170°". We treat `w > e` as the signal —
 * a non-crossing box always has `w ≤ e`.
 *
 * Exported for the UI so it can wrap east-longitude past 180°
 * when building MapLibre polygon coordinates.
 */
export function crossesAntimeridian(bounds: { e: number; w: number }): boolean {
  return bounds.w > bounds.e
}

/**
 * True when the dataset should display the real-time marker.
 * Mirrors `isRealtimeRow` in `catalogTimeline.ts` — same two
 * qualifying conditions per plan §6.8/§6.9:
 *
 *  1. `tags` contains the curated `'Real-Time'` tag.
 *  2. `endTime` parses to a millisecond timestamp within ±24 h
 *     of `now`.
 */
function isRealtimeBbox(dataset: Dataset, now: number): boolean {
  if ((dataset.tags ?? []).includes(REALTIME_TAG)) return true
  if (!dataset.endTime) return false
  const ms = Date.parse(dataset.endTime)
  if (!Number.isFinite(ms)) return false
  return ms >= now - REALTIME_FRESH_WINDOW_MS && ms <= now + REALTIME_FRESH_WINDOW_MS
}

/**
 * Validate a bbox's numeric shape. A dataset with a partially
 * populated `boundingBox` (e.g. only `n` and `s` set) is treated
 * as "no spatial extent" — same as a row with no `boundingBox`
 * at all. Tightens the contract so the UI never tries to render
 * a polygon with NaN corners.
 */
function isValidBbox(bb: { n: number; s: number; e: number; w: number } | undefined): bb is { n: number; s: number; e: number; w: number } {
  if (!bb) return false
  if (!Number.isFinite(bb.n) || !Number.isFinite(bb.s)) return false
  if (!Number.isFinite(bb.e) || !Number.isFinite(bb.w)) return false
  // North must be at or above south (latitudes are naturally ordered
  // — there's no "wrap" axis equivalent for latitude). A flipped
  // bbox (n < s) is data corruption; skip rather than crash.
  if (bb.n < bb.s) return false
  return true
}

/**
 * Build the map overlays from a catalog + filter state + free-text
 * query.
 *
 * Mirrors `buildTimeline` from `catalogTimeline.ts`: chip-rail
 * state and any prefix tokens in the search query merge via
 * `mergeFilterStates`, then `filterDatasets` narrows to the
 * visible set. Overlays are returned in input order (no spatial
 * sort needed — the UI handles overlap resolution via the
 * tooltip's top-N-by-relevance cap).
 *
 * @param datasets    Full catalog. Hidden datasets are excluded by
 *                    `filterDatasets` automatically.
 * @param filterState Chip-rail state from `browseUI.ts`.
 * @param searchQuery Raw search-box string. Defaults to `''`.
 * @param options     `includeGlobal` toggle + `now` override +
 *                    custom resolver registry.
 */
export function buildMap(
  datasets: readonly Dataset[],
  filterState: FilterState,
  searchQuery: string = '',
  options: BuildMapOptions = {},
): CatalogMap {
  const resolvers = options.resolvers ?? DEFAULT_RESOLVERS
  const now = options.now ?? Date.now()
  const includeGlobal = options.includeGlobal ?? false

  const parsed = parseSearchQuery(searchQuery)
  const effectiveState = mergeFilterStates(filterState, parsed.prefixes)
  const filtered = filterDatasets(datasets, effectiveState, parsed.freeText, resolvers)

  const bboxes: MapBboxOverlay[] = []
  let hiddenGlobalCount = 0
  let undatedCount = 0

  for (const dataset of filtered) {
    if (!isValidBbox(dataset.boundingBox)) {
      undatedCount += 1
      continue
    }
    const bounds = dataset.boundingBox
    const global = isGlobalBbox(bounds)
    if (global && !includeGlobal) {
      hiddenGlobalCount += 1
      continue
    }
    bboxes.push({
      datasetId: dataset.id,
      title: dataset.title,
      bounds: { n: bounds.n, s: bounds.s, e: bounds.e, w: bounds.w },
      global,
      isRealtime: isRealtimeBbox(dataset, now),
      group: 'category-content',
      crossesAntimeridian: crossesAntimeridian(bounds),
    })
  }

  return {
    bboxes,
    hiddenGlobalCount,
    undatedCount,
    filteredDatasetCount: bboxes.length + hiddenGlobalCount + undatedCount,
  }
}
