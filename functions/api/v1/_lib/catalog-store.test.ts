/**
 * Regression test for the D1 bind-variable cliff in `getDecorations`.
 *
 * Pre-1d/K, the function built a single `IN (?, ?, …, ?)` clause
 * with one placeholder per dataset id, which D1 capped at 100 binds
 * per prepared statement. The Phase 1d SOS bulk import landed 191
 * published rows; the next public catalog read 503'd with
 * `D1_ERROR: too many SQL variables`. The fix chunks the id list
 * at 80 per batch and merges the rows; this test pins that — seed
 * 150 datasets each with one tag / category / keyword and verify
 * `getDecorations` returns the full set without erroring.
 */

import { describe, expect, it } from 'vitest'
import { getDecorations } from './catalog-store'
import { asD1, seedFixtures } from './test-helpers'

describe('getDecorations — D1 bind-variable chunking (1d/K)', () => {
  it('returns decorations for every id when N > the per-statement bind cap', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const insertDataset = sqlite.prepare(
      `INSERT INTO datasets (
        id, slug, origin_node, title, format, data_ref,
        weight, visibility, is_hidden, schema_version,
        created_at, updated_at, published_at
      ) VALUES (?, ?, 'NODE000', ?, 'video/mp4', 'vimeo:1', 0, 'public', 0, 1,
                '2026-04-30T00:00:00.000Z', '2026-04-30T00:00:00.000Z', '2026-04-30T00:00:00.000Z')`,
    )
    const insertTag = sqlite.prepare(
      `INSERT INTO dataset_tags (dataset_id, tag) VALUES (?, ?)`,
    )
    const insertCategory = sqlite.prepare(
      `INSERT INTO dataset_categories (dataset_id, facet, value) VALUES (?, 'Theme', ?)`,
    )
    const insertKeyword = sqlite.prepare(
      `INSERT INTO dataset_keywords (dataset_id, keyword) VALUES (?, ?)`,
    )

    const N = 150
    const ids: string[] = []
    for (let i = 0; i < N; i++) {
      const id = `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)
      ids.push(id)
      insertDataset.run(id, `dataset-${i}`, `Dataset ${i}`)
      insertTag.run(id, `tag-${i}`)
      insertCategory.run(id, `value-${i}`)
      insertKeyword.run(id, `keyword-${i}`)
    }

    const db = asD1(sqlite)
    const decorations = await getDecorations(db, ids)

    expect(decorations.size).toBe(N)
    for (const id of ids) {
      const d = decorations.get(id)
      expect(d).toBeDefined()
      expect(d!.tags).toHaveLength(1)
      expect(d!.categories).toHaveLength(1)
      expect(d!.keywords).toHaveLength(1)
    }
  })

  it('returns an empty map for an empty id list (no queries fired)', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const decorations = await getDecorations(asD1(sqlite), [])
    expect(decorations.size).toBe(0)
  })
})
