/**
 * Cloudflare Pages Function — GET /api/v1/datasets/{id}/manifest
 *
 * Resolves a dataset's `data_ref` to a concrete playback manifest.
 * The catalog row stores a *reference* (`vimeo:123`, `url:https://...`,
 * eventually `stream:abc`, `r2:key`, `peer:node/dataset`); this
 * endpoint resolves the reference to whatever shape the frontend
 * needs to actually play the asset.
 *
 * Resolution policy by data_ref scheme + format:
 *   - `vimeo:<id>` + video — proxied through the existing
 *     `video-proxy.zyra-project.org`. Surfaces what Vimeo's API
 *     exposes; subject to the proxy's quality ceiling.
 *   - `url:<href>` + video — synthesized single-file manifest
 *     pointing at the external URL (legacy NOAA imagery,
 *     occasional MP4 hosted alongside SOS).
 *   - `url:<href>` + image — synthesized progressive-resolution
 *     variants matching the existing `_4096`/`_2048`/`_1024`
 *     ladder the frontend already probes.
 *   - `stream:<uid>` + video — Cloudflare Stream HLS playback
 *     URL (Phase 1b; uncommon now that Phase 3's R2/HLS path is
 *     preferred for spherical content above 1080p).
 *   - `r2:<key>` + image — Cloudflare Images variant ladder when
 *     CF_IMAGES_RESIZE_BASE is configured, otherwise a single
 *     fallback URL.
 *   - `r2:<key>.m3u8` + video — HLS master playlist served from
 *     the R2 public bucket. The Phase 3 r2-hls migration writes
 *     `r2:videos/<dataset_id>/master.m3u8` here; the SPA's HLS
 *     player consumes the `hls` field directly.
 *   - `r2:<key>` + video (non-`.m3u8`) — direct single-file MP4
 *     manifest. Rare; mostly future-proofing.
 *   - `peer:` returns 501; mismatched scheme/format pairs return
 *     400 with a typed error envelope.
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
import { parseScheduleSeconds } from '../../_lib/workflow-schedule'
import { getNodeIdentity, getPublicDataset } from '../../_lib/catalog-store'
import { isConfigurationError } from '../../_lib/errors'
import { streamPlaybackUrl } from '../../_lib/stream-store'
import { computeEtag } from '../../_lib/snapshot'
import { encodeR2Key, resolveR2HlsPublicUrl, resolveR2PublicUrl } from '../../_lib/r2-public-url'

const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600'

/** Phase Z4 (docs/ZYRA_INTEGRATION_PLAN.md): rows with a LIVE
 *  update cadence re-bind to their newest upload bundle faster — a
 *  workflow re-publish is visible within ~1 minute instead of 5.
 *  Liveness requires `period` AND a trailing edge within two
 *  cadences of now — historical time-series rows carry `period`
 *  too and keep the standard policy (PR #179 review). Bundle URLs
 *  are immutable per upload_id, so this only shortens the
 *  pointer's cache, never re-fetches video bytes. */
const CACHE_CONTROL_REALTIME = 'public, max-age=60, stale-while-revalidate=120'

export function cacheControlFor(
  row: { period: string | null; end_time: string | null },
  now: number = Date.now(),
): string {
  const seconds = row.period ? parseScheduleSeconds(row.period) : null
  // P0D parses to 0 and overflowed components to Infinity — neither
  // is a real cadence (PR #179 review).
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return CACHE_CONTROL
  if (!row.end_time) return CACHE_CONTROL_REALTIME
  const end = Date.parse(row.end_time)
  if (!Number.isFinite(end)) return CACHE_CONTROL
  return now - end <= 2 * seconds * 1000 ? CACHE_CONTROL_REALTIME : CACHE_CONTROL
}
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
 *
 * Re-exported from the shared `_lib/data-ref` module so the
 * catalog read path can use the same splitter without pulling in
 * this file (and its transitive image/video deps). New callers
 * should import directly from `_lib/data-ref`.
 */
import { parseDataRef } from '../../_lib/data-ref'
export { parseDataRef }

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
    const url = resolveR2PublicUrl(env, parsed.value)
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
          url: `${base.replace(/\/$/, '')}/cdn-cgi/image/fit=scale-down,width=${width},format=auto/${bucket}/${encodeR2Key(parsed.value)}`,
        }))
        return { manifest: { kind: 'image', variants, fallback: url } }
      }
      // No Cloudflare Images transformations — emit a single-variant
      // manifest pointing at the direct R2 URL. The frontend's
      // progressive-resolution probe falls through to fallback.
      return { manifest: { kind: 'image', variants: [], fallback: url } }
    }
    if (isVideo) {
      // HLS bundles (Phase 3 r2-hls migration): when the key ends
      // in `.m3u8`, the value is an HLS master playlist URL. The
      // SPA's hlsService.ts uses the `hls` field; `files` stays
      // empty (no direct-file alternative needed because the
      // master playlist references its own variant streams + ts
      // segments via relative paths under the same R2 prefix).
      //
      // Resolution here is stricter than the image / single-file
      // MP4 branches above: we require an *explicit* public
      // origin (`R2_PUBLIC_BASE` in prod or `MOCK_R2` for tests)
      // rather than letting the `R2_S3_ENDPOINT` fallback fire.
      // In a typical production setup `R2_S3_ENDPOINT` is present
      // so the Phase 3 CLI can sign PUTs, but the bucket itself
      // is *not* publicly readable through that endpoint — a
      // custom domain bound via "Connect Domain" is. Falling
      // through to the S3 endpoint would return an `hls:` URL
      // that 403s at play time and contradicts the runbook
      // (`expected-bindings.ts` already documents the missing-
      // R2_PUBLIC_BASE → 503 r2_unconfigured contract).
      if (parsed.value.toLowerCase().endsWith('.m3u8')) {
        const hls = resolveR2HlsPublicUrl(env, parsed.value)
        if (!hls) {
          return {
            error: {
              status: 503,
              code: 'r2_unconfigured',
              message:
                'R2 public origin is not configured for HLS playback — set ' +
                'R2_PUBLIC_BASE to the bucket\'s custom-domain URL (Cloudflare ' +
                'dashboard → R2 → bucket → Settings → Connect Domain), or set ' +
                'MOCK_R2=true for local development. The R2_S3_ENDPOINT fallback ' +
                'is intentionally skipped here because that endpoint is for ' +
                'signed S3 API access, not public reads.',
            },
          }
        }
        return {
          manifest: {
            kind: 'video',
            id: row.id,
            title: '',
            duration: 0,
            hls,
            files: [],
          },
        }
      }
      // Non-HLS video sitting on R2 (rare — direct MP4 hosted on
      // R2 instead of Stream or an external URL). Emit a
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

// R2 public-URL resolution moved to `_lib/r2-public-url.ts` so the
// docent's featured-list helper can share it. Imported above as
// `resolveR2PublicUrl`.

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
  const cacheControl = cacheControlFor(row)
  if (context.request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': cacheControl },
    })
  }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE,
      ETag: etag,
      'Cache-Control': cacheControl,
    },
  })
}
