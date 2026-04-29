/**
 * Wire-level tests for `POST /api/v1/publish/datasets/{id}/asset/{upload_id}/complete`.
 *
 * Coverage:
 *   - 200 + dataset row updated with the right *_ref / digest column
 *     for every kind (data over Stream, data over R2, thumbnail,
 *     sphere_thumbnail, legend, caption).
 *   - asset_uploads row flips to status='completed' with a
 *     completed_at timestamp.
 *   - KV snapshot invalidates when the dataset is currently
 *     published, doesn't when it's a draft.
 *   - 404 for unknown / mis-tenanted upload ids.
 *   - 409 digest_mismatch on R2 byte mismatch + asset_uploads row
 *     marked failed with `digest_mismatch` reason.
 *   - 409 asset_missing when the R2 binding has no object at the key.
 *   - 202 transcode_in_progress when Stream is still processing.
 *   - 409 transcode_error when Stream errors out.
 *   - Idempotent re-call on a `completed` row returns 200.
 *   - Re-call on a `failed` row returns 409 upload_failed.
 */

import { describe, expect, it, vi } from 'vitest'
import { onRequestPost as completeHandler } from './complete'
import { asD1, makeKV, seedFixtures } from '../../../../../_lib/test-helpers'
import type { PublisherRow } from '../../../../../_lib/publisher-store'
import { CapturingJobQueue } from '../../../../../_lib/job-queue'

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
  id: 'PUB-COMMUNITY',
  email: 'community@example.com',
  display_name: 'Community',
  role: 'community',
  is_admin: 0,
}

const SHA64_HELLO = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
const HELLO_DIGEST = `sha256:${SHA64_HELLO}`
const SHA64_OTHER = 'a'.repeat(64)
const OTHER_DIGEST = `sha256:${SHA64_OTHER}`

function setupEnv(opts: { datasetPublished?: boolean } = {}) {
  const sqlite = seedFixtures({ count: 1 })
  for (const p of [STAFF, COMMUNITY]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  const datasetId = 'DS000' + 'A'.repeat(21)
  sqlite.prepare(`UPDATE datasets SET publisher_id = ? WHERE id = ?`).run(STAFF.id, datasetId)
  if (opts.datasetPublished === false) {
    sqlite.prepare(`UPDATE datasets SET published_at = NULL WHERE id = ?`).run(datasetId)
  }
  const kv = makeKV()
  // Seed a snapshot so we can assert invalidation actually runs.
  void kv.put('catalog:snapshot:v1', JSON.stringify({ etag: '"x"', generatedAt: 'now', body: '{}', contentType: 'application/json' }))
  return { sqlite, datasetId, kv }
}

interface PendingUploadOptions {
  uploadId: string
  datasetId: string
  kind: 'data' | 'thumbnail' | 'legend' | 'caption' | 'sphere_thumbnail'
  target: 'r2' | 'stream'
  target_ref: string
  mime: string
  claimed_digest: string
  publisherId?: string
}

function insertPending(sqlite: ReturnType<typeof seedFixtures>, opts: PendingUploadOptions) {
  sqlite
    .prepare(
      `INSERT INTO asset_uploads
        (id, dataset_id, publisher_id, kind, target, target_ref, mime,
         declared_size, claimed_digest, status, failure_reason,
         created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
    )
    .run(
      opts.uploadId,
      opts.datasetId,
      opts.publisherId ?? STAFF.id,
      opts.kind,
      opts.target,
      opts.target_ref,
      opts.mime,
      1234,
      opts.claimed_digest,
      '2026-04-29T12:00:00.000Z',
    )
}

function makeBucket(content: ArrayBuffer | null): R2Bucket {
  return {
    get: async (_key: string) => {
      if (!content) return null
      return { arrayBuffer: async () => content } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
}

function ctx(opts: {
  env: Record<string, unknown>
  datasetId: string
  uploadId: string
  publisher?: PublisherRow
  jobQueue?: CapturingJobQueue
}) {
  const url = `https://localhost/api/v1/publish/datasets/${opts.datasetId}/asset/${opts.uploadId}/complete`
  // Default to a CapturingJobQueue so tests that don't care about
  // the sphere-thumbnail enqueue path don't run the job
  // eagerly (which would require every fixture to wire up a fake
  // R2 binding even when the test isn't about R2). The dedicated
  // enqueue-wiring tests pass an explicit queue and assert on its
  // records.
  const jobQueue = opts.jobQueue ?? new CapturingJobQueue()
  return {
    request: new Request(url, { method: 'POST' }),
    env: opts.env,
    params: { id: opts.datasetId, upload_id: opts.uploadId },
    data: { publisher: opts.publisher ?? STAFF, jobQueue },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof completeHandler>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

const HELLO_BYTES = new TextEncoder().encode('hello world')

describe('POST .../asset/{upload_id}/complete — R2 happy paths', () => {
  it('flips data_ref + content_digest for an R2 image data upload', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    insertPending(sqlite, {
      uploadId: 'UP-DATA',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/asset.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-DATA' }))
    expect(res.status).toBe(200)

    const dataset = sqlite
      .prepare(`SELECT data_ref, content_digest, source_digest FROM datasets WHERE id = ?`)
      .get(datasetId) as { data_ref: string; content_digest: string; source_digest: string | null }
    expect(dataset.data_ref).toBe(`r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/asset.png`)
    expect(dataset.content_digest).toBe(HELLO_DIGEST)
    expect(dataset.source_digest).toBeNull()

    const upload = sqlite
      .prepare(`SELECT status, completed_at FROM asset_uploads WHERE id = ?`)
      .get('UP-DATA') as { status: string; completed_at: string }
    expect(upload.status).toBe('completed')
    expect(typeof upload.completed_at).toBe('string')

    // Snapshot was invalidated because the dataset is currently published.
    expect(await kv.get('catalog:snapshot:v1')).toBeNull()
  })

  it('flips thumbnail_ref and merges into auxiliary_digests', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    // Pre-seed an existing aux digest entry so we exercise the merge.
    sqlite
      .prepare(`UPDATE datasets SET auxiliary_digests = ? WHERE id = ?`)
      .run(JSON.stringify({ legend: 'sha256:c'.padEnd(64 + 7, 'c') }), datasetId)
    insertPending(sqlite, {
      uploadId: 'UP-THUMB',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-THUMB' }))
    expect(res.status).toBe(200)

    const dataset = sqlite
      .prepare(`SELECT thumbnail_ref, auxiliary_digests FROM datasets WHERE id = ?`)
      .get(datasetId) as { thumbnail_ref: string; auxiliary_digests: string }
    expect(dataset.thumbnail_ref).toContain('thumbnail.png')
    const aux = JSON.parse(dataset.auxiliary_digests) as Record<string, string>
    expect(aux.thumbnail).toBe(HELLO_DIGEST)
    // Existing legend digest survives the merge.
    expect(aux.legend).toBeDefined()
  })

  it('flips sphere_thumbnail_ref under auxiliary_digests.sphere_thumbnail', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    insertPending(sqlite, {
      uploadId: 'UP-SPHERE',
      datasetId,
      kind: 'sphere_thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/sphere-thumbnail.webp`,
      mime: 'image/webp',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-SPHERE' }))
    expect(res.status).toBe(200)
    const dataset = sqlite
      .prepare(`SELECT sphere_thumbnail_ref, auxiliary_digests FROM datasets WHERE id = ?`)
      .get(datasetId) as { sphere_thumbnail_ref: string; auxiliary_digests: string }
    expect(dataset.sphere_thumbnail_ref).toContain('sphere-thumbnail.webp')
    const aux = JSON.parse(dataset.auxiliary_digests) as Record<string, string>
    expect(aux.sphere_thumbnail).toBe(HELLO_DIGEST)

    // Draft datasets don't trigger snapshot invalidation.
    expect(await kv.get('catalog:snapshot:v1')).not.toBeNull()
  })
})

describe('POST .../asset/{upload_id}/complete — Stream', () => {
  it('returns 200 and stamps source_digest when transcode is ready', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_STREAM: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-STREAM',
      datasetId,
      kind: 'data',
      target: 'stream',
      target_ref: 'stream:abc123def456',
      mime: 'video/mp4',
      claimed_digest: OTHER_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-STREAM' }))
    expect(res.status).toBe(200)
    const dataset = sqlite
      .prepare(`SELECT data_ref, content_digest, source_digest FROM datasets WHERE id = ?`)
      .get(datasetId) as { data_ref: string; content_digest: string | null; source_digest: string }
    expect(dataset.data_ref).toBe('stream:abc123def456')
    expect(dataset.source_digest).toBe(OTHER_DIGEST)
    expect(dataset.content_digest).toBeNull()
  })

  it('returns 202 transcode_in_progress when Stream is still processing', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const fetchStub = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, result: { uid: 'u', status: { state: 'inprogress' } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      STREAM_ACCOUNT_ID: 'acct',
      STREAM_API_TOKEN: 'tok',
      // Patch the global fetch the helper consults (no fetchImpl in
      // route handlers — Stream's getTranscodeStatus reads `fetch`).
    } as Record<string, unknown>
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchStub
    try {
      insertPending(sqlite, {
        uploadId: 'UP-STREAM-PEND',
        datasetId,
        kind: 'data',
        target: 'stream',
        target_ref: 'stream:abc123',
        mime: 'video/mp4',
        claimed_digest: OTHER_DIGEST,
      })
      const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-STREAM-PEND' }))
      expect(res.status).toBe(202)
      expect((await readJson<{ error: string }>(res)).error).toBe('transcode_in_progress')
      // Row stays pending — caller retries.
      const row = sqlite
        .prepare(`SELECT status FROM asset_uploads WHERE id = ?`)
        .get('UP-STREAM-PEND') as { status: string }
      expect(row.status).toBe('pending')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('marks failed and returns 409 transcode_error when Stream errors', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const fetchStub = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            uid: 'u',
            status: { state: 'error', errorReasonText: 'codec_unsupported' },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      STREAM_ACCOUNT_ID: 'acct',
      STREAM_API_TOKEN: 'tok',
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchStub
    try {
      insertPending(sqlite, {
        uploadId: 'UP-STREAM-ERR',
        datasetId,
        kind: 'data',
        target: 'stream',
        target_ref: 'stream:abc123',
        mime: 'video/mp4',
        claimed_digest: OTHER_DIGEST,
      })
      const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-STREAM-ERR' }))
      expect(res.status).toBe(409)
      expect((await readJson<{ error: string }>(res)).error).toBe('transcode_error')
      const row = sqlite
        .prepare(`SELECT status, failure_reason FROM asset_uploads WHERE id = ?`)
        .get('UP-STREAM-ERR') as { status: string; failure_reason: string }
      expect(row.status).toBe('failed')
      expect(row.failure_reason).toBe('codec_unsupported')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('POST .../asset/{upload_id}/complete — refusals', () => {
  it('returns 404 for an unknown upload id', async () => {
    const { sqlite, datasetId, kv } = setupEnv()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(null),
    }
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-NOPE' }))
    expect(res.status).toBe(404)
  })

  it('returns 404 when the upload belongs to a different dataset', async () => {
    const { sqlite, datasetId, kv } = setupEnv()
    // Seed a second dataset so the FK on asset_uploads.dataset_id
    // resolves; the route should still 404 because the URL path
    // refers to `datasetId` but the upload row points elsewhere.
    const otherId = 'DS999' + 'A'.repeat(21)
    sqlite
      .prepare(
        `INSERT INTO datasets (id, slug, origin_node, title, format, data_ref,
                               weight, visibility, is_hidden, schema_version,
                               created_at, updated_at, publisher_id)
         VALUES (?, ?, 'NODE000', 'Other', 'image/png', '', 0, 'public', 0, 1,
                 '2026-04-29T12:00:00.000Z', '2026-04-29T12:00:00.000Z', ?)`,
      )
      .run(otherId, 'other', STAFF.id)
    insertPending(sqlite, {
      uploadId: 'UP-OTHER',
      datasetId: otherId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: 'r2:foo',
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-OTHER' }))
    expect(res.status).toBe(404)
  })

  it('returns 404 when a community publisher tries to complete a staff-owned upload', async () => {
    const { sqlite, datasetId, kv } = setupEnv()
    insertPending(sqlite, {
      uploadId: 'UP-COMM',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-COMM', publisher: COMMUNITY }))
    // Community can't see the dataset, so the not_found triggers
    // before the upload row is even consulted.
    expect(res.status).toBe(404)
  })

  it('returns 409 digest_mismatch and marks the row failed', async () => {
    const { sqlite, datasetId, kv } = setupEnv()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    insertPending(sqlite, {
      uploadId: 'UP-WRONG',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_OTHER}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: OTHER_DIGEST, // Bytes will hash to HELLO_DIGEST instead
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-WRONG' }))
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string; claimed: string; actual: string }>(res)
    expect(body.error).toBe('digest_mismatch')
    expect(body.claimed).toBe(OTHER_DIGEST)
    expect(body.actual).toBe(HELLO_DIGEST)

    const row = sqlite
      .prepare(`SELECT status, failure_reason FROM asset_uploads WHERE id = ?`)
      .get('UP-WRONG') as { status: string; failure_reason: string }
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('digest_mismatch')
  })

  it('returns 409 asset_missing when R2 has no object at the key', async () => {
    const { sqlite, datasetId, kv } = setupEnv()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(null),
    }
    insertPending(sqlite, {
      uploadId: 'UP-MISS',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-MISS' }))
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('asset_missing')
  })

  it('idempotent on a completed row: returns 200 with the dataset', async () => {
    const { sqlite, datasetId, kv } = setupEnv()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    insertPending(sqlite, {
      uploadId: 'UP-DONE',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    sqlite
      .prepare(`UPDATE asset_uploads SET status = 'completed', completed_at = ? WHERE id = ?`)
      .run('2026-04-29T12:00:00.000Z', 'UP-DONE')
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-DONE' }))
    expect(res.status).toBe(200)
    const body = await readJson<{ idempotent: boolean }>(res)
    expect(body.idempotent).toBe(true)
  })

  it('returns 409 upload_failed when re-called on a failed row', async () => {
    const { sqlite, datasetId, kv } = setupEnv()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    insertPending(sqlite, {
      uploadId: 'UP-FAIL',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    sqlite
      .prepare(
        `UPDATE asset_uploads SET status = 'failed', failure_reason = ?, completed_at = ? WHERE id = ?`,
      )
      .run('digest_mismatch', '2026-04-29T12:00:00.000Z', 'UP-FAIL')
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-FAIL' }))
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('upload_failed')
  })
})

describe('POST .../asset/{upload_id}/complete — MOCK_R2 short-circuit', () => {
  it('trusts the claim and skips bucket read when MOCK_R2=true', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      // No CATALOG_R2 binding — the mock path must not consult it.
      MOCK_R2: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-MOCK',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-MOCK' }))
    expect(res.status).toBe(200)
    const body = await readJson<{ verified_digest: string }>(res)
    expect(body.verified_digest).toBe(HELLO_DIGEST)

    const dataset = sqlite
      .prepare(`SELECT thumbnail_ref, auxiliary_digests FROM datasets WHERE id = ?`)
      .get(datasetId) as { thumbnail_ref: string; auxiliary_digests: string }
    expect(dataset.thumbnail_ref).toContain('thumbnail.png')
    const aux = JSON.parse(dataset.auxiliary_digests) as Record<string, string>
    expect(aux.thumbnail).toBe(HELLO_DIGEST)
  })

  it('refuses MOCK_R2=true on a non-loopback hostname', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_R2: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-MOCK-PROD',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    // Override the request URL hostname so it's not loopback.
    const url = `https://terraviz.example.com/api/v1/publish/datasets/${datasetId}/asset/UP-MOCK-PROD/complete`
    const baseCtx = ctx({ env, datasetId, uploadId: 'UP-MOCK-PROD' })
    const prodCtx = {
      ...baseCtx,
      request: new Request(url, { method: 'POST' }),
    } as Parameters<typeof completeHandler>[0]
    const res = await completeHandler(prodCtx)
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('mock_r2_unsafe')
  })
})

describe('POST .../asset/{upload_id}/complete — sphere thumbnail enqueue', () => {
  it('enqueues a sphere_thumbnail job when a `data` upload completes', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    const queue = new CapturingJobQueue()
    insertPending(sqlite, {
      uploadId: 'UP-DATA',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/asset.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(
      ctx({ env, datasetId, uploadId: 'UP-DATA', jobQueue: queue }),
    )
    expect(res.status).toBe(200)
    expect(queue.records).toHaveLength(1)
    expect(queue.records[0].name).toBe('sphere_thumbnail')
    expect(queue.records[0].payload).toEqual({
      dataset_id: datasetId,
      source_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/asset.png`,
    })
  })

  it('enqueues a sphere_thumbnail job when a `thumbnail` upload completes', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    const queue = new CapturingJobQueue()
    insertPending(sqlite, {
      uploadId: 'UP-THUMB',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(
      ctx({ env, datasetId, uploadId: 'UP-THUMB', jobQueue: queue }),
    )
    expect(res.status).toBe(200)
    expect(queue.records).toHaveLength(1)
    expect(queue.records[0].payload).toMatchObject({ dataset_id: datasetId })
  })

  it('does NOT enqueue for caption / legend / sphere_thumbnail kinds', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    for (const kind of ['caption', 'legend', 'sphere_thumbnail'] as const) {
      const queue = new CapturingJobQueue()
      const uploadId = `UP-${kind}`
      const ext = kind === 'caption' ? 'vtt' : kind === 'sphere_thumbnail' ? 'webp' : 'png'
      const mime =
        kind === 'caption' ? 'text/vtt' : kind === 'sphere_thumbnail' ? 'image/webp' : 'image/png'
      insertPending(sqlite, {
        uploadId,
        datasetId,
        kind,
        target: 'r2',
        target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/${kind}.${ext}`,
        mime,
        claimed_digest: HELLO_DIGEST,
      })
      const res = await completeHandler(ctx({ env, datasetId, uploadId, jobQueue: queue }))
      expect(res.status).toBe(200)
      expect(queue.records).toHaveLength(0)
    }
  })
})
