/**
 * D1 store for the current-events feed-connector registry
 * (`migrations/catalog/0026_feed_connectors.sql`;
 * `docs/CURRENT_EVENTS_PLAN.md` §9). Each row is one feed a node
 * ingests events from: which connector implementation reads it
 * (`kind`), where it lives (`url`), how the portal groups it
 * (`category`), and whether it currently runs (`enabled`), plus
 * one-row-deep run bookkeeping (`last_run_*`).
 *
 * Mirrors `events-store.ts` conventions: snake_case row types mapping
 * the table verbatim, camelCase public types via a `toPublic*` mapper,
 * ULID-minted ids, and injectable `now` timestamps for deterministic
 * tests. Pure D1 (`prepare/bind/run/first/all`) — no route wiring, no
 * caching. The refresh route / scheduled importer read the enabled
 * rows; the portal feeds page (a later slice) does the CRUD.
 */

import { newUlid } from './ulid'

/** The connector implementations this deployment can run. Rows of any
 *  other kind are skippable data (the refresh route records an error),
 *  but the create/update routes only accept these. */
export const FEED_CONNECTOR_KINDS = ['eonet', 'rss'] as const
export type FeedConnectorKind = (typeof FEED_CONNECTOR_KINDS)[number]

/**
 * Request headers for every server-side feed fetch (the refresh route
 * and the preview dry-run). A bare Workers `fetch` sends no
 * `User-Agent`/`Accept`, and mainstream news CDNs reject that (The
 * Guardian's answers 406 Not Acceptable) — an honest bot UA with a
 * contact URL plus a feed-shaped Accept gets past content negotiation
 * and is polite to operators reading their logs.
 */
export function feedRequestHeaders(kind: FeedConnectorKind): Record<string, string> {
  return {
    'User-Agent': 'TerravizEventsBot/1.0 (+https://github.com/zyra-project/terraviz)',
    Accept:
      kind === 'eonet'
        ? 'application/json'
        : 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1',
  }
}

/** One `feed_connectors` row, column-for-column. */
export interface FeedConnectorRow {
  id: string
  kind: string
  label: string
  url: string
  category: string | null
  enabled: number
  created_at: string
  updated_at: string
  last_run_at: string | null
  last_run_status: string | null
  last_run_error: string | null
}

/** A connector as routes/portal consume it. */
export interface PublicFeedConnector {
  id: string
  kind: string
  label: string
  url: string
  category: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  lastRunStatus: 'ok' | 'error' | null
  lastRunError: string | null
}

export interface NewFeedConnector {
  kind: string
  label: string
  url: string
  category?: string | null
  /** Defaults to enabled. */
  enabled?: boolean
}

export function toPublicFeedConnector(row: FeedConnectorRow): PublicFeedConnector {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    url: row.url,
    category: row.category,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status === 'ok' || row.last_run_status === 'error' ? row.last_run_status : null,
    lastRunError: row.last_run_error,
  }
}

/**
 * List connectors, optionally restricted to enabled ones (the shape the
 * refresh route / importer read). Ordered by creation so the seeded
 * default stays first and the portal list is stable.
 */
export async function listFeedConnectors(
  db: D1Database,
  opts: { enabledOnly?: boolean } = {},
): Promise<FeedConnectorRow[]> {
  const where = opts.enabledOnly ? 'WHERE enabled = 1' : ''
  const res = await db
    .prepare(`SELECT * FROM feed_connectors ${where} ORDER BY created_at, id`)
    .all<FeedConnectorRow>()
  return res.results ?? []
}

export async function getFeedConnector(
  db: D1Database,
  id: string,
): Promise<FeedConnectorRow | null> {
  const row = await db
    .prepare(`SELECT * FROM feed_connectors WHERE id = ?`)
    .bind(id)
    .first<FeedConnectorRow>()
  return row ?? null
}

/** Insert a connector, minting its ULID. Returns the stored row. */
export async function insertFeedConnector(
  db: D1Database,
  input: NewFeedConnector,
  now: string = new Date().toISOString(),
): Promise<FeedConnectorRow> {
  const id = newUlid()
  await db
    .prepare(
      `INSERT INTO feed_connectors (id, kind, label, url, category, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.kind, input.label, input.url, input.category ?? null, input.enabled === false ? 0 : 1, now, now)
    .run()
  return (await getFeedConnector(db, id))!
}

/**
 * Patch a connector's operator-editable fields. Only supplied keys
 * change; `updated_at` is stamped whenever anything does. Returns the
 * updated row, or `null` for an unknown id.
 */
export async function updateFeedConnector(
  db: D1Database,
  id: string,
  patch: Partial<Pick<NewFeedConnector, 'label' | 'url' | 'category' | 'enabled'>>,
  now: string = new Date().toISOString(),
): Promise<FeedConnectorRow | null> {
  const existing = await getFeedConnector(db, id)
  if (!existing) return null
  const sets: string[] = []
  const binds: unknown[] = []
  if (patch.label !== undefined) { sets.push('label = ?'); binds.push(patch.label) }
  if (patch.url !== undefined) { sets.push('url = ?'); binds.push(patch.url) }
  if (patch.category !== undefined) { sets.push('category = ?'); binds.push(patch.category) }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); binds.push(patch.enabled ? 1 : 0) }
  if (sets.length === 0) return existing
  sets.push('updated_at = ?')
  binds.push(now, id)
  await db
    .prepare(`UPDATE feed_connectors SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run()
  return getFeedConnector(db, id)
}

/** Delete a connector (the portal's remove action). Returns whether a
 *  row was deleted. Events already ingested from it are untouched —
 *  they carry their own provenance and stay under the curator gate. */
export async function deleteFeedConnector(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM feed_connectors WHERE id = ?`).bind(id).run()
  return (res.meta?.changes ?? 0) > 0
}

/**
 * Record the outcome of one run attempt — the one-row-deep bookkeeping
 * the portal shows ("last ran 5 minutes ago · ok"). An `ok` run clears
 * any prior error text.
 */
export async function recordFeedRun(
  db: D1Database,
  id: string,
  outcome: { status: 'ok' | 'error'; error?: string },
  now: string = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE feed_connectors
          SET last_run_at = ?, last_run_status = ?, last_run_error = ?
        WHERE id = ?`,
    )
    .bind(now, outcome.status, outcome.status === 'error' ? (outcome.error ?? 'unknown error') : null, id)
    .run()
}
