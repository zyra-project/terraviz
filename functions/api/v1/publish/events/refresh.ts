/**
 * POST /api/v1/publish/events/refresh — on-demand current-events
 * ingestion (`docs/CURRENT_EVENTS_PLAN.md` §9).
 *
 * The scheduled importer (`.github/workflows/import-events.yml`) pulls
 * the feed every 6 hours; this route lets a curator pull it *now* from
 * the review queue instead of waiting for the next cron tick. It does
 * server-side what the CLI importer does: fetch the node's configured
 * feed, map each item to a create body via the shared pure mapper, and
 * run the same idempotent upsert+match path (`events-ingest.ts`). Every
 * event still lands `proposed` — the curator gate is unchanged.
 *
 * Source-agnostic backend, node-configurable connector: NASA EONET is
 * the one connector wired for this Earth-science node (mirroring the
 * CLI). A node covering a different subject would wire a different feed.
 * The EONET specifics are quarantined to the imported pure mapper; the
 * upsert/validation core (`events-ingest.ts`) stays feed-agnostic.
 *
 * Privileged-only (admin / service). Static `refresh` segment, so Pages
 * routes it ahead of the sibling `[id]` review-submit handler.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { writeAuditEvent } from '../../_lib/audit-store'
import { parseCreate, resolveOriginNode, ingestEvent } from '../../_lib/events-ingest'
import { bustFeaturedEventCache } from '../../_lib/events-store'
import { mapEonetFeed, EONET_DEFAULT_URL, EONET_FEED_ID, type EonetFeed } from '../../../../../cli/lib/eonet'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Bound the per-request matcher loop. EONET's `days=14` window keeps
 *  the open-event count modest; this is a backstop, not the norm. */
const MAX_REFRESH_EVENTS = 100

/** Give up on a slow feed rather than hang the request. */
const FEED_TIMEOUT_MS = 10_000

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Refreshing events is restricted to admin and service callers.')
  }

  const db = context.env.CATALOG_DB

  // Fetch the node's configured feed (EONET). A feed outage shouldn't
  // read as a server bug — surface it as a 502 the UI can explain.
  let feed: EonetFeed
  try {
    const res = await fetch(EONET_DEFAULT_URL, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })
    if (!res.ok) return jsonError(502, 'feed_unavailable', `The events feed responded ${res.status}.`)
    feed = (await res.json()) as EonetFeed
  } catch {
    return jsonError(502, 'feed_unavailable', 'Could not reach the events feed.')
  }

  const fetched = Array.isArray(feed.events) ? feed.events.length : 0
  const mapped = mapEonetFeed(feed)
  const bodies = mapped.slice(0, MAX_REFRESH_EVENTS)

  const originNode = await resolveOriginNode(db)
  let created = 0
  let refreshed = 0
  let failed = 0
  for (const body of bodies) {
    const parsed = parseCreate(body)
    if (!parsed.ok) {
      failed++
      continue
    }
    try {
      const outcome = await ingestEvent(db, { ...parsed.value, originNode })
      if (outcome.created) created++
      else refreshed++
    } catch {
      failed++
    }
  }

  const summary = { feed: EONET_FEED_ID, fetched, mappable: mapped.length, created, refreshed, failed }

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'event.refreshed',
    subject_kind: 'event',
    subject_id: null,
    metadata_json: JSON.stringify(summary),
  })

  // A refresh of an already-approved event can change what the hero
  // surfaces (e.g. a fresher published_at), so bust the public cache.
  await bustFeaturedEventCache(context.env.CATALOG_KV)

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
