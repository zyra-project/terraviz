/**
 * Publisher-API write paths for the `datasets` table.
 *
 * Pure data-access on top of D1, mirroring `catalog-store.ts` for
 * the read side. Wraps the row-mutation SQL plus the cross-cutting
 * concerns: ULID minting, slug uniqueness checks, decoration
 * upsert, role-aware visibility filters.
 *
 * Authorisation model (Phase 1a):
 *   - `staff` and the synthetic `service` role see all rows.
 *   - `community` (and any role we don't recognise) see only rows
 *     where `publisher_id = caller.id`.
 *   - `is_admin = 1` is staff-equivalent (used by dev-bypass).
 *
 * Phase 1a is metadata-only: `data_ref` / `thumbnail_ref` /
 * `legend_ref` / `caption_ref` are bare strings supplied by the
 * caller (typically the CLI). Asset upload + content-digest
 * verification land in Phase 1b.
 */

import { type PublisherRow, isPrivileged } from './publisher-store'
import type { DatasetRow } from './catalog-store'
import { invalidateSnapshot } from './snapshot'
import type { CatalogEnv } from './env'
import { newUlid } from './ulid'
import {
  deriveSlug,
  validateDraftCreate,
  validateDraftUpdate,
  validateForPublish,
  type DatasetDraftBody,
  type ValidationError,
} from './validators'
import type { JobQueue } from './job-queue'
import {
  embedDatasetJob,
  type EmbedDatasetEnv,
  type EmbedDatasetJobPayload,
} from './embed-dataset-job'
import { deleteEmbedding } from './vectorize-store'

/**
 * Optional dependencies the mutation functions accept so the route
 * layer can wire post-response background work (`WaitUntilJobQueue`)
 * and tests can inject a `CapturingJobQueue` to assert on enqueue
 * shape without exercising the job body.
 *
 * `jobQueue` carries the embed / delete-embedding work for Phase 1c.
 * When omitted, mutations run their D1 + KV side effects only;
 * embedding work is silently skipped. That keeps the existing
 * pre-1c test surface working unchanged and makes the integration
 * opt-in at the route layer.
 */
export interface MutationDeps {
  jobQueue?: JobQueue
}

/** Job-queue task name for embed work. Stable across phases. */
export const EMBED_JOB_NAME = 'embed_dataset'

/** Job-queue task name for vector deletion. */
export const DELETE_EMBEDDING_JOB_NAME = 'delete_dataset_embedding'

interface DeleteEmbeddingJobPayload {
  dataset_id: string
}

/**
 * Whether the embed pipeline has the bindings (or mock flags) it
 * needs to do its work. When false, the enqueue helpers return
 * early without scheduling a job — a deploy that hasn't wired
 * Vectorize / Workers AI yet keeps publishing and retracting
 * normally, with only the docent's search surface degraded.
 *
 * Exported for the route layer's test injection point and for
 * future operator-side health-check endpoints.
 */
export function isEmbedConfigured(env: CatalogEnv): boolean {
  const haveAi = env.AI != null || env.MOCK_AI === 'true'
  const haveVec = env.CATALOG_VECTORIZE != null || env.MOCK_VECTORIZE === 'true'
  return haveAi && haveVec
}

async function enqueueEmbed(
  deps: MutationDeps,
  env: CatalogEnv,
  datasetId: string,
): Promise<void> {
  if (!deps.jobQueue) return
  if (!isEmbedConfigured(env)) return
  await deps.jobQueue.enqueue<EmbedDatasetJobPayload>(
    EMBED_JOB_NAME,
    (jobEnv, payload) => embedDatasetJob(jobEnv as EmbedDatasetEnv, payload),
    { dataset_id: datasetId },
  )
}

async function enqueueDeleteEmbedding(
  deps: MutationDeps,
  env: CatalogEnv,
  datasetId: string,
): Promise<void> {
  if (!deps.jobQueue) return
  // Vector deletion needs only the Vectorize binding; AI is irrelevant
  // here. Still gate on the binding so a Vectorize-less deploy doesn't
  // log a ConfigurationError on every retract.
  const haveVec = env.CATALOG_VECTORIZE != null || env.MOCK_VECTORIZE === 'true'
  if (!haveVec) return
  await deps.jobQueue.enqueue<DeleteEmbeddingJobPayload>(
    DELETE_EMBEDDING_JOB_NAME,
    (jobEnv, payload) => deleteEmbedding(jobEnv as CatalogEnv, payload.dataset_id),
    { dataset_id: datasetId },
  )
}

export interface DraftCreateResult {
  ok: true
  dataset: DatasetRow
}
export interface DraftCreateFailure {
  ok: false
  status: number
  errors: ValidationError[]
}
export type DraftCreateOutcome = DraftCreateResult | DraftCreateFailure

/**
 * Apply the role-aware visibility predicate to an existing query.
 * Returns the WHERE fragment + binds to splice into the caller's
 * SQL. The fragment is a no-op (`'1=1'`) for privileged callers so
 * the caller can keep the SQL shape uniform.
 */
function publisherScope(publisher: PublisherRow): { sql: string; binds: unknown[] } {
  if (isPrivileged(publisher)) return { sql: '1=1', binds: [] }
  return { sql: 'publisher_id = ?', binds: [publisher.id] }
}

export interface ListOptions {
  status?: 'draft' | 'published' | 'retracted'
  limit?: number
  cursor?: string
}

export async function listDatasetsForPublisher(
  db: D1Database,
  publisher: PublisherRow,
  options: ListOptions = {},
): Promise<{ datasets: DatasetRow[]; next_cursor: string | null }> {
  const where: string[] = []
  const binds: unknown[] = []

  const scope = publisherScope(publisher)
  where.push(scope.sql)
  binds.push(...scope.binds)

  if (options.status === 'draft') {
    where.push('published_at IS NULL AND retracted_at IS NULL')
  } else if (options.status === 'published') {
    where.push('published_at IS NOT NULL AND retracted_at IS NULL')
  } else if (options.status === 'retracted') {
    where.push('retracted_at IS NOT NULL')
  }

  if (options.cursor) {
    where.push('id > ?')
    binds.push(options.cursor)
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const sql = `
    SELECT * FROM datasets
    WHERE ${where.join(' AND ')}
    ORDER BY id ASC
    LIMIT ?
  `
  const result = await db
    .prepare(sql)
    .bind(...binds, limit + 1)
    .all<DatasetRow>()
  const rows = result.results ?? []
  const hasMore = rows.length > limit
  const datasets = hasMore ? rows.slice(0, limit) : rows
  const next_cursor = hasMore ? datasets[datasets.length - 1].id : null
  return { datasets, next_cursor }
}

export async function getDatasetForPublisher(
  db: D1Database,
  publisher: PublisherRow,
  id: string,
): Promise<DatasetRow | null> {
  const scope = publisherScope(publisher)
  const row = await db
    .prepare(`SELECT * FROM datasets WHERE id = ? AND ${scope.sql} LIMIT 1`)
    .bind(id, ...scope.binds)
    .first<DatasetRow>()
  return row ?? null
}

async function slugInUse(db: D1Database, slug: string, excludingId?: string): Promise<boolean> {
  const sql = excludingId
    ? 'SELECT id FROM datasets WHERE slug = ? AND id != ? LIMIT 1'
    : 'SELECT id FROM datasets WHERE slug = ? LIMIT 1'
  const binds = excludingId ? [slug, excludingId] : [slug]
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ id: string }>()
  return row != null
}

async function ensureUniqueSlug(
  db: D1Database,
  desired: string,
  excludingId?: string,
): Promise<string> {
  let candidate = desired
  let n = 1
  while (await slugInUse(db, candidate, excludingId)) {
    n++
    candidate = `${desired}-${n}`.slice(0, 64)
    if (n > 100) throw new Error('Could not allocate a unique slug')
  }
  return candidate
}

async function replaceDecorations(
  db: D1Database,
  id: string,
  body: DatasetDraftBody,
): Promise<void> {
  // Replace-all semantics: a missing field clears the decoration,
  // a present field overwrites. The CLI sends the full set on each
  // PUT so a partial patch on the wire never silently drops rows it
  // didn't include.
  if (body.categories !== undefined) {
    await db.prepare('DELETE FROM dataset_categories WHERE dataset_id = ?').bind(id).run()
    for (const [facet, values] of Object.entries(body.categories ?? {})) {
      for (const v of values) {
        await db
          .prepare(
            'INSERT INTO dataset_categories (dataset_id, facet, value) VALUES (?, ?, ?)',
          )
          .bind(id, facet, v)
          .run()
      }
    }
  }
  if (body.keywords !== undefined) {
    await db.prepare('DELETE FROM dataset_keywords WHERE dataset_id = ?').bind(id).run()
    for (const k of body.keywords ?? []) {
      await db
        .prepare('INSERT INTO dataset_keywords (dataset_id, keyword) VALUES (?, ?)')
        .bind(id, k)
        .run()
    }
  }
  if (body.tags !== undefined) {
    await db.prepare('DELETE FROM dataset_tags WHERE dataset_id = ?').bind(id).run()
    for (const t of body.tags ?? []) {
      await db
        .prepare('INSERT INTO dataset_tags (dataset_id, tag) VALUES (?, ?)')
        .bind(id, t)
        .run()
    }
  }
}

/**
 * Insert a new draft dataset. Returns either the inserted row
 * (`ok: true`) or a 4xx outcome with validation errors.
 */
export async function createDataset(
  env: CatalogEnv,
  publisher: PublisherRow,
  body: DatasetDraftBody,
): Promise<DraftCreateOutcome> {
  const errors = validateDraftCreate(body)
  if (errors.length) return { ok: false, status: 400, errors }

  const db = env.CATALOG_DB!
  const desiredSlug = body.slug ?? deriveSlug(body.title!)
  const slug = await ensureUniqueSlug(db, desiredSlug)

  const id = newUlid()
  const now = new Date().toISOString()

  await db
    .prepare(
      `INSERT INTO datasets (
         id, slug, origin_node, title, abstract, organization, format, data_ref,
         thumbnail_ref, legend_ref, caption_ref, website_link,
         start_time, end_time, period, weight, visibility, is_hidden, run_tour_on_load,
         license_spdx, license_url, license_statement, attribution_text,
         rights_holder, doi, citation_text,
         schema_version, created_at, updated_at, published_at, publisher_id
       ) VALUES (?,?,(SELECT node_id FROM node_identity LIMIT 1),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      slug,
      body.title,
      body.abstract ?? null,
      body.organization ?? null,
      body.format,
      // The schema declares data_ref NOT NULL because production
      // rows always carry a backing reference. Drafts allow it to
      // be empty so the publisher can fill it in before flipping
      // to published — the publish-readiness validator refuses
      // empty data_ref.
      body.data_ref ?? '',
      body.thumbnail_ref ?? null,
      body.legend_ref ?? null,
      body.caption_ref ?? null,
      body.website_link ?? null,
      body.start_time ?? null,
      body.end_time ?? null,
      body.period ?? null,
      body.weight ?? 0,
      body.visibility ?? 'public',
      body.is_hidden ? 1 : 0,
      body.run_tour_on_load ?? null,
      body.license_spdx ?? null,
      body.license_url ?? null,
      body.license_statement ?? null,
      body.attribution_text ?? null,
      body.rights_holder ?? null,
      body.doi ?? null,
      body.citation_text ?? null,
      1,
      now,
      now,
      null,
      publisher.id,
    )
    .run()

  await replaceDecorations(db, id, body)

  const row = await db
    .prepare('SELECT * FROM datasets WHERE id = ?')
    .bind(id)
    .first<DatasetRow>()
  return { ok: true, dataset: row! }
}

/**
 * Patch an existing draft (or published) dataset. The handler
 * pre-checks ownership via `getDatasetForPublisher`; this function
 * trusts the caller has already proven access.
 */
export async function updateDataset(
  env: CatalogEnv,
  publisher: PublisherRow,
  id: string,
  body: DatasetDraftBody,
  deps: MutationDeps = {},
): Promise<DraftCreateOutcome> {
  const errors = validateDraftUpdate(body)
  if (errors.length) return { ok: false, status: 400, errors }
  const db = env.CATALOG_DB!

  const sets: string[] = []
  const binds: unknown[] = []
  function set(col: string, v: unknown): void {
    sets.push(`${col} = ?`)
    binds.push(v)
  }

  if (body.title !== undefined) set('title', body.title)
  if (body.abstract !== undefined) set('abstract', body.abstract)
  if (body.organization !== undefined) set('organization', body.organization)
  if (body.format !== undefined) set('format', body.format)
  if (body.data_ref !== undefined) set('data_ref', body.data_ref)
  if (body.thumbnail_ref !== undefined) set('thumbnail_ref', body.thumbnail_ref)
  if (body.legend_ref !== undefined) set('legend_ref', body.legend_ref)
  if (body.caption_ref !== undefined) set('caption_ref', body.caption_ref)
  if (body.website_link !== undefined) set('website_link', body.website_link)
  if (body.start_time !== undefined) set('start_time', body.start_time)
  if (body.end_time !== undefined) set('end_time', body.end_time)
  if (body.period !== undefined) set('period', body.period)
  if (body.weight !== undefined) set('weight', body.weight)
  if (body.visibility !== undefined) set('visibility', body.visibility)
  if (body.is_hidden !== undefined) set('is_hidden', body.is_hidden ? 1 : 0)
  if (body.run_tour_on_load !== undefined) set('run_tour_on_load', body.run_tour_on_load)
  if (body.license_spdx !== undefined) set('license_spdx', body.license_spdx)
  if (body.license_url !== undefined) set('license_url', body.license_url)
  if (body.license_statement !== undefined) set('license_statement', body.license_statement)
  if (body.attribution_text !== undefined) set('attribution_text', body.attribution_text)
  if (body.rights_holder !== undefined) set('rights_holder', body.rights_holder)
  if (body.doi !== undefined) set('doi', body.doi)
  if (body.citation_text !== undefined) set('citation_text', body.citation_text)

  if (body.slug !== undefined) {
    const unique = await ensureUniqueSlug(db, body.slug!, id)
    if (unique !== body.slug) {
      return {
        ok: false,
        status: 409,
        errors: [{ field: 'slug', code: 'conflict', message: `Slug "${body.slug}" is in use.` }],
      }
    }
    set('slug', unique)
  }

  set('updated_at', new Date().toISOString())

  if (sets.length) {
    await db
      .prepare(`UPDATE datasets SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds, id)
      .run()
  }
  await replaceDecorations(db, id, body)

  // If the row is currently published, mutating it changes what
  // public consumers see — invalidate the snapshot so the next
  // `/api/v1/catalog` read sees the change, and re-embed so the
  // docent's vector index reflects the new title / abstract /
  // categories / keywords / organization. Drafts are not embedded;
  // they're not searchable until publish.
  const after = await db
    .prepare('SELECT * FROM datasets WHERE id = ?')
    .bind(id)
    .first<DatasetRow>()
  if (after?.published_at && !after.retracted_at) {
    await invalidateSnapshot(env)
    await enqueueEmbed(deps, env, id)
  }
  return { ok: true, dataset: after! }
}

/**
 * Stamp `published_at` on a draft, after running the
 * publish-readiness validator over the row's current shape.
 * Invalidates the catalog snapshot so the next read pulls the new
 * state.
 */
export async function publishDataset(
  env: CatalogEnv,
  id: string,
  deps: MutationDeps = {},
): Promise<DraftCreateOutcome> {
  const db = env.CATALOG_DB!
  const row = await db
    .prepare('SELECT * FROM datasets WHERE id = ?')
    .bind(id)
    .first<DatasetRow>()
  if (!row) {
    return {
      ok: false,
      status: 404,
      errors: [{ field: 'id', code: 'not_found', message: `Dataset ${id} not found.` }],
    }
  }

  const errors = validateForPublish({
    title: row.title,
    slug: row.slug,
    format: row.format,
    data_ref: row.data_ref ?? undefined,
    visibility: row.visibility,
    license_spdx: row.license_spdx ?? undefined,
    license_statement: row.license_statement ?? undefined,
    abstract: row.abstract ?? undefined,
  })
  if (errors.length) return { ok: false, status: 400, errors }

  const now = new Date().toISOString()
  await db
    .prepare(
      `UPDATE datasets SET published_at = ?, retracted_at = NULL, updated_at = ? WHERE id = ?`,
    )
    .bind(now, now, id)
    .run()
  await invalidateSnapshot(env)
  // Publication makes the row searchable — embed it so the docent's
  // vector index covers it on the next search.
  await enqueueEmbed(deps, env, id)

  const after = await db
    .prepare('SELECT * FROM datasets WHERE id = ?')
    .bind(id)
    .first<DatasetRow>()
  return { ok: true, dataset: after! }
}

export async function retractDataset(
  env: CatalogEnv,
  id: string,
  deps: MutationDeps = {},
): Promise<DraftCreateOutcome> {
  const db = env.CATALOG_DB!
  const row = await db
    .prepare('SELECT * FROM datasets WHERE id = ?')
    .bind(id)
    .first<DatasetRow>()
  if (!row) {
    return {
      ok: false,
      status: 404,
      errors: [{ field: 'id', code: 'not_found', message: `Dataset ${id} not found.` }],
    }
  }
  const now = new Date().toISOString()
  await db
    .prepare('UPDATE datasets SET retracted_at = ?, updated_at = ? WHERE id = ?')
    .bind(now, now, id)
    .run()
  await invalidateSnapshot(env)
  // Drop the row from the docent's vector index so retracted
  // datasets don't surface in search results. Idempotent at the
  // helper level — re-retracting an already-deleted vector is a
  // no-op.
  await enqueueDeleteEmbedding(deps, env, id)
  const after = await db
    .prepare('SELECT * FROM datasets WHERE id = ?')
    .bind(id)
    .first<DatasetRow>()
  return { ok: true, dataset: after! }
}
