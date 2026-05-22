/**
 * Publisher-API write paths for the `tours` table.
 *
 * Mirrors `dataset-mutations.ts` for tours. Phase 1a is metadata-
 * only — the `tour_json_ref` is supplied by the caller as a bare
 * string (an R2 key once Phase 1b lands). Slug uniqueness, role-
 * aware visibility filters, and snapshot invalidation on
 * publish/retract follow the same shape as datasets.
 */

import type { PublisherRow } from './publisher-store'
import { invalidateSnapshot } from './snapshot'
import type { CatalogEnv } from './env'
import { newUlid } from './ulid'
import {
  deriveSlug,
  validateTourDraft,
  type TourDraftBody,
  type ValidationError,
} from './validators'

export interface TourRow {
  id: string
  slug: string
  origin_node: string
  title: string
  description: string | null
  tour_json_ref: string
  thumbnail_ref: string | null
  visibility: string
  schema_version: number
  created_at: string
  updated_at: string
  published_at: string | null
  publisher_id: string | null
}

export interface TourCreateResult {
  ok: true
  tour: TourRow
}
export interface TourCreateFailure {
  ok: false
  status: number
  errors: ValidationError[]
}
export type TourMutationOutcome = TourCreateResult | TourCreateFailure

function isPrivileged(p: PublisherRow): boolean {
  return p.is_admin === 1 || p.role === 'staff' || p.role === 'service'
}

async function slugInUse(db: D1Database, slug: string, exclude?: string): Promise<boolean> {
  const sql = exclude
    ? 'SELECT id FROM tours WHERE slug = ? AND id != ? LIMIT 1'
    : 'SELECT id FROM tours WHERE slug = ? LIMIT 1'
  const binds = exclude ? [slug, exclude] : [slug]
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ id: string }>()
  return row != null
}

async function ensureUniqueSlug(db: D1Database, desired: string, exclude?: string): Promise<string> {
  let candidate = desired
  let n = 1
  while (await slugInUse(db, candidate, exclude)) {
    n++
    candidate = `${desired}-${n}`.slice(0, 64)
    if (n > 100) throw new Error('Could not allocate a unique tour slug')
  }
  return candidate
}

/**
 * R2 key for a tour's current draft JSON. Phase 3pt/E — the
 * authoring dock autosaves to this path; the engine reads from
 * it for the in-portal preview. Drafts overwrite (a tour has
 * exactly one current draft); published versions get their own
 * immutable key under `tours/{id}/published/{publish_id}.json`
 * when tour/F lands the publish flow.
 */
export function tourDraftR2Key(tourId: string): string {
  return `tours/${tourId}/draft.json`
}

/** Bare `r2:` ref string for the draft. */
export function tourDraftR2Ref(tourId: string): string {
  return `r2:${tourDraftR2Key(tourId)}`
}

/**
 * Phase 3pt/E — create a fresh draft tour row + write an empty
 * tour file (`{"tourTasks":[]}`) at the canonical draft key.
 * Bypasses the `tour_json_ref` validator (which requires a non-
 * empty ref) by computing the ref server-side from the newly
 * minted ULID. Returns the row with `tour_json_ref` already
 * pointing at the (empty) draft blob so the dock can flip
 * straight into autosave mode without a follow-up PUT.
 */
export async function createDraftTour(
  env: CatalogEnv,
  publisher: PublisherRow,
  overrides: { title?: string } = {},
): Promise<TourMutationOutcome> {
  // Phase 3pt-review/H — validate a caller-supplied title against
  // the same rules `createTour` / `updateTour` apply (≥3 chars
  // after trim, ≤200 chars, no control chars). Pre-fix, a draft
  // POST with `{ title: "  " }` or `{ title: "<200 chars" }` would
  // accept whatever the caller sent, drift the row into a state
  // the rename PUT would refuse, and confuse the UI. We skip the
  // check when no title is provided (the auto-derived placeholder
  // is always valid). Copilot discussion_r3291171383.
  if (overrides.title !== undefined) {
    const errors = validateTourDraft({ title: overrides.title })
    if (errors.length) return { ok: false, status: 400, errors }
  }
  const db = env.CATALOG_DB!
  const id = newUlid()
  const title = overrides.title?.trim() || `Untitled tour ${id.slice(-6)}`
  const slug = await ensureUniqueSlug(db, deriveSlug(title))
  const now = new Date().toISOString()
  const ref = tourDraftR2Ref(id)
  // Seed the R2 blob with an empty tour file so a GET on the
  // ref returns valid JSON even before the first autosave. The
  // bucket is optional only in the sense that the row insert
  // still succeeds without it; a deploy without CATALOG_R2
  // bound will accept the draft create but every follow-up
  // /publish/tours/{id}/json PUT will fail with
  // `503 binding_missing`. Production deploys must bind the
  // bucket — this branch keeps unit tests + smoke checks
  // running against a partial env. Phase 3pt-review/H —
  // Copilot discussion_r3291171409.
  if (env.CATALOG_R2) {
    const emptyTour = JSON.stringify({ tourTasks: [] })
    await env.CATALOG_R2.put(tourDraftR2Key(id), emptyTour, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    })
  }
  await db
    .prepare(
      `INSERT INTO tours (
         id, slug, origin_node, title, description, tour_json_ref, thumbnail_ref,
         visibility, schema_version, created_at, updated_at, published_at, publisher_id
       ) VALUES (?, ?, (SELECT node_id FROM node_identity LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, slug, title, null, ref, null, 'public', 1, now, now, null, publisher.id)
    .run()
  const row = await db
    .prepare('SELECT * FROM tours WHERE id = ?')
    .bind(id)
    .first<TourRow>()
  return { ok: true, tour: row! }
}

/**
 * Phase 3pt/E — overwrite the draft JSON blob. Validates the
 * body is shaped like a `TourFile` (object with a `tourTasks`
 * array) and refuses anything else with `invalid_tour_file`.
 * Bumps `updated_at` on the row but doesn't touch
 * `tour_json_ref` (which already points at the draft key) or
 * `published_at` (publish is a separate gesture).
 */
export async function writeTourDraftJson(
  env: CatalogEnv,
  publisher: PublisherRow,
  id: string,
  body: unknown,
): Promise<
  | { ok: true; tour: TourRow }
  | { ok: false; status: number; error: string; message: string }
> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_tour_file', message: 'Body must be a TourFile object.' }
  }
  const taskArr = (body as { tourTasks?: unknown }).tourTasks
  if (!Array.isArray(taskArr)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_tour_file',
      message: 'Body must have a `tourTasks` array.',
    }
  }
  const existing = await getTourForPublisher(env.CATALOG_DB!, publisher, id)
  if (!existing) {
    return { ok: false, status: 404, error: 'not_found', message: `Tour ${id} not found.` }
  }
  if (!env.CATALOG_R2) {
    return {
      ok: false,
      status: 503,
      error: 'binding_missing',
      message: 'CATALOG_R2 binding is not configured.',
    }
  }
  await env.CATALOG_R2.put(tourDraftR2Key(id), JSON.stringify(body), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })
  const now = new Date().toISOString()
  await env.CATALOG_DB!
    .prepare('UPDATE tours SET updated_at = ? WHERE id = ?')
    .bind(now, id)
    .run()
  const row = await env.CATALOG_DB!
    .prepare('SELECT * FROM tours WHERE id = ?')
    .bind(id)
    .first<TourRow>()
  return { ok: true, tour: row! }
}

/**
 * Phase 3pt/E — read the draft JSON blob for re-opening the
 * authoring dock against an existing tour. Returns the parsed
 * tour file or null on missing-blob / unreadable.
 */
export async function readTourDraftJson(
  env: CatalogEnv,
  publisher: PublisherRow,
  id: string,
): Promise<
  | { ok: true; tour: TourRow; tourFile: unknown }
  | { ok: false; status: number; error: string; message: string }
> {
  const row = await getTourForPublisher(env.CATALOG_DB!, publisher, id)
  if (!row) {
    return { ok: false, status: 404, error: 'not_found', message: `Tour ${id} not found.` }
  }
  if (!env.CATALOG_R2) {
    return {
      ok: false,
      status: 503,
      error: 'binding_missing',
      message: 'CATALOG_R2 binding is not configured.',
    }
  }
  const obj = await env.CATALOG_R2.get(tourDraftR2Key(id))
  if (!obj) {
    // Row exists but blob doesn't (cold start before first
    // autosave; or hand-deleted from the dashboard). Surface as
    // a fresh empty tour so the dock can come up cleanly.
    return { ok: true, tour: row, tourFile: { tourTasks: [] } }
  }
  const text = await obj.text()
  try {
    return { ok: true, tour: row, tourFile: JSON.parse(text) }
  } catch {
    return {
      ok: false,
      status: 500,
      error: 'invalid_tour_blob',
      message: `Tour ${id}'s draft.json is not valid JSON.`,
    }
  }
}

/**
 * Phase 3pt/G — list tours visible to the caller. Honours the
 * same role gating `getTourForPublisher` uses (staff / admin /
 * service see every row; community publishers see only their
 * own). Cursor pagination via `id < ?` since `tours.id` is a
 * ULID — lexicographic order matches creation order, so a
 * fresh tour landing at the top doesn't shift the cursor's
 * position on the rest of the list.
 */
export interface ListToursResult {
  tours: TourRow[]
  next_cursor: string | null
}

export async function listToursForPublisher(
  env: CatalogEnv,
  publisher: PublisherRow,
  options: { limit: number; cursor?: string },
): Promise<ListToursResult> {
  const db = env.CATALOG_DB!
  // Fetch limit+1 so we can compute `next_cursor` without a
  // separate COUNT — the extra row is what the next page's
  // cursor will be.
  const fetchLimit = options.limit + 1
  const cursorBound = options.cursor && options.cursor.length > 0 ? options.cursor : null
  let rows: TourRow[]
  if (isPrivileged(publisher)) {
    rows = cursorBound
      ? ((await db
          .prepare('SELECT * FROM tours WHERE id < ? ORDER BY id DESC LIMIT ?')
          .bind(cursorBound, fetchLimit)
          .all<TourRow>()).results ?? [])
      : ((await db
          .prepare('SELECT * FROM tours ORDER BY id DESC LIMIT ?')
          .bind(fetchLimit)
          .all<TourRow>()).results ?? [])
  } else {
    rows = cursorBound
      ? ((await db
          .prepare(
            'SELECT * FROM tours WHERE publisher_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
          )
          .bind(publisher.id, cursorBound, fetchLimit)
          .all<TourRow>()).results ?? [])
      : ((await db
          .prepare(
            'SELECT * FROM tours WHERE publisher_id = ? ORDER BY id DESC LIMIT ?',
          )
          .bind(publisher.id, fetchLimit)
          .all<TourRow>()).results ?? [])
  }
  let next_cursor: string | null = null
  if (rows.length > options.limit) {
    // We fetched `limit + 1` rows. The extra row is only used to
    // detect hasMore — we drop it and set the cursor to the id of
    // the last *returned* row, which the next page's `cursor < ?`
    // predicate will pick up from. Phase 3pt-review/B — Copilot
    // discussion_r3284513457.
    next_cursor = rows[options.limit - 1]?.id ?? null
    rows = rows.slice(0, options.limit)
  }
  return { tours: rows, next_cursor }
}

/**
 * Phase 3pt/G — publish a tour. Copies the current draft blob
 * to an immutable `tours/{id}/published/{publish_id}.json` key,
 * flips the row's `tour_json_ref` to that path, and stamps
 * `published_at`. The draft blob stays put — the publisher can
 * continue editing the draft after publishing, and a future
 * publish creates a new immutable snapshot.
 *
 * The R2 copy uses a fresh ULID for the publish-id segment so
 * each publish has a stable URL even after multiple republish
 * cycles. Old published bundles aren't deleted — federation
 * subscribers may still be holding the prior `tour_json_ref`.
 */
export async function publishTour(
  env: CatalogEnv,
  publisher: PublisherRow,
  id: string,
): Promise<
  | { ok: true; tour: TourRow; publishId: string }
  | { ok: false; status: number; error: string; message: string }
> {
  const row = await getTourForPublisher(env.CATALOG_DB!, publisher, id)
  if (!row) {
    return { ok: false, status: 404, error: 'not_found', message: `Tour ${id} not found.` }
  }
  if (!env.CATALOG_R2) {
    return {
      ok: false,
      status: 503,
      error: 'binding_missing',
      message: 'CATALOG_R2 binding is not configured.',
    }
  }
  // Read the current draft. A missing blob is a server-side
  // data-consistency problem (clearTranscoding analogue —
  // createDraftTour writes the seed blob; only a hand-delete
  // can produce this state). Refuse to publish rather than
  // pointing the row at a nonexistent ref.
  const draft = await env.CATALOG_R2.get(tourDraftR2Key(id))
  if (!draft) {
    return {
      ok: false,
      status: 503,
      error: 'draft_missing',
      message: `Tour ${id}'s draft.json is not in R2; refusing to publish.`,
    }
  }
  const text = await draft.text()
  // Validate the draft is JSON before the copy — a corrupt
  // draft would otherwise be promoted to an immutable
  // published blob.
  try {
    JSON.parse(text)
  } catch {
    return {
      ok: false,
      status: 500,
      error: 'invalid_draft_blob',
      message: `Tour ${id}'s draft.json is not valid JSON; refusing to publish.`,
    }
  }
  const publishId = newUlid()
  const publishedKey = `tours/${id}/published/${publishId}.json`
  await env.CATALOG_R2.put(publishedKey, text, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })
  const now = new Date().toISOString()
  await env.CATALOG_DB!
    .prepare(
      'UPDATE tours SET tour_json_ref = ?, published_at = ?, updated_at = ? WHERE id = ?',
    )
    .bind(`r2:${publishedKey}`, now, now, id)
    .run()
  const updated = await env.CATALOG_DB!
    .prepare('SELECT * FROM tours WHERE id = ?')
    .bind(id)
    .first<TourRow>()
  return { ok: true, tour: updated!, publishId }
}

/**
 * Phase 3pt/G — hard-delete a tour. Removes the D1 row and
 * best-effort deletes the draft R2 blob. Published immutable
 * snapshots under `tours/{id}/published/{publish_id}.json` are
 * NOT removed — if any federation subscriber holds the
 * `tour_json_ref` URL it should keep resolving until the peer
 * notices the parent row is gone and prunes its cache. Once
 * Phase 4 federation lands a soft-retract gesture can replace
 * this; for v1 the publisher's intent ("clean up my drafts")
 * is what matters.
 *
 * Visibility gating goes through `getTourForPublisher` so a
 * community publisher can only delete their own; staff /
 * admin / service tokens can delete anything.
 */
export async function deleteTour(
  env: CatalogEnv,
  publisher: PublisherRow,
  id: string,
): Promise<
  | { ok: true; deleted_id: string }
  | { ok: false; status: number; error: string; message: string }
> {
  const row = await getTourForPublisher(env.CATALOG_DB!, publisher, id)
  if (!row) {
    return { ok: false, status: 404, error: 'not_found', message: `Tour ${id} not found.` }
  }
  await env.CATALOG_DB!
    .prepare('DELETE FROM tours WHERE id = ?')
    .bind(id)
    .run()
  // Best-effort blob delete. A missing blob (cold-start row that
  // never autosaved) is fine; a binding-missing deployment is
  // also fine — the row is gone, and orphaned blobs are
  // harmless until a future cleanup job runs.
  if (env.CATALOG_R2) {
    try {
      await env.CATALOG_R2.delete(tourDraftR2Key(id))
    } catch {
      // Don't fail the delete because R2 hiccuped — the
      // canonical "tour exists" state lives in D1, which is
      // already cleared.
    }
  }
  return { ok: true, deleted_id: id }
}

export async function getTourForPublisher(
  db: D1Database,
  publisher: PublisherRow,
  id: string,
): Promise<TourRow | null> {
  if (isPrivileged(publisher)) {
    return (
      (await db
        .prepare('SELECT * FROM tours WHERE id = ? LIMIT 1')
        .bind(id)
        .first<TourRow>()) ?? null
    )
  }
  return (
    (await db
      .prepare('SELECT * FROM tours WHERE id = ? AND publisher_id = ? LIMIT 1')
      .bind(id, publisher.id)
      .first<TourRow>()) ?? null
  )
}

export async function createTour(
  env: CatalogEnv,
  publisher: PublisherRow,
  body: TourDraftBody,
): Promise<TourMutationOutcome> {
  const errors = validateTourDraft(body)
  if (errors.length) return { ok: false, status: 400, errors }
  if (!body.tour_json_ref) {
    return {
      ok: false,
      status: 400,
      errors: [
        {
          field: 'tour_json_ref',
          code: 'required',
          message: 'A tour_json_ref is required (Phase 1a accepts any non-empty string).',
        },
      ],
    }
  }
  const db = env.CATALOG_DB!
  const desiredSlug = body.slug ?? deriveSlug(body.title!)
  const slug = await ensureUniqueSlug(db, desiredSlug)
  const id = newUlid()
  const now = new Date().toISOString()

  await db
    .prepare(
      `INSERT INTO tours (
         id, slug, origin_node, title, description, tour_json_ref, thumbnail_ref,
         visibility, schema_version, created_at, updated_at, published_at, publisher_id
       ) VALUES (?, ?, (SELECT node_id FROM node_identity LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      slug,
      body.title,
      body.description ?? null,
      body.tour_json_ref,
      body.thumbnail_ref ?? null,
      body.visibility ?? 'public',
      1,
      now,
      now,
      null,
      publisher.id,
    )
    .run()

  const row = await db
    .prepare('SELECT * FROM tours WHERE id = ?')
    .bind(id)
    .first<TourRow>()
  return { ok: true, tour: row! }
}

export async function updateTour(
  env: CatalogEnv,
  publisher: PublisherRow,
  id: string,
  body: TourDraftBody,
): Promise<TourMutationOutcome> {
  const errors = validateTourDraft(body)
  if (errors.length) return { ok: false, status: 400, errors }
  const db = env.CATALOG_DB!

  const sets: string[] = []
  const binds: unknown[] = []
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`)
    binds.push(v)
  }
  if (body.title !== undefined) set('title', body.title)
  if (body.description !== undefined) set('description', body.description)
  if (body.tour_json_ref !== undefined) set('tour_json_ref', body.tour_json_ref)
  if (body.thumbnail_ref !== undefined) set('thumbnail_ref', body.thumbnail_ref)
  if (body.visibility !== undefined) set('visibility', body.visibility)

  if (body.slug !== undefined) {
    const unique = await ensureUniqueSlug(db, body.slug!, id)
    if (unique !== body.slug) {
      return {
        ok: false,
        status: 409,
        errors: [
          { field: 'slug', code: 'conflict', message: `Slug "${body.slug}" is in use.` },
        ],
      }
    }
    set('slug', unique)
  }

  set('updated_at', new Date().toISOString())

  if (sets.length) {
    await db
      .prepare(`UPDATE tours SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds, id)
      .run()
  }

  const after = await db
    .prepare('SELECT * FROM tours WHERE id = ?')
    .bind(id)
    .first<TourRow>()
  if (after?.published_at) await invalidateSnapshot(env)
  return { ok: true, tour: after! }
}
