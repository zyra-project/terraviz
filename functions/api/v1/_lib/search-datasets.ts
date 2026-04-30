/**
 * Vector search over the dataset catalog — Phase 1c.
 *
 * Embeds the query via Workers AI, queries Vectorize for similar
 * dataset vectors, and hydrates the top matches from D1 into a
 * compact wire shape: `{ id, title, abstract_snippet, categories,
 * peer_id, score }`.
 *
 * Two call sites share this helper:
 *
 *   - `GET /api/v1/search?q=...` — public search endpoint
 *     (Commit E's route handler).
 *   - The docent's `search_datasets` LLM tool (Commit G's frontend
 *     refactor invokes the public URL; the tool definition shapes
 *     the same payload).
 *
 * The plan flags these as "separate code paths" (one user-facing,
 * one server-internal); in practice they share this helper and only
 * the call layer differs. If a future need requires
 * publisher-scoped filters (e.g. "search across un-published drafts
 * I own"), that surface lands as a separate publisher-API route
 * with its own helper — this one stays public-only.
 *
 * Failure modes:
 *
 *   - Empty / blank query → empty result set, no embed/query call.
 *   - Vectorize or Workers AI unconfigured → empty result set with
 *     a `degraded: 'unconfigured'` flag, so a deploy that hasn't
 *     wired the embed bindings keeps browse working and surfaces a
 *     useful "search is offline" message instead of a 5xx.
 *   - Embed/query throws → propagated; the route layer maps to a
 *     5xx. The docent's local engine fallback kicks in client-side.
 *
 * The result shape echoes the spec in CATALOG_BACKEND_PLAN.md
 * "Docent integration → Tool surface": id, title, abstract_snippet,
 * categories, peer_id. `score` is included so callers can debug
 * ranking; the docent's tool description tells the LLM to ignore
 * it.
 */

import {
  type DatasetRow,
  type DecorationRows,
  getDecorations,
  getNodeIdentity,
} from './catalog-store'
import { embedDatasetText, type EmbeddingEnv } from './embeddings'
import {
  queryEmbedding,
  VECTORIZE_DEFAULT_TOP_K,
  VECTORIZE_MAX_TOP_K,
  type DatasetVectorMetadata,
  type VectorizeEnv,
} from './vectorize-store'

/** Max characters in `abstract_snippet`. Roughly 50 words. */
const ABSTRACT_SNIPPET_MAX = 280

/** The conventional `peer_id` value the docent emits for local-only filters. */
export const LOCAL_PEER_ALIAS = 'local'

export interface SearchDatasetsHit {
  id: string
  title: string
  abstract_snippet: string
  categories: string[]
  /** `'local'` for own-node datasets; a peer node id otherwise. */
  peer_id: string
  /** Cosine similarity score from Vectorize. Higher = more similar. */
  score: number
}

export interface SearchDatasetsFilters {
  /** Exact-match category filter (lowercased). */
  category?: string
  /**
   * `'local'` (translated to the local node id) or a peer node id.
   * Federated peers are excluded by default; passing the peer's id
   * explicitly is how a future federation-aware caller opts in.
   */
  peer_id?: string
}

export interface SearchDatasetsOptions {
  query: string
  /** Defaults to `VECTORIZE_DEFAULT_TOP_K`; capped at `VECTORIZE_MAX_TOP_K`. */
  limit?: number
  filters?: SearchDatasetsFilters
}

export interface SearchDatasetsResult {
  datasets: SearchDatasetsHit[]
  /**
   * Set to `'unconfigured'` when the embed bindings are not wired,
   * so the route can stamp a `Warning` header and the docent can
   * fall back to its local engine. Absent in the happy path.
   */
  degraded?: 'unconfigured'
}

/** Minimum env surface the helper needs across its three dependencies. */
export type SearchDatasetsEnv = EmbeddingEnv &
  VectorizeEnv & {
    CATALOG_DB?: D1Database
  }

/**
 * Run a semantic search over the catalog. Returns at most `limit`
 * dataset hits ordered by cosine similarity.
 */
export async function searchDatasets(
  env: SearchDatasetsEnv,
  options: SearchDatasetsOptions,
): Promise<SearchDatasetsResult> {
  const query = options.query.trim()
  if (query.length === 0) return { datasets: [] }

  if (!env.CATALOG_DB) return { datasets: [] }

  // Soft-degrade when the embed bindings are not wired — the catalog
  // still browses; only search is offline. The docent's local
  // fallback covers this case client-side.
  const haveAi = env.AI != null || env.MOCK_AI === 'true'
  const haveVec = env.CATALOG_VECTORIZE != null || env.MOCK_VECTORIZE === 'true'
  if (!haveAi || !haveVec) {
    return { datasets: [], degraded: 'unconfigured' }
  }

  const limit = clampLimit(options.limit)

  // Translate `peer_id: 'local'` to the actual local node id so
  // Vectorize's exact-match filter matches what `embed-dataset-job`
  // wrote into the metadata. A request for a literal peer id falls
  // through as-is; a missing peer_id matches all peers.
  //
  // The builder returns `'unresolvable'` when the caller asked for
  // `'local'` but no node identity row exists yet (fresh deploy
  // pre-`gen:node-key`). Falling through with no filter would
  // broaden the search to all peers — exactly the opposite of
  // local-only — so short-circuit to an empty result instead.
  const baseFilter = await buildVectorizeFilter(env, options.filters)
  if (baseFilter === 'unresolvable') return { datasets: [] }

  // This helper backs a public-only search surface. Always constrain
  // the vector query itself to `visibility: 'public'` so private and
  // unlisted vectors don't take topK slots only to be dropped at
  // hydration — that would shrink the result below `limit` even when
  // more public matches exist further down the ranking. The
  // hydration step still filters defensively, but the load-bearing
  // filter is here.
  const filter: VectorizeVectorMetadataFilter = baseFilter
    ? ({ ...(baseFilter as Record<string, unknown>), visibility: 'public' } as unknown as VectorizeVectorMetadataFilter)
    : ({ visibility: 'public' } as unknown as VectorizeVectorMetadataFilter)

  const queryVec = await embedDatasetText(env, query)
  const matches = await queryEmbedding(env, queryVec, { limit, filter })
  if (matches.length === 0) return { datasets: [] }

  const ids = matches.map(m => m.dataset_id)
  const [rowMap, decorationMap, identity] = await Promise.all([
    fetchPublishedRows(env.CATALOG_DB, ids),
    getDecorations(env.CATALOG_DB, ids),
    getNodeIdentity(env.CATALOG_DB),
  ])
  const localNodeId = identity?.node_id ?? null

  // Preserve Vectorize's score-sorted order; drop hits whose row no
  // longer exists or is no longer published (a retract that happened
  // between the indexing job and now).
  const datasets: SearchDatasetsHit[] = []
  for (const match of matches) {
    const row = rowMap.get(match.dataset_id)
    if (!row) continue
    const decorations =
      decorationMap.get(match.dataset_id) ??
      ({ tags: [], categories: [], keywords: [], developers: [], related: [] } as DecorationRows)
    datasets.push(toHit(row, decorations, match.score, localNodeId, match.metadata))
  }

  return { datasets }
}

/** Fetch only currently-public rows (visibility=public, not hidden, not retracted). */
async function fetchPublishedRows(
  db: D1Database,
  ids: string[],
): Promise<Map<string, DatasetRow>> {
  if (ids.length === 0) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const result = await db
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
  const map = new Map<string, DatasetRow>()
  for (const row of result.results ?? []) map.set(row.id, row)
  return map
}

/**
 * Returns either a Vectorize-shaped filter, `undefined` (no filter
 * — match all peers), or `'unresolvable'` to signal that the
 * caller asked for `peer_id='local'` but the local node identity
 * row is missing. The caller short-circuits to an empty result in
 * the unresolvable case so a fresh deploy doesn't accidentally
 * surface federated content under a "local" filter.
 */
async function buildVectorizeFilter(
  env: SearchDatasetsEnv,
  filters: SearchDatasetsFilters | undefined,
): Promise<VectorizeVectorMetadataFilter | undefined | 'unresolvable'> {
  if (!filters) return undefined
  const out: Record<string, string> = {}

  if (filters.category) {
    out.category = filters.category.normalize('NFC').trim().toLowerCase()
  }

  if (filters.peer_id) {
    if (filters.peer_id === LOCAL_PEER_ALIAS) {
      const identity = env.CATALOG_DB ? await getNodeIdentity(env.CATALOG_DB) : null
      if (!identity?.node_id) return 'unresolvable'
      out.peer_id = identity.node_id
    } else {
      out.peer_id = filters.peer_id
    }
  }

  if (Object.keys(out).length === 0) return undefined
  return out as unknown as VectorizeVectorMetadataFilter
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return VECTORIZE_DEFAULT_TOP_K
  if (limit < 1) return 1
  return Math.min(Math.floor(limit), VECTORIZE_MAX_TOP_K)
}

function toHit(
  row: DatasetRow,
  decorations: DecorationRows,
  score: number,
  localNodeId: string | null,
  metadata: DatasetVectorMetadata | undefined,
): SearchDatasetsHit {
  return {
    id: row.id,
    title: row.title,
    abstract_snippet: snippet(row.abstract),
    categories: extractCategories(decorations),
    peer_id: derivePeerId(row.origin_node, localNodeId, metadata),
    score,
  }
}

function extractCategories(decorations: DecorationRows): string[] {
  const seen = new Set<string>()
  for (const c of decorations.categories) {
    const v = c.value.trim()
    if (v) seen.add(v)
  }
  return [...seen]
}

function snippet(abstract: string | null): string {
  if (!abstract) return ''
  const collapsed = abstract.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= ABSTRACT_SNIPPET_MAX) return collapsed
  return collapsed.slice(0, ABSTRACT_SNIPPET_MAX - 1).trimEnd() + '…'
}

function derivePeerId(
  originNode: string,
  localNodeId: string | null,
  metadata: DatasetVectorMetadata | undefined,
): string {
  // Prefer the row's `origin_node` over the metadata; the row is
  // the source of truth and the metadata may be stale across model
  // version bumps.
  void metadata
  if (localNodeId && originNode === localNodeId) return LOCAL_PEER_ALIAS
  return originNode
}
