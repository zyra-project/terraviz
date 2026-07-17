/**
 * Generic Google Video Sitemap → normalized video parser (pure).
 *
 * The media-suggestion counterpart of `rss.ts`: point it at any
 * standard Video Sitemap (`http://www.google.com/schemas/sitemap-video/1.1`,
 * the `video:` namespace) and every `<url>` entry becomes a
 * {@link SitemapVideo} — a self-hosted video the curator can attach to
 * an event or blog. Unlike the RSS path (which produces *events*), this
 * feeds the "suggested media" engine: title + description + tags are the
 * semantic signal a story is matched against; `contentUrl` is the direct
 * media file a companion tour plays natively.
 *
 * It is deliberately source-agnostic — NOAA's Ocean Today sitemap is the
 * first consumer, but any agency video sitemap drops in. The per-source
 * host of `contentUrl` is surfaced ({@link SitemapVideo.contentHost}) so
 * the refresh job can derive the media-proxy / native-`<video>` host
 * allowlist from exactly what an operator registered.
 *
 * Parsing is the same small, tolerant, zero-dependency scan `rss.ts`
 * uses (the Workers runtime has no DOMParser): pull each `<url>` block,
 * read the handful of `<video:*>` children we map, and sanitize. Real
 * sitemaps carry dirty strings — the Ocean Today feed wraps every
 * `<video:content_loc>` in a stray trailing quote and doubles slashes in
 * thumbnails — so every field is defensively cleaned rather than trusted.
 * A malformed entry degrades to "skipped", never a throw.
 *
 * Sitemap-index documents (a `<sitemapindex>` of child `<loc>`s) are a
 * fetch-time concern, not a parse-time one: {@link isSitemapIndex} lets
 * the refresh job detect and expand them; this pure parser only reads
 * `<urlset>` video entries.
 */

/** One normalized video from a sitemap `<url>` entry. */
export interface SitemapVideo {
  /** Stable dedupe key within a source — the entry's page `<loc>`
   *  (unique per video across a well-formed sitemap). */
  externalId: string
  /** The video's landing page — the citation/source link shown on the
   *  suggestion card and stored as provenance. */
  pageUrl: string
  title: string
  description: string
  /** Filtered topical tags: junk (bare years, title echoes, dupes)
   *  removed. May be empty. */
  tags: string[]
  /** The `<video:category>` value, when present and not a generic
   *  catch-all. Absent for the ~86% of Ocean Today entries whose
   *  category is just "Ocean". */
  category?: string
  /** Direct media file URL (sanitized, http(s) only). */
  contentUrl: string
  /** Lowercased host of {@link contentUrl} — the unit the media-proxy /
   *  native-video host allowlist is built from. */
  contentHost: string
  /** Preview thumbnail (sanitized, http(s) only), when present. */
  thumbnailUrl?: string
  /** Runtime in whole seconds, when present and valid. */
  durationSec?: number
  /** Publication date as an ISO string, when parseable. */
  publishedAt?: string
}

/** Cap descriptions so a long synopsis can't bloat an index row. */
const DESCRIPTION_MAX_CHARS = 1000
/** Cap tags kept per video — a shortlist of topical keywords, not the
 *  full (often redundant) tag list. */
const MAX_TAGS = 12

/** HTML named entities beyond XML's five that occur in sitemap prose. */
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
  amp: '&',
}

/** `String.fromCodePoint` throws on out-of-range values — a malformed
 *  reference must stay literal, never a throw. */
function safeCodePoint(code: number, literal: string): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return literal
  }
}

/** Decode the XML/HTML entities that occur in sitemaps (numeric +
 *  common named). `&amp;` decodes last so a double-escaped sequence
 *  doesn't cascade. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (whole, hex: string) => safeCodePoint(parseInt(hex, 16), whole))
    .replace(/&#(\d+);/g, (whole, dec: string) => safeCodePoint(parseInt(dec, 10), whole))
    .replace(/&(?!amp;)([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

/** Unwrap CDATA, strip markup, decode entities, collapse whitespace. */
function toPlainText(raw: string): string {
  const noCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  const decoded = decodeEntities(noCdata.replace(/<[^>]*>/g, ' '))
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Text content of the first `<video:tag>…</video:tag>` in `block`. */
function videoText(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<video:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</video:${tag}>`, 'i'))
  return m ? m[1] : undefined
}

/** Every text content of a repeated `<video:tag>` in `block`. */
function videoTexts(block: string, tag: string): string[] {
  const out: string[] = []
  for (const m of block.matchAll(new RegExp(`<video:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</video:${tag}>`, 'gi'))) {
    out.push(m[1])
  }
  return out
}

/** Sanitize a URL string from a sitemap: unwrap CDATA, decode entities,
 *  strip surrounding whitespace and stray quotes (the Ocean Today feed
 *  suffixes every `content_loc` with a `"`), collapse accidental
 *  path-double-slashes, and accept only http(s). Returns the parsed URL
 *  or null. */
function sanitizeUrl(raw: string | undefined): URL | null {
  if (!raw) return null
  let text = toPlainText(raw)
  // Strip any surrounding single/double quotes left in the markup.
  text = text.replace(/^["'\s]+|["'\s]+$/g, '')
  if (!text) return null
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // Collapse doubled path slashes (`…noaa.gov//blueiq/…`) — cosmetic,
  // but keeps the stored URL clean and dedupe-stable. The authority's
  // `//` is untouched (pathname never includes it).
  u.pathname = u.pathname.replace(/\/{2,}/g, '/')
  return u
}

/** A date-only or full timestamp → ISO string, else undefined. */
function toIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const text = toPlainText(raw)
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** Generic category values that carry no topical signal — dropped so
 *  the index doesn't treat "Ocean" (86% of the Ocean Today feed) or a
 *  bare "News" as a discriminating facet. */
const GENERIC_CATEGORIES = new Set(['ocean', 'news', 'video', 'videos', 'general', 'other'])

/**
 * Clean the tag list for one entry: plain-text each tag, drop empties,
 * bare years/numbers (`2011`, `101`), and any tag that merely echoes the
 * title; dedupe case-insensitively (first spelling wins) and cap to
 * {@link MAX_TAGS}. What survives is a shortlist of topical keywords —
 * the semantic signal, not the feed's redundant bookkeeping tags.
 */
function cleanTags(rawTags: string[], title: string): string[] {
  const titleKey = title.toLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of rawTags) {
    const tag = toPlainText(raw)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (key === titleKey) continue // echoes the title — no added signal
    if (/^\d{1,4}$/.test(tag)) continue // bare year / number
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/** Parse one `<url>` block into a normalized video, or null when it
 *  lacks the minimum a suggestion needs (a page URL, a title, and a
 *  fetchable content URL). */
function parseUrlEntry(block: string): SitemapVideo | null {
  const page = sanitizeUrl(tagLoc(block))
  if (!page) return null

  // The video metadata lives inside <video:video>; scope reads to it so
  // a stray sibling tag can't leak in. Fall back to the whole block if
  // the wrapper is absent (tolerant of minor shape drift).
  const inner = block.match(/<video:video(?:\s[^>]*)?>([\s\S]*?)<\/video:video>/i)?.[1] ?? block

  const title = toPlainText(videoText(inner, 'title') ?? '')
  const content = sanitizeUrl(videoText(inner, 'content_loc'))
  if (!title || !content) return null

  const description = toPlainText(videoText(inner, 'description') ?? '').slice(0, DESCRIPTION_MAX_CHARS)
  const tags = cleanTags(videoTexts(inner, 'tag'), title)

  const categoryRaw = toPlainText(videoText(inner, 'category') ?? '')
  const category = categoryRaw && !GENERIC_CATEGORIES.has(categoryRaw.toLowerCase()) ? categoryRaw : undefined

  const thumbnail = sanitizeUrl(videoText(inner, 'thumbnail_loc'))

  const durationText = toPlainText(videoText(inner, 'duration') ?? '')
  const durationNum = durationText ? Number.parseInt(durationText, 10) : NaN
  const durationSec = Number.isFinite(durationNum) && durationNum > 0 ? durationNum : undefined

  const publishedAt = toIso(videoText(inner, 'publication_date'))

  const video: SitemapVideo = {
    externalId: page.toString(),
    pageUrl: page.toString(),
    title,
    description,
    tags,
    contentUrl: content.toString(),
    contentHost: content.hostname.toLowerCase(),
  }
  if (category) video.category = category
  if (thumbnail) video.thumbnailUrl = thumbnail.toString()
  if (durationSec !== undefined) video.durationSec = durationSec
  if (publishedAt) video.publishedAt = publishedAt
  return video
}

/** Text of the entry's own `<loc>` (the sibling of `<video:video>`),
 *  not any `<video:*>` loc. Matched non-greedily and anchored to the
 *  first `<loc>` so it reads the page URL, not a nested one. */
function tagLoc(block: string): string | undefined {
  const m = block.match(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/i)
  return m ? m[1] : undefined
}

/** True when the document is a `<sitemapindex>` (a list of child
 *  sitemaps) rather than a `<urlset>` of entries — the refresh job
 *  expands these; this pure parser does not fetch. */
export function isSitemapIndex(xml: string): boolean {
  return typeof xml === 'string' && /<sitemapindex[\s>]/i.test(xml)
}

/** Child sitemap URLs from a `<sitemapindex>` document (http(s) only) —
 *  for the refresh job to fetch and parse in turn. Empty for a plain
 *  `<urlset>`. */
export function parseSitemapIndex(xml: string): string[] {
  if (typeof xml !== 'string' || !isSitemapIndex(xml)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of xml.matchAll(/<sitemap(?:\s[^>]*)?>([\s\S]*?)<\/sitemap>/gi)) {
    const url = sanitizeUrl(tagLoc(m[1]))
    if (url && !seen.has(url.toString())) {
      seen.add(url.toString())
      out.push(url.toString())
    }
  }
  return out
}

/** Raw `<url>` entry count in the document — how many entries the
 *  sitemap carries before the parser's skip rules, so callers can report
 *  an honest fetched-vs-mappable split. */
export function countSitemapEntries(xml: string): number {
  if (typeof xml !== 'string' || xml.length === 0) return 0
  return xml.match(/<url(?:\s[^>]*)?>/gi)?.length ?? 0
}

/**
 * Parse a Video Sitemap document into normalized videos. Deduped on the
 * page URL (a sitemap can legitimately repeat, and the index upsert keys
 * on `externalId`). A non-video `<urlset>`, a `<sitemapindex>`, or an
 * unrecognisable document parses to `[]`, never a throw.
 */
export function parseVideoSitemap(xml: string): SitemapVideo[] {
  if (typeof xml !== 'string' || xml.length === 0) return []
  if (isSitemapIndex(xml)) return []
  const out: SitemapVideo[] = []
  const seen = new Set<string>()
  for (const m of xml.matchAll(/<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/gi)) {
    const video = parseUrlEntry(m[1])
    if (video && !seen.has(video.externalId)) {
      seen.add(video.externalId)
      out.push(video)
    }
  }
  return out
}

/**
 * The canonical text to embed for a video's semantic signal — title,
 * description, category and tags joined into one blob, mirroring the
 * event-side `buildEventEmbeddingText`. Same embedding space as datasets
 * and events, so the cosine between a story and a topically-relevant
 * video is high. Returns `''` when there's nothing to embed.
 */
export function buildVideoEmbeddingText(video: {
  title?: string
  description?: string
  category?: string
  tags?: readonly string[]
}): string {
  return [
    video.title ?? '',
    video.description ?? '',
    video.category ?? '',
    (video.tags ?? []).join(' '),
  ]
    .map(s => s.trim())
    .filter(Boolean)
    .join('\n')
}
