/**
 * Embedding pipeline job — Phase 1c.
 *
 * Builds the canonical embedding text for a dataset, runs it
 * through Workers AI to produce a 768-dim vector, upserts the
 * vector + metadata into Vectorize, and stamps
 * `datasets.embedding_version` to record that the row is current
 * against the active model + canonical-text version.
 *
 * Triggered by `dataset-mutations.ts` (Commit D) on publish and
 * update; the retract path calls `deleteEmbedding` directly rather
 * than enqueueing a job. Federation sync (Phase 4) will enqueue
 * the same job for newly-mirrored datasets.
 *
 * Mirrors the `sphere-thumbnail-job.ts` shape from 1b — the route
 * never invokes the job inline, it goes through the JobQueue
 * abstraction (`WaitUntilJobQueue` in production, `SyncJobQueue` /
 * `CapturingJobQueue` in tests). The job itself is intentionally
 * idempotent: three updates in a minute queue three jobs but the
 * Vectorize upsert is last-write-wins on the dataset id, and
 * `embedding_version` lands at the same value all three times.
 *
 * The job handler signature `(env, payload) => Promise<...>`
 * matches the JobQueue contract; the result type carries the
 * structured outcome so a future Phase 4 follow-on can route
 * `{ok: false, reason: 'not_found'}` to an `embed_failed` audit
 * event without re-parsing exception messages.
 */

import { getDecorations } from './catalog-store'
import {
  buildDatasetEmbeddingText,
  embedDatasetText,
  EMBEDDING_MODEL_VERSION,
  type EmbeddingEnv,
} from './embeddings'
import type { CatalogEnv } from './env'
import {
  upsertEmbedding,
  type DatasetVectorMetadata,
  type VectorizeEnv,
} from './vectorize-store'

/** Minimum binding surface the job needs from the catalog Env. */
export type EmbedDatasetEnv = CatalogEnv & EmbeddingEnv & VectorizeEnv

export interface EmbedDatasetJobPayload {
  dataset_id: string
}

export type EmbedDatasetJobResult =
  | {
      ok: true
      dataset_id: string
      embedding_version: number
      /** SHA-1 of the canonical embedding text — useful for "did the input change?" debugging. */
      text_signature: string
    }
  | {
      ok: false
      dataset_id: string
      /**
       * `not_found`     — the dataset row was deleted before the job ran.
       * `binding_missing` — `CATALOG_DB` not wired; treated as a soft skip.
       */
      reason: 'not_found' | 'binding_missing'
    }

/**
 * Row shape the job needs from D1. Narrower than the full
 * `DatasetRow` so we only depend on the columns we actually read.
 */
interface EmbedRow {
  id: string
  title: string
  abstract: string | null
  organization: string | null
  visibility: string
  origin_node: string
}

/**
 * Embed a single dataset and persist the result. Idempotent on
 * re-run — Vectorize upsert is last-write-wins on the dataset id,
 * `embedding_version` reaches the same value, and the text signature
 * stays stable for an unchanged row.
 */
export async function embedDatasetJob(
  env: EmbedDatasetEnv,
  payload: EmbedDatasetJobPayload,
): Promise<EmbedDatasetJobResult> {
  if (!env.CATALOG_DB) {
    // The job runs out of band of the request; if the binding is
    // unset we cannot recover by erroring back to the caller. Soft-
    // skip and let `console.error` in the WaitUntilJobQueue catch
    // surface the misconfig in Workers Logs.
    return { ok: false, dataset_id: payload.dataset_id, reason: 'binding_missing' }
  }

  const row = await env.CATALOG_DB
    .prepare(
      `SELECT id, title, abstract, organization, visibility, origin_node
         FROM datasets WHERE id = ? LIMIT 1`,
    )
    .bind(payload.dataset_id)
    .first<EmbedRow>()
  if (!row) {
    return { ok: false, dataset_id: payload.dataset_id, reason: 'not_found' }
  }

  const decorationsMap = await getDecorations(env.CATALOG_DB, [payload.dataset_id])
  const decorations =
    decorationsMap.get(payload.dataset_id) ??
    { tags: [], categories: [], keywords: [], developers: [], related: [] }

  const text = buildDatasetEmbeddingText(row, {
    categories: decorations.categories,
    keywords: decorations.keywords,
  })

  const values = await embedDatasetText(env, text)

  const metadata: DatasetVectorMetadata = {
    peer_id: row.origin_node,
    category: pickPrimaryCategory(decorations.categories.map(c => c.value)),
    visibility: normaliseVisibility(row.visibility),
    embedding_version: EMBEDDING_MODEL_VERSION,
  }

  await upsertEmbedding(env, {
    dataset_id: payload.dataset_id,
    values,
    metadata,
  })

  // Stamp the row LAST so a partial failure (Vectorize accepted the
  // upsert, then we crash before the UPDATE) is recoverable: the
  // row reads as "not yet embedded" and the next enqueue re-runs
  // the whole pipeline — Vectorize re-upsert is a no-op with the
  // same vector. The opposite ordering (stamp first, upsert second)
  // would falsely advertise a row as up-to-date when it isn't.
  await env.CATALOG_DB
    .prepare(`UPDATE datasets SET embedding_version = ? WHERE id = ?`)
    .bind(EMBEDDING_MODEL_VERSION, payload.dataset_id)
    .run()

  return {
    ok: true,
    dataset_id: payload.dataset_id,
    embedding_version: EMBEDDING_MODEL_VERSION,
    text_signature: await sha1Hex(text),
  }
}

/**
 * Pick the indexed category for Vectorize metadata. The plan's
 * "Index metadata" entry is singular (`category`); store the first
 * lowercased value in lexicographical order so the choice is
 * deterministic across re-indexes. Empty string when the dataset
 * has no categories (the field still indexes; filter callers that
 * pass `category: 'atmosphere'` simply won't match it).
 */
function pickPrimaryCategory(values: string[]): string {
  const cleaned = values
    .map(v => v.normalize('NFC').trim().toLowerCase())
    .filter(v => v.length > 0)
  cleaned.sort()
  return cleaned[0] ?? ''
}

/**
 * Coerce arbitrary `visibility` strings off the row to the three
 * values Vectorize metadata understands. The dataset schema's
 * CHECK constraint already restricts the column, but defending here
 * keeps a future schema relaxation from silently storing a value
 * the docent's filter cannot match.
 */
function normaliseVisibility(value: string): DatasetVectorMetadata['visibility'] {
  if (value === 'unlisted' || value === 'private') return value
  return 'public'
}

async function sha1Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s)
  const hash = await crypto.subtle.digest('SHA-1', bytes)
  const view = new Uint8Array(hash)
  let hex = ''
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0')
  return hex
}
