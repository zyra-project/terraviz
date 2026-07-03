/**
 * Wire-level tests for /api/v1/publish/node-profile/logo — the org
 * logo upload/remove (Phase 3d follow-up).
 *
 * Coverage: privileged gate, content-type allowlist, size cap,
 * magic-byte verification against the claimed type, the
 * save-profile-first precondition (checked BEFORE any R2 write so no
 * object is orphaned), the happy path (content-addressed R2 put with
 * immutable cache headers → logo_ref → audit → KV bust → resolved
 * logoUrl), and idempotent DELETE.
 */

import { describe, expect, it } from 'vitest'
import { onRequestDelete, onRequestPost } from './logo'
import { asD1, makeKV, seedFixtures } from '../../_lib/test-helpers'
import {
  LOGO_MAX_BYTES,
  NODE_PROFILE_CACHE_KEY,
} from '../../_lib/node-profile-store'
import type { PublisherRow } from '../../_lib/publisher-store'

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

function setupEnv(opts: { withProfile?: boolean } = {}) {
  const sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  if (opts.withProfile !== false) {
    sqlite
      .prepare(
        `INSERT INTO node_profile (id, org_name, updated_by, updated_at)
         VALUES (1, 'The Zyra Project', ?, '2026-06-01T00:00:00.000Z')`,
      )
      .run(ADMIN.id)
  }
  const { bucket, puts } = makeBucket()
  const kv = makeKV()
  const env = { CATALOG_DB: asD1(sqlite), CATALOG_R2: bucket, CATALOG_KV: kv, MOCK_R2: 'true' }
  return { sqlite, env, puts, kv }
}

function ctx(opts: {
  env: Record<string, unknown>
  method: 'POST' | 'DELETE'
  publisher?: PublisherRow
  body?: unknown
}) {
  const url = 'https://localhost/api/v1/publish/node-profile/logo'
  const init: RequestInit = { method: opts.method, headers: new Headers() }
  if (opts.body !== undefined) {
    ;(init.headers as Headers).set('Content-Type', 'application/json')
    init.body = JSON.stringify(opts.body)
  }
  return {
    request: new Request(url, init),
    env: opts.env,
    params: {},
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof onRequestPost>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

/** Bytes with a valid PNG signature. */
function pngBytes(payloadLen = 16): Uint8Array {
  const bytes = new Uint8Array(8 + payloadLen)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 8; i < bytes.length; i++) bytes[i] = i % 251
  return bytes
}

/** Bytes with a valid JPEG signature. */
function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

const PNG_BODY = { contentType: 'image/png', dataBase64: toB64(pngBytes()) }

describe('POST /api/v1/publish/node-profile/logo', () => {
  it('is 403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    const res = await onRequestPost(ctx({ env, method: 'POST', publisher: PUBLISHER, body: PNG_BODY }))
    expect(res.status).toBe(403)
  })

  it('rejects a non-allowlisted content type (SVG)', async () => {
    const { env, puts } = setupEnv()
    const res = await onRequestPost(
      ctx({ env, method: 'POST', body: { contentType: 'image/svg+xml', dataBase64: toB64(pngBytes()) } }),
    )
    expect(res.status).toBe(400)
    const { errors } = await readJson<{ errors: Array<{ field: string; code: string }> }>(res)
    expect(errors[0]).toMatchObject({ field: 'contentType', code: 'unsupported' })
    expect(puts).toHaveLength(0)
  })

  it('rejects bytes whose magic does not match the declared type', async () => {
    const { env, puts } = setupEnv()
    const res = await onRequestPost(
      ctx({ env, method: 'POST', body: { contentType: 'image/png', dataBase64: toB64(jpegBytes()) } }),
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
        method: 'POST',
        body: { contentType: 'image/png', dataBase64: 'A'.repeat(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 64) },
      }),
    )
    expect(res.status).toBe(400)
    const { errors } = await readJson<{ errors: Array<{ code: string }> }>(res)
    expect(errors[0].code).toBe('too_large')
    expect(puts).toHaveLength(0)
  })

  it('requires a saved profile before any R2 write', async () => {
    const { env, puts } = setupEnv({ withProfile: false })
    const res = await onRequestPost(ctx({ env, method: 'POST', body: PNG_BODY }))
    expect(res.status).toBe(400)
    const { errors } = await readJson<{ errors: Array<{ field: string; code: string }> }>(res)
    expect(errors[0]).toMatchObject({ field: 'profile', code: 'missing' })
    // The precondition fired before the upload — no orphaned object.
    expect(puts).toHaveLength(0)
  })

  it('stores the logo content-addressed, sets logo_ref, audits, and busts the public cache', async () => {
    const { env, sqlite, puts, kv } = setupEnv()
    kv._store.set(NODE_PROFILE_CACHE_KEY, JSON.stringify({ profile: { orgName: 'Stale', logoUrl: null } }))

    const res = await onRequestPost(ctx({ env, method: 'POST', body: PNG_BODY }))
    expect(res.status).toBe(200)
    const { logoUrl } = await readJson<{ logoUrl: string | null }>(res)
    expect(logoUrl).toMatch(/^https:\/\/mock-r2\.localhost\/.*\/node\/logo\/sha256\/[0-9a-f]{64}\/logo\.png$/)

    expect(puts).toHaveLength(1)
    expect(puts[0].key).toMatch(/^node\/logo\/sha256\/[0-9a-f]{64}\/logo\.png$/)
    expect(puts[0].options.httpMetadata).toMatchObject({
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    })

    const row = sqlite.prepare('SELECT logo_ref FROM node_profile WHERE id = 1').get() as { logo_ref: string }
    expect(row.logo_ref).toBe(`r2:${puts[0].key}`)

    const audit = sqlite
      .prepare(`SELECT action FROM audit_events WHERE action = 'node_profile.logo_update'`)
      .all()
    expect(audit).toHaveLength(1)

    expect(kv._store.has(NODE_PROFILE_CACHE_KEY)).toBe(false)
  })
})

describe('DELETE /api/v1/publish/node-profile/logo', () => {
  it('clears logo_ref and audits', async () => {
    const { env, sqlite } = setupEnv()
    sqlite.prepare(`UPDATE node_profile SET logo_ref = 'r2:node/logo/sha256/${'a'.repeat(64)}/logo.png' WHERE id = 1`).run()

    const res = await onRequestDelete(ctx({ env, method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect((await readJson<{ logoUrl: string | null }>(res)).logoUrl).toBeNull()

    const row = sqlite.prepare('SELECT logo_ref FROM node_profile WHERE id = 1').get() as { logo_ref: string | null }
    expect(row.logo_ref).toBeNull()
    const audit = sqlite
      .prepare(`SELECT action FROM audit_events WHERE action = 'node_profile.logo_update'`)
      .all()
    expect(audit).toHaveLength(1)
  })

  it('is idempotent when no profile exists — and still busts the public cache', async () => {
    const { env, kv } = setupEnv({ withProfile: false })
    // A stale identity entry must not outlive the delete just because
    // the row is gone.
    kv._store.set(NODE_PROFILE_CACHE_KEY, JSON.stringify({ profile: { orgName: 'Stale', logoUrl: 'https://x/y.png' } }))
    const res = await onRequestDelete(ctx({ env, method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect((await readJson<{ logoUrl: string | null }>(res)).logoUrl).toBeNull()
    expect(kv._store.has(NODE_PROFILE_CACHE_KEY)).toBe(false)
  })
})
