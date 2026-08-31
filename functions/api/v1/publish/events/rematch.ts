// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * POST /api/v1/publish/events/rematch — re-score existing events
 * against the current matcher.
 *
 * The matcher runs on ingest and on a curator edit to an event's date
 * or geometry, and nowhere else. That is fine while scoring is stable
 * and wrong the moment it changes: an event whose feed has already
 * dropped it (EONET retires closed events, RSS rolls off) is never
 * re-scored, so it keeps whatever the old formula produced — or, after
 * migration `0044` cleared those values, no score at all. This route is
 * the missing path. It re-runs `runMatcherForEvent` over events chosen
 * by `listEventIdsToRescore` and refreshes their links in place.
 *
 * **Bounded and resumable, because it has to be.** Each event costs D1
 * reads plus, where Workers AI and Vectorize are wired, an embedding
 * call and a vector query. A few hundred events in one request would
 * exhaust the Worker's CPU or subrequest budget partway through, and a
 * partial run with no way to say where it stopped is worse than no run.
 * So a call does at most `limit` events and returns `nextCursor`; the
 * caller repeats with that cursor until the response says `done`.
 *
 * Paging is keyset on event id rather than a shrinking "needs a score"
 * set — see `listEventIdsToRescore` for why that distinction decides
 * whether the loop terminates.
 *
 * One event's failure never ends the run. The matcher touches the
 * network for the semantic signal, and a single 500 from Workers AI
 * should cost that event's re-score, not the other twenty-four in the
 * page. Failures are counted and named in the response.
 *
 * Privileged-only (admin / service). Feature-gating is the
 * middleware's: `/api/v1/publish/events` is a gated prefix, and this
 * route is deliberately NOT added to `FEATURE_GATE_EXEMPT_PATHS`, so a
 * node with events off answers 403 here. That exemption list exists for
 * the two cron-invoked routes, where a middleware 403 would turn a
 * GitHub Actions run red every cycle; this route is driven by an admin
 * clicking a button on a page that itself does not render when events
 * is off, so there is no cron to keep green and nothing to special-case.
 *
 * An in-route `getEffectiveFeatures` check was written here first and
 * removed: the middleware answers before the handler runs, so it was
 * unreachable, and it made the route document a 200-no-op contract it
 * could not honour.
 *
 * Static `rematch` segment, so Pages routes it ahead of the sibling
 * `[id]` review-submit handler.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { writeAuditEvent } from '../../_lib/audit-store'
import { listEventIdsToRescore } from '../../_lib/events-store'
import { runMatcherForEvent } from '../../_lib/events-matcher'

const CONTENT_TYPE = 'application/json; charset=utf-8'

/**
 * Events re-scored per request. Deliberately smaller than
 * `refresh.ts`'s 100-event budget: refresh mostly re-ingests events
 * whose links already exist, while every event here pays the full
 * matcher cost including the semantic signal.
 */
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

/** Distinct failing event ids echoed back; the count is always exact. */
const MAX_REPORTED_FAILURES = 10

interface RematchBody {
  limit?: number
  after?: string | null
  unscoredOnly?: boolean
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

/** Parse the optional body. A malformed one is a 400, not a silent
 *  default: a caller that meant to pass a cursor and typoed the field
 *  would otherwise restart the walk from the beginning every call. */
async function readBody(request: Request): Promise<RematchBody | { error: string }> {
  const raw = await request.text()
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: 'Request body must be JSON.' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Request body must be a JSON object.' }
  }
  const body = parsed as Record<string, unknown>
  const out: RematchBody = {}
  if (body.limit !== undefined) {
    if (typeof body.limit !== 'number' || !Number.isFinite(body.limit) || body.limit < 1) {
      return { error: '`limit` must be a positive number.' }
    }
    out.limit = Math.min(Math.floor(body.limit), MAX_LIMIT)
  }
  if (body.after !== undefined && body.after !== null) {
    if (typeof body.after !== 'string') return { error: '`after` must be a string event id or null.' }
    out.after = body.after
  }
  if (body.unscoredOnly !== undefined) {
    if (typeof body.unscoredOnly !== 'boolean') return { error: '`unscoredOnly` must be a boolean.' }
    out.unscoredOnly = body.unscoredOnly
  }
  return out
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Re-scoring events is restricted to admin and service callers.')
  }

  const parsed = await readBody(context.request)
  if ('error' in parsed) return jsonError(400, 'invalid_body', parsed.error)

  const db = context.env.CATALOG_DB
  const limit = parsed.limit ?? DEFAULT_LIMIT
  const ids = await listEventIdsToRescore(db, {
    limit,
    after: parsed.after ?? null,
    unscoredOnly: parsed.unscoredOnly,
  })

  let rescored = 0
  const failedIds: string[] = []
  for (const id of ids) {
    try {
      await runMatcherForEvent(db, id, { env: context.env })
      rescored += 1
    } catch {
      failedIds.push(id)
    }
  }

  // A short page means the walk reached the end. Cursor advances to the
  // last id *attempted*, not the last one that succeeded, so a failing
  // event cannot pin the loop in place — the response names it instead.
  const done = ids.length < limit
  const nextCursor = done ? null : (ids[ids.length - 1] ?? null)

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'event.refreshed',
    subject_kind: 'event',
    subject_id: null,
    metadata_json: JSON.stringify({
      via: 'rematch',
      scanned: ids.length,
      rescored,
      failed: failedIds.length,
      unscoredOnly: parsed.unscoredOnly !== false,
    }),
  })

  return json({
    scanned: ids.length,
    rescored,
    failed: failedIds.length,
    failedIds: failedIds.slice(0, MAX_REPORTED_FAILURES),
    nextCursor,
    done,
  })
}
