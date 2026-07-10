/**
 * GET /api/v1/publish/media/youtube-search?q=… — agency-YouTube video
 * search for the Events-tab media-suggestion pane (task: media
 * suggestion engine).
 *
 * YouTube's Data API needs a key, and the key must stay server-side —
 * so, like the NHC storms proxy, the browser calls this same-origin
 * route instead.
 *
 * **Search WITHIN the allowlist, don't filter down to it.** The naive
 * shape — one global `search.list` for the query, then keep only the
 * results whose channel happens to be a vetted agency — almost never
 * yields anything: YouTube's relevance ranking fills the top of a
 * broad query with news orgs and random uploaders, so one of a handful
 * of specific agency channels essentially never lands in that window.
 * Instead we run one `channelId`-scoped `search.list` per allowlisted
 * channel (`youtube-channels.ts` defaults ∪ the node's custom
 * channels), so every hit is by construction from a reputable source,
 * then merge the per-channel results round-robin (channel diversity +
 * each channel's own relevance order) into `{ videos: [{ videoId,
 * title, channelId, channelName }] }`.
 *
 * The key is optional: absent `YOUTUBE_API_KEY` (or every upstream
 * request failing) degrades to `{ videos: [] }` — the source simply
 * offers no cards, never an error. Results are KV-cached by query so
 * re-opening the same event in the review queue doesn't re-spend
 * quota. Cost is now one `search.list` (100 units) PER searched
 * channel rather than one per event; see the quota note in
 * `docs/YOUTUBE_API_KEY.md`.
 *
 * Privileged-only — this exists for the curator review surface.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import {
  AGENCY_ALLOWLIST_SIGNATURE,
  AGENCY_YOUTUBE_CHANNELS,
  channelName,
  isAllowlistedChannel,
} from '../../_lib/youtube-channels'
import { disabledBuiltinChannelIds, listCustomChannels } from '../../_lib/youtube-channels-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const SEARCH_API = 'https://www.googleapis.com/youtube/v3/search'
const UPSTREAM_TIMEOUT_MS = 5_000
/** Per-channel page size. Each request is already scoped to one vetted
 *  channel, so a handful of its most-relevant videos for the query is
 *  plenty — we only ever surface `SHORTLIST` across all channels. */
const PER_CHANNEL_MAX_RESULTS = 5
const SHORTLIST = 4
/** Upper bound on channels searched per request — each is a 100-unit
 *  `search.list`, so this caps a single event's quota spend. Sized to
 *  cover the full built-in agency set (~18 channels) plus a couple of a
 *  node's own custom channels. Custom channels are searched first (a
 *  node adds them because they're its most relevant sources), then the
 *  built-in agency defaults in priority order; a node with more channels
 *  than this searches the highest-priority `MAX_CHANNELS_SEARCHED` and
 *  the niche tail is skipped. See the quota note in
 *  `docs/YOUTUBE_API_KEY.md`. */
const MAX_CHANNELS_SEARCHED = 20
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

/**
 * Interleave per-channel candidate lists round-robin — pure, exported
 * for tests. Taking one from each channel before a channel's second
 * gives channel diversity (no single agency dominates the shortlist)
 * while preserving each channel's own relevance order. Dedupes by
 * videoId (a video cross-posted to two allowlisted channels appears
 * once) and caps at `SHORTLIST`.
 */
export function mergeChannelCandidates(perChannel: VideoCandidate[][]): VideoCandidate[] {
  const merged: VideoCandidate[] = []
  const seen = new Set<string>()
  const maxLen = perChannel.reduce((m, list) => Math.max(m, list.length), 0)
  for (let round = 0; round < maxLen && merged.length < SHORTLIST; round++) {
    for (const list of perChannel) {
      if (round >= list.length) continue
      const cand = list[round]
      if (seen.has(cand.videoId)) continue
      seen.add(cand.videoId)
      merged.push(cand)
      if (merged.length >= SHORTLIST) break
    }
  }
  return merged
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

  // Effective allowlist = (hardcoded agency defaults minus the built-ins
  // this node has switched off) ∪ the node's own custom channels. Both
  // sets change the cache key, so a freshly-added channel's videos aren't
  // hidden by a stale entry and a just-disabled channel's stop appearing
  // at once. A missing/failed `youtube_channels*` table (e.g. an
  // un-migrated preview D1) degrades to defaults-only — never a 500.
  let custom: Awaited<ReturnType<typeof listCustomChannels>> = []
  let disabledBuiltins = new Set<string>()
  if (context.env.CATALOG_DB) {
    try {
      custom = await listCustomChannels(context.env.CATALOG_DB)
    } catch {
      // No custom table yet → just the hardcoded agency defaults.
    }
    try {
      disabledBuiltins = await disabledBuiltinChannelIds(context.env.CATALOG_DB)
    } catch {
      // No disable table yet → nothing is disabled.
    }
  }
  const customMap = new Map(custom.map(c => [c.channelId, c.channelName]))
  const allow: ChannelAllowlist = {
    has: id => !disabledBuiltins.has(id) && (isAllowlistedChannel(id) || customMap.has(id)),
    name: id => customMap.get(id) ?? channelName(id),
  }
  // Signature = the built-in allowlist + the node's custom ids + the
  // disabled built-in ids, hashed. Folding the built-in set in means
  // removing a channel from the hardcoded defaults invalidates its
  // previously-cached results at once; folding the disabled set in does
  // the same the moment a curator toggles a channel off or on.
  const signature = sigHash(
    `${AGENCY_ALLOWLIST_SIGNATURE}|${[...customMap.keys()].sort().join(',')}|off:${[...disabledBuiltins].sort().join(',')}`,
  )

  const cacheKey = cacheKeyFor(query, signature)
  if (context.env.CATALOG_KV) {
    try {
      const cached = await context.env.CATALOG_KV.get(cacheKey)
      if (cached) return ok(cached, 'HIT')
    } catch {
      // KV failure = cache miss.
    }
  }

  // The channels to fan out across: custom first (node-specific, most
  // relevant), then the built-in agency defaults, de-duped by id and
  // capped. One `channelId`-scoped search per channel.
  const apiKey = context.env.YOUTUBE_API_KEY
  const searchChannelIds: string[] = []
  const seenChannel = new Set<string>()
  for (const id of [...customMap.keys(), ...Object.keys(AGENCY_YOUTUBE_CHANNELS)]) {
    if (seenChannel.has(id) || disabledBuiltins.has(id)) continue
    seenChannel.add(id)
    searchChannelIds.push(id)
    if (searchChannelIds.length >= MAX_CHANNELS_SEARCHED) break
  }

  // One `search.list` per channel, scoped by `channelId`. Each request
  // gets its own timeout so a single slow channel can't sink the rest,
  // and any failure degrades to that channel contributing nothing.
  const searchChannel = async (channelId: string): Promise<{ ok: boolean; candidates: VideoCandidate[] }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      const params = new URLSearchParams({
        part: 'snippet',
        type: 'video',
        channelId,
        q: query,
        order: 'relevance',
        maxResults: String(PER_CHANNEL_MAX_RESULTS),
        safeSearch: 'strict',
        relevanceLanguage: 'en',
        key: apiKey,
      })
      const res = await fetch(`${SEARCH_API}?${params.toString()}`, { signal: controller.signal })
      if (!res.ok) return { ok: false, candidates: [] }
      return { ok: true, candidates: parseYoutubeSearch(await res.json(), allow) }
    } catch {
      // Timeout / network / parse — this channel contributes nothing.
      return { ok: false, candidates: [] }
    } finally {
      clearTimeout(timer)
    }
  }

  const settled = await Promise.all(searchChannelIds.map(searchChannel))
  // Cache only when at least one channel actually answered — a total
  // outage (every request failed/timed out) must not pin an empty list
  // for the whole TTL. An honest empty (channels answered, no video
  // matched the query) is cacheable.
  const upstreamOk = settled.some(s => s.ok)
  const videos = mergeChannelCandidates(settled.map(s => s.candidates))

  const body = JSON.stringify({ videos })
  if (upstreamOk && context.env.CATALOG_KV) {
    try {
      await context.env.CATALOG_KV.put(cacheKey, body, { expirationTtl: CACHE_TTL_SECONDS })
    } catch {
      // Best-effort cache fill.
    }
  }
  return ok(body, 'MISS')
}
