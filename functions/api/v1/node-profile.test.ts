/**
 * Wire-level tests for the public GET /api/v1/node-profile — the lean
 * host-organization identity read (org name + logo URL) the public
 * blog surface renders.
 *
 * Coverage: null profile before any write, orgName + resolved
 * logoUrl, the KV MISS→HIT cycle, and the degrade-to-null path when
 * the table is missing.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet } from './node-profile'
import { asD1, makeKV, seedFixtures } from './_lib/test-helpers'

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  const kv = makeKV()
  return { sqlite, kv, env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv, MOCK_R2: 'true' } }
}

function insertProfile(sqlite: ReturnType<typeof seedFixtures>, logoRef: string | null = null): void {
  // `node_profile.updated_by` is an FK to publishers.
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES ('PUB-1', 'admin@example.com', 'Admin', 'admin', 1, 'active', '2026-01-01T00:00:00.000Z')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO node_profile (id, org_name, logo_ref, updated_by, updated_at)
       VALUES (1, 'The Zyra Project', ?, 'PUB-1', '2026-06-01T00:00:00.000Z')`,
    )
    .run(logoRef)
}

function ctx(env: Record<string, unknown>) {
  const url = 'https://localhost/api/v1/node-profile'
  return {
    request: new Request(url),
    env,
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof onRequestGet>[0]
}

interface Payload {
  profile: { orgName: string; logoUrl: string | null } | null
}

async function readJson(res: Response): Promise<Payload> {
  return JSON.parse(await res.text()) as Payload
}

describe('GET /api/v1/node-profile', () => {
  it('returns profile: null before any write', async () => {
    const { env } = setupEnv()
    const res = await onRequestGet(ctx(env))
    expect(res.status).toBe(200)
    expect((await readJson(res)).profile).toBeNull()
  })

  it('returns orgName with a resolved logoUrl and cycles KV MISS → HIT', async () => {
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite, `r2:node/logo/sha256/${'a'.repeat(64)}/logo.png`)

    const miss = await onRequestGet(ctx(env))
    expect(miss.headers.get('X-Cache')).toBe('MISS')
    const payload = await readJson(miss)
    expect(payload.profile?.orgName).toBe('The Zyra Project')
    expect(payload.profile?.logoUrl).toMatch(/^https:\/\/mock-r2\.localhost\//)

    const hit = await onRequestGet(ctx(env))
    expect(hit.headers.get('X-Cache')).toBe('HIT')
    expect(await readJson(hit)).toEqual(payload)
  })

  it('returns logoUrl: null when no logo is set', async () => {
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite)
    const payload = await readJson(await onRequestGet(ctx(env)))
    expect(payload.profile).toEqual({ orgName: 'The Zyra Project', logoUrl: null })
  })

  it('degrades to profile: null (no-store) when the table is missing', async () => {
    const { env, sqlite } = setupEnv()
    sqlite.prepare('DROP TABLE node_profile').run()
    const res = await onRequestGet(ctx(env))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await readJson(res)).profile).toBeNull()
  })
})
