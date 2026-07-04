/**
 * Operator-configurable agency-YouTube channels (task: media
 * suggestion engine — YouTube source).
 *
 * D1 access for the per-node channel allowlist (`youtube_channels`,
 * migration 0035) plus the pasted-URL → canonical-channel-id
 * resolution. The hardcoded curated set lives in `youtube-channels.ts`
 * (pure, no DB); this module adds the node's own vetted channels on
 * top. The search proxy merges both at filter time.
 *
 * Resolution: a `/channel/UC…` URL carries the id directly (no API
 * call); a `@handle`, `/c/name`, or `/user/name` URL is resolved via
 * the YouTube Data API's `channels.list` (1 quota unit) using the
 * server-side key. The stored key is always the canonical `UC…` id.
 */

const CHANNELS_API = 'https://www.googleapis.com/youtube/v3/channels'
const RESOLVE_TIMEOUT_MS = 5_000

/** A stored custom channel (public/camelCase shape). */
export interface CustomYoutubeChannel {
  channelId: string
  channelName: string
  createdAt: string
}

interface CustomChannelRow {
  channel_id: string
  channel_name: string
  created_at: string
}

/** List the node's custom channels, newest first. */
export async function listCustomChannels(db: D1Database): Promise<CustomYoutubeChannel[]> {
  const res = await db
    .prepare('SELECT channel_id, channel_name, created_at FROM youtube_channels ORDER BY created_at DESC')
    .all<CustomChannelRow>()
  return (res.results ?? []).map(r => ({
    channelId: r.channel_id,
    channelName: r.channel_name,
    createdAt: r.created_at,
  }))
}

/** The set of custom channel ids — merged with the hardcoded defaults
 *  by the search proxy to form the effective allowlist. */
export async function customChannelIds(db: D1Database): Promise<Set<string>> {
  const res = await db.prepare('SELECT channel_id FROM youtube_channels').all<{ channel_id: string }>()
  return new Set((res.results ?? []).map(r => r.channel_id))
}

/** A custom channel's stored display name, or null. */
export async function customChannelName(db: D1Database, channelId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT channel_name FROM youtube_channels WHERE channel_id = ?')
    .bind(channelId)
    .first<{ channel_name: string }>()
  return row?.channel_name ?? null
}

/** Insert (or refresh the name of) a custom channel. */
export async function addCustomChannel(
  db: D1Database,
  channel: { channelId: string; channelName: string; addedBy: string | null },
  now: string = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO youtube_channels (channel_id, channel_name, added_by, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET channel_name = excluded.channel_name`,
    )
    .bind(channel.channelId, channel.channelName, channel.addedBy, now)
    .run()
}

/** Remove a custom channel. Returns true when a row was deleted. */
export async function removeCustomChannel(db: D1Database, channelId: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM youtube_channels WHERE channel_id = ?').bind(channelId).run()
  return (res.meta?.changes ?? 0) > 0
}

/** A canonical channel id shape (`UC` + 22 url-safe chars). */
export function isChannelId(value: string): boolean {
  return /^UC[\w-]{22}$/.test(value)
}

/** What a URL resolves to, or why it failed. */
export type ChannelResolution =
  | { ok: true; channelId: string; channelName: string }
  | { ok: false; code: 'invalid_url' | 'unresolved' | 'unconfigured' }

/**
 * Resolve a pasted YouTube channel URL to its canonical id + title.
 *
 * `/channel/UC…` carries the id directly. `@handle`, `/c/name`,
 * `/user/name` (and a bare `@handle`) are resolved through
 * `channels.list` with the server-side key. Returns `unconfigured`
 * when a handle/name URL needs the API but no key is set.
 */
export async function resolveChannelUrl(
  raw: string,
  apiKey: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<ChannelResolution> {
  const parsed = parseChannelUrl(raw)
  if (!parsed) return { ok: false, code: 'invalid_url' }

  // Direct id — still fetch the title for display, but the id is known.
  const lookup: { forId?: string; forHandle?: string; forUsername?: string } =
    parsed.kind === 'id'
      ? { forId: parsed.value }
      : parsed.kind === 'handle'
        ? { forHandle: parsed.value }
        : { forUsername: parsed.value }

  if (!apiKey) {
    // Without the key we can still accept a direct-id URL (no lookup
    // needed); a handle/name URL can't be resolved.
    if (parsed.kind === 'id') return { ok: true, channelId: parsed.value, channelName: parsed.value }
    return { ok: false, code: 'unconfigured' }
  }

  const params = new URLSearchParams({ part: 'id,snippet', key: apiKey })
  if (lookup.forId) params.set('id', lookup.forId)
  if (lookup.forHandle) params.set('forHandle', lookup.forHandle)
  if (lookup.forUsername) params.set('forUsername', lookup.forUsername)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
  try {
    const res = await fetchFn(`${CHANNELS_API}?${params.toString()}`, { signal: controller.signal })
    if (!res.ok) {
      // A direct-id URL is still usable even if the title fetch fails.
      if (parsed.kind === 'id') return { ok: true, channelId: parsed.value, channelName: parsed.value }
      return { ok: false, code: 'unresolved' }
    }
    const item = (await res.json() as { items?: Array<{ id?: unknown; snippet?: { title?: unknown } }> })?.items?.[0]
    const id = typeof item?.id === 'string' && isChannelId(item.id) ? item.id : null
    const title = typeof item?.snippet?.title === 'string' ? item.snippet.title : null
    if (!id) {
      if (parsed.kind === 'id') return { ok: true, channelId: parsed.value, channelName: parsed.value }
      return { ok: false, code: 'unresolved' }
    }
    return { ok: true, channelId: id, channelName: title ?? id }
  } catch {
    if (parsed.kind === 'id') return { ok: true, channelId: parsed.value, channelName: parsed.value }
    return { ok: false, code: 'unresolved' }
  } finally {
    clearTimeout(timer)
  }
}

type ParsedChannelUrl =
  | { kind: 'id'; value: string }
  | { kind: 'handle'; value: string }
  | { kind: 'user'; value: string }

/**
 * Pull the channel selector out of a pasted URL (or a bare `@handle`) —
 * pure, exported for tests. Accepts youtube.com / m.youtube.com /
 * youtube-nocookie.com and youtu.be; rejects any other host.
 */
export function parseChannelUrl(raw: string): ParsedChannelUrl | null {
  const trimmed = raw.trim()
  // A bare handle (`@NASA`) is a common paste.
  if (/^@[\w.-]{2,60}$/.test(trimmed)) return { kind: 'handle', value: trimmed }

  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null

  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length === 0) return null
  // /@handle
  if (parts[0].startsWith('@')) {
    return /^@[\w.-]{2,60}$/.test(parts[0]) ? { kind: 'handle', value: parts[0] } : null
  }
  // /channel/UC…
  if (parts[0] === 'channel' && parts[1]) {
    return isChannelId(parts[1]) ? { kind: 'id', value: parts[1] } : null
  }
  // /c/CustomName  and  /user/Username — both resolve via forUsername
  // (the legacy custom-URL forms; forUsername covers the common case).
  if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) {
    return /^[\w.-]{2,60}$/.test(parts[1]) ? { kind: 'user', value: parts[1] } : null
  }
  return null
}
