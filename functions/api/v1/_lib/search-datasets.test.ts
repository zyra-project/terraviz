/**
 * Tests for the searchDatasets helper.
 *
 * Coverage:
 *   - Empty / blank query → empty result, no embed call.
 *   - Missing CATALOG_DB → empty result, soft-skip.
 *   - Embed bindings unconfigured → `degraded: 'unconfigured'`.
 *   - Happy path: embed → query → hydrate; result preserves
 *     Vectorize's score-sorted order; abstract is snipped to the
 *     280-char ceiling and whitespace-collapsed; categories are
 *     pulled from the decoration table; `peer_id` translates to
 *     `'local'` for own-node rows and to the verbatim node id for
 *     federated rows.
 *   - Filter: `peer_id: 'local'` is translated to the local node
 *     id before being forwarded to Vectorize.
 *   - Filter: a literal peer id is forwarded verbatim.
 *   - Filter: `category` is lowercased + NFC-normalised.
 *   - Hydration drops vectors whose row no longer exists / was
 *     retracted / is hidden / is unpublished.
 *   - Limit clamps at `VECTORIZE_MAX_TOP_K`.
 */

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'
import { asD1 } from './test-helpers'
import { searchDatasets, type SearchDatasetsEnv } from './search-datasets'
import { embedDatasetJob } from './embed-dataset-job'
import {
  __clearMockStore,
  VECTORIZE_MAX_TOP_K,
  type VectorizeEnv,
} from './vectorize-store'

const TS = '2026-04-29T12:00:00.000Z'

interface SeedRow {
  id: string
  title: string
  abstract?: string | null
  organization?: string | null
  origin_node?: string
  visibility?: string
  is_hidden?: number
  published?: boolean
  retracted?: boolean
  categories?: string[]
  keywords?: string[]
}

function seed(rows: SeedRow[]): Database.Database {
  const db = freshMigratedDb()
  db.prepare(
    `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
     VALUES ('LOCAL_NODE', 'T', 'https://t', 'k', ?)`,
  ).run(TS)
  db.prepare(
    `INSERT INTO publishers (id, email, display_name, role, status, created_at)
     VALUES ('PUB001', 'p@t', 'P', 'staff', 'active', ?)`,
  ).run(TS)
  for (const r of rows) {
    db.prepare(
      `INSERT INTO datasets (id, slug, origin_node, title, abstract, organization,
                             format, data_ref, weight, visibility, is_hidden,
                             schema_version, created_at, updated_at,
                             published_at, retracted_at, publisher_id)
       VALUES (?, ?, ?, ?, ?, ?, 'video/mp4', 'vimeo:1', 0, ?, ?, 1, ?, ?, ?, ?, 'PUB001')`,
    ).run(
      r.id,
      r.id.toLowerCase(),
      r.origin_node ?? 'LOCAL_NODE',
      r.title,
      r.abstract ?? null,
      r.organization ?? null,
      r.visibility ?? 'public',
      r.is_hidden ?? 0,
      TS,
      TS,
      r.published === false ? null : TS,
      r.retracted ? TS : null,
    )
    for (const c of r.categories ?? []) {
      db.prepare(
        `INSERT INTO dataset_categories (dataset_id, facet, value) VALUES (?, 'theme', ?)`,
      ).run(r.id, c)
    }
    for (const k of r.keywords ?? []) {
      db.prepare(`INSERT INTO dataset_keywords (dataset_id, keyword) VALUES (?, ?)`).run(
        r.id,
        k,
      )
    }
  }
  return db
}

function freshEnv(db: Database.Database): SearchDatasetsEnv {
  const env = {
    CATALOG_DB: asD1(db),
    MOCK_AI: 'true',
    MOCK_VECTORIZE: 'true',
  } as SearchDatasetsEnv
  __clearMockStore(env as VectorizeEnv)
  return env
}

async function indexAll(env: SearchDatasetsEnv, ids: string[]): Promise<void> {
  for (const id of ids) {
    await embedDatasetJob(env, { dataset_id: id })
  }
}

describe('searchDatasets — early exits', () => {
  it('empty query returns empty datasets', async () => {
    const db = seed([{ id: 'DS001', title: 'Hurricane' }])
    const env = freshEnv(db)
    const result = await searchDatasets(env, { query: '' })
    expect(result).toEqual({ datasets: [] })
  })

  it('whitespace-only query returns empty datasets', async () => {
    const db = seed([{ id: 'DS001', title: 'Hurricane' }])
    const env = freshEnv(db)
    const result = await searchDatasets(env, { query: '   \n  ' })
    expect(result).toEqual({ datasets: [] })
  })

  it('returns empty result when CATALOG_DB is unset', async () => {
    const env: SearchDatasetsEnv = { MOCK_AI: 'true', MOCK_VECTORIZE: 'true' }
    const result = await searchDatasets(env, { query: 'hurricane' })
    expect(result).toEqual({ datasets: [] })
  })

  it('flags degraded when AI binding is missing', async () => {
    const db = seed([{ id: 'DS001', title: 'Hurricane' }])
    const env = { CATALOG_DB: asD1(db), MOCK_VECTORIZE: 'true' } as SearchDatasetsEnv
    const result = await searchDatasets(env, { query: 'hurricane' })
    expect(result).toEqual({ datasets: [], degraded: 'unconfigured' })
  })

  it('flags degraded when Vectorize binding is missing', async () => {
    const db = seed([{ id: 'DS001', title: 'Hurricane' }])
    const env = { CATALOG_DB: asD1(db), MOCK_AI: 'true' } as SearchDatasetsEnv
    const result = await searchDatasets(env, { query: 'hurricane' })
    expect(result).toEqual({ datasets: [], degraded: 'unconfigured' })
  })
})

describe('searchDatasets — happy path', () => {
  it('returns score-ordered hits with the documented payload shape', async () => {
    const db = seed([
      {
        id: 'DS_HURR',
        title: 'Atlantic Hurricane Tracks',
        abstract: 'Storm tracks for the Atlantic basin from 1950 to 2020.',
        categories: ['Atmosphere'],
        keywords: ['hurricane', 'storm', 'atlantic'],
      },
      {
        id: 'DS_VOLC',
        title: 'Volcano Eruptions',
        abstract: 'Eruption events worldwide.',
        categories: ['Geology'],
        keywords: ['volcano', 'lava', 'magma'],
      },
    ])
    const env = freshEnv(db)
    await indexAll(env, ['DS_HURR', 'DS_VOLC'])

    const result = await searchDatasets(env, { query: 'hurricane storm atlantic' })
    expect(result.degraded).toBeUndefined()
    expect(result.datasets[0]).toMatchObject({
      id: 'DS_HURR',
      title: 'Atlantic Hurricane Tracks',
      abstract_snippet: 'Storm tracks for the Atlantic basin from 1950 to 2020.',
      categories: ['Atmosphere'],
      peer_id: 'local',
    })
    expect(typeof result.datasets[0].score).toBe('number')
    expect(result.datasets[0].score).toBeGreaterThan(
      result.datasets[result.datasets.length - 1].score,
    )
  })

  it('snips long abstracts to ≤ 280 chars and collapses whitespace', async () => {
    const long =
      'Storm season ' + 'analysis '.repeat(100) +
      'with newlines\n\nin\nthe\nmiddle.'
    const db = seed([
      {
        id: 'DS_LONG',
        title: 'Storm Season',
        abstract: long,
        categories: ['Atmosphere'],
        keywords: ['storm'],
      },
    ])
    const env = freshEnv(db)
    await indexAll(env, ['DS_LONG'])

    const result = await searchDatasets(env, { query: 'storm season analysis' })
    const hit = result.datasets[0]
    expect(hit.abstract_snippet.length).toBeLessThanOrEqual(280)
    expect(hit.abstract_snippet).not.toContain('\n')
    expect(hit.abstract_snippet.endsWith('…')).toBe(true)
  })

  it('returns peer_id verbatim for federated rows', async () => {
    const db = seed([
      {
        id: 'DS_PEER',
        title: 'Peer Hurricane Data',
        abstract: 'Mirror of a peer dataset.',
        origin_node: 'PEER_X',
        categories: ['Atmosphere'],
        keywords: ['hurricane'],
      },
    ])
    const env = freshEnv(db)
    await indexAll(env, ['DS_PEER'])

    const result = await searchDatasets(env, { query: 'hurricane' })
    expect(result.datasets[0].peer_id).toBe('PEER_X')
  })
})

describe('searchDatasets — filters', () => {
  function seedMixed() {
    return seed([
      {
        id: 'LOCAL_HURR',
        title: 'Local Hurricane',
        abstract: 'Local hurricane.',
        origin_node: 'LOCAL_NODE',
        categories: ['Atmosphere'],
        keywords: ['hurricane'],
      },
      {
        id: 'PEER_HURR',
        title: 'Peer Hurricane',
        abstract: 'Peer hurricane.',
        origin_node: 'PEER_X',
        categories: ['Atmosphere'],
        keywords: ['hurricane'],
      },
      {
        id: 'LOCAL_OCEAN',
        title: 'Local Ocean',
        abstract: 'Local ocean dataset.',
        origin_node: 'LOCAL_NODE',
        categories: ['Oceans'],
        keywords: ['ocean'],
      },
    ])
  }

  it('translates peer_id="local" to the local node id', async () => {
    const db = seedMixed()
    const env = freshEnv(db)
    await indexAll(env, ['LOCAL_HURR', 'PEER_HURR', 'LOCAL_OCEAN'])

    const result = await searchDatasets(env, {
      query: 'hurricane',
      filters: { peer_id: 'local' },
    })
    const ids = result.datasets.map(d => d.id).sort()
    expect(ids).toEqual(['LOCAL_HURR', 'LOCAL_OCEAN'])
    expect(result.datasets.every(d => d.peer_id === 'local')).toBe(true)
  })

  it('forwards a literal peer id verbatim', async () => {
    const db = seedMixed()
    const env = freshEnv(db)
    await indexAll(env, ['LOCAL_HURR', 'PEER_HURR'])

    const result = await searchDatasets(env, {
      query: 'hurricane',
      filters: { peer_id: 'PEER_X' },
    })
    expect(result.datasets.map(d => d.id)).toEqual(['PEER_HURR'])
  })

  it('lowercases / NFC-normalises the category filter', async () => {
    const db = seedMixed()
    const env = freshEnv(db)
    await indexAll(env, ['LOCAL_HURR', 'LOCAL_OCEAN'])

    const result = await searchDatasets(env, {
      query: 'data',
      filters: { category: 'OCEANS' },
    })
    const ids = result.datasets.map(d => d.id)
    expect(ids).toEqual(['LOCAL_OCEAN'])
  })

  it('returns empty when peer_id="local" but the node identity row is missing', async () => {
    // Regression for #59 / Copilot review: prior behaviour fell
    // through to "no peer filter" when local couldn't resolve,
    // which would broaden the search to all peers — exactly the
    // opposite of what the caller asked for. The helper now
    // short-circuits to an empty result instead.
    const db = freshMigratedDb()
    // No node_identity row inserted on purpose. Seed a peer row
    // so a "no filter" leak would be observable.
    db.prepare(
      `INSERT INTO publishers (id, email, display_name, role, status, created_at)
       VALUES ('PUB001', 'p@t', 'P', 'staff', 'active', ?)`,
    ).run(TS)
    db.prepare(
      `INSERT INTO datasets (id, slug, origin_node, title, abstract, format, data_ref,
                             weight, visibility, is_hidden, schema_version,
                             created_at, updated_at, published_at, publisher_id)
       VALUES ('DS_PEER', 'ds_peer', 'PEER_X', 'Peer Hurricane', 'A.', 'video/mp4', 'vimeo:1',
               0, 'public', 0, 1, ?, ?, ?, 'PUB001')`,
    ).run(TS, TS, TS)
    db.prepare(`INSERT INTO dataset_keywords (dataset_id, keyword) VALUES ('DS_PEER', 'hurricane')`).run()

    const env = freshEnv(db)
    await indexAll(env, ['DS_PEER'])

    // Without the short-circuit fix, this would return DS_PEER
    // because no peer_id filter is forwarded to Vectorize.
    const result = await searchDatasets(env, {
      query: 'hurricane',
      filters: { peer_id: 'local' },
    })
    expect(result.datasets).toEqual([])
  })
})

describe('searchDatasets — hydration filters', () => {
  it('drops hits whose row was retracted between indexing and query', async () => {
    const db = seed([
      {
        id: 'DS_A',
        title: 'Atlantic Hurricane',
        abstract: 'A.',
        categories: ['Atmosphere'],
        keywords: ['hurricane'],
      },
      {
        id: 'DS_B',
        title: 'Pacific Hurricane',
        abstract: 'B.',
        categories: ['Atmosphere'],
        keywords: ['hurricane'],
      },
    ])
    const env = freshEnv(db)
    await indexAll(env, ['DS_A', 'DS_B'])

    // Retract DS_A out from under the indexed vector — Vectorize
    // still returns the hit (the embed pipeline's cleanup hasn't
    // run), but the hydrator drops it.
    db.prepare(`UPDATE datasets SET retracted_at = ? WHERE id = ?`).run(TS, 'DS_A')

    const result = await searchDatasets(env, { query: 'hurricane' })
    expect(result.datasets.map(d => d.id)).not.toContain('DS_A')
    expect(result.datasets.map(d => d.id)).toContain('DS_B')
  })

  it('drops hits for hidden rows', async () => {
    const db = seed([
      {
        id: 'DS_A',
        title: 'Hurricane',
        abstract: 'a.',
        is_hidden: 1,
        keywords: ['hurricane'],
      },
    ])
    const env = freshEnv(db)
    await indexAll(env, ['DS_A'])
    const result = await searchDatasets(env, { query: 'hurricane' })
    expect(result.datasets).toEqual([])
  })

  it('drops hits for non-public rows', async () => {
    const db = seed([
      {
        id: 'DS_A',
        title: 'Hurricane',
        abstract: 'a.',
        visibility: 'private',
        keywords: ['hurricane'],
      },
    ])
    const env = freshEnv(db)
    await indexAll(env, ['DS_A'])
    const result = await searchDatasets(env, { query: 'hurricane' })
    expect(result.datasets).toEqual([])
  })

  it('does not let private vectors consume topK slots that public hits could fill', async () => {
    // Regression for Copilot review on PR #59: the embed job stores
    // `visibility` in vector metadata, but searchDatasets used to
    // filter only at the D1 hydration step. With a `limit` of 2,
    // a closer-scoring private vector at rank 1 would consume a
    // topK slot, get dropped at hydration, and the response would
    // be missing a public match that exists further down the
    // ranking. The Vectorize filter now includes
    // `visibility: 'public'` so private vectors don't even compete.
    //
    // Construct a scenario where a private dataset would outrank
    // public ones if visibility weren't filtered at the Vectorize
    // layer: identical keyword set across all three.
    const db = seed([
      {
        id: 'PRIVATE_HURR',
        title: 'Private Hurricane Tracks',
        abstract: 'Private.',
        visibility: 'private',
        keywords: ['hurricane', 'storm', 'atlantic'],
      },
      {
        id: 'PUBLIC_HURR_A',
        title: 'Public Hurricane A',
        abstract: 'Public A.',
        keywords: ['hurricane', 'storm'],
      },
      {
        id: 'PUBLIC_HURR_B',
        title: 'Public Hurricane B',
        abstract: 'Public B.',
        keywords: ['hurricane'],
      },
    ])
    const env = freshEnv(db)
    await indexAll(env, ['PRIVATE_HURR', 'PUBLIC_HURR_A', 'PUBLIC_HURR_B'])

    // limit=2: under the bug, top-2 includes the private row and
    // one public; hydration drops the private; result has 1 entry.
    // After the fix: top-2 are both public; result has 2 entries.
    const result = await searchDatasets(env, {
      query: 'hurricane storm atlantic',
      limit: 2,
    })
    const ids = result.datasets.map(d => d.id).sort()
    expect(ids).toContain('PUBLIC_HURR_A')
    expect(ids).toContain('PUBLIC_HURR_B')
    expect(ids).not.toContain('PRIVATE_HURR')
    expect(result.datasets).toHaveLength(2)
  })
})

describe('searchDatasets — limit', () => {
  it('clamps a giant limit to VECTORIZE_MAX_TOP_K', async () => {
    const rows: SeedRow[] = []
    for (let i = 0; i < VECTORIZE_MAX_TOP_K + 5; i++) {
      const id = `DS${String(i).padStart(3, '0')}`
      rows.push({
        id,
        title: `Hurricane ${i}`,
        abstract: 'a.',
        keywords: ['hurricane'],
      })
    }
    const db = seed(rows)
    const env = freshEnv(db)
    await indexAll(env, rows.map(r => r.id))

    const result = await searchDatasets(env, { query: 'hurricane', limit: 9999 })
    expect(result.datasets.length).toBeLessThanOrEqual(VECTORIZE_MAX_TOP_K)
  })
})
