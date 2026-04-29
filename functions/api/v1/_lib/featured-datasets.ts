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

  const existing = await db
    .prepare(`SELECT dataset_id FROM featured_datasets WHERE dataset_id = ?`)
    .bind(input.dataset_id)
    .first<{ dataset_id: string }>()
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: 'already_featured',
      message: `Dataset ${input.dataset_id} is already in the featured list. Use PUT to update its position.`,
    }
  }

  await db
    .prepare(
      `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(input.dataset_id, input.position, publisher.id, now)
    .run()

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
