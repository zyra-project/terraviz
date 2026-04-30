/**
 * `featured_datasets` row helpers.
 *
 * Sits between the four publisher routes (Commit F: list / add /
 * update / remove) and the table introduced in
 * `migrations/catalog/0007_featured_datasets.sql`. Pure data access;
 * authorisation lives in the route handlers.
 *
 * `position` is an integer ordering knob: lower = higher in the
 * list. The publisher API allows duplicate positions (an operator
 * UI edits one row at a time and a transient duplicate during a
 * reorder is fine); the docent's `list_featured_datasets` query
 * breaks ties deterministically by `(position ASC, added_at ASC)`.
 */

import type { PublisherRow } from './publisher-store'
import type { DatasetRow, DecorationRows } from './catalog-store'
import { getDecorations } from './catalog-store'
import { resolveAssetRef } from './r2-public-url'
import type { CatalogEnv } from './env'

export interface FeaturedRow {
  dataset_id: string
  position: number
  added_by: string
  added_at: string
}

/** List the featured set in display order. */
export async function listFeaturedDatasets(
  db: D1Database,
  options: { limit?: number } = {},
): Promise<FeaturedRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  const result = await db
    .prepare(
      `SELECT dataset_id, position, added_by, added_at
         FROM featured_datasets
        ORDER BY position ASC, added_at ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<FeaturedRow>()
  return result.results ?? []
}

export interface AddFeaturedInput {
  dataset_id: string
  position: number
}

export type AddOutcome =
  | { ok: true; row: FeaturedRow }
  | { ok: false; status: number; error: string; message: string }

/**
 * Add a dataset to the featured list. Refuses non-existent datasets
 * (404), and refuses if the dataset is already featured (409 — the
 * caller should PUT to update position instead).
 *
 * Race-safe: two concurrent first-adds for the same dataset both
 * pass the existence check, but only one wins the
 * `ON CONFLICT(dataset_id) DO NOTHING` insert; the loser detects
 * `changes === 0` and returns a clean 409 instead of letting the
 * UNIQUE constraint surface as a 500.
 */
export async function addFeaturedDataset(
  db: D1Database,
  publisher: PublisherRow,
  input: AddFeaturedInput,
  now: string = new Date().toISOString(),
): Promise<AddOutcome> {
  const dataset = await db
    .prepare(`SELECT id FROM datasets WHERE id = ? LIMIT 1`)
    .bind(input.dataset_id)
    .first<{ id: string }>()
  if (!dataset) {
    return {
      ok: false,
      status: 404,
      error: 'not_found',
      message: `Dataset ${input.dataset_id} not found.`,
    }
  }

  const result = await db
    .prepare(
      `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(dataset_id) DO NOTHING`,
    )
    .bind(input.dataset_id, input.position, publisher.id, now)
    .run()

  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0
  if (changes === 0) {
    return {
      ok: false,
      status: 409,
      error: 'already_featured',
      message: `Dataset ${input.dataset_id} is already in the featured list. Use PUT to update its position.`,
    }
  }

  return {
    ok: true,
    row: { dataset_id: input.dataset_id, position: input.position, added_by: publisher.id, added_at: now },
  }
}

export type UpdateOutcome =
  | { ok: true; row: FeaturedRow }
  | { ok: false; status: number; error: string; message: string }

/** Update an existing featured row's position. 404 if not present. */
export async function updateFeaturedPosition(
  db: D1Database,
  datasetId: string,
  position: number,
): Promise<UpdateOutcome> {
  const existing = await db
    .prepare(`SELECT * FROM featured_datasets WHERE dataset_id = ? LIMIT 1`)
    .bind(datasetId)
    .first<FeaturedRow>()
  if (!existing) {
    return {
      ok: false,
      status: 404,
      error: 'not_found',
      message: `Dataset ${datasetId} is not in the featured list.`,
    }
  }
  await db
    .prepare(`UPDATE featured_datasets SET position = ? WHERE dataset_id = ?`)
    .bind(position, datasetId)
    .run()
  return { ok: true, row: { ...existing, position } }
}

/** Remove a dataset from the featured list. Idempotent: returns true even if absent. */
export async function removeFeaturedDataset(
  db: D1Database,
  datasetId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM featured_datasets WHERE dataset_id = ?`)
    .bind(datasetId)
    .run()
}

/** Validate a position integer body field. */
export function validatePosition(value: unknown): { ok: true; position: number } | { ok: false; message: string } {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, message: 'position must be an integer.' }
  }
  if (value < 0 || value > 1_000_000) {
    return { ok: false, message: 'position must be between 0 and 1_000_000.' }
  }
  return { ok: true, position: value }
}

// ---------------------------------------------------------------------------
// Docent-shaped read surface
//
// `listFeaturedDatasets` above returns the curation rows (id +
// position + provenance). The docent's `list_featured_datasets`
// tool wants something different: a small payload it can suggest
// in chat — id + title + abstract_snippet + thumbnail_url +
// categories. The two surfaces share the curation table; only the
// shape they return differs.
//
// The hydration drops featured rows whose dataset is currently
// retracted / hidden / un-published / non-public — the curation
// row stays put for the publisher portal to manage, but the
// docent does not surface tombstones to the user.
// ---------------------------------------------------------------------------

/** Max characters in `abstract_snippet`. Matches `search-datasets.ts`. */
const FEATURED_ABSTRACT_SNIPPET_MAX = 280

/** Default page size when the caller does not specify a limit. */
export const FEATURED_DOCENT_DEFAULT_LIMIT = 6

/** Hard ceiling on the docent surface so the LLM payload stays small. */
export const FEATURED_DOCENT_MAX_LIMIT = 24

export interface FeaturedDatasetHit {
  id: string
  title: string
  abstract_snippet: string
  /**
   * Equirectangular sphere thumbnail when one exists, else the
   * dataset's flat thumbnail, else null. The docent UI prefers the
   * sphere variant for its mini-globe rendering.
   */
  thumbnail_url: string | null
  categories: string[]
  /** Curation order — lower is higher in the list. */
  position: number
}

export interface FeaturedDocentResult {
  datasets: FeaturedDatasetHit[]
}

/**
 * Read the operator's featured set in display order, hydrate each
 * row to the docent payload shape, and drop anything that isn't
 * currently visible to the public catalog. Used by the public
 * `/api/v1/featured` endpoint and (via that URL) by the docent's
 * `list_featured_datasets` tool.
 */
export async function listFeaturedForDocent(
  env: CatalogEnv,
  options: { limit?: number } = {},
): Promise<FeaturedDocentResult> {
  if (!env.CATALOG_DB) return { datasets: [] }
  const db = env.CATALOG_DB

  const limit = clampDocentLimit(options.limit)

  // Fetch a few extra curation rows so dropping un-visible datasets
  // doesn't shrink the page below `limit` when the operator has
  // featured a row that's currently retracted. Cap on the raw read
  // is twice the requested limit (or 50, whichever is smaller) —
  // beyond that the publisher portal needs to clean up stale picks.
  const rawCap = Math.min(limit * 2, 50)
  const featured = await listFeaturedDatasets(db, { limit: rawCap })
  if (featured.length === 0) return { datasets: [] }

  const ids = featured.map(r => r.dataset_id)
  const placeholders = ids.map(() => '?').join(',')
  const rowResult = await db
    .prepare(
      `SELECT * FROM datasets
        WHERE id IN (${placeholders})
          AND visibility = 'public'
          AND is_hidden = 0
          AND retracted_at IS NULL
          AND published_at IS NOT NULL`,
    )
    .bind(...ids)
    .all<DatasetRow>()
  const rowMap = new Map<string, DatasetRow>()
  for (const r of rowResult.results ?? []) rowMap.set(r.id, r)

  const decorationMap = await getDecorations(db, ids)

  const datasets: FeaturedDatasetHit[] = []
  for (const f of featured) {
    if (datasets.length >= limit) break
    const row = rowMap.get(f.dataset_id)
    if (!row) continue
    const decorations =
      decorationMap.get(f.dataset_id) ??
      ({ tags: [], categories: [], keywords: [], developers: [], related: [] } as DecorationRows)
    datasets.push({
      id: row.id,
      title: row.title,
      abstract_snippet: snippetFor(row.abstract),
      thumbnail_url: pickThumbnailUrl(env, row),
      categories: extractCategoryValues(decorations),
      position: f.position,
    })
  }

  return { datasets }
}

function clampDocentLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return FEATURED_DOCENT_DEFAULT_LIMIT
  if (limit < 1) return 1
  return Math.min(Math.floor(limit), FEATURED_DOCENT_MAX_LIMIT)
}

function snippetFor(abstract: string | null): string {
  if (!abstract) return ''
  const collapsed = abstract.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= FEATURED_ABSTRACT_SNIPPET_MAX) return collapsed
  return collapsed.slice(0, FEATURED_ABSTRACT_SNIPPET_MAX - 1).trimEnd() + '…'
}

function pickThumbnailUrl(env: CatalogEnv, row: DatasetRow): string | null {
  // Prefer the sphere variant — the docent's mini-globe widget is
  // the visual receiver. Fall back to the flat thumbnail (legacy
  // SOS rows + un-regenerated datasets) when the sphere is missing.
  return resolveAssetRef(env, row.sphere_thumbnail_ref) ?? resolveAssetRef(env, row.thumbnail_ref)
}

function extractCategoryValues(decorations: DecorationRows): string[] {
  const seen = new Set<string>()
  for (const c of decorations.categories) {
    const v = c.value.trim()
    if (v) seen.add(v)
  }
  return [...seen]
}
