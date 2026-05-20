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
 * Frame-source-filenames-ref shape produced by `clearTranscoding`:
 * `r2:uploads/{datasetId}/{uploadId}/source_filenames.json`. Phase
 * 3pg/A extracts the `{uploadId}` from this to build per-frame URL
 * templates without threading the upload_id through a separate
 * column — the source-filenames ref already locks in which upload's
 * frames are live, so it's the single source of truth for "which
 * frames live alongside this dataset row right now".
 */
const FRAME_SOURCE_FILENAMES_REF_PATTERN =
  /^r2:uploads\/([0-9A-HJKMNP-TV-Z]{26})\/([0-9A-HJKMNP-TV-Z]{26})\/source_filenames\.json$/

/**
 * Build the per-frame URL template that `WireDataset.frames.urlTemplate`
 * surfaces. The literal `{index}` token survives URL encoding so
 * consumers can substitute the zero-padded frame number directly:
 *
 *     const url = template.replace('{index}', String(i).padStart(5, '0'))
 *
 * Returns null when R2 public-base resolution falls through (same
 * shape `resolveR2HlsPublicUrl` uses — operator must bind
 * `R2_PUBLIC_BASE` or set `MOCK_R2=true` for the template to be
 * well-defined). Also returns null when the supplied
 * `frame_source_filenames_ref` doesn't match the canonical shape —
 * a row whose ref column got truncated or hand-edited can't be
 * mapped back to its frames, and silently returning null is safer
 * than emitting a template that points at a non-existent prefix.
 *
 * The `{index}` token is preserved by splitting the key at the
 * filename: the prefix portion is URL-encoded through `encodeR2Key`,
 * then `{index}.{ext}` is appended verbatim. `{` and `}` would
 * otherwise become `%7B` / `%7D` under `encodeURIComponent`,
 * forcing every consumer to URL-decode before substituting.
 */
export function buildFramesUrlTemplate(
  env: CatalogEnv,
  frameSourceFilenamesRef: string,
  frameExtension: string,
): string | null {
  const match = FRAME_SOURCE_FILENAMES_REF_PATTERN.exec(frameSourceFilenamesRef)
  if (!match) return null
  if (!/^[a-z0-9]+$/.test(frameExtension)) return null
  const [, datasetId, uploadId] = match
  // Resolve a sentinel prefix to leverage the existing public-base
  // selection logic; then swap the sentinel for the `{index}` token
  // so the surviving URL carries it literally. The sentinel
  // (`__FRAMES_INDEX_TOKEN__`) is reserved per project convention —
  // matches `[A-Z_]+` so a future migration can grep-and-rename if
  // the token shape ever changes.
  const sentinelKey = `uploads/${datasetId}/${uploadId}/frames/__FRAMES_INDEX_TOKEN__.${frameExtension}`
  const resolved = resolveR2HlsPublicUrl(env, sentinelKey)
  if (!resolved) return null
  return resolved.replace('__FRAMES_INDEX_TOKEN__', '{index}')
}
