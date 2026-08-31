// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * POST /api/v1/publish/media/video-sources/refresh — index every enabled
 * video source now (task: video-sitemap media source). The on-demand
 * counterpart of the scheduled indexer (`.github/workflows/refresh-video-sources.yml`):
 * a curator (or the cron's service token) pulls the latest videos into
 * `video_index` immediately.
 *
 * Iterates the enabled `video_sources`, runs the shared
 * `refreshVideoSource` engine over each (fetch → parse → embed changed →
 * upsert → prune), and records per-source run bookkeeping. One source's
 * outage is recorded and the run continues; the route answers 200 with a
 * per-source summary. A shared embedding budget across the whole request
 * caps a first-pull's model calls.
 *
 * Privileged-only (admin / service). Static `refresh` segment so Pages
 * routes it ahead of the sibling `[id]` handler.
 */

import type { CatalogEnv } from '../../../_lib/env'
import type { PublisherData } from '../../_middleware'
import { isPrivileged } from '../../../_lib/publisher-store'
import { writeAuditEvent } from '../../../_lib/audit-store'
import { listVideoSources, recordVideoSourceRun } from '../../../_lib/video-sources-store'
import { refreshVideoSource } from '../../../_lib/video-source-refresh'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Max embedding calls per refresh request, shared across all sources —
 *  a first pull embeds the newest entries and leaves the tail for the
 *  next run, exactly like the events refresh's enrichment budget. */
const MAX_EMBED_CALLS = 300

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

interface SourceSummary {
  id: string
  label: string
  fetched: number
  indexed: number
  embedded: number
  pruned: number
  error?: string
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Refreshing video sources is restricted to admin and service callers.')
  }
  const db = context.env.CATALOG_DB

  const sources = await listVideoSources(db, { enabledOnly: true })
  const embedBudget = { remaining: MAX_EMBED_CALLS }
  const summaries: SourceSummary[] = []
  let anyReached = false
  // Network fetches actually attempted (valid URL) — the denominator for
  // the all-down 502. A config error (bad URL) can't succeed on retry, so
  // it doesn't count, exactly like the events refresh route.
  let networkAttempts = 0

  for (const source of sources) {
    const result = await refreshVideoSource(db, source, {
      env: context.env,
      embedBudget,
      fetchFn: (input, init) => fetch(input, init),
    })
    const configError = !result.ok && /must be http/i.test(result.error ?? '')
    if (!configError) networkAttempts++
    if (result.ok) {
      anyReached = true
      await recordVideoSourceRun(db, source.id, { status: 'ok', count: result.indexed })
    } else {
      await recordVideoSourceRun(db, source.id, { status: 'error', error: result.error })
    }
    summaries.push({
      id: source.id,
      label: source.label,
      fetched: result.fetched,
      indexed: result.indexed,
      embedded: result.embedded,
      pruned: result.pruned,
      ...(result.error ? { error: result.error } : {}),
    })
  }

  // A total outage (sources reachable-in-principle but none actually
  // reached) is a 502 the UI can explain — mirrors the events refresh
  // contract. No sources, or all config errors, answer 200 with the
  // per-source errors recorded.
  if (networkAttempts > 0 && !anyReached) {
    return jsonError(502, 'sources_unavailable', 'Could not reach any enabled video source.')
  }

  const totals = summaries.reduce(
    (acc, s) => ({
      fetched: acc.fetched + s.fetched,
      indexed: acc.indexed + s.indexed,
      embedded: acc.embedded + s.embedded,
      pruned: acc.pruned + s.pruned,
    }),
    { fetched: 0, indexed: 0, embedded: 0, pruned: 0 },
  )
  const summary = { ...totals, sources: summaries }

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'video_source.refresh',
    subject_kind: 'video_source',
    subject_id: null,
    metadata_json: JSON.stringify(summary),
  })

  return json(200, summary)
}
