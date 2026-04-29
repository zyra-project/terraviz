/**
 * Cloudflare Pages Function — GET /api/v1/datasets/{id}/manifest
 *
 * Resolves a dataset's `data_ref` to a concrete playback manifest.
 * The catalog row stores a *reference* (`vimeo:123`, `url:https://...`,
 * eventually `stream:abc`, `r2:key`, `peer:node/dataset`); this
 * endpoint resolves the reference to whatever shape the frontend
 * needs to actually play the asset.
 *
 * Phase 1a scope:
 *   - `vimeo:<id>` for video formats — proxied through the existing
 *     `video-proxy.zyra-project.org` so cutover to a node-served
 *     manifest is a one-line frontend change with no asset re-encoding.
 *   - `url:<href>` for video formats — synthesized single-file
 *     manifest pointing at the external URL (legacy NOAA imagery,
 *     occasional MP4 hosted alongside SOS).
 *   - `url:<href>` for image formats — synthesized progressive-
 *     resolution variants matching the existing `_4096`/`_2048`/
 *     `_1024` ladder the frontend already probes.
 *   - Unknown schemes (`stream:`, `r2:`, `peer:`) and mismatched
 *     scheme/format pairs return 400 with a typed error envelope.
 *
 * Wire shape:
 *   - Video: matches the existing `VideoProxyResponse` shape
 *     (`{ id, title, duration, hls, files }`) so `hlsService.ts`
 *     consumes it unchanged once Commit H lands.
 *   - Image: `{ kind: "image", variants: [{ width, url }], fallback }`
 *     per `CATALOG_BACKEND_PLAN.md` "Image datasets (R2 + Cloudflare
 *     Images)". Phase 2 enriches this with real Cloudflare Images
 *     variant URLs; Phase 1a fakes it with the suffix-mangled ladder
 *     to keep the frontend identical.
 *
 * Caching: ETag-driven 304 + a 5-minute edge cache. The Vimeo proxy
 * signs MP4 URLs with a ~1-hour TTL, so a few-minute edge cache is
 * generous-enough headroom without serving expired URLs.
 */

import { CatalogEnv } from '../../_lib/env'
import { getNodeIdentity, getPublicDataset } from '../../_lib/catalog-store'
import { isConfigurationError } from '../../_lib/errors'
import { streamPlaybackUrl } from '../../_lib/stream-store'
import { computeEtag } from '../../_lib/snapshot'

const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600'
const CONTENT_TYPE = 'application/json; charset=utf-8'
const DEFAULT_VIDEO_PROXY_BASE = 'https://video-proxy.zyra-project.org/video'

interface VideoProxyFile {
  quality: string
  width?: number
  height?: number
  size: number
  type: string
  link: string
}

interface VideoManifest {
  kind: 'video'
  id: string
  title: string
  duration: number
  hls: string
  files: VideoProxyFile[]
}

interface ImageManifest {
  kind: 'image'
  variants: Array<{ width: number; url: string }>
  fallback: string
}

type Manifest = VideoManifest | ImageManifest

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

/**
 * Split `vimeo:123` / `url:https://...` into `{ scheme, value }`.
 * Returns null on a malformed `data_ref` so the caller can produce
 * a typed 500 rather than blowing up the JSON body.
 */
export function parseDataRef(ref: string): { scheme: string; value: string } | null {
  const idx = ref.indexOf(':')
  if (idx < 1) return null
  return { scheme: ref.slice(0, idx), value: ref.slice(idx + 1) }
}

/**
 * Build the progressive-resolution variant ladder for an image
 * dataset by mangling the canonical URL the same way the frontend's
 * `loadImageFromNetwork` does today: `_4096`/`_2048`/`_1024` suffix
 * before the file extension. Mirrors the existing client behaviour
 * exactly so Phase 1a is transparent; Phase 2 replaces this with
 * actual Cloudflare Images variant URLs at upload time.
 */
export function imageVariants(href: string): ImageManifest {
  const extMatch = href.match(/(\.\w+)$/)
  const ext = extMatch ? extMatch[1] : ''
  const base = ext ? href.slice(0, -ext.length) : href
  const variants = [4096, 2048, 1024].map(width => ({
    width,
    url: `${base}_${width}${ext}`,
  }))
  return { kind: 'image', variants, fallback: href }
}

/**
 * Resolve a `vimeo:<id>` to a `VideoManifest` by calling the
 * upstream proxy. The proxy returns the existing
 * `{ id, title, duration, hls, dash, files }` shape; we drop `dash`
 * (the frontend never used it) and stamp `kind: "video"` so the
 * union discriminator is in place for forward compatibility.
 *
 * On upstream failure we return null and the caller surfaces a 502
 * — this path is one of the few in the catalog backend that has a
 * hard external dependency, so a clear error envelope is worth more
 * than a half-rendered manifest.
 */
async function fetchVimeoManifest(
  vimeoId: string,
  proxyBase: string,
  fetchImpl: typeof fetch,
): Promise<VideoManifest | null> {
  const upstream = await fetchImpl(`${proxyBase}/${vimeoId}`)
  if (!upstream.ok) return null
  const data = (await upstream.json()) as {
    id: string
    title?: string
    duration?: number
    hls: string
    files?: VideoProxyFile[]
  }
  return {
    kind: 'video',
    id: data.id,
    title: data.title ?? '',
    duration: data.duration ?? 0,
    hls: data.hls,
    files: data.files ?? [],
  }
}

/**
 * Wrap a single `url:<href>` video reference (e.g., a direct MP4)
 * in a video-shaped manifest with one entry in `files`. `hls` is
 * empty — the frontend's `hlsService.loadDirect` path picks up
 * `files[0].link` instead. Format string flows through as the file's
 * MIME type so the frontend can choose the right code path.
 */
function externalVideoManifest(id: string, href: string, format: string): VideoManifest {
  return {
    kind: 'video',
    id,
    title: '',
    duration: 0,
    hls: '',
    files: [
      {
        quality: 'source',
        size: 0,
        type: format,
        link: href,
      },
    ],
  }
}

export async function resolveManifest(
  row: { id: string; format: string; data_ref: string },
  env: CatalogEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ manifest: Manifest } | { error: { status: number; code: string; message: string } }> {
  const parsed = parseDataRef(row.data_ref)
  if (!parsed) {
    return {
      error: {
        status: 500,
        code: 'invalid_data_ref',
        message: `Dataset ${row.id} has a malformed data_ref.`,
      },
    }
  }

  const isVideo = row.format.startsWith('video/')
  const isImage = row.format.startsWith('image/')

  if (parsed.scheme === 'vimeo') {
    if (!isVideo) {
      return {
        error: {
          status: 400,
          code: 'data_ref_format_mismatch',
          message: `Dataset ${row.id} has a vimeo: data_ref but a non-video format (${row.format}).`,
        },
      }
    }
    const proxyBase = env.VIDEO_PROXY_BASE ?? DEFAULT_VIDEO_PROXY_BASE
    const manifest = await fetchVimeoManifest(parsed.value, proxyBase, fetchImpl)
    if (!manifest) {
      return {
        error: {
          status: 502,
          code: 'upstream_unavailable',
          message: 'The video proxy did not return a usable manifest.',
        },
      }
    }
    return { manifest }
  }

  if (parsed.scheme === 'url') {
    if (isVideo) return { manifest: externalVideoManifest(row.id, parsed.value, row.format) }
    if (isImage) return { manifest: imageVariants(parsed.value) }
    return {
      error: {
        status: 415,
        code: 'unsupported_format',
        message: `Dataset ${row.id} has format ${row.format} which is not yet served by the manifest endpoint.`,
      },
    }
  }

  // Phase 1b schemes: `stream:<uid>` (Cloudflare Stream HLS) and
  // `r2:<key>` (R2-served images / direct files). Both land via the
  // upload pipeline in `POST .../asset` + `/complete`.
  if (parsed.scheme === 'stream') {
    if (!isVideo) {
      return {
        error: {
          status: 400,
          code: 'data_ref_format_mismatch',
          message: `Dataset ${row.id} has a stream: data_ref but a non-video format (${row.format}).`,
        },
      }
    }
    let hls: string
    try {
      hls = streamPlaybackUrl(env, parsed.value)
    } catch (err) {
      if (isConfigurationError(err)) {
        return {
          error: { status: 503, code: 'stream_unconfigured', message: err.message },
        }
      }
      throw err
    }
    return {
      manifest: {
        kind: 'video',
        id: row.id,
        title: '',
        duration: 0,
        hls,
        // Restricted-bucket / signed-MP4 fallback is a Phase 4
        // federation concern; the public HLS URL is enough for the
        // existing `hlsService.ts` to play the asset on Phase 1b.
        files: [],
      },
    }
  }

  if (parsed.scheme === 'r2') {
    const url = r2ReadUrl(env, parsed.value)
    if (!url) {
      return {
        error: {
          status: 503,
          code: 'r2_unconfigured',
          message:
            'R2 read URL cannot be constructed — set CF_IMAGES_RESIZE_BASE for public-image ' +
            'transformations, R2_PUBLIC_BASE for a public-bucket origin, or MOCK_R2=true for ' +
            'local development.',
        },
      }
    }
    if (isImage) {
      const base = env.CF_IMAGES_RESIZE_BASE?.trim()
      const bucket = env.CATALOG_R2_BUCKET?.trim() || 'terraviz-assets'
      if (base) {
        const variants = [4096, 2048, 1024].map(width => ({
          width,
          url: `${base.replace(/\/$/, '')}/cdn-cgi/image/fit=scale-down,width=${width},format=auto/${bucket}/${encodeKey(parsed.value)}`,
        }))
        return { manifest: { kind: 'image', variants, fallback: url } }
      }
      // No Cloudflare Images transformations — emit a single-variant
      // manifest pointing at the direct R2 URL. The frontend's
      // progressive-resolution probe falls through to fallback.
      return { manifest: { kind: 'image', variants: [], fallback: url } }
    }
    if (isVideo) {
      // Non-Stream video sitting on R2 (rare in 1b — Stream is the
      // default — but possible for the >4K HLS-on-R2 path described
      // in `CATALOG_ASSETS_PIPELINE.md` "Resolution tiers"). Emit a
      // single-file manifest pointing at the direct URL.
      return { manifest: externalVideoManifest(row.id, url, row.format) }
    }
    // Tour / JSON assets need a manifest discriminator that isn't
    // `video|image` (the existing `Manifest` union here). Adding a
    // `kind: 'file'` shape is a wider frontend change — the tour
    // engine fetches `tour_json_ref` directly, not via /manifest —
    // so for Phase 1b we surface 415 and let a Phase 3 publisher-
    // portal commit add the new kind alongside the consumer.
    return {
      error: {
        status: 415,
        code: 'unsupported_format',
        message: `Dataset ${row.id} has format ${row.format} which is not yet served by the manifest endpoint.`,
      },
    }
  }

  // `peer:` (federation) lands in Phase 4. Hand-edited rows with
  // unknown schemes get a clear 501 rather than a hang.
  return {
    error: {
      status: 501,
      code: 'unsupported_data_ref',
      message: `data_ref scheme "${parsed.scheme}" is not implemented in this release.`,
    },
  }
}

/**
 * Encode an R2 key for inclusion in a URL path. Slashes are
 * preserved (they're path separators in R2 keys); everything else
 * goes through `encodeURIComponent`.
 */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/**
 * Build a publicly-readable URL for an R2 object. Tries, in order:
 *   1. `R2_PUBLIC_BASE` — operator-configured custom-domain origin
 *      (e.g. `https://assets.terraviz.example.com`).
 *   2. `MOCK_R2=true` — local-dev stub host the test suite
 *      asserts against.
 *   3. `R2_S3_ENDPOINT` — direct path-style S3 URL; only resolves
 *      to readable bytes for buckets with public access enabled.
 * Returns null when none of those apply — caller surfaces a 503.
 *
 * Restricted-bucket presigned-GET semantics are a Phase 4
 * federation concern; the manifest endpoint here serves the
 * happy-path public read.
 */
function r2ReadUrl(env: CatalogEnv, key: string): string | null {
  const bucket = env.CATALOG_R2_BUCKET?.trim() || 'terraviz-assets'
  const path = encodeKey(key)
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

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')
  if (!context.env.CATALOG_DB) {
    return jsonError(
      503,
      'binding_missing',
      'CATALOG_DB binding is not configured on this deployment.',
    )
  }

  const db = context.env.CATALOG_DB
  const [identity, row] = await Promise.all([getNodeIdentity(db), getPublicDataset(db, id)])
  if (!identity) {
    return jsonError(
      503,
      'identity_missing',
      'Node identity has not been provisioned. Run `npm run gen:node-key`.',
    )
  }
  if (!row) return jsonError(404, 'not_found', `Dataset ${id} not found.`)

  const result = await resolveManifest(row, context.env)
  if ('error' in result) {
    return jsonError(result.error.status, result.error.code, result.error.message)
  }

  const body = JSON.stringify(result.manifest)
  const etag = await computeEtag(body)
  if (context.request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL },
    })
  }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      ETag: etag,
      'Cache-Control': CACHE_CONTROL,
    },
  })
}
