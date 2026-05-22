/**
 * Catalog mode — `?catalog=true` URL routing.
 *
 * Catalog mode inverts TerraViz's default surface: the dataset
 * browser becomes the primary viewport and the globe stays hidden
 * until the visitor selects a dataset. The mode is opt-in — the
 * SOS website (and other catalog-first integrations) links to
 * `?catalog=true`; bare `/` continues to land on globe-first.
 *
 * See `docs/WEB_CATALOG_FEATURES_PLAN.md` §3 for the full design,
 * including the catalog↔sphere tab control (§3.2) that lives on
 * top of this routing primitive.
 */

/**
 * Read the catalog-mode flag from the current URL. True when the
 * URL carries `?catalog=true` (case-insensitive); false otherwise.
 * The values `false` and `0` are treated as explicit opt-outs so a
 * tab control that flips the flag round-trips cleanly.
 */
export function getCatalogMode(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('catalog')
  if (raw === null) return false
  const lowered = raw.toLowerCase()
  return lowered !== 'false' && lowered !== '0'
}

/**
 * Update the URL's `catalog` flag without triggering a navigation.
 * Uses `pushState` so the back button returns the visitor to the
 * previous catalog state — matters when the catalog↔sphere tab
 * control (§3.2) lands on top of this.
 */
export function setCatalogMode(on: boolean): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (on) {
    url.searchParams.set('catalog', 'true')
  } else {
    url.searchParams.delete('catalog')
  }
  window.history.pushState({}, '', url.toString())
}
