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
