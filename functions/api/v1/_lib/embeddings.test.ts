/**
 * Tests for the Workers AI embedding helpers.
 *
 * Coverage:
 *   - `buildDatasetEmbeddingText` produces the labelled canonical
 *     form, normalises whitespace + Unicode, sorts + lowercases +
 *     dedupes categories and keywords, handles null abstract /
 *     organization with empty values, and is byte-stable across
 *     decoration insertion orders (the whole point of the
 *     `embedding_version` column).
 *   - `embedDatasetText` in `MOCK_AI=true` mode returns a
 *     deterministic 768-dim unit vector, deterministic across
 *     calls, gives different vectors for different texts, biases
 *     vectors with shared vocabulary closer in cosine similarity
 *     than unrelated ones, and degrades gracefully on empty / all-
 *     punctuation input.
 *   - `embedDatasetText` in real-binding mode forwards the right
 *     model id + payload shape, surfaces async-queue deferrals as
 *     thrown errors (Phase 4 surface), and refuses outputs whose
 *     dimension does not match the configured 768.
 *   - Missing AI binding without `MOCK_AI=true` raises a
 *     `ConfigurationError` (mapped to 503 by the route layer).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildDatasetEmbeddingText,
  embedDatasetText,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_VERSION,
  type EmbeddingEnv,
} from './embeddings'
import { isConfigurationError } from './errors'
import { VECTORIZE_EMBEDDING_DIMENSIONS } from './vectorize-store'
import type { DatasetRow, DecorationRows } from './catalog-store'

const DIM = VECTORIZE_EMBEDDING_DIMENSIONS

type MinimalRow = Pick<DatasetRow, 'title' | 'abstract' | 'organization'>
type MinimalDeco = Pick<DecorationRows, 'categories' | 'keywords'>

const SAMPLE_ROW: MinimalRow = {
  title: 'Atlantic Hurricane Tracks',
  abstract: 'Storm tracks for the Atlantic basin from 1950–2020.',
  organization: 'NOAA',
}

const SAMPLE_DECO: MinimalDeco = {
  categories: [
    { facet: 'theme', value: 'Atmosphere' },
    { facet: 'theme', value: 'Oceans' },
  ],
  keywords: ['hurricane', 'storm', 'atlantic'],
}

describe('buildDatasetEmbeddingText — canonical form', () => {
  it('emits labelled, newline-separated lines in fixed order', () => {
    const text = buildDatasetEmbeddingText(SAMPLE_ROW, SAMPLE_DECO)
    expect(text).toBe(
      [
        'Title: Atlantic Hurricane Tracks',
        'Organization: NOAA',
        'Abstract: Storm tracks for the Atlantic basin from 1950–2020.',
        'Categories: atmosphere, oceans',
        'Keywords: atlantic, hurricane, storm',
      ].join('\n'),
    )
  })

  it('keeps labels when fields are null/empty', () => {
    const text = buildDatasetEmbeddingText(
      { title: 'Untitled', abstract: null, organization: null },
      { categories: [], keywords: [] },
    )
    expect(text).toBe(
      ['Title: Untitled', 'Organization: ', 'Abstract: ', 'Categories: ', 'Keywords: '].join('\n'),
    )
  })

  it('is byte-stable across decoration insertion orders', () => {
    const a = buildDatasetEmbeddingText(SAMPLE_ROW, {
      categories: [
        { facet: 'theme', value: 'Atmosphere' },
        { facet: 'theme', value: 'Oceans' },
      ],
      keywords: ['hurricane', 'storm', 'atlantic'],
    })
    const b = buildDatasetEmbeddingText(SAMPLE_ROW, {
      categories: [
        { facet: 'theme', value: 'Oceans' },
        { facet: 'theme', value: 'Atmosphere' },
      ],
      keywords: ['atlantic', 'storm', 'hurricane'],
    })
    expect(b).toBe(a)
  })

  it('lowercases, dedupes, and sorts categories + keywords', () => {
    const text = buildDatasetEmbeddingText(SAMPLE_ROW, {
      categories: [
        { facet: 'theme', value: 'OCEANS' },
        { facet: 'tag', value: 'oceans' }, // dup after lowercasing
        { facet: 'theme', value: 'Climate' },
      ],
      keywords: ['STORM', 'storm', 'Hurricane'],
    })
    expect(text).toContain('Categories: climate, oceans')
    expect(text).toContain('Keywords: hurricane, storm')
  })

  it('normalises whitespace and Unicode form', () => {
    const text = buildDatasetEmbeddingText(
      {
        title: '  Atlantic   Hurricane  ', // collapsing inner whitespace
        abstract: '\nMulti-line\nabstract.',
        organization: 'café'.normalize('NFD'), // decomposed → composed
      },
      { categories: [], keywords: [] },
    )
    expect(text).toContain('Title: Atlantic Hurricane')
    expect(text).toContain('Abstract: Multi-line abstract.')
    expect(text).toContain(`Organization: ${'café'.normalize('NFC')}`)
  })

  it('drops empty / whitespace-only category and keyword entries', () => {
    const text = buildDatasetEmbeddingText(SAMPLE_ROW, {
      categories: [
        { facet: 'theme', value: '  ' },
        { facet: 'theme', value: 'Atmosphere' },
      ],
      keywords: ['', '   ', 'storm'],
    })
    expect(text).toContain('Categories: atmosphere')
    expect(text).toContain('Keywords: storm')
  })
})

describe('embedDatasetText — MOCK_AI mode', () => {
  const env: EmbeddingEnv = { MOCK_AI: 'true' }

  it('returns a 768-dim unit vector', async () => {
    const v = await embedDatasetText(env, 'hurricane tracks atlantic')
    expect(v).toHaveLength(DIM)
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
  })

  it('is deterministic across calls', async () => {
    const a = await embedDatasetText(env, 'hurricane tracks')
    const b = await embedDatasetText(env, 'hurricane tracks')
    expect(b).toEqual(a)
  })

  it('produces different vectors for different texts', async () => {
    const a = await embedDatasetText(env, 'hurricane tracks')
    const b = await embedDatasetText(env, 'volcano lava flows')
    expect(b).not.toEqual(a)
  })

  it('biases shared-vocabulary texts closer in cosine similarity', async () => {
    const query = await embedDatasetText(env, 'hurricane storm tracks atlantic')
    const sharedDoc = await embedDatasetText(env, 'atlantic hurricane storm season tracks')
    const unrelatedDoc = await embedDatasetText(env, 'volcano lava magma eruption seismic')

    const sharedScore = cosine(query, sharedDoc)
    const unrelatedScore = cosine(query, unrelatedDoc)

    expect(sharedScore).toBeGreaterThan(unrelatedScore)
  })

  it('handles all-punctuation input without producing a zero vector', async () => {
    const v = await embedDatasetText(env, '...!!!---???')
    expect(v).toHaveLength(DIM)
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
  })

  it('refuses empty text', async () => {
    await expect(embedDatasetText(env, '')).rejects.toThrow(/non-empty/)
  })
})

describe('embedDatasetText — real-binding mode', () => {
  function makeAi() {
    return {
      run: vi.fn(),
    }
  }

  it('forwards model id, text, and pooling to AI.run', async () => {
    const ai = makeAi()
    ai.run.mockResolvedValue({ data: [new Array(DIM).fill(0.001)], shape: [1, DIM] })
    const env: EmbeddingEnv = { AI: ai as unknown as Ai }

    await embedDatasetText(env, 'hurricane tracks')

    expect(ai.run).toHaveBeenCalledTimes(1)
    const [model, inputs] = ai.run.mock.calls[0]
    expect(model).toBe(EMBEDDING_MODEL_ID)
    expect(inputs).toEqual({ text: 'hurricane tracks', pooling: 'mean' })
  })

  it('returns the first row of the returned data array', async () => {
    const ai = makeAi()
    const expected = new Array(DIM).fill(0).map((_, i) => i / DIM)
    ai.run.mockResolvedValue({ data: [expected], shape: [1, DIM] })
    const env: EmbeddingEnv = { AI: ai as unknown as Ai }

    const result = await embedDatasetText(env, 'hurricane')
    expect(result).toEqual(expected)
  })

  it('surfaces async-queue deferrals as thrown errors', async () => {
    const ai = makeAi()
    ai.run.mockResolvedValue({ request_id: 'req-123' })
    const env: EmbeddingEnv = { AI: ai as unknown as Ai }

    await expect(embedDatasetText(env, 'hurricane')).rejects.toThrow(/async queue.*req-123/)
  })

  it('refuses outputs of the wrong dimension', async () => {
    const ai = makeAi()
    ai.run.mockResolvedValue({ data: [new Array(384).fill(0)] })
    const env: EmbeddingEnv = { AI: ai as unknown as Ai }

    await expect(embedDatasetText(env, 'hurricane')).rejects.toThrow(/384-dim.*expected 768/)
  })

  it('refuses empty data arrays', async () => {
    const ai = makeAi()
    ai.run.mockResolvedValue({ data: [] })
    const env: EmbeddingEnv = { AI: ai as unknown as Ai }

    await expect(embedDatasetText(env, 'hurricane')).rejects.toThrow(/no embedding data/)
  })

  it('raises ConfigurationError when no AI binding and no MOCK_AI', async () => {
    const env: EmbeddingEnv = {}
    try {
      await embedDatasetText(env, 'hurricane')
      throw new Error('expected ConfigurationError')
    } catch (err) {
      expect(isConfigurationError(err)).toBe(true)
      expect((err as Error).message).toMatch(/MOCK_AI/)
    }
  })
})

describe('exported constants', () => {
  it('pin the canonical model id + version', () => {
    expect(EMBEDDING_MODEL_ID).toBe('@cf/baai/bge-base-en-v1.5')
    expect(EMBEDDING_MODEL_VERSION).toBe(1)
  })
})

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
