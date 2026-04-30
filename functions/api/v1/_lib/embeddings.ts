/**
 * Workers AI embedding helpers — Phase 1c.
 *
 * Two responsibilities:
 *
 *   1. `buildDatasetEmbeddingText(row, decorations)` — produces the
 *      canonical text-to-embed for a dataset. Stable byte-for-byte
 *      across re-indexes of an unchanged row, so `embedding_version`
 *      remains a meaningful "this row was embedded by model vN"
 *      marker. Re-running the indexer on an unchanged row produces
 *      an identical input string and (with a deterministic embedding
 *      model) an identical vector.
 *
 *   2. `embedDatasetText(env, text)` — calls
 *      `@cf/baai/bge-base-en-v1.5` via the Workers AI binding and
 *      returns the 768-dim embedding as a plain `number[]` ready to
 *      hand to `vectorize-store.upsertEmbedding`. Pooling is forced
 *      to `mean` to match the BGE default; do NOT change without
 *      simultaneously bumping `EMBEDDING_MODEL_VERSION` and
 *      bulk-re-embedding (mean-pooled and cls-pooled vectors are
 *      not interoperable per Cloudflare's docs).
 *
 * Local dev sets `MOCK_AI=true` so the contributor walkthrough works
 * without burning Workers AI quota. The mock implements a
 * deterministic feature-hashing embedding (FNV-1a per token, ±1
 * contribution at an index keyed by the token hash, L2-normalised
 * to unit length) so two datasets sharing topical vocabulary land
 * closer in cosine similarity than two unrelated datasets. That
 * mirrors what a real embedding model does at a coarse level and
 * makes the "publish three datasets, search for the closest one"
 * walk in `MOCK_VECTORIZE=true` actually feel useful, instead of
 * returning a static stub list.
 *
 * Canonical embedding-text shape (decided up-front in the Phase 1c
 * brief; see "Decision points" in the brief for rationale):
 *
 *   Title: <title>
 *   Organization: <organization or "">
 *   Abstract: <abstract or "">
 *   Categories: <sorted, lowercased, comma+space-joined>
 *   Keywords: <sorted, lowercased, comma+space-joined>
 *
 * Newline-separated, label-prefixed (helps the embedder weight each
 * field), `categories` and `keywords` sorted lexicographically before
 * joining (decoration tables are insertion-ordered; sort keeps the
 * input byte-stable), empty fields keep the label with an empty
 * value (so adding an abstract later changes one line, not the
 * positional layout), `\n` line endings, no trailing newline,
 * NFC-normalised. Locking this down here is the whole point of the
 * `embedding_version` column: a future change to the format requires
 * bumping the version + a bulk re-embed.
 */

import type { DatasetRow, DecorationRows } from './catalog-store'
import { ConfigurationError } from './errors'
import { VECTORIZE_EMBEDDING_DIMENSIONS } from './vectorize-store'

/**
 * Cloudflare Workers AI model id for dataset embeddings. Pinned;
 * changing this is a model-upgrade event that requires bumping
 * `EMBEDDING_MODEL_VERSION` and re-embedding every dataset.
 */
export const EMBEDDING_MODEL_ID = '@cf/baai/bge-base-en-v1.5' as const

/**
 * Monotonic identifier for the (model id × text shape × pooling)
 * tuple. Stamped onto `datasets.embedding_version` after a
 * successful embed so the indexer can answer "what's already up to
 * date vs. needs re-embedding" with a single SQL predicate. Bump
 * this any time the model id, the canonical text shape, or the
 * pooling strategy changes.
 */
export const EMBEDDING_MODEL_VERSION = 1

export interface EmbeddingEnv {
  /**
   * Workers AI binding. Required for real-mode embedding; provided
   * automatically by the Pages runtime. Optional in the type so
   * helper callers can degrade gracefully and so tests can mock the
   * binding shape directly.
   */
  AI?: Ai
  /**
   * `"true"` swaps the AI binding for a deterministic feature-hashed
   * mock. Refused by `requireAi` whenever it is unset; the helpers
   * therefore fail closed instead of silently emitting zero-vectors
   * in production.
   */
  MOCK_AI?: string
}

// ---------------------------------------------------------------------------
// Canonical embedding text
// ---------------------------------------------------------------------------

/**
 * Build the canonical text-to-embed for a dataset row + its
 * decorations. The output is stable byte-for-byte across re-indexes
 * of an unchanged row.
 *
 * Inputs are NFC-normalised (so an á composed differently produces
 * the same embedding) and trimmed; categories + keywords are
 * lowercased and lexicographically sorted before joining.
 */
export function buildDatasetEmbeddingText(
  row: Pick<DatasetRow, 'title' | 'abstract' | 'organization'>,
  decorations: Pick<DecorationRows, 'categories' | 'keywords'>,
): string {
  const title = normaliseText(row.title ?? '')
  const organization = normaliseText(row.organization ?? '')
  const abstract = normaliseText(row.abstract ?? '')

  const categories = canonicaliseList(decorations.categories.map(c => c.value))
  const keywords = canonicaliseList(decorations.keywords)

  return [
    `Title: ${title}`,
    `Organization: ${organization}`,
    `Abstract: ${abstract}`,
    `Categories: ${categories.join(', ')}`,
    `Keywords: ${keywords.join(', ')}`,
  ].join('\n')
}

function normaliseText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** Lowercase, NFC-normalise, dedupe, and lexicographically sort a list. */
function canonicaliseList(values: string[]): string[] {
  const seen = new Set<string>()
  for (const raw of values) {
    const normalised = normaliseText(raw).toLowerCase()
    if (normalised) seen.add(normalised)
  }
  return [...seen].sort()
}

// ---------------------------------------------------------------------------
// Embedding call
// ---------------------------------------------------------------------------

/**
 * Embed a single string against `bge-base-en-v1.5`. Returns the
 * 768-dim vector ready to upsert into Vectorize. In `MOCK_AI=true`
 * mode returns a deterministic feature-hashed vector so multi-step
 * walkthroughs work without a real Workers AI quota.
 *
 * Validates the model's response shape — Workers AI returns
 * `{ data: number[][] }` for sync calls and an async-queue
 * descriptor (`{ request_id }`) when the load shedder defers.
 * The async path is a Phase 4 concern; here a non-sync response is
 * treated as a transient failure and surfaces as a thrown error
 * the job retry handles.
 */
export async function embedDatasetText(
  env: EmbeddingEnv,
  text: string,
): Promise<number[]> {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('embedDatasetText: text must be a non-empty string')
  }

  if (env.MOCK_AI === 'true') {
    return mockEmbed(text)
  }

  const ai = requireAi(env)
  const result = (await ai.run(EMBEDDING_MODEL_ID, {
    text,
    pooling: 'mean',
  })) as { data?: number[][]; shape?: number[]; request_id?: string }

  if (result?.request_id && !result.data) {
    throw new Error(
      `embedDatasetText: Workers AI deferred to async queue (request_id=${result.request_id}); ` +
        'the embedding job will retry. Async-queue collection is a Phase 4 concern.',
    )
  }

  const data = result?.data
  if (!Array.isArray(data) || data.length === 0 || !Array.isArray(data[0])) {
    throw new Error('embedDatasetText: Workers AI returned no embedding data')
  }
  const values = data[0]
  if (values.length !== VECTORIZE_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedDatasetText: model returned ${values.length}-dim vector, expected ` +
        `${VECTORIZE_EMBEDDING_DIMENSIONS} (model=${EMBEDDING_MODEL_ID})`,
    )
  }
  return values
}

function requireAi(env: EmbeddingEnv): Ai {
  if (!env.AI) {
    throw new ConfigurationError(
      'Workers AI is not configured. Add the AI binding to this Pages project, ' +
        'or set MOCK_AI=true for local development.',
    )
  }
  return env.AI
}

// ---------------------------------------------------------------------------
// Deterministic mock embedding
//
// Feature-hashing implementation:
//   1. Tokenise the input by stripping non-alphanumeric chars and
//      lowercasing. Tokens of length <2 are dropped to avoid
//      "a" / "an" / "the" overweighting noise.
//   2. For each token, compute FNV-1a 32-bit. Use the low 16 bits as
//      an index into the 768-dim vector (mod), and bit 16 as the
//      sign (0 → +1, 1 → -1). Accumulate.
//   3. L2-normalise the result. Unit length matches BGE's
//      normalised output, so cosine similarity behaves the same way
//      as it would against real embeddings.
//
// The empty-text case (or a text with no surviving tokens — e.g.
// punctuation-only) yields a vector with a single non-zero
// dimension chosen by hashing the empty string so it remains
// deterministic and unit-length.
// ---------------------------------------------------------------------------

function mockEmbed(text: string): number[] {
  const dims = VECTORIZE_EMBEDDING_DIMENSIONS
  const values = new Array<number>(dims).fill(0)

  const tokens = tokeniseForMock(text)
  if (tokens.length === 0) {
    // Stable degenerate-input fallback so the mock never returns the
    // zero vector (which would make cosine similarity NaN).
    const h = fnv1a('')
    values[h % dims] = 1
    return values
  }

  for (const token of tokens) {
    const h = fnv1a(token)
    const idx = h % dims
    const sign = (h >>> 16) & 1 ? -1 : 1
    values[idx] += sign
  }

  return l2Normalise(values)
}

function tokeniseForMock(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(t => t.length >= 2)
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function l2Normalise(values: number[]): number[] {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i] * values[i]
  const norm = Math.sqrt(sum)
  if (norm === 0) return values
  for (let i = 0; i < values.length; i++) values[i] /= norm
  return values
}
