/**
 * Vectorize helpers — Phase 1c.
 *
 * Cloudflare Vectorize is the docent's semantic-search backend.
 * Embeddings produced by `_lib/embeddings.ts` (Commit B) land here
 * via `upsertEmbedding`; `search_datasets` (Commit E) runs query
 * vectors through `queryEmbedding` and hydrates the matches against
 * D1; the retract path uses `deleteEmbedding`. The plan pins the
 * binding to a 768-dim cosine-metric index named
 * `terraviz-datasets`, matching `@cf/baai/bge-base-en-v1.5` from
 * Workers AI.
 *
 * The contributor walkthrough must work without a real Vectorize
 * index — quota signups are gated and a fresh fork shouldn't need a
 * Cloudflare account at all to run the dev server. `MOCK_VECTORIZE=true`
 * therefore swaps the binding for an in-memory store keyed by the
 * Workers isolate so a multi-step "upsert three datasets, then query
 * for the closest one" walkthrough actually works end to end. The
 * mock implements cosine similarity directly and supports the
 * subset of `$eq` / `$in` / `$nin` filters the docent emits, so
 * search results behave realistically rather than returning a static
 * stub list. Anything beyond that surface (range filters, namespace
 * scoping) is a Phase 4 federation concern and falls back to "match
 * everything" in mock mode.
 *
 * Design notes worth pinning down here so they don't drift:
 *
 *   - Vector ids are dataset ULIDs verbatim. No prefix, no hashing —
 *     a deletion targets exactly the row's id; a query result's
 *     `id` is the catalog primary key.
 *   - Metadata indexes (`peer_id`, `category`, `visibility`) are
 *     created out-of-band via `wrangler vectorize create-metadata-index`
 *     — see `docs/CATALOG_BACKEND_DEVELOPMENT.md` for the commands.
 *     The helpers here just hand the filter shape to the binding;
 *     filterable-vs-non-filterable enforcement is Vectorize's
 *     responsibility.
 *   - `topK` is capped at 50. The docent surface tops out at ~10;
 *     50 leaves enough headroom for federation-aware re-ranking
 *     without letting a buggy caller drain the query budget.
 */

import { ConfigurationError } from './errors'

export interface VectorizeEnv {
  /**
   * Workers binding for the catalog vector index. Provisioned in
   * the Cloudflare dashboard under
   * Settings → Bindings → Vectorize → variable name `CATALOG_VECTORIZE`,
   * pointing at the `terraviz-datasets` index created via
   * `wrangler vectorize create terraviz-datasets --dimensions=768 --metric=cosine`.
   *
   * Optional in the type so handlers can degrade gracefully when an
   * operator skipped the binding step — every consumer here either
   * branches on `MOCK_VECTORIZE` or routes through `requireVectorize`,
   * which throws a `ConfigurationError` the route layer maps onto a
   * `503 vectorize_unconfigured`.
   */
  CATALOG_VECTORIZE?: Vectorize
  /**
   * `"true"` swaps the binding for an in-memory mock so the
   * contributor walkthrough works without a real Vectorize index.
   * Refused by `requireVectorize` whenever it is unset; the helpers
   * therefore fail closed instead of silently no-oping in production.
   */
  MOCK_VECTORIZE?: string
}

/** Maximum `topK` we forward to Vectorize. Caps callers; not Vectorize's own ceiling. */
export const VECTORIZE_MAX_TOP_K = 50

/** Default top-K for `queryEmbedding` when the caller does not specify one. */
export const VECTORIZE_DEFAULT_TOP_K = 10

/** Expected dimension count — `bge-base-en-v1.5` produces 768. */
export const VECTORIZE_EMBEDDING_DIMENSIONS = 768

/**
 * Metadata stored alongside every vector. Mirrors the filterable
 * fields in the plan ("Index metadata" in CATALOG_BACKEND_PLAN.md,
 * "Docent integration"); `embedding_version` is included so a future
 * model upgrade can bulk-evict stale rows by metadata filter without
 * round-tripping to D1.
 */
export interface DatasetVectorMetadata {
  peer_id: string
  category: string
  visibility: 'public' | 'unlisted' | 'private'
  embedding_version: number
  /** Optional ISO 8601 dates; range filters land in Phase 4. */
  time_range_start?: string
  time_range_end?: string
}

export interface UpsertEmbeddingInput {
  dataset_id: string
  values: number[]
  metadata: DatasetVectorMetadata
}

export interface QueryEmbeddingOptions {
  /** Maximum matches to return. Defaults to `VECTORIZE_DEFAULT_TOP_K`; capped at `VECTORIZE_MAX_TOP_K`. */
  limit?: number
  /**
   * Metadata filters in Vectorize's native shape, e.g.
   * `{ peer_id: 'local' }` or `{ category: { $in: ['atmosphere', 'oceans'] } }`.
   * The mock applies a subset of the operator vocabulary.
   */
  filter?: VectorizeVectorMetadataFilter
}

export interface QueryEmbeddingMatch {
  dataset_id: string
  score: number
  metadata?: DatasetVectorMetadata
}

/**
 * Upsert one dataset's embedding into the catalog vector index.
 * Idempotent on re-run: an updated dataset re-embeds and overwrites
 * the previous values + metadata in place. Vectorize's mutations
 * are async (returns a `mutationId`); the helper resolves once the
 * change has been accepted, not once it has propagated. That is the
 * documented Vectorize semantic — a query immediately after an
 * upsert may briefly miss the new vector. The docent surface is
 * tolerant of this (publish → first search returns N-1 results,
 * second one returns N) and we don't paper it over with polling.
 */
export async function upsertEmbedding(
  env: VectorizeEnv,
  input: UpsertEmbeddingInput,
): Promise<void> {
  validateValues(input.values)

  if (env.MOCK_VECTORIZE === 'true') {
    mockStore(env).set(input.dataset_id, {
      values: [...input.values],
      metadata: { ...input.metadata },
    })
    return
  }

  const index = requireVectorize(env)
  await index.upsert([
    {
      id: input.dataset_id,
      values: input.values,
      metadata: input.metadata as unknown as Record<string, VectorizeVectorMetadata>,
    },
  ])
}

/**
 * Query the catalog vector index. Returns the top matches, each
 * with the dataset id and similarity score. The caller hydrates
 * row data (title / abstract / thumbnail) from D1.
 *
 * Score range follows Vectorize's cosine convention — 1.0 is an
 * identical embedding, 0.0 is orthogonal. The docent treats
 * everything Vectorize hands back as a candidate; threshold-based
 * "no match" framing is the LLM's job, not the helper's.
 */
export async function queryEmbedding(
  env: VectorizeEnv,
  values: number[],
  options: QueryEmbeddingOptions = {},
): Promise<QueryEmbeddingMatch[]> {
  validateValues(values)

  const limit = clampTopK(options.limit ?? VECTORIZE_DEFAULT_TOP_K)

  if (env.MOCK_VECTORIZE === 'true') {
    return mockQuery(env, values, limit, options.filter)
  }

  const index = requireVectorize(env)
  const result = await index.query(values, {
    topK: limit,
    returnMetadata: 'indexed',
    filter: options.filter,
  })

  return result.matches.map(match => ({
    dataset_id: match.id,
    score: match.score,
    metadata: match.metadata as unknown as DatasetVectorMetadata | undefined,
  }))
}

/**
 * Remove a dataset's embedding from the index. Used on retract /
 * hard-delete so the docent does not surface tombstoned datasets.
 * Idempotent: deleting an id that isn't present is not an error.
 */
export async function deleteEmbedding(
  env: VectorizeEnv,
  datasetId: string,
): Promise<void> {
  if (env.MOCK_VECTORIZE === 'true') {
    mockStore(env).delete(datasetId)
    return
  }

  const index = requireVectorize(env)
  await index.deleteByIds([datasetId])
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireVectorize(env: VectorizeEnv): Vectorize {
  if (!env.CATALOG_VECTORIZE) {
    throw new ConfigurationError(
      'Vectorize is not configured. Add the CATALOG_VECTORIZE binding to ' +
        'this Pages project, or set MOCK_VECTORIZE=true for local development.',
    )
  }
  return env.CATALOG_VECTORIZE
}

function validateValues(values: number[]): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('vectorize-store: vector values must be a non-empty number[]')
  }
  if (values.length !== VECTORIZE_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `vectorize-store: vector must be ${VECTORIZE_EMBEDDING_DIMENSIONS}-dim ` +
        `(got ${values.length}); model is bge-base-en-v1.5.`,
    )
  }
}

function clampTopK(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(Math.floor(n), VECTORIZE_MAX_TOP_K)
}

// ---------------------------------------------------------------------------
// In-memory mock — only active when `MOCK_VECTORIZE=true`.
//
// Stored on a symbol-keyed slot of the env object so each test or
// request sees its own state. Tests that want a clean slate can
// either use a fresh env literal or call `__clearMockStore`.
// ---------------------------------------------------------------------------

interface StoredVector {
  values: number[]
  metadata: DatasetVectorMetadata
}

const MOCK_STORE_KEY = Symbol.for('terraviz/vectorize-mock-store')

interface MockHost {
  [MOCK_STORE_KEY]?: Map<string, StoredVector>
}

function mockStore(env: VectorizeEnv): Map<string, StoredVector> {
  const host = env as unknown as MockHost
  let store = host[MOCK_STORE_KEY]
  if (!store) {
    store = new Map<string, StoredVector>()
    host[MOCK_STORE_KEY] = store
  }
  return store
}

/** Test helper — wipes the mock state attached to `env`. Not exported in production paths. */
export function __clearMockStore(env: VectorizeEnv): void {
  const host = env as unknown as MockHost
  host[MOCK_STORE_KEY]?.clear()
}

function mockQuery(
  env: VectorizeEnv,
  values: number[],
  limit: number,
  filter: VectorizeVectorMetadataFilter | undefined,
): QueryEmbeddingMatch[] {
  const store = mockStore(env)
  const queryNorm = vectorNorm(values)

  const matches: QueryEmbeddingMatch[] = []
  for (const [id, stored] of store) {
    if (!matchesFilter(stored.metadata, filter)) continue
    const score = cosineSimilarity(values, stored.values, queryNorm, vectorNorm(stored.values))
    matches.push({ dataset_id: id, score, metadata: { ...stored.metadata } })
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Stable tie-break by id so two identical-vector datasets order
    // deterministically across runs.
    return a.dataset_id < b.dataset_id ? -1 : a.dataset_id > b.dataset_id ? 1 : 0
  })

  return matches.slice(0, limit)
}

function vectorNorm(values: number[]): number {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i] * values[i]
  return Math.sqrt(sum)
}

function cosineSimilarity(
  a: number[],
  b: number[],
  normA: number,
  normB: number,
): number {
  if (normA === 0 || normB === 0) return 0
  let dot = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) dot += a[i] * b[i]
  return dot / (normA * normB)
}

/**
 * Apply a Vectorize-shaped filter against a stored metadata bag.
 * Supports the operators the docent emits today: implicit `$eq`,
 * `$eq`, `$ne`, `$in`, `$nin`. Range operators (`$lt`/`$gt`/...)
 * resolve to "match" so unsupported filters don't drop results
 * silently — that surface lands when range filters are wired into
 * the docent in a later phase.
 */
function matchesFilter(
  metadata: DatasetVectorMetadata,
  filter: VectorizeVectorMetadataFilter | undefined,
): boolean {
  if (!filter) return true
  const bag = metadata as unknown as Record<string, unknown>

  for (const [field, condition] of Object.entries(filter)) {
    const actual = bag[field]
    if (condition == null) {
      if (actual != null) return false
      continue
    }
    if (
      typeof condition === 'string' ||
      typeof condition === 'number' ||
      typeof condition === 'boolean'
    ) {
      if (actual !== condition) return false
      continue
    }
    if (typeof condition === 'object') {
      const cond = condition as Record<string, unknown>
      if ('$eq' in cond && actual !== cond.$eq) return false
      if ('$ne' in cond && actual === cond.$ne) return false
      if ('$in' in cond) {
        const list = cond.$in as unknown[]
        if (!Array.isArray(list) || !list.includes(actual)) return false
      }
      if ('$nin' in cond) {
        const list = cond.$nin as unknown[]
        if (Array.isArray(list) && list.includes(actual)) return false
      }
      // Range operators silently match — see comment above.
    }
  }

  return true
}
