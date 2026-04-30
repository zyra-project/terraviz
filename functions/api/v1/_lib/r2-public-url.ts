/**
 * Build a publicly-readable URL for an R2 object key.
 *
 * Centralised here so the manifest endpoint, the docent's featured-
 * list helper, and any future consumer all agree on resolution
 * order. Tries:
 *
 *   1. `R2_PUBLIC_BASE` — operator-configured custom-domain origin
 *      (e.g. `https://assets.terraviz.example.com`).
 *   2. `MOCK_R2=true` — local-dev stub host the test suite asserts
 *      against. Bucket name is included in the path so a
 *      `mock-r2.localhost/<bucket>/<key>` round-trip is uniform
 *      across paths.
 *   3. `R2_S3_ENDPOINT` — direct path-style S3 URL; only resolves
 *      to readable bytes when the bucket has public access enabled.
 *
 * Returns null when none of those apply. Callers surface that as a
 * 503 (manifest) or as a `null` thumbnail (featured / search) —
 * the right answer depends on whether the asset is the request's
 * critical path or just a nice-to-have.
 *
 * Restricted-bucket presigned-GET semantics are a Phase 4
 * federation concern.
 */

import type { CatalogEnv } from './env'

/**
 * Encode an R2 key for inclusion in a URL path. Slashes are
 * preserved (they're path separators in R2 keys); everything else
 * goes through `encodeURIComponent`.
 *
 * Exported because the manifest endpoint also slots R2 keys into a
 * Cloudflare Images URL transformation path that doesn't go
 * through `resolveR2PublicUrl`.
 */
export function encodeR2Key(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/** Resolve an `r2:<key>` reference to a publicly-readable URL, or null. */
export function resolveR2PublicUrl(env: CatalogEnv, key: string): string | null {
  const bucket = env.CATALOG_R2_BUCKET?.trim() || 'terraviz-assets'
  const path = encodeR2Key(key)

  const publicBase = env.R2_PUBLIC_BASE?.trim()
  if (publicBase) {
    return `${publicBase.replace(/\/$/, '')}/${path}`
  }

  if (env.MOCK_R2 === 'true') {
    return `https://mock-r2.localhost/${bucket}/${path}`
  }

  const endpoint = env.R2_S3_ENDPOINT?.trim()
  if (endpoint) {
    return `${endpoint.replace(/\/$/, '')}/${bucket}/${path}`
  }

  return null
}

/**
 * Resolve an arbitrary `*_ref` value to a publicly-readable URL.
 * Strips the scheme and dispatches:
 *   - `r2:<key>`  → `resolveR2PublicUrl`
 *   - everything else → returned as-is (already a URL, or unsupported)
 *
 * Used for the dataset thumbnail / sphere-thumbnail surfaces where
 * the row's `*_ref` column may be either an `r2:` handle or a
 * legacy direct URL (`https://...`). Returns null only when an
 * `r2:` ref can't be resolved.
 */
export function resolveAssetRef(env: CatalogEnv, ref: string | null | undefined): string | null {
  if (!ref) return null
  if (ref.startsWith('r2:')) {
    return resolveR2PublicUrl(env, ref.slice('r2:'.length))
  }
  // Bare URLs (https://, http://) and unknown schemes pass through.
  return ref
}
