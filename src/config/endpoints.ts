/**
 * Externally-hosted endpoint configuration.
 *
 * Terraviz is designed so each deployed node operates **independently**
 * of every other node. A handful of runtime dependencies were
 * historically hardcoded to the upstream `zyra-project` node's
 * infrastructure — the Vimeo / caption proxy worker and the
 * CloudFront-fronted Earth basemap bucket. Hardcoding them silently
 * coupled every fork to upstream's uptime and bandwidth.
 *
 * Each base is now resolved here from a build-time `VITE_*` env var,
 * defaulting to the upstream URL so an un-configured build still
 * works out of the box (a quick demo fork). To run a fully
 * independent node, set the corresponding variable at build time
 * (Cloudflare Pages → Settings → Environment variables) and host the
 * proxy / assets yourself. See `docs/SELF_HOSTING.md` Phase 1.5.
 *
 * These are read at module load; Vite inlines `import.meta.env.VITE_*`
 * as string literals at build time, so each export is effectively a
 * compile-time constant in the shipped bundle.
 *
 * Note: the NASA GIBS tile base, the NOAA "Science On a Sphere"
 * metadata snapshot, and the cloud-texture bucket are third-party
 * **public data sources** shared by all nodes — not upstream-Terraviz
 * infrastructure — so they are deliberately not parameterised here.
 */

/** Trim a single trailing slash so callers can always append `/x`. */
function normalizeBase(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  return trimmed.replace(/\/+$/, '')
}

/**
 * Base for the video proxy that resolves legacy `vimeo:` dataset
 * refs into HLS / MP4 manifests. Consumers append `/{vimeoId}`.
 * Override with `VITE_VIDEO_PROXY_BASE`.
 */
export const VIDEO_PROXY_BASE = normalizeBase(
  import.meta.env.VITE_VIDEO_PROXY_BASE,
  'https://video-proxy.zyra-project.org/video',
)

/**
 * Base for the caption proxy — a CORS shim in front of `sos.noaa.gov`
 * `.srt` files. Consumers append `?url=<encoded caption url>`.
 * Override with `VITE_CAPTION_PROXY_BASE`.
 */
export const CAPTION_PROXY_BASE = normalizeBase(
  import.meta.env.VITE_CAPTION_PROXY_BASE,
  'https://video-proxy.zyra-project.org/captions',
)

/**
 * Base for the Earth basemap textures used by the photoreal Earth
 * (VR + Orbit character) and the 2D globe overlays: diffuse, night
 * lights, normal map, and country-borders PNG. Consumers append
 * `/earth_diffuse_4096.jpg`, `/country-borders-black-8192.png`, etc.
 * Override with `VITE_EARTH_ASSET_BASE` (and mirror the assets to
 * your own host) to decouple from upstream's CDN.
 */
export const EARTH_ASSET_BASE = normalizeBase(
  import.meta.env.VITE_EARTH_ASSET_BASE,
  'https://d3sik7mbbzunjo.cloudfront.net/terraviz/basemaps',
)
