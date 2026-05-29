/**
 * D1 reader functions for the catalog tables.
 *
 * Pure data-access layer: every function takes a `D1Database` and
 * returns plain rows or row sets. Serialization to the wire shape
 * lives in `dataset-serializer.ts`; KV caching lives in
 * `snapshot.ts`. Keeping the three concerns separate means the
 * test for each is tight (a mocked D1 here, a row → JSON unit test
 * in the serializer, a KV map fake for the snapshot).
 *
 * The cloud-portability goal in CATALOG_BACKEND_PLAN.md ("storage
 * interfaces extracted to `_lib/`") will eventually wrap these in
 * a `catalogStore` interface so a Postgres or other backend can
 * slot in. Phase 1a leaves the functions as direct D1 calls and
 * expects the interface extraction to happen as a Phase-6
 * mechanical refactor.
 */

import { newUlid } from './ulid'

export interface DatasetRow {
  id: string
  slug: string
  origin_node: string
  title: string
  abstract: string | null
  organization: string | null
  format: string
  data_ref: string
  thumbnail_ref: string | null
  sphere_thumbnail_ref: string | null
  sphere_thumbnail_ref_lg: string | null
  legend_ref: string | null
  caption_ref: string | null
  website_link: string | null
  start_time: string | null
  end_time: string | null
  period: string | null
  weight: number
  visibility: string
  is_hidden: number
  run_tour_on_load: string | null
  license_spdx: string | null
  license_url: string | null
  license_statement: string | null
  attribution_text: string | null
  rights_holder: string | null
  doi: string | null
  citation_text: string | null
  schema_version: number
  created_at: string
  updated_at: string
  published_at: string | null
  retracted_at: string | null
  publisher_id: string | null
  /**
   * Idempotency key for upstream-imported rows (e.g. the Phase 1d
   * SOS bulk import populates this with the snapshot's
   * `INTERNAL_SOS_*` id). NULL for publisher-created drafts.
   */
  legacy_id: string | null
  /** Fourth auxiliary-asset URL: the color ramp used by
   * interactive probing. Distinct from `legend_ref` in ~2 of 14
   * overlapping rows. Phase 3b restored this from the SOS
   * snapshot via migration 0009. NULL on rows that don't ship one. */
  color_table_ref: string | null
  /** JSON-stringified probing metadata
   * (`{ units, minVal, maxVal, minPos, maxPos }`) recovered from
   * the SOS snapshot. The SPA-side probe tooltip is a separate
   * downstream change; this column just persists the data. */
  probing_info: string | null
  /** Geographic bounding box (NSWE in degrees) for the dataset's
   * spatial extent. Phase 3d promoted these from the legacy
   * `bounding_variables` JSON column to typed REALs; consumers
   * MUST read the typed fields. NULL on rows with global extent.
   * Validation: n/s in [-90, 90], w/e in [-180, 180], n >= s.
   * The SPA's regional projection feature (Phase 3e) wraps the
   * dataset texture to this bbox; rows with all four NULL get
   * the legacy global-equirectangular treatment. */
  bbox_n: number | null
  bbox_s: number | null
  bbox_w: number | null
  bbox_e: number | null
  /** Celestial body the dataset visualises. NULL means Earth (the
   * common case). Non-Earth values surface as a SPA hint to swap
   * the base globe texture (Phase 3e). Verbatim SOS strings —
   * the snapshot includes Mars / Moon / Sun / Jupiter / Saturn /
   * Mercury / Venus / Pluto / Neptune / Uranus / Io / Europa /
   * Ganymede / Callisto / Enceladus / Titan / 67p / aurora /
   * Trappist-1d / Kepler-10b. */
  celestial_body: string | null
  /** Radius of the celestial body in miles, when non-Earth.
   * Paired with `celestial_body` for proportional sizing. NULL
   * when celestial_body is NULL (Earth's default radius is
   * implicit). */
  radius_mi: number | null
  /** Globe longitude rotation reference in degrees. NULL means 0
   * (prime-meridian-centered). 12 SOS rows use ±180 for
   * Pacific-focused datasets where the dateline reads better as
   * the visual center. */
  lon_origin: number | null
  /** Boolean (0/1) image-orientation flag. NULL means 0 (no flip).
   * Zero rows use this in the current SOS snapshot; persisted for
   * future publishers whose imagery uses inverted Y conventions. */
  is_flipped_in_y: number | null
  /** Boolean (0/1) flag set by the video-upload /complete handler
   * when a `source.mp4` lands in R2 and a GHA transcode dispatch
   * fires (Phase 3pd). The workflow clears the flag and writes
   * `data_ref = r2:videos/{id}/{upload_id}/master.m3u8` (per-
   * upload-versioned so a re-upload doesn't clobber a still-
   * playing bundle) when the HLS bundle is ready. The portal
   * renders a "Transcoding…" badge and gates the publish button
   * while this is set. NULL on every other row. Migration 0011. */
  transcoding: number | null
  /** ULID of the asset_uploads row whose GHA workflow currently
   * owns the row's transcoding stamp. Set in lockstep with
   * `transcoding=1` by the /asset/.../complete handler; verified
   * by /transcode-complete before applying the workflow's callback
   * so two overlapping uploads can't race their PATCHes against
   * each other (see migration 0012). NULL when `transcoding` is
   * NULL. Migration 0012. */
  active_transcode_upload_id: string | null
  /** Number of source frames for an image-sequence-source video
   *  dataset (Phase 3pf). NULL for MP4-source video, image, and
   *  tour rows. Populated by /complete when stamping
   *  `transcoding=1`; the manifest serializer reads it to surface
   *  the frames-as-data envelope in Phase 3pg. Migration 0014. */
  frame_count: number | null
  /** File extension on each per-frame R2 key — `png` / `jpg` /
   *  `webp` matching the `extForMime` convention. Paired with
   *  `frame_count`; populated by /complete and read by the
   *  manifest serializer to build the `urlTemplate`. NULL on
   *  non-sequence rows. Migration 0014. */
  frame_extension: string | null
  /** R2 key of the auxiliary JSON blob recording the publisher's
   *  original frame filenames in encode order. Surfaced by the
   *  frames-as-data API (Phase 3pg) as `originalFilename` on
   *  /frames responses for tooling that needs to map back to the
   *  publisher's on-disk convention. NULL on non-sequence rows.
   *  Migration 0014. */
  frame_source_filenames_ref: string | null
  /** SHA-256 of the asset's *delivered bytes*. Carried for
   * single-blob assets (R2 images, captions, legends) where one
   * hash describes the whole object. Always NULL for HLS bundles:
   * those are many segment files plus variant manifests, and the
   * pipeline tracks per-segment integrity via the master manifest
   * rather than a single bundle-wide hash. `clearTranscoding`
   * (`asset-uploads.ts`) explicitly NULLs this column when a
   * video transcode lands, atomically with the `data_ref` swap
   * (PR #112 followup — 3pd-followup/Z). Also NULL when the row
   * predates Phase 1b content-digest verification or when the
   * pipeline trusts an upstream-provided source digest instead.
   * Phase 1b. */
  content_digest: string | null
  /** SHA-256 of the publisher's *source upload* (the MP4 they
   * dropped into the portal uploader, before any transcoding).
   * Set at /asset/{upload_id}/complete time and round-trips into
   * the GHA workflow's repository_dispatch payload so the runner
   * can re-verify before encoding. NULL on rows that never went
   * through the source-upload flow. */
  source_digest: string | null
}

export interface DecorationRows {
  tags: string[]
  categories: Array<{ facet: string; value: string }>
  keywords: string[]
  developers: Array<{ role: string; name: string; affiliation_url: string | null }>
  related: Array<{ related_title: string; related_url: string }>
}

export interface NodeIdentityRow {
  node_id: string
  display_name: string
  base_url: string
  description: string | null
  contact_email: string | null
  public_key: string
  created_at: string
}

/**
 * The single-row catalog identity. Returns null on a fresh
 * deployment that hasn't run `npm run gen:node-key` yet (Commit D);
 * the read endpoints surface that as a 503 with a clear message.
 */
export async function getNodeIdentity(db: D1Database): Promise<NodeIdentityRow | null> {
  return db
    .prepare(
      `SELECT node_id, display_name, base_url, description, contact_email, public_key, created_at
       FROM node_identity LIMIT 1`,
    )
    .first<NodeIdentityRow>()
}

export interface NodeIdentityInput {
  display_name: string
  base_url: string
  description?: string | null
  contact_email?: string | null
  /** Required on first provision (the column is NOT NULL). On an
   *  update, omit to keep the existing key. */
  public_key?: string
}

/**
 * Provision or update the single `node_identity` row.
 *
 * Migrations create the table but never seed it, and the local
 * `db:seed` / `gen:node-key` paths only touch the on-disk dev D1 —
 * so on a remote deploy this row has to be created out-of-band
 * before `/.well-known/terraviz.json` resolves and before any
 * publish (dataset inserts read `node_id` from here for the
 * NOT NULL `origin_node`). This is the server-side primitive behind
 * the `terraviz init-node` CLI command.
 *
 * Idempotent: an existing row is updated in place and its
 * `node_id` / `created_at` are preserved, so dataset `origin_node`
 * references stay valid. `public_key` is only overwritten when a new
 * one is supplied. A fresh provision requires `public_key` (the
 * column is NOT NULL); the caller validates and surfaces a typed
 * error before reaching here.
 */
export async function upsertNodeIdentity(
  db: D1Database,
  input: NodeIdentityInput,
): Promise<NodeIdentityRow> {
  const existing = await getNodeIdentity(db)
  if (existing) {
    await db
      .prepare(
        `UPDATE node_identity
           SET display_name = ?, base_url = ?, description = ?,
               contact_email = ?, public_key = ?
         WHERE node_id = ?`,
      )
      .bind(
        input.display_name,
        input.base_url,
        input.description ?? null,
        input.contact_email ?? null,
        input.public_key ?? existing.public_key,
        existing.node_id,
      )
      .run()
  } else {
    if (!input.public_key) {
      throw new Error('public_key is required to provision a new node_identity row')
    }
    // Guard the insert against a concurrent first-time provision:
    // only insert when the table is still empty. The `singleton`
    // UNIQUE index (migration 0016) is the hard backstop; this
    // `WHERE NOT EXISTS` keeps the idempotent re-run path graceful
    // (a racing second call inserts nothing and falls through to
    // return the winning row below) instead of throwing.
    await db
      .prepare(
        `INSERT INTO node_identity
           (node_id, display_name, base_url, description, contact_email, public_key, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM node_identity)`,
      )
      .bind(
        newUlid(),
        input.display_name,
        input.base_url,
        input.description ?? null,
        input.contact_email ?? null,
        input.public_key,
        new Date().toISOString(),
      )
      .run()
  }
  const row = await getNodeIdentity(db)
  if (!row) throw new Error('node_identity upsert did not produce a row')
  return row
}

/**
 * Visible-to-the-public dataset rows: not retracted, not hidden,
 * visibility='public'. The federated / restricted / private cases
 * come online with the federation feed in Phase 4 — they are
 * filtered out here so the Phase 1a public read path stays simple
 * and the federation path can compose its own visibility predicate
 * on top.
 *
 * Ordering: weight DESC, then id for stable pagination. The id
 * is a ULID so id-order is roughly insertion-order.
 *
 * `since` is an opaque cursor that the catalog response stamps as
 * the latest `updated_at` it returned; subsequent calls with that
 * cursor only get rows that have been updated since. Phase 1a has
 * no retract path so tombstones come along empty, but the contract
 * is in place so federation subscribers (Phase 4) and CLI sync
 * jobs can rely on it.
 */
export async function listPublicDatasets(
  db: D1Database,
  options: { since?: string } = {},
): Promise<DatasetRow[]> {
  const { since } = options
  // The four conditions together define "this row is something
  // the public SPA / federation should see":
  //   - visibility = 'public': not federated-only or private
  //   - is_hidden = 0: operator hasn't suppressed it
  //   - retracted_at IS NULL: not retracted post-publish
  //   - published_at IS NOT NULL: actually published, not a draft
  // The fourth condition is what was missing — the schema's
  // `visibility` column defaults to 'public', so a draft created
  // with no explicit visibility setting still has visibility='public'
  // and would leak into the public catalog until publish/retract.
  // Both the public snapshot endpoint (`/api/v1/catalog`) and
  // the federation feed (Phase 4) key off this function, so the
  // fix is applied here once. The publisher portal's drafts tab
  // is a separate path: it queries the publisher-scoped
  // `listDatasetsForPublisher` in `dataset-mutations.ts`, which
  // has its own visibility model (drafts + published owned by
  // the caller). Found during a production smoke test where a
  // draft "Test 1" appeared alongside published datasets in the
  // SPA's browse panel.
  const where = [
    'visibility = ?',
    'is_hidden = 0',
    'retracted_at IS NULL',
    'published_at IS NOT NULL',
  ]
  const binds: unknown[] = ['public']
  if (since) {
    where.push('updated_at > ?')
    binds.push(since)
  }
  const sql = `
    SELECT * FROM datasets
    WHERE ${where.join(' AND ')}
    ORDER BY weight DESC, id ASC
  `
  const stmt = db.prepare(sql).bind(...binds)
  const result = await stmt.all<DatasetRow>()
  return result.results ?? []
}

/** Single dataset by id. Honors the same visibility filter as the list. */
export async function getPublicDataset(
  db: D1Database,
  id: string,
): Promise<DatasetRow | null> {
  return db
    .prepare(
      `SELECT * FROM datasets
       WHERE id = ? AND visibility = 'public'
         AND is_hidden = 0 AND retracted_at IS NULL
         AND published_at IS NOT NULL
       LIMIT 1`,
    )
    .bind(id)
    .first<DatasetRow>()
}

/**
 * D1 caps bind variables per prepared statement at 100, so the
 * decoration fetch chunks the dataset id list before running each
 * IN-clause query. 80 leaves comfortable headroom; queries within
 * a chunk still run concurrently across the five decoration
 * tables. The Phase 1d SOS bulk import (~190 rows) is the first
 * real workload that crossed the limit; pre-1d nobody had enough
 * published rows to surface the cliff.
 */
const D1_BIND_BATCH = 80

/**
 * Fetch every decoration row for a set of dataset ids in batch
 * queries. Used by the list endpoint to avoid the N+1 trap of
 * one-row-per-dataset fetches across five tables.
 */
export async function getDecorations(
  db: D1Database,
  datasetIds: string[],
): Promise<Map<string, DecorationRows>> {
  if (datasetIds.length === 0) return new Map()

  async function chunkedSelect<T>(template: (placeholders: string) => string): Promise<T[]> {
    const out: T[] = []
    for (let i = 0; i < datasetIds.length; i += D1_BIND_BATCH) {
      const chunk = datasetIds.slice(i, i + D1_BIND_BATCH)
      const placeholders = chunk.map(() => '?').join(',')
      const res = await db
        .prepare(template(placeholders))
        .bind(...chunk)
        .all<T>()
      if (res.results) out.push(...res.results)
    }
    return out
  }

  const [tagRows, catRows, kwRows, devRows, relRows] = await Promise.all([
    chunkedSelect<{ dataset_id: string; tag: string }>(
      ph => `SELECT dataset_id, tag FROM dataset_tags WHERE dataset_id IN (${ph})`,
    ),
    chunkedSelect<{ dataset_id: string; facet: string; value: string }>(
      ph =>
        `SELECT dataset_id, facet, value FROM dataset_categories WHERE dataset_id IN (${ph})`,
    ),
    chunkedSelect<{ dataset_id: string; keyword: string }>(
      ph => `SELECT dataset_id, keyword FROM dataset_keywords WHERE dataset_id IN (${ph})`,
    ),
    chunkedSelect<{
      dataset_id: string
      role: string
      name: string
      affiliation_url: string | null
    }>(
      ph =>
        `SELECT dataset_id, role, name, affiliation_url FROM dataset_developers WHERE dataset_id IN (${ph})`,
    ),
    chunkedSelect<{ dataset_id: string; related_title: string; related_url: string }>(
      ph =>
        `SELECT dataset_id, related_title, related_url FROM dataset_related WHERE dataset_id IN (${ph})`,
    ),
  ])

  const map = new Map<string, DecorationRows>()
  for (const id of datasetIds) {
    map.set(id, { tags: [], categories: [], keywords: [], developers: [], related: [] })
  }
  for (const r of tagRows) map.get(r.dataset_id)!.tags.push(r.tag)
  for (const r of catRows) {
    map.get(r.dataset_id)!.categories.push({ facet: r.facet, value: r.value })
  }
  for (const r of kwRows) map.get(r.dataset_id)!.keywords.push(r.keyword)
  for (const r of devRows) {
    map.get(r.dataset_id)!.developers.push({
      role: r.role,
      name: r.name,
      affiliation_url: r.affiliation_url,
    })
  }
  for (const r of relRows) {
    map.get(r.dataset_id)!.related.push({
      related_title: r.related_title,
      related_url: r.related_url,
    })
  }
  return map
}
