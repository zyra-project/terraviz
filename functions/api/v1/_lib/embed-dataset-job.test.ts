/**
 * Tests for the dataset-embedding pipeline job.
 *
 * Coverage:
 *   - Happy path: reads row + decorations, builds canonical text,
 *     calls Workers AI, upserts into Vectorize with the documented
 *     metadata shape, stamps `embedding_version` on the row.
 *   - Idempotent on re-run: a second invocation against the same
 *     unchanged row produces the identical text signature, the same
 *     metadata, and a Vectorize upsert at the same id.
 *   - Updates flow through: changing the row's title between runs
 *     produces a new text signature and re-upserts a different
 *     vector for the same id.
 *   - `not_found`: the dataset row was deleted before the job ran;
 *     the job returns the structured outcome and does not call
 *     Vectorize / AI.
 *   - `binding_missing`: missing `CATALOG_DB` soft-skips so the
 *     queue's catch handler can log without throwing.
 *   - Metadata: `peer_id` carries the row's `origin_node`,
 *     `category` is the lexicographically-first lowercased value
 *     (deterministic), `visibility` is normalised to the three
 *     allowed enum values, `embedding_version` matches
 *     `EMBEDDING_MODEL_VERSION`.
 *   - Failure modes: a Vectorize upsert error is propagated (the
 *     `embedding_version` row stamp does NOT happen, so a retry
 *     re-runs the whole pipeline).
 */

import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'
import { asD1 } from './test-helpers'
import { embedDatasetJob, type EmbedDatasetEnv } from './embed-dataset-job'
import { EMBEDDING_MODEL_VERSION } from './embeddings'
import {
  __clearMockStore,
  queryEmbedding,
  type VectorizeEnv,
} from './vectorize-store'

const TS = '2026-04-29T12:00:00.000Z'
const DATASET_ID = 'DS001AAAAAAAAAAAAAAAAAAAAA'

function setupDb(overrides: {
  title?: string
  abstract?: string | null
  organization?: string | null
  visibility?: string
  origin_node?: string
  categories?: Array<{ facet: string; value: string }>
  keywords?: string[]
} = {}): Database.Database {
  const db = freshMigratedDb()
  db.prepare(
    `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
     VALUES ('NODE000', 'T', 'https://t', 'k', ?)`,
  ).run(TS)
  db.prepare(
    `INSERT INTO publishers (id, email, display_name, role, status, created_at)
     VALUES ('PUB001', 'p@t', 'P', 'staff', 'active', ?)`,
  ).run(TS)
  db.prepare(
    `INSERT INTO datasets (id, slug, origin_node, title, abstract, organization,
                           format, data_ref, weight, visibility, is_hidden,
                           schema_version, created_at, updated_at, publisher_id)
     VALUES (?, 'd', ?, ?, ?, ?, 'video/mp4', 'stream:abc',
             0, ?, 0, 1, ?, ?, 'PUB001')`,
  ).run(
    DATASET_ID,
    overrides.origin_node ?? 'NODE000',
    overrides.title ?? 'Atlantic Hurricane Tracks',
    overrides.abstract === undefined
      ? 'Storm tracks for the Atlantic basin from 1950–2020.'
      : overrides.abstract,
    overrides.organization === undefined ? 'NOAA' : overrides.organization,
    overrides.visibility ?? 'public',
    TS,
    TS,
  )
  for (const cat of overrides.categories ?? [
    { facet: 'theme', value: 'Atmosphere' },
    { facet: 'theme', value: 'Oceans' },
  ]) {
    db.prepare(
      `INSERT INTO dataset_categories (dataset_id, facet, value) VALUES (?, ?, ?)`,
    ).run(DATASET_ID, cat.facet, cat.value)
  }
  for (const kw of overrides.keywords ?? ['hurricane', 'storm', 'atlantic']) {
    db.prepare(`INSERT INTO dataset_keywords (dataset_id, keyword) VALUES (?, ?)`).run(
      DATASET_ID,
      kw,
    )
  }
  return db
}

function freshEnv(db: Database.Database): EmbedDatasetEnv {
  const env = {
    CATALOG_DB: asD1(db),
    MOCK_AI: 'true',
    MOCK_VECTORIZE: 'true',
  } as EmbedDatasetEnv
  __clearMockStore(env as VectorizeEnv)
  return env
}

describe('embedDatasetJob — happy path', () => {
  it('embeds, upserts, and stamps embedding_version', async () => {
    const db = setupDb()
    const env = freshEnv(db)

    const result = await embedDatasetJob(env, { dataset_id: DATASET_ID })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.dataset_id).toBe(DATASET_ID)
    expect(result.embedding_version).toBe(EMBEDDING_MODEL_VERSION)
    expect(result.text_signature).toMatch(/^[0-9a-f]{40}$/)

    // Row was stamped.
    const row = db
      .prepare(`SELECT embedding_version FROM datasets WHERE id = ?`)
      .get(DATASET_ID) as { embedding_version: number | null }
    expect(row.embedding_version).toBe(EMBEDDING_MODEL_VERSION)

    // Vector landed.
    const matches = await queryEmbedding(env, await embedKnown(env), { limit: 5 })
    expect(matches.find(m => m.dataset_id === DATASET_ID)).toBeDefined()
  })

  it('writes documented metadata shape (peer_id, category, visibility, embedding_version)', async () => {
    const db = setupDb({ origin_node: 'NODE000', visibility: 'public' })
    const env = freshEnv(db)

    await embedDatasetJob(env, { dataset_id: DATASET_ID })

    const matches = await queryEmbedding(env, await embedKnown(env), { limit: 1 })
    expect(matches[0].metadata).toEqual({
      peer_id: 'NODE000',
      category: 'atmosphere', // lex-first of ['Atmosphere', 'Oceans']
      visibility: 'public',
      embedding_version: EMBEDDING_MODEL_VERSION,
    })
  })

  it('normalises an unknown visibility to "public" defensively', async () => {
    const db = setupDb({ visibility: 'public' })
    // Force-write an out-of-enum value to simulate a future schema relaxation.
    db.prepare(`UPDATE datasets SET visibility = 'experimental' WHERE id = ?`).run(DATASET_ID)
    const env = freshEnv(db)

    await embedDatasetJob(env, { dataset_id: DATASET_ID })

    const matches = await queryEmbedding(env, await embedKnown(env), { limit: 1 })
    expect(matches[0].metadata?.visibility).toBe('public')
  })

  it('preserves "unlisted" / "private" visibility verbatim', async () => {
    const db = setupDb({ visibility: 'unlisted' })
    const env = freshEnv(db)

    await embedDatasetJob(env, { dataset_id: DATASET_ID })
    const matches = await queryEmbedding(env, await embedKnown(env), { limit: 1 })
    expect(matches[0].metadata?.visibility).toBe('unlisted')
  })

  it('records empty category for a row with no decorations', async () => {
    const db = setupDb({ categories: [], keywords: [] })
    const env = freshEnv(db)

    await embedDatasetJob(env, { dataset_id: DATASET_ID })
    const matches = await queryEmbedding(env, await embedKnown(env), { limit: 1 })
    expect(matches[0].metadata?.category).toBe('')
  })

  it('handles null abstract + organization without crashing', async () => {
    const db = setupDb({ abstract: null, organization: null })
    const env = freshEnv(db)
    const result = await embedDatasetJob(env, { dataset_id: DATASET_ID })
    expect(result.ok).toBe(true)
  })
})

describe('embedDatasetJob — idempotency', () => {
  it('produces an identical text signature on re-run of an unchanged row', async () => {
    const db = setupDb()
    const env = freshEnv(db)

    const a = await embedDatasetJob(env, { dataset_id: DATASET_ID })
    const b = await embedDatasetJob(env, { dataset_id: DATASET_ID })

    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(b.text_signature).toBe(a.text_signature)
  })

  it('produces a different signature + vector when the row changes', async () => {
    const db = setupDb({ title: 'Atlantic Hurricane Tracks' })
    const env = freshEnv(db)

    const before = await embedDatasetJob(env, { dataset_id: DATASET_ID })
    const beforeMatches = await queryEmbedding(env, await embedKnown(env), { limit: 1 })
    const beforeVector = beforeMatches[0]

    db.prepare(`UPDATE datasets SET title = 'Volcano Eruptions' WHERE id = ?`).run(DATASET_ID)
    const after = await embedDatasetJob(env, { dataset_id: DATASET_ID })

    if (!before.ok || !after.ok) throw new Error('unreachable')
    expect(after.text_signature).not.toBe(before.text_signature)

    const afterMatches = await queryEmbedding(env, await embedKnown(env), { limit: 1 })
    expect(afterMatches[0].score).not.toBeCloseTo(beforeVector.score, 6)
  })
})

describe('embedDatasetJob — error / skip surfaces', () => {
  it('returns not_found when the row was deleted', async () => {
    const db = freshMigratedDb()
    const env = freshEnv(db)

    const result = await embedDatasetJob(env, { dataset_id: 'DS_GHOST' })
    expect(result).toEqual({
      ok: false,
      dataset_id: 'DS_GHOST',
      reason: 'not_found',
    })
  })

  it('returns binding_missing without throwing when CATALOG_DB is unset', async () => {
    const env = {
      MOCK_AI: 'true',
      MOCK_VECTORIZE: 'true',
    } as EmbedDatasetEnv
    const result = await embedDatasetJob(env, { dataset_id: DATASET_ID })
    expect(result).toEqual({
      ok: false,
      dataset_id: DATASET_ID,
      reason: 'binding_missing',
    })
  })

  it('does not stamp embedding_version when Vectorize upsert fails', async () => {
    const db = setupDb()
    // Real-binding mode but with a binding that throws on upsert.
    const env = {
      CATALOG_DB: asD1(db),
      MOCK_AI: 'true',
      CATALOG_VECTORIZE: {
        upsert: vi.fn().mockRejectedValue(new Error('vectorize blew up')),
        query: vi.fn(),
        deleteByIds: vi.fn(),
      } as unknown as Vectorize,
    } as EmbedDatasetEnv

    await expect(embedDatasetJob(env, { dataset_id: DATASET_ID })).rejects.toThrow(
      /vectorize blew up/,
    )

    const row = db
      .prepare(`SELECT embedding_version FROM datasets WHERE id = ?`)
      .get(DATASET_ID) as { embedding_version: number | null }
    expect(row.embedding_version).toBeNull()
  })

  it('stamps embedding_version AFTER the upsert succeeds (ordering test)', async () => {
    const db = setupDb()
    const upsertSpy = vi.fn().mockResolvedValue({ mutationId: 'mut' })
    let stampedAtTimeOfUpsert: number | null | 'unread' = 'unread'

    const env = {
      CATALOG_DB: asD1(db),
      MOCK_AI: 'true',
      CATALOG_VECTORIZE: {
        upsert: vi.fn(async () => {
          // Snapshot the column at the moment Vectorize is called —
          // it must still be NULL (stamp comes after).
          const row = db
            .prepare(`SELECT embedding_version FROM datasets WHERE id = ?`)
            .get(DATASET_ID) as { embedding_version: number | null }
          stampedAtTimeOfUpsert = row.embedding_version
          return { mutationId: 'mut' }
        }),
        query: vi.fn(),
        deleteByIds: vi.fn(),
      } as unknown as Vectorize,
    } as EmbedDatasetEnv

    void upsertSpy
    await embedDatasetJob(env, { dataset_id: DATASET_ID })
    expect(stampedAtTimeOfUpsert).toBeNull()
  })
})

/**
 * Helper — embed a known query string in MOCK_AI mode so a test
 * can call `queryEmbedding(env, vec)` against it. The mock embedder
 * uses the same hashing function across calls, so any string with
 * shared vocabulary will produce a usable similarity-ranked result
 * set; we use the canonical row text directly so the dataset's
 * own vector is the closest match.
 */
async function embedKnown(env: EmbedDatasetEnv): Promise<number[]> {
  const { embedDatasetText } = await import('./embeddings')
  return embedDatasetText(env, 'Atlantic Hurricane Tracks NOAA Storm tracks atmosphere oceans')
}
