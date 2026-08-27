// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for POST /api/v1/publish/tours/{id}/media — the
 * tour media-rail image upload (task: tour media authoring).
 *
 * Coverage: ownership gate (owner vs other publisher vs privileged),
 * shared image validation (allowlist / magic mismatch / size cap),
 * the content-addressed R2 put with immutable cache headers, and the
 * r2_unconfigured guard firing BEFORE any write.
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost, TOUR_MEDIA_MAX_BYTES } from './media'
import { asD1, seedFixtures } from '../../../_lib/test-helpers'
import type { PublisherRow } from '../../../_lib/publisher-store'

const OWNER: PublisherRow = {
  id: 'PUB-OWNER',
  email: 'owner@example.com',
  display_name: 'Owner',
  affiliation: null,
  org_id: null,
  role: 'publisher',
  is_admin: 0,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const OTHER: PublisherRow = { ...OWNER, id: 'PUB-OTHER', email: 'other@example.com' }
const ADMIN: PublisherRow = { ...OWNER, id: 'PUB-ADMIN', email: 'admin@example.com', role: 'admin', is_admin: 1 }

const TOUR_ID = '01HXTOUR00000000000000000A'

interface CapturedPut {
  key: string
  bytes: Uint8Array
  options: { httpMetadata?: { contentType?: string; cacheControl?: string } }
}

function makeBucket() {
  const puts: CapturedPut[] = []
  const bucket = {
    put: async (key: string, value: ArrayBuffer, options: CapturedPut['options']) => {
      puts.push({ key, bytes: new Uint8Array(value), options })
      return {}
    },
  } as unknown as R2Bucket
  return { bucket, puts }
}

function setupEnv(opts: { mockR2?: boolean } = {}) {
  const sqlite = seedFixtures({ count: 0 })
  for (const p of [OWNER, OTHER, ADMIN]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  sqlite
    .prepare(
      `INSERT INTO tours (id, slug, origin_node, title, tour_json_ref, visibility,
                          schema_version, created_at, updated_at, publisher_id)
       VALUES (?, 'test-tour', 'node', 'Test tour', ?, 'public', 1, ?, ?, ?)`,
    )
    .run(TOUR_ID, `r2:tours/${TOUR_ID}/draft.json`, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', OWNER.id)
  const { bucket, puts } = makeBucket()
  return {
    sqlite,
    puts,
    env: {
      CATALOG_DB: asD1(sqlite),
      CATALOG_R2: bucket,
      ...(opts.mockR2 === false ? {} : { MOCK_R2: 'true' }),
    },
  }
}

function ctx(opts: { env: Record<string, unknown>; publisher?: PublisherRow; tourId?: string; body?: unknown }) {
  const id = opts.tourId ?? TOUR_ID
  const url = `https://localhost/api/v1/publish/tours/${id}/media`
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body ?? {}),
    }),
    env: opts.env,
    params: { id },
    data: { publisher: opts.publisher ?? OWNER },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof onRequestPost>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

function pngBytes(payloadLen = 16): Uint8Array {
  const bytes = new Uint8Array(8 + payloadLen)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 8; i < bytes.length; i++) bytes[i] = i % 251
  return bytes
}

const PNG_BODY = { contentType: 'image/png', dataBase64: Buffer.from(pngBytes()).toString('base64') }

describe('POST /api/v1/publish/tours/{id}/media', () => {
  it('uploads content-addressed under the tour and returns the public URL', async () => {
    const { env, puts } = setupEnv()
    const res = await onRequestPost(ctx({ env, body: PNG_BODY }))
    expect(res.status).toBe(200)
    const { url } = await readJson<{ url: string }>(res)
    expect(url).toMatch(
      new RegExp(`^https://mock-r2\\.localhost/.*/tours/${TOUR_ID}/media/sha256/[0-9a-f]{64}/media\\.png$`),
    )
    expect(puts).toHaveLength(1)
    expect(puts[0].options.httpMetadata).toMatchObject({
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    })
  })

  it("is 404 for another publisher's tour, 200 for an admin", async () => {
    const { env, puts } = setupEnv()
    const other = await onRequestPost(ctx({ env, publisher: OTHER, body: PNG_BODY }))
    expect(other.status).toBe(404)
    expect(puts).toHaveLength(0)
    const admin = await onRequestPost(ctx({ env, publisher: ADMIN, body: PNG_BODY }))
    expect(admin.status).toBe(200)
  })

  it('rejects a magic-byte mismatch via the shared validator', async () => {
    const { env, puts } = setupEnv()
    const res = await onRequestPost(
      ctx({ env, body: { contentType: 'image/png', dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') } }),
    )
    expect(res.status).toBe(400)
    const { errors } = await readJson<{ errors: Array<{ code: string }> }>(res)
    expect(errors[0].code).toBe('type_mismatch')
    expect(puts).toHaveLength(0)
  })

  it('rejects an oversized payload without decoding it', async () => {
    const { env, puts } = setupEnv()
    const res = await onRequestPost(
      ctx({
        env,
        body: { contentType: 'image/png', dataBase64: 'A'.repeat(Math.ceil((TOUR_MEDIA_MAX_BYTES * 4) / 3) + 64) },
      }),
    )
    expect(res.status).toBe(400)
    const { errors } = await readJson<{ errors: Array<{ code: string }> }>(res)
    expect(errors[0].code).toBe('too_large')
    expect(puts).toHaveLength(0)
  })

  it('fails 503 r2_unconfigured BEFORE writing when no public origin is bound', async () => {
    const { env, puts } = setupEnv({ mockR2: false })
    const res = await onRequestPost(ctx({ env, body: PNG_BODY }))
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('r2_unconfigured')
    expect(puts).toHaveLength(0)
  })
})
