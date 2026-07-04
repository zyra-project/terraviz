/**
 * Media suggestions for the Events tab (task: media suggestion
 * engine) — candidate builders the detail pane renders as a
 * "Suggested media" card row.
 *
 * Sources:
 * - **NASA Worldview snapshots** (pure) — the Worldview Snapshots API
 *   renders real satellite imagery for a bounding box and date as a
 *   plain image URL (keyless, public domain, no fetch needed to
 *   *suggest*; the URL itself is the image). Every located, dated
 *   event gets a "what the satellite saw there, that day" candidate.
 * - **Wikimedia Commons nearby photos** (fetched) — the Commons
 *   geosearch API (keyless, CORS `origin=*`) finds freely-licensed
 *   photos near the event location. Kept ONLY when the license is
 *   public domain / CC0: the stored `image_url` carries no
 *   attribution field, so images with attribution obligations
 *   (CC BY / BY-SA) are never suggested.
 *
 * Curator-picked by design: nothing here writes anything. The pane's
 * "Use as event image" posts the chosen URL through the review
 * endpoint's `edits`, where it lands on `current_events.image_url`
 * and flows into generated tours like any vetted story image.
 */

import type { EventGeometry } from './events-model'

export interface MediaSuggestion {
  /** Provenance tier — drives the badge + alt text. */
  kind: 'worldview' | 'commons'
  /** The image URL itself. */
  url: string
  /** Attribution shown on the card and stored in curator memory —
   *  both sources are public domain but credit is good manners. */
  attribution: string
}

/** Daily global true-color — available for any date since 2000 and
 *  the closest thing to "what you'd have seen from space". */
export const WORLDVIEW_SNAPSHOT_LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor'

const SNAPSHOT_HOST = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot'
const SNAPSHOT_WIDTH = 768
/** Padding around a point event, degrees — wide enough for context
 *  (a hurricane, a fire complex), tight enough to still be "there". */
const POINT_PAD_DEG = 5
/** Minimum bbox span, degrees — a very tight bbox snapshots to noise. */
const MIN_SPAN_DEG = 2

const clampLat = (v: number): number => Math.max(-90, Math.min(90, v))
const clampLon = (v: number): number => Math.max(-180, Math.min(180, v))

/** Widen `[lo, hi]` to at least `span`, sliding the window to stay
 *  inside `[boundLo, boundHi]` rather than clamping each edge
 *  independently — a degenerate box at a pole or the dateline still
 *  comes out full-span (the bounds are ≥ 180° wide, span is 2°). */
const growSpan = (
  lo: number,
  hi: number,
  span: number,
  boundLo: number,
  boundHi: number,
): [number, number] => {
  if (hi - lo >= span) return [lo, hi]
  const mid = (lo + hi) / 2
  let nextLo = mid - span / 2
  let nextHi = mid + span / 2
  if (nextLo < boundLo) {
    nextHi += boundLo - nextLo
    nextLo = boundLo
  }
  if (nextHi > boundHi) {
    nextLo -= nextHi - boundHi
    nextHi = boundHi
  }
  return [Math.max(boundLo, nextLo), Math.min(boundHi, nextHi)]
}

/**
 * Build the Worldview snapshot candidate for an event, or null when
 * the event lacks what a snapshot needs (a date and a location).
 */
export function buildWorldviewSnapshot(event: {
  occurredStart?: string
  source?: { publishedAt?: string }
  geometry?: EventGeometry
}): MediaSuggestion | null {
  const rawDate = event.occurredStart ?? event.source?.publishedAt
  const ms = rawDate ? Date.parse(rawDate) : NaN
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms).toISOString().slice(0, 10)

  let n: number, s: number, w: number, e: number
  const bbox = event.geometry?.boundingBox
  const point = event.geometry?.point
  if (bbox) {
    n = clampLat(bbox.n)
    s = clampLat(bbox.s)
    w = clampLon(bbox.w)
    e = clampLon(bbox.e)
    // The catalog encodes an antimeridian-crossing box as w > e
    // ("170°E east through 180° to -160°" — see catalogMap.ts). The
    // snapshot API wants a plain min<max range, so keep the wider of
    // the two dateline halves — most of the event area, always valid.
    if (w > e) {
      if (180 - w >= e + 180) e = 180
      else w = -180
    }
    // Grow degenerate boxes to a visible span around their centre.
    ;[s, n] = growSpan(s, n, MIN_SPAN_DEG, -90, 90)
    ;[w, e] = growSpan(w, e, MIN_SPAN_DEG, -180, 180)
  } else if (point) {
    n = clampLat(point.lat + POINT_PAD_DEG)
    s = clampLat(point.lat - POINT_PAD_DEG)
    w = clampLon(point.lon - POINT_PAD_DEG)
    e = clampLon(point.lon + POINT_PAD_DEG)
  } else {
    // Region-only events resolve to a bbox at ingest; an event with
    // neither has nowhere to point a snapshot.
    return null
  }
  if (n <= s || e <= w) return null

  const height = Math.max(
    192,
    Math.min(SNAPSHOT_WIDTH, Math.round((SNAPSHOT_WIDTH * (n - s)) / (e - w))),
  )
  const params = new URLSearchParams({
    REQUEST: 'GetSnapshot',
    TIME: date,
    // EPSG:4326 axis order: lat_min, lon_min, lat_max, lon_max.
    BBOX: `${s},${w},${n},${e}`,
    CRS: 'EPSG:4326',
    LAYERS: WORLDVIEW_SNAPSHOT_LAYER,
    WIDTH: String(SNAPSHOT_WIDTH),
    HEIGHT: String(height),
    FORMAT: 'image/jpeg',
  })
  return {
    kind: 'worldview',
    url: `${SNAPSHOT_HOST}?${params.toString()}`,
    attribution: 'NASA Worldview / GIBS', // i18n-exempt: proper noun attribution
  }
}

// ---------------------------------------------------------------------------
// Wikimedia Commons nearby photos
// ---------------------------------------------------------------------------

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php'
/** geosearch's maximum radius (metres). Photos are of the *place*, so
 *  this only makes sense for localized events anyway. */
const COMMONS_RADIUS_M = 10_000
/** How many candidates to surface — the pane is a shortlist, not a
 *  gallery. geosearch returns nearest-first, so these are the closest. */
const COMMONS_LIMIT = 3
/** Preview/stored rendition width. Commons thumb URLs are stable. */
const COMMONS_THUMB_WIDTH = 1024
export const COMMONS_TIMEOUT_MS = 5_000

/** Event location for the photo search: the pin when there is one,
 *  else the bbox centre (antimeridian-aware — a w > e box wraps). */
function locationFor(geometry: EventGeometry | undefined): { lat: number; lon: number } | null {
  // Clamp both paths — an out-of-range stored point would otherwise
  // build an invalid ggscoord and silently drop the suggestions.
  if (geometry?.point) {
    return { lat: clampLat(geometry.point.lat), lon: clampLon(geometry.point.lon) }
  }
  const bbox = geometry?.boundingBox
  if (!bbox) return null
  const lat = clampLat((bbox.n + bbox.s) / 2)
  const w = clampLon(bbox.w)
  const e = clampLon(bbox.e)
  const span = w > e ? e + 360 - w : e - w
  let lon = w + span / 2
  if (lon > 180) lon -= 360
  return { lat, lon }
}

/** The geosearch query URL for a point — pure, exported for tests. */
export function buildCommonsQueryUrl(point: { lat: number; lon: number }): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*', // anonymous CORS
    generator: 'geosearch',
    ggscoord: `${point.lat}|${point.lon}`,
    ggsradius: String(COMMONS_RADIUS_M),
    ggslimit: '20',
    ggsnamespace: '6', // File:
    prop: 'imageinfo',
    iiprop: 'url|mime|extmetadata',
    iiurlwidth: String(COMMONS_THUMB_WIDTH),
  })
  return `${COMMONS_API}?${params.toString()}`
}

interface CommonsImageInfo {
  url?: string
  thumburl?: string
  mime?: string
  extmetadata?: Record<string, { value?: unknown }>
}

interface CommonsPage {
  /** Generator result order — `pages` is keyed by pageid, which does
   *  NOT preserve geosearch's nearest-first ordering; `index` does. */
  index?: number
  imageinfo?: CommonsImageInfo[]
}

/** No attribution obligation: the stored image_url can't carry one. */
const FREE_LICENSE_RE = /public domain|cc0/i

/**
 * Map a Commons API response to suggestions — pure, exported for
 * tests. Keeps only raster images under a public-domain/CC0 license,
 * nearest-first (sorted by the generator `index`, since the `pages`
 * object is pageid-keyed), capped to the shortlist size. The sized
 * thumb rendition is REQUIRED — the full-size original can be tens of
 * megabytes and must never become the stored/previewed URL.
 */
export function parseCommonsResponse(json: unknown): MediaSuggestion[] {
  const pages = (json as { query?: { pages?: Record<string, CommonsPage> } })?.query?.pages
  if (!pages || typeof pages !== 'object') return []
  const ordered = Object.values(pages).sort(
    (a, b) => (a?.index ?? Number.MAX_SAFE_INTEGER) - (b?.index ?? Number.MAX_SAFE_INTEGER),
  )
  const out: MediaSuggestion[] = []
  for (const page of ordered) {
    const info = page?.imageinfo?.[0]
    if (!info) continue
    if (typeof info.mime !== 'string' || !info.mime.startsWith('image/')) continue
    const license = info.extmetadata?.LicenseShortName?.value
    if (typeof license !== 'string' || !FREE_LICENSE_RE.test(license)) continue
    const url = info.thumburl
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 2048) continue
    out.push({
      kind: 'commons',
      url,
      attribution: 'Wikimedia Commons', // i18n-exempt: proper noun attribution
    })
    if (out.length >= COMMONS_LIMIT) break
  }
  return out
}

/**
 * Fetch nearby public-domain photos for an event. Every failure path
 * — no location, timeout, HTTP error, malformed body — is an empty
 * list; the pane simply shows fewer cards.
 */
export async function fetchCommonsSuggestions(
  event: { geometry?: EventGeometry },
  fetchFn: typeof fetch = fetch,
): Promise<MediaSuggestion[]> {
  const point = locationFor(event.geometry)
  if (!point) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), COMMONS_TIMEOUT_MS)
  try {
    const res = await fetchFn(buildCommonsQueryUrl(point), { signal: controller.signal })
    if (!res.ok) return []
    return parseCommonsResponse(await res.json())
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
