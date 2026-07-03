/**
 * Generic RSS 2.0 / Atom → current-event mapper (pure).
 *
 * The second feed-connector kind (`docs/CURRENT_EVENTS_PLAN.md` §9) and
 * the one that powers bring-your-own-feed: point it at any RSS or Atom
 * URL and every item becomes a `POST /api/v1/publish/events` create
 * body — headline, summary, publish date, and the item link as the
 * cited source. Feeds that carry GeoRSS geometry (`georss:point`,
 * `geo:lat`/`geo:long` — USGS earthquakes, GDACS) get a real event
 * point; plain news feeds don't, which is exactly the gap the AI
 * date/location enrichment (slice C) backfills. Everything still lands
 * `proposed` behind the curator gate.
 *
 * Parsing is a small, tolerant, zero-dependency scan (the Workers
 * runtime has no DOMParser): extract `<item>`/`<entry>` blocks, then
 * read the handful of child tags we map. It intentionally handles the
 * overwhelmingly common well-formed-feed shapes rather than the full
 * XML grammar — a malformed item degrades to "skipped", never a throw.
 *
 * The `feedId` is the connector's registry id (not a hardcoded slug), so
 * two different RSS feeds can never collide on the `(feed_id,
 * external_id)` dedupe key.
 */

import type { EventCreateBody } from './eonet'

/** One parsed feed item — the subset of RSS/Atom we map. */
export interface RssItem {
  id: string
  title: string
  link: string
  summary?: string
  publishedAt?: string
  point?: { lat: number; lon: number }
  keywords?: string[]
  /** The item's lead image, when the feed syndicates one. */
  imageUrl?: string
}

/** Cap summaries so a full-article description doesn't bloat the row. */
const SUMMARY_MAX_CHARS = 500

/** Cap items mapped from one feed to the NEWEST 25 (feeds list newest
 *  first). A firehose feed can't flood the review queue, the tail of a
 *  first pull — old stories nobody will triage — never ingests at all,
 *  and one new feed's first page aligns exactly with the refresh
 *  route's per-run AI-enrichment budget, so a freshly added feed
 *  arrives fully enriched. The 6-hourly cron only misses items if a
 *  feed posts more than 25 between runs. */
export const RSS_MAX_ITEMS = 25

/** The HTML named entities that routinely appear in feed prose beyond
 *  XML's own five. Anything not listed decodes numerically or stays
 *  literal — cosmetic, never a correctness problem. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  deg: '°',
}

/** `String.fromCodePoint` throws on out-of-range values (> U+10FFFF) —
 *  a malformed numeric reference must stay literal text, never a throw
 *  (this module's contract is "skip bad input, don't fail the feed"). */
function safeCodePoint(code: number, literal: string): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return literal
  }
}

/** Decode the XML/HTML entities that actually occur in feeds
 *  (numeric + common named). `&amp;` decodes last so a double-escaped
 *  sequence doesn't cascade. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (whole, hex: string) => safeCodePoint(parseInt(hex, 16), whole))
    .replace(/&#(\d+);/g, (whole, dec: string) => safeCodePoint(parseInt(dec, 10), whole))
    .replace(/&([a-z]+);/g, (whole, name: string) => NAMED_ENTITIES[name] ?? whole)
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

/** Unwrap CDATA, strip markup, decode entities, collapse whitespace.
 *  Tags are stripped **twice** — once raw and once after decoding —
 *  because feeds carry markup both ways: raw HTML inside CDATA (RSS
 *  descriptions) and entity-escaped HTML (Atom `summary type="html"`).
 *  What's left is plain prose safe for an event row. */
function toPlainText(raw: string): string {
  const noCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  const decoded = decodeEntities(noCdata.replace(/<[^>]*>/g, ' '))
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Text content of the first `<tag>…</tag>` in `block` (namespace-prefix
 *  tolerant when `allowPrefix`), or undefined. */
function tagText(block: string, tag: string, allowPrefix = false): string | undefined {
  const name = allowPrefix ? `(?:[a-zA-Z0-9]+:)?${tag}` : tag
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? m[1] : undefined
}

/** Every text content of `<tag>…</tag>` occurrences in `block`. */
function tagTexts(block: string, tag: string): string[] {
  const out: string[] = []
  for (const m of block.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))) {
    out.push(m[1])
  }
  return out
}

/** An attribute value from the first matching self-closing-or-not tag. */
function tagAttr(block: string, tag: string, attr: string, opts: { requireRel?: string } = {}): string | undefined {
  for (const m of block.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, 'gi'))) {
    const attrs = m[1]
    if (opts.requireRel !== undefined) {
      const rel = attrs.match(/\brel\s*=\s*"([^"]*)"/i)?.[1]
      // Atom: a link with no rel IS the alternate link.
      if (rel !== undefined && rel !== opts.requireRel) continue
    }
    const value = attrs.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]
    if (value) return decodeEntities(value)
  }
  return undefined
}

/** Parse a GeoRSS point: `georss:point` ("lat lon"), or the
 *  `geo:lat` + `geo:long` W3C pair. */
function parsePoint(block: string): { lat: number; lon: number } | undefined {
  const georss = tagText(block, 'georss:point') ?? tagText(block, 'point', true)
  if (georss) {
    const parts = toPlainText(georss).split(/[\s,]+/).map(Number)
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      return { lat: parts[0], lon: parts[1] }
    }
  }
  // Presence is judged on the tag text, not the parsed number —
  // `Number('')` is 0, and (0, 0) is a real coordinate off West Africa.
  const latText = toPlainText(tagText(block, 'geo:lat') ?? '')
  const lonText = toPlainText(tagText(block, 'geo:long') ?? '')
  if (latText && lonText) {
    const lat = Number(latText)
    const lon = Number(lonText)
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon }
  }
  return undefined
}

/** A parseable date → ISO string, else undefined. Handles RFC 822
 *  (RSS `pubDate`) and ISO 8601 (Atom) via `Date.parse`. */
function toIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const ms = Date.parse(toPlainText(raw))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** True for the http(s) URLs the ingest layer accepts as a source. */
function isHttpUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url)
}

/**
 * The item's lead image, when the feed syndicates one. Checked in
 * preference order:
 *   1. `media:content` with an image `type`/`medium` (Media RSS — the
 *      richest form, used by most news feeds),
 *   2. `enclosure` with an image `type` (RSS 2.0 core),
 *   3. `media:thumbnail` (small, but better than nothing),
 *   4. Atom `link rel="enclosure"` with an image `type`.
 * http(s)-only; anything else is treated as "no image".
 */
function parseImageUrl(block: string): string | undefined {
  const isImage = (attrs: string): boolean => {
    const type = attrs.match(/\btype\s*=\s*"([^"]*)"/i)?.[1]
    const medium = attrs.match(/\bmedium\s*=\s*"([^"]*)"/i)?.[1]
    if (type) return /^image\//i.test(type)
    if (medium) return medium.toLowerCase() === 'image'
    return false
  }
  const candidates: Array<{ tag: string; attr: string; needImage: boolean; requireRel?: string }> = [
    { tag: '(?:[a-zA-Z0-9]+:)?content', attr: 'url', needImage: true },
    { tag: 'enclosure', attr: 'url', needImage: true },
    { tag: '(?:[a-zA-Z0-9]+:)?thumbnail', attr: 'url', needImage: false },
    { tag: 'link', attr: 'href', needImage: true, requireRel: 'enclosure' },
  ]
  for (const c of candidates) {
    for (const m of block.matchAll(new RegExp(`<${c.tag}\\s([^>]*?)/?>`, 'gi'))) {
      const attrs = m[1]
      if (c.requireRel) {
        const rel = attrs.match(/\brel\s*=\s*"([^"]*)"/i)?.[1]
        if (rel !== c.requireRel) continue
      }
      if (c.needImage && !isImage(attrs)) continue
      const value = attrs.match(new RegExp(`\\b${c.attr}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]
      const url = value ? decodeEntities(value) : undefined
      if (isHttpUrl(url)) return url
    }
  }
  return undefined
}

/** Parse one `<item>` (RSS 2.0) block. */
function parseRssItem(block: string): RssItem | null {
  const title = toPlainText(tagText(block, 'title') ?? '')
  const link = toPlainText(tagText(block, 'link') ?? '')
  if (!title || !isHttpUrl(link)) return null
  const guid = toPlainText(tagText(block, 'guid') ?? '') || link
  const summary = toPlainText(tagText(block, 'description') ?? '')
  const keywords = tagTexts(block, 'category').map(toPlainText).filter(Boolean)
  return {
    id: guid,
    title,
    link,
    summary: summary || undefined,
    publishedAt: toIso(tagText(block, 'pubDate')),
    point: parsePoint(block),
    keywords: keywords.length ? keywords : undefined,
    imageUrl: parseImageUrl(block),
  }
}

/** Parse one `<entry>` (Atom) block. */
function parseAtomEntry(block: string): RssItem | null {
  const title = toPlainText(tagText(block, 'title') ?? '')
  const link =
    tagAttr(block, 'link', 'href', { requireRel: 'alternate' }) ?? tagAttr(block, 'link', 'href')
  if (!title || !isHttpUrl(link)) return null
  const id = toPlainText(tagText(block, 'id') ?? '') || link
  const summary = toPlainText(tagText(block, 'summary') ?? tagText(block, 'content') ?? '')
  const keywords: string[] = []
  for (const m of block.matchAll(/<category\s[^>]*?\bterm\s*=\s*"([^"]*)"[^>]*?\/?>/gi)) {
    const term = decodeEntities(m[1]).trim()
    if (term) keywords.push(term)
  }
  return {
    id,
    title,
    link,
    summary: summary || undefined,
    publishedAt: toIso(tagText(block, 'published') ?? tagText(block, 'updated')),
    point: parsePoint(block),
    keywords: keywords.length ? keywords : undefined,
    imageUrl: parseImageUrl(block),
  }
}

/** Raw `<item>`/`<entry>` count in the document — how many items the
 *  feed carries *before* the mapper's skip rules and `RSS_MAX_ITEMS`
 *  cap, so callers can report an honest fetched-vs-mappable split
 *  (the RSS analogue of EONET's `feed.events.length`). */
export function countFeedItems(xml: string): number {
  if (typeof xml !== 'string' || xml.length === 0) return 0
  const rss = xml.match(/<item(?:\s[^>]*)?>/gi)?.length ?? 0
  if (rss > 0) return rss
  return xml.match(/<entry(?:\s[^>]*)?>/gi)?.length ?? 0
}

/** Parse an RSS 2.0 or Atom document into items. Unrecognisable
 *  documents (or ones with no items) parse to `[]`, never a throw. */
export function parseRssFeed(xml: string): RssItem[] {
  if (typeof xml !== 'string' || xml.length === 0) return []
  const items: RssItem[] = []
  const rssBlocks = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
  if (rssBlocks.length > 0) {
    for (const m of rssBlocks) {
      const item = parseRssItem(m[1])
      if (item) items.push(item)
    }
    return items
  }
  for (const m of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
    const item = parseAtomEntry(m[1])
    if (item) items.push(item)
  }
  return items
}

/**
 * Map a raw RSS/Atom document to event create bodies. `feedId` MUST be
 * the connector's registry id (unique per feed — the dedupe namespace);
 * `sourceName` is the connector's label, the provenance shown on every
 * cited card produced from this feed.
 */
export function mapRssFeed(
  xml: string,
  opts: { feedId: string; sourceName: string },
): EventCreateBody[] {
  return parseRssFeed(xml)
    .slice(0, RSS_MAX_ITEMS)
    .map(item => {
      const body: EventCreateBody = {
        title: item.title,
        source: { name: opts.sourceName, url: item.link, publishedAt: item.publishedAt },
        feedId: opts.feedId,
        externalId: item.id,
      }
      if (item.summary) body.summary = item.summary.slice(0, SUMMARY_MAX_CHARS)
      if (item.publishedAt) body.occurredStart = item.publishedAt
      if (item.point) body.geometry = { point: item.point }
      if (item.keywords) body.keywords = item.keywords
      if (item.imageUrl) body.imageUrl = item.imageUrl
      return body
    })
}
