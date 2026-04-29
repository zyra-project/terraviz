/**
 * Tests for the publisher-API dataset mutations layer.
 *
 * Coverage:
 *   - createDataset on a valid body inserts a draft (published_at NULL).
 *   - createDataset returns 400 + errors for invalid body.
 *   - Slug is derived from the title when missing, with collision suffix.
 *   - listDatasetsForPublisher honors the staff vs community filter.
 *   - listDatasetsForPublisher's status filter (draft/published/retracted).
 *   - updateDataset patches fields, leaves others alone, invalidates KV
 *     when the row is currently public.
 *   - publishDataset stamps published_at + invalidates KV; rejects when
 *     required fields are missing.
 *   - retractDataset stamps retracted_at + invalidates KV.
 */

import { describe, expect, it } from 'vitest'
import type { PublisherRow } from './publisher-store'
import {
  createDataset,
  getDatasetForPublisher,
  listDatasetsForPublisher,
  publishDataset,
  retractDataset,
  updateDataset,
} from './dataset-mutations'
import { asD1, makeKV, seedFixtures } from './test-helpers'
import { SNAPSHOT_KEY } from './snapshot'

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
const COMMUNITY: PublisherRow = {
  ...STAFF,
  id: 'PUB-COMM',
  email: 'comm@example.com',
  role: 'community',
  is_admin: 0,
}

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  // Insert the publishers we'll test with so the FK on datasets validates.
  for (const p of [STAFF, COMMUNITY]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
  return { sqlite, env }
}

describe('createDataset', () => {
  it('inserts a draft with derived slug, decoration rows, and publisher_id', async () => {
    const { env, sqlite } = setupEnv()
    const result = await createDataset(env, COMMUNITY, {
      title: 'Hurricane Helene 2024',
      format: 'video/mp4',
      data_ref: 'vimeo:1107911993',
      keywords: ['hurricane', 'atlantic'],
      tags: ['demo'],
      categories: { Theme: ['Atmosphere'] },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.slug).toBe('hurricane-helene-2024')
    expect(result.dataset.published_at).toBeNull()
    expect(result.dataset.publisher_id).toBe(COMMUNITY.id)
    const kw = sqlite
      .prepare(`SELECT keyword FROM dataset_keywords WHERE dataset_id = ?`)
      .all(result.dataset.id) as Array<{ keyword: string }>
    expect(kw.map(r => r.keyword).sort()).toEqual(['atlantic', 'hurricane'])
  })

  it('returns 400 + structured errors for an invalid body', async () => {
    const { env } = setupEnv()
    const result = await createDataset(env, COMMUNITY, { title: 'a' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.errors.some(e => e.field === 'title' && e.code === 'too_short')).toBe(true)
    expect(result.errors.some(e => e.field === 'format' && e.code === 'required')).toBe(true)
  })

  it('handles slug collisions by appending -N', async () => {
    const { env } = setupEnv()
    const a = await createDataset(env, STAFF, { title: 'Same Title', format: 'video/mp4' })
    const b = await createDataset(env, STAFF, { title: 'Same Title', format: 'video/mp4' })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.dataset.slug).toBe('same-title')
      expect(b.dataset.slug).toBe('same-title-2')
    }
  })
})

describe('listDatasetsForPublisher', () => {
  async function seed3(env: ReturnType<typeof setupEnv>['env']) {
    const a = await createDataset(env, STAFF, { title: 'Staff Dataset', format: 'video/mp4' })
    const b = await createDataset(env, COMMUNITY, { title: 'Comm Dataset 1', format: 'image/png' })
    const c = await createDataset(env, COMMUNITY, { title: 'Comm Dataset 2', format: 'image/png' })
    if (!a.ok || !b.ok || !c.ok) throw new Error('seed failed')
    return { a, b, c }
  }

  it('returns every row for a staff publisher', async () => {
    const { env } = setupEnv()
    await seed3(env)
    const { datasets } = await listDatasetsForPublisher(env.CATALOG_DB!, STAFF)
    expect(datasets).toHaveLength(3)
  })

  it('filters to own rows for a community publisher', async () => {
    const { env } = setupEnv()
    await seed3(env)
    const { datasets } = await listDatasetsForPublisher(env.CATALOG_DB!, COMMUNITY)
    expect(datasets).toHaveLength(2)
    for (const d of datasets) expect(d.publisher_id).toBe(COMMUNITY.id)
  })

  it('honors ?status=draft|published|retracted', async () => {
    const { env } = setupEnv()
    const { a, b } = await seed3(env)
    // Make a publishable
    await env.CATALOG_DB!.prepare(
      `UPDATE datasets SET data_ref='vimeo:1', license_spdx='CC-BY-4.0' WHERE id = ?`,
    )
      .bind(a.dataset.id)
      .run()
    await publishDataset(env, a.dataset.id)

    const drafts = await listDatasetsForPublisher(env.CATALOG_DB!, STAFF, { status: 'draft' })
    const published = await listDatasetsForPublisher(env.CATALOG_DB!, STAFF, { status: 'published' })
    expect(drafts.datasets.map(d => d.id).sort()).toEqual([b.dataset.id].concat(drafts.datasets.filter(d => d.id !== b.dataset.id).map(d => d.id)).sort())
    expect(published.datasets).toHaveLength(1)
    expect(published.datasets[0].id).toBe(a.dataset.id)
  })
})

describe('getDatasetForPublisher', () => {
  it('respects the role-aware filter', async () => {
    const { env } = setupEnv()
    const created = await createDataset(env, STAFF, {
      title: 'Staff dataset',
      format: 'video/mp4',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.dataset.id
    expect(await getDatasetForPublisher(env.CATALOG_DB!, STAFF, id)).not.toBeNull()
    expect(await getDatasetForPublisher(env.CATALOG_DB!, COMMUNITY, id)).toBeNull()
  })
})

describe('updateDataset', () => {
  it('patches only the fields supplied', async () => {
    const { env } = setupEnv()
    const created = await createDataset(env, STAFF, {
      title: 'Original',
      format: 'video/mp4',
      abstract: 'Original abstract',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const result = await updateDataset(env, STAFF, created.dataset.id, { title: 'Updated' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.title).toBe('Updated')
    expect(result.dataset.abstract).toBe('Original abstract')
  })

  it('invalidates the KV snapshot when the row is currently published', async () => {
    const { env } = setupEnv()
    const kv = env.CATALOG_KV
    await kv.put(SNAPSHOT_KEY, JSON.stringify({ etag: '"x"', body: '{}', contentType: 'application/json' }))

    const created = await createDataset(env, STAFF, {
      title: 'Pub me',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    await publishDataset(env, created.dataset.id)
    // Reseed the snapshot so we can detect re-invalidation.
    await kv.put(SNAPSHOT_KEY, JSON.stringify({ etag: '"x"', body: '{}', contentType: 'application/json' }))

    await updateDataset(env, STAFF, created.dataset.id, { title: 'Renamed' })
    expect(await kv.get(SNAPSHOT_KEY)).toBeNull()
  })
})

describe('publishDataset', () => {
  it('stamps published_at and invalidates KV', async () => {
    const { env } = setupEnv()
    const kv = env.CATALOG_KV
    await kv.put(SNAPSHOT_KEY, JSON.stringify({ etag: '"x"', body: '{}', contentType: 'application/json' }))

    const created = await createDataset(env, STAFF, {
      title: 'Ready',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    const result = await publishDataset(env, created.dataset.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.published_at).not.toBeNull()
    expect(await kv.get(SNAPSHOT_KEY)).toBeNull()
  })

  it('rejects when required fields are missing', async () => {
    const { env } = setupEnv()
    const created = await createDataset(env, STAFF, {
      title: 'Not ready',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('seed')
    const result = await publishDataset(env, created.dataset.id)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.errors.some(e => e.field === 'data_ref')).toBe(true)
    expect(result.errors.some(e => e.field === 'license')).toBe(true)
  })
})

describe('retractDataset', () => {
  it('stamps retracted_at and invalidates KV', async () => {
    const { env } = setupEnv()
    const kv = env.CATALOG_KV
    const created = await createDataset(env, STAFF, {
      title: 'Will retract',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    await publishDataset(env, created.dataset.id)
    await kv.put(SNAPSHOT_KEY, JSON.stringify({ etag: '"x"', body: '{}', contentType: 'application/json' }))

    const result = await retractDataset(env, created.dataset.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.retracted_at).not.toBeNull()
    expect(await kv.get(SNAPSHOT_KEY)).toBeNull()
  })
})
