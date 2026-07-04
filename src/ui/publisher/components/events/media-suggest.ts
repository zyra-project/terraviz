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
  kind: 'worldview' | 'commons' | 'shakemap' | 'nhc'
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

// ---------------------------------------------------------------------------
// USGS ShakeMaps (earthquake events)
// ---------------------------------------------------------------------------

const USGS_QUERY_API = 'https://earthquake.usgs.gov/fdsnws/event/1/query'
/** Only ever follow detail links back to the same host we queried. */
const USGS_HOST = 'earthquake.usgs.gov'
/** Search window around the event date — quakes are instants; the
 *  slack absorbs timezone fuzz in AI-inferred dates. */
const USGS_WINDOW_DAYS = 2
const USGS_RADIUS_KM = 300
const USGS_MIN_MAGNITUDE = 4
export const USGS_TIMEOUT_MS = 5_000

/** Does this event read like an earthquake? Cheap text gate so a
 *  wildfire near a coincidental quake never gets a ShakeMap card. */
export function looksLikeQuake(event: { title?: string; summary?: string; keywords?: string[] }): boolean {
  const text = `${event.title ?? ''} ${event.summary ?? ''} ${(event.keywords ?? []).join(' ')}`
  return /\b(earthquake|quake|seismic|tremor|aftershock)\b/i.test(text)
}

/** The FDSN event query for "the largest shakemapped quake near this
 *  place around this date" — pure, exported for tests. */
export function buildUsgsQueryUrl(point: { lat: number; lon: number }, dateIso: string): string {
  const ms = Date.parse(dateIso)
  const day = 24 * 60 * 60 * 1000
  const params = new URLSearchParams({
    format: 'geojson',
    starttime: new Date(ms - USGS_WINDOW_DAYS * day).toISOString().slice(0, 10),
    endtime: new Date(ms + USGS_WINDOW_DAYS * day).toISOString().slice(0, 10),
    latitude: String(clampLat(point.lat)),
    longitude: String(clampLon(point.lon)),
    maxradiuskm: String(USGS_RADIUS_KM),
    minmagnitude: String(USGS_MIN_MAGNITUDE),
    producttype: 'shakemap',
    orderby: 'magnitude',
    limit: '1',
  })
  return `${USGS_QUERY_API}?${params.toString()}`
}

/** Pull the matched quake's detail-feed URL out of the query response
 *  — pure, exported for tests. Only same-host http(s) URLs pass. */
export function parseUsgsQuery(json: unknown): string | null {
  const detail = (json as { features?: Array<{ properties?: { detail?: unknown } }> })
    ?.features?.[0]?.properties?.detail
  if (typeof detail !== 'string') return null
  try {
    const u = new URL(detail)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname === USGS_HOST ? detail : null
  } catch {
    return null
  }
}

/** Pull the ShakeMap intensity image out of the detail feed
 *  (`products.shakemap[0].contents["download/intensity.jpg"].url`) —
 *  pure, exported for tests. */
export function parseShakemapDetail(json: unknown): string | null {
  const contents = (json as {
    properties?: { products?: { shakemap?: Array<{ contents?: Record<string, { url?: unknown }> }> } }
  })?.properties?.products?.shakemap?.[0]?.contents
  const url = contents?.['download/intensity.jpg']?.url ?? contents?.['download/intensity.png']?.url
  return typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= 2048 ? url : null
}

/**
 * Fetch the ShakeMap intensity-map candidate for an earthquake event:
 * query the FDSN event API (keyless, CORS-enabled) for the largest
 * shakemapped quake near the event's place and date, then read the
 * intensity image from its detail feed. Two bounded fetches; every
 * failure path — not a quake, no location/date, no match, timeout —
 * is null.
 */
export async function fetchShakemapSuggestion(
  event: { title?: string; summary?: string; keywords?: string[]; occurredStart?: string; source?: { publishedAt?: string }; geometry?: EventGeometry },
  fetchFn: typeof fetch = fetch,
): Promise<MediaSuggestion | null> {
  if (!looksLikeQuake(event)) return null
  const point = locationFor(event.geometry)
  const rawDate = event.occurredStart ?? event.source?.publishedAt
  if (!point || !rawDate || !Number.isFinite(Date.parse(rawDate))) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), USGS_TIMEOUT_MS)
  try {
    const res = await fetchFn(buildUsgsQueryUrl(point, rawDate), { signal: controller.signal })
    if (!res.ok) return null
    const detailUrl = parseUsgsQuery(await res.json())
    if (!detailUrl) return null
    const detail = await fetchFn(detailUrl, { signal: controller.signal })
    if (!detail.ok) return null
    const url = parseShakemapDetail(await detail.json())
    if (!url) return null
    return {
      kind: 'shakemap',
      url,
      attribution: 'USGS ShakeMap', // i18n-exempt: proper noun attribution
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// NHC forecast cones (tropical-cyclone events)
// ---------------------------------------------------------------------------

/** Same-origin proxy over NHC's CurrentStorms.json — nhc.noaa.gov
 *  serves no CORS headers, so the browser can't fetch it directly. */
export const NHC_STORMS_ENDPOINT = '/api/v1/publish/media/nhc-storms'
export const NHC_TIMEOUT_MS = 5_000

/** Does this event read like a tropical cyclone? */
export function looksLikeTropical(event: { title?: string; summary?: string; keywords?: string[] }): boolean {
  const text = `${event.title ?? ''} ${event.summary ?? ''} ${(event.keywords ?? []).join(' ')}`
  return /\b(hurricane|typhoon|cyclone|tropical\s+(storm|depression))\b/i.test(text)
}

/** The public 5-day forecast-cone graphic for an active storm id
 *  (`al062023` → `storm_graphics/AT06/AL062023_…_sm2.png`) — pure,
 *  exported for tests. Null for a malformed id. If NHC retires the
 *  graphic (storm dissipated), the card's preview 404s and the card
 *  removes itself — same degradation as every other source. */
export function buildNhcConeUrl(stormId: string): string | null {
  const m = stormId.match(/^(al|ep|cp)(\d{2})(\d{4})$/i)
  if (!m) return null
  const dir = ({ al: 'AT', ep: 'EP', cp: 'CP' } as const)[m[1].toLowerCase() as 'al' | 'ep' | 'cp']
  return `https://www.nhc.noaa.gov/storm_graphics/${dir}${m[2]}/${stormId.toUpperCase()}_5day_cone_with_line_and_wind_sm2.png`
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Fetch the forecast-cone candidate for a tropical-cyclone event:
 * read the active-storms list through the same-origin proxy and match
 * a storm whose NAME appears as a word in the event title ("Hurricane
 * Delta strengthens" ↔ "Delta"). Null when the event isn't tropical,
 * nothing is active, or no name matches.
 */
export async function fetchNhcConeSuggestion(
  event: { title?: string; summary?: string; keywords?: string[] },
  fetchFn: typeof fetch = fetch,
): Promise<MediaSuggestion | null> {
  if (!looksLikeTropical(event)) return null
  const title = event.title ?? ''
  if (!title) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NHC_TIMEOUT_MS)
  try {
    const res = await fetchFn(NHC_STORMS_ENDPOINT, { signal: controller.signal })
    if (!res.ok) return null
    const { activeStorms } = (await res.json()) as { activeStorms?: Array<{ id?: unknown; name?: unknown }> }
    if (!Array.isArray(activeStorms)) return null
    for (const storm of activeStorms) {
      if (typeof storm?.id !== 'string' || typeof storm?.name !== 'string') continue
      if (storm.name.length < 3) continue // "Two"-style numerals stay, single letters don't false-match
      if (!new RegExp(`\\b${escapeRe(storm.name)}\\b`, 'i').test(title)) continue
      const url = buildNhcConeUrl(storm.id)
      if (!url) continue
      return {
        kind: 'nhc',
        url,
        attribution: 'NOAA / National Hurricane Center', // i18n-exempt: proper noun attribution
      }
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
