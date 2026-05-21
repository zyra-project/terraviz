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
import { parseIsoDuration } from './iso-duration'
import { isWorkersAiQuotaError } from '../../_lib/workers-ai-error'
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
  /**
   * Image-sequence indicator (Phase 3pg/C). Present only when the
   * row was transcoded from a frames upload; carries the count
   * plus the time origin / period so Orbit's LLM can decide
   * whether `<<LOAD_FRAME:...>>` makes sense and pick a reasonable
   * timestamp / index from the conversation. Omitted entirely for
   * MP4-source rows — older clients ignore the field, and an
   * LLM that doesn't see it falls back to the regular
   * `<<LOAD:...>>` marker for whole-sequence playback.
   */
  frames?: {
    count: number
    startTime?: string
    period?: string
  }
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
  /**
   * Phase 3pg/D — restrict hits to datasets whose time window
   * overlaps the requested `[fromMs, toMs]` range (milliseconds
   * since epoch). The overlap is computed per row:
   *
   *   - sequence rows (frames + start_time + period): the window
   *     is `[start_time, start_time + period × frame_count)`;
   *   - non-sequence rows: the window is `[start_time, end_time]`
   *     (legacy SOS shape — both columns must be set);
   *   - rows with no time metadata: dropped from the result when
   *     `time_range` is set.
   *
   * Filtering happens post-hydration: the Vectorize query and D1
   * lookup are unchanged; the hits are pruned before they're
   * mapped to the wire shape. Cheaper than threading a SQL `WHERE`
   * for a v1 implementation, and avoids re-querying when the
   * filter result set is empty.
   */
  time_range?: { fromMs: number; toMs: number }
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
   * Set when the search path could not produce real hits and the
   * caller should treat the empty datasets array as degraded
   * rather than "no matches":
   *   - `'unconfigured'` — embed bindings not wired (operator
   *     misconfiguration; Step 4 of the deploy checklist).
   *   - `'quota_exhausted'` — Workers AI / Vectorize raised a
   *     4006-shaped quota error (Phase 1f/D). Distinct from
   *     `unconfigured` so the SPA can decide whether to show
   *     "wire up Vectorize" guidance vs the
   *     "Reduced functionality — Workers AI quota reached" badge
   *     (see `src/ui/chatUI.ts` `degradedBadgeText`).
   */
  degraded?: 'unconfigured' | 'quota_exhausted'
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

  let queryVec: number[]
  let matches: Awaited<ReturnType<typeof queryEmbedding>>
  try {
    queryVec = await embedDatasetText(env, query)
    matches = await queryEmbedding(env, queryVec, { limit, filter })
  } catch (err) {
    // Phase 1f/D — Workers AI quota exhaustion lands here as a
    // thrown Error from `embedDatasetText` (Workers AI free-tier
    // budget) or `queryEmbedding` (rare). Surface it as a typed
    // degraded reason so the SPA can flip its badge instead of
    // showing an empty-result silent failure.
    if (isWorkersAiQuotaError(err)) {
      return { datasets: [], degraded: 'quota_exhausted' }
    }
    throw err
  }
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
  // between the indexing job and now). Phase 3pg/D — also drop hits
  // whose time window doesn't overlap the requested `time_range`
  // filter, evaluated post-hydration so the Vectorize/D1 work is
  // unchanged when the filter isn't supplied.
  const timeRange = options.filters?.time_range
  const datasets: SearchDatasetsHit[] = []
  for (const match of matches) {
    const row = rowMap.get(match.dataset_id)
    if (!row) continue
    if (timeRange && !rowOverlapsTimeRange(row, timeRange.fromMs, timeRange.toMs)) continue
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
  const hit: SearchDatasetsHit = {
    id: row.id,
    title: row.title,
    abstract_snippet: snippet(row.abstract),
    categories: extractCategories(decorations),
    peer_id: derivePeerId(row.origin_node, localNodeId, metadata),
    score,
  }
  // Frame surface predicate matches the wire serializer
  // (`dataset-serializer.ts`) and the `/frames` endpoints: all
  // three columns must be set in lockstep, since `clearTranscoding`
  // writes them atomically. Surfacing `hit.frames` on a partially-
  // null row would advertise a frame surface that
  // `WireDataset.frames` / `/frames` would then refuse — confusing
  // for the LLM and any other consumer. Phase 3pg-review/B —
  // Copilot discussion_r3277221713.
  if (
    row.frame_count != null &&
    row.frame_extension != null &&
    row.frame_source_filenames_ref != null
  ) {
    hit.frames = {
      count: row.frame_count,
      ...(row.start_time ? { startTime: row.start_time } : {}),
      ...(row.period ? { period: row.period } : {}),
    }
  }
  return hit
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

/**
 * Phase 3pg/D — does the dataset row's time window overlap the
 * requested `[fromMs, toMs]` interval? Used by `searchDatasets`
 * to filter `?time_range=ISO/ISO` query results. Two row shapes:
 *
 *   - Sequence row (all three frame columns set + start_time +
 *     parseable period): window is `[start_time,
 *     start_time + period × frame_count)`.
 *   - Non-sequence row (no frames, but `start_time` + `end_time`
 *     set): window is `[start_time, end_time]` (closed-closed —
 *     legacy SOS rows treat both ends as inclusive).
 *
 * Rows with no usable time metadata return false — a publisher
 * who hasn't set a time range can't meaningfully overlap a query.
 * That matches the plan's "drops out when `time_range` is set"
 * stance and keeps the filter behaviour deterministic.
 *
 * Half-open vs closed-closed: the sequence window is half-open at
 * the upper end because frame N's timestamp is
 * `start_time + period × N`, and the (N+1)-th frame doesn't exist.
 * The non-sequence range is closed-closed because the catalog's
 * end_time semantically includes that moment (e.g. "1979-01-01 to
 * 2020-01-01" should match a query containing 2020-01-01). Both
 * conventions match the way `/frames?at=` and the docent's TIME
 * marker treat the same column.
 */
export function rowOverlapsTimeRange(
  row: DatasetRow,
  fromMs: number,
  toMs: number,
): boolean {
  if (
    row.frame_count != null &&
    row.frame_extension != null &&
    row.frame_source_filenames_ref != null &&
    row.start_time &&
    row.period
  ) {
    const startMs = Date.parse(row.start_time)
    const periodMs = parseIsoDuration(row.period)
    if (!Number.isNaN(startMs) && periodMs != null && periodMs > 0) {
      const endMsExclusive = startMs + periodMs * row.frame_count
      return fromMs < endMsExclusive && toMs >= startMs
    }
  }
  if (row.start_time && row.end_time) {
    const startMs = Date.parse(row.start_time)
    const endMs = Date.parse(row.end_time)
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
      return fromMs <= endMs && toMs >= startMs
    }
  }
  return false
}
