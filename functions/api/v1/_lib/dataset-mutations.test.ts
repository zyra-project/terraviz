/**
 * Tests for the publisher-API dataset mutations layer.
 *
 * Coverage:
 *   - createDataset on a valid body inserts a draft (published_at NULL).
 *   - createDataset returns 400 + errors for invalid body.
 *   - Slug is derived from the title when missing, with collision suffix.
 *   - listDatasetsForPublisher honors the admin vs publisher filter.
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
  deleteDataset,
  DELETE_EMBEDDING_JOB_NAME,
  EMBED_JOB_NAME,
  getDatasetForPublisher,
  isEmbedConfigured,
  listDatasetsForPublisher,
  publishDataset,
  reindexDataset,
  retractDataset,
  updateDataset,
} from './dataset-mutations'
import { asD1, makeKV, seedFixtures } from './test-helpers'
import { CapturingJobQueue, SyncJobQueue } from './job-queue'
import { SNAPSHOT_KEY } from './snapshot'
import { __clearMockStore, queryEmbedding, type VectorizeEnv } from './vectorize-store'
import { embedDatasetText } from './embeddings'

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

  it('filters to own rows for a publisher-role account', async () => {
    const { env } = setupEnv()
    await seed3(env)
    const { datasets } = await listDatasetsForPublisher(env.CATALOG_DB!, PUBLISHER)
    expect(datasets).toHaveLength(2)
    for (const d of datasets) expect(d.publisher_id).toBe(PUBLISHER.id)
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
