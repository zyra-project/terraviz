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
  const where = ['visibility = ?', 'is_hidden = 0', 'retracted_at IS NULL']
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
