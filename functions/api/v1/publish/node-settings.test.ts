// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for /api/v1/publish/node-settings — the per-node
 * feature toggles.
 *
 * Coverage: GET before any write (all enabled), any-publisher read,
 * admin-only gate on writes (403 for publisher AND service — the
 * strict `isAdmin` break from the node-profile precedent), PUT →
 * GET round-trip, partial body semantics, validation (unknown key,
 * non-boolean, missing features), the `node_settings.update` audit
 * row, and the double cache bust (node-features:v1 + the public
 * node-profile key).
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet, onRequestPut } from './node-settings'
import { asD1, makeKV, seedFixtures } from '../_lib/test-helpers'
import { NODE_FEATURES_CACHE_KEY } from '../_lib/node-settings-store'
import { NODE_PROFILE_CACHE_KEY } from '../_lib/node-profile-store'
import { defaultFeatures, type FeatureMap } from '../../../../src/types/node-features'
import type { PublisherRow } from '../_lib/publisher-store'

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
const SERVICE: PublisherRow = { ...ADMIN, id: 'PUB-SVC', email: 's@e', role: 'service', is_admin: 0 }

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  const kv = makeKV()
  return { sqlite, kv, env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv } }
}

function ctx(opts: { env: Record<string, unknown>; method: 'GET' | 'PUT'; publisher?: PublisherRow; body?: unknown; rawBody?: string }) {
  const url = 'https://localhost/api/v1/publish/node-settings'
  const init: RequestInit = { method: opts.method, headers: new Headers() }
  if (opts.rawBody !== undefined) {
    ;(init.headers as Headers).set('Content-Type', 'application/json')
    init.body = opts.rawBody
  } else if (opts.body !== undefined) {
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
  } as unknown as Parameters<typeof onRequestPut>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

interface SettingsResponse {
  features: FeatureMap
  updatedBy: string | null
  updatedAt: string | null
}

describe('/api/v1/publish/node-settings', () => {
  it('GET returns all-enabled defaults before any write', async () => {
    const { env } = setupEnv()
    const res = await onRequestGet(ctx({ env, method: 'GET' }))
    expect(res.status).toBe(200)
    const body = await readJson<SettingsResponse>(res)
    expect(body.features).toEqual(defaultFeatures())
    expect(body.updatedBy).toBeNull()
    expect(body.updatedAt).toBeNull()
  })

  it('GET is readable by a non-privileged publisher', async () => {
    const { env } = setupEnv()
    const res = await onRequestGet(ctx({ env, method: 'GET', publisher: PUBLISHER }))
    expect(res.status).toBe(200)
  })

  it('PUT is admin-only: publisher and service callers get 403', async () => {
    const { env } = setupEnv()
    for (const caller of [PUBLISHER, SERVICE]) {
      const res = await onRequestPut(
        ctx({ env, method: 'PUT', publisher: caller, body: { features: { blog: false } } }),
      )
      expect(res.status).toBe(403)
      expect((await readJson<{ error: string }>(res)).error).toBe('forbidden_role')
    }
  })

  it('PUT round-trips a partial body: named keys apply, missing keys stay enabled', async () => {
    const { env } = setupEnv()
    const put = await onRequestPut(
      ctx({ env, method: 'PUT', body: { features: { blog: false, events: false, tours: true } } }),
    )
    expect(put.status).toBe(200)
    const putBody = await readJson<SettingsResponse>(put)
    expect(putBody.features.blog).toBe(false)
    expect(putBody.features.events).toBe(false)
    expect(putBody.features.tours).toBe(true)
    expect(putBody.features.datasets).toBe(true)
    expect(putBody.updatedBy).toBe(ADMIN.id)

    const get = await onRequestGet(ctx({ env, method: 'GET' }))
    expect((await readJson<SettingsResponse>(get)).features).toEqual(putBody.features)
  })

  it('PUT rejects unknown keys and non-boolean values with field errors', async () => {
    const { env } = setupEnv()
    const res = await onRequestPut(
      ctx({ env, method: 'PUT', body: { features: { mystery: false, blog: 'off' } } }),
    )
    expect(res.status).toBe(400)
    const { errors } = await readJson<{ errors: Array<{ field: string }> }>(res)
    expect(errors.map(e => e.field)).toEqual(
      expect.arrayContaining(['features.mystery', 'features.blog']),
    )
  })

  it('PUT rejects a missing features object and invalid JSON', async () => {
    const { env } = setupEnv()
    const noFeatures = await onRequestPut(ctx({ env, method: 'PUT', body: {} }))
    expect(noFeatures.status).toBe(400)
    const badJson = await onRequestPut(ctx({ env, method: 'PUT', rawBody: '{not json' }))
    expect(badJson.status).toBe(400)
    expect((await readJson<{ error: string }>(badJson)).error).toBe('invalid_json')
  })

  it('PUT writes a node_settings.update audit row with the disabled set', async () => {
    const { env, sqlite } = setupEnv()
    await onRequestPut(ctx({ env, method: 'PUT', body: { features: { analytics: false } } }))
    const row = sqlite
      .prepare(`SELECT action, subject_kind, actor_id, metadata_json FROM audit_events ORDER BY id DESC LIMIT 1`)
      .get() as { action: string; subject_kind: string; actor_id: string; metadata_json: string }
    expect(row.action).toBe('node_settings.update')
    expect(row.subject_kind).toBe('node_settings')
    expect(row.actor_id).toBe(ADMIN.id)
    expect(JSON.parse(row.metadata_json)).toEqual({ disabled: ['analytics'] })
  })

  it('PUT busts both the features cache and the public node-profile cache', async () => {
    const { env, kv } = setupEnv()
    kv._store.set(NODE_FEATURES_CACHE_KEY, JSON.stringify(defaultFeatures()))
    kv._store.set(NODE_PROFILE_CACHE_KEY, JSON.stringify({ profile: null }))
    await onRequestPut(ctx({ env, method: 'PUT', body: { features: { hero: false } } }))
    expect(kv._store.has(NODE_FEATURES_CACHE_KEY)).toBe(false)
    expect(kv._store.has(NODE_PROFILE_CACHE_KEY)).toBe(false)
  })

  it('returns 503 when CATALOG_DB is missing', async () => {
    const res = await onRequestGet(ctx({ env: {}, method: 'GET' }))
    expect(res.status).toBe(503)
  })
})
