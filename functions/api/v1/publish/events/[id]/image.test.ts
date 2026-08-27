// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for POST /api/v1/publish/events/:id/image — the
 * publisher's own photo as an event's story image (task: media
 * suggestion engine).
 */

import { describe, expect, it } from 'vitest'
import { onRequestPost as imagePost } from './image'
import { asD1, seedFixtures } from '../../../_lib/test-helpers'
import { insertCurrentEvent, getCurrentEvent } from '../../../_lib/events-store'
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
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUB', email: 'p@e', role: 'publisher', is_admin: 0 }

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

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  // Seed publisher rows so an event's owner_id FK resolves.
  for (const p of [ADMIN, PUBLISHER]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  const { bucket, puts } = makeBucket()
  const env = { CATALOG_DB: asD1(sqlite), CATALOG_R2: bucket, MOCK_R2: 'true' }
  return { sqlite, env, puts }
}

function ctx(opts: { env: Record<string, unknown>; id: string; publisher?: PublisherRow; body?: unknown }) {
  const url = `https://localhost/api/v1/publish/events/${opts.id}/image`
  const init: RequestInit = { method: 'POST', headers: new Headers({ 'Content-Type': 'application/json' }) }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    request: new Request(url, init),
    env: opts.env,
    params: { id: opts.id },
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof imagePost>[0]
}

const SAMPLE = {
  originNode: 'NODE000',
  title: 'Storm now',
  sourceName: 'NOAA',
  sourceUrl: 'https://example.gov/storm',
}

function pngBytes(): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 8; i < bytes.length; i++) bytes[i] = i % 251
  return bytes
}

const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const PNG_BODY = { contentType: 'image/png', dataBase64: toB64(pngBytes()) }

describe('POST /api/v1/publish/events/:id/image', () => {
  it('is 403 forbidden_owner when a publisher targets an event owned by someone else', async () => {
    const { env } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, { ...SAMPLE, ownerId: 'PUB-ADMIN' })).id
    const res = await imagePost(ctx({ env, id, publisher: PUBLISHER, body: PNG_BODY }))
    expect(res.status).toBe(403)
    expect((JSON.parse(await res.text()) as { error: string }).error).toBe('forbidden_owner')
  })

  it('is 404 for an unknown event', async () => {
    const { env } = setupEnv()
    const res = await imagePost(ctx({ env, id: 'NOPE000000000000000000000A', body: PNG_BODY }))
    expect(res.status).toBe(404)
  })

  it('refuses a content type that disagrees with the magic bytes', async () => {
    const { env } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    const res = await imagePost(
      ctx({ env, id, body: { contentType: 'image/jpeg', dataBase64: toB64(pngBytes()) } }),
    )
    expect(res.status).toBe(400)
  })

  it('refuses oversized alt text', async () => {
    const { env } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    const res = await imagePost(ctx({ env, id, body: { ...PNG_BODY, altText: 'x'.repeat(513) } }))
    expect(res.status).toBe(400)
    const body = JSON.parse(await res.text()) as { errors: Array<{ field: string }> }
    expect(body.errors[0].field).toBe('altText')
  })

  it('is 503 when R2 public reads are not configured', async () => {
    const { env } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    const res = await imagePost(ctx({ env: { ...env, MOCK_R2: undefined }, id, body: PNG_BODY }))
    expect(res.status).toBe(503)
    expect(JSON.parse(await res.text())).toMatchObject({ error: 'r2_unconfigured' })
  })

  it('stores the photo content-addressed, sets image_url + image_alt, audits', async () => {
    const { env, sqlite, puts } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, SAMPLE)).id
    const res = await imagePost(
      ctx({ env, id, body: { ...PNG_BODY, altText: '  Flood waters over the harbor  ' } }),
    )
    expect(res.status).toBe(200)
    const { imageUrl } = JSON.parse(await res.text()) as { imageUrl: string }
    expect(imageUrl).toMatch(/^https:\/\/mock-r2\.localhost\/.*\/events\/image\/sha256\/[0-9a-f]{64}\.png$/)

    expect(puts).toHaveLength(1)
    expect(puts[0].options.httpMetadata?.contentType).toBe('image/png')

    const row = await getCurrentEvent(env.CATALOG_DB, id)
    expect(row!.image_url).toBe(imageUrl)
    expect(row!.image_alt).toBe('Flood waters over the harbor') // trimmed

    const audit = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'event.image_upload' AND subject_id = ?`)
      .get(id) as { n: number }
    expect(audit.n).toBe(1)
  })

  it('a replacement upload without alt text clears the stale description', async () => {
    const { env } = setupEnv()
    const id = (await insertCurrentEvent(env.CATALOG_DB, {
      ...SAMPLE,
      imageUrl: 'https://img.example.org/old.jpg',
      imageAlt: 'The old picture',
    })).id
    const res = await imagePost(ctx({ env, id, body: PNG_BODY }))
    expect(res.status).toBe(200)
    const row = await getCurrentEvent(env.CATALOG_DB, id)
    expect(row!.image_url).toContain('events/image/sha256/')
    expect(row!.image_alt).toBeNull()
  })
})
