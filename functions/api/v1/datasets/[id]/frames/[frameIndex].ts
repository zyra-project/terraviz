/**
 * Cloudflare Pages Function — `/api/v1/datasets/{id}/frames/{frameIndex}`
 *
 * Phase 3pg/B — single-frame addressing. Two methods:
 *
 *   - `GET`: 302 to the per-frame R2 URL. Stable consumer-facing
 *     URL even if the bucket layout changes later — clients book-
 *     mark or share this and the redirect target adapts.
 *   - `HEAD`: returns the same headers GET would set, minus the
 *     redirect Location, for tooling that wants a cheap exists-
 *     check. The frame's SHA-256 from the manifest blob is surfaced
 *     as `Content-Digest: sha-256=:<base64>:` per RFC 9530.
 *
 * Visibility honors the same public-only filter as the list
 * endpoint (`/frames`); restricted-row presigning is a follow-up.
 *
 * The `frameIndex` route segment is the literal zero-based frame
 * number — `0`, `47`, etc. Padded forms (`00047`) are accepted but
 * normalised before the lookup so consumers don't have to remember
 * the padding width.
 */

import type { CatalogEnv } from '../../../_lib/env'
import { getPublicDataset } from '../../../_lib/catalog-store'
import { buildFramesUrlTemplate, isR2PublicConfigured } from '../../../_lib/r2-public-url'
import { loadFrameManifest } from '../../../_lib/frames-manifest'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const REDIRECT_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

interface FrameLookupResult {
  url: string
  digest: string
  ext: string
}

async function resolveFrame(
  env: CatalogEnv,
  id: string,
  frameIndexRaw: string,
): Promise<FrameLookupResult | Response> {
  if (!env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured.')
  }
  if (!env.CATALOG_R2) {
    return jsonError(503, 'binding_missing', 'CATALOG_R2 binding is not configured.')
  }
  // Accept canonical base-10 indexes only: `47`, `00047`. The
  // route contract says "non-negative integer", and a bare digit
  // regex enforces that strictly — `Number(...)` would silently
  // accept `3e2`, `0x10`, `3.0`, `1_000`, leading `+`, etc., any
  // of which lands at a key that doesn't exist in R2 and 404s
  // with a confusing message. Phase 3pg-review/B — Copilot
  // discussion_r3277221610.
  if (!/^\d+$/.test(frameIndexRaw)) {
    return jsonError(
      400,
      'invalid_frame_index',
      'frameIndex must be a non-negative base-10 integer.',
    )
  }
  const idx = parseInt(frameIndexRaw, 10)
  const row = await getPublicDataset(env.CATALOG_DB, id)
  if (!row) return jsonError(404, 'not_found', `Dataset ${id} not found.`)
  if (
    row.frame_count == null ||
    row.frame_extension == null ||
    row.frame_source_filenames_ref == null
  ) {
    return jsonError(
      404,
      'not_a_frame_sequence',
      `Dataset ${id} has no image-sequence frames.`,
    )
  }
  if (idx >= row.frame_count) {
    return jsonError(
      404,
      'frame_index_out_of_range',
      `Dataset ${id} has frames 0..${row.frame_count - 1}; got ${idx}.`,
    )
  }
  // Pre-check the env so the post-fact `null` from
  // `buildFramesUrlTemplate` surfaces as the right error code
  // (row data vs deployment misconfig). Phase 3pg-review/B —
  // Copilot discussion_r3277221688.
  if (!isR2PublicConfigured(env)) {
    return jsonError(
      503,
      'r2_unconfigured',
      'R2_PUBLIC_BASE / MOCK_R2 must be configured for the frame surface.',
    )
  }
  const template = buildFramesUrlTemplate(
    env,
    row.frame_source_filenames_ref,
    row.frame_extension,
  )
  if (!template) {
    return jsonError(
      500,
      'invalid_frame_metadata',
      `Dataset ${id}'s frame_source_filenames_ref or frame_extension is malformed; ` +
        'frame URLs cannot be built. An operator should inspect the row.',
    )
  }
  const manifestKey = row.frame_source_filenames_ref.startsWith('r2:')
    ? row.frame_source_filenames_ref.slice('r2:'.length)
    : row.frame_source_filenames_ref
  const manifest = await loadFrameManifest(env.CATALOG_R2, manifestKey)
  if (!manifest) {
    return jsonError(
      503,
      'frame_manifest_missing',
      `Frame manifest blob at ${manifestKey} could not be read.`,
    )
  }
  if (manifest.length !== row.frame_count) {
    return jsonError(
      503,
      'frame_manifest_inconsistent',
      `Frame manifest length ${manifest.length} does not match dataset frame_count ${row.frame_count}.`,
    )
  }
  const padded = String(idx).padStart(5, '0')
  return {
    url: template.replace('{index}', padded),
    digest: manifest[idx].digest,
    ext: row.frame_extension,
  }
}

/** Encode the manifest's `sha256:<hex>` digest as a structured
 *  `Content-Digest` header value per RFC 9530:
 *  `sha-256=:<base64>:`. The colon-delimited base64 is structured-
 *  fields byte-string syntax; this is the format conformant
 *  HTTP-cache implementations expect. */
function buildContentDigestHeader(shaHex: string): string {
  const hex = shaHex.replace(/^sha256:/, '')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `sha-256=:${btoa(bin)}:`
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id' | 'frameIndex'> = async context => {
  const idParam = context.params.id
  const idxParam = context.params.frameIndex
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  const frameIndex = Array.isArray(idxParam) ? idxParam[0] : idxParam
  if (!id || !frameIndex) {
    return jsonError(400, 'invalid_request', 'Missing dataset id or frameIndex.')
  }
  const result = await resolveFrame(context.env, id, frameIndex)
  if (result instanceof Response) return result
  return new Response(null, {
    status: 302,
    headers: {
      Location: result.url,
      'Content-Digest': buildContentDigestHeader(result.digest),
      'Cache-Control': REDIRECT_CACHE_CONTROL,
    },
  })
}

export const onRequestHead: PagesFunction<CatalogEnv, 'id' | 'frameIndex'> = async context => {
  const idParam = context.params.id
  const idxParam = context.params.frameIndex
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  const frameIndex = Array.isArray(idxParam) ? idxParam[0] : idxParam
  if (!id || !frameIndex) {
    return new Response(null, { status: 400 })
  }
  const result = await resolveFrame(context.env, id, frameIndex)
  if (result instanceof Response) {
    // For HEAD, strip the body but preserve status + headers.
    return new Response(null, { status: result.status, headers: result.headers })
  }
  return new Response(null, {
    status: 200,
    headers: {
      'Content-Digest': buildContentDigestHeader(result.digest),
      'Content-Type': mimeForExt(result.ext),
      // No Content-Length — that would require fetching R2 metadata
      // per HEAD, which costs a subrequest. The digest header is
      // sufficient for "is this the version I cached?" tooling.
      'Cache-Control': REDIRECT_CACHE_CONTROL,
      'X-Frame-Url': result.url,
    },
  })
}
