/**
 * Tests for `POST /api/v1/publish/datasets/{id}/transcode-failed`.
 *
 * The failure counterpart to `/transcode-complete`: the transcode job
 * errored or timed out, so this releases the `transcoding` lock WITHOUT
 * touching `data_ref` (the row keeps serving its prior good bundle).
 * Guarded by the active-upload binding and restricted to privileged
 * callers, exactly like the complete route.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost as transcodeFailed } from './transcode-failed'
import { asD1, makeKV, seedFixtures } from '../../../_lib/test-helpers'
import type { PublisherRow } from '../../../_lib/publisher-store'

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
const SERVICE: PublisherRow = { ...ADMIN, id: 'PUB-SERVICE', email: 'svc@service', role: 'service', is_admin: 0 }
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUBLISHER', email: 'pub@example.com', role: 'publisher', is_admin: 0 }

const DATASET_ID = 'DS000' + 'A'.repeat(21)
const UPLOAD_ID = 'KP000' + 'A'.repeat(21)
const OTHER_UPLOAD = 'KP000' + 'B'.repeat(21)
const HELD_DATA_REF = 'r2:videos/' + DATASET_ID + '/PRIORUPLOAD0000000000000001/master.m3u8'

function setupEnv(opts: { transcoding?: boolean; activeUploadId?: string | null } = {}) {
  const sqlite = seedFixtures({ count: 1 })
  for (const p of [ADMIN, SERVICE, PUBLISHER]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  const activeUploadId = opts.activeUploadId === null ? null : opts.activeUploadId ?? UPLOAD_ID
  // Seed a row mid-transcode that HELD a prior published data_ref —
  // the failure path must leave it intact.
  sqlite
    .prepare(
      `UPDATE datasets
         SET transcoding = ?,
             active_transcode_upload_id = ?,
             data_ref = ?
       WHERE id = ?`,
    )
    .run(opts.transcoding ?? true ? 1 : null, activeUploadId, HELD_DATA_REF, DATASET_ID)
  return { sqlite, datasetId: DATASET_ID, uploadId: UPLOAD_ID, env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() } }
}

function ctx(opts: { env: Record<string, unknown>; datasetId: string; publisher?: PublisherRow; body?: unknown }) {
  const url = `https://localhost/api/v1/publish/datasets/${opts.datasetId}/transcode-failed`
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env: opts.env,
    params: { id: opts.datasetId },
    data: { publisher: opts.publisher ?? SERVICE },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof transcodeFailed>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('POST .../transcode-failed', () => {
  it('releases the transcoding lock and leaves data_ref untouched', async () => {
    const { sqlite, datasetId, uploadId, env } = setupEnv()
    const res = await transcodeFailed(ctx({ env, datasetId, body: { upload_id: uploadId } }))
    expect(res.status).toBe(200)
    const body = await readJson<{ dataset: { data_ref: string; transcoding: number | null } }>(res)
    expect(body.dataset.transcoding).toBeNull()
    expect(body.dataset.data_ref).toBe(HELD_DATA_REF)

    const row = sqlite
      .prepare(`SELECT data_ref, transcoding, active_transcode_upload_id FROM datasets WHERE id = ?`)
      .get(datasetId) as { data_ref: string; transcoding: number | null; active_transcode_upload_id: string | null }
    expect(row.transcoding).toBeNull()
    expect(row.active_transcode_upload_id).toBeNull()
    expect(row.data_ref).toBe(HELD_DATA_REF) // prior bundle preserved
  })

  it('writes a transcode_failed audit entry with the error summary', async () => {
    const { sqlite, datasetId, uploadId, env } = setupEnv()
    await transcodeFailed(ctx({ env, datasetId, body: { upload_id: uploadId, error_summary: 'boom\u0007timed out' } }))
    const audit = sqlite
      .prepare(`SELECT metadata_json FROM audit_events WHERE subject_id = ? ORDER BY id DESC LIMIT 1`)
      .get(datasetId) as { metadata_json: string }
    const meta = JSON.parse(audit.metadata_json)
    expect(meta.reason).toBe('transcode_failed')
    expect(meta.upload_id).toBe(uploadId)
    expect(meta.error_summary).toBe('boom timed out') // \u0007 collapsed to a space
  })

  it('is idempotent when the row is no longer transcoding', async () => {
    const { datasetId, uploadId, env } = setupEnv({ transcoding: false })
    const res = await transcodeFailed(ctx({ env, datasetId, body: { upload_id: uploadId } }))
    expect(res.status).toBe(200)
    const body = await readJson<{ idempotent?: boolean }>(res)
    expect(body.idempotent).toBe(true)
  })

  it('refuses (409) when a newer upload owns the active transcode', async () => {
    const { sqlite, datasetId, uploadId, env } = setupEnv({ activeUploadId: OTHER_UPLOAD })
    const res = await transcodeFailed(ctx({ env, datasetId, body: { upload_id: uploadId } }))
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('transcode_upload_mismatch')
    // The newer upload's lock is untouched.
    const row = sqlite.prepare(`SELECT transcoding FROM datasets WHERE id = ?`).get(datasetId) as {
      transcoding: number | null
    }
    expect(row.transcoding).toBe(1)
  })

  it('rejects a non-privileged caller (403)', async () => {
    const { datasetId, uploadId, env } = setupEnv()
    const res = await transcodeFailed(ctx({ env, datasetId, publisher: PUBLISHER, body: { upload_id: uploadId } }))
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe('transcode_failed_forbidden')
  })

  it('404s an unknown dataset', async () => {
    const { uploadId, env } = setupEnv()
    const res = await transcodeFailed(ctx({ env, datasetId: 'DS000' + 'Z'.repeat(21), body: { upload_id: uploadId } }))
    expect(res.status).toBe(404)
  })

  it('400s a missing/invalid upload_id', async () => {
    const { datasetId, env } = setupEnv()
    const res = await transcodeFailed(ctx({ env, datasetId, body: { upload_id: 'nope' } }))
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_body')
  })
})
