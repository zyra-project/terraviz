/**
 * GET /api/v1/publish/feeds/preview — dry-run a feed URL
 * (`docs/CURRENT_EVENTS_PLAN.md` §9).
 *
 * `?url=&kind=` → fetch the feed once, run it through the same pure
 * mapper the refresh route uses (`mapEonetFeed` / `mapRssFeed`), and
 * return the first few mapped items (title, published time, link).
 * Nothing is written: no connector row, no events, no audit — this is
 * how an operator sees what a preset or a pasted URL would actually
 * ingest before adding it. The browser can't fetch feeds directly
 * (CORS), which is why this proxies server-side.
 *
 * Privileged-only (admin / service), same gate as the registry CRUD.
 * Static `preview` segment, so Pages routes it ahead of the sibling
 * `[id]` connector handler.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import {
  FEED_CONNECTOR_KINDS,
  feedRequestHeaders,
  type FeedConnectorKind,
} from '../../_lib/feed-connectors-store'
import { mapEonetFeed, type EonetFeed, type EventCreateBody } from '../../../../../cli/lib/eonet'
import { countFeedItems, mapRssFeed } from '../../../../../cli/lib/rss'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Enough to convey the feed's flavour without echoing the whole thing. */
export const PREVIEW_MAX_ITEMS = 5

/** Give up on a slow feed rather than hang the request. */
const FEED_TIMEOUT_MS = 10_000

/** One preview row — the operator-facing gist of a mapped item. */
export interface FeedPreviewItem {
  title: string
  publishedAt: string | null
  url: string
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Reduce a mapped create body to the preview row shape. */
export function toPreviewItem(body: EventCreateBody): FeedPreviewItem {
  return {
    title: body.title,
    publishedAt: body.source.publishedAt ?? body.occurredStart ?? null,
    url: body.source.url,
  }
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Previewing feeds is restricted to admin and service callers.')
  }

  const params = new URL(context.request.url).searchParams
  const kind = (params.get('kind') ?? '').trim()
  const url = (params.get('url') ?? '').trim()
  if (!(FEED_CONNECTOR_KINDS as readonly string[]).includes(kind)) {
    return jsonError(400, 'invalid_kind', `\`kind\` must be one of: ${FEED_CONNECTOR_KINDS.join(', ')}.`)
  }
  if (!url || !isHttpUrl(url)) {
    return jsonError(400, 'invalid_url', '`url` must be an http(s) URL.')
  }

  let bodies: EventCreateBody[]
  let fetched: number
  if ((kind as FeedConnectorKind) === 'eonet') {
    let feed: EonetFeed
    try {
      const res = await fetch(url, {
        headers: feedRequestHeaders('eonet'),
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      })
      if (!res.ok) return jsonError(502, 'feed_unavailable', `The feed responded ${res.status}.`)
      feed = (await res.json()) as EonetFeed
    } catch {
      return jsonError(502, 'feed_unavailable', 'Could not reach the feed.')
    }
    fetched = Array.isArray(feed.events) ? feed.events.length : 0
    bodies = mapEonetFeed(feed)
  } else {
    let xml: string
    try {
      // Real news CDNs content-negotiate: a bare Workers fetch (no UA,
      // no Accept) gets 406'd by e.g. The Guardian. Honest bot headers.
      const res = await fetch(url, {
        headers: feedRequestHeaders('rss'),
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      })
      if (!res.ok) return jsonError(502, 'feed_unavailable', `The feed responded ${res.status}.`)
      xml = await res.text()
    } catch {
      return jsonError(502, 'feed_unavailable', 'Could not reach the feed.')
    }
    // Synthetic identifiers — a preview never persists, so the feed id /
    // source name only shape the mapped bodies we discard afterwards.
    const sourceName = new URL(url).hostname
    bodies = mapRssFeed(xml, { feedId: 'preview', sourceName })
    // Raw item count, so fetched vs mappable shows skips + the cap.
    fetched = countFeedItems(xml)
  }

  return new Response(
    JSON.stringify({
      fetched,
      mappable: bodies.length,
      items: bodies.slice(0, PREVIEW_MAX_ITEMS).map(toPreviewItem),
    }),
    { status: 200, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' } },
  )
}
