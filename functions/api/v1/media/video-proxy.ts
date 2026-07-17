/**
 * GET/HEAD /api/v1/media/video-proxy?url=<mp4> — a CORS-adding,
 * Range-passing stream proxy for direct video files from registered
 * video sources (task: video-sitemap media source, decision #4).
 *
 * Why it exists: a companion tour plays a picked event video with a
 * native `<video>`. In 2D that works against any host, but the immersive
 * (VR/AR) path wraps the element in a `THREE.VideoTexture`, and WebGL
 * refuses a cross-origin upload unless the response carries
 * `Access-Control-Allow-Origin`. Agency CDNs (NOAA's included) send none.
 * This same-origin proxy adds ACAO and forwards Range requests so
 * seeking still works, letting VR play the video the 2D path already can.
 *
 * NOT an open proxy: the requested URL's host must be on the allowlist
 * derived from ENABLED video sources' indexed content
 * (`allowlistedContentHosts`) — a host earns trust only by an operator
 * registering a source that serves it. A non-http(s) URL, an
 * unrecognised host, or a missing DB is refused before any upstream
 * fetch. Public (unauthenticated) by design — it serves approved-event
 * tours on the public site — but bounded by that allowlist.
 */

import type { CatalogEnv } from '../_lib/env'
import { allowlistedContentHosts } from '../_lib/video-index-store'

/** Upstream request timeout. Video is streamed, so this bounds the
 *  time-to-first-byte, not the whole transfer. */
const UPSTREAM_TIMEOUT_MS = 15_000

/** How long a resolved allowlist is reused before re-reading D1. A
 *  single `<video>` fires many GET/HEAD Range requests, so re-querying
 *  the allowlist on every one adds needless D1 latency/cost to the
 *  streaming path. The set only changes when sources are (re)indexed or
 *  toggled, so a short staleness window is fine — a just-removed host
 *  stays proxyable for at most this long. */
const ALLOWLIST_TTL_MS = 30_000

/** Per-D1-binding TTL cache. Keyed by the binding object (a WeakMap) so
 *  it caches across requests within one Worker isolate in production,
 *  while staying isolated per test (each test uses a distinct DB). */
const allowlistCache = new WeakMap<object, { hosts: Set<string>; expires: number }>()

async function cachedAllowlistedHosts(db: D1Database): Promise<Set<string>> {
  const now = Date.now()
  const cached = allowlistCache.get(db as object)
  if (cached && cached.expires > now) return cached.hosts
  const hosts = await allowlistedContentHosts(db)
  allowlistCache.set(db as object, { hosts, expires: now + ALLOWLIST_TTL_MS })
  return hosts
}

/** Response headers copied from upstream when present — everything a
 *  media element needs to play + seek. `content-type` is handled
 *  separately (restricted to a media allowlist), NOT blindly forwarded. */
const FORWARD_HEADERS = [
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
  'cache-control',
]

/** Content types this proxy will pass through verbatim. Anything else
 *  (notably `text/html`) is neutralized to `application/octet-stream` so
 *  an upstream — reached directly or via a redirect — can never have its
 *  body executed as HTML/script on THIS app's origin. Matched on the
 *  media type only (parameters like `; charset` are ignored). */
const ALLOWED_CONTENT_TYPE_RE = /^(?:video\/|audio\/|image\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|octet-stream)\b)/i

/** The content-type to advertise: the upstream value when it's a media
 *  type, else a non-renderable default. */
function safeContentType(upstream: string | null): string {
  if (upstream && ALLOWED_CONTENT_TYPE_RE.test(upstream.trim())) return upstream
  return 'application/octet-stream'
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  }
}

function refuse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() },
  })
}

export const onRequestOptions: PagesFunction<CatalogEnv> = async () =>
  new Response(null, { status: 204, headers: corsHeaders() })

async function handle(context: Parameters<PagesFunction<CatalogEnv>>[0], method: 'GET' | 'HEAD'): Promise<Response> {
  if (!context.env.CATALOG_DB) return refuse(503, 'CATALOG_DB is not configured.')

  const raw = new URL(context.request.url).searchParams.get('url')
  if (!raw) return refuse(400, 'A `url` query parameter is required.')
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return refuse(400, 'Malformed `url`.')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return refuse(400, '`url` must be http(s).')
  }

  // Only proxy hosts a registered, enabled source actually serves.
  const allowed = await cachedAllowlistedHosts(context.env.CATALOG_DB)
  if (!allowed.has(target.hostname.toLowerCase())) {
    return refuse(403, 'This host is not a registered video source.')
  }

  // Forward the client's Range so partial-content seeking works.
  const upstreamHeaders: Record<string, string> = {}
  const range = context.request.headers.get('Range')
  if (range) upstreamHeaders['Range'] = range

  let upstream: Response
  try {
    upstream = await fetch(target.toString(), {
      method,
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: 'follow',
    })
  } catch {
    return refuse(502, 'Could not reach the upstream video.')
  }

  const headers = new Headers(corsHeaders())
  for (const name of FORWARD_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  // Restrict content-type to media + forbid MIME sniffing, so a body
  // served through this same-origin proxy can never execute as HTML on
  // the app's origin (the upstream, or a redirect target, is untrusted).
  headers.set('Content-Type', safeContentType(upstream.headers.get('content-type')))
  headers.set('X-Content-Type-Options', 'nosniff')
  // A HEAD has no body; a GET streams the upstream body straight through.
  return new Response(method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

export const onRequestGet: PagesFunction<CatalogEnv> = context => handle(context, 'GET')
export const onRequestHead: PagesFunction<CatalogEnv> = context => handle(context, 'HEAD')
