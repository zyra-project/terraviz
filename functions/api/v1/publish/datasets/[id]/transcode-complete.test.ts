/**
 * Tests for `POST /api/v1/publish/datasets/{id}/transcode-complete`.
 *
 * The endpoint is the workflow side of the 3pd transcode pipeline:
 * GHA writes the HLS bundle to R2 under
 * `videos/{datasetId}/{uploadId}/`, then POSTs back through this
 * route to flip `data_ref` and clear `transcoding`. The server
 * constructs `data_ref` itself from the route id + upload id, so
 * the workflow can't accidentally PATCH dataset A with dataset B's
 * bundle (Phase 3pd review fix #3).
 *
 * Restricted to service-token / admin-staff callers — community
 * publishers shouldn't be able to manipulate the `transcoding`
 * column directly.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost as transcodeComplete } from './transcode-complete'
import { asD1, makeKV, seedFixtures } from '../../../_lib/test-helpers'
import type { PublisherRow } from '../../../_lib/publisher-store'

const STAFF_ADMIN: PublisherRow = {
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

const SERVICE: PublisherRow = {
  ...STAFF_ADMIN,
  id: 'PUB-SERVICE',
  email: 'transcode@service',
  display_name: 'Transcode service',
  role: 'service',
  is_admin: 0,
}

const COMMUNITY: PublisherRow = {
  ...STAFF_ADMIN,
  id: 'PUB-COMMUNITY',
  email: 'community@example.com',
  display_name: 'Community',
  role: 'community',
  is_admin: 0,
}

// ULIDs are Crockford base32 — `U`, `I`, `L`, `O` are excluded.
// `DS000` (D, S, 0) and `KP000` (K, P, 0) all live inside the
// allowed set so the route's regex check accepts them.
const DATASET_ID = 'DS000' + 'A'.repeat(21)
const UPLOAD_ID = 'KP000' + 'A'.repeat(21)
const DEFAULT_SOURCE_DIGEST = 'sha256:' + 'a'.repeat(64)

function setupEnv(opts: {
  transcoding?: boolean
  sourceDigest?: string
  /** Seed the matching asset_uploads row. Defaults to true.
   *  Tests that want to exercise the "upload not found" branch
   *  pass `false`. */
  seedUpload?: boolean
  /** Override the seeded upload's `target_ref` (for the
   *  "upload_kind_mismatch" branch). */
  uploadTargetRef?: string
  /** Override the seeded upload's `kind`. */
  uploadKind?: 'data' | 'thumbnail'
  /** Override the seeded `datasets.active_transcode_upload_id`.
   *  Defaults to UPLOAD_ID. Pass another ULID to simulate a
   *  superseding upload, or `null` to simulate a pre-0012 row. */
  activeUploadId?: string | null
} = {}) {
  const sqlite = seedFixtures({ count: 1 })
  for (const p of [STAFF_ADMIN, SERVICE, COMMUNITY]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  const sourceDigest = opts.sourceDigest ?? DEFAULT_SOURCE_DIGEST
  // The active-upload-id binding (migration 0012) defaults to the
  // canonical UPLOAD_ID so the happy-path tests below don't have to
  // pass it explicitly. Tests that exercise the mismatch branch
  // override `activeUploadId` (to a different id) or pass the
  // sentinel `null` to clear it (simulating a row that was
  // transcoding before the migration shipped).
  const activeUploadId =
    opts.activeUploadId === null
      ? null
      : opts.activeUploadId ?? UPLOAD_ID
  if (opts.transcoding ?? true) {
    sqlite
      .prepare(
        `UPDATE datasets
           SET transcoding = 1,
               active_transcode_upload_id = ?,
               data_ref = '',
               source_digest = ?
         WHERE id = ?`,
      )
      .run(activeUploadId, sourceDigest, DATASET_ID)
  }
  if (opts.seedUpload ?? true) {
    sqlite
      .prepare(
        `INSERT INTO asset_uploads
           (id, dataset_id, publisher_id, kind, target, target_ref, mime,
            declared_size, claimed_digest, status, failure_reason,
            created_at, completed_at)
         VALUES (?, ?, ?, ?, 'r2', ?, 'video/mp4', 1000, ?, 'completed', NULL, ?, ?)`,
      )
      .run(
        UPLOAD_ID,
        DATASET_ID,
        STAFF_ADMIN.id,
        opts.uploadKind ?? 'data',
        opts.uploadTargetRef ?? `r2:uploads/${DATASET_ID}/${UPLOAD_ID}/source.mp4`,
        sourceDigest,
        '2026-04-29T12:00:00.000Z',
        '2026-04-29T12:01:00.000Z',
      )
  }
  return {
    sqlite,
    datasetId: DATASET_ID,
    uploadId: UPLOAD_ID,
    env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() },
  }
}

function ctx(opts: {
  env: Record<string, unknown>
  datasetId: string
  publisher?: PublisherRow
  body?: unknown
}) {
  const url = `https://localhost/api/v1/publish/datasets/${opts.datasetId}/transcode-complete`
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
  } as unknown as Parameters<typeof transcodeComplete>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('POST .../transcode-complete — happy path', () => {
  it('clears transcoding, server-constructs data_ref, returns the updated row', async () => {
    const { sqlite, datasetId, uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ dataset: { data_ref: string; transcoding: number | null } }>(
      res,
    )
    // data_ref is built server-side from the route id + upload id;
    // the workflow never gets to choose. Fix for #3.
    expect(body.dataset.data_ref).toBe(`r2:videos/${datasetId}/${uploadId}/master.m3u8`)
    expect(body.dataset.transcoding).toBeNull()

    const row = sqlite
      .prepare(`SELECT data_ref, transcoding FROM datasets WHERE id = ?`)
      .get(datasetId) as { data_ref: string; transcoding: number | null }
    expect(row.data_ref).toBe(`r2:videos/${datasetId}/${uploadId}/master.m3u8`)
    expect(row.transcoding).toBeNull()
  })

  it('marks the asset_uploads row completed (durable backstop for /complete mark-failure)', async () => {
    // PR #112 followup — /asset/.../complete's
    // markVideoUploadCompleted step can fail transiently after
    // dispatch succeeds, leaving the upload row stuck `pending`.
    // /transcode-complete re-marks it here so the post-workflow
    // state is always upload.status='completed', and any retry
    // of /complete hits the top-of-handler idempotent branch
    // cleanly. Closes the attack vector that required the
    // earlier `alreadyCompleted` recovery branch in /complete
    // (which the publisher could forge via a planted data_ref).
    const { sqlite, datasetId, uploadId, env } = setupEnv()
    // Simulate the stuck-pending state: /asset/.../complete
    // ran its dispatch but the mark step never landed.
    sqlite
      .prepare(`UPDATE asset_uploads SET status = 'pending', completed_at = NULL WHERE id = ?`)
      .run(uploadId)
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(200)
    const row = sqlite
      .prepare(`SELECT status, completed_at FROM asset_uploads WHERE id = ?`)
      .get(uploadId) as { status: string; completed_at: string | null }
    expect(row.status).toBe('completed')
    expect(row.completed_at).not.toBeNull()
  })

  it('writes an audit_events row tagged transcode_complete with the upload_id', async () => {
    const { sqlite, datasetId, uploadId, env } = setupEnv()
    await transcodeComplete(ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }))
    const audit = sqlite
      .prepare(
        `SELECT action, metadata_json FROM audit_events WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(datasetId) as { action: string; metadata_json: string }
    expect(audit.action).toBe('dataset.update')
    const meta = JSON.parse(audit.metadata_json) as {
      fields: string[]
      reason: string
      upload_id: string
    }
    expect(meta.reason).toBe('transcode_complete')
    // Audit metadata lists every server-managed column
    // clearTranscoding mutates — PR #112 followup
    // (transcode-complete.ts audit completeness).
    expect(meta.fields).toEqual([
      'data_ref',
      'transcoding',
      'active_transcode_upload_id',
      'content_digest',
    ])
    expect(meta.upload_id).toBe(uploadId)
  })

  it('accepts a matching source_digest belt-and-suspenders check', async () => {
    const sourceDigest = 'sha256:' + 'b'.repeat(64)
    const { datasetId, uploadId, env } = setupEnv({ sourceDigest })
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        body: { upload_id: uploadId, source_digest: sourceDigest },
      }),
    )
    expect(res.status).toBe(200)
  })
})

describe('POST .../transcode-complete — auth', () => {
  it('allows staff admins through', async () => {
    const { datasetId, uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        publisher: STAFF_ADMIN,
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('rejects community publishers with 403', async () => {
    const { datasetId, uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        publisher: COMMUNITY,
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe('transcode_complete_forbidden')
  })

  it('rejects non-admin staff with 403', async () => {
    const nonAdmin: PublisherRow = { ...STAFF_ADMIN, is_admin: 0 }
    const { datasetId, uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        publisher: nonAdmin,
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(403)
  })
})

describe('POST .../transcode-complete — refusals', () => {
  it('returns 404 for an unknown dataset id', async () => {
    const { uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId: 'NOPE',
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 upload_not_found when the upload doesn’t exist', async () => {
    const { datasetId, env } = setupEnv({ seedUpload: false })
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        body: { upload_id: UPLOAD_ID, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(404)
    expect((await readJson<{ error: string }>(res)).error).toBe('upload_not_found')
  })

  it('returns 404 upload_not_found when the upload belongs to a different dataset', async () => {
    // Seed a fresh dataset with a different id and bind the
    // upload to it; the route still points at the original
    // datasetId, so the mismatched binding should 404.
    const { sqlite, env } = setupEnv({ seedUpload: false })
    const otherDataset = 'DSXYZ' + 'A'.repeat(21)
    sqlite
      .prepare(
        `INSERT INTO datasets (id, slug, origin_node, title, format, data_ref,
                                weight, visibility, is_hidden, schema_version,
                                created_at, updated_at, transcoding)
         VALUES (?, 'other', 'NODE000', 'Other', 'video/mp4', '',
                 0, 'public', 0, 1,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`,
      )
      .run(otherDataset)
    sqlite
      .prepare(
        `INSERT INTO asset_uploads
           (id, dataset_id, publisher_id, kind, target, target_ref, mime,
            declared_size, claimed_digest, status, failure_reason,
            created_at, completed_at)
         VALUES (?, ?, ?, 'data', 'r2', ?, 'video/mp4', 1000, ?, 'completed', NULL, ?, ?)`,
      )
      .run(
        UPLOAD_ID,
        otherDataset,
        STAFF_ADMIN.id,
        `r2:uploads/${otherDataset}/${UPLOAD_ID}/source.mp4`,
        DEFAULT_SOURCE_DIGEST,
        '2026-04-29T12:00:00.000Z',
        '2026-04-29T12:01:00.000Z',
      )
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId: DATASET_ID, // <- doesn't match the upload's dataset_id
        body: { upload_id: UPLOAD_ID, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(404)
    expect((await readJson<{ error: string }>(res)).error).toBe('upload_not_found')
  })

  it('returns 409 upload_kind_mismatch when the upload isn’t a video source', async () => {
    // Seed an upload whose target_ref doesn't live under
    // `uploads/` — i.e. it's an image upload that landed at the
    // content-addressed key. The workflow shouldn't be finalising
    // anything except video sources.
    const { datasetId, uploadId, env } = setupEnv({
      uploadTargetRef: `r2:datasets/${DATASET_ID}/by-digest/sha256/abc/asset.png`,
    })
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('upload_kind_mismatch')
  })

  it('returns 409 not_transcoding when the row isn’t currently transcoding', async () => {
    const { datasetId, uploadId, env } = setupEnv({ transcoding: false })
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('not_transcoding')
  })

  it('returns 409 transcode_upload_mismatch when the callback’s upload_id is stale', async () => {
    // Migration 0012 — two uploads with identical bytes (same
    // source_digest) need a per-upload binding to disambiguate
    // their callbacks. The newer upload's /complete handler set
    // active_transcode_upload_id to its own id; an older
    // workflow's callback (carrying the previous upload_id) must
    // 409 here instead of clearing transcoding against the wrong
    // upload's bundle.
    const newerUploadId = 'KP000' + 'B'.repeat(21)
    const { datasetId, uploadId, env } = setupEnv({ activeUploadId: newerUploadId })
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string; message: string }>(res)
    expect(body.error).toBe('transcode_upload_mismatch')
    expect(body.message).toContain(newerUploadId)
  })

  it('returns 409 transcode_upload_mismatch when active_transcode_upload_id is NULL (pre-0012 row)', async () => {
    // A row that was transcoding before migration 0012 shipped
    // has the column NULL. Such rows are stuck and need operator
    // cleanup rather than a workflow callback flipping data_ref
    // against an unverified binding.
    const { datasetId, uploadId, env } = setupEnv({ activeUploadId: null })
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe(
      'transcode_upload_mismatch',
    )
  })

  it('returns 409 source_digest_mismatch on a digest mismatch', async () => {
    const { datasetId, uploadId, env } = setupEnv({
      sourceDigest: 'sha256:' + 'a'.repeat(64),
    })
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        body: {
          upload_id: uploadId,
          source_digest: 'sha256:' + 'f'.repeat(64),
        },
      }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('source_digest_mismatch')
  })

  it('returns 400 invalid_body on a missing source_digest (#3)', async () => {
    // Required since 3pd-review3/B — a stale dispatch should
    // not be able to win against a fresher upload's
    // source_digest just by omitting the field.
    const { datasetId, uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId } }),
    )
    expect(res.status).toBe(400)
    const body = await readJson<{ message: string }>(res)
    expect(body.message).toMatch(/source_digest/)
  })

  it('returns 400 invalid_body on a missing upload_id', async () => {
    const { datasetId, env } = setupEnv()
    const res = await transcodeComplete(ctx({ env, datasetId, body: {} }))
    expect(res.status).toBe(400)
  })

  it('returns 400 invalid_body on an upload_id that isn’t a ULID', async () => {
    const { datasetId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: 'not-a-ulid' } }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 invalid_json on a non-JSON body', async () => {
    const { datasetId, env } = setupEnv()
    const url = `https://localhost/api/v1/publish/datasets/${datasetId}/transcode-complete`
    const baseCtx = ctx({ env, datasetId, body: {} })
    const goodCtx = {
      ...baseCtx,
      request: new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    } as typeof baseCtx
    const res = await transcodeComplete(goodCtx)
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_json')
  })
})
