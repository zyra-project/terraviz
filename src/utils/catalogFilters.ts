/**
 * URL round-trip for catalog filter state.
 *
 * Phase 4 §6.3 of `docs/WEB_CATALOG_FEATURES_PLAN.md`. The chip
 * rail and search box write their state to the URL via
 * `history.replaceState` (not pushState — chip clicks shouldn't
 * clog history). The compact form from the plan is the
 * human-readable contract:
 *
 *     ?catalog=true&q=ocean&cat=atmosphere,land&fmt=video
 *
 * On the wire `URLSearchParams.toString()` percent-encodes the
 * commas (and spaces in `q=`) so the address bar actually shows
 *
 *     ?catalog=true&q=ocean&cat=atmosphere%2Cland&fmt=video
 *
 * The two forms are equivalent — `URLSearchParams` decodes
 * `%2C` back to `,` on read, and a hand-typed comma URL round-
 * trips through {@link decodeFilterState} the same as the
 * percent-encoded form. Tests in this module assert the
 * on-wire shape; the doc above reads the human form because
 * that's the contract the plan documents.
 *
 * Encode/decode are pure functions and live alongside the
 * predicate engine that they serve. The side-effecting
 * `applyFilterStateToUrl` / `readFilterStateFromUrl` helpers
 * touch `window.history` / `window.location` and are tested
 * against the happy-dom environment vitest already runs in.
 */

import type { FacetPredicate, FilterState } from '../services/datasetFilter'

// ---------------------------------------------------------------------------
// Encoded URL surface
// ---------------------------------------------------------------------------

/**
 * Free-text search query key. Separate from the facet predicates
 * because the search query is a different shape (multi-field
 * substring) and the §6.3 example reserves the short `q=` key
 * for it.
 */
export const SEARCH_QUERY_PARAM = 'q'

/**
 * Two-way map between facet names ({@link FilterState} keys) and
 * the compact URL params they encode to. Kept as a single source
 * of truth so {@link encodeFilterState} and
 * {@link decodeFilterState} can't drift.
 *
 * Adding a new facet means appending one entry here AND
 * registering a resolver in `datasetFilter.ts`. The URL form
 * stays terse (max ~4 chars) so a shared link with several
 * facets active is still readable.
 */
export const FACET_URL_KEYS: Readonly<Record<string, string>> = {
  category: 'cat',
  keyword: 'kw',
  format: 'fmt',
  dateAdded: 'da',
  dataCoverageYear: 'dcy',
  hasCaptions: 'cc',
  hasTour: 'tour',
  includeSos: 'sos',
  geographicRegion: 'gr',
}

/** Reverse lookup. Built once at module load. */
const URL_KEY_TO_FACET: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FACET_URL_KEYS).map(([facet, urlKey]) => [urlKey, facet]),
)

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Encode a {@link FilterState} + free-text search query to
 * `URLSearchParams`. The result is the compact form ready to
 * stitch onto the catalog URL — callers concat with any other
 * params (e.g. `catalog=true`) before applying.
 *
 * Encoding rules per facet kind:
 *  - `multi-select` → comma-separated values (`cat=Water,Land`).
 *    Empty values arrays are omitted entirely.
 *  - `boolean` → the literal `1` (`cc=1`); the param key's
 *    presence is the signal. Boolean facets that are off don't
 *    get a param.
 *  - `range` → `min-max` (`da=2018-2024`). Half-open ranges
 *    encode as `2018-` or `-2024`. Both bounds absent → no param.
 *  - `bbox` → `n,s,e,w` (`gr=40,10,30,-10`) — §6.9 Map view's
 *    geographicRegion predicate. Bounds round to 3 decimals
 *    (~111 m at the equator) for compact shared links.
 *
 * Unknown facet keys (e.g. peer facets a future client knows
 * about but this one doesn't) are dropped on encode. Decode is
 * the symmetric side — unknown URL keys are dropped there too.
 */
export function encodeFilterState(
  state: FilterState,
  searchQuery: string,
): URLSearchParams {
  const params = new URLSearchParams()
  const trimmedQuery = searchQuery.trim()
  if (trimmedQuery) {
    params.set(SEARCH_QUERY_PARAM, trimmedQuery)
  }
  for (const [facet, predicate] of Object.entries(state)) {
    if (predicate == null) continue
    const urlKey = FACET_URL_KEYS[facet]
    if (!urlKey) continue
    const encoded = encodePredicate(predicate)
    if (encoded != null) params.set(urlKey, encoded)
  }
  return params
}

/** Encode a single predicate to its URL value, or null if it
 *  contributes no information (empty multi-select, half-open
 *  range with no bounds set). */
function encodePredicate(predicate: FacetPredicate): string | null {
  switch (predicate.kind) {
    case 'multi-select': {
      if (predicate.values.length === 0) return null
      return predicate.values.join(',')
    }
    case 'boolean':
      return '1'
    case 'range': {
      const min = predicate.min != null ? String(predicate.min) : ''
      const max = predicate.max != null ? String(predicate.max) : ''
      if (!min && !max) return null
      return `${min}-${max}`
    }
    case 'bbox':
      // §6.9 Map view — `geographicRegion` round-trips as
      // `gr=n,s,e,w`. Bounds round to 3 decimals (~111 m at the
      // equator) — same precision `camera.ts` uses for lat/lon —
      // so shared links don't leak high-precision drag positions
      // and the URL stays compact for chip-rail shares.
      return [predicate.n, predicate.s, predicate.e, predicate.w]
        .map(v => String(Math.round(v * 1000) / 1000))
        .join(',')
  }
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Decode `URLSearchParams` into a {@link FilterState} + free-text
 * search query. The inverse of {@link encodeFilterState}.
 *
 * Forgiving by design:
 *  - Unknown URL keys are silently ignored (other params can
 *    coexist on the URL — `catalog=true`, `dataset=...`, etc.).
 *  - Malformed values fall through without throwing (a corrupted
 *    `da=foo-bar` produces no predicate rather than crashing the
 *    page). The shared-link UX should never wedge on a typo.
 */
export function decodeFilterState(
  params: URLSearchParams,
): { state: FilterState; searchQuery: string } {
  const state: Record<string, FacetPredicate> = {}
  for (const [urlKey, value] of params.entries()) {
    const facet = URL_KEY_TO_FACET[urlKey]
    if (!facet) continue
    const predicate = decodePredicate(facet, value)
    if (predicate) state[facet] = predicate
  }
  const searchQuery = params.get(SEARCH_QUERY_PARAM) ?? ''
  return { state, searchQuery }
}

/**
 * Decode a single URL value into a predicate. The predicate kind
 * is inferred from the facet's expected shape — which is itself
 * declared by which resolver in `datasetFilter.ts` handles the
 * key. This module knows the baseline §6.1 shapes; future
 * facets register their decoder here when they ship.
 */
function decodePredicate(facet: string, raw: string): FacetPredicate | null {
  // Range facets — `min-max`, `min-`, or `-max`. The dash is the
  // separator, never a minus sign (we don't currently encode
  // negative years; the regex would need to grow to support
  // bbox-style negative numbers if BCE coverage ever ships).
  if (facet === 'dateAdded' || facet === 'dataCoverageYear') {
    const match = raw.match(/^(\d*)-(\d*)$/)
    if (!match) return null
    const min = match[1] ? Number(match[1]) : undefined
    const max = match[2] ? Number(match[2]) : undefined
    if (min == null && max == null) return null
    if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max))) return null
    return { kind: 'range', min, max }
  }
  // Boolean facets — strict allow-list of `1` (canonical) and
  // `true` (defensive, for hand-typed URLs). Anything else
  // (including `0`, `false`, `on`, `yes`) is dropped so a typo
  // can't silently enable the toggle.
  if (facet === 'hasCaptions' || facet === 'hasTour' || facet === 'includeSos') {
    if (raw === '1' || raw.toLowerCase() === 'true') {
      return { kind: 'boolean', value: true }
    }
    return null
  }
  // Geographic region — `gr=n,s,e,w`. Four signed decimals,
  // comma-separated, in the canonical NSEW order (matches the
  // FacetPredicate's bbox shape). Malformed entries (wrong arity,
  // empty segments, non-finite numbers) decode to null so a
  // hand-edited URL never wedges the page — explicitly reject
  // empty segments (`gr=10,,30,40`) because `Number('')` is `0`,
  // which would silently coerce the omission to a value.
  if (facet === 'geographicRegion') {
    const parts = raw.split(',').map(p => p.trim())
    if (parts.length !== 4) return null
    if (parts.some(p => p.length === 0)) return null
    const [n, s, e, w] = parts.map(p => Number(p))
    if (!Number.isFinite(n) || !Number.isFinite(s)) return null
    if (!Number.isFinite(e) || !Number.isFinite(w)) return null
    return { kind: 'bbox', n, s, e, w }
  }
  // Multi-select facets — comma-separated. Empty segments
  // (`cat=,Water`) are dropped so a trailing comma doesn't create
  // a phantom empty-string value.
  const values = raw.split(',').map(v => v.trim()).filter(v => v.length > 0)
  if (values.length === 0) return null
  return { kind: 'multi-select', values }
}

// ---------------------------------------------------------------------------
// Side-effecting helpers (history.replaceState + location)
// ---------------------------------------------------------------------------

/**
 * Update the current URL to reflect `state` and `searchQuery`,
 * preserving every other query param already present
 * (`catalog=true`, `dataset=...`, etc.). Uses `history.replaceState`
 * per §6.3 so chip clicks don't clog the back button — the user
 * presses Back to leave the catalog, not to step through filter
 * permutations.
 *
 * Idempotent — calling with the same state twice produces no
 * additional history entry. SSR-safe — no-ops when `window` is
 * undefined.
 *
 * The default `replace: true` matches the §6.3 directive. Passing
 * `replace: false` is reserved for callers that want a real
 * history entry (e.g. entering catalog mode from the globe-first
 * default — that *should* be back-navigable).
 */
export function applyFilterStateToUrl(
  state: FilterState,
  searchQuery: string,
  options: { replace?: boolean } = {},
): void {
  if (typeof window === 'undefined') return
  const { replace = true } = options

  const url = new URL(window.location.href)
  // Strip every facet/search key we own, then re-add the encoded
  // ones. This lets the URL drop a param cleanly when a facet
  // toggles off — without the explicit strip, decoded state would
  // leave stale params behind.
  url.searchParams.delete(SEARCH_QUERY_PARAM)
  for (const urlKey of Object.values(FACET_URL_KEYS)) {
    url.searchParams.delete(urlKey)
  }
  const encoded = encodeFilterState(state, searchQuery)
  for (const [key, value] of encoded.entries()) {
    url.searchParams.set(key, value)
  }
  const next = url.pathname + (url.search ? url.search : '') + url.hash
  // Compare against current to avoid emitting a redundant history
  // entry — important on browsers that count replaceState toward
  // a "navigated" signal even when the URL is identical.
  const current = window.location.pathname + window.location.search + window.location.hash
  if (next === current) return
  if (replace) {
    window.history.replaceState(window.history.state, '', next)
  } else {
    window.history.pushState(window.history.state, '', next)
  }
}

/**
 * Read the catalog filter state from the current URL. The
 * inverse of {@link applyFilterStateToUrl}. SSR-safe — returns
 * an empty state when `window` is undefined.
 */
export function readFilterStateFromUrl(): { state: FilterState; searchQuery: string } {
  if (typeof window === 'undefined') {
    return { state: {}, searchQuery: '' }
  }
  return decodeFilterState(new URLSearchParams(window.location.search))
}
