// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
 * proxy / assets yourself. See `docs/SELF_HOSTING.md` Reference C.
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
 *
 * Same-origin by default. The eleven files are committed under
 * `public/assets/basemaps/`, so a build serves them from the node's
 * own domain with nothing configured, no install-time network, and
 * nothing that can be missing when the globe first paints.
 *
 * This used to default to upstream's CloudFront distribution, which
 * meant every fork's visitors pulled the Earth from upstream's
 * bandwidth unless its operator noticed Reference C and mirrored the
 * files by hand. Almost none did — it was the only entry in that
 * table applying to every node, and the only one with no tooling.
 *
 * Override with `VITE_EARTH_ASSET_BASE` to serve them from a CDN
 * instead — an optimisation now, not a workaround. `.gitattributes`
 * carries the note on why these are plain blobs rather than LFS.
 */
export const EARTH_ASSET_BASE = normalizeBase(
  import.meta.env.VITE_EARTH_ASSET_BASE,
  '/assets/basemaps',
)
