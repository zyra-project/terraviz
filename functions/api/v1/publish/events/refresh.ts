/**
 * POST /api/v1/publish/events/refresh — on-demand current-events
 * ingestion (`docs/CURRENT_EVENTS_PLAN.md` §9).
 *
 * The scheduled importer (`.github/workflows/import-events.yml`) pulls
 * on a cron; this route lets a curator pull *now* from the review queue.
 * It iterates the node's **enabled feed connectors** (the
 * `feed_connectors` registry, `feed-connectors-store.ts`): for each, it
 * fetches the feed, maps items to create bodies via the connector's
 * pure mapper, and runs the same idempotent upsert+match path
 * (`events-ingest.ts`). Every event still lands `proposed` — the
 * curator gate is unchanged.
 *
 * Connector dispatch is by `kind`: 'eonet' (the GeoJSON mapper in
 * `cli/lib/eonet.ts`) is the one implementation today; the generic RSS
 * connector lands next. A row whose kind this deployment doesn't know
 * is skipped with a recorded error rather than failing the run, so a
 * registry ahead of the code degrades gracefully.
 *
 * One connector's outage shouldn't hide another's events: fetch
 * failures are recorded per-connector (`recordFeedRun`) and the run
 * continues. The route only answers 502 when every enabled connector
 * failed to fetch — preserving the old single-feed behaviour.
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
import {
  listFeedConnectors,
  recordFeedRun,
  type FeedConnectorRow,
} from '../../_lib/feed-connectors-store'
import { mapEonetFeed, type EonetFeed, type EventCreateBody } from '../../../../../cli/lib/eonet'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Bound the per-request matcher loop — a global budget across all
 *  connectors. EONET's `days=14` window keeps the open-event count
 *  modest; this is a backstop, not the norm. */
const MAX_REFRESH_EVENTS = 100

/** Give up on a slow feed rather than hang the request. */
const FEED_TIMEOUT_MS = 10_000

/** Per-connector outcome reported in the response + run bookkeeping. */
interface ConnectorSummary {
  id: string
  kind: string
  label: string
  fetched: number
  mappable: number
  created: number
  refreshed: number
  failed: number
  error?: string
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

/**
 * Fetch + map one connector's feed into create bodies. Returns the raw
 * item count alongside the mapped bodies, or a human-readable error
 * string for the run bookkeeping. Dispatches on `kind` — the only place
 * connector implementations are enumerated.
 */
async function fetchAndMap(
  connector: FeedConnectorRow,
): Promise<{ ok: true; fetched: number; bodies: EventCreateBody[] } | { ok: false; error: string }> {
  if (connector.kind !== 'eonet') {
    return { ok: false, error: `unknown connector kind "${connector.kind}"` }
  }
  let feed: EonetFeed
  try {
    const res = await fetch(connector.url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })
    if (!res.ok) return { ok: false, error: `feed responded ${res.status}` }
    feed = (await res.json()) as EonetFeed
  } catch {
    return { ok: false, error: 'could not reach the feed' }
  }
  return {
    ok: true,
    fetched: Array.isArray(feed.events) ? feed.events.length : 0,
    bodies: mapEonetFeed(feed),
  }
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
  const connectors = await listFeedConnectors(db, { enabledOnly: true })
  const originNode = await resolveOriginNode(db)

  const feeds: ConnectorSummary[] = []
  let budget = MAX_REFRESH_EVENTS
  let anyFetched = false

  for (const connector of connectors) {
    const summary: ConnectorSummary = {
      id: connector.id,
      kind: connector.kind,
      label: connector.label,
      fetched: 0,
      mappable: 0,
      created: 0,
      refreshed: 0,
      failed: 0,
    }
    const result = await fetchAndMap(connector)
    if (!result.ok) {
      summary.error = result.error
      await recordFeedRun(db, connector.id, { status: 'error', error: result.error })
      feeds.push(summary)
      continue
    }
    anyFetched = true
    summary.fetched = result.fetched
    summary.mappable = result.bodies.length

    for (const body of result.bodies.slice(0, budget)) {
      const parsed = parseCreate(body)
      if (!parsed.ok) {
        summary.failed++
        continue
      }
      try {
        const outcome = await ingestEvent(db, { ...parsed.value, originNode })
        if (outcome.created) summary.created++
        else summary.refreshed++
      } catch {
        summary.failed++
      }
    }
    budget -= Math.min(summary.mappable, budget)
    await recordFeedRun(db, connector.id, { status: 'ok' })
    feeds.push(summary)
  }

  // Preserve the old single-feed contract: a total feed outage is a 502
  // the UI explains, not a silent all-zeros success. (No enabled
  // connectors at all is a legitimate configuration → 200 with zeros.)
  if (connectors.length > 0 && !anyFetched) {
    return jsonError(502, 'feed_unavailable', 'Could not reach any enabled events feed.')
  }

  const totals = feeds.reduce(
    (acc, f) => ({
      fetched: acc.fetched + f.fetched,
      mappable: acc.mappable + f.mappable,
      created: acc.created + f.created,
      refreshed: acc.refreshed + f.refreshed,
      failed: acc.failed + f.failed,
    }),
    { fetched: 0, mappable: 0, created: 0, refreshed: 0, failed: 0 },
  )
  const summary = { ...totals, feeds }

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
