/**
 * Reputable-channel allowlist for the agency-YouTube media source
 * (task: media suggestion engine).
 *
 * The suggestion engine's "reputable sources" promise means a YouTube
 * search result is only ever offered when it comes from a vetted
 * agency channel. This is the allowlist that enforces it: the
 * `youtube-search` proxy keeps a `search.list` result only when its
 * `channelId` is a key here.
 *
 * **Curated, not exhaustive, and meant to be extended.** These are
 * top-level science-agency channels verified by channel ID (not name
 * — names can be spoofed, IDs can't). A node covering a different
 * subject, or wanting a specific NOAA/NWS sub-channel, adds its
 * verified `UC…` id here. Find a channel's id from its channel page
 * source (`"externalId":"UC…"`) or `youtube.com/channel/UC…` URL.
 *
 * Empty-allowlist behaviour: if this object is emptied, the proxy
 * returns no videos — the source stays off rather than surfacing
 * unvetted content.
 */

/** channelId → human-readable channel name (for the card + audit). */
export const AGENCY_YOUTUBE_CHANNELS: Readonly<Record<string, string>> = {
  // Keys are channel ids — quoted because some contain a hyphen.
  'UCLA_DiR1FfKNvjuUpBHmylQ': 'NASA',
  'UCeXH8GZyV3sVqAr45AvupOA': 'USGS',
  'UC012BUr9u82skTv9bOfmG4w': 'NOAA Education',
  'UCxK2oekvetMp6zPSTWN63_g': 'NOAA Central Library',
  'UC-pHprdRFZMZNegDaZKFB9g': 'NOAA AOML',
  'UCroWPW0Wg6zZPyt42N89P7g': 'NOAA National Ocean Service',
  'UCtC03FBKVTbM_OM3WQB-Hng': 'NOAA Sanctuaries',
}

/** True when `channelId` is a vetted agency channel. */
export function isAllowlistedChannel(channelId: string | null | undefined): boolean {
  return typeof channelId === 'string' && channelId in AGENCY_YOUTUBE_CHANNELS
}

/**
 * A stable signature of the built-in allowlist. Folded into the search
 * cache key so that editing this set (adding OR removing a channel)
 * invalidates previously-cached results immediately — a removed channel
 * can't keep being served from a stale cache entry until its TTL
 * expires, which would weaken the reputability gate.
 */
export const AGENCY_ALLOWLIST_SIGNATURE = Object.keys(AGENCY_YOUTUBE_CHANNELS).sort().join(',')

/** The vetted channel's display name, or null when not allowlisted. */
export function channelName(channelId: string | null | undefined): string | null {
  return typeof channelId === 'string' ? (AGENCY_YOUTUBE_CHANNELS[channelId] ?? null) : null
}

/**
 * The one embed-URL shape a curator video pick may take: the
 * privacy-enhanced `https://www.youtube-nocookie.com/embed/{videoId}`
 * form. Enforced on write (the review route) AND on read
 * (`toPublicEvent`) — this value becomes an iframe src, so nothing but
 * our own source's output may pass. A frame-refusing watch page or a
 * third-party host is rejected.
 */
export function isNocookieEmbedUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  return (
    u.protocol === 'https:' &&
    u.hostname === 'www.youtube-nocookie.com' &&
    /^\/embed\/[\w-]{6,20}$/.test(u.pathname)
  )
}

/** Build the canonical nocookie embed URL from a bare YouTube video id. */
export function nocookieEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}`
}
