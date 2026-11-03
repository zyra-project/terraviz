// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for the public GET /api/v1/node-profile — the lean
 * host-organization identity read (org name + logo URL) the public
 * blog surface renders.
 *
 * Coverage: null profile before any write, orgName + resolved
 * logoUrl, the KV MISS→HIT cycle, the degrade-to-null path when
 * the table is missing, and the `features` field (all-enabled
 * defaults, stored toggles, fail-open when node_settings is
 * missing).
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet } from './node-profile'
import { asD1, makeKV, seedFixtures } from './_lib/test-helpers'
import { defaultFeatures, type FeatureMap } from '../../../src/types/node-features'

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  const kv = makeKV()
  return { sqlite, kv, env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv, MOCK_R2: 'true' } }
}

function insertProfile(
  sqlite: ReturnType<typeof seedFixtures>,
  logoRef: string | null = null,
  tagline: string | null = null,
): void {
  // `node_profile.updated_by` is an FK to publishers.
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES ('PUB-1', 'admin@example.com', 'Admin', 'admin', 1, 'active', '2026-01-01T00:00:00.000Z')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO node_profile (id, org_name, logo_ref, tagline, updated_by, updated_at)
       VALUES (1, 'The Zyra Project', ?, ?, 'PUB-1', '2026-06-01T00:00:00.000Z')`,
    )
    .run(logoRef, tagline)
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
  profile: {
    orgName: string
    logoUrl: string | null
    tagline: string | null
    browseSubtitle: string | null
  } | null
  features: FeatureMap
}

async function readJson(res: Response): Promise<Payload> {
  return JSON.parse(await res.text()) as Payload
}

describe('GET /api/v1/node-profile', () => {
  it('returns profile: null and all-enabled features before any write', async () => {
    const { env } = setupEnv()
    const res = await onRequestGet(ctx(env))
    expect(res.status).toBe(200)
    const payload = await readJson(res)
    expect(payload.profile).toBeNull()
    expect(payload.features).toEqual(defaultFeatures())
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
    expect(payload.profile).toEqual({
      orgName: 'The Zyra Project',
      logoUrl: null,
      tagline: null,
      browseSubtitle: null,
    })
  })

  it('carries the loading-screen tagline the operator set', async () => {
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite, null, 'Global Systems Laboratory')
    const payload = await readJson(await onRequestGet(ctx(env)))
    expect(payload.profile?.tagline).toBe('Global Systems Laboratory')
  })

  it('carries the dataset browser subtitle the operator set', async () => {
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite)
    sqlite.prepare(`UPDATE node_profile SET browse_subtitle = 'Browse datasets from GSL'`).run()
    const payload = await readJson(await onRequestGet(ctx(env)))
    expect(payload.profile?.browseSubtitle).toBe('Browse datasets from GSL')
  })

  it('reads the tagline on a database with 0060 but not 0061', async () => {
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite, null, 'Global Systems Laboratory')
    sqlite.prepare('ALTER TABLE node_profile DROP COLUMN browse_subtitle').run()
    const payload = await readJson(await onRequestGet(ctx(env)))
    expect(payload.profile?.tagline).toBe('Global Systems Laboratory')
    expect(payload.profile?.browseSubtitle).toBeNull()
  })

  it('withholds a stored tagline the PUT would refuse (a hand-edited row)', async () => {
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite, null, 'Two\nlines')
    const payload = await readJson(await onRequestGet(ctx(env)))
    expect(payload.profile?.orgName).toBe('The Zyra Project')
    expect(payload.profile?.tagline).toBeNull()
  })

  it('degrades to profile: null (no-store) when the table is missing', async () => {
    const { env, sqlite } = setupEnv()
    sqlite.prepare('DROP TABLE node_profile').run()
    const res = await onRequestGet(ctx(env))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const payload = await readJson(res)
    expect(payload.profile).toBeNull()
    expect(payload.features).toEqual(defaultFeatures())
  })

  it('keeps the stored toggles when the profile cannot be read', async () => {
    // A profile-side failure must not turn Orbit back on for a node
    // that turned it off.
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite)
    sqlite
      .prepare(
        `INSERT INTO node_settings (id, features_json, updated_by, updated_at)
         VALUES (1, ?, 'PUB-1', '2026-06-01T00:00:00.000Z')`,
      )
      .run(JSON.stringify({ orbit: false }))
    sqlite.prepare('DROP TABLE node_profile').run()
    const res = await onRequestGet(ctx(env))
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const payload = await readJson(res)
    expect(payload.profile).toBeNull()
    expect(payload.features.orbit).toBe(false)
  })

  it('reads the profile, without either line, on a database without migrations 0060 or 0061', async () => {
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite)
    sqlite
      .prepare(
        `INSERT INTO node_settings (id, features_json, updated_by, updated_at)
         VALUES (1, ?, 'PUB-1', '2026-06-01T00:00:00.000Z')`,
      )
      .run(JSON.stringify({ orbit: false }))
    sqlite.prepare('ALTER TABLE node_profile DROP COLUMN browse_subtitle').run()
    sqlite.prepare('ALTER TABLE node_profile DROP COLUMN tagline').run()
    const payload = await readJson(await onRequestGet(ctx(env)))
    expect(payload.profile).toEqual({
      orgName: 'The Zyra Project',
      logoUrl: null,
      tagline: null,
      browseSubtitle: null,
    })
    expect(payload.features.orbit).toBe(false)
  })

  it('carries stored feature toggles in the payload', async () => {
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite)
    sqlite
      .prepare(
        `INSERT INTO node_settings (id, features_json, updated_by, updated_at)
         VALUES (1, ?, 'PUB-1', '2026-06-01T00:00:00.000Z')`,
      )
      .run(JSON.stringify({ blog: false, events: false }))
    const payload = await readJson(await onRequestGet(ctx(env)))
    expect(payload.features.blog).toBe(false)
    expect(payload.features.events).toBe(false)
    expect(payload.features.datasets).toBe(true)
  })

  it('fails open to all-enabled features when node_settings is missing', async () => {
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite)
    sqlite.prepare('DROP TABLE node_settings').run()
    const res = await onRequestGet(ctx(env))
    expect(res.status).toBe(200)
    const payload = await readJson(res)
    expect(payload.profile?.orgName).toBe('The Zyra Project')
    expect(payload.features).toEqual(defaultFeatures())
  })

  it('never caches features it had to assume', async () => {
    // The SPA decides whether to offer Orbit from this payload, so a
    // guess cached for the TTL would outlive the failure behind it.
    const { env, sqlite } = setupEnv()
    insertProfile(sqlite)
    sqlite.prepare('DROP TABLE node_settings').run()
    const res = await onRequestGet(ctx(env))
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((env.CATALOG_KV as ReturnType<typeof makeKV>)._store.size).toBe(0)
  })
})
