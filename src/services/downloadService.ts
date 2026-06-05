/**
 * Download Service — manages offline dataset downloads via Tauri backend.
 *
 * Desktop-only (Tauri). All public functions are no-ops on the web,
 * except for the pure `resolveAssets()` / `expandFrameAssets()`
 * helpers which the web-only zip downloader (§8.2) also consumes.
 *
 * `resolveAssets(dataset)` is the shared asset-resolution surface: it
 * walks the catalog manifest (publisher-portal R2 datasets) or falls
 * back to the legacy SOS / Vimeo paths, and returns a typed
 * `ResolvedAsset[]` describing the primary + auxiliary downloads.
 * Both the desktop downloader (this file's `downloadDataset()`) and
 * the web zip path (`zipDownloadService.ts`) call it; the source-of-
 * truth field on each asset is what the zip dialog renders as
 * "Downloaded as source MP4 from publisher upload" vs "best-quality
 * MP4 from Vimeo proxy" so the user knows what's in the archive.
 */

import type { Dataset } from '../types'
import { dataService } from './dataService'
import { apiFetch, isManifestUrl, getApiOrigin } from './catalogSource'
import { proxyCaptionUrl } from '../utils/captionProxy'
import { logger } from '../utils/logger'
import { VIDEO_PROXY_BASE } from '../config/endpoints'

const IS_TAURI = !!(window as any).__TAURI__

// Hostnames whose URLs we trust as "publisher original" — the
// Cloudflare Pages origin and any subdomain of an operated domain
// (R2 public buckets bound to custom domains, image transformations
// served from the main origin, etc.). Subdomains match by suffix. A
// URL served from any other host falls back to `external` rather
// than being mislabelled as a publisher source.
//
// This static list holds the upstream production domain; a fork's
// own host is added dynamically by `publisherHosts()` below, so a
// self-hosted node serving assets from a subdomain of its own domain
// classifies them as `publisher` without a code edit.
//
// Intentionally NOT including the bare `r2.dev` apex — a `*.r2.dev`
// suffix match would classify every third-party R2 public bucket as
// our publisher source. Production R2 assets are served via custom
// domains under the operated domain; the default `*.r2.dev` URL
// shouldn't appear in our manifests, and if it does it should
// classify as `external` until someone explicitly adds the specific
// bucket subdomain here.
const PUBLISHER_HOSTS = [
  'zyra-project.org',
]

// Loopback / pseudo-hosts that must never be trusted as a publisher
// suffix: they never appear in a manifest, and a local-dev
// `VITE_API_ORIGIN=http://localhost:...` would otherwise classify
// every loopback URL as a publisher source.
function isLoopbackHost(host: string): boolean {
  return !host || host === 'localhost' || host.endsWith('.localhost')
}

// The set of trusted publisher hosts for the running node: the
// static upstream domain(s) above plus this node's own host. The
// own-host is derived from the configured API origin (desktop /
// `VITE_API_ORIGIN`) and, on web, the live page origin — whichever
// resolves. `localhost` / Tauri webview pseudo-hosts are skipped
// (see `isLoopbackHost`): they never appear in a manifest and only
// add noise.
function publisherHosts(): string[] {
  const hosts = [...PUBLISHER_HOSTS]
  try {
    const apiHost = new URL(getApiOrigin()).hostname.toLowerCase()
    if (!isLoopbackHost(apiHost)) hosts.push(apiHost)
  } catch {
    // getApiOrigin always returns a valid origin, but guard anyway.
  }
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const pageHost = window.location.hostname.toLowerCase()
    if (!isLoopbackHost(pageHost)) hosts.push(pageHost)
  }
  return hosts
}

// Use Tauri's CORS-free fetch for HEAD probes when available.
const tauriFetchReady: Promise<typeof globalThis.fetch | null> = IS_TAURI
  ? import('@tauri-apps/plugin-http')
      .then(m => m.fetch as typeof globalThis.fetch)
      .catch(() => null)
  : Promise.resolve(null)

async function corsFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const f = await tauriFetchReady
  return f ? f(input, init) : fetch(input, init)
}

// --- Types ---

export interface DownloadedDataset {
  dataset_id: string
  title: string
  format: string
  kind: string
  primary_file: string
  caption_file: string | null
  thumbnail_file: string | null
  legend_file: string | null
  total_bytes: number
  downloaded_at: string
}

export interface DownloadProgress {
  dataset_id: string
  title: string
  downloaded_bytes: number
  total_bytes: number
  phase: string
}

interface AssetInput {
  url: string
  filename: string
}

interface DownloadInput {
  datasetId: string
  title: string
  format: string
  kind: string
  primaryFile: string
  captionFile: string | null
  thumbnailFile: string | null
  legendFile: string | null
  assets: AssetInput[]
}

interface VideoProxyFile {
  quality: string
  width?: number
  height?: number
  size: number
  type: string
  link: string
}

interface VideoProxyResponse {
  id: string
  title: string
  duration: number
  hls: string
  dash: string
  files: VideoProxyFile[]
}

/** Asset role within a dataset's downloadable bundle. Drives both
 * the checkbox labels in the zip dialog and the filename layout
 * inside the resulting archive. */
export type AssetKind =
  | 'primary'
  | 'legend'
  | 'caption'
  | 'thumbnail'
  | 'colorTable'
  | 'frame'

/** Provenance of a resolved asset URL. The zip dialog surfaces this
 * so users know whether the archive contains the publisher's
 * canonical upload, a lossy Vimeo transcode, or a legacy SOS asset.
 *
 * Derived by inspecting the URL's hostname against the known origins
 * (`PUBLISHER_HOSTS` / video-proxy / sos.noaa.gov). A URL that doesn't
 * match any of those buckets falls through to `external`. */
export type SourceOfTruth = 'publisher' | 'vimeo' | 'sos' | 'external'

/** One downloadable file the zip / desktop path will fetch. */
export interface ResolvedAsset {
  kind: AssetKind
  url: string
  /** Suggested archive filename. Stable across reruns — the zip
   * service uses these verbatim as zip-entry names. */
  filename: string
  /** Known size in bytes when the upstream manifest exposes it
   * (video manifests do; image variants don't until a HEAD probe).
   * Consumers that need an exact total should HEAD any asset whose
   * `sizeBytes` is undefined. */
  sizeBytes?: number
  sourceOfTruth: SourceOfTruth
}

// --- Tauri invoke helper ---

let invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null
let listen: ((event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null

const tauriReady: Promise<boolean> = IS_TAURI
  ? Promise.all([
    import('@tauri-apps/api/core').then(m => { invoke = m.invoke }),
    import('@tauri-apps/api/event').then(m => { listen = m.listen }),
  ]).then(() => true).catch(() => false)
  : Promise.resolve(false)

async function cmd<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  await tauriReady
  if (!invoke) throw new Error('Tauri not available')
  return invoke(name, args) as Promise<T>
}

// --- Public API ---

/** Check if we're running in a desktop context that supports downloads. */
export function isDownloadAvailable(): boolean {
  return IS_TAURI
}

/**
 * True if `url` is an absolute http(s) URL — i.e. something the Rust
 * download manager (reqwest) can actually fetch. Catches the failure
 * modes that previously surfaced as opaque `HTTP request failed:
 * builder error` in the Rust log: relative paths (`/api/v1/...`),
 * raw `r2:` / `stream:` / `vimeo:` data_ref schemes leaked through
 * the catalog serializer, and empty strings.
 */
function isHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false
  return /^https?:\/\//i.test(url)
}

/**
 * Pull the file extension off a URL (`.mp4`, `.jpg`, `.png`), tolerant
 * of query strings. Falls back to `defaultExt` if nothing matches.
 */
function extFromUrl(url: string, defaultExt: string): string {
  const match = url.match(/(\.\w+)(\?|#|$)/)
  return match ? match[1] : defaultExt
}

/**
 * Classify a URL by its hostname so the UI can render an honest
 * source-of-truth note in the zip dialog. The check parses via the
 * URL constructor (subdomain-safe — never substring-matches) and
 * matches against the explicit `PUBLISHER_HOSTS` list / the video-
 * proxy host / sos.noaa.gov.
 *
 * Errors (malformed URL) and any host outside those buckets fall
 * through to `external`, which the dialog labels generically.
 */
export function classifySourceOfTruth(url: string): SourceOfTruth {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'external'
  }
  if (host === 'video-proxy.zyra-project.org' || host.endsWith('.vimeocdn.com')) {
    return 'vimeo'
  }
  if (host === 'sos.noaa.gov' || host.endsWith('.sos.noaa.gov')) {
    return 'sos'
  }
  for (const publisher of publisherHosts()) {
    if (host === publisher || host.endsWith(`.${publisher}`)) return 'publisher'
  }
  return 'external'
}

/**
 * Fetch the catalog's manifest envelope for a node-mode dataset. The
 * envelope shape is documented in
 * `functions/api/v1/datasets/[id]/manifest.ts`: `{ kind: 'video' |
 * 'image', ... }` with `files[]` for videos and `variants[]` +
 * `fallback` for images. Same shape datasetLoader.ts consumes for
 * playback, kept in sync here so download and play resolve to the
 * same underlying URLs.
 */
async function fetchManifestEnvelope(dataLink: string, signal?: AbortSignal): Promise<
  | { kind: 'video'; files?: VideoProxyFile[] }
  | { kind: 'image'; variants?: Array<{ width: number; url: string }>; fallback?: string }
> {
  const res = await apiFetch(dataLink, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status} ${res.statusText}`)
  return res.json()
}

/**
 * Pure picker over a video manifest envelope's `files[]`: returns the
 * highest-width MP4 with an http(s) link, or throws a typed error.
 * Extracted so unit tests can call into the real selection logic
 * (sort + HLS-empty guard + non-HTTP guard) rather than re-implementing
 * it inline.
 */
function pickBestVideoFile(envelope: { kind: 'video'; files?: VideoProxyFile[] }): {
  link: string
  size: number
} {
  const files = envelope.files ?? []
  if (files.length === 0) {
    // R2 HLS bundles (Phase 3 r2-hls migration) populate `hls` but
    // leave `files[]` empty — there's no direct MP4 to grab and
    // reassembling a playlist + .ts segments into a single offline
    // file is a follow-on feature. Surface a clear error so the UI
    // can render something better than reqwest's `builder error`.
    throw new Error(
      'This dataset is HLS-streamed and not yet available for offline download. ' +
      'Open it online to view, or try a different dataset for offline use.',
    )
  }
  const sorted = [...files].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  const best = sorted[0]
  if (!isHttpUrl(best.link)) {
    throw new Error(`Video manifest returned a non-HTTP file link: ${best.link}`)
  }
  return { link: best.link, size: best.size }
}

/**
 * Pure ordering over an image manifest envelope: returns http(s)-only
 * candidate URLs, highest-width variant first, with `fallback`
 * appended last. Empty result is valid — callers throw their own
 * "no usable variants" error so the message matches their context.
 */
function orderImageCandidates(envelope: {
  kind: 'image'
  variants?: Array<{ width: number; url: string }>
  fallback?: string
}): string[] {
  const variants = [...(envelope.variants ?? [])].sort((a, b) => b.width - a.width)
  return [
    ...variants.map(v => v.url),
    ...(envelope.fallback ? [envelope.fallback] : []),
  ].filter(isHttpUrl)
}

/** Resolve the best video file for download (highest quality MP4). */
async function resolveVideoPrimary(dataset: Dataset, signal?: AbortSignal): Promise<{ url: string; sizeBytes: number; filename: string }> {
  // Node-mode: dataLink is `/api/v1/datasets/{id}/manifest`. Fetch
  // the envelope and walk `files[]` — same path datasetLoader.ts
  // uses for playback. The legacy direct-Vimeo path below stays for
  // catalogs that still serve vimeo.com URLs in dataLink (the
  // `legacy` catalog source).
  if (isManifestUrl(dataset.dataLink)) {
    const envelope = await fetchManifestEnvelope(dataset.dataLink, signal)
    if (envelope.kind !== 'video') {
      throw new Error(`Expected a video manifest; got kind=${envelope.kind}.`)
    }
    const best = pickBestVideoFile(envelope)
    return { url: best.link, sizeBytes: best.size, filename: 'video.mp4' }
  }

  // Legacy catalog: dataLink is a vimeo.com URL, resolve via proxy.
  const vimeoId = dataService.extractVimeoId(dataset.dataLink)
  if (!vimeoId) throw new Error(`Cannot extract Vimeo ID from ${dataset.dataLink}`)

  const res = await fetch(`${VIDEO_PROXY_BASE}/${vimeoId}`, { signal })
  if (!res.ok) throw new Error(`Video proxy returned ${res.status}`)
  const manifest: VideoProxyResponse = await res.json()

  const sorted = [...manifest.files].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  const best = sorted[0]
  if (!best) throw new Error('No video files available')
  return { url: best.link, sizeBytes: best.size, filename: 'video.mp4' }
}

/** Resolve image assets for download (highest available resolution). */
async function resolveImagePrimary(dataset: Dataset, signal?: AbortSignal): Promise<{ url: string; filename: string }> {
  // Node-mode: dataLink is the manifest endpoint. Walk `variants[]`
  // highest-width-first, HEAD-probe each, fall back to `fallback`.
  if (isManifestUrl(dataset.dataLink)) {
    const envelope = await fetchManifestEnvelope(dataset.dataLink, signal)
    if (envelope.kind !== 'image') {
      throw new Error(`Expected an image manifest; got kind=${envelope.kind}.`)
    }
    const ordered = orderImageCandidates(envelope)
    if (ordered.length === 0) {
      throw new Error('Image manifest returned no usable variants')
    }
    for (const candidateUrl of ordered) {
      try {
        const probe = await corsFetch(candidateUrl, { method: 'HEAD', signal })
        if (probe.ok) {
          const ext = extFromUrl(candidateUrl, '.jpg')
          return { url: candidateUrl, filename: `image${ext}` }
        }
      } catch (err) {
        // Propagate aborts; otherwise try next candidate.
        if ((err as { name?: string }).name === 'AbortError') throw err
      }
    }
    // No HEAD probe succeeded; trust the highest-resolution variant
    // and let the downstream fetch surface the real HTTP error if it
    // 404s. Same fail-soft posture as the legacy path below.
    const fallback = ordered[0]
    const ext = extFromUrl(fallback, '.jpg')
    return { url: fallback, filename: `image${ext}` }
  }

  // Legacy: SPA mangles the suffix to probe `_4096` / `_2048` /
  // original. Kept for catalogs that still serve direct asset URLs.
  const url = dataset.dataLink
  const ext = url.match(/(\.\w+)$/)
  const base = ext ? url.slice(0, -ext[1].length) : url
  const suffix = ext ? ext[1] : ''

  const candidates = [
    { url: `${base}_4096${suffix}`, filename: `image_4096${suffix}` },
    { url: `${base}_2048${suffix}`, filename: `image_2048${suffix}` },
    { url, filename: `image${suffix}` },
  ]

  for (const candidate of candidates) {
    try {
      const res = await corsFetch(candidate.url, { method: 'HEAD', signal })
      if (res.ok) return candidate
    } catch (err) {
      // Propagate aborts; otherwise try next.
      if ((err as { name?: string }).name === 'AbortError') throw err
    }
  }

  // Last resort: use original URL and hope for the best
  return candidates[candidates.length - 1]
}

/**
 * Resolve only the auxiliary assets attached to a dataset row —
 * legend / caption / thumbnail / color table. Pure HTTP-URL
 * filtering: refs that aren't absolute http(s) are silently dropped
 * (logged at warn level), since the catalog serializer occasionally
 * passes raw `r2:` / `stream:` / `vimeo:` URIs through verbatim.
 *
 * Extracted from `resolveAssets()` so callers that don't want the
 * primary (notably the web zip path's frame-mode flow, where the
 * frame bundle replaces the rendered primary and the video manifest
 * would throw HLS-only) can resolve auxiliaries directly without
 * tripping a primary-asset resolution error.
 */
function resolveAuxiliaryAssets(dataset: Dataset): ResolvedAsset[] {
  const assets: ResolvedAsset[] = []

  // The catalog serializer currently passes `thumbnail_ref` /
  // `legend_ref` / `caption_ref` through verbatim, so they may arrive
  // as raw `r2:` / `stream:` / `vimeo:` URIs rather than absolute
  // https URLs. Filter to http(s) only — the downstream fetch
  // refuses anything else, and a missing thumbnail is much better
  // UX than a failed download.
  if (isHttpUrl(dataset.legendLink)) {
    const ext = extFromUrl(dataset.legendLink, '.png')
    assets.push({
      kind: 'legend',
      url: dataset.legendLink,
      filename: `legend${ext}`,
      sourceOfTruth: classifySourceOfTruth(dataset.legendLink),
    })
  } else if (dataset.legendLink) {
    logger.warn('[Download] Skipping non-HTTP legend ref:', dataset.legendLink)
  }

  if (isHttpUrl(dataset.closedCaptionLink)) {
    // Caption URLs from sos.noaa.gov need to go through the proxy —
    // host-matched (not substring) so a URL like
    //   https://attacker.example/sos.noaa.gov/foo.srt
    // isn't accidentally routed through the proxy. See
    // `src/utils/captionProxy.ts`.
    const captionUrl = proxyCaptionUrl(dataset.closedCaptionLink)
    assets.push({
      kind: 'caption',
      url: captionUrl,
      filename: 'captions.srt',
      sourceOfTruth: classifySourceOfTruth(dataset.closedCaptionLink),
    })
  } else if (dataset.closedCaptionLink) {
    logger.warn('[Download] Skipping non-HTTP caption ref:', dataset.closedCaptionLink)
  }

  if (isHttpUrl(dataset.thumbnailLink)) {
    const ext = extFromUrl(dataset.thumbnailLink, '.jpg')
    assets.push({
      kind: 'thumbnail',
      url: dataset.thumbnailLink,
      filename: `thumbnail${ext}`,
      sourceOfTruth: classifySourceOfTruth(dataset.thumbnailLink),
    })
  } else if (dataset.thumbnailLink) {
    logger.warn('[Download] Skipping non-HTTP thumbnail ref:', dataset.thumbnailLink)
  }

  if (isHttpUrl(dataset.colorTableLink)) {
    const ext = extFromUrl(dataset.colorTableLink, '.png')
    assets.push({
      kind: 'colorTable',
      url: dataset.colorTableLink,
      filename: `color-table${ext}`,
      sourceOfTruth: classifySourceOfTruth(dataset.colorTableLink),
    })
  } else if (dataset.colorTableLink) {
    logger.warn('[Download] Skipping non-HTTP color-table ref:', dataset.colorTableLink)
  }

  return assets
}

/**
 * Resolve every downloadable asset for `dataset`, in primary-first
 * order. The primary entry is always index 0; auxiliary entries
 * (legend / caption / thumbnail) follow when present.
 *
 * Throws on a primary-asset failure (HLS-only, no usable image
 * variants); auxiliary failures are silently filtered (we'd rather
 * surface a partial archive than reject the whole download because
 * a thumbnail 404s).
 *
 * Both the desktop downloader and the web zip path consume this —
 * the zip dialog then filters the result by user-selected
 * `AssetKind`s, attaches a `manifest.json`, and packages.
 */
export async function resolveAssets(
  dataset: Dataset,
  opts: { signal?: AbortSignal } = {},
): Promise<ResolvedAsset[]> {
  const isVideo = dataset.format.startsWith('video/')
  const assets: ResolvedAsset[] = []

  if (isVideo) {
    const primary = await resolveVideoPrimary(dataset, opts.signal)
    assets.push({
      kind: 'primary',
      url: primary.url,
      filename: primary.filename,
      sizeBytes: primary.sizeBytes > 0 ? primary.sizeBytes : undefined,
      sourceOfTruth: classifySourceOfTruth(primary.url),
    })
  } else {
    const primary = await resolveImagePrimary(dataset, opts.signal)
    assets.push({
      kind: 'primary',
      url: primary.url,
      filename: primary.filename,
      sourceOfTruth: classifySourceOfTruth(primary.url),
    })
  }

  assets.push(...resolveAuxiliaryAssets(dataset))
  return assets
}

/**
 * Pure resolver for auxiliary assets only — public surface for the
 * web zip path's frame-mode flow. Same semantics as the auxiliary
 * portion of `resolveAssets()` but without attempting to resolve a
 * video primary that would throw HLS-only for post-transcode
 * publisher datasets. The frames are the canonical downloadable
 * primary for those rows; the caller pairs this with
 * `expandFrameAssets(dataset)`.
 */
export function resolveAuxiliaryAssetsOnly(dataset: Dataset): ResolvedAsset[] {
  return resolveAuxiliaryAssets(dataset)
}

/**
 * Pure expansion of a frames-mode dataset's `frames.urlTemplate` into
 * one ResolvedAsset per frame. Returns `[]` when the dataset has no
 * `frames` envelope. The zip service uses this when the user opts to
 * download source frames in addition to (or instead of) the rendered
 * primary; the cap-at-1.5-GB enforcement in the dialog gates the
 * actual download.
 *
 * `{index}` in `urlTemplate` is substituted with a zero-padded 5-digit
 * frame index, mirroring the convention the publisher portal /
 * `/api/v1/datasets/{id}/frames` endpoint emits.
 */
export function expandFrameAssets(dataset: Dataset): ResolvedAsset[] {
  if (!dataset.frames) return []
  const { count, urlTemplate } = dataset.frames
  // Same fail-closed guard `resolveFrameQuery` uses for chat-driven
  // frame loads (`src/utils/frames.ts:60`): non-integer / non-
  // positive `count` means the row is corrupt or mid-ingest and the
  // for-loop bound below would silently generate bogus indices
  // (NaN ⇒ no iterations, Infinity ⇒ unbounded loop). Drop the
  // bundle rather than emitting unbounded or off-by-many URLs.
  if (!Number.isInteger(count) || count <= 0) return []
  if (!urlTemplate) return []
  const assets: ResolvedAsset[] = []
  for (let i = 0; i < count; i++) {
    const padded = String(i).padStart(5, '0')
    const url = urlTemplate.replace(/\{index\}/g, padded)
    if (!isHttpUrl(url)) continue
    // Filename: `frame_{NNNNN}{ext}` — match the publisher portal's
    // server-rendered displayName convention so unzipped frames
    // sort correctly without renaming.
    const ext = extFromUrl(url, '.png')
    assets.push({
      kind: 'frame',
      url,
      filename: `frames/frame_${padded}${ext}`,
      sourceOfTruth: classifySourceOfTruth(url),
    })
  }
  return assets
}

/**
 * Heuristic gate for whether the web zip-download button should
 * render for a given dataset on the current deployment. Suppresses
 * the button on rows we know will fail with the "HLS-streamed and
 * not yet available for offline download" error from
 * `resolveVideoPrimary` / `pickBestVideoFile` rather than surfacing
 * a misleading entry point.
 *
 * - Image datasets always render: the manifest endpoint's
 *   `variants[]` ladder gives a downloadable single image.
 * - Frame-mode datasets render even when stored as `video/*`:
 *   `expandFrameAssets()` exposes the per-frame URLs, and the
 *   frame bundle is the canonical downloadable data for the
 *   sequence-source Phase 3pf upload shape.
 * - Plain video datasets (no `frames` envelope) suppress today:
 *   after the Phase 3 r2-hls migration, every video row's
 *   `data_ref` is `r2:videos/{id}/<id>/master.m3u8`, and the
 *   manifest endpoint returns `files: []` for those. The
 *   Vimeo-proxy fallback in `resolveVideoPrimary` exists for
 *   the legacy direct-`vimeo:` shape but no row carries that
 *   data_ref in the current deployment.
 *
 * **TEMPORARY — relax the video-without-frames suppression once
 * issues #147 + #148 land.** #147 exposes the publisher
 * `source.mp4` alongside the HLS manifest for new uploads; #148
 * backfills the source for legacy migrated rows. Either one fixes
 * the underlying "no offline download for HLS-only rows" problem;
 * this gate should be widened when the manifest endpoint
 * reliably returns a non-empty `files[]` for the video cohort the
 * deployment serves.
 */
export function isZipDownloadable(dataset: Dataset): boolean {
  if (dataset.format.startsWith('image/')) return true
  if (dataset.frames) return true
  if (dataset.format.startsWith('video/')) {
    // Legacy direct-URL videos (most commonly `https://vimeo.com/X`
    // dataLinks predating the manifest endpoint) bypass node-mode
    // resolution and route through `resolveVideoPrimary`'s Vimeo-
    // proxy fallback — those produce a working archive. Only the
    // manifest-endpoint shape is suppressed today, where the
    // post-Phase-3-r2-hls deployment returns `files: []` for the
    // dominant `r2:.../master.m3u8` data_ref. A manifest-URL row
    // whose data_ref is still `vimeo:X` would also work via the
    // proxy resolution server-side, but we can't tell which scheme
    // is behind a manifest URL client-side; that distinction
    // arrives via #147's server-side hint.
    if (!isManifestUrl(dataset.dataLink)) return true
  }
  return false
}

/** Get the estimated download size for a dataset. */
export async function getDownloadSize(dataset: Dataset): Promise<number> {
  if (!IS_TAURI) return 0

  const isVideo = dataset.format === 'video/mp4'
  if (isVideo) {
    try {
      const { sizeBytes } = await resolveVideoPrimary(dataset)
      return sizeBytes
    } catch {
      return 0
    }
  }
  return 0 // Can't determine image sizes without HEAD requests
}

/** Start downloading a dataset for offline use. */
export async function downloadDataset(dataset: Dataset): Promise<void> {
  if (!IS_TAURI) return

  const resolved = await resolveAssets(dataset)
  const primary = resolved.find(a => a.kind === 'primary')
  if (!primary) throw new Error(`No primary asset resolved for ${dataset.id}`)
  const isVideo = dataset.format === 'video/mp4'
  const kind = isVideo ? 'video' : 'image'

  // The Rust download manager expects a flat AssetInput[] plus the
  // four "primary / caption / thumbnail / legend" filename slots
  // (Phase 3 desktop UI surfaces these by role). Walk the resolved
  // list, pick the first asset of each role, and pass it through.
  // Color-table downloads aren't tracked separately by the Rust side
  // yet, but the file is still included in `assets[]` so it lands on
  // disk for any consumer that walks the dataset folder directly.
  const captionAsset = resolved.find(a => a.kind === 'caption') ?? null
  const thumbnailAsset = resolved.find(a => a.kind === 'thumbnail') ?? null
  const legendAsset = resolved.find(a => a.kind === 'legend') ?? null

  const input: DownloadInput = {
    datasetId: dataset.id,
    title: dataset.title,
    format: dataset.format,
    kind,
    primaryFile: primary.filename,
    captionFile: captionAsset?.filename ?? null,
    thumbnailFile: thumbnailAsset?.filename ?? null,
    legendFile: legendAsset?.filename ?? null,
    assets: resolved.map(a => ({ url: a.url, filename: a.filename })),
  }

  logger.info('[Download] Starting download:', dataset.id, input.assets.map(a => a.filename))
  await cmd('download_dataset', { input })
}

/** Cancel an in-progress download. */
export async function cancelDownload(datasetId: string): Promise<void> {
  if (!IS_TAURI) return
  await cmd('cancel_download', { datasetId })
}

/** List all downloaded datasets. */
export async function listDownloads(): Promise<DownloadedDataset[]> {
  if (!IS_TAURI) return []
  return cmd<DownloadedDataset[]>('list_downloads')
}

/** Check if a specific dataset is downloaded. */
export async function getDownload(datasetId: string): Promise<DownloadedDataset | null> {
  if (!IS_TAURI) return null
  return cmd<DownloadedDataset | null>('get_download', { datasetId })
}

/** Delete a downloaded dataset. */
export async function deleteDownload(datasetId: string): Promise<void> {
  if (!IS_TAURI) return
  await cmd('delete_download', { datasetId })
}

/** Get the local file path for a downloaded asset. */
export async function getDownloadPath(datasetId: string, filename: string): Promise<string | null> {
  if (!IS_TAURI) return null
  return cmd<string | null>('get_download_path', { datasetId, filename })
}

/** Get total disk usage of all downloaded datasets. */
export async function getDownloadsSize(): Promise<number> {
  if (!IS_TAURI) return 0
  return cmd<number>('get_downloads_size')
}

/** Check if a download is currently in progress. */
export async function isDownloading(datasetId: string): Promise<boolean> {
  if (!IS_TAURI) return false
  return cmd<boolean>('is_downloading', { datasetId })
}

/** Listen for download progress events. Returns an unsubscribe function. */
export async function onDownloadProgress(handler: (progress: DownloadProgress) => void): Promise<() => void> {
  await tauriReady
  if (!listen) return () => {}
  return listen('download-progress', (e) => handler(e.payload as DownloadProgress))
}

/** Listen for download completion events. Returns an unsubscribe function. */
export async function onDownloadComplete(handler: (datasetId: string) => void): Promise<() => void> {
  await tauriReady
  if (!listen) return () => {}
  return listen('download-complete', (e) => handler(e.payload as string))
}

/** Listen for download error events. Returns an unsubscribe function. */
export async function onDownloadError(handler: (datasetId: string, error: string) => void): Promise<() => void> {
  await tauriReady
  if (!listen) return () => {}
  return listen('download-error', (e) => {
    const [id, err] = e.payload as [string, string]
    handler(id, err)
  })
}

/** Format bytes into a human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}

/**
 * Test-only surface. Exposes the pure helpers used by `resolveAssets`
 * / `downloadDataset` so unit tests call into the real implementation
 * rather than re-running the same logic inline (which would let
 * production drift silently). Don't import this outside `*.test.ts`.
 */
export const __test__ = {
  isHttpUrl,
  extFromUrl,
  pickBestVideoFile,
  orderImageCandidates,
  classifySourceOfTruth,
}
