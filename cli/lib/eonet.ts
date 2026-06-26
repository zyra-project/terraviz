/**
 * NASA EONET → current-event mapper (pure).
 *
 * EONET (Earth Observatory Natural Event Tracker) is an openly-licensed,
 * curated feed of natural events (storms, wildfires, volcanoes, icebergs)
 * tagged with geometry + time + category — the closest fit to SOS
 * datasets and the first connector for the current-events ingestion path
 * (`docs/CURRENT_EVENTS_PLAN.md` §9). This module is the pure mapping
 * from an EONET v3 `events` payload to the `POST /api/v1/publish/events`
 * create bodies; the network fetch + posting live in
 * `cli/import-events.ts`.
 *
 * Source-agnostic backend, node-configurable connector: EONET is *one*
 * example connector wired for an Earth-science node. The event shape it
 * produces carries only generic provenance + a `feed_id` of `eonet`.
 */

export const EONET_FEED_ID = 'eonet'
export const EONET_SOURCE_NAME = 'NASA EONET'

/** Default EONET v3 endpoint — open events from the last 14 days. */
export const EONET_DEFAULT_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=14'

/** A raw EONET event (the subset we read). */
export interface EonetEvent {
  id?: unknown
  title?: unknown
  description?: unknown
  link?: unknown
  categories?: Array<{ id?: unknown; title?: unknown }>
  sources?: Array<{ id?: unknown; url?: unknown }>
  geometry?: Array<{ date?: unknown; type?: unknown; coordinates?: unknown }>
}

export interface EonetFeed {
  events?: EonetEvent[]
}

/** A `POST /api/v1/publish/events` create body. */
export interface EventCreateBody {
  title: string
  summary?: string
  source: { name: string; url: string; publishedAt?: string }
  feedId: string
  externalId: string
  occurredStart?: string
  occurredEnd?: string
  geometry?: {
    boundingBox?: { n: number; s: number; w: number; e: number }
    point?: { lat: number; lon: number }
  }
  categories?: Record<string, string[]>
  keywords?: string[]
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Recursively collect `[lon, lat]` pairs from an EONET coordinates
 *  value (Point → one pair; Polygon → nested rings). */
function collectLonLat(coords: unknown, out: Array<[number, number]>): void {
  if (!Array.isArray(coords)) return
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    out.push([coords[0], coords[1]])
    return
  }
  for (const c of coords) collectLonLat(c, out)
}

/** Map one EONET geometry entry to event geometry (point for a single
 *  coordinate, bounding box for a polygon). */
function toGeometry(coordinates: unknown): EventCreateBody['geometry'] | undefined {
  const pairs: Array<[number, number]> = []
  collectLonLat(coordinates, pairs)
  if (pairs.length === 0) return undefined
  if (pairs.length === 1) {
    const [lon, lat] = pairs[0]
    return { point: { lat, lon } }
  }
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity
  for (const [lon, lat] of pairs) {
    if (lon < w) w = lon
    if (lon > e) e = lon
    if (lat < s) s = lat
    if (lat > n) n = lat
  }
  return { boundingBox: { n, s, w, e } }
}

/** Domains whose pages are public + human-readable. EONET frequently
 *  cites internal/auth-walled systems instead — IRWIN (`irwin.doi.gov`,
 *  most wildfires) and JTWC (`metoc.navy.mil`, storms) — which read as
 *  dead links to the public; those fall through to a Worldview imagery
 *  link. Matched as the exact host or a true subdomain (see
 *  `hostIsPublic`). */
const PUBLIC_SOURCE_HOSTS = [
  'noaa.gov',
  'usgs.gov',
  'si.edu', // Smithsonian — SIVolcano (volcano.si.edu)
  'gdacs.org',
  'pdc.org',
  'inciweb.nwcg.gov',
  'inciweb.wildfire.gov',
]

/** Exact host or a true subdomain of an allowlisted domain. The `.${h}`
 *  guard means `nhc.noaa.gov` matches `noaa.gov` but `evilgdacs.org`
 *  does NOT match `gdacs.org`. */
function hostIsPublic(host: string): boolean {
  return PUBLIC_SOURCE_HOSTS.some(h => host === h || host.endsWith(`.${h}`))
}

/** First **http(s)** source URL whose host is public + human-readable,
 *  else undefined. The protocol guard matters: the ingest layer rejects a
 *  non-http(s) `source.url`, so returning an `ftp:`/`mailto:` URL from an
 *  allowlisted host would drop the event instead of falling back to the
 *  Worldview link. */
function pickPublicSourceUrl(sources: EonetEvent['sources']): string | undefined {
  for (const s of sources ?? []) {
    const url = asStr(s?.url)
    if (!url) continue
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    if (hostIsPublic(parsed.hostname.toLowerCase())) return url
  }
  return undefined
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/** A public NASA Worldview deep-link framed on the event's location +
 *  date — the satellite imagery that *is* the event, used when no public
 *  source page exists. Always derivable from the (required) geometry, so
 *  every event gets a usable public link. */
function buildWorldviewUrl(geometry: EventCreateBody['geometry'], dateIso: string | undefined): string {
  let w = -180, s = -90, e = 180, n = 90
  if (geometry?.boundingBox) {
    ;({ w, s, e, n } = geometry.boundingBox)
  } else if (geometry?.point) {
    const PAD = 10
    w = geometry.point.lon - PAD
    e = geometry.point.lon + PAD
    s = geometry.point.lat - PAD
    n = geometry.point.lat + PAD
  }
  const v = [
    round1(clamp(w, -180, 180)),
    round1(clamp(s, -90, 90)),
    round1(clamp(e, -180, 180)),
    round1(clamp(n, -90, 90)),
  ].join(',')
  const date = dateIso ? dateIso.slice(0, 10) : undefined
  const query = date ? `v=${v}&t=${date}` : `v=${v}`
  return `https://worldview.earthdata.nasa.gov/?${query}`
}

function fmtLat(lat: number): string {
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`
}
function fmtLon(lon: number): string {
  return `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`
}

/** "near 43.0°N, 114.7°W" from a point or bbox centre, or "". */
function describeLocation(geometry: EventCreateBody['geometry']): string {
  let lat: number | undefined, lon: number | undefined
  if (geometry?.point) {
    lat = geometry.point.lat
    lon = geometry.point.lon
  } else if (geometry?.boundingBox) {
    lat = (geometry.boundingBox.n + geometry.boundingBox.s) / 2
    lon = (geometry.boundingBox.w + geometry.boundingBox.e) / 2
  }
  if (lat === undefined || lon === undefined) return ''
  return `near ${fmtLat(lat)}, ${fmtLon(lon)}`
}

/**
 * Synthesize a readable summary. EONET descriptions are empty ~80% of
 * the time, so compose category + location + time framing from the
 * structured fields every event carries; keep any real description as
 * the lede. This is what makes a card understandable when its source
 * link is an auth-walled registry.
 */
function buildSummary(
  raw: EonetEvent,
  geometry: EventCreateBody['geometry'],
  occurredStart: string | undefined,
  occurredEnd: string | undefined,
): string | undefined {
  const category = asStr(raw.categories?.[0]?.title)
  const location = describeLocation(geometry)
  const head = [category, location].filter(Boolean).join(' ')

  const start = occurredStart?.slice(0, 10)
  const end = occurredEnd?.slice(0, 10)
  let when = ''
  if (start) when = end && end !== start ? `Observed ${start} through ${end}.` : `First observed ${start}.`

  const synthesized = [head ? `${head}.` : '', when].filter(Boolean).join(' ').trim()

  const description = asStr(raw.description)
  if (description) {
    const lede = /[.!?]$/.test(description) ? description : `${description}.`
    return [lede, synthesized].filter(Boolean).join(' ').trim() || undefined
  }
  return synthesized || undefined
}

/**
 * Map a single EONET event to a create body, or null when it lacks the
 * minimum we need (a stable id, a title, and at least one geometry with
 * coordinates). The latest geometry entry drives the location + time.
 * The citation prefers a public source page, falling back to a public
 * NASA Worldview imagery link; the summary is synthesized from the
 * structured fields so the card is legible even when the source is an
 * auth-walled registry.
 */
export function mapEonetEvent(raw: EonetEvent): EventCreateBody | null {
  const externalId = asStr(raw.id)
  const title = asStr(raw.title)
  if (!externalId || !title) return null

  const geoms = Array.isArray(raw.geometry) ? raw.geometry : []
  if (geoms.length === 0) return null
  const latest = geoms[geoms.length - 1]
  const geometry = toGeometry(latest?.coordinates)
  if (!geometry) return null

  const dates = geoms.map(g => asStr(g.date)).filter((d): d is string => !!d)
  const occurredStart = dates[0]
  const occurredEnd = dates.length > 1 ? dates[dates.length - 1] : undefined
  const latestDate = dates[dates.length - 1] ?? occurredStart

  // Prefer a public, human-readable source page; otherwise link to the
  // public NASA Worldview imagery for this place + date. Geometry is
  // already required, so a usable public link is always derivable —
  // events are no longer dropped for lacking a citable source.
  const sourceUrl = pickPublicSourceUrl(raw.sources) ?? buildWorldviewUrl(geometry, latestDate)

  const catTitles = (raw.categories ?? []).map(c => asStr(c.title)).filter((t): t is string => !!t)
  const catIds = (raw.categories ?? []).map(c => asStr(c.id)).filter((t): t is string => !!t)

  const body: EventCreateBody = {
    title,
    source: { name: EONET_SOURCE_NAME, url: sourceUrl },
    feedId: EONET_FEED_ID,
    externalId,
    geometry,
  }
  const summary = buildSummary(raw, geometry, occurredStart, occurredEnd)
  if (summary) body.summary = summary
  if (occurredStart) {
    body.occurredStart = occurredStart
    body.source.publishedAt = occurredStart
  }
  if (occurredEnd) body.occurredEnd = occurredEnd
  if (catTitles.length) body.categories = { EONET: catTitles }
  if (catIds.length) body.keywords = catIds
  return body
}

/** Map an EONET feed to create bodies, dropping events we can't map. */
export function mapEonetFeed(feed: EonetFeed): EventCreateBody[] {
  const events = Array.isArray(feed.events) ? feed.events : []
  return events.map(mapEonetEvent).filter((b): b is EventCreateBody => b !== null)
}
