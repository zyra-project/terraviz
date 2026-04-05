/**
 * Cloudflare Pages Function — /api/tile/[...path]
 *
 * Proxies NASA GIBS tile requests through Cloudflare's edge network so that:
 * 1. Tiles are cached at the nearest Cloudflare PoP (~20ms vs ~200ms from GIBS origin)
 * 2. Aggressive Cache-Control headers ensure the browser caches tiles long-term
 * 3. Same-origin requests avoid CORS preflight overhead
 *
 * Example:
 *   /api/tile/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/2/1/3.jpg
 *   → https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/2/1/3.jpg
 */

type Env = Record<string, never>

const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'

// Only allow known GIBS layer prefixes to prevent open-proxy abuse
const ALLOWED_PREFIXES = [
  'BlueMarble_NextGeneration/',
  'VIIRS_Black_Marble/',
]

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const pathParam = context.params.path
  if (!pathParam) {
    return new Response('Missing tile path', { status: 400 })
  }

  const segments = Array.isArray(pathParam) ? pathParam : [pathParam]

  // Reject path traversal attempts and malformed encoding
  for (const segment of segments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return new Response('Invalid tile path', { status: 400 })
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      return new Response('Invalid tile path', { status: 400 })
    }
  }

  const tilePath = segments.join('/')

  if (!ALLOWED_PREFIXES.some(prefix => tilePath.startsWith(prefix))) {
    return new Response('Layer not allowed', { status: 403 })
  }

  const gibsUrl = `${GIBS_BASE}/${tilePath}`

  let upstream: Response
  try {
    upstream = await fetch(gibsUrl, {
      // Cloudflare-specific: cache at the edge for 1 year (tiles never change)
      cf: {
        cacheEverything: true,
        cacheTtl: 31536000,
      },
    } as RequestInit)
  } catch {
    return new Response('Failed to fetch tile from GIBS', { status: 502 })
  }

  if (!upstream.ok) {
    return new Response(`GIBS returned ${upstream.status}`, { status: upstream.status })
  }

  const contentType = upstream.headers.get('Content-Type') ?? 'image/jpeg'

  return new Response(upstream.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
