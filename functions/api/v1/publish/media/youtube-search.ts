/**
 * GET /api/v1/publish/media/youtube-search?q=… — agency-YouTube video
 * search for the Events-tab media-suggestion pane (task: media
 * suggestion engine).
 *
 * YouTube's Data API needs a key, and the key must stay server-side —
 * so, like the NHC storms proxy, the browser calls this same-origin
 * route instead. It runs one `search.list` for the caller's query,
 * keeps ONLY results whose channel is on the vetted agency allowlist
 * (`youtube-channels.ts` — the "reputable sources" gate), and returns
 * the trimmed candidates as `{ videos: [{ videoId, title, channelId,
 * channelName }] }`.
 *
 * The key is optional: absent `YOUTUBE_API_KEY` (or any upstream
 * failure) degrades to `{ videos: [] }` — the source simply offers no
 * cards, never an error. Results are KV-cached by query so re-opening
 * the same event in the review queue doesn't re-spend quota
 * (search.list is 100 units; see `docs/YOUTUBE_API_KEY.md`).
 *
 * Privileged-only — this exists for the curator review surface.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { AGENCY_ALLOWLIST_SIGNATURE, channelName, isAllowlistedChannel } from '../../_lib/youtube-channels'
import { listCustomChannels } from '../../_lib/youtube-channels-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const SEARCH_API = 'https://www.googleapis.com/youtube/v3/search'
const UPSTREAM_TIMEOUT_MS = 5_000
/** search.list pulls a page; we filter to the allowlist and keep a
 *  shortlist. 25 is one page — enough to surface a few agency hits. */
const SEARCH_MAX_RESULTS = 25
const SHORTLIST = 4
const CACHE_TTL_SECONDS = 60 * 60 // an event's news doesn't change hourly
/** Bound the query so a pathological title can't build a huge request. */
const MAX_QUERY_CHARS = 200

interface VideoCandidate {
  videoId: string
  title: string
  channelId: string
  channelName: string
}

function ok(body: string, xCache: 'HIT' | 'MISS'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store', 'X-Cache': xCache },
  })
}

/** Compact, stable hash of the allowlist signature (FNV-1a → 8 hex) so
 *  a long channel-id list can't crowd the query out of the length-capped
 *  cache key. Changes whenever the allowlist changes. */
function sigHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Stable cache key from the query — lowercased, whitespace-collapsed,
 *  URI-encoded so a KV key can't be oversized or contain odd bytes. The
 *  `signature` is a hash of the effective allowlist (built-in defaults +
 *  the node's custom channels), so any allowlist change — including
 *  editing the built-in set — invalidates stale entries immediately. */
function cacheKeyFor(query: string, signature: string): string {
  const q = query.toLowerCase().replace(/\s+/g, ' ').trim()
  return `yt-search:v1:${encodeURIComponent(`${signature}|${q}`).slice(0, 400)}`
}

interface YtSearchItem {
  id?: { videoId?: unknown }
  snippet?: { title?: unknown; channelId?: unknown }
}

/** The effective allowlist a search is filtered against: the hardcoded
 *  agency defaults plus the node's custom channels. */
export interface ChannelAllowlist {
  has(channelId: string): boolean
  name(channelId: string): string | null
}

/** The hardcoded-only allowlist (no custom channels) — the default. */
const DEFAULT_ALLOWLIST: ChannelAllowlist = {
  has: isAllowlistedChannel,
  name: channelName,
}

/** Map + allowlist-filter a search.list body — pure, exported for
 *  tests. Filters against `allow` (defaults ∪ node custom channels). */
export function parseYoutubeSearch(json: unknown, allow: ChannelAllowlist = DEFAULT_ALLOWLIST): VideoCandidate[] {
  const items = (json as { items?: YtSearchItem[] })?.items
  if (!Array.isArray(items)) return []
  const out: VideoCandidate[] = []
  for (const item of items) {
    const videoId = item?.id?.videoId
    const channelId = item?.snippet?.channelId
    const title = item?.snippet?.title
    if (typeof videoId !== 'string' || !/^[\w-]{6,20}$/.test(videoId)) continue
    if (typeof channelId !== 'string' || !allow.has(channelId)) continue
    out.push({
      videoId,
      title: typeof title === 'string' ? title : '',
      channelId,
      channelName: allow.name(channelId) ?? '',
    })
    if (out.length >= SHORTLIST) break
  }
  return out
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return new Response(
      JSON.stringify({ error: 'forbidden_role', message: 'The media proxy is restricted to admin and service callers.' }),
      { status: 403, headers: { 'Content-Type': CONTENT_TYPE } },
    )
  }

  const query = (new URL(context.request.url).searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS)
  // No query, or no key configured → the source is simply off.
  if (!query || !context.env.YOUTUBE_API_KEY) {
    return ok(JSON.stringify({ videos: [] }), 'MISS')
  }

  // Effective allowlist = hardcoded agency defaults ∪ the node's own
  // custom channels. A change to the custom set changes the cache key,
  // so a freshly-added channel's videos aren't hidden by a stale entry.
  // A missing/failed `youtube_channels` table (e.g. an un-migrated
  // preview D1) degrades to defaults-only — the source must never 500.
  let custom: Awaited<ReturnType<typeof listCustomChannels>> = []
  if (context.env.CATALOG_DB) {
    try {
      custom = await listCustomChannels(context.env.CATALOG_DB)
    } catch {
      // No custom table yet → just the hardcoded agency defaults.
    }
  }
  const customMap = new Map(custom.map(c => [c.channelId, c.channelName]))
  const allow: ChannelAllowlist = {
    has: id => isAllowlistedChannel(id) || customMap.has(id),
    name: id => customMap.get(id) ?? channelName(id),
  }
  // Signature = the built-in allowlist + the node's custom ids, hashed.
  // Folding the built-in set in means removing a channel from the
  // hardcoded defaults invalidates its previously-cached results at once
  // rather than serving them until TTL expiry.
  const signature = sigHash(`${AGENCY_ALLOWLIST_SIGNATURE}|${[...customMap.keys()].sort().join(',')}`)

  const cacheKey = cacheKeyFor(query, signature)
  if (context.env.CATALOG_KV) {
    try {
      const cached = await context.env.CATALOG_KV.get(cacheKey)
      if (cached) return ok(cached, 'HIT')
    } catch {
      // KV failure = cache miss.
    }
  }

  let videos: VideoCandidate[] = []
  let upstreamOk = false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      q: query,
      maxResults: String(SEARCH_MAX_RESULTS),
      safeSearch: 'strict',
      relevanceLanguage: 'en',
      key: context.env.YOUTUBE_API_KEY,
    })
    const res = await fetch(`${SEARCH_API}?${params.toString()}`, { signal: controller.signal })
    if (res.ok) {
      upstreamOk = true
      videos = parseYoutubeSearch(await res.json(), allow)
    }
  } catch {
    // Timeout / network / parse — degrade to an empty list.
  } finally {
    clearTimeout(timer)
  }

  const body = JSON.stringify({ videos })
  // Cache only real upstream answers — an outage or quota-exceeded
  // response must not pin an empty list for the whole TTL.
  if (upstreamOk && context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(cacheKey, body, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // Best-effort cache fill.
    }
  }
  return ok(body, 'MISS')
}
