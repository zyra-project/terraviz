/**
 * Tests for the featured_datasets row helpers.
 *
 * Coverage:
 *   - listFeaturedDatasets returns rows in `(position ASC,
 *     added_at ASC)` order, honors `limit`.
 *   - addFeaturedDataset inserts a fresh row, refuses duplicates
 *     with 409, refuses unknown dataset_id with 404.
 *   - updateFeaturedPosition updates position, 404s if absent.
 *   - removeFeaturedDataset is idempotent.
 *   - validatePosition rejects non-integers and out-of-range values.
 */

import { describe, expect, it } from 'vitest'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'
import { asD1 } from './test-helpers'
import type { CatalogEnv } from './env'
import {
  addFeaturedDataset,
  FEATURED_DOCENT_DEFAULT_LIMIT,
  FEATURED_DOCENT_MAX_LIMIT,
  listFeaturedDatasets,
  listFeaturedForDocent,
  removeFeaturedDataset,
  updateFeaturedPosition,
  validatePosition,
} from './featured-datasets'
import type { PublisherRow } from './publisher-store'

const STAFF: PublisherRow = {
  id: 'PUB-STAFF',
  email: 'staff@example.com',
  display_name: 'Staff',
  affiliation: null,
  org_id: null,
  role: 'staff',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}

function setupDb(datasetCount = 3) {
  const sqlite = freshMigratedDb()
  const ts = '2026-04-29T12:00:00.000Z'
  sqlite
    .prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
       VALUES ('NODE000', 'T', 'https://t', 'k', ?)`,
    )
    .run(ts)
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(STAFF.id, STAFF.email, STAFF.display_name, STAFF.role, STAFF.is_admin, STAFF.status, ts)
  for (let i = 0; i < datasetCount; i++) {
    const id = `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)
    sqlite
      .prepare(
        `INSERT INTO datasets (id, slug, origin_node, title, format, data_ref,
                               weight, visibility, is_hidden, schema_version,
                               created_at, updated_at, publisher_id)
         VALUES (?, ?, 'NODE000', ?, 'video/mp4', '', 0, 'public', 0, 1, ?, ?, ?)`,
      )
      .run(id, `dataset-${i}`, `Dataset ${i}`, ts, ts, STAFF.id)
  }
  return { sqlite, d1: asD1(sqlite) }
}

describe('listFeaturedDatasets', () => {
  it('returns rows in (position, added_at) order', async () => {
    const { sqlite, d1 } = setupDb()
    const ids = [0, 1, 2].map(i => `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21))
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ids[2], 5, STAFF.id, '2026-04-29T12:00:00.000Z')
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ids[0], 1, STAFF.id, '2026-04-29T12:01:00.000Z')
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ids[1], 5, STAFF.id, '2026-04-29T12:02:00.000Z')
    const list = await listFeaturedDatasets(d1)
    expect(list.map(r => r.dataset_id)).toEqual([ids[0], ids[2], ids[1]])
  })

  it('honours limit', async () => {
    const { sqlite, d1 } = setupDb()
    const ids = [0, 1, 2].map(i => `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21))
    for (let i = 0; i < 3; i++) {
      sqlite
        .prepare(
          `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(ids[i], i, STAFF.id, '2026-04-29T12:00:00.000Z')
    }
    const list = await listFeaturedDatasets(d1, { limit: 2 })
    expect(list).toHaveLength(2)
  })
})

describe('addFeaturedDataset', () => {
  it('inserts a fresh row', async () => {
    const { d1 } = setupDb()
    const result = await addFeaturedDataset(d1, STAFF, {
      dataset_id: 'DS000' + 'A'.repeat(21),
      position: 1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.row.position).toBe(1)
    expect(result.row.added_by).toBe(STAFF.id)
  })

  it('refuses duplicates with 409', async () => {
    const { d1 } = setupDb()
    const id = 'DS000' + 'A'.repeat(21)
    await addFeaturedDataset(d1, STAFF, { dataset_id: id, position: 1 })
    const second = await addFeaturedDataset(d1, STAFF, { dataset_id: id, position: 2 })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.status).toBe(409)
    expect(second.error).toBe('already_featured')
  })

  it('refuses unknown dataset_id with 404', async () => {
    const { d1 } = setupDb()
    const result = await addFeaturedDataset(d1, STAFF, {
      dataset_id: 'DS999' + 'A'.repeat(21),
      position: 1,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
  })

  it('handles a concurrent-add race via ON CONFLICT (no UNIQUE 500)', async () => {
    const { sqlite, d1 } = setupDb()
    const id = 'DS000' + 'A'.repeat(21)
    // Simulate the race by pre-inserting the row directly, then
    // invoking addFeaturedDataset. The function's existence-check
    // could pass concurrently with another writer; this test
    // validates the loser branch returns a clean 409 instead of
    // letting the UNIQUE constraint trigger a 500.
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, 1, STAFF.id, '2026-04-29T12:00:00.000Z')
    const result = await addFeaturedDataset(d1, STAFF, { dataset_id: id, position: 5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.error).toBe('already_featured')
    // Position is unchanged — the loser MUST NOT overwrite the winner.
    const row = sqlite
      .prepare(`SELECT position FROM featured_datasets WHERE dataset_id = ?`)
      .get(id) as { position: number }
    expect(row.position).toBe(1)
  })
})

describe('updateFeaturedPosition', () => {
  it('updates an existing row', async () => {
    const { d1 } = setupDb()
    const id = 'DS000' + 'A'.repeat(21)
    await addFeaturedDataset(d1, STAFF, { dataset_id: id, position: 1 })
    const result = await updateFeaturedPosition(d1, id, 7)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.row.position).toBe(7)
  })

  it('404s when the dataset is not featured', async () => {
    const { d1 } = setupDb()
    const result = await updateFeaturedPosition(d1, 'DS999' + 'A'.repeat(21), 5)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
  })
})

describe('removeFeaturedDataset', () => {
  it('removes when present', async () => {
    const { d1 } = setupDb()
    const id = 'DS000' + 'A'.repeat(21)
    await addFeaturedDataset(d1, STAFF, { dataset_id: id, position: 1 })
    await removeFeaturedDataset(d1, id)
    const list = await listFeaturedDatasets(d1)
    expect(list).toHaveLength(0)
  })

  it('is idempotent when absent', async () => {
    const { d1 } = setupDb()
    await expect(removeFeaturedDataset(d1, 'DS999' + 'A'.repeat(21))).resolves.not.toThrow()
  })
})

describe('validatePosition', () => {
  it('accepts positive integers up to 1_000_000', () => {
    expect(validatePosition(0)).toEqual({ ok: true, position: 0 })
    expect(validatePosition(50)).toEqual({ ok: true, position: 50 })
    expect(validatePosition(1_000_000)).toEqual({ ok: true, position: 1_000_000 })
  })

  it('refuses non-integers and out-of-range values', () => {
    for (const v of [-1, 1.5, NaN, '5', null, undefined, 1_000_001]) {
      const r = validatePosition(v)
      expect(r.ok).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Docent-shaped read surface (Phase 1c)
// ---------------------------------------------------------------------------

/**
 * Like `setupDb` above but the seeded datasets are PUBLISHED so the
 * docent-shaped helper's visibility filter doesn't drop them.
 * Inserts the row + decoration content the docent payload reads.
 */
function setupPublished(): { sqlite: ReturnType<typeof freshMigratedDb>; env: CatalogEnv; ids: string[] } {
  const sqlite = freshMigratedDb()
  const ts = '2026-04-29T12:00:00.000Z'
  sqlite
    .prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
       VALUES ('NODE000', 'T', 'https://t', 'k', ?)`,
    )
    .run(ts)
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(STAFF.id, STAFF.email, STAFF.display_name, STAFF.role, STAFF.is_admin, STAFF.status, ts)

  const ids: string[] = []
  for (let i = 0; i < 4; i++) {
    const id = `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)
    ids.push(id)
    sqlite
      .prepare(
        `INSERT INTO datasets (id, slug, origin_node, title, abstract, format, data_ref,
                               sphere_thumbnail_ref, thumbnail_ref,
                               weight, visibility, is_hidden, schema_version,
                               created_at, updated_at, published_at, publisher_id)
         VALUES (?, ?, 'NODE000', ?, ?, 'video/mp4', 'vimeo:1',
                 ?, ?, 0, 'public', 0, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `dataset-${i}`,
        `Dataset ${i}`,
        `Abstract for dataset ${i}.`,
        i === 0 ? `r2:datasets/${id}/sphere-thumbnail.jpg` : null,
        i === 1 ? 'https://example.com/flat.png' : null,
        ts,
        ts,
        ts,
        STAFF.id,
      )
    sqlite
      .prepare(
        `INSERT INTO dataset_categories (dataset_id, facet, value) VALUES (?, 'theme', ?)`,
      )
      .run(id, i % 2 === 0 ? 'Atmosphere' : 'Oceans')
  }
  const env: CatalogEnv = {
    CATALOG_DB: asD1(sqlite),
    MOCK_R2: 'true', // so r2: thumbnail refs resolve to a stub URL
    CATALOG_R2_BUCKET: 'terraviz-assets',
  }
  return { sqlite, env, ids }
}

describe('listFeaturedForDocent', () => {
  it('returns empty when CATALOG_DB is unset', async () => {
    const env: CatalogEnv = {}
    expect(await listFeaturedForDocent(env)).toEqual({ datasets: [] })
  })

  it('returns hydrated docent-shaped rows in curation order', async () => {
    const { sqlite, env, ids } = setupPublished()
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, 'PUB-STAFF', ?)`,
      )
      .run(ids[0], 1, '2026-04-29T12:00:00.000Z')
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, 'PUB-STAFF', ?)`,
      )
      .run(ids[1], 2, '2026-04-29T12:00:00.000Z')

    const result = await listFeaturedForDocent(env)
    expect(result.datasets).toHaveLength(2)
    expect(result.datasets[0]).toEqual({
      id: ids[0],
      title: 'Dataset 0',
      abstract_snippet: 'Abstract for dataset 0.',
      thumbnail_url: `https://mock-r2.localhost/terraviz-assets/datasets/${ids[0]}/sphere-thumbnail.jpg`,
      categories: ['Atmosphere'],
      position: 1,
    })
    expect(result.datasets[1].thumbnail_url).toBe('https://example.com/flat.png')
    expect(result.datasets[1].categories).toEqual(['Oceans'])
  })

  it('drops featured rows whose dataset is currently retracted', async () => {
    const { sqlite, env, ids } = setupPublished()
    sqlite.prepare(`UPDATE datasets SET retracted_at = ? WHERE id = ?`).run('2026-04-29T13:00:00.000Z', ids[0])
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, 'PUB-STAFF', ?)`,
      )
      .run(ids[0], 1, '2026-04-29T12:00:00.000Z')
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, ?, 'PUB-STAFF', ?)`,
      )
      .run(ids[1], 2, '2026-04-29T12:00:00.000Z')

    const result = await listFeaturedForDocent(env)
    expect(result.datasets.map(d => d.id)).toEqual([ids[1]])
  })

  it('drops featured rows for hidden / non-public / draft datasets', async () => {
    const { sqlite, env, ids } = setupPublished()
    sqlite.prepare(`UPDATE datasets SET is_hidden = 1 WHERE id = ?`).run(ids[0])
    sqlite.prepare(`UPDATE datasets SET visibility = 'private' WHERE id = ?`).run(ids[1])
    sqlite.prepare(`UPDATE datasets SET published_at = NULL WHERE id = ?`).run(ids[2])
    for (let i = 0; i < 3; i++) {
      sqlite
        .prepare(
          `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
           VALUES (?, ?, 'PUB-STAFF', ?)`,
        )
        .run(ids[i], i, '2026-04-29T12:00:00.000Z')
    }
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, 99, 'PUB-STAFF', ?)`,
      )
      .run(ids[3], '2026-04-29T12:00:00.000Z')

    const result = await listFeaturedForDocent(env)
    expect(result.datasets.map(d => d.id)).toEqual([ids[3]])
  })

  it('caps the result at the requested limit', async () => {
    const { sqlite, env, ids } = setupPublished()
    for (let i = 0; i < 4; i++) {
      sqlite
        .prepare(
          `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
           VALUES (?, ?, 'PUB-STAFF', ?)`,
        )
        .run(ids[i], i, '2026-04-29T12:00:00.000Z')
    }
    const result = await listFeaturedForDocent(env, { limit: 2 })
    expect(result.datasets).toHaveLength(2)
    expect(result.datasets.map(d => d.id)).toEqual([ids[0], ids[1]])
  })

  it('clamps overhuge / non-finite limits to FEATURED_DOCENT_MAX_LIMIT', async () => {
    const { env } = setupPublished()
    // No featured rows seeded — just confirm clampDocentLimit doesn't pass
    // an absurd LIMIT through to D1. We can only check the helper accepts
    // the value without throwing; the seeded set is empty so the result is
    // an empty list.
    await expect(listFeaturedForDocent(env, { limit: 9999 })).resolves.toEqual({ datasets: [] })
    await expect(listFeaturedForDocent(env, { limit: 0 })).resolves.toEqual({ datasets: [] })
  })

  it('exports default + max limit constants used by the route layer', () => {
    expect(FEATURED_DOCENT_DEFAULT_LIMIT).toBeGreaterThanOrEqual(1)
    expect(FEATURED_DOCENT_MAX_LIMIT).toBeGreaterThan(FEATURED_DOCENT_DEFAULT_LIMIT)
  })

  it('returns null thumbnail when the dataset has no thumbnail refs', async () => {
    const { sqlite, env, ids } = setupPublished()
    // ids[2] has no thumbnail seeded.
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, 1, 'PUB-STAFF', ?)`,
      )
      .run(ids[2], '2026-04-29T12:00:00.000Z')
    const result = await listFeaturedForDocent(env)
    expect(result.datasets[0].thumbnail_url).toBeNull()
  })

  it('snips long abstracts to ≤ 280 chars', async () => {
    const { sqlite, env, ids } = setupPublished()
    sqlite
      .prepare(`UPDATE datasets SET abstract = ? WHERE id = ?`)
      .run('x '.repeat(500), ids[0])
    sqlite
      .prepare(
        `INSERT INTO featured_datasets (dataset_id, position, added_by, added_at)
         VALUES (?, 1, 'PUB-STAFF', ?)`,
      )
      .run(ids[0], '2026-04-29T12:00:00.000Z')
    const result = await listFeaturedForDocent(env)
    expect(result.datasets[0].abstract_snippet.length).toBeLessThanOrEqual(280)
    expect(result.datasets[0].abstract_snippet.endsWith('…')).toBe(true)
  })
})
