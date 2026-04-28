/**
 * Shared `Env` type for catalog-backend Pages Functions.
 *
 * Bindings are declared in `wrangler.toml` and provisioned via the
 * Cloudflare Pages dashboard. Phase 1a uses two: D1 for the
 * catalog tables (CATALOG_DB) and KV for the hot-path snapshot
 * cache (CATALOG_KV). Later phases extend this surface with R2,
 * Stream, Queues, and Workers AI bindings — when they land, this
 * type grows additively.
 *
 * Every binding is optional in the type so Functions can degrade
 * gracefully when an operator forgot to wire one in the dashboard:
 * the catalog endpoint, for example, returns a 503 with a clear
 * "CATALOG_DB binding missing" body rather than crashing on a
 * type error against an undefined.
 */
export interface CatalogEnv {
  /** D1 database holding the catalog tables (Phase 1a +). */
  CATALOG_DB?: D1Database
  /** KV namespace caching the rendered catalog response. */
  CATALOG_KV?: KVNamespace
  /**
   * Override for the upstream Vimeo proxy used by the manifest
   * endpoint to resolve `vimeo:` `data_ref` values. Defaults to the
   * production proxy when unset; tests stub it via a mock fetch.
   * Phase 2 retires this field once Cloudflare Stream takes over
   * video hosting.
   */
  VIDEO_PROXY_BASE?: string
}
