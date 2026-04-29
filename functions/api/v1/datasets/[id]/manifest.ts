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

  // Phase-2+ schemes: stream:, r2:, peer:. Catalog rows for these
  // shouldn't exist in Phase 1a, but if a self-hosted contributor
  // hand-edits the DB they get a clear 501 rather than a hang.
  return {
    error: {
      status: 501,
      code: 'unsupported_data_ref',
      message: `data_ref scheme "${parsed.scheme}" is not implemented in this release.`,
    },
  }
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
