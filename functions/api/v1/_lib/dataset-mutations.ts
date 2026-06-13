/**
 * Publisher-API write paths for the `datasets` table.
 *
 * Pure data-access on top of D1, mirroring `catalog-store.ts` for
 * the read side. Wraps the row-mutation SQL plus the cross-cutting
 * concerns: ULID minting, slug uniqueness checks, decoration
 * upsert, role-aware visibility filters.
 *
 * Authorisation model:
 *   - `admin` and the synthetic `service` role see all rows.
 *   - `publisher` / `readonly` (and any role we don't recognise) see
 *     only rows where `publisher_id = caller.id`.
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

/**
 * Collapse undefined / null / empty / whitespace-only strings to
 * NULL on the way to D1. Used by Phase 3d's `celestial_body`
 * column so a publisher posting `""` is treated the same as
 * omission (the "Earth implicit" convention) — defense in depth
 * for both the SOS importer (which already strips empties) and
 * the future publisher-portal client.
 */
function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
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
 * Gate the `legacy_id` field to privileged callers (staff / service
 * tokens). The field is bulk-import provenance metadata; community
 * publishers have no legitimate use case for setting it, and
 * allowing it would leak existence of out-of-scope rows through
 * the unique-constraint conflict path (the 409 message includes
 * the existing dataset id). Returns a 403 outcome when an
 * unprivileged caller tries to set it; returns null when the
 * caller is allowed to proceed.
 */
function checkLegacyIdAllowed(
  publisher: PublisherRow,
  body: DatasetDraftBody,
): DraftCreateFailure | null {
  if (body.legacy_id === undefined) return null
  if (isPrivileged(publisher)) return null
  return {
    ok: false,
    status: 403,
    errors: [
      {
        field: 'legacy_id',
        code: 'forbidden',
        message: 'legacy_id may only be set by privileged publishers (staff / service token).',
      },
    ],
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

  const legacyIdGate = checkLegacyIdAllowed(publisher, body)
  if (legacyIdGate) return legacyIdGate

  const db = env.CATALOG_DB!
  const desiredSlug = body.slug ?? deriveSlug(body.title!)
  const slug = await ensureUniqueSlug(db, desiredSlug)

  const id = newUlid()
  const now = new Date().toISOString()

  // The unique partial index on `legacy_id` (migration 0008) means
  // a duplicate import would surface as a SQLite UNIQUE-constraint
  // failure. Pre-check so the importer gets a structured 409 with
  // the existing row's id rather than an opaque write error. Only
  // staff reach this branch (the privilege gate above blocks
  // community callers), so the existing-id surfaced in the message
  // isn't a cross-tenant existence leak.
  if (body.legacy_id) {
    const existing = await db
      .prepare('SELECT id FROM datasets WHERE legacy_id = ? LIMIT 1')
      .bind(body.legacy_id)
      .first<{ id: string }>()
    if (existing) {
      return {
        ok: false,
        status: 409,
        errors: [
          {
            field: 'legacy_id',
            code: 'conflict',
            message: `legacy_id "${body.legacy_id}" already imported as ${existing.id}.`,
          },
        ],
      }
    }
  }

  await db
    .prepare(
      `INSERT INTO datasets (
         id, slug, origin_node, title, abstract, organization, format, data_ref,
         thumbnail_ref, legend_ref, caption_ref, color_table_ref, website_link,
         start_time, end_time, period, weight, visibility, is_hidden, run_tour_on_load,
         license_spdx, license_url, license_statement, attribution_text,
         rights_holder, doi, citation_text, legacy_id,
         probing_info,
         bbox_n, bbox_s, bbox_w, bbox_e,
         celestial_body, radius_mi, lon_origin, is_flipped_in_y,
         schema_version, created_at, updated_at, published_at, publisher_id
       ) VALUES (?,?,(SELECT node_id FROM node_identity LIMIT 1),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      body.color_table_ref ?? null,
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
      body.legacy_id ?? null,
      // Phase 3b restored probing_info from the SOS snapshot.
      // Validated upstream as a plain JSON-stringified blob; D1
      // stores it verbatim and the serializer hands it back to
      // callers unchanged. NULL on rows that don't carry it.
      body.probing_info ?? null,
      // Phase 3d typed bbox + non-Earth metadata. NULL when
      // omitted; the serializer surfaces them only on populated
      // rows so the wire stays terse for the common case.
      body.bounding_box?.n ?? null,
      body.bounding_box?.s ?? null,
      body.bounding_box?.w ?? null,
      body.bounding_box?.e ?? null,
      // celestial_body: blank/whitespace collapses to NULL so the
      // "Earth implicit" convention is preserved on the read side.
      // (The SOS importer already strips empties, but a publisher-
      // portal caller could still post `""` and we want defense in
      // depth.)
      normalizeOptionalString(body.celestial_body),
      body.radius_mi ?? null,
      body.lon_origin ?? null,
      // is_flipped_in_y: both undefined and explicit null map to
      // NULL (the column's default state); booleans round-trip
      // through 0/1.
      body.is_flipped_in_y == null ? null : body.is_flipped_in_y ? 1 : 0,
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

  const legacyIdGate = checkLegacyIdAllowed(publisher, body)
  if (legacyIdGate) return legacyIdGate

  const db = env.CATALOG_DB!

  // Asset-coupled field guard: refuse `format` or `data_ref`
  // mutations while the row is mid-transcode. Without these an
  // editor could
  //   • swap `video/mp4` → `image/png` and end up with the
  //     workflow's eventual HLS data_ref contradicting the new
  //     format, or
  //   • paste a manual `vimeo:` / `url:` / `r2:videos/...`
  //     value into data_ref that the workflow's
  //     /transcode-complete callback will overwrite as soon as
  //     it finishes (and which any /publish or /preview hit
  //     between the manual edit and the callback would
  //     transiently surface).
  // The dataset form's UI gate already prevents both through
  // the supported path (the format radio is disabled in /W,
  // the data_ref input is replaced by a read-only notice in /Q),
  // but the server is the authoritative check — a direct API
  // call could otherwise bypass the UI. Both rejections share
  // the same 409 envelope so the client treats them uniformly.
  // PR #112 followup — dataset-form.ts:937 (server-side
  // companion) + dataset-mutations.ts (data_ref extension).
  // Capture once and reuse for both the JS pre-check below and
  // the SQL-level atomic guard further down. Without this, the
  // pre-check would SELECT and the UPDATE would not know which
  // fields were "value-actually-changing" vs same-value
  // submissions (the form re-serializes every field on save,
  // including format/data_ref, so a save that doesn't touch
  // those fields still has them in the body).
  const guardableFieldsInBody =
    body.format !== undefined || body.data_ref !== undefined
  let currentForGuard:
    | { format: string; data_ref: string; transcoding: number | null }
    | null = null
  if (guardableFieldsInBody) {
    currentForGuard =
      (await db
        .prepare('SELECT format, data_ref, transcoding FROM datasets WHERE id = ?')
        .bind(id)
        .first<{ format: string; data_ref: string; transcoding: number | null }>()) ?? null
  }
  const formatChanges =
    body.format !== undefined && currentForGuard !== null && body.format !== currentForGuard.format
  const dataRefChanges =
    body.data_ref !== undefined &&
    currentForGuard !== null &&
    body.data_ref !== currentForGuard.data_ref

  if (currentForGuard?.transcoding === 1) {
    if (formatChanges) {
      return {
        ok: false,
        status: 409,
        errors: [
          {
            field: 'format',
            code: 'transcoding_in_progress',
            message:
              'Cannot change format while a video transcode is in flight — ' +
              'the workflow will write a video data_ref into this row when it ' +
              'finishes, which would contradict the new format. Wait for the ' +
              '"Transcoding…" badge to clear, then update format.',
          },
        ],
      }
    }
    if (dataRefChanges) {
      return {
        ok: false,
        status: 409,
        errors: [
          {
            field: 'data_ref',
            code: 'transcoding_in_progress',
            message:
              'Cannot change data_ref while a video transcode is in flight — ' +
              'the workflow will overwrite it with the new HLS bundle path ' +
              'when it finishes, and a /publish or /preview hit before that ' +
              'callback would transiently surface the manual value. Wait for ' +
              'the "Transcoding…" badge to clear, then update data_ref.',
          },
        ],
      }
    }
  }

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
  if (body.color_table_ref !== undefined) set('color_table_ref', body.color_table_ref)
  if (body.probing_info !== undefined) set('probing_info', body.probing_info)
  // Phase 3d bbox + non-Earth fields. An explicit `null` body
  // value clears the column; omission leaves it untouched.
  if (body.bounding_box !== undefined) {
    set('bbox_n', body.bounding_box?.n ?? null)
    set('bbox_s', body.bounding_box?.s ?? null)
    set('bbox_w', body.bounding_box?.w ?? null)
    set('bbox_e', body.bounding_box?.e ?? null)
  }
  if (body.celestial_body !== undefined) {
    set('celestial_body', normalizeOptionalString(body.celestial_body))
  }
  if (body.radius_mi !== undefined) set('radius_mi', body.radius_mi)
  if (body.lon_origin !== undefined) set('lon_origin', body.lon_origin)
  if (body.is_flipped_in_y !== undefined) {
    set('is_flipped_in_y', body.is_flipped_in_y === null ? null : body.is_flipped_in_y ? 1 : 0)
  }
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

  // Pre-check the legacy_id partial unique index, mirroring the
  // createDataset path. Without this pre-check a duplicate value
  // would surface as a SQLite UNIQUE-constraint failure inside the
  // UPDATE, which the route layer would currently wrap as an
  // unstructured 500. Privilege-gated upstream by
  // checkLegacyIdAllowed.
  if (body.legacy_id !== undefined) {
    const conflict = await db
      .prepare('SELECT id FROM datasets WHERE legacy_id = ? AND id != ? LIMIT 1')
      .bind(body.legacy_id, id)
      .first<{ id: string }>()
    if (conflict) {
      return {
        ok: false,
        status: 409,
        errors: [
          {
            field: 'legacy_id',
            code: 'conflict',
            message: `legacy_id "${body.legacy_id}" is already imported as ${conflict.id}.`,
          },
        ],
      }
    }
    set('legacy_id', body.legacy_id)
  }

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

  // SQL-level atomic guard for the format/data_ref check above.
  // The JS pre-check fails fast with a clear error message in
  // the common case, but is TOCTOU-vulnerable: between its
  // SELECT and this UPDATE, a concurrent /asset/{upload}/complete
  // could stamp `transcoding=1`, and the UPDATE would still
  // apply the format/data_ref change. Scoping the UPDATE itself
  // to `(transcoding IS NULL OR transcoding = 0)` when those
  // fields are in the body closes the window — the SQL engine
  // evaluates the WHERE clause atomically with the SET. PR #112
  // followup — dataset-mutations.ts (TOCTOU on format/data_ref
  // guard). On 0 rows affected, return the same 409 envelope
  // the JS check produces so the client treats the two paths
  // uniformly.
  // The atomic guard only fires when format/data_ref are
  // ACTUALLY changing (different from the row's current value).
  // Submitting the same value as a no-op shouldn't trip the
  // guard — the form re-serializes every field on save, so a
  // save that doesn't touch format/data_ref still has them in
  // the body.
  const needsTranscodingGuard = formatChanges || dataRefChanges
  let whereSql = 'WHERE id = ?'
  if (needsTranscodingGuard) {
    whereSql += ' AND (transcoding IS NULL OR transcoding = 0)'
  }

  if (sets.length) {
    const result = await db
      .prepare(`UPDATE datasets SET ${sets.join(', ')} ${whereSql}`)
      .bind(...binds, id)
      .run()
    if (needsTranscodingGuard && (result.meta?.changes ?? 0) === 0) {
      // The JS pre-check passed but the UPDATE filtered the row
      // out — a concurrent stamp landed between SELECT and
      // UPDATE. Surface the same field-level 409 as the pre-
      // check so the client renders the same per-field message.
      // We don't know which of format / data_ref the publisher
      // tried to change, so attribute to whichever was in the
      // body (format wins if both).
      const field = body.format !== undefined ? 'format' : 'data_ref'
      return {
        ok: false,
        status: 409,
        errors: [
          {
            field,
            code: 'transcoding_in_progress',
            message:
              `Cannot change ${field} while a video transcode is in flight — ` +
              `a concurrent upload stamped the row between the freshness check ` +
              `and the apply step. Wait for the "Transcoding…" badge to clear, ` +
              `then retry.`,
          },
        ],
      }
    }
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

  // Refuse to publish a row whose video source is still being
  // transcoded. The detail page's UI gate already disables the
  // Publish button while `transcoding=1`, but a direct API
  // POST or a CLI call could bypass that — this server-side
  // check is the authoritative gate. For a row whose
  // `data_ref` is already pointing at a playable bundle (the
  // re-upload case on a published / retracted row), publishing
  // mid-transcode would also point public clients at the OLD
  // bundle even though the row's metadata is mid-flip; cleaner
  // to require the transcode to finish first.
  if (row.transcoding) {
    return {
      ok: false,
      status: 409,
      errors: [
        {
          field: 'transcoding',
          code: 'transcoding_in_progress',
          message:
            'Cannot publish while a video transcode is in flight. ' +
            'Wait for the workflow to finish and the "Transcoding…" ' +
            'badge to clear, then publish.',
        },
      ],
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

/**
 * Re-enqueue the embed job for an already-published dataset. Used
 * by the Phase 1d/D `--reindex` operator path: an operator that
 * wires up Vectorize after publishing some rows can backfill the
 * vector index without an unnecessary update / republish of the
 * row itself. Also handles the future model-version-bump case —
 * a one-off cron that walks every row and calls reindex.
 *
 * Returns:
 *   - 404 if the dataset isn't visible to the caller.
 *   - 409 conflict if the row is unpublished or retracted (vectors
 *     are only built for published, non-retracted rows; reindex
 *     of a draft would be a no-op).
 *   - 503 embed_unconfigured if neither Vectorize binding nor the
 *     MOCK_VECTORIZE flag is present — surfaces the operator's
 *     missing-binding configuration before they wonder why the
 *     index isn't filling.
 *   - 200 + { dataset: row } when the enqueue succeeds.
 */
export async function reindexDataset(
  env: CatalogEnv,
  publisher: PublisherRow,
  id: string,
  deps: MutationDeps = {},
): Promise<DraftCreateOutcome> {
  const row = await getDatasetForPublisher(env.CATALOG_DB!, publisher, id)
  if (!row) {
    return {
      ok: false,
      status: 404,
      errors: [{ field: 'id', code: 'not_found', message: `Dataset ${id} not found.` }],
    }
  }
  if (!row.published_at || row.retracted_at) {
    return {
      ok: false,
      status: 409,
      errors: [
        {
          field: 'status',
          code: 'not_published',
          message: 'Reindex requires a published, non-retracted dataset.',
        },
      ],
    }
  }
  if (!isEmbedConfigured(env)) {
    return {
      ok: false,
      status: 503,
      errors: [
        {
          field: 'embed',
          code: 'embed_unconfigured',
          message:
            'Embed bindings are not configured. Bind Workers AI + Vectorize ' +
            '(or set MOCK_AI=true / MOCK_VECTORIZE=true for local dev) and re-run.',
        },
      ],
    }
  }
  await enqueueEmbed(deps, env, id)
  return { ok: true, dataset: row }
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

/**
 * Hard-delete a dataset — the cleanup path the Z0 spike drafts
 * surfaced the need for (tours have had one since 3pt/G).
 * Restricted to rows that are not currently published (retract
 * first) and not mid-transcode. Removes the D1 row (decoration
 * tables cascade via their FKs), drops the docent embedding,
 * invalidates the snapshot, and best-effort deletes the row's R2
 * prefixes (`uploads/`, `videos/`, `datasets/`) so storage doesn't
 * leak with the row. Visibility gating goes through
 * `getDatasetForPublisher`, so a community publisher can only
 * delete their own rows; staff / admin / service can delete any.
 */
export async function deleteDataset(
  env: CatalogEnv,
  publisher: PublisherRow,
  id: string,
  deps: MutationDeps = {},
): Promise<
  | { ok: true; deleted_id: string }
  | { ok: false; status: number; error: string; message: string }
> {
  const db = env.CATALOG_DB!
  const row = await getDatasetForPublisher(db, publisher, id)
  if (!row) {
    return { ok: false, status: 404, error: 'not_found', message: `Dataset ${id} not found.` }
  }
  if (row.published_at && !row.retracted_at) {
    return {
      ok: false,
      status: 409,
      error: 'published',
      message: 'Retract the dataset before deleting it.',
    }
  }
  if ((row as { transcoding?: number | null }).transcoding) {
    return {
      ok: false,
      status: 409,
      error: 'transcode_in_progress',
      message: 'A transcode is in flight; wait for it to finish before deleting.',
    }
  }
  // Conditional delete re-asserts the guards atomically — a row
  // that became published or started transcoding between the
  // pre-read and this statement survives, and meta.changes tells
  // us to re-diagnose (PR #177 Copilot review, TOCTOU).
  const deleted = await db
    .prepare(
      `DELETE FROM datasets
        WHERE id = ?
          AND (published_at IS NULL OR retracted_at IS NOT NULL)
          AND (transcoding IS NULL OR transcoding = 0)`,
    )
    .bind(id)
    .run()
  if ((deleted.meta?.changes ?? 0) === 0) {
    return {
      ok: false,
      status: 409,
      error: 'conflict',
      message: 'The dataset changed state (published or transcoding) before the delete landed; refresh and retry.',
    }
  }
  await invalidateSnapshot(env)
  // Idempotent at the helper level — deleting a vector that was
  // never written (drafts are unembedded) is a no-op.
  await enqueueDeleteEmbedding(deps, env, id)
  if (env.CATALOG_R2) {
    for (const prefix of [`uploads/${id}/`, `videos/${id}/`, `datasets/${id}/`]) {
      try {
        // Bounded best-effort: a few pages per prefix. Anything
        // beyond that waits for the storage-GC job scoped in
        // docs/ZYRA_INTEGRATION_PLAN.md §Open questions — D1 is
        // the canonical "dataset exists" state and is already
        // cleared.
        for (let page = 0; page < 5; page++) {
          const listing = await env.CATALOG_R2.list({ prefix, limit: 500 })
          if (listing.objects.length === 0) break
          await Promise.all(listing.objects.map(o => env.CATALOG_R2!.delete(o.key)))
          if (!listing.truncated) break
        }
      } catch {
        // R2 hiccup must not fail the delete.
      }
    }
  }
  return { ok: true, deleted_id: id }
}
