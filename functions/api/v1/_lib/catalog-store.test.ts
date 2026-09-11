// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listMigrations, MIGRATIONS_DIR, renderSchemaSnapshot, SCHEMA_SNAPSHOT_PATH } from '../../../../scripts/lib/catalog-migrations'
import { getDecorations, getNodeIdentity, getPublicDataset, listPublicDatasets } from './catalog-store'
import { asD1, seedFixtures } from './test-helpers'
import { serializeDataset } from './dataset-serializer'

describe('metadata annotation migration and internal reads', () => {
  it('backfills every legacy row to unknown without changing bounds, timestamps, or licenses', () => {
    const sqlite = new Database(':memory:')
    try {
      const migration = '0054_metadata_provenance.sql'
      for (const name of listMigrations().filter(name => name < migration)) {
        sqlite.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
      }
      const insert = sqlite.prepare(`INSERT INTO datasets
        (id, slug, origin_node, title, format, data_ref, bbox_n, bbox_s, bbox_w, bbox_e,
         start_time, end_time, period, created_at, updated_at, published_at, license_statement)
        VALUES (?, ?, 'NODE000', 'Legacy', 'image/png', 'url:https://example.com/image.png', ?, ?, ?, ?,
          '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', 'P1D', '2026-01-01', '2026-02-01', '2026-03-01', 'Keep license')`)
      insert.run('unknown', 'unknown', null, null, null, null)
      insert.run('global', 'global', 90, -90, -180, 180)
      insert.run('partial', 'partial', 10, null, null, null)
      const before = sqlite.prepare('SELECT * FROM datasets ORDER BY id').all()
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, migration), 'utf8'))
      const after = sqlite.prepare('SELECT * FROM datasets ORDER BY id').all()
      expect(after).toEqual(before.map(row => ({
        ...(row as object), bbox_provenance: 'unknown', bbox_evidence: null,
        temporal_semantics: 'unknown', temporal_evidence: null, resource_kind: 'unknown',
      })))
    } finally {
      sqlite.close()
    }
  })

  it('enforces enum/default and evidence-size constraints with real migrations', () => {
    const sqlite = seedFixtures({ count: 1 })
    try {
      for (const field of ['bbox_provenance', 'temporal_semantics', 'resource_kind']) {
        expect(() => sqlite.prepare(`UPDATE datasets SET ${field} = ?`).run('invalid')).toThrow()
        expect(() => sqlite.prepare(`UPDATE datasets SET ${field} = NULL`).run()).toThrow()
      }
      for (const field of ['bbox_evidence', 'temporal_evidence']) {
        expect(() => sqlite.prepare(`UPDATE datasets SET ${field} = ?`).run('x'.repeat(2049))).toThrow()
        expect(() => sqlite.prepare(`UPDATE datasets SET ${field} = ?`).run('x'.repeat(2048))).not.toThrow()
      }
      expect(renderSchemaSnapshot(sqlite)).toBe(readFileSync(SCHEMA_SNAPSHOT_PATH, 'utf8'))
    } finally {
      sqlite.close()
    }
  })

  it('reads annotations internally while leaving native serialization exactly unchanged', async () => {
    const sqlite = seedFixtures({ count: 1 })
    try {
      const db = asD1(sqlite)
      const [before] = await listPublicDatasets(db)
      expect(before).toMatchObject({ bbox_provenance: 'unknown', temporal_semantics: 'unknown', resource_kind: 'unknown', bbox_n: null, start_time: null })
      const identity = (await getNodeIdentity(db))!
      const decoration = (await getDecorations(db, [before.id])).get(before.id)!
      const wireBefore = serializeDataset(before, decoration, identity)
      sqlite.prepare(`UPDATE datasets SET bbox_provenance = 'unknown', bbox_evidence = 'Needs curator review',
        temporal_semantics = 'publication', temporal_evidence = 'Release date only', resource_kind = 'presentation'`).run()
      const after = (await getPublicDataset(db, before.id))!
      expect(after).toMatchObject({ bbox_evidence: 'Needs curator review', temporal_semantics: 'publication', temporal_evidence: 'Release date only', resource_kind: 'presentation' })
      expect(serializeDataset(after, decoration, identity)).toEqual(wireBefore)
    } finally {
      sqlite.close()
    }
  })
})

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

describe('listPublicDatasets / getPublicDataset — published_at filter', () => {
  // Found during a production smoke test: a draft (created via
  // the publisher portal but not yet published) appeared in the
  // SPA's browse panel alongside published datasets. Root cause:
  // the catalog filter only checked `visibility = 'public'`,
  // `is_hidden = 0`, and `retracted_at IS NULL` — but the
  // `visibility` column defaults to 'public' on insert, so a
  // draft row with no explicit visibility setting was leaking
  // through. The published_at IS NOT NULL clause closes that
  // gap. Search + featured queries already had it; this fixes
  // the parity gap on the main public listing.

  it('listPublicDatasets excludes rows with published_at IS NULL (drafts)', async () => {
    const sqlite = seedFixtures({ count: 0 })
    // Two rows in the same shape — one published, one draft.
    // Both have visibility='public' (the column default) so the
    // filter has to key off published_at to distinguish them.
    const insert = sqlite.prepare(`
      INSERT INTO datasets (
        id, slug, origin_node, title, format, data_ref, weight,
        visibility, is_hidden, schema_version, created_at, updated_at,
        published_at
      ) VALUES (?, ?, 'NODE000', ?, 'video/mp4', 'vimeo:1', 0,
        'public', 0, 1, ?, ?, ?)
    `)
    insert.run(
      'DS001' + 'A'.repeat(21),
      'published-row',
      'Published',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    )
    insert.run(
      'DS002' + 'A'.repeat(21),
      'draft-row',
      'Still a draft',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      null,
    )

    const rows = await listPublicDatasets(asD1(sqlite))
    expect(rows).toHaveLength(1)
    expect(rows[0].slug).toBe('published-row')
  })

  it('listPublicDatasets excludes retracted rows even when published_at is set', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const insert = sqlite.prepare(`
      INSERT INTO datasets (
        id, slug, origin_node, title, format, data_ref, weight,
        visibility, is_hidden, schema_version, created_at, updated_at,
        published_at, retracted_at
      ) VALUES (?, ?, 'NODE000', ?, 'video/mp4', 'vimeo:1', 0,
        'public', 0, 1, ?, ?, ?, ?)
    `)
    insert.run(
      'DS003' + 'A'.repeat(21),
      'retracted-row',
      'Was published, now retracted',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    )

    const rows = await listPublicDatasets(asD1(sqlite))
    expect(rows).toHaveLength(0)
  })

  it('getPublicDataset returns NULL for a draft, the row for a published dataset', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const publishedId = 'DS010' + 'A'.repeat(21)
    const draftId = 'DS011' + 'A'.repeat(21)
    const insert = sqlite.prepare(`
      INSERT INTO datasets (
        id, slug, origin_node, title, format, data_ref, weight,
        visibility, is_hidden, schema_version, created_at, updated_at,
        published_at
      ) VALUES (?, ?, 'NODE000', ?, 'video/mp4', 'vimeo:1', 0,
        'public', 0, 1, ?, ?, ?)
    `)
    insert.run(
      publishedId,
      'pub',
      'Published',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    )
    insert.run(
      draftId,
      'draft',
      'Draft',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      null,
    )

    const draft = await getPublicDataset(asD1(sqlite), draftId)
    expect(draft).toBeNull()
    const pub = await getPublicDataset(asD1(sqlite), publishedId)
    expect(pub).not.toBeNull()
    expect(pub!.slug).toBe('pub')
  })
})
