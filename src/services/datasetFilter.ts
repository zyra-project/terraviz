/**
 * Catalog filter predicate engine.
 *
 * Phase 4 §6.6 of `docs/WEB_CATALOG_FEATURES_PLAN.md`. The chip
 * rail in `browseUI.ts`, the field-prefixed search box, and the
 * forthcoming Graph / Timeline / Map view modes (§6.7–§6.9) all
 * funnel their filter state through this module, so a single
 * predicate engine drives every browse surface.
 *
 * The shape is deliberately generic — facet names are strings and
 * resolvers are looked up by name — so SOS-parity facets (NGSS,
 * Theme) layer in by registering new resolvers when the metadata
 * arrives, and federated peer facets (§1.4) can slot in once
 * `/.well-known/terraviz.json` advertises them. Baseline v1 hard-
 * codes the §6.1 facet set.
 *
 * Pure module — no DOM, no fetch, no analytics, no localStorage.
 * Tests run without happy-dom.
 */

import type { Dataset, DatasetFormat } from '../types'

// ---------------------------------------------------------------------------
// Predicate shape
// ---------------------------------------------------------------------------

/**
 * A single filter on one facet. Variants:
 *
 *  - `multi-select` — a chip group; values combine as OR within the
 *    facet (any selected value matches). Used for Category, Keyword,
 *    Format.
 *  - `boolean` — a toggle. The presence of the predicate is the
 *    signal; `value: true` is the only carried payload so the URL
 *    form stays compact (`cc=1`). Boolean facets that mean
 *    *include* a normally-excluded subset (see {@link INVERSE_DEFAULT_FACETS})
 *    carry an inverse default — absence excludes, presence includes.
 *  - `range` — inclusive numeric range. `min`/`max` are independently
 *    optional so half-open ranges work.
 *  - `bbox` — geographic bounding box for the future Map view
 *    (§6.9). The engine carries the shape today even though the
 *    resolver isn't wired until §6.9 ships, so encode/decode and
 *    type-checking are forward-compat.
 */
export type FacetPredicate =
  | { kind: 'multi-select'; values: readonly string[] }
  | { kind: 'boolean'; value: true }
  | { kind: 'range'; min?: number; max?: number }
  | { kind: 'bbox'; n: number; s: number; e: number; w: number }

/**
 * The complete filter state. A facet absent from the record is
 * unconstrained (subject to the inverse-default rule for
 * {@link INVERSE_DEFAULT_FACETS}). Readonly so callers can rely on
 * `toggleFacet` returning a new object rather than mutating in
 * place.
 */
export type FilterState = Readonly<Partial<Record<string, FacetPredicate>>>

/**
 * A resolver tests one predicate against one dataset and returns
 * true when the dataset satisfies the predicate. Registering a
 * new resolver is how the engine learns a new facet (NGSS,
 * federation peer, …) without modification.
 */
export type FacetResolver = (predicate: FacetPredicate, dataset: Dataset) => boolean

// ---------------------------------------------------------------------------
// Baseline facets and their resolvers (§6.1)
// ---------------------------------------------------------------------------

/**
 * Facets whose "absent" default *excludes* a normally-hidden
 * subset. When the user opts in (`{kind:'boolean', value:true}`)
 * the exclusion lifts.
 *
 * `includeSos` is the only entry today — the SOS-source-quality
 * toggle defaults off so today's 204-dataset browse surface
 * doesn't suddenly grow to 520 without consent (§6.4). Other
 * facets land here if they need the same polarity.
 *
 * Wired generically — {@link filterDatasets} reads from this map
 * to enforce the exclusion when the corresponding facet is
 * absent from `state`. Adding a new inverse-default facet means
 * adding its name here AND its exclusion test to
 * {@link INVERSE_DEFAULT_EXCLUSIONS}; the engine handles the
 * rest.
 */
export const INVERSE_DEFAULT_FACETS = new Set<string>(['includeSos'])

/**
 * Predicate that returns true when a dataset should be excluded
 * under the inverse-default rule for a given facet (i.e. when
 * the user has not opted in). The map is keyed by facet name and
 * must stay in lockstep with {@link INVERSE_DEFAULT_FACETS}.
 *
 * `includeSos` excludes synthesised SOS-only rows so today's
 * 204-dataset surface doesn't grow without consent (§6.4).
 */
export const INVERSE_DEFAULT_EXCLUSIONS: Readonly<Record<string, (dataset: Dataset) => boolean>> = {
  includeSos: (dataset) => dataset.availableFor === 'SOS',
}

/**
 * Coarse format buckets surfaced as user-facing chips. The
 * `Dataset.format` field carries the raw MIME-ish string
 * (`video/mp4`, `image/jpeg`, `tour/json`); chips collapse them
 * to four user-comprehensible labels per §6.1.
 */
export type FormatBucket = 'video' | 'image' | 'tour' | 'other'

/**
 * Bucket a raw `Dataset.format` value to one of the four user-
 * facing buckets. Anything that isn't recognised falls through
 * to `'other'` so a wire-shape change can't accidentally drop
 * rows.
 */
export function formatToBucket(format: DatasetFormat | string | undefined): FormatBucket {
  if (!format) return 'other'
  if (format.startsWith('video/')) return 'video'
  if (format.startsWith('image') || format.startsWith('images/')) return 'image'
  if (format.startsWith('tour/')) return 'tour'
  return 'other'
}

/**
 * Extract a four-digit year from a flexible date string. Accepts
 * ISO 8601 (`2024-01-15T00:00:00Z`), short ISO (`2024-01-15`), or
 * a bare four-digit prefix (`2024`). Returns `undefined` when no
 * year is recoverable — callers treat that as "this dataset has no
 * date to filter on" and skip it.
 *
 * Years in the enriched metadata occasionally carry historical
 * dates (year 0, 1500, 1800) — the regex captures any four-digit
 * run at the start, intentionally NOT clamping to the 1900–2100
 * window so reconstruction datasets remain filterable.
 */
export function extractYear(value: string | undefined | null): number | undefined {
  if (!value) return undefined
  const match = value.match(/^(\d{4})/)
  if (!match) return undefined
  const year = Number(match[1])
  return Number.isFinite(year) ? year : undefined
}

/** Apply a `range` predicate inclusively. Half-open ranges (only
 *  `min` or only `max`) are honoured. */
function inRange(value: number, predicate: Extract<FacetPredicate, { kind: 'range' }>): boolean {
  if (predicate.min != null && value < predicate.min) return false
  if (predicate.max != null && value > predicate.max) return false
  return true
}

/**
 * The §6.1 baseline resolvers, keyed by facet name. Exported so
 * callers can layer additional resolvers on top (`{ ...BASELINE_RESOLVERS, ngssGrade: ... }`)
 * without losing the baseline behaviour.
 *
 * Conventions across resolvers:
 *  - `multi-select` predicates with an empty `values` array match
 *    everything (a degenerate chip group should not exclude rows).
 *  - Missing dataset fields cause the predicate to *fail* — a
 *    "has captions" filter excludes datasets where the field is
 *    absent, mirroring the user's expectation that the chip
 *    promises a positive signal.
 */
export const BASELINE_RESOLVERS: Readonly<Record<string, FacetResolver>> = {
  /**
   * Category — driven by `Dataset.tags`. §6.1's 11-value SOS
   * taxonomy (Water, People, Air, Land, Movies, Space, Real-Time,
   * Tours, Snow and Ice, Layers, Extras). Compared case-sensitively
   * because the catalog tag values are themselves canonical.
   */
  category: (predicate, dataset) => {
    if (predicate.kind !== 'multi-select') return false
    if (predicate.values.length === 0) return true
    const tags = dataset.tags ?? []
    return predicate.values.some(v => tags.includes(v))
  },

  /**
   * Keyword — driven by `enriched.keywords`, with `tags` as a
   * fallback for SOS-only synthesised rows that have tags but no
   * enriched keywords (mirroring {@link collectKeywords} in
   * relatedDatasets.ts). Matching is case-insensitive because the
   * keyword vocabulary is author-written.
   */
  keyword: (predicate, dataset) => {
    if (predicate.kind !== 'multi-select') return false
    if (predicate.values.length === 0) return true
    const enrichedKws = dataset.enriched?.keywords
    const haystack = enrichedKws && enrichedKws.length > 0
      ? enrichedKws.map(k => k.toLowerCase())
      : (dataset.tags ?? []).map(k => k.toLowerCase())
    return predicate.values.some(v => haystack.includes(v.toLowerCase()))
  },

  /**
   * Format — collapsed to four buckets via {@link formatToBucket}.
   * Predicate values are the bucket strings (`'video'`,
   * `'image'`, `'tour'`, `'other'`).
   */
  format: (predicate, dataset) => {
    if (predicate.kind !== 'multi-select') return false
    if (predicate.values.length === 0) return true
    const bucket = formatToBucket(dataset.format)
    return predicate.values.includes(bucket)
  },

  /**
   * Date added — year range against `enriched.dateAdded`. The
   * field is a flexible date string in practice; {@link extractYear}
   * tolerates ISO 8601, short ISO, and bare year prefixes.
   * Datasets without a parseable `dateAdded` fail the predicate.
   */
  dateAdded: (predicate, dataset) => {
    if (predicate.kind !== 'range') return false
    const year = extractYear(dataset.enriched?.dateAdded)
    if (year == null) return false
    return inRange(year, predicate)
  },

  /**
   * Data-coverage year — range *overlap* against `startTime`/
   * `endTime`. A dataset matches when its coverage interval
   * intersects the requested range. Rows missing both endpoints
   * fail; rows with only `startTime` are treated as instantaneous.
   *
   * Predicate + URL plumbing only in v1 — the chip-rail UI for
   * this facet ships as a follow-up (the dual-thumb range
   * slider is non-trivial). Lives here so the Graph / Timeline /
   * Map views can already brush against it.
   */
  dataCoverageYear: (predicate, dataset) => {
    if (predicate.kind !== 'range') return false
    const startYear = extractYear(dataset.startTime)
    const endYear = extractYear(dataset.endTime) ?? startYear
    if (startYear == null || endYear == null) return false
    const intervalStart = Math.min(startYear, endYear)
    const intervalEnd = Math.max(startYear, endYear)
    // Two intervals overlap iff each starts before the other ends.
    if (predicate.max != null && intervalStart > predicate.max) return false
    if (predicate.min != null && intervalEnd < predicate.min) return false
    return true
  },

  /**
   * Has closed captions — boolean toggle. Surfaces datasets whose
   * `closedCaptionLink` is a non-empty string (the SOS feed
   * occasionally serves the empty string for "no captions").
   */
  hasCaptions: (predicate, dataset) => {
    if (predicate.kind !== 'boolean') return false
    return typeof dataset.closedCaptionLink === 'string' && dataset.closedCaptionLink.length > 0
  },

  /**
   * Has tour — boolean toggle. Surfaces datasets whose `format` is
   * `tour/json`, i.e. publisher Tours and SOS tour files with a
   * curated task sequence (camera moves, narration, dataset
   * orchestration).
   *
   * The original shape of this resolver tested `runTourOnLoad`,
   * which the publisher pipeline now sets on most imported rows
   * to mean "auto-play on load" rather than "this is a curated
   * tour". That overload made the toggle effectively a no-op
   * (it surfaced almost the entire catalog). Filtering on the
   * format string instead aligns the chip's behaviour with what
   * the label promises — see PR #137 discussion.
   */
  hasTour: (predicate, dataset) => {
    if (predicate.kind !== 'boolean') return false
    return dataset.format === 'tour/json'
  },

  /**
   * SOS source quality — inverse default. When the user opts in
   * (`{kind:'boolean', value:true}`) every row passes; when the
   * facet is absent the engine's outer loop applies the inverse
   * default and excludes `availableFor === 'SOS'`. The resolver
   * itself returns true unconditionally when the predicate is
   * present because the user has explicitly asked for everything.
   */
  includeSos: (predicate) => predicate.kind === 'boolean',

  /**
   * Geographic region — bbox intersection against `Dataset.boundingBox`.
   * Phase 4 §6.9 of `docs/WEB_CATALOG_FEATURES_PLAN.md`. The Map
   * view's draw-rectangle gesture writes this predicate via
   * `setFacet('geographicRegion', { kind: 'bbox', n, s, e, w })`;
   * the chip rail surfaces it as a removable "Region X°–Y°" chip
   * through the existing active-filter strip renderer.
   *
   * Semantics: a dataset matches when its bbox overlaps the
   * predicate's bbox on BOTH the latitude AND the longitude axis.
   * Two intervals overlap iff each starts before the other ends —
   * the same overlap test the `dataCoverageYear` resolver uses for
   * time intervals. Rows without `boundingBox` fail the predicate;
   * the Map view's UI hides them anyway (per `catalogMap.ts`) but
   * the resolver enforces the same exclusion so chip-rail
   * filtering stays consistent across Card / Graph / Timeline.
   *
   * Antimeridian handling: longitudes that cross the dateline are
   * encoded as `w > e` (e.g. `{w: 170, e: -170}` meaning "wrap east
   * through 180° to -170°"). The resolver splits any wrapped bbox
   * into two non-wrapping segments at ±180° — a wrapped bbox
   * `[170, -170]` becomes `[170, 180]` and `[-180, -170]`. It
   * then overlap-tests every pair of (dataset-segment,
   * predicate-segment); the dataset matches iff at least one pair
   * overlaps. This works symmetrically for both axes — wrapped
   * predicate × non-wrapped dataset, non-wrapped predicate ×
   * wrapped dataset, and wrapped × wrapped all fall out of the
   * same loop.
   */
  geographicRegion: (predicate, dataset) => {
    if (predicate.kind !== 'bbox') return false
    const bb = dataset.boundingBox
    if (!bb) return false
    if (!Number.isFinite(bb.n) || !Number.isFinite(bb.s)) return false
    if (!Number.isFinite(bb.e) || !Number.isFinite(bb.w)) return false
    // Latitude axis — naturally ordered, no wrap to worry about.
    // A flipped dataset bbox (n < s) is invalid; bail.
    if (bb.n < bb.s) return false
    const predN = Math.max(predicate.n, predicate.s)
    const predS = Math.min(predicate.n, predicate.s)
    if (bb.n < predS) return false
    if (bb.s > predN) return false
    // Longitude axis — handle the antimeridian. Build each side's
    // longitude segments, splitting any wrapped bbox at ±180°. A
    // standard (non-crossing) bbox is one segment `[w, e]`; a
    // crossing bbox is two segments `[w, 180]` and `[-180, e]`.
    const datasetSegments = bb.w <= bb.e
      ? [[bb.w, bb.e] as [number, number]]
      : [[bb.w, 180] as [number, number], [-180, bb.e] as [number, number]]
    const predSegments = predicate.w <= predicate.e
      ? [[predicate.w, predicate.e] as [number, number]]
      : [[predicate.w, 180] as [number, number], [-180, predicate.e] as [number, number]]
    for (const [aw, ae] of datasetSegments) {
      for (const [pw, pe] of predSegments) {
        // Two longitude intervals overlap iff each starts before
        // the other ends. Inclusive on both ends — a shared edge
        // counts as overlap (a coast-line predicate touching a
        // coast-line bbox is meaningful).
        if (aw <= pe && pw <= ae) return true
      }
    }
    return false
  },
}

/**
 * Build a resolver for the `recentlyViewed` boolean facet (§9.2).
 * Closes over the set of dataset ids the user has visited so the
 * predicate stays "datasetId in visits" while this module stays pure
 * (no localStorage import — the caller in `browseUI.ts` reads
 * `visitMemory.getVisitedIds()` and passes the set in, composing the
 * resolver onto {@link BASELINE_RESOLVERS}).
 *
 * The predicate's mere presence (a boolean toggle) is the signal; a
 * dataset matches when its id is in `visitedIds`. An empty set matches
 * nothing — but the chip itself is hidden when there's no visit
 * history, so that degenerate state isn't reachable from the UI.
 */
export function makeRecentlyViewedResolver(visitedIds: ReadonlySet<string>): FacetResolver {
  return (predicate, dataset) => {
    if (predicate.kind !== 'boolean') return false
    return visitedIds.has(dataset.id)
  }
}

// ---------------------------------------------------------------------------
// Free-text search
// ---------------------------------------------------------------------------

/**
 * Substring-match a search query against a dataset's title,
 * description, keywords, tags, and category names. Matches
 * today's `browseUI.ts` behaviour so the chip-rail rewrite
 * doesn't regress the search box.
 *
 * Empty query matches every dataset.
 */
export function matchesSearchQuery(dataset: Dataset, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  const title = dataset.title.toLowerCase()
  if (title.includes(needle)) return true
  const desc = (dataset.enriched?.description ?? dataset.abstractTxt ?? '').toLowerCase()
  if (desc.includes(needle)) return true
  const keywords = [...(dataset.enriched?.keywords ?? []), ...(dataset.tags ?? [])]
    .join(' ').toLowerCase()
  if (keywords.includes(needle)) return true
  const cats = Object.keys(dataset.enriched?.categories ?? {}).join(' ').toLowerCase()
  return cats.includes(needle)
}

// ---------------------------------------------------------------------------
// Top-level filter
// ---------------------------------------------------------------------------

/**
 * Apply a {@link FilterState} and a free-text search query to a
 * catalog. The returned array is the input filtered down — order
 * is preserved so the caller can chain `.sort()` after.
 *
 * Semantics:
 *  - Hidden datasets (`isHidden`) are always excluded — they
 *    don't appear in the browse surface today and the engine
 *    enforces that invariant.
 *  - SOS-only synthesised rows (`availableFor === 'SOS'`) are
 *    excluded unless `state.includeSos` is set. See
 *    {@link INVERSE_DEFAULT_FACETS}.
 *  - Every other facet predicate is AND-combined; values within a
 *    `multi-select` facet are OR-combined inside the resolver.
 *  - The free-text query is AND-combined with the facet result.
 *  - Unknown facet keys are silently ignored (forward-compat
 *    with federated peer facets a future client may not know
 *    about).
 *
 * The `resolvers` parameter defaults to {@link BASELINE_RESOLVERS}.
 * Callers that need extra resolvers should compose:
 * `{ ...BASELINE_RESOLVERS, ngssGrade: customResolver }`.
 */
export function filterDatasets(
  datasets: readonly Dataset[],
  state: FilterState,
  searchQuery: string,
  resolvers: Readonly<Record<string, FacetResolver>> = BASELINE_RESOLVERS,
): Dataset[] {
  const query = searchQuery.trim().toLowerCase()
  const activeEntries = Object.entries(state).filter(
    (entry): entry is [string, FacetPredicate] => entry[1] != null,
  )
  // Pre-compute which inverse-default facets are still in their
  // "absent" state so the per-row loop can iterate a small array
  // instead of re-checking presence for every row. Adding a new
  // inverse-default facet automatically participates here via
  // INVERSE_DEFAULT_FACETS + INVERSE_DEFAULT_EXCLUSIONS — no
  // engine change required.
  const inverseDefaultExclusions: Array<(d: Dataset) => boolean> = []
  for (const facet of INVERSE_DEFAULT_FACETS) {
    if (state[facet] != null) continue
    const exclude = INVERSE_DEFAULT_EXCLUSIONS[facet]
    if (exclude) inverseDefaultExclusions.push(exclude)
  }

  const result: Dataset[] = []
  for (const dataset of datasets) {
    if (dataset.isHidden) continue
    let excludedByInverseDefault = false
    for (const exclude of inverseDefaultExclusions) {
      if (exclude(dataset)) { excludedByInverseDefault = true; break }
    }
    if (excludedByInverseDefault) continue
    if (!matchesSearchQuery(dataset, query)) continue

    let satisfies = true
    for (const [facet, predicate] of activeEntries) {
      const resolver = resolvers[facet]
      if (!resolver) continue // unknown facet — skip (federation forward-compat)
      if (!resolver(predicate, dataset)) {
        satisfies = false
        break
      }
    }
    if (satisfies) result.push(dataset)
  }
  return result
}

// ---------------------------------------------------------------------------
// State mutation — single mutation path for chip clicks, Graph
// node clicks (§6.7), Timeline brushes (§6.8), Map draws (§6.9).
// ---------------------------------------------------------------------------

/**
 * Return a NEW filter state with `value` toggled on a multi-
 * select `facet`. Behaviour depends on the facet's current
 * predicate kind:
 *
 *  - Facet absent → add as a `multi-select` with one value.
 *  - `multi-select` present, value missing → add the value.
 *  - `multi-select` present, value present → remove the value;
 *    if the result is empty, delete the facet entirely so the
 *    state stays minimal.
 *  - `boolean` present → delete the facet (treats `toggleFacet`
 *    on a boolean as "clear"; callers that want to toggle a
 *    boolean facet use {@link toggleBooleanFacet}).
 *
 * Range and bbox facets are not toggled by this helper — they
 * carry continuous state and are mutated directly by the
 * range-slider / brush / draw handler via {@link setFacet}.
 *
 * The earlier shape of this helper accepted `value === 'on'` or
 * `value === ''` as a signal to create a boolean predicate. That
 * was a footgun — a legitimate multi-select value of `'on'` (or
 * a stray empty-string keyword) would silently become a boolean
 * predicate that baseline resolvers then rejected. Boolean
 * facets now have a dedicated helper so value strings never
 * collide with control tokens.
 *
 * Pure — returns a new object; never mutates `state`.
 */
export function toggleFacet(state: FilterState, facet: string, value: string): FilterState {
  const current = state[facet]
  const next: Record<string, FacetPredicate | undefined> = { ...state }

  if (current == null) {
    next[facet] = { kind: 'multi-select', values: [value] }
  } else if (current.kind === 'multi-select') {
    const has = current.values.includes(value)
    const updated = has
      ? current.values.filter(v => v !== value)
      : [...current.values, value]
    if (updated.length === 0) {
      delete next[facet]
    } else {
      next[facet] = { kind: 'multi-select', values: updated }
    }
  } else if (current.kind === 'boolean') {
    delete next[facet]
  } else {
    // Range / bbox — toggleFacet is not the right mutation path;
    // callers use setFacet. Leave state unchanged so the helper
    // is safe to call indiscriminately from generic UI handlers.
  }
  return next
}

/**
 * Return a NEW filter state with the boolean facet at `facet`
 * toggled on (if absent) or off (if present). The dedicated
 * helper exists so callers don't have to encode boolean toggles
 * as magic value strings through {@link toggleFacet} — that's
 * how the older single-API shape produced the value-collision
 * footgun documented on `toggleFacet`.
 *
 * Pure — returns a new object.
 */
export function toggleBooleanFacet(state: FilterState, facet: string): FilterState {
  const next: Record<string, FacetPredicate | undefined> = { ...state }
  if (state[facet]?.kind === 'boolean') {
    delete next[facet]
  } else {
    next[facet] = { kind: 'boolean', value: true }
  }
  return next
}

/**
 * Set or replace a facet's predicate outright. Used by range
 * sliders (where the user drags continuous values) and by the
 * future Map view's bbox draw handler. Pass `undefined` to
 * clear the facet — equivalent to deleting the key.
 *
 * Pure — returns a new object.
 */
export function setFacet(
  state: FilterState,
  facet: string,
  predicate: FacetPredicate | undefined,
): FilterState {
  const next: Record<string, FacetPredicate | undefined> = { ...state }
  if (predicate == null) {
    delete next[facet]
  } else {
    next[facet] = predicate
  }
  return next
}

// ---------------------------------------------------------------------------
// Search prefix parsing (§6.2)
// ---------------------------------------------------------------------------

/**
 * Maps the English period vocabulary the user is likely to type
 * (`period:yearly`) onto the ISO 8601 duration values catalogued
 * datasets actually carry (`P1Y`). Matches the cadence labels
 * `inferDisplayInterval` recognises so the same vocabulary works
 * across the playback transport and the search box.
 *
 * Not a baseline chip-rail facet — `period:` is search-only per
 * the §6.2 wording. Surfaced as a separate function so callers
 * (e.g. an autocomplete suggester) can introspect the mapping.
 */
export const PERIOD_TOKEN_TO_ISO: Readonly<Record<string, string>> = {
  hourly: 'PT1H',
  daily: 'P1D',
  weekly: 'P7D',
  monthly: 'P1M',
  yearly: 'P1Y',
  annual: 'P1Y',
}

/** Search prefixes recognised by {@link parseSearchQuery}. */
const KNOWN_PREFIXES = new Set(['category', 'format', 'keyword', 'period'])

/**
 * Parse a search-box string into free-text and a {@link FilterState}
 * overlay of prefix predicates. Tokens of the form `key:value` are
 * extracted when `key` matches a known prefix; everything else
 * stays in `freeText`. Quoted values (`category:"snow and ice"`)
 * are honoured so multi-word values work — the unquoted token
 * parser otherwise splits on whitespace.
 *
 * Multiple tokens with the same prefix collect into a single
 * `multi-select` predicate (`category:water category:land` →
 * `{ category: { kind:'multi-select', values:['water','land'] } }`).
 *
 * Unknown prefixes fall through to free-text so a user typing
 * `temp:hot` searches literally — there's no failure mode where
 * a typo silently drops the query.
 */
export function parseSearchQuery(raw: string): { freeText: string; prefixes: FilterState } {
  const tokens = tokeniseSearch(raw)
  const collected: Record<string, string[]> = {}
  const period: string[] = []
  const freeTextParts: string[] = []

  for (const token of tokens) {
    const colon = token.indexOf(':')
    if (colon <= 0 || colon === token.length - 1) {
      freeTextParts.push(token)
      continue
    }
    const prefix = token.slice(0, colon).toLowerCase()
    const rawValue = token.slice(colon + 1)
    // Strip surrounding double quotes so `category:"snow and ice"`
    // → `snow and ice`. The tokeniser keeps the quotes intact so a
    // quoted run stays one token; the parser is responsible for the
    // unwrap here.
    const value = rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2
      ? rawValue.slice(1, -1)
      : rawValue
    if (!KNOWN_PREFIXES.has(prefix)) {
      freeTextParts.push(token)
      continue
    }
    if (prefix === 'period') {
      const iso = PERIOD_TOKEN_TO_ISO[value.toLowerCase()]
      if (iso) period.push(iso)
      else freeTextParts.push(token) // unrecognised vocab → free-text
      continue
    }
    if (!collected[prefix]) collected[prefix] = []
    collected[prefix].push(value)
  }

  const prefixes: Record<string, FacetPredicate> = {}
  for (const [facet, values] of Object.entries(collected)) {
    prefixes[facet] = { kind: 'multi-select', values }
  }
  if (period.length > 0) {
    // `period` isn't a baseline chip facet, but the parser still
    // emits a predicate keyed on `period` so the engine's generic
    // dispatch can apply it. Callers register a `period` resolver
    // alongside BASELINE_RESOLVERS when prefix search is wired
    // up; absent a resolver, the predicate is silently ignored
    // (forward-compat behaviour).
    prefixes.period = { kind: 'multi-select', values: period }
  }

  return { freeText: freeTextParts.join(' '), prefixes }
}

/**
 * Resolver for the search-only `period:` prefix. Lives next to
 * {@link PERIOD_TOKEN_TO_ISO} so the vocabulary and matcher stay
 * in lockstep. Callers register it on top of
 * {@link BASELINE_RESOLVERS} when wiring prefix search:
 *
 *   const resolvers = { ...BASELINE_RESOLVERS, period: PERIOD_RESOLVER }
 */
export const PERIOD_RESOLVER: FacetResolver = (predicate, dataset) => {
  if (predicate.kind !== 'multi-select') return false
  if (predicate.values.length === 0) return true
  return typeof dataset.period === 'string' && predicate.values.includes(dataset.period)
}

/**
 * Combine two filter states for the engine to consume. When the
 * same facet is keyed in both:
 *
 *  - Both `multi-select` → union the values. A chip selecting
 *    `category=Water` plus a prefix-search `category:Land`
 *    matches *either*, not just the overlay — otherwise the UI
 *    would show the chip as active while only the prefix's value
 *    filters, surprising the user.
 *  - Any other shape combination → overlay wins. Prefix search
 *    only emits `multi-select` predicates today, so the override
 *    path is the safe default for any future predicate kind we
 *    add without thinking through the merge semantics.
 *
 * Used to layer `parseSearchQuery` output on top of the chip
 * rail's `FilterState` before passing to `filterDatasets`. The
 * chip rail still renders from its own state alone (so a prefix
 * doesn't visually light up chips — §6.2's parallel-input model);
 * the union here only affects the effective filter.
 */
export function mergeFilterStates(base: FilterState, overlay: FilterState): FilterState {
  const result: Record<string, FacetPredicate | undefined> = { ...base }
  for (const [facet, predicate] of Object.entries(overlay)) {
    if (predicate == null) continue
    const existing = result[facet]
    if (
      existing != null &&
      existing.kind === 'multi-select' &&
      predicate.kind === 'multi-select'
    ) {
      const unioned = [...existing.values]
      for (const v of predicate.values) {
        if (!unioned.includes(v)) unioned.push(v)
      }
      result[facet] = { kind: 'multi-select', values: unioned }
    } else {
      result[facet] = predicate
    }
  }
  return result
}

/**
 * Split a search-box string into tokens. Whitespace-separated by
 * default, with double-quoted runs preserved as single tokens so
 * `category:"snow and ice"` survives intact. Empty tokens are
 * dropped.
 *
 * Local to this module — exposed via {@link parseSearchQuery}
 * rather than as a standalone export because the contract here
 * is "parse a search query"; callers shouldn't need the tokeniser
 * alone.
 */
function tokeniseSearch(raw: string): string[] {
  const out: string[] = []
  // Three patterns, tried in order:
  //   1. `key:"value with spaces"` — keep the quote-delimited value
  //      glued to its prefix so the parser sees one token.
  //   2. `"value"` — a bare quoted run becomes one token.
  //   3. `\S+` — anything else is whitespace-separated.
  // The quotes are preserved in the token; {@link parseSearchQuery}
  // unwraps them after splitting on the colon.
  const re = /\S+?:"[^"]*"|"[^"]*"|\S+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) != null) {
    if (match[0]) out.push(match[0])
  }
  return out
}
