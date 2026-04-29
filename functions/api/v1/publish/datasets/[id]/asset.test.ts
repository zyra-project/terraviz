/**
 * Wire-level tests for `POST /api/v1/publish/datasets/{id}/asset`.
 *
 * Coverage:
 *   - 201 + the right response envelope for video data (Stream)
 *     and image / caption / sphere-thumbnail uploads (R2).
 *   - The asset_uploads row lands with status='pending', the
 *     correct target / target_ref / claimed_digest, and is
 *     associated with the calling publisher.
 *   - 404 when the dataset id is not visible to the caller.
 *   - 400 for malformed JSON, non-object bodies, and the per-field
 *     validation paths from `asset-uploads.ts`.
 *   - 503 stream_unconfigured / r2_unconfigured surface the helper
 *     error message when neither real credentials nor the mock flag
 *     are set.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost as assetInit } from './asset'
import { asD1, makeKV, seedFixtures } from '../../../_lib/test-helpers'
import type { PublisherRow } from '../../../_lib/publisher-store'

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

const SHA64 = 'a'.repeat(64)
const HAPPY_DIGEST = `sha256:${SHA64}`

function setupEnv(extra: Record<string, unknown> = {}) {
  const sqlite = seedFixtures({ count: 1 })
  // Seed both publishers + attribute the seeded dataset to STAFF.
  for (const p of [STAFF, COMMUNITY]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  // The fixture inserts DS000A...A; mark it as STAFF's.
  const datasetId = 'DS000' + 'A'.repeat(21)
  sqlite.prepare(`UPDATE datasets SET publisher_id = ? WHERE id = ?`).run(STAFF.id, datasetId)
  return {
    sqlite,
    datasetId,
    env: {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      MOCK_R2: 'true',
      MOCK_STREAM: 'true',
      ...extra,
    },
  }
}

function ctx(opts: {
  env: Record<string, unknown>
  publisher?: PublisherRow
  body?: unknown
  bodyText?: string
  datasetId: string
}) {
  const url = `https://localhost/api/v1/publish/datasets/${opts.datasetId}/asset`
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const init: RequestInit = { method: 'POST', headers }
  if (opts.bodyText !== undefined) {
    init.body = opts.bodyText
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body)
  }
  return {
    request: new Request(url, init),
    env: opts.env,
    params: { id: opts.datasetId },
    data: { publisher: opts.publisher ?? STAFF },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof assetInit>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('POST /api/v1/publish/datasets/{id}/asset — happy paths', () => {
  it('routes a video data upload to Stream and persists a pending row', async () => {
    const { env, sqlite, datasetId } = setupEnv()
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        body: {
          kind: 'data',
          mime: 'video/mp4',
          size: 50 * 1024 * 1024,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('location')).toMatch(
      new RegExp(`^/api/v1/publish/datasets/${datasetId}/asset/`),
    )
    const body = await readJson<{
      upload_id: string
      kind: string
      target: string
      stream?: { upload_url: string; stream_uid: string }
      r2?: unknown
      expires_at: string
    }>(res)
    expect(body.target).toBe('stream')
    expect(body.kind).toBe('data')
    expect(body.r2).toBeUndefined()
    expect(body.stream?.upload_url).toContain('mock-stream.localhost')
    expect(body.stream?.stream_uid).toMatch(/^[0-9a-f]{32}$/)
    expect(typeof body.expires_at).toBe('string')

    const row = sqlite
      .prepare(`SELECT * FROM asset_uploads WHERE id = ?`)
      .get(body.upload_id) as Record<string, unknown> | undefined
    expect(row).toBeTruthy()
    expect(row?.dataset_id).toBe(datasetId)
    expect(row?.publisher_id).toBe(STAFF.id)
    expect(row?.status).toBe('pending')
    expect(row?.target).toBe('stream')
    expect((row?.target_ref as string).startsWith('stream:')).toBe(true)
    expect(row?.claimed_digest).toBe(HAPPY_DIGEST)
  })

  it('routes a thumbnail to R2 with a content-addressed key', async () => {
    const { env, sqlite, datasetId } = setupEnv()
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        body: {
          kind: 'thumbnail',
          mime: 'image/png',
          size: 1234,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(201)
    const body = await readJson<{
      target: string
      r2?: { method: string; url: string; key: string; headers: Record<string, string> }
      stream?: unknown
    }>(res)
    expect(body.target).toBe('r2')
    expect(body.stream).toBeUndefined()
    expect(body.r2?.method).toBe('PUT')
    expect(body.r2?.key).toBe(`datasets/${datasetId}/by-digest/sha256/${SHA64}/thumbnail.png`)
    expect(body.r2?.url).toContain('mock-r2.localhost')
    expect(body.r2?.headers['Content-Type']).toBe('image/png')

    const row = sqlite
      .prepare(`SELECT target, target_ref, kind, mime FROM asset_uploads WHERE dataset_id = ?`)
      .get(datasetId) as Record<string, unknown>
    expect(row.target).toBe('r2')
    expect(row.target_ref).toBe(
      `r2:datasets/${datasetId}/by-digest/sha256/${SHA64}/thumbnail.png`,
    )
    expect(row.kind).toBe('thumbnail')
  })

  it('routes a sphere thumbnail to R2 in webp', async () => {
    const { env, datasetId } = setupEnv()
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        body: {
          kind: 'sphere_thumbnail',
          mime: 'image/webp',
          size: 50_000,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(201)
    const body = await readJson<{ r2?: { key: string } }>(res)
    expect(body.r2?.key).toBe(
      `datasets/${datasetId}/by-digest/sha256/${SHA64}/sphere-thumbnail.webp`,
    )
  })

  it('routes a VTT caption to R2', async () => {
    const { env, datasetId } = setupEnv()
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        body: {
          kind: 'caption',
          mime: 'text/vtt',
          size: 5_000,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(201)
    const body = await readJson<{ r2?: { key: string } }>(res)
    expect(body.r2?.key).toBe(`datasets/${datasetId}/by-digest/sha256/${SHA64}/caption.vtt`)
  })
})

describe('POST /api/v1/publish/datasets/{id}/asset — auth + visibility', () => {
  it('returns 404 when the dataset is not visible to a community publisher', async () => {
    const { env, datasetId } = setupEnv()
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        publisher: COMMUNITY,
        body: {
          kind: 'thumbnail',
          mime: 'image/png',
          size: 1234,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(404)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('not_found')
  })

  it('returns 404 for an unknown dataset id', async () => {
    const { env } = setupEnv()
    const res = await assetInit(
      ctx({
        env,
        datasetId: 'DS999AAAAAAAAAAAAAAAAAAAAA',
        body: {
          kind: 'thumbnail',
          mime: 'image/png',
          size: 1234,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/publish/datasets/{id}/asset — body validation', () => {
  it('returns 400 invalid_json when the body is not parseable', async () => {
    const { env, datasetId } = setupEnv()
    const res = await assetInit(ctx({ env, datasetId, bodyText: '{not json' }))
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_json')
  })

  it('returns 400 invalid_body when the parsed JSON is not an object', async () => {
    const { env, datasetId } = setupEnv()
    const res = await assetInit(ctx({ env, datasetId, body: ['array'] }))
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_body')
  })

  it('returns 400 with field errors for an invalid kind/mime/size/digest combination', async () => {
    const { env, datasetId } = setupEnv()
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        body: {
          kind: 'data',
          mime: 'text/vtt',
          size: 0,
          content_digest: 'wrong',
        },
      }),
    )
    expect(res.status).toBe(400)
    const body = await readJson<{
      errors: Array<{ field: string; code: string }>
    }>(res)
    const fields = new Set(body.errors.map(e => e.field))
    expect(fields.has('mime')).toBe(true)
    expect(fields.has('size')).toBe(true)
    expect(fields.has('content_digest')).toBe(true)
  })

  it('returns 400 size_exceeded for a video larger than 10 GB', async () => {
    const { env, datasetId } = setupEnv()
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        body: {
          kind: 'data',
          mime: 'video/mp4',
          size: 11 * 1024 * 1024 * 1024,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(400)
    const body = await readJson<{ errors: Array<{ field: string; code: string }> }>(res)
    expect(body.errors[0]).toMatchObject({ field: 'size', code: 'size_exceeded' })
  })
})

describe('POST /api/v1/publish/datasets/{id}/asset — config errors', () => {
  it('returns 503 stream_unconfigured when video upload but no Stream config', async () => {
    const { env, datasetId } = setupEnv({ MOCK_STREAM: undefined })
    delete (env as Record<string, unknown>).MOCK_STREAM
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        body: {
          kind: 'data',
          mime: 'video/mp4',
          size: 1000,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('stream_unconfigured')
  })

  it('returns 503 r2_unconfigured when image upload but no R2 config', async () => {
    const { env, datasetId } = setupEnv({ MOCK_R2: undefined })
    delete (env as Record<string, unknown>).MOCK_R2
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        body: {
          kind: 'thumbnail',
          mime: 'image/png',
          size: 1000,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('r2_unconfigured')
  })
})

describe('POST /api/v1/publish/datasets/{id}/asset — mock flag', () => {
  it('stamps mock=true on R2 uploads when MOCK_R2 is set', async () => {
    const { env, datasetId } = setupEnv()
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        body: {
          kind: 'thumbnail',
          mime: 'image/png',
          size: 1234,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(201)
    const body = await readJson<{ mock: boolean }>(res)
    expect(body.mock).toBe(true)
  })

  it('stamps mock=true on Stream uploads when MOCK_STREAM is set', async () => {
    const { env, datasetId } = setupEnv()
    const res = await assetInit(
      ctx({
        env,
        datasetId,
        body: {
          kind: 'data',
          mime: 'video/mp4',
          size: 50_000,
          content_digest: HAPPY_DIGEST,
        },
      }),
    )
    expect(res.status).toBe(201)
    const body = await readJson<{ mock: boolean }>(res)
    expect(body.mock).toBe(true)
  })

  it('refuses MOCK_R2=true on a non-loopback hostname', async () => {
    const { env, datasetId } = setupEnv()
    const baseCtx = ctx({
      env,
      datasetId,
      body: {
        kind: 'thumbnail',
        mime: 'image/png',
        size: 1234,
        content_digest: HAPPY_DIGEST,
      },
    })
    const prodCtx = {
      ...baseCtx,
      request: new Request(
        `https://terraviz.example.com/api/v1/publish/datasets/${datasetId}/asset`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'thumbnail',
            mime: 'image/png',
            size: 1234,
            content_digest: HAPPY_DIGEST,
          }),
        },
      ),
    } as Parameters<typeof assetInit>[0]
    const res = await assetInit(prodCtx)
    expect(res.status).toBe(500)
    expect((await readJson<{ error: string }>(res)).error).toBe('mock_r2_unsafe')
  })

  it('refuses MOCK_STREAM=true on a non-loopback hostname', async () => {
    const { env, datasetId } = setupEnv()
    const prodCtx = {
      ...ctx({ env, datasetId, body: {} }),
      request: new Request(
        `https://terraviz.example.com/api/v1/publish/datasets/${datasetId}/asset`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'data',
            mime: 'video/mp4',
            size: 50_000,
            content_digest: HAPPY_DIGEST,
          }),
        },
      ),
    } as Parameters<typeof assetInit>[0]
    const res = await assetInit(prodCtx)
    expect(res.status).toBe(500)
    expect((await readJson<{ error: string }>(res)).error).toBe('mock_stream_unsafe')
  })

  it('stamps mock=false when only one half of the pair is mocked', async () => {
    // R2 mock, Stream not mocked — Stream upload reports mock=false.
    const { env, datasetId } = setupEnv({ MOCK_STREAM: undefined })
    delete (env as Record<string, unknown>).MOCK_STREAM
    // Provide real-ish Stream credentials so the helper doesn't 503.
    Object.assign(env, {
      STREAM_ACCOUNT_ID: 'acct',
      STREAM_API_TOKEN: 'tok',
      STREAM_CUSTOMER_SUBDOMAIN: 'customer-real.cloudflarestream.com',
    })
    // Patch global fetch — mintDirectUploadUrl will reach for it.
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: { uploadURL: 'https://upload.cloudflarestream.com/abc', uid: 'abc' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const res = await assetInit(
        ctx({
          env,
          datasetId,
          body: {
            kind: 'data',
            mime: 'video/mp4',
            size: 50_000,
            content_digest: HAPPY_DIGEST,
          },
        }),
      )
      expect(res.status).toBe(201)
      const body = await readJson<{ mock: boolean }>(res)
      expect(body.mock).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
