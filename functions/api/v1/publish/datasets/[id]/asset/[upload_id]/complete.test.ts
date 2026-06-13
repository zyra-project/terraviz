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
  id: 'PUB-PUBLISHER',
  email: 'publisher@example.com',
  display_name: 'Publisher',
  role: 'publisher',
  is_admin: 0,
}

const SHA64_HELLO = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
const HELLO_DIGEST = `sha256:${SHA64_HELLO}`
const SHA64_OTHER = 'a'.repeat(64)
const OTHER_DIGEST = `sha256:${SHA64_OTHER}`

function setupEnv(opts: { datasetPublished?: boolean } = {}) {
  const sqlite = seedFixtures({ count: 1 })
  for (const p of [ADMIN, PUBLISHER]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  const datasetId = 'DS000' + 'A'.repeat(21)
  sqlite.prepare(`UPDATE datasets SET publisher_id = ? WHERE id = ?`).run(ADMIN.id, datasetId)
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
  /** Optional. Defaults to `HELLO_BYTES.byteLength` so the
   *  size-check (added in 3pd-followup/O for video sources)
   *  agrees with the canonical R2 fixture content. Tests that
   *  exercise the size-mismatch failure path override this. */
  declared_size?: number
}

function insertPending(
  sqlite: ReturnType<typeof seedFixtures>,
  opts: PendingUploadOptions & { frame_count?: number | null },
) {
  sqlite
    .prepare(
      `INSERT INTO asset_uploads
        (id, dataset_id, publisher_id, kind, target, target_ref, mime,
         declared_size, claimed_digest, status, failure_reason,
         created_at, completed_at, frame_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`,
    )
    .run(
      opts.uploadId,
      opts.datasetId,
      opts.publisherId ?? ADMIN.id,
      opts.kind,
      opts.target,
      opts.target_ref,
      opts.mime,
      opts.declared_size ?? HELLO_BYTES.byteLength,
      opts.claimed_digest,
      '2026-04-29T12:00:00.000Z',
      opts.frame_count ?? null,
    )
}

function makeBucket(content: ArrayBuffer | null): R2Bucket {
  return {
    get: async (_key: string) => {
      if (!content) return null
      return { arrayBuffer: async () => content } as unknown as R2ObjectBody
    },
    // HEAD-only response — `verifyObjectExists` in r2-store.ts
    // uses this for the video-source path (avoids reading the
    // body, which can be up to 10 GB).
    head: async (_key: string) => {
      if (!content) return null
      return { size: content.byteLength } as unknown as R2Object
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
    data: { publisher: opts.publisher ?? ADMIN, jobQueue },
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
  it('atomically applies the dataset row and marks upload completed', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    insertPending(sqlite, {
      uploadId: 'UP-ATOMIC',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-ATOMIC' }))
    expect(res.status).toBe(200)
    // Both updates landed: dataset row has new ref + upload row is completed.
    const dataset = sqlite
      .prepare(`SELECT thumbnail_ref FROM datasets WHERE id = ?`)
      .get(datasetId) as { thumbnail_ref: string }
    const upload = sqlite
      .prepare(`SELECT status, completed_at FROM asset_uploads WHERE id = ?`)
      .get('UP-ATOMIC') as { status: string; completed_at: string }
    expect(dataset.thumbnail_ref).toContain('thumbnail.png')
    expect(upload.status).toBe('completed')
    expect(typeof upload.completed_at).toBe('string')
  })

  it('flips data_ref + content_digest for an R2 image data upload', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    // Align the dataset's declared format with what this test
    // uploads — the /AZ format-revalidation guard refuses a
    // `data` upload whose mime doesn't match dataset.format.
    sqlite.prepare(`UPDATE datasets SET format = 'image/png' WHERE id = ?`).run(datasetId)
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

  it('returns 409 stream_asset_not_found when Stream returns 404', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10006, message: 'video not found' }] }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
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
        uploadId: 'UP-MISSING',
        datasetId,
        kind: 'data',
        target: 'stream',
        target_ref: 'stream:abc',
        mime: 'video/mp4',
        claimed_digest: OTHER_DIGEST,
      })
      const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-MISSING' }))
      expect(res.status).toBe(409)
      expect((await readJson<{ error: string }>(res)).error).toBe('stream_asset_not_found')
      const row = sqlite
        .prepare(`SELECT status, failure_reason FROM asset_uploads WHERE id = ?`)
        .get('UP-MISSING') as { status: string; failure_reason: string }
      expect(row.status).toBe('failed')
      expect(row.failure_reason).toBe('stream_asset_not_found')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns 502 stream_upstream_error for non-404 Stream API failures', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'rate limit' }] }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
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
        uploadId: 'UP-RATE',
        datasetId,
        kind: 'data',
        target: 'stream',
        target_ref: 'stream:abc',
        mime: 'video/mp4',
        claimed_digest: OTHER_DIGEST,
      })
      const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-RATE' }))
      expect(res.status).toBe(502)
      expect((await readJson<{ error: string }>(res)).error).toBe('stream_upstream_error')
      // Row stays pending — caller can retry.
      const row = sqlite
        .prepare(`SELECT status FROM asset_uploads WHERE id = ?`)
        .get('UP-RATE') as { status: string }
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
      const body = await readJson<{ error: string; message: string }>(res)
      expect(body.error).toBe('transcode_error')
      // The verbose Stream-side reason text flows through the API
      // response message …
      expect(body.message).toContain('codec_unsupported')
      // … but `failure_reason` on the row stays a stable machine-
      // readable code so audit / retry logic can branch on it.
      const row = sqlite
        .prepare(`SELECT status, failure_reason FROM asset_uploads WHERE id = ?`)
        .get('UP-STREAM-ERR') as { status: string; failure_reason: string }
      expect(row.status).toBe('failed')
      expect(row.failure_reason).toBe('transcode_error')
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
      .run(otherId, 'other', ADMIN.id)
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

  it('returns 404 when a publisher-role account tries to complete an admin-owned upload', async () => {
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
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-COMM', publisher: PUBLISHER }))
    // Publisher can't see the dataset, so the not_found triggers
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

  it('idempotent path re-reads the dataset so background mutations are reflected', async () => {
    const { sqlite, datasetId, kv } = setupEnv()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    insertPending(sqlite, {
      uploadId: 'UP-IDEMP',
      datasetId,
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64_HELLO}/thumbnail.png`,
      mime: 'image/png',
      claimed_digest: HELLO_DIGEST,
    })
    sqlite
      .prepare(`UPDATE asset_uploads SET status = 'completed', completed_at = ? WHERE id = ?`)
      .run('2026-04-29T12:00:00.000Z', 'UP-IDEMP')
    // Simulate a background mutation that landed AFTER the original
    // /complete returned: a sphere-thumbnail job stamped a new
    // sphere_thumbnail_ref. The second /complete call must reflect it.
    sqlite
      .prepare(
        `UPDATE datasets SET sphere_thumbnail_ref = ?, updated_at = ? WHERE id = ?`,
      )
      .run('r2:datasets/x/sphere-thumbnail.jpg', '2026-04-29T12:05:00.000Z', datasetId)
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-IDEMP' }))
    expect(res.status).toBe(200)
    const body = await readJson<{
      idempotent: boolean
      dataset: { sphere_thumbnail_ref: string }
    }>(res)
    expect(body.idempotent).toBe(true)
    expect(body.dataset.sphere_thumbnail_ref).toBe('r2:datasets/x/sphere-thumbnail.jpg')
  })

  it('idempotent retry reports transcoding state for a still-transcoding video upload', async () => {
    // PR #112 Copilot followup: when /complete is retried for a
    // video upload whose row already says status='completed' but
    // the GHA workflow hasn't fired /transcode-complete yet, the
    // idempotent branch must report `transcoding: true` so the
    // asset-uploader UI routes through the 'done-transcoding'
    // stage instead of 'done-direct'. Without this the form
    // would mis-paint as a finished direct upload and clear the
    // "Transcoding…" badge prematurely.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    const uploadId = `UP-VID-${'X'.repeat(20)}`
    insertPending(sqlite, {
      uploadId,
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${uploadId}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })
    // Mirror the steady state the first /complete leaves behind:
    // upload row completed + dataset row stamped transcoding.
    sqlite
      .prepare(`UPDATE asset_uploads SET status = 'completed', completed_at = ? WHERE id = ?`)
      .run('2026-04-29T12:00:00.000Z', uploadId)
    sqlite
      .prepare(
        `UPDATE datasets
           SET transcoding = 1, active_transcode_upload_id = ?, source_digest = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(uploadId, HELLO_DIGEST, '2026-04-29T12:00:00.000Z', datasetId)

    const res = await completeHandler(ctx({ env, datasetId, uploadId }))
    expect(res.status).toBe(200)
    const body = await readJson<{
      idempotent: boolean
      transcoding: boolean
      dataset: { transcoding: number | null }
    }>(res)
    expect(body.idempotent).toBe(true)
    expect(body.transcoding).toBe(true)
    expect(body.dataset.transcoding).toBe(1)
  })

  it('idempotent retry reports transcoding=false once the workflow has cleared the row', async () => {
    // Companion to the test above: after /transcode-complete
    // runs, the dataset row's transcoding column is NULL/0 and
    // data_ref points at the master.m3u8. A /complete retry now
    // should report `transcoding: false` so the uploader knows
    // the bundle is live and routes to the 'done-direct' stage
    // (or whatever the parent treats as "finished"). The strict
    // boolean — not `undefined` — keeps the client's
    // `=== true` check consistent across response shapes.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    const uploadId = `UP-VID-${'Y'.repeat(20)}`
    insertPending(sqlite, {
      uploadId,
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${uploadId}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })
    sqlite
      .prepare(`UPDATE asset_uploads SET status = 'completed', completed_at = ? WHERE id = ?`)
      .run('2026-04-29T12:00:00.000Z', uploadId)
    // Workflow already completed: transcoding cleared, data_ref
    // updated to point at the HLS bundle.
    sqlite
      .prepare(
        `UPDATE datasets
           SET transcoding = NULL,
               active_transcode_upload_id = NULL,
               data_ref = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .run(
        `r2:videos/${datasetId}/${uploadId}/master.m3u8`,
        '2026-04-29T12:30:00.000Z',
        datasetId,
      )

    const res = await completeHandler(ctx({ env, datasetId, uploadId }))
    expect(res.status).toBe(200)
    const body = await readJson<{ idempotent: boolean; transcoding: boolean }>(res)
    expect(body.idempotent).toBe(true)
    expect(body.transcoding).toBe(false)
  })

  it('retries on a stamped-but-pending row by re-dispatching (no false recovery)', async () => {
    // PR #112 followup: an earlier `alreadyStamped` recovery
    // branch short-circuited a retry of /complete when the row
    // was already `transcoding=1 + active=this upload`,
    // marking the upload completed without re-dispatching.
    // Copilot pointed out the failure mode that branch couldn't
    // distinguish: the exact same row state can be produced by
    // "stamp succeeded, dispatch failed, revert ALSO failed" —
    // in which case there's no workflow running and the
    // shortcut would permanently strand the row. Without a
    // durable "dispatch succeeded" marker the row state is
    // ambiguous, so the recovery branch is gone and the retry
    // path falls through to a fresh stamp + dispatch. The
    // workflow is idempotent (deterministic ffmpeg keyed on
    // source bytes + upload_id), so a duplicate run is bounded
    // cost; a stranded row is not.
    //
    // The fixture has no GITHUB_TOKEN, so a fall-through to
    // dispatch 503s. The 503 is the proof point that the route
    // attempted to re-dispatch (the desired behavior) rather
    // than recovering with a false "marked completed" via the
    // removed shortcut.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
      // No GITHUB_TOKEN — re-dispatch will 503.
    }
    const uploadId = 'Z'.repeat(26)
    insertPending(sqlite, {
      uploadId,
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${uploadId}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })
    sqlite
      .prepare(
        `UPDATE datasets
           SET transcoding = 1, active_transcode_upload_id = ?, source_digest = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(uploadId, HELLO_DIGEST, '2026-04-29T12:00:00.000Z', datasetId)

    const res = await completeHandler(ctx({ env, datasetId, uploadId }))
    // The route did NOT short-circuit with `recovered: true`.
    // It re-stamped (a no-op on the same upload), attempted
    // dispatch, and 503d on missing GitHub config.
    expect(res.status).toBe(503)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('github_dispatch_unconfigured')
    // Upload row stays pending — no false-completed marking.
    const row = sqlite
      .prepare(`SELECT status FROM asset_uploads WHERE id = ?`)
      .get(uploadId) as { status: string }
    expect(row.status).toBe('pending')
  })

  it('does NOT recover via a planted data_ref alone (attack vector closed)', async () => {
    // PR #112 followup — the earlier `alreadyCompleted`
    // recovery branch matched any `transcoding=NULL +
    // data_ref === r2:videos/{datasetId}/{uploadId}/master.m3u8`
    // row, including data_refs the publisher planted via the
    // generic dataset PUT path before transcoding=1 was stamped
    // (AE's mutation guard only fires on transcoding rows).
    // The attack:
    //   1. mint upload via /asset
    //   2. plant data_ref = r2:videos/{id}/{uploadId}/master.m3u8
    //      via PUT /datasets/{id} (transcoding still NULL, so no
    //      guard rejects)
    //   3. call /complete: alreadyCompleted matches, upload
    //      marked completed without ever dispatching
    // The branch is now gone — only the alreadyStamped path
    // (transcoding=1 + active=uploadId, a state the publisher
    // can't forge via PUT) recovers without dispatching.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
      // No GITHUB_TOKEN — a fall-through to dispatch would 503.
      // The 503 + still-pending upload row proves the attack
      // was rejected (no recovery, no upload marked completed).
    }
    const uploadId = 'W'.repeat(26)
    insertPending(sqlite, {
      uploadId,
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${uploadId}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })
    // Plant the predicted master.m3u8 data_ref without ever
    // running the workflow. transcoding stays NULL.
    sqlite
      .prepare(`UPDATE datasets SET data_ref = ? WHERE id = ?`)
      .run(`r2:videos/${datasetId}/${uploadId}/master.m3u8`, datasetId)

    const res = await completeHandler(ctx({ env, datasetId, uploadId }))
    // Falls through to the normal stamp+dispatch flow, then
    // 503s on the absent GitHub config. The upload row stays
    // pending — no false-recovery marking.
    expect(res.status).toBe(503)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('github_dispatch_unconfigured')
    const row = sqlite
      .prepare(`SELECT status FROM asset_uploads WHERE id = ?`)
      .get(uploadId) as { status: string }
    expect(row.status).toBe('pending')
  })

  it('returns 409 when the dataset format was changed between mint and complete', async () => {
    // PR #112 followup — closes the gap where a publisher mints
    // a video/mp4 upload, PUTs the dataset's format to image/png
    // before /complete (allowed because the row isn't yet
    // `transcoding=1`, so /AE's format guard doesn't fire), then
    // calls /complete. Without this re-check the route would
    // dispatch a video transcode that eventually writes an HLS
    // data_ref into a row that now declares image format.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
      MOCK_GITHUB_DISPATCH: 'true',
    }
    const uploadId = 'Y'.repeat(26)
    insertPending(sqlite, {
      uploadId,
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${uploadId}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })
    // Publisher mutated format BETWEEN mint and complete.
    sqlite.prepare(`UPDATE datasets SET format = 'image/png' WHERE id = ?`).run(datasetId)

    const res = await completeHandler(ctx({ env, datasetId, uploadId }))
    expect(res.status).toBe(409)
    const body = await readJson<{ errors: Array<{ field: string; code: string }> }>(res)
    expect(body.errors[0]).toMatchObject({
      field: 'format',
      code: 'mime_format_mismatch',
    })
    // The dataset row wasn't stamped — we caught the mismatch
    // before the stamp/dispatch step.
    const row = sqlite
      .prepare(`SELECT transcoding, data_ref FROM datasets WHERE id = ?`)
      .get(datasetId) as { transcoding: number | null; data_ref: string }
    expect(row.transcoding).toBeNull()
    // The upload row stays pending — operator can mint a fresh
    // upload (matching the new format) without the prior one
    // appearing "completed" in the audit trail.
    const upload = sqlite
      .prepare(`SELECT status FROM asset_uploads WHERE id = ?`)
      .get(uploadId) as { status: string }
    expect(upload.status).toBe('pending')
  })

  it('fails closed with 500 unknown_target when upload.target is corrupted', async () => {
    const { sqlite, datasetId, kv } = setupEnv()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
    }
    // Manually insert an upload row with an unknown target — the
    // init handler would never write this, but a corrupted /
    // tampered row must not silently apply.
    sqlite
      .prepare(
        `INSERT INTO asset_uploads
          (id, dataset_id, publisher_id, kind, target, target_ref, mime,
           declared_size, claimed_digest, status, failure_reason,
           created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run(
        'UP-WEIRD',
        datasetId,
        ADMIN.id,
        'thumbnail',
        'gcs', // unknown target
        'gcs:foo',
        'image/png',
        1234,
        HELLO_DIGEST,
        '2026-04-29T12:00:00.000Z',
      )
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-WEIRD' }))
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('unknown_target')
    // Row marked failed, dataset row untouched.
    const row = sqlite
      .prepare(`SELECT status, failure_reason FROM asset_uploads WHERE id = ?`)
      .get('UP-WEIRD') as { status: string; failure_reason: string }
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('unknown_target')
    // Dataset row's thumbnail_ref is unchanged (the fixture seeds a
    // placeholder value; the assertion is "didn't get clobbered with
    // the corrupt upload's target_ref").
    const dataset = sqlite
      .prepare(`SELECT thumbnail_ref FROM datasets WHERE id = ?`)
      .get(datasetId) as { thumbnail_ref: string | null }
    expect(dataset.thumbnail_ref).not.toBe('gcs:foo')
    expect(dataset.thumbnail_ref).not.toContain('by-digest')
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

  it('refuses MOCK_STREAM=true on a non-loopback hostname', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_STREAM: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-MOCK-STREAM-PROD',
      datasetId,
      kind: 'data',
      target: 'stream',
      target_ref: 'stream:abc',
      mime: 'video/mp4',
      claimed_digest: OTHER_DIGEST,
    })
    const url = `https://terraviz.example.com/api/v1/publish/datasets/${datasetId}/asset/UP-MOCK-STREAM-PROD/complete`
    const baseCtx = ctx({ env, datasetId, uploadId: 'UP-MOCK-STREAM-PROD' })
    const prodCtx = {
      ...baseCtx,
      request: new Request(url, { method: 'POST' }),
    } as Parameters<typeof completeHandler>[0]
    const res = await completeHandler(prodCtx)
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('mock_stream_unsafe')
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
    // Match fixture format to upload mime — see /AZ test note
    // above re: the format-revalidation guard at /complete.
    sqlite.prepare(`UPDATE datasets SET format = 'image/png' WHERE id = ?`).run(datasetId)
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

describe('POST .../asset/{upload_id}/complete — video transcode dispatch (3pd)', () => {
  it('on a draft, stamps transcoding=1, clears data_ref, returns 202', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      // Loopback host on the request URL so the mock-r2 short-circuit
      // is allowed (digest trusts the claim; no real bucket needed).
      MOCK_R2: 'true',
      MOCK_GITHUB_DISPATCH: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-VIDEO',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })

    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-VIDEO' }))

    // 202 because the transcode is still in flight — the row isn't
    // "ready" yet, even though the upload bytes are. data_ref stays
    // empty until the GHA workflow PATCHes it back; the publisher's
    // detail page surfaces a "Transcoding…" badge in the meantime.
    expect(res.status).toBe(202)
    const body = await readJson<{
      dataset: { data_ref: string; transcoding: number | null; source_digest: string }
      transcoding: boolean
    }>(res)
    expect(body.transcoding).toBe(true)
    expect(body.dataset.data_ref).toBe('')
    expect(body.dataset.transcoding).toBe(1)
    // source_digest carries the claim so the workflow can re-verify
    // before kicking off ffmpeg.
    expect(body.dataset.source_digest).toBe(HELLO_DIGEST)

    // Persisted state matches the response.
    const row = sqlite
      .prepare(`SELECT data_ref, transcoding, source_digest FROM datasets WHERE id = ?`)
      .get(datasetId) as { data_ref: string; transcoding: number; source_digest: string }
    expect(row.data_ref).toBe('')
    expect(row.transcoding).toBe(1)
    expect(row.source_digest).toBe(HELLO_DIGEST)

    // The asset_uploads row is marked completed — the upload step
    // itself succeeded; the transcode is a separate, async concern.
    const upload = sqlite
      .prepare(`SELECT status, completed_at FROM asset_uploads WHERE id = ?`)
      .get('UP-VIDEO') as { status: string; completed_at: string }
    expect(upload.status).toBe('completed')
    expect(typeof upload.completed_at).toBe('string')
  })

  it('verifies via HEAD (not arrayBuffer) when the source is a video upload', async () => {
    // The arrayBuffer-based digest recompute would blow the
    // Workers 128 MB memory cap on a real video upload (cap is
    // 10 GB). Phase 3pd review fix: the /complete handler does
    // a HEAD-style existence check on the source key and trusts
    // the publisher's claimed digest. The transcode runner
    // re-hashes the bytes via Node's streaming
    // crypto.createHash before encoding, so a tampered upload
    // surfaces there.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      // Real R2 binding (no MOCK_R2) so the verify path is
      // exercised end-to-end. The bucket returns HEAD-only —
      // get() never gets called on the video-source branch.
      CATALOG_R2: makeBucket(new ArrayBuffer(8)), // size=8, irrelevant content
      MOCK_GITHUB_DISPATCH: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-VIDEO-HEAD',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
      // Bucket fixture is an 8-byte ArrayBuffer — match
      // declared_size so the truncation guard
      // (3pd-followup/O) doesn't reject this case.
      declared_size: 8,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-VIDEO-HEAD' }))
    expect(res.status).toBe(202)
  })

  it('returns 409 size_mismatch when the HEAD size differs from declared_size', async () => {
    // PR #112 Copilot followup (complete.ts:216): a connection-
    // dropped PUT that lands a partial source.mp4 in R2 would
    // previously pass the existence check, stamp the row as
    // transcoding, fire the GHA dispatch, and only fail in the
    // runner's streaming digest recompute — leaving the row
    // stuck `transcoding=1` until operator cleanup. The
    // truncation guard catches the mismatch up front and the
    // upload row is marked `failed` with `size_mismatch` so the
    // publisher can mint a fresh upload.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      // Bucket holds 8 bytes; declared_size below is 100. The
      // size check should surface that as 409 size_mismatch.
      CATALOG_R2: makeBucket(new ArrayBuffer(8)),
      MOCK_GITHUB_DISPATCH: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-VIDEO-TRUNC',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
      declared_size: 100,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-VIDEO-TRUNC' }))
    expect(res.status).toBe(409)
    const body = await readJson<{
      error: string
      declared: number
      actual: number
    }>(res)
    expect(body.error).toBe('size_mismatch')
    expect(body.declared).toBe(100)
    expect(body.actual).toBe(8)
    // The upload row is marked failed so a retry can't paper
    // over a truncated PUT.
    const row = sqlite
      .prepare(`SELECT status, failure_reason FROM asset_uploads WHERE id = ?`)
      .get('UP-VIDEO-TRUNC') as { status: string; failure_reason: string }
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toBe('size_mismatch')
    // The dataset row was NOT stamped — we caught the truncation
    // before reaching the stamp/dispatch step.
    const dsRow = sqlite
      .prepare(`SELECT transcoding FROM datasets WHERE id = ?`)
      .get(datasetId) as { transcoding: number | null }
    expect(dsRow.transcoding).toBeNull()
  })

  it('returns 409 asset_missing when the source object is absent from R2', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(null), // HEAD returns null → missing
      MOCK_GITHUB_DISPATCH: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-VIDEO-MISS',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-VIDEO-MISS' }))
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('asset_missing')
  })

  it('on a published row, preserves the existing data_ref while transcoding=1 (fix #2)', async () => {
    // Published rows must keep serving their existing HLS bundle
    // until the workflow completes — clearing data_ref would
    // break public playback the moment the upload finalises.
    // Phase 3pd review fix.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const existingDataRef = `r2:videos/${datasetId}/PRIOR-UPLOAD/master.m3u8`
    sqlite
      .prepare(`UPDATE datasets SET data_ref = ? WHERE id = ?`)
      .run(existingDataRef, datasetId)
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_R2: 'true',
      MOCK_GITHUB_DISPATCH: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-PUB',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })

    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-PUB' }))
    expect(res.status).toBe(202)

    const row = sqlite
      .prepare(`SELECT data_ref, transcoding FROM datasets WHERE id = ?`)
      .get(datasetId) as { data_ref: string; transcoding: number }
    // data_ref kept pointing at the prior bundle so public manifest
    // resolution keeps working through the transcode window.
    expect(row.data_ref).toBe(existingDataRef)
    expect(row.transcoding).toBe(1)
  })

  it('reverts the transcoding stamp when dispatch fails after persist (fix #9)', async () => {
    // Persist-before-dispatch ordering: when the dispatch step
    // throws after we've already stamped transcoding=1, the
    // handler runs a compensating UPDATE so the row goes back
    // to its prior state — otherwise the publisher would see a
    // stuck "Transcoding…" badge with no workflow actually
    // running.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: true })
    const priorDataRef = `r2:videos/${datasetId}/PRIOR/master.m3u8`
    sqlite
      .prepare(`UPDATE datasets SET data_ref = ? WHERE id = ?`)
      .run(priorDataRef, datasetId)
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_R2: 'true',
      // No GitHub config + no mock → dispatchTranscode throws
      // ConfigurationError. The handler maps that to 503 and
      // runs the compensating revert.
    }
    insertPending(sqlite, {
      uploadId: 'UP-VIDEO-FAIL',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-VIDEO-FAIL' }))
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe(
      'github_dispatch_unconfigured',
    )

    // The row reverted to its prior state — transcoding NULL,
    // data_ref restored, source_digest cleared.
    const row = sqlite
      .prepare(
        `SELECT data_ref, transcoding, source_digest FROM datasets WHERE id = ?`,
      )
      .get(datasetId) as {
      data_ref: string
      transcoding: number | null
      source_digest: string | null
    }
    expect(row.transcoding).toBeNull()
    expect(row.data_ref).toBe(priorDataRef)
    expect(row.source_digest).toBeNull()

    // The asset_upload row stayed `pending` so the publisher
    // can retry /complete after the operator fixes the config.
    const upload = sqlite
      .prepare(`SELECT status FROM asset_uploads WHERE id = ?`)
      .get('UP-VIDEO-FAIL') as { status: string }
    expect(upload.status).toBe('pending')
  })

  it('returns 503 github_dispatch_unconfigured when neither real config nor mock is set', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_R2: 'true',
      // Intentionally no MOCK_GITHUB_DISPATCH, no GITHUB_OWNER/REPO/TOKEN.
    }
    insertPending(sqlite, {
      uploadId: 'UP-VIDEO-503',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })

    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-VIDEO-503' }))
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('github_dispatch_unconfigured')

    // Critical: the dataset row is NOT modified on dispatch failure,
    // and the upload row stays `pending` so the publisher can retry
    // `/complete` after the operator fixes the GitHub config. Without
    // this, a misconfigured deploy would burn the upload window and
    // force a fresh upload mint.
    const row = sqlite
      .prepare(`SELECT data_ref, transcoding FROM datasets WHERE id = ?`)
      .get(datasetId) as { data_ref: string | null; transcoding: number | null }
    expect(row.transcoding).toBeNull()
    const upload = sqlite
      .prepare(`SELECT status FROM asset_uploads WHERE id = ?`)
      .get('UP-VIDEO-503') as { status: string }
    expect(upload.status).toBe('pending')
  })

  it('returns 409 transcoding_in_progress when the row already owns a different active upload', async () => {
    // Migration 0012 — refusing the second dispatch is the
    // server-side counterpart to the dataset-form edit-mode
    // gate. Without it, two overlapping /complete calls would
    // both stamp transcoding=1 and fire two parallel GHA
    // workflows that race their /transcode-complete callbacks.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    // Pre-stamp the row as if a prior upload (UP-PRIOR) already
    // dispatched its workflow.
    sqlite
      .prepare(
        `UPDATE datasets
           SET transcoding = 1,
               active_transcode_upload_id = 'UP-PRIOR',
               source_digest = ?
         WHERE id = ?`,
      )
      .run(HELLO_DIGEST, datasetId)
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_R2: 'true',
      MOCK_GITHUB_DISPATCH: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-OVERLAP',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-OVERLAP' }))
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string; message: string }>(res)
    expect(body.error).toBe('transcoding_in_progress')
    expect(body.message).toContain('UP-PRIOR')
    // The blocking row's binding is unchanged — the second
    // upload's /complete call doesn't get to overwrite it.
    const row = sqlite
      .prepare(`SELECT active_transcode_upload_id FROM datasets WHERE id = ?`)
      .get(datasetId) as { active_transcode_upload_id: string }
    expect(row.active_transcode_upload_id).toBe('UP-PRIOR')
    // The newer upload row stays pending so a retry (after the
    // prior workflow finishes or an operator clears the row)
    // can complete cleanly.
    const upload = sqlite
      .prepare(`SELECT status FROM asset_uploads WHERE id = ?`)
      .get('UP-OVERLAP') as { status: string }
    expect(upload.status).toBe('pending')
  })

  it('returns 409 transcoding_in_progress on a corrupted transcoding=1 + NULL active row', async () => {
    // PR #112 followup — the earlier overlap guard only
    // rejected when `active_transcode_upload_id` was populated.
    // A row stamped before migration 0012 (or left in this
    // shape by a partial manual edit) would fall through the
    // guard, the new upload would re-stamp, and a second
    // workflow could run alongside whatever workflow left the
    // row stuck. The corrupted-state path now refuses with the
    // same envelope but a clearer operator-action message.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    sqlite
      .prepare(
        `UPDATE datasets
           SET transcoding = 1,
               active_transcode_upload_id = NULL,
               source_digest = ?
         WHERE id = ?`,
      )
      .run(HELLO_DIGEST, datasetId)
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_R2: 'true',
      MOCK_GITHUB_DISPATCH: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-STUCK-RECOVERY',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-STUCK-RECOVERY' }))
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string; message: string }>(res)
    expect(body.error).toBe('transcoding_in_progress')
    // Message explicitly cites the corrupted state + operator-
    // action SQL so the publisher knows this is operator
    // territory, not just "wait a bit."
    expect(body.message).toContain('inconsistent state')
    expect(body.message).toContain('UPDATE datasets')
    // The corrupted row is untouched — no second stamp landed.
    const row = sqlite
      .prepare(`SELECT transcoding, active_transcode_upload_id FROM datasets WHERE id = ?`)
      .get(datasetId) as { transcoding: number | null; active_transcode_upload_id: string | null }
    expect(row.transcoding).toBe(1)
    expect(row.active_transcode_upload_id).toBeNull()
  })

  it('binds active_transcode_upload_id to the upload id when stamping transcoding', async () => {
    // The /transcode-complete handler verifies the callback's
    // upload_id matches `datasets.active_transcode_upload_id`,
    // so this stamp is what makes the per-upload guard work.
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_R2: 'true',
      MOCK_GITHUB_DISPATCH: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-BIND',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })
    const res = await completeHandler(ctx({ env, datasetId, uploadId: 'UP-BIND' }))
    expect(res.status).toBe(202)
    const row = sqlite
      .prepare(`SELECT transcoding, active_transcode_upload_id FROM datasets WHERE id = ?`)
      .get(datasetId) as {
      transcoding: number
      active_transcode_upload_id: string
    }
    expect(row.transcoding).toBe(1)
    expect(row.active_transcode_upload_id).toBe('UP-BIND')
  })

  it('refuses MOCK_GITHUB_DISPATCH=true on a non-loopback hostname', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    // Don't enable MOCK_R2 — it has its own non-loopback refusal
    // that would fire before the github-dispatch check we want to
    // exercise here. Use a real R2 binding instead so digest
    // verification passes on the real path.
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(HELLO_BYTES.buffer as ArrayBuffer),
      MOCK_GITHUB_DISPATCH: 'true',
    }
    insertPending(sqlite, {
      uploadId: 'UP-VIDEO-PROD',
      datasetId,
      kind: 'data',
      target: 'r2',
      target_ref: `r2:uploads/${datasetId}/${'X'.repeat(26)}/source.mp4`,
      mime: 'video/mp4',
      claimed_digest: HELLO_DIGEST,
    })

    // Hit the handler with a production-hostname URL to trigger the
    // mock-on-non-loopback refusal. Same defense-in-depth pattern as
    // MOCK_R2 / MOCK_STREAM.
    const baseCtx = ctx({ env, datasetId, uploadId: 'UP-VIDEO-PROD' })
    const prodCtx = {
      ...baseCtx,
      request: new Request(
        `https://terraviz.example.com/api/v1/publish/datasets/${datasetId}/asset/UP-VIDEO-PROD/complete`,
        { method: 'POST' },
      ),
    } as typeof baseCtx
    const res = await completeHandler(prodCtx)
    expect(res.status).toBe(500)
    expect((await readJson<{ error: string }>(res)).error).toBe('mock_github_dispatch_unsafe')
  })
})

describe('POST .../asset/{upload_id}/complete — image-sequence dispatch (3pf)', () => {
  // Frame-source uploads use a single asset_uploads row with
  // `frame_count = N`; the route branches on that non-NULL value
  // to take the multi-key HEAD + frames dispatch path. The
  // upload's `claimed_digest` is the SHA-256 of the canonical
  // source-filenames JSON (not the frames themselves) — same
  // shape the runner re-verifies.
  const UPLOAD_ID = '01HZAAAAAAAAAAAAAAAAAAAAAA'
  const SOURCE_FILENAMES_DIGEST = `sha256:${'f'.repeat(64)}`

  function seedFrameUpload(
    sqlite: ReturnType<typeof seedFixtures>,
    datasetId: string,
    frameCount: number,
    mime = 'image/png',
  ) {
    insertPending(sqlite, {
      uploadId: UPLOAD_ID,
      datasetId,
      kind: 'data',
      target: 'r2',
      // The prefix-shaped target_ref matches what /asset writes.
      // /complete reads `frame_count` + `mime` and rebuilds the
      // per-frame keys via `buildFrameKey`, so the target_ref is
      // informational rather than load-bearing on the read path.
      target_ref: `r2:uploads/${datasetId}/${UPLOAD_ID}/frames/`,
      mime,
      declared_size: frameCount * 4_000_000,
      claimed_digest: SOURCE_FILENAMES_DIGEST,
      frame_count: frameCount,
    })
  }

  it('stamps transcoding=1, populates frame metadata, fires frames dispatch, returns 202', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      // MOCK_R2 short-circuits the HEAD-every-frame loop — no
      // real bytes have been uploaded to the mock-r2.localhost
      // PUT URLs, so the HEAD checks would 404. Trust matches
      // the same bargain the MP4 path makes in mock mode.
      MOCK_R2: 'true',
      MOCK_GITHUB_DISPATCH: 'true',
    }
    seedFrameUpload(sqlite, datasetId, 3)

    const res = await completeHandler(ctx({ env, datasetId, uploadId: UPLOAD_ID }))
    expect(res.status).toBe(202)
    const body = await readJson<{ transcoding: boolean; verified_digest: string }>(res)
    expect(body.transcoding).toBe(true)
    expect(body.verified_digest).toBe(SOURCE_FILENAMES_DIGEST)

    const row = sqlite
      .prepare(
        `SELECT transcoding, active_transcode_upload_id, frame_count,
                frame_extension, frame_source_filenames_ref
         FROM datasets WHERE id = ?`,
      )
      .get(datasetId) as {
      transcoding: number | null
      active_transcode_upload_id: string | null
      frame_count: number | null
      frame_extension: string | null
      frame_source_filenames_ref: string | null
    }
    expect(row.transcoding).toBe(1)
    expect(row.active_transcode_upload_id).toBe(UPLOAD_ID)
    expect(row.frame_count).toBe(3)
    // Extension comes from extForMime — `png` for image/png,
    // `jpg` for image/jpeg, `webp` for image/webp. Matches the
    // R2 key the /asset PUT lands at.
    expect(row.frame_extension).toBe('png')
    expect(row.frame_source_filenames_ref).toMatch(/\/source_filenames\.json$/)
  })

  it('returns 409 frames_require_video_format when the row format changed between mint and complete', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_R2: 'true',
      MOCK_GITHUB_DISPATCH: 'true',
    }
    seedFrameUpload(sqlite, datasetId, 3)
    // Simulate a format-mutation between /asset and /complete.
    sqlite.prepare(`UPDATE datasets SET format = 'image/png' WHERE id = ?`).run(datasetId)

    const res = await completeHandler(ctx({ env, datasetId, uploadId: UPLOAD_ID }))
    expect(res.status).toBe(409)
    const body = await readJson<{ errors: Array<{ code: string }> }>(res)
    expect(body.errors[0].code).toBe('frames_require_video_format')
  })

  it('returns 409 transcoding_in_progress when another upload owns the row', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_R2: 'true',
      MOCK_GITHUB_DISPATCH: 'true',
    }
    seedFrameUpload(sqlite, datasetId, 3)
    sqlite
      .prepare(
        `UPDATE datasets SET transcoding = 1, active_transcode_upload_id = 'OTHER' WHERE id = ?`,
      )
      .run(datasetId)

    const res = await completeHandler(ctx({ env, datasetId, uploadId: UPLOAD_ID }))
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('transcoding_in_progress')
  })

  it('returns 409 asset_missing when one of the frame keys is not present in R2', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    // No MOCK_R2 — real R2 binding that we control. Bucket
    // returns null on every head() so the first frame's HEAD
    // fails and the route surfaces 409.
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      CATALOG_R2: makeBucket(null),
      MOCK_GITHUB_DISPATCH: 'true',
    }
    seedFrameUpload(sqlite, datasetId, 3)

    const res = await completeHandler(ctx({ env, datasetId, uploadId: UPLOAD_ID }))
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('asset_missing')
    // The asset_uploads row is now marked failed so a retry mints
    // a fresh upload rather than re-running this one.
    const status = sqlite
      .prepare(`SELECT status, failure_reason FROM asset_uploads WHERE id = ?`)
      .get(UPLOAD_ID) as { status: string; failure_reason: string }
    expect(status.status).toBe('failed')
    expect(status.failure_reason).toBe('asset_missing')
  })

  it('idempotent retry on a completed frame-source upload returns 200 with transcoding=true', async () => {
    const { sqlite, datasetId, kv } = setupEnv({ datasetPublished: false })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: kv,
      MOCK_R2: 'true',
      MOCK_GITHUB_DISPATCH: 'true',
    }
    seedFrameUpload(sqlite, datasetId, 3)
    // First call stamps + dispatches + marks completed.
    const first = await completeHandler(ctx({ env, datasetId, uploadId: UPLOAD_ID }))
    expect(first.status).toBe(202)
    // Second call hits the shared idempotent-retry branch ABOVE
    // the frames-source fork (status === 'completed' is checked
    // first). Should return 200 with transcoding: true because
    // the row is still mid-workflow.
    const second = await completeHandler(ctx({ env, datasetId, uploadId: UPLOAD_ID }))
    expect(second.status).toBe(200)
    const body = await readJson<{ idempotent: boolean; transcoding: boolean }>(second)
    expect(body.idempotent).toBe(true)
    expect(body.transcoding).toBe(true)
  })
})
