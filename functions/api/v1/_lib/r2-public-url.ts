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
import { buildContentAddressedFrameKey } from './r2-store'

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
 * Like `resolveR2PublicUrl` but without the `R2_S3_ENDPOINT`
 * fallback — only `R2_PUBLIC_BASE` (production) or `MOCK_R2`
 * (local dev) produce a URL.
 *
 * Use this for HLS master playlists: in a typical production
 * deployment `R2_S3_ENDPOINT` is set so the CLI can sign PUTs
 * against the bucket, but the bucket itself is NOT publicly
 * readable through that endpoint — a custom domain bound via
 * R2 → bucket → Settings → Connect Domain (surfaced as
 * `R2_PUBLIC_BASE`) is the public-read origin.
 *
 * If we fell through to `R2_S3_ENDPOINT` here, the manifest
 * endpoint would happily return an `hls:` URL that resolves
 * to a 403 at play time on every typical production setup.
 * Better to surface the misconfiguration up front as
 * `r2_unconfigured` (matching the runbook + `expected-bindings`
 * hint) so the operator binds the custom domain before traffic
 * hits the migrated rows.
 */
export function resolveR2HlsPublicUrl(env: CatalogEnv, key: string): string | null {
  const bucket = env.CATALOG_R2_BUCKET?.trim() || 'terraviz-assets'
  const path = encodeR2Key(key)

  const publicBase = env.R2_PUBLIC_BASE?.trim()
  if (publicBase) {
    return `${publicBase.replace(/\/$/, '')}/${path}`
  }

  if (env.MOCK_R2 === 'true') {
    return `https://mock-r2.localhost/${bucket}/${path}`
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

/**
 * Strict variant of `resolveAssetRef` for surfaces where the SPA
 * actually fetches the URL — dataset thumbnails / legends /
 * captions / color tables surfaced by `serializeDataset`.
 *
 * Differs from `resolveAssetRef` in one place: when the ref is
 * `r2:<key>` it uses `resolveR2HlsPublicUrl` (which omits the
 * `R2_S3_ENDPOINT` fallback) instead of `resolveR2PublicUrl`.
 * The S3 endpoint is for signed PUTs in a typical production
 * setup — the bucket usually isn't publicly readable through it.
 * Falling through to it would yield a thumbnail / legend /
 * caption URL that 403s in the browser. Better to surface the
 * misconfiguration as a missing-field omission so the operator
 * knows R2_PUBLIC_BASE needs to be bound.
 *
 * Bare URLs pass through unchanged, same as `resolveAssetRef` —
 * pre-Phase-3b rows on NOAA CloudFront keep working.
 */
export function resolveAssetRefStrict(
  env: CatalogEnv,
  ref: string | null | undefined,
): string | null {
  if (!ref) return null
  if (ref.startsWith('r2:')) {
    return resolveR2HlsPublicUrl(env, ref.slice('r2:'.length))
  }
  return ref
}

/**
 * Resolve a ref to a **fetchable HTTP(S) URL**, or null.
 *
 * `resolveAssetRefStrict` passes non-`r2:` refs through verbatim, so
 * a `vimeo:123` (or any non-HTTP scheme) would come back unchanged.
 * The publisher portal feeds these values straight into `fetch()` and
 * `<img src>` (data-frame fetch, thumbnail/legend previews), so only
 * `http(s)` URLs are usable — anything else must surface as null so
 * the UI hides the one-click generator / image preview rather than
 * fetching an invalid URL or injecting an unsupported scheme into the
 * DOM. PR #208 Copilot review.
 */
export function resolveHttpAssetUrl(
  env: CatalogEnv,
  ref: string | null | undefined,
): string | null {
  const resolved = resolveAssetRefStrict(env, ref)
  return resolved && /^https?:\/\//i.test(resolved) ? resolved : null
}

/**
 * Has the operator bound an R2 public-read origin?
 *
 * Returns true when either `R2_PUBLIC_BASE` is set (production
 * custom domain) or `MOCK_R2=true` is set (local dev). The
 * `R2_S3_ENDPOINT` fallback that `resolveR2PublicUrl` honours
 * isn't counted — assets surfaced through the strict variants
 * (image / HLS / frames) won't resolve to readable bytes through
 * the S3 endpoint on a typical non-public-bucket production
 * setup, so it doesn't satisfy "configured" for those surfaces.
 *
 * Phase 3pg-review/B — Copilot discussion_r3277221658 /
 * discussion_r3277221688. Lets handlers distinguish "deployment
 * misconfig" (return `r2_unconfigured`) from "row data is bad"
 * (return `invalid_frame_metadata`) when `buildFramesUrlTemplate`
 * returns null.
 */
export function isR2PublicConfigured(env: CatalogEnv): boolean {
  return !!(env.R2_PUBLIC_BASE?.trim() || env.MOCK_R2 === 'true')
}

/**
 * Resolve a single frame's content-addressed public URL:
 * `{R2_PUBLIC_BASE}/videos/{datasetId}/frames/sha256/{hex}.{ext}`
 * (`docs/INCREMENTAL_FRAME_UPLOAD_PLAN.md`). The `digest` is the
 * frame's `sha256:<hex>` from the `source_filenames.json` manifest;
 * the `/frames` list and `/frames/{index}` recall endpoints resolve
 * each frame's direct URL through here.
 *
 * Returns null when R2 public-base resolution falls through (operator
 * must bind `R2_PUBLIC_BASE` or set `MOCK_R2=true`), or when the
 * digest/extension is malformed. The helper is non-throwing so the
 * caller decides how to classify the failure: the `/frames` and
 * `/frames/{index}` endpoints pre-check `isR2PublicConfigured` (→ 503
 * for the unconfigured case) and treat a remaining null as malformed
 * row metadata (→ 500 `invalid_frame_metadata`). Returning null rather
 * than throwing keeps one bad manifest entry from blowing up the whole
 * request with an unhandled exception.
 */
export function buildFrameRecallUrl(
  env: CatalogEnv,
  datasetId: string,
  digest: string,
  frameExtension: string,
): string | null {
  let key: string
  try {
    key = buildContentAddressedFrameKey(datasetId, digest, frameExtension)
  } catch {
    return null
  }
  return resolveR2HlsPublicUrl(env, key)
}

/**
 * Build the dataset-level `WireDataset.frames.urlTemplate` — an
 * absolute URL with a literal `{index}` token that consumers
 * substitute the zero-padded frame number into:
 *
 *     const url = template.replace('{index}', String(i).padStart(5, '0'))
 *
 * Content-addressed frames can't be expressed as one direct-R2
 * `{index}` template (each index maps to an arbitrary hash), so the
 * template points at the `/frames/{index}` **redirect** endpoint —
 * the stable indirection the API already exposes ("the redirect target
 * adapts" to bucket-layout changes). Following the resulting URL 302s
 * to the content-addressed object. The `/frames` *list* endpoint still
 * emits direct content-addressed URLs (it has the manifest), so bulk
 * download skips the hop.
 *
 * Returns null when R2 public-base resolution isn't configured — same
 * fail-quiet gate as before, so a deployment without an R2 public
 * origin simply doesn't advertise a frame surface.
 */
export function buildFramesRedirectTemplate(
  env: CatalogEnv,
  baseUrl: string,
  datasetId: string,
): string | null {
  if (!isR2PublicConfigured(env)) return null
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(datasetId)) return null
  const base = baseUrl.replace(/\/$/, '')
  return `${base}/api/v1/datasets/${datasetId}/frames/{index}`
}
