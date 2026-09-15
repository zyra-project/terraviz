// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the publisher-API dataset mutations layer.
 *
 * Coverage:
 *   - createDataset on a valid body inserts a draft (published_at NULL).
 *   - createDataset returns 400 + errors for invalid body.
 *   - Slug is derived from the title when missing, with collision suffix.
 *   - listDatasetsForPublisher returns the whole catalog to every role
 *     (reads are open; writes stay owner-scoped).
 *   - listDatasetsForPublisher's status filter (draft/published/retracted).
 *   - canMutateDataset / getDatasetById enforce the read-open,
 *     write-owner-scoped split.
 *   - updateDataset patches fields, leaves others alone, invalidates KV
 *     when the row is currently public.
 *   - publishDataset stamps published_at + invalidates KV; rejects when
 *     required fields are missing.
 *   - retractDataset stamps retracted_at + invalidates KV.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PublisherRow } from './publisher-store'
import {
  canMutateDataset,
  createDataset,
  deleteDataset,
  DELETE_EMBEDDING_JOB_NAME,
  EMBED_JOB_NAME,
  getDatasetById,
  getDatasetForPublisher,
  isEmbedConfigured,
  listDatasetsForPublisher,
  publishDataset,
  reindexDataset,
  retractDataset,
  updateDataset,
} from './dataset-mutations'
import { asD1, makeCtx, makeKV, seedFixtures } from './test-helpers'
import type { DatasetDraftBody } from './validators'
import { onRequestGet as getPublisherDetail } from '../publish/datasets/[id]'
import { CapturingJobQueue, SyncJobQueue } from './job-queue'
import { SNAPSHOT_KEY } from './snapshot'
import { __clearMockStore, queryEmbedding, type VectorizeEnv } from './vectorize-store'
import { embedDatasetText } from './embeddings'
import { abandonTranscoding, revertTranscodingStamp, stampTranscodingForVideoSource, type AssetUploadRow } from './asset-uploads'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const PUBLISHER: PublisherRow = {
  ...ADMIN,
  id: 'PUB-COMM',
  email: 'comm@example.com',
  role: 'publisher',
  is_admin: 0,
}

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  // Insert the publishers we'll test with so the FK on datasets validates.
  for (const p of [ADMIN, PUBLISHER]) {
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

describe('metadata provenance persistence and PATCH merge', () => {
  const world = { n: 90, s: -90, w: -180, e: 180 }
  const regional = { n: 40, s: 20, w: 170, e: -170 }
  const assertion: DatasetDraftBody = {
    title: 'Annotated source', format: 'image/png', data_ref: 'url:https://example.com/data.png',
    license_statement: 'Source license statement',
    bounding_box: world, bbox_provenance: 'declared_global', bbox_evidence: 'Source specifies a global domain',
    start_time: '2024-02-29T00:00:00Z', end_time: '2024-03-01T00:00:00Z',
    temporal_semantics: 'represented', temporal_evidence: 'Source observation times', resource_kind: 'product',
  }
  async function create(body: DatasetDraftBody = assertion) {
    const { env, sqlite } = setupEnv()
    const result = await createDataset(env, PUBLISHER, body)
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    return { env, sqlite, row: result.dataset, id: result.dataset.id }
  }

  it('defaults even global-looking and timestamped new rows to unknown', async () => {
    const { env, id, row } = await create({
      title: 'Legacy source', format: 'tour/json', bounding_box: world,
      start_time: '2024-02-29T00:00:00Z', end_time: '2024-03-01T00:00:00Z', period: 'P1D',
      data_ref: 'url:https://example.com/tour.json', license_statement: 'Native license',
    })
    expect(row).toMatchObject({ bbox_provenance: 'unknown', bbox_evidence: null, temporal_semantics: 'unknown', temporal_evidence: null, resource_kind: 'unknown' })
    expect(await publishDataset(env, id)).toMatchObject({ ok: true })
    const published = await getDatasetById(env.CATALOG_DB, id)
    expect(published?.published_at).toBeTruthy()
    expect(published).toMatchObject({ temporal_semantics: 'unknown', start_time: row.start_time, end_time: row.end_time, period: 'P1D' })
  })

  it.each(['measured', 'imported', 'inferred', 'declared_global'] as const)('persists explicit %s assertions and reads them on the authenticated detail row', async bbox_provenance => {
    const { env, id } = await create({ ...assertion, bbox_provenance })
    const context = makeCtx<'id'>({ env, params: { id } })
    context.data = { publisher: PUBLISHER }
    const response = await getPublisherDetail(context)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ dataset: {
      bbox_provenance, bbox_evidence: assertion.bbox_evidence, temporal_semantics: 'represented',
      temporal_evidence: assertion.temporal_evidence, resource_kind: 'product', can_edit: true,
    } })
  })

  it('preserves assertions on unrelated patches and unchanged bounds/time submissions', async () => {
    const { env, id } = await create()
    const result = await updateDataset(env, PUBLISHER, id, { title: 'Renamed dataset', bounding_box: world, start_time: assertion.start_time, end_time: assertion.end_time })
    expect(result).toMatchObject({ ok: true, dataset: { title: 'Renamed dataset', bbox_provenance: 'declared_global', bbox_evidence: assertion.bbox_evidence, temporal_semantics: 'represented', temporal_evidence: assertion.temporal_evidence } })
  })

  it('allows assertions against existing bounds/time/evidence rather than requiring a full PATCH', async () => {
    const { env, id } = await create({ ...assertion, bbox_provenance: 'unknown', temporal_semantics: 'unknown' })
    const result = await updateDataset(env, PUBLISHER, id, { bbox_provenance: 'measured', temporal_semantics: 'represented' })
    expect(result).toMatchObject({ ok: true, dataset: { bbox_provenance: 'measured', temporal_semantics: 'represented' } })
  })

  it.each([
    { bounding_box: regional, bbox_provenance: 'declared_global' },
    { bounding_box: null, bbox_provenance: 'measured' },
    { bbox_evidence: null }, { bbox_evidence: '' },
    { temporal_evidence: null }, { temporal_evidence: '  ' },
    { start_time: null, temporal_semantics: 'represented' },
    { end_time: null, temporal_semantics: 'represented' },
    { end_time: '2023-01-01T00:00:00Z', temporal_semantics: 'represented' },
    { start_time: '2024-02-30T00:00:00Z', temporal_semantics: 'represented' },
  ] satisfies DatasetDraftBody[])('rejects invalid merged claims atomically: %j', async patch => {
    const { env, id, row } = await create()
    const result = await updateDataset(env, PUBLISHER, id, { ...patch, title: 'Must not persist', tags: ['must-not-persist'] })
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(await getDatasetById(env.CATALOG_DB, id)).toEqual(row)
    expect(await env.CATALOG_DB.prepare('SELECT * FROM dataset_tags WHERE dataset_id = ?').bind(id).all()).toMatchObject({ results: [] })
  })

  it('invalidates spatial claims on changed bounds even if evidence alone is supplied', async () => {
    const { env, id } = await create()
    const result = await updateDataset(env, PUBLISHER, id, { bounding_box: regional, bbox_evidence: 'Cannot retain this without reasserting provenance' })
    expect(result).toMatchObject({ ok: true, dataset: { bbox_n: 40, bbox_s: 20, bbox_w: 170, bbox_e: -170, bbox_provenance: 'unknown', bbox_evidence: null, temporal_semantics: 'represented' } })
  })

  it.each([
    { start_time: '2024-03-01T00:00:00Z' }, { end_time: '2024-03-02T00:00:00Z' },
    { start_time: null }, { end_time: null }, { period: 'PT1H' },
  ] satisfies DatasetDraftBody[])('invalidates temporal claims/evidence on changed time: %j', async patch => {
    const { env, id } = await create()
    const result = await updateDataset(env, PUBLISHER, id, { ...patch, temporal_evidence: 'Not a renewed assertion' })
    expect(result).toMatchObject({ ok: true, dataset: { temporal_semantics: 'unknown', temporal_evidence: null, bbox_provenance: 'declared_global' } })
  })

  it('null-clears whole bounds without inventing global and clears all enum annotations to unknown', async () => {
    const { env, id } = await create()
    expect(await updateDataset(env, PUBLISHER, id, { bounding_box: null })).toMatchObject({ ok: true, dataset: { bbox_n: null, bbox_s: null, bbox_w: null, bbox_e: null, bbox_provenance: 'unknown', bbox_evidence: null } })
    expect(await updateDataset(env, PUBLISHER, id, { bbox_provenance: null, temporal_semantics: null, resource_kind: null })).toMatchObject({ ok: true, dataset: { bbox_provenance: 'unknown', bbox_evidence: null, temporal_semantics: 'unknown', temporal_evidence: null, resource_kind: 'unknown', start_time: assertion.start_time, end_time: assertion.end_time } })
  })

  it('rejects partial box clears instead of erasing the other corners', async () => {
    const { env, id, row } = await create()
    const patch = { bounding_box: { n: null } } as unknown as DatasetDraftBody
    expect(await updateDataset(env, PUBLISHER, id, patch)).toMatchObject({ ok: false, status: 400 })
    expect(await getDatasetById(env.CATALOG_DB, id)).toEqual(row)
  })

  it('never fills missing corners or asserts provenance for old unknown rows', async () => {
    const { env, id, sqlite } = await create({ title: 'Unknown domain', format: 'image/png' })
    sqlite.prepare('UPDATE datasets SET bbox_n = 20 WHERE id = ?').run(id)
    expect(await updateDataset(env, PUBLISHER, id, { title: 'Still unknown' })).toMatchObject({ ok: true, dataset: { bbox_n: 20, bbox_s: null, bbox_w: null, bbox_e: null, bbox_provenance: 'unknown' } })
    expect(await updateDataset(env, PUBLISHER, id, { bbox_provenance: 'imported', bbox_evidence: 'Incomplete source' })).toMatchObject({ ok: false, status: 400 })
  })

  it('allows reasserting valid replacement metadata with evidence and classifying presentations', async () => {
    const { env, id } = await create()
    const result = await updateDataset(env, PUBLISHER, id, {
      bounding_box: regional, bbox_provenance: 'measured', bbox_evidence: '  New spatial source  ',
      start_time: '2024-03-01T00:00:00Z', temporal_semantics: 'represented', temporal_evidence: 'New instant source',
      resource_kind: 'presentation',
    })
    expect(result).toMatchObject({ ok: true, dataset: { bbox_provenance: 'measured', bbox_evidence: 'New spatial source', temporal_semantics: 'represented', temporal_evidence: 'New instant source', resource_kind: 'presentation' } })
  })

  it('blocks a metadata assertion if a concurrent writer changes its validation inputs', async () => {
    const { env, id } = await create()
    const prepare = env.CATALOG_DB.prepare.bind(env.CATALOG_DB)
    const spy = vi.spyOn(env.CATALOG_DB, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('UPDATE datasets SET bbox_provenance')) {
        env.CATALOG_DB.raw().prepare('UPDATE datasets SET bbox_n = 50 WHERE id = ?').run(id)
      }
      return prepare(sql)
    })
    try {
      expect(await updateDataset(env, PUBLISHER, id, { bbox_provenance: 'declared_global' })).toMatchObject({ ok: false, status: 409, errors: [expect.objectContaining({ code: 'concurrent_update' })] })
    } finally {
      spy.mockRestore()
    }
  })

  it.each([
    { data_ref: 'url:https://example.com/different.png' },
    { format: 'image/jpeg' },
  ] satisfies DatasetDraftBody[])('resets source annotations and digests on an explicit identity change: %j', async patch => {
    const { env, sqlite, id } = await create()
    sqlite.prepare('UPDATE datasets SET source_digest = ?, content_digest = ? WHERE id = ?')
      .run('sha256:old-source', 'sha256:old-content', id)
    expect(await updateDataset(env, PUBLISHER, id, patch)).toMatchObject({ ok: true, dataset: {
      bbox_provenance: 'unknown', bbox_evidence: null,
      temporal_semantics: 'unknown', temporal_evidence: null, resource_kind: 'unknown',
      source_digest: null, content_digest: null,
      bbox_n: 90, start_time: assertion.start_time, end_time: assertion.end_time,
    } })
  })

  it('preserves assertions and verified digests on an unchanged source submission', async () => {
    const { env, sqlite, id } = await create()
    sqlite.prepare('UPDATE datasets SET source_digest = ? WHERE id = ?').run('sha256:source', id)
    expect(await updateDataset(env, PUBLISHER, id, { data_ref: assertion.data_ref, format: assertion.format }))
      .toMatchObject({ ok: true, dataset: {
        bbox_provenance: 'declared_global', bbox_evidence: assertion.bbox_evidence,
        temporal_semantics: 'represented', temporal_evidence: assertion.temporal_evidence,
        resource_kind: 'product', source_digest: 'sha256:source',
      } })
  })

  it.each([
    { bounding_box: regional, bbox_provenance: 'measured' },
    { end_time: '2024-03-02T00:00:00Z', temporal_semantics: 'represented' },
    { period: 'PT1H', temporal_semantics: 'represented' },
    { data_ref: 'url:https://example.com/new.png', bbox_provenance: 'declared_global' },
    { format: 'image/jpeg', temporal_semantics: 'represented' },
  ] satisfies DatasetDraftBody[])('requires supplied evidence rather than inheriting it across a change: %j', async patch => {
    const { env, id, row } = await create()
    expect(await updateDataset(env, PUBLISHER, id, patch)).toMatchObject({ ok: false, status: 400 })
    expect(await getDatasetById(env.CATALOG_DB, id)).toEqual(row)
  })

  it('accepts explicit source reassertions, including unchanged evidence supplied deliberately', async () => {
    const { env, id } = await create()
    expect(await updateDataset(env, PUBLISHER, id, {
      data_ref: 'url:https://example.com/rehosted.png',
      bbox_provenance: assertion.bbox_provenance, bbox_evidence: assertion.bbox_evidence,
      temporal_semantics: assertion.temporal_semantics, temporal_evidence: assertion.temporal_evidence,
      resource_kind: 'product',
    })).toMatchObject({ ok: true, dataset: {
      bbox_provenance: 'declared_global', bbox_evidence: assertion.bbox_evidence,
      temporal_semantics: 'represented', temporal_evidence: assertion.temporal_evidence, resource_kind: 'product',
    } })
  })

  it.each([
    "data_ref = 'url:https://example.com/concurrent.png'",
    "format = 'image/jpeg'",
    "source_digest = 'sha256:new-source'",
    "content_digest = 'sha256:new-content'",
    'transcoding = 1',
    'frame_count = 8',
  ])('rejects an assertion when source validation inputs change concurrently: %s', async change => {
    const { env, sqlite, id } = await create()
    const prepare = env.CATALOG_DB.prepare.bind(env.CATALOG_DB)
    const spy = vi.spyOn(env.CATALOG_DB, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('UPDATE datasets SET')) sqlite.prepare(`UPDATE datasets SET ${change} WHERE id = ?`).run(id)
      return prepare(sql)
    })
    try {
      expect(await updateDataset(env, PUBLISHER, id, { bbox_provenance: 'measured', tags: ['not-written'] }))
        .toMatchObject({ ok: false, status: 409, errors: [expect.objectContaining({ code: 'concurrent_update' })] })
      expect(sqlite.prepare('SELECT * FROM dataset_tags WHERE dataset_id = ?').all(id)).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('does not overwrite a concurrent source swap with a formerly unchanged source submission', async () => {
    const { env, sqlite, id } = await create()
    const prepare = env.CATALOG_DB.prepare.bind(env.CATALOG_DB)
    const spy = vi.spyOn(env.CATALOG_DB, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('UPDATE datasets SET')) {
        sqlite.prepare("UPDATE datasets SET data_ref = 'url:https://example.com/new.png' WHERE id = ?").run(id)
      }
      return prepare(sql)
    })
    try {
      expect(await updateDataset(env, PUBLISHER, id, { data_ref: assertion.data_ref }))
        .toMatchObject({ ok: false, status: 409 })
      expect(sqlite.prepare('SELECT data_ref FROM datasets WHERE id = ?').get(id))
        .toEqual({ data_ref: 'url:https://example.com/new.png' })
    } finally {
      spy.mockRestore()
    }
  })

  describe('source assertions during a pending transcode', () => {
    const now = '2026-09-11T00:00:00Z'
    const digest = `sha256:${'b'.repeat(64)}`
    const unknown = {
      bbox_provenance: 'unknown', bbox_evidence: null,
      temporal_semantics: 'unknown', temporal_evidence: null,
    }
    function upload(id: string): AssetUploadRow {
      return {
        id: 'UP-METADATA-PENDING', dataset_id: id, publisher_id: PUBLISHER.id,
        kind: 'data', target: 'r2', target_ref: 'r2:replacement-source-B',
        mime: 'video/mp4', declared_size: 1234, claimed_digest: digest,
        status: 'pending', failure_reason: null, created_at: now, completed_at: null, frame_count: null,
      }
    }

    it.each(['rollback', 'published-abandon'] as const)('rejects B assertions before %s restores/retains source A', async failure => {
      const { env, sqlite, id, row } = await create({ ...assertion, format: 'video/mp4', data_ref: 'r2:source-A' })
      if (failure === 'published-abandon') expect(await publishDataset(env, id)).toMatchObject({ ok: true })
      const replacement = upload(id)
      expect(await stampTranscodingForVideoSource(env.CATALOG_DB, id, replacement, now)).toBe(1)
      const pending = await getDatasetById(env.CATALOG_DB, id)
      expect(pending).toMatchObject({ ...unknown, transcoding: 1 })
      expect(await updateDataset(env, PUBLISHER, id, {
        bbox_provenance: 'measured', bbox_evidence: 'Replacement B bounds',
        temporal_semantics: 'represented', temporal_evidence: 'Replacement B acquisition',
        resource_kind: 'product', start_time: now, end_time: now,
        title: 'Must not persist', tags: ['must-not-persist'],
      })).toMatchObject({ ok: false, status: 409, errors: expect.arrayContaining([
        expect.objectContaining({ field: 'bbox_provenance', code: 'transcoding_in_progress' }),
        expect.objectContaining({ field: 'temporal_semantics', code: 'transcoding_in_progress' }),
        expect.objectContaining({ field: 'resource_kind', code: 'transcoding_in_progress' }),
      ]) })
      expect(await getDatasetById(env.CATALOG_DB, id)).toEqual(pending)
      expect(sqlite.prepare('SELECT * FROM dataset_tags WHERE dataset_id = ?').all(id)).toEqual([])
      if (failure === 'rollback') {
        expect(await revertTranscodingStamp(env.CATALOG_DB, id, replacement, row, now)).toBe(1)
      } else {
        expect(await abandonTranscoding(env.CATALOG_DB, id, replacement.id, now)).toBe(1)
      }
      expect(await getDatasetById(env.CATALOG_DB, id)).toMatchObject({
        ...unknown, data_ref: 'r2:source-A', transcoding: null,
        start_time: assertion.start_time, end_time: assertion.end_time,
      })
      // Conservative unknown provenance does not block native publication.
      expect(await publishDataset(env, id)).toMatchObject({ ok: true })
    })

    it.each([
      { bbox_provenance: 'measured' }, { bbox_provenance: 'declared_global' },
      { bbox_provenance: 'imported' }, { bbox_provenance: 'inferred' },
      { temporal_semantics: 'represented' },
      { resource_kind: 'product' }, { resource_kind: 'presentation' },
      { bbox_evidence: 'Replacement bounds evidence only' },
      { temporal_evidence: 'Replacement time evidence only' },
      { bbox_provenance: 'unknown', bbox_evidence: 'Staged replacement bounds' },
      { temporal_semantics: null, temporal_evidence: 'Staged replacement time' },
    ] satisfies DatasetDraftBody[])('rejects setting/reaffirming an assertion or evidence even for same-source transcodes: %j', async patch => {
      const { env, sqlite, id } = await create({ ...assertion, format: 'video/mp4' })
      sqlite.prepare('UPDATE datasets SET source_digest = ? WHERE id = ?').run(digest, id)
      expect(await stampTranscodingForVideoSource(env.CATALOG_DB, id, upload(id), now)).toBe(1)
      const pending = await getDatasetById(env.CATALOG_DB, id)
      expect(pending).toMatchObject({ bbox_provenance: assertion.bbox_provenance, temporal_semantics: 'represented' })
      expect(await updateDataset(env, PUBLISHER, id, patch)).toMatchObject({
        ok: false, status: 409, errors: expect.arrayContaining([expect.objectContaining({ code: 'transcoding_in_progress' })]),
      })
      expect(await getDatasetById(env.CATALOG_DB, id)).toEqual(pending)
    })

    it.each([null, 'unknown'] as const)('allows clearing assertions to %s and unrelated edits while pending', async cleared => {
      const { env, sqlite, id } = await create({ ...assertion, format: 'video/mp4' })
      sqlite.prepare('UPDATE datasets SET source_digest = ? WHERE id = ?').run(digest, id)
      await stampTranscodingForVideoSource(env.CATALOG_DB, id, upload(id), now)
      expect(await updateDataset(env, PUBLISHER, id, { title: 'Safe unrelated edit' })).toMatchObject({
        ok: true, dataset: { bbox_provenance: assertion.bbox_provenance, temporal_semantics: 'represented', resource_kind: 'product' },
      })
      expect(await updateDataset(env, PUBLISHER, id, {
        bbox_provenance: cleared, bbox_evidence: null,
        temporal_semantics: cleared, temporal_evidence: null, resource_kind: cleared,
      })).toMatchObject({ ok: true, dataset: { ...unknown, resource_kind: 'unknown', transcoding: 1 } })
      expect(await updateDataset(env, PUBLISHER, id, { bbox_evidence: '', temporal_evidence: '  ' }))
        .toMatchObject({ ok: true, dataset: unknown })
    })

    it.each([
      { bbox_provenance: 'measured' }, { temporal_semantics: 'represented' },
      { resource_kind: 'product' }, { bbox_evidence: 'Concurrent bounds' },
      { temporal_evidence: 'Concurrent time' },
    ] satisfies DatasetDraftBody[])('atomically rejects a real same-source stamp after the metadata read: %j', async patch => {
      const { env, sqlite, id } = await create({ ...assertion, format: 'video/mp4', data_ref: 'r2:source-A' })
      // Published + same bytes: stamp preserves data_ref and all assertions,
      // so the pending lifecycle comparison must still detect this race.
      expect(await publishDataset(env, id)).toMatchObject({ ok: true })
      sqlite.prepare('UPDATE datasets SET source_digest = ? WHERE id = ?').run(digest, id)
      const prepare = env.CATALOG_DB.prepare.bind(env.CATALOG_DB)
      const spy = vi.spyOn(env.CATALOG_DB, 'prepare').mockImplementation(sql => {
        const statement = prepare(sql)
        if (sql.startsWith('UPDATE datasets SET')) {
          const bind = statement.bind.bind(statement)
          vi.spyOn(statement, 'bind').mockImplementation((...values) => {
            const bound = bind(...values)
            const run = bound.run.bind(bound)
            vi.spyOn(bound, 'run').mockImplementation(async () => {
              expect(await stampTranscodingForVideoSource(asD1(sqlite), id, upload(id), now)).toBe(1)
              return run()
            })
            return bound
          })
        }
        return statement
      })
      try {
        expect(await updateDataset(env, PUBLISHER, id, { ...patch, title: 'Must not persist', tags: ['not-written'] }))
          .toMatchObject({ ok: false, status: 409, errors: [expect.objectContaining({ code: 'concurrent_update' })] })
        expect(await getDatasetById(env.CATALOG_DB, id)).toMatchObject({
          title: assertion.title, data_ref: 'r2:source-A', transcoding: 1,
          bbox_provenance: assertion.bbox_provenance, bbox_evidence: assertion.bbox_evidence,
          temporal_semantics: assertion.temporal_semantics, temporal_evidence: assertion.temporal_evidence,
        })
        expect(sqlite.prepare('SELECT * FROM dataset_tags WHERE dataset_id = ?').all(id)).toEqual([])
      } finally {
        spy.mockRestore()
      }
    })
  })
})

describe('createDataset', () => {
  it('inserts a draft with derived slug, decoration rows, and publisher_id', async () => {
    const { env, sqlite } = setupEnv()
    const result = await createDataset(env, PUBLISHER, {
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
    expect(result.dataset.publisher_id).toBe(PUBLISHER.id)
    const kw = sqlite
      .prepare(`SELECT keyword FROM dataset_keywords WHERE dataset_id = ?`)
      .all(result.dataset.id) as Array<{ keyword: string }>
    expect(kw.map(r => r.keyword).sort()).toEqual(['atlantic', 'hurricane'])
  })

  it('returns 400 + structured errors for an invalid body', async () => {
    const { env } = setupEnv()
    const result = await createDataset(env, PUBLISHER, { title: 'a' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.errors.some(e => e.field === 'title' && e.code === 'too_short')).toBe(true)
    expect(result.errors.some(e => e.field === 'format' && e.code === 'required')).toBe(true)
  })

  it('handles slug collisions by appending -N', async () => {
    const { env } = setupEnv()
    const a = await createDataset(env, ADMIN, { title: 'Same Title', format: 'video/mp4' })
    const b = await createDataset(env, ADMIN, { title: 'Same Title', format: 'video/mp4' })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.dataset.slug).toBe('same-title')
      expect(b.dataset.slug).toBe('same-title-2')
    }
  })

  it('persists legacy_id and surfaces it on the returned row', async () => {
    const { env } = setupEnv()
    const result = await createDataset(env, ADMIN, {
      title: 'Imported Row',
      format: 'video/mp4',
      legacy_id: 'INTERNAL_SOS_42',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.legacy_id).toBe('INTERNAL_SOS_42')
  })

  it('rejects a duplicate legacy_id with a structured 409', async () => {
    const { env } = setupEnv()
    const first = await createDataset(env, ADMIN, {
      title: 'First Import',
      format: 'video/mp4',
      legacy_id: 'INTERNAL_SOS_99',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = await createDataset(env, ADMIN, {
      title: 'Second Import (same source row)',
      format: 'video/mp4',
      legacy_id: 'INTERNAL_SOS_99',
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.status).toBe(409)
    expect(second.errors[0].field).toBe('legacy_id')
    expect(second.errors[0].code).toBe('conflict')
    expect(second.errors[0].message).toContain(first.dataset.id)
  })

  it('rejects legacy_id from a non-privileged publisher with 403 (1d/L)', async () => {
    // Cross-tenant existence leak guard: legacy_id is bulk-import
    // provenance metadata, and allowing publisher-role accounts to set
    // it would let them probe whether a given legacy_id exists in a
    // admin-owned row via the 409 conflict path.
    const { env } = setupEnv()
    const result = await createDataset(env, PUBLISHER, {
      title: 'Sneaky import',
      format: 'video/mp4',
      legacy_id: 'INTERNAL_SOS_99',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.errors[0].field).toBe('legacy_id')
    expect(result.errors[0].code).toBe('forbidden')
  })
})

describe('listDatasetsForPublisher', () => {
  async function seed3(env: ReturnType<typeof setupEnv>['env']) {
    const a = await createDataset(env, ADMIN, { title: 'Admin Dataset', format: 'video/mp4' })
    const b = await createDataset(env, PUBLISHER, { title: 'Comm Dataset 1', format: 'image/png' })
    const c = await createDataset(env, PUBLISHER, { title: 'Comm Dataset 2', format: 'image/png' })
    if (!a.ok || !b.ok || !c.ok) throw new Error('seed failed')
    return { a, b, c }
  }

  it('returns every row for an admin publisher', async () => {
    const { env } = setupEnv()
    await seed3(env)
    const { datasets } = await listDatasetsForPublisher(env.CATALOG_DB!, ADMIN)
    expect(datasets).toHaveLength(3)
  })

  it('returns the whole catalog to a publisher-role account (reads are open)', async () => {
    const { env } = setupEnv()
    await seed3(env)
    const { datasets } = await listDatasetsForPublisher(env.CATALOG_DB!, PUBLISHER)
    // A community publisher now sees every row, not just its own two.
    expect(datasets).toHaveLength(3)
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

    const drafts = await listDatasetsForPublisher(env.CATALOG_DB!, ADMIN, { status: 'draft' })
    const published = await listDatasetsForPublisher(env.CATALOG_DB!, ADMIN, { status: 'published' })
    expect(drafts.datasets.map(d => d.id).sort()).toEqual([b.dataset.id].concat(drafts.datasets.filter(d => d.id !== b.dataset.id).map(d => d.id)).sort())
    expect(published.datasets).toHaveLength(1)
    expect(published.datasets[0].id).toBe(a.dataset.id)
  })
})

describe('canMutateDataset', () => {
  it('lets a publisher mutate only its own rows', () => {
    expect(canMutateDataset(PUBLISHER, { publisher_id: PUBLISHER.id })).toBe(true)
    expect(canMutateDataset(PUBLISHER, { publisher_id: ADMIN.id })).toBe(false)
    expect(canMutateDataset(PUBLISHER, { publisher_id: null })).toBe(false)
  })

  it('lets a privileged (admin) caller mutate any row', () => {
    expect(canMutateDataset(ADMIN, { publisher_id: PUBLISHER.id })).toBe(true)
    expect(canMutateDataset(ADMIN, { publisher_id: null })).toBe(true)
  })
})

describe('getDatasetById', () => {
  it('reads any row regardless of owner (reads are open)', async () => {
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Admin dataset',
      format: 'video/mp4',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // Owned by ADMIN, but a community publisher can still read it.
    const row = await getDatasetById(env.CATALOG_DB!, created.dataset.id)
    expect(row?.id).toBe(created.dataset.id)
    expect(await getDatasetById(env.CATALOG_DB!, 'does-not-exist')).toBeNull()
  })
})

describe('getDatasetForPublisher', () => {
  it('respects the role-aware filter', async () => {
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Admin dataset',
      format: 'video/mp4',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.dataset.id
    expect(await getDatasetForPublisher(env.CATALOG_DB!, ADMIN, id)).not.toBeNull()
    expect(await getDatasetForPublisher(env.CATALOG_DB!, PUBLISHER, id)).toBeNull()
  })

  it('normalizes empty / whitespace celestial_body to NULL on INSERT (3d/A defense in depth)', async () => {
    const { env, sqlite } = setupEnv()
    const created = await createDataset(env, PUBLISHER, {
      title: 'Earth implicit',
      format: 'video/mp4',
      celestial_body: '   ',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const row = sqlite
      .prepare(`SELECT celestial_body FROM datasets WHERE id = ?`)
      .get(created.dataset.id) as { celestial_body: string | null }
    expect(row.celestial_body).toBeNull()
  })
})

describe('updateDataset — slug lock', () => {
  /** Create a dataset and flip it to published. */
  async function publishedDataset(env: ReturnType<typeof setupEnv>['env']) {
    const created = await createDataset(env, ADMIN, {
      title: 'Hurricane Season 2024',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('seed failed')
    await env.CATALOG_DB!.prepare(
      `UPDATE datasets SET data_ref='vimeo:1', license_spdx='CC-BY-4.0' WHERE id = ?`,
    )
      .bind(created.dataset.id)
      .run()
    await publishDataset(env, created.dataset.id)
    return created.dataset
  }

  async function storedSlug(
    env: ReturnType<typeof setupEnv>['env'],
    id: string,
  ): Promise<string | undefined> {
    const row = await env
      .CATALOG_DB!.prepare('SELECT slug FROM datasets WHERE id = ?')
      .bind(id)
      .first<{ slug: string }>()
    return row?.slug
  }

  it('refuses to rename a published dataset’s slug', async () => {
    const { env } = setupEnv()
    const ds = await publishedDataset(env)

    const result = await updateDataset(env, ADMIN, ds.id, { slug: 'something-else' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.errors[0].field).toBe('slug')
    expect(result.errors[0].code).toBe('slug_locked')

    // The stored slug is untouched — the public URL still resolves.
    expect(await storedSlug(env, ds.id)).toBe(ds.slug)
  })

  it('accepts a published dataset’s unchanged slug', async () => {
    // The dataset form re-serializes every field on save, so the
    // current slug rides along in the body of every ordinary edit.
    // Refusing on presence rather than on change would make a
    // published dataset unsaveable at all.
    const { env } = setupEnv()
    const ds = await publishedDataset(env)

    const result = await updateDataset(env, ADMIN, ds.id, {
      slug: ds.slug,
      abstract: 'Edited while published.',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.abstract).toBe('Edited while published.')
    expect(await storedSlug(env, ds.id)).toBe(ds.slug)
  })

  it('still lets a draft rename its slug freely', async () => {
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Still A Draft',
      format: 'video/mp4',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const result = await updateDataset(env, ADMIN, created.dataset.id, {
      slug: 'renamed-while-draft',
    })

    expect(result.ok).toBe(true)
    expect(await storedSlug(env, created.dataset.id)).toBe('renamed-while-draft')
  })
})

describe('updateDataset', () => {
  it('patches only the fields supplied', async () => {
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Original',
      format: 'video/mp4',
      abstract: 'Original abstract',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const result = await updateDataset(env, ADMIN, created.dataset.id, { title: 'Updated' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.title).toBe('Updated')
    expect(result.dataset.abstract).toBe('Original abstract')
  })

  it('invalidates the KV snapshot when the row is currently published', async () => {
    const { env } = setupEnv()
    const kv = env.CATALOG_KV
    await kv.put(SNAPSHOT_KEY, JSON.stringify({ etag: '"x"', body: '{}', contentType: 'application/json' }))

    const created = await createDataset(env, ADMIN, {
      title: 'Pub me',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    await publishDataset(env, created.dataset.id)
    // Reseed the snapshot so we can detect re-invalidation.
    await kv.put(SNAPSHOT_KEY, JSON.stringify({ etag: '"x"', body: '{}', contentType: 'application/json' }))

    await updateDataset(env, ADMIN, created.dataset.id, { title: 'Renamed' })
    expect(await kv.get(SNAPSHOT_KEY)).toBeNull()
  })

  it('rejects legacy_id update from a non-privileged publisher with 403 (1d/L)', async () => {
    const { env } = setupEnv()
    const created = await createDataset(env, PUBLISHER, {
      title: 'Publisher draft',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('seed')
    const result = await updateDataset(env, PUBLISHER, created.dataset.id, {
      legacy_id: 'INTERNAL_SOS_99',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.errors[0].field).toBe('legacy_id')
    expect(result.errors[0].code).toBe('forbidden')
  })

  it('rejects a duplicate legacy_id update with a structured 409 (1d/L)', async () => {
    const { env } = setupEnv()
    const a = await createDataset(env, ADMIN, {
      title: 'Holds the legacy_id',
      format: 'video/mp4',
      legacy_id: 'INTERNAL_SOS_77',
    })
    const b = await createDataset(env, ADMIN, {
      title: 'Wants to take it',
      format: 'video/mp4',
    })
    if (!a.ok || !b.ok) throw new Error('seed')
    const result = await updateDataset(env, ADMIN, b.dataset.id, {
      legacy_id: 'INTERNAL_SOS_77',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.errors[0].field).toBe('legacy_id')
    expect(result.errors[0].code).toBe('conflict')
    expect(result.errors[0].message).toContain(a.dataset.id)
  })

  it('allows a row to update its own legacy_id to itself (no-op write)', async () => {
    // Sanity: the conflict pre-check must exclude the row being
    // updated from the "in use elsewhere" lookup, otherwise an
    // operator re-saving the same row would 409 against itself.
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Self-update',
      format: 'video/mp4',
      legacy_id: 'INTERNAL_SOS_88',
    })
    if (!created.ok) throw new Error('seed')
    const result = await updateDataset(env, ADMIN, created.dataset.id, {
      legacy_id: 'INTERNAL_SOS_88',
    })
    expect(result.ok).toBe(true)
  })

  it('rejects format mutation while the row is mid-transcode', async () => {
    // PR #112 followup — server-side companion to the form's
    // disabled format radio. Without this guard, a direct PUT
    // bypassing the UI could swap `video/mp4` → `image/png`
    // while the GHA workflow is still running; the eventual
    // /transcode-complete callback would then write an HLS
    // data_ref into a row that now declares an image format.
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Transcoding row',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('seed')
    // Stamp the row as if /asset/.../complete had fired.
    env.CATALOG_DB!
      .prepare(`UPDATE datasets SET transcoding = 1 WHERE id = ?`)
      .bind(created.dataset.id)
      .run()
    const result = await updateDataset(env, ADMIN, created.dataset.id, {
      format: 'image/png',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.errors?.[0]).toMatchObject({
      field: 'format',
      code: 'transcoding_in_progress',
    })
  })

  it('allows non-asset-coupled mutations while transcoding (title, abstract)', async () => {
    // The guard is narrow: only `format` is locked. Editors
    // should still be able to fix typos in the title / abstract
    // / organization while the transcode runs.
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Transcoding row',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('seed')
    env.CATALOG_DB!
      .prepare(`UPDATE datasets SET transcoding = 1 WHERE id = ?`)
      .bind(created.dataset.id)
      .run()
    const result = await updateDataset(env, ADMIN, created.dataset.id, {
      title: 'Renamed during transcode',
      abstract: 'Updated abstract',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.title).toBe('Renamed during transcode')
  })

  it('allows format updates after transcoding clears', async () => {
    // Symmetric: once the workflow finishes and clears
    // `transcoding`, the format field is fair game again.
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Done transcoding',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('seed')
    // No transcoding stamp on this row — same as the post-
    // /transcode-complete steady state.
    const result = await updateDataset(env, ADMIN, created.dataset.id, {
      format: 'image/png',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.format).toBe('image/png')
  })

  it('rejects data_ref mutation while the row is mid-transcode', async () => {
    // PR #112 followup — companion to the format guard. The
    // workflow's /transcode-complete callback will overwrite
    // data_ref with the new HLS bundle path; letting a manual
    // edit through in the meantime opens the same race the UI
    // avoids by hiding the manual data_ref input during
    // transcoding (3pd-followup/Q).
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Transcoding row',
      format: 'video/mp4',
      data_ref: 'r2:videos/old/master.m3u8',
    })
    if (!created.ok) throw new Error('seed')
    env.CATALOG_DB!
      .prepare(`UPDATE datasets SET transcoding = 1 WHERE id = ?`)
      .bind(created.dataset.id)
      .run()
    const result = await updateDataset(env, ADMIN, created.dataset.id, {
      data_ref: 'vimeo:9999',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.errors?.[0]).toMatchObject({
      field: 'data_ref',
      code: 'transcoding_in_progress',
    })
  })

  it('treats a same-value data_ref submission as a no-op even while transcoding', async () => {
    // Edge case parallel to the same-value format case: the
    // form re-submits data_ref on every save. While transcoding,
    // the row's data_ref might be the preserved published-row
    // value or an empty draft value; either way a submission
    // matching the stored value should fall through cleanly.
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Transcoding row',
      format: 'video/mp4',
      data_ref: 'r2:videos/old/master.m3u8',
    })
    if (!created.ok) throw new Error('seed')
    env.CATALOG_DB!
      .prepare(`UPDATE datasets SET transcoding = 1 WHERE id = ?`)
      .bind(created.dataset.id)
      .run()
    const result = await updateDataset(env, ADMIN, created.dataset.id, {
      title: 'Renamed',
      data_ref: 'r2:videos/old/master.m3u8', // same as current
    })
    expect(result.ok).toBe(true)
  })

  it('treats a same-value format submission as a no-op even while transcoding', async () => {
    // Important edge case: the form re-submits the current
    // value of every field on save, including format. While
    // transcoding, that current value matches the row's value,
    // so we shouldn't reject the PUT just because `format` is
    // present in the body — only reject when it actually
    // changes.
    const { env } = setupEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Transcoding row',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('seed')
    env.CATALOG_DB!
      .prepare(`UPDATE datasets SET transcoding = 1 WHERE id = ?`)
      .bind(created.dataset.id)
      .run()
    const result = await updateDataset(env, ADMIN, created.dataset.id, {
      title: 'Renamed',
      format: 'video/mp4', // same as current
    })
    expect(result.ok).toBe(true)
  })
})

describe('publishDataset', () => {
  it('stamps published_at and invalidates KV', async () => {
    const { env } = setupEnv()
    const kv = env.CATALOG_KV
    await kv.put(SNAPSHOT_KEY, JSON.stringify({ etag: '"x"', body: '{}', contentType: 'application/json' }))

    const created = await createDataset(env, ADMIN, {
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
    const created = await createDataset(env, ADMIN, {
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
    const created = await createDataset(env, ADMIN, {
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

// ---------------------------------------------------------------------------
// Phase 1c — embed / delete-embedding enqueue integration
//
// Covers the wiring layer between the mutation paths and the embed
// pipeline. The job body itself is tested in
// `embed-dataset-job.test.ts`; here we just assert that:
//
//   - publishDataset enqueues `embed_dataset` for the new row
//   - updateDataset enqueues `embed_dataset` only when the row is
//     currently published (drafts stay un-embedded — they aren't
//     searchable)
//   - retractDataset enqueues `delete_dataset_embedding`
//   - all three skip the enqueue silently when no jobQueue is passed
//   - all three skip the enqueue silently when the env has neither
//     real bindings nor mock flags (`isEmbedConfigured` / Vectorize-
//     only-for-delete gate) — keeps a Vectorize-less deploy from
//     logging ConfigurationError on every publish/retract
//   - the SyncJobQueue + MOCK_AI + MOCK_VECTORIZE path round-trips
//     all the way to a queryable Vectorize match (smoke test that
//     the integration actually delivers the docent's search index)
// ---------------------------------------------------------------------------

function setupEmbedEnv() {
  const base = setupEnv()
  const env = {
    ...base.env,
    MOCK_AI: 'true',
    MOCK_VECTORIZE: 'true',
  } as typeof base.env & { MOCK_AI: string; MOCK_VECTORIZE: string }
  __clearMockStore(env as VectorizeEnv)
  return { ...base, env }
}

describe('isEmbedConfigured', () => {
  it('is false when neither AI nor MOCK_AI is set', () => {
    expect(isEmbedConfigured({ MOCK_VECTORIZE: 'true' })).toBe(false)
  })
  it('is false when neither CATALOG_VECTORIZE nor MOCK_VECTORIZE is set', () => {
    expect(isEmbedConfigured({ MOCK_AI: 'true' })).toBe(false)
  })
  it('is true when both mock flags are set', () => {
    expect(isEmbedConfigured({ MOCK_AI: 'true', MOCK_VECTORIZE: 'true' })).toBe(true)
  })
  it('is true when both real bindings are set', () => {
    expect(
      isEmbedConfigured({
        AI: {} as unknown as Ai,
        CATALOG_VECTORIZE: {} as unknown as Vectorize,
      }),
    ).toBe(true)
  })
})

describe('publishDataset — embed enqueue', () => {
  it('enqueues `embed_dataset` for the new row when the queue is provided + env is configured', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Hurricane Tracks',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')

    const queue = new CapturingJobQueue()
    const result = await publishDataset(env, created.dataset.id, { jobQueue: queue })
    expect(result.ok).toBe(true)
    expect(queue.records).toEqual([
      { name: EMBED_JOB_NAME, payload: { dataset_id: created.dataset.id } },
    ])
  })

  it('skips enqueue when no jobQueue is provided', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'No queue',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')

    const result = await publishDataset(env, created.dataset.id)
    expect(result.ok).toBe(true) // no throw, no queue.
  })

  it('skips enqueue when env has neither real bindings nor mock flags', async () => {
    const { env } = setupEnv() // no MOCK_AI / MOCK_VECTORIZE
    const created = await createDataset(env, ADMIN, {
      title: 'Unconfigured',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')

    const queue = new CapturingJobQueue()
    await publishDataset(env, created.dataset.id, { jobQueue: queue })
    expect(queue.records).toEqual([])
  })

  it('SyncJobQueue path round-trips to a queryable Vectorize match', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Atlantic Hurricane Tracks',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
      keywords: ['hurricane', 'atlantic', 'storm'],
      categories: { Theme: ['Atmosphere'] },
    })
    if (!created.ok) throw new Error('seed')

    const queue = new SyncJobQueue(env)
    const result = await publishDataset(env, created.dataset.id, { jobQueue: queue })
    expect(result.ok).toBe(true)

    // Vector landed; a query against the same vocabulary finds it.
    const queryVec = await embedDatasetText(env, 'hurricane storm atlantic')
    const matches = await queryEmbedding(env, queryVec, { limit: 5 })
    expect(matches.find(m => m.dataset_id === created.dataset.id)).toBeDefined()
  })
})

describe('updateDataset — embed enqueue', () => {
  it('does NOT enqueue when updating an unpublished draft', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Draft only',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('seed')

    const queue = new CapturingJobQueue()
    await updateDataset(env, ADMIN, created.dataset.id, { title: 'Renamed' }, { jobQueue: queue })
    expect(queue.records).toEqual([])
  })

  it('enqueues `embed_dataset` when updating a currently-published row', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Published',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    await publishDataset(env, created.dataset.id) // un-queued

    const queue = new CapturingJobQueue()
    await updateDataset(env, ADMIN, created.dataset.id, { title: 'Renamed' }, { jobQueue: queue })
    expect(queue.records).toEqual([
      { name: EMBED_JOB_NAME, payload: { dataset_id: created.dataset.id } },
    ])
  })

  it('does NOT enqueue when updating a retracted row', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Will retract',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    await publishDataset(env, created.dataset.id)
    await retractDataset(env, created.dataset.id)

    const queue = new CapturingJobQueue()
    await updateDataset(env, ADMIN, created.dataset.id, { title: 'Tomb' }, { jobQueue: queue })
    expect(queue.records).toEqual([])
  })
})

describe('retractDataset — delete-embedding enqueue', () => {
  it('enqueues `delete_dataset_embedding` for the retracted id', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Retract me',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    await publishDataset(env, created.dataset.id)

    const queue = new CapturingJobQueue()
    await retractDataset(env, created.dataset.id, { jobQueue: queue })
    expect(queue.records).toEqual([
      { name: DELETE_EMBEDDING_JOB_NAME, payload: { dataset_id: created.dataset.id } },
    ])
  })

  it('skips enqueue when env has no Vectorize binding and no MOCK_VECTORIZE', async () => {
    const { env } = setupEnv() // unconfigured
    const created = await createDataset(env, ADMIN, {
      title: 'Unconfigured retract',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    await publishDataset(env, created.dataset.id)

    const queue = new CapturingJobQueue()
    await retractDataset(env, created.dataset.id, { jobQueue: queue })
    expect(queue.records).toEqual([])
  })

  it('SyncJobQueue path actually drops the vector from Vectorize', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Round-trip retract',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
      keywords: ['volcano', 'lava', 'eruption'],
    })
    if (!created.ok) throw new Error('seed')

    const queue = new SyncJobQueue(env)
    await publishDataset(env, created.dataset.id, { jobQueue: queue })

    const queryVec = await embedDatasetText(env, 'volcano lava eruption')
    expect(
      (await queryEmbedding(env, queryVec)).find(m => m.dataset_id === created.dataset.id),
    ).toBeDefined()

    await retractDataset(env, created.dataset.id, { jobQueue: queue })
    expect(
      (await queryEmbedding(env, queryVec)).find(m => m.dataset_id === created.dataset.id),
    ).toBeUndefined()
  })
})

describe('reindexDataset — bulk re-embed entry point (1d/D)', () => {
  it('enqueues `embed_dataset` for a published row when env is configured', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Reindex Me',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    await publishDataset(env, created.dataset.id)

    const queue = new CapturingJobQueue()
    const result = await reindexDataset(env, ADMIN, created.dataset.id, { jobQueue: queue })
    expect(result.ok).toBe(true)
    expect(queue.records).toEqual([
      { name: EMBED_JOB_NAME, payload: { dataset_id: created.dataset.id } },
    ])
  })

  it('returns 404 when the dataset is not visible to the caller', async () => {
    const { env } = setupEmbedEnv()
    const result = await reindexDataset(env, ADMIN, 'NONEXISTENT', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
    expect(result.errors[0].code).toBe('not_found')
  })

  it('returns 409 not_published when the row is still a draft', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Draft only',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('seed')

    const queue = new CapturingJobQueue()
    const result = await reindexDataset(env, ADMIN, created.dataset.id, { jobQueue: queue })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.errors[0].code).toBe('not_published')
    expect(queue.records).toEqual([])
  })

  it('returns 409 not_published when the row has been retracted', async () => {
    const { env } = setupEmbedEnv()
    const created = await createDataset(env, ADMIN, {
      title: 'Retract first',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    await publishDataset(env, created.dataset.id)
    await retractDataset(env, created.dataset.id)

    const queue = new CapturingJobQueue()
    const result = await reindexDataset(env, ADMIN, created.dataset.id, { jobQueue: queue })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(queue.records).toEqual([])
  })

  it('returns 503 embed_unconfigured when neither bindings nor mock flags are set', async () => {
    const { env } = setupEnv() // no MOCK_AI / MOCK_VECTORIZE
    const created = await createDataset(env, ADMIN, {
      title: 'Pre-vectorize publish',
      format: 'video/mp4',
      data_ref: 'vimeo:1',
      license_spdx: 'CC-BY-4.0',
    })
    if (!created.ok) throw new Error('seed')
    await publishDataset(env, created.dataset.id)

    const queue = new CapturingJobQueue()
    const result = await reindexDataset(env, ADMIN, created.dataset.id, { jobQueue: queue })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(503)
    expect(result.errors[0].code).toBe('embed_unconfigured')
    expect(queue.records).toEqual([])
  })
})

describe('deleteDataset', () => {
  it('hard-deletes a draft and enqueues the embedding delete', async () => {
    // setupEmbedEnv wires the Vectorize binding — without it the
    // embedding-delete enqueue is deliberately gated off.
    const { env } = setupEmbedEnv()
    const created = await createDataset(env as never, ADMIN, {
      title: 'Disposable draft',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('setup create failed')
    const queue = new CapturingJobQueue()
    const result = await deleteDataset(env as never, ADMIN, created.dataset.id, {
      jobQueue: queue,
    })
    expect(result).toEqual({ ok: true, deleted_id: created.dataset.id })
    expect(await getDatasetForPublisher(env.CATALOG_DB, ADMIN, created.dataset.id)).toBeNull()
    expect(queue.records).toEqual([
      { name: DELETE_EMBEDDING_JOB_NAME, payload: { dataset_id: created.dataset.id } },
    ])
  })

  it("404s when a publisher-role account targets someone else's row", async () => {
    const { env } = setupEnv()
    const created = await createDataset(env as never, ADMIN, {
      title: 'Admin-owned draft',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('setup create failed')
    const result = await deleteDataset(env as never, PUBLISHER, created.dataset.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
    expect(await getDatasetForPublisher(env.CATALOG_DB, ADMIN, created.dataset.id)).not.toBeNull()
  })

  it('409s on a published row, then allows delete once retracted', async () => {
    const { sqlite, env } = setupEnv()
    const created = await createDataset(env as never, ADMIN, {
      title: 'Published row',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('setup create failed')
    sqlite
      .prepare('UPDATE datasets SET published_at = ? WHERE id = ?')
      .run('2026-06-01T00:00:00.000Z', created.dataset.id)
    const published = await deleteDataset(env as never, ADMIN, created.dataset.id)
    expect(published.ok).toBe(false)
    if (!published.ok) {
      expect(published.status).toBe(409)
      expect(published.error).toBe('published')
    }
    sqlite
      .prepare('UPDATE datasets SET retracted_at = ? WHERE id = ?')
      .run('2026-06-02T00:00:00.000Z', created.dataset.id)
    const retracted = await deleteDataset(env as never, ADMIN, created.dataset.id)
    expect(retracted.ok).toBe(true)
  })

  it('409s while a transcode is in flight', async () => {
    const { sqlite, env } = setupEnv()
    const created = await createDataset(env as never, ADMIN, {
      title: 'Mid-transcode row',
      format: 'video/mp4',
    })
    if (!created.ok) throw new Error('setup create failed')
    sqlite
      .prepare('UPDATE datasets SET transcoding = 1 WHERE id = ?')
      .run(created.dataset.id)
    const result = await deleteDataset(env as never, ADMIN, created.dataset.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toBe('transcode_in_progress')
    }
  })
})
