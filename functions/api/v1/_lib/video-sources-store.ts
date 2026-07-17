/**
 * D1 store for the video-suggestion source registry (`video_sources`,
 * migration 0040; task: video-sitemap media source). Each row is one
 * Video Sitemap a node ingests videos from for the "suggested media"
 * engine — the non-YouTube counterpart of `feed-connectors-store.ts`
 * (which registers *event* feeds).
 *
 * Mirrors the feed-connector conventions: snake_case row types mapping
 * the table verbatim, a camelCase public type via `toPublicVideoSource`,
 * ULID ids, injectable `now` for deterministic tests, one-row-deep run
 * bookkeeping (`last_run_*`). Pure D1 — no route wiring, no fetching.
 * The scheduled refresh job reads the enabled rows and materializes each
 * sitemap into `video_index` (`video-index-store.ts`); the portal Feeds
 * console does the CRUD.
 */

import { newUlid } from './ulid'

/** The source implementations this deployment can index. Only
 *  `video-sitemap` today; the column defaults to it. */
export const VIDEO_SOURCE_KINDS = ['video-sitemap'] as const
export type VideoSourceKind = (typeof VIDEO_SOURCE_KINDS)[number]

/** Request headers for every server-side sitemap fetch — an honest bot
 *  UA (mainstream CDNs 406 a bare Workers fetch) and an XML-shaped
 *  Accept. Mirrors `feed-connectors-store.feedRequestHeaders`. */
export function videoSourceRequestHeaders(): Record<string, string> {
  return {
    'User-Agent': 'TerravizMediaBot/1.0 (+https://github.com/zyra-project/terraviz)',
    Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1',
  }
}

/** One `video_sources` row, column-for-column. */
export interface VideoSourceRow {
  id: string
  kind: string
  label: string
  url: string
  attribution: string | null
  enabled: number
  added_by: string | null
  created_at: string
  updated_at: string
  last_run_at: string | null
  last_run_status: string | null
  last_run_error: string | null
  last_run_count: number | null
}

/** A source as routes / portal consume it. */
export interface PublicVideoSource {
  id: string
  kind: string
  label: string
  url: string
  attribution: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  lastRunStatus: 'ok' | 'error' | null
  lastRunError: string | null
  lastRunCount: number | null
}

export interface NewVideoSource {
  kind?: string
  label: string
  url: string
  attribution?: string | null
  /** Defaults to enabled. */
  enabled?: boolean
  addedBy?: string | null
}

export function toPublicVideoSource(row: VideoSourceRow): PublicVideoSource {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    url: row.url,
    attribution: row.attribution,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status === 'ok' || row.last_run_status === 'error' ? row.last_run_status : null,
    lastRunError: row.last_run_error,
    lastRunCount: row.last_run_count,
  }
}

/** List sources, optionally restricted to enabled ones (the shape the
 *  refresh job / matcher read). Ordered by creation for a stable list. */
export async function listVideoSources(
  db: D1Database,
  opts: { enabledOnly?: boolean } = {},
): Promise<VideoSourceRow[]> {
  const where = opts.enabledOnly ? 'WHERE enabled = 1' : ''
  const res = await db
    .prepare(`SELECT * FROM video_sources ${where} ORDER BY created_at, id`)
    .all<VideoSourceRow>()
  return res.results ?? []
}

export async function getVideoSource(db: D1Database, id: string): Promise<VideoSourceRow | null> {
  const row = await db.prepare(`SELECT * FROM video_sources WHERE id = ?`).bind(id).first<VideoSourceRow>()
  return row ?? null
}

/** Look up a source by its sitemap URL — used to reject a duplicate
 *  registration (the portal's "already added" state). */
export async function getVideoSourceByUrl(db: D1Database, url: string): Promise<VideoSourceRow | null> {
  const row = await db.prepare(`SELECT * FROM video_sources WHERE url = ?`).bind(url).first<VideoSourceRow>()
  return row ?? null
}

/** Insert a source, minting its ULID. Returns the stored row. */
export async function insertVideoSource(
  db: D1Database,
  input: NewVideoSource,
  now: string = new Date().toISOString(),
): Promise<VideoSourceRow> {
  const id = newUlid()
  await db
    .prepare(
      `INSERT INTO video_sources (id, kind, label, url, attribution, enabled, added_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.kind ?? 'video-sitemap',
      input.label,
      input.url,
      input.attribution ?? null,
      input.enabled === false ? 0 : 1,
      input.addedBy ?? null,
      now,
      now,
    )
    .run()
  return (await getVideoSource(db, id))!
}

/** Patch a source's operator-editable fields. Only supplied keys change;
 *  `updated_at` is stamped whenever anything does. Returns the updated
 *  row, or `null` for an unknown id. */
export async function updateVideoSource(
  db: D1Database,
  id: string,
  patch: Partial<Pick<NewVideoSource, 'label' | 'url' | 'attribution' | 'enabled'>>,
  now: string = new Date().toISOString(),
): Promise<VideoSourceRow | null> {
  const existing = await getVideoSource(db, id)
  if (!existing) return null
  const sets: string[] = []
  const binds: unknown[] = []
  if (patch.label !== undefined) { sets.push('label = ?'); binds.push(patch.label) }
  if (patch.url !== undefined) { sets.push('url = ?'); binds.push(patch.url) }
  if (patch.attribution !== undefined) { sets.push('attribution = ?'); binds.push(patch.attribution) }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); binds.push(patch.enabled ? 1 : 0) }
  if (sets.length === 0) return existing
  sets.push('updated_at = ?')
  binds.push(now, id)
  await db.prepare(`UPDATE video_sources SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
  return getVideoSource(db, id)
}

/** Delete a source. Its `video_index` rows cascade (FK ON DELETE
 *  CASCADE). Returns whether a row was deleted. */
export async function deleteVideoSource(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM video_sources WHERE id = ?`).bind(id).run()
  return (res.meta?.changes ?? 0) > 0
}

/** Record the outcome of one refresh attempt — the bookkeeping the
 *  portal shows ("last indexed 5 min ago · 283 videos"). An `ok` run
 *  clears any prior error and stamps the indexed count. */
export async function recordVideoSourceRun(
  db: D1Database,
  id: string,
  outcome: { status: 'ok' | 'error'; error?: string; count?: number },
  now: string = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE video_sources
          SET last_run_at = ?, last_run_status = ?, last_run_error = ?, last_run_count = ?
        WHERE id = ?`,
    )
    .bind(
      now,
      outcome.status,
      outcome.status === 'error' ? (outcome.error ?? 'unknown error') : null,
      outcome.status === 'ok' ? (outcome.count ?? null) : null,
      id,
    )
    .run()
}
