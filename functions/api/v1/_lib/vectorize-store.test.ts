/**
 * Tests for the Vectorize storage helpers.
 *
 * Coverage:
 *   - Validation: vectors must be 768-dim non-empty number[].
 *   - `MOCK_VECTORIZE=true`:
 *       - upsert + query round-trips by cosine similarity.
 *       - delete is idempotent.
 *       - filter operators (`$eq` shorthand, `$eq`, `$ne`, `$in`,
 *         `$nin`) drop non-matching rows.
 *       - `topK` clamps to `VECTORIZE_MAX_TOP_K`.
 *       - tie-breaking is deterministic by id.
 *   - Real-binding mode:
 *       - `upsertEmbedding` calls `index.upsert` with the right
 *         payload shape.
 *       - `queryEmbedding` forwards `topK` / `filter` and maps the
 *         binding's `VectorizeMatches` onto the helper's flat shape.
 *       - `deleteEmbedding` forwards the id list to `deleteByIds`.
 *   - `requireVectorize` raises a `ConfigurationError` (mapped to
 *     503 by the route layer) when no binding and no mock flag.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  __clearMockStore,
  deleteEmbedding,
  queryEmbedding,
  upsertEmbedding,
  VECTORIZE_DEFAULT_TOP_K,
  VECTORIZE_EMBEDDING_DIMENSIONS,
  VECTORIZE_MAX_TOP_K,
  type DatasetVectorMetadata,
  type VectorizeEnv,
} from './vectorize-store'
import { isConfigurationError } from './errors'

const DIM = VECTORIZE_EMBEDDING_DIMENSIONS

function vec(fill: number, length = DIM): number[] {
  return new Array(length).fill(fill)
}

/** Build a 768-dim vector with a single coordinate set so cosine ranks it. */
function unitVec(axis: number, magnitude = 1): number[] {
  const v = new Array(DIM).fill(0)
  v[axis] = magnitude
  return v
}

const META: DatasetVectorMetadata = {
  peer_id: 'local',
  category: 'atmosphere',
  visibility: 'public',
  embedding_version: 1,
}

describe('validation', () => {
  it('rejects empty vectors', async () => {
    const env: VectorizeEnv = { MOCK_VECTORIZE: 'true' }
    await expect(
      upsertEmbedding(env, { dataset_id: 'DS001', values: [], metadata: META }),
    ).rejects.toThrow(/non-empty/)
  })

  it('rejects wrong-dim vectors', async () => {
    const env: VectorizeEnv = { MOCK_VECTORIZE: 'true' }
    await expect(
      upsertEmbedding(env, { dataset_id: 'DS001', values: vec(0.1, 1024), metadata: META }),
    ).rejects.toThrow(/768-dim/)
  })

  it('rejects wrong-dim query vectors', async () => {
    const env: VectorizeEnv = { MOCK_VECTORIZE: 'true' }
    await expect(queryEmbedding(env, vec(0.1, 384))).rejects.toThrow(/768-dim/)
  })
})

describe('MOCK_VECTORIZE — upsert + query round-trip', () => {
  function freshEnv(): VectorizeEnv {
    const env: VectorizeEnv = { MOCK_VECTORIZE: 'true' }
    __clearMockStore(env)
    return env
  }

  it('round-trips by cosine similarity', async () => {
    const env = freshEnv()

    await upsertEmbedding(env, { dataset_id: 'DS_HURRICANE', values: unitVec(0), metadata: META })
    await upsertEmbedding(env, { dataset_id: 'DS_OCEAN', values: unitVec(1), metadata: META })
    await upsertEmbedding(env, { dataset_id: 'DS_VOLCANO', values: unitVec(2), metadata: META })

    const results = await queryEmbedding(env, unitVec(0))
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].dataset_id).toBe('DS_HURRICANE')
    expect(results[0].score).toBeCloseTo(1, 5)
    // Orthogonal vectors land at 0.
    expect(results.find(r => r.dataset_id === 'DS_OCEAN')?.score).toBeCloseTo(0, 5)
  })

  it('returns metadata on each match', async () => {
    const env = freshEnv()
    await upsertEmbedding(env, { dataset_id: 'DS001', values: unitVec(0), metadata: META })

    const [match] = await queryEmbedding(env, unitVec(0))
    expect(match.metadata).toEqual(META)
  })

  it('upsert overwrites in place', async () => {
    const env = freshEnv()
    await upsertEmbedding(env, { dataset_id: 'DS001', values: unitVec(0), metadata: META })
    await upsertEmbedding(env, {
      dataset_id: 'DS001',
      values: unitVec(7),
      metadata: { ...META, embedding_version: 2 },
    })

    // Querying along the new axis matches; the old axis no longer does.
    const newAxisHit = await queryEmbedding(env, unitVec(7))
    expect(newAxisHit[0].dataset_id).toBe('DS001')
    expect(newAxisHit[0].metadata?.embedding_version).toBe(2)

    const oldAxisHit = await queryEmbedding(env, unitVec(0))
    expect(oldAxisHit[0].score).toBeCloseTo(0, 5)
  })

  it('delete is idempotent', async () => {
    const env = freshEnv()
    await upsertEmbedding(env, { dataset_id: 'DS001', values: unitVec(0), metadata: META })

    await deleteEmbedding(env, 'DS001')
    expect(await queryEmbedding(env, unitVec(0))).toEqual([])

    // Second delete must not throw.
    await expect(deleteEmbedding(env, 'DS001')).resolves.toBeUndefined()
    await expect(deleteEmbedding(env, 'DS_NEVER_EXISTED')).resolves.toBeUndefined()
  })

  it('clamps topK to VECTORIZE_MAX_TOP_K', async () => {
    const env = freshEnv()
    for (let i = 0; i < VECTORIZE_MAX_TOP_K + 5; i++) {
      // All identical vectors so the tie-breaker drives ordering.
      await upsertEmbedding(env, {
        dataset_id: `DS${i.toString().padStart(3, '0')}`,
        values: unitVec(0),
        metadata: META,
      })
    }
    const results = await queryEmbedding(env, unitVec(0), { limit: 1000 })
    expect(results).toHaveLength(VECTORIZE_MAX_TOP_K)
  })

  it('defaults topK to VECTORIZE_DEFAULT_TOP_K when limit is omitted', async () => {
    const env = freshEnv()
    for (let i = 0; i < VECTORIZE_DEFAULT_TOP_K + 5; i++) {
      await upsertEmbedding(env, {
        dataset_id: `DS${i.toString().padStart(3, '0')}`,
        values: unitVec(0),
        metadata: META,
      })
    }
    expect(await queryEmbedding(env, unitVec(0))).toHaveLength(VECTORIZE_DEFAULT_TOP_K)
  })

  it('tie-breaks deterministically by id', async () => {
    const env = freshEnv()
    // Two identical vectors → identical scores → id ordering wins.
    await upsertEmbedding(env, { dataset_id: 'DS_BBB', values: unitVec(0), metadata: META })
    await upsertEmbedding(env, { dataset_id: 'DS_AAA', values: unitVec(0), metadata: META })

    const a = await queryEmbedding(env, unitVec(0))
    const b = await queryEmbedding(env, unitVec(0))
    expect(a.map(m => m.dataset_id)).toEqual(['DS_AAA', 'DS_BBB'])
    expect(b.map(m => m.dataset_id)).toEqual(a.map(m => m.dataset_id))
  })
})

describe('MOCK_VECTORIZE — filter operators', () => {
  function envWithThree(): VectorizeEnv {
    const env: VectorizeEnv = { MOCK_VECTORIZE: 'true' }
    __clearMockStore(env)
    return env
  }

  async function seedThree(env: VectorizeEnv) {
    await upsertEmbedding(env, {
      dataset_id: 'LOCAL_ATMO',
      values: unitVec(0),
      metadata: { peer_id: 'local', category: 'atmosphere', visibility: 'public', embedding_version: 1 },
    })
    await upsertEmbedding(env, {
      dataset_id: 'LOCAL_OCEAN',
      values: unitVec(0),
      metadata: { peer_id: 'local', category: 'oceans', visibility: 'public', embedding_version: 1 },
    })
    await upsertEmbedding(env, {
      dataset_id: 'PEER_ATMO',
      values: unitVec(0),
      metadata: { peer_id: 'peer-x', category: 'atmosphere', visibility: 'public', embedding_version: 1 },
    })
  }

  it('implicit-equality scalar filter drops non-matching rows', async () => {
    const env = envWithThree()
    await seedThree(env)
    const results = await queryEmbedding(env, unitVec(0), { filter: { peer_id: 'local' } })
    expect(results.map(r => r.dataset_id).sort()).toEqual(['LOCAL_ATMO', 'LOCAL_OCEAN'])
  })

  it('$eq behaves identically to scalar shorthand', async () => {
    const env = envWithThree()
    await seedThree(env)
    const results = await queryEmbedding(env, unitVec(0), {
      filter: { peer_id: { $eq: 'local' } },
    })
    expect(results.map(r => r.dataset_id).sort()).toEqual(['LOCAL_ATMO', 'LOCAL_OCEAN'])
  })

  it('$ne excludes the listed value', async () => {
    const env = envWithThree()
    await seedThree(env)
    const results = await queryEmbedding(env, unitVec(0), {
      filter: { peer_id: { $ne: 'local' } },
    })
    expect(results.map(r => r.dataset_id)).toEqual(['PEER_ATMO'])
  })

  it('$in matches any value in the list', async () => {
    const env = envWithThree()
    await seedThree(env)
    const results = await queryEmbedding(env, unitVec(0), {
      filter: { category: { $in: ['atmosphere'] } },
    })
    expect(results.map(r => r.dataset_id).sort()).toEqual(['LOCAL_ATMO', 'PEER_ATMO'])
  })

  it('$nin excludes any value in the list', async () => {
    const env = envWithThree()
    await seedThree(env)
    const results = await queryEmbedding(env, unitVec(0), {
      filter: { category: { $nin: ['oceans'] } },
    })
    expect(results.map(r => r.dataset_id).sort()).toEqual(['LOCAL_ATMO', 'PEER_ATMO'])
  })

  it('combines multiple filter fields with AND semantics', async () => {
    const env = envWithThree()
    await seedThree(env)
    const results = await queryEmbedding(env, unitVec(0), {
      filter: { peer_id: 'local', category: 'atmosphere' },
    })
    expect(results.map(r => r.dataset_id)).toEqual(['LOCAL_ATMO'])
  })
})

describe('real-binding mode', () => {
  /**
   * Mock binding implementing just the methods the helpers call.
   * Records calls so assertions can target the wire shape.
   */
  function makeBinding() {
    return {
      describe: vi.fn(),
      query: vi.fn().mockResolvedValue({ matches: [], count: 0 }),
      queryById: vi.fn(),
      insert: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ mutationId: 'mut-1' }),
      deleteByIds: vi.fn().mockResolvedValue({ mutationId: 'mut-2' }),
      getByIds: vi.fn(),
    }
  }

  it('upsertEmbedding forwards id, values, metadata to the binding', async () => {
    const binding = makeBinding()
    const env: VectorizeEnv = { CATALOG_VECTORIZE: binding as unknown as Vectorize }

    await upsertEmbedding(env, {
      dataset_id: 'DS001',
      values: unitVec(0),
      metadata: META,
    })

    expect(binding.upsert).toHaveBeenCalledTimes(1)
    const [vectors] = binding.upsert.mock.calls[0]
    expect(vectors).toHaveLength(1)
    expect(vectors[0].id).toBe('DS001')
    expect(vectors[0].values).toEqual(unitVec(0))
    expect(vectors[0].metadata).toEqual(META)
  })

  it('queryEmbedding forwards topK + filter and maps matches', async () => {
    const binding = makeBinding()
    binding.query.mockResolvedValueOnce({
      matches: [
        { id: 'DS001', score: 0.92, metadata: META },
        { id: 'DS002', score: 0.81 },
      ],
      count: 2,
    })
    const env: VectorizeEnv = { CATALOG_VECTORIZE: binding as unknown as Vectorize }

    const result = await queryEmbedding(env, unitVec(0), {
      limit: 5,
      filter: { peer_id: 'local' },
    })

    expect(binding.query).toHaveBeenCalledTimes(1)
    const [values, opts] = binding.query.mock.calls[0]
    expect(values).toEqual(unitVec(0))
    expect(opts.topK).toBe(5)
    expect(opts.filter).toEqual({ peer_id: 'local' })
    expect(opts.returnMetadata).toBe('indexed')

    expect(result).toEqual([
      { dataset_id: 'DS001', score: 0.92, metadata: META },
      { dataset_id: 'DS002', score: 0.81, metadata: undefined },
    ])
  })

  it('queryEmbedding clamps oversized topK before forwarding', async () => {
    const binding = makeBinding()
    const env: VectorizeEnv = { CATALOG_VECTORIZE: binding as unknown as Vectorize }

    await queryEmbedding(env, unitVec(0), { limit: 9999 })
    expect(binding.query.mock.calls[0][1].topK).toBe(VECTORIZE_MAX_TOP_K)
  })

  it('deleteEmbedding forwards the id list to deleteByIds', async () => {
    const binding = makeBinding()
    const env: VectorizeEnv = { CATALOG_VECTORIZE: binding as unknown as Vectorize }

    await deleteEmbedding(env, 'DS001')

    expect(binding.deleteByIds).toHaveBeenCalledWith(['DS001'])
  })
})

describe('configuration error', () => {
  it('upsertEmbedding raises ConfigurationError when no binding and no mock', async () => {
    const env: VectorizeEnv = {}
    try {
      await upsertEmbedding(env, { dataset_id: 'DS001', values: unitVec(0), metadata: META })
      throw new Error('expected ConfigurationError')
    } catch (err) {
      expect(isConfigurationError(err)).toBe(true)
      expect((err as Error).message).toMatch(/MOCK_VECTORIZE/)
    }
  })

  it('queryEmbedding raises ConfigurationError when no binding and no mock', async () => {
    const env: VectorizeEnv = {}
    try {
      await queryEmbedding(env, unitVec(0))
      throw new Error('expected ConfigurationError')
    } catch (err) {
      expect(isConfigurationError(err)).toBe(true)
    }
  })

  it('deleteEmbedding raises ConfigurationError when no binding and no mock', async () => {
    const env: VectorizeEnv = {}
    try {
      await deleteEmbedding(env, 'DS001')
      throw new Error('expected ConfigurationError')
    } catch (err) {
      expect(isConfigurationError(err)).toBe(true)
    }
  })
})
