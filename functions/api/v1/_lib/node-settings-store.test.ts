// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the node_settings singleton helpers (per-node feature
 * toggles).
 *
 * Coverage:
 *   - getNodeSettings returns null when never configured, the row when set.
 *   - setNodeFeatures upserts the singleton (a second set replaces).
 *   - featuresFromRow: null row / corrupt JSON / partial map all normalize.
 *   - validateFeaturesInput: partial ok, unknown key + non-boolean rejected.
 *   - getEffectiveFeatures: KV hit, KV miss + fill, fail-open on every
 *     failure mode (no bindings, D1 throw, KV throw, corrupt cache).
 *   - bustNodeFeaturesCache deletes the key, best-effort on error.
 */

import { describe, expect, it } from 'vitest'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'
import { defaultFeatures } from '../../../../src/types/node-features'
import { asD1, makeKV } from './test-helpers'
import {
  NODE_FEATURES_CACHE_KEY,
  bustNodeFeaturesCache,
  disabledKeys,
  featuresFromRow,
  getEffectiveFeatures,
  getNodeSettings,
  setNodeFeatures,
  validateFeaturesInput,
} from './node-settings-store'
import type { PublisherRow } from './publisher-store'

const TS = '2026-07-01T00:00:00.000Z'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: TS,
}

function setupDb() {
  const sqlite = freshMigratedDb()
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, TS)
  return asD1(sqlite)
}

describe('getNodeSettings / setNodeFeatures', () => {
  it('returns null when never configured', async () => {
    const db = setupDb()
    expect(await getNodeSettings(db)).toBeNull()
  })

  it('upserts the singleton and replaces on a second set', async () => {
    const db = setupDb()
    const off = { ...defaultFeatures(), blog: false }
    const row = await setNodeFeatures(db, ADMIN, off, TS)
    expect(row.updated_by).toBe(ADMIN.id)
    expect(row.updated_at).toBe(TS)
    expect(featuresFromRow(row).blog).toBe(false)

    const later = '2026-07-02T00:00:00.000Z'
    const row2 = await setNodeFeatures(db, ADMIN, defaultFeatures(), later)
    expect(row2.updated_at).toBe(later)
    expect(featuresFromRow(row2)).toEqual(defaultFeatures())
    // Still a single row.
    const settings = await getNodeSettings(db)
    expect(featuresFromRow(settings)).toEqual(defaultFeatures())
  })
})

describe('featuresFromRow', () => {
  it('null row means all enabled', () => {
    expect(featuresFromRow(null)).toEqual(defaultFeatures())
  })

  it('corrupt JSON degrades to all enabled', () => {
    expect(
      featuresFromRow({ features_json: '{not json', updated_by: 'x', updated_at: TS }),
    ).toEqual(defaultFeatures())
  })

  it('partial map fills missing keys as enabled and drops unknown keys', () => {
    const map = featuresFromRow({
      features_json: JSON.stringify({ events: false, mystery: false, blog: true }),
      updated_by: 'x',
      updated_at: TS,
    })
    expect(map.events).toBe(false)
    expect(map.blog).toBe(true)
    expect(map.datasets).toBe(true)
    expect('mystery' in map).toBe(false)
  })
})

describe('validateFeaturesInput', () => {
  it('accepts a partial features object', () => {
    const res = validateFeaturesInput({ features: { blog: false } })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.blog).toBe(false)
      expect(res.value.events).toBe(true)
    }
  })

  it('rejects a missing/invalid features object', () => {
    for (const raw of [undefined, null, {}, { features: null }, { features: [] }, { features: 'x' }]) {
      const res = validateFeaturesInput(raw)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.errors[0].field).toBe('features')
    }
  })

  it('rejects unknown keys and non-boolean values with per-field errors', () => {
    const res = validateFeaturesInput({ features: { mystery: false, blog: 'off' } })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      const fields = res.errors.map(e => e.field)
      expect(fields).toContain('features.mystery')
      expect(fields).toContain('features.blog')
    }
  })
})

describe('disabledKeys', () => {
  it('lists only the disabled features', () => {
    expect(disabledKeys(defaultFeatures())).toEqual([])
    expect(disabledKeys({ ...defaultFeatures(), events: false, blog: false })).toEqual([
      'events',
      'blog',
    ])
  })
})

describe('getEffectiveFeatures', () => {
  it('serves the KV cache when warm without touching D1', async () => {
    const kv = makeKV()
    kv._store.set(NODE_FEATURES_CACHE_KEY, JSON.stringify({ ...defaultFeatures(), tours: false }))
    const throwingDb = {
      prepare() {
        throw new Error('D1 must not be read on a cache hit')
      },
    } as unknown as D1Database
    const features = await getEffectiveFeatures({ CATALOG_DB: throwingDb, CATALOG_KV: kv })
    expect(features.tours).toBe(false)
    expect(features.blog).toBe(true)
  })

  it('reads D1 on a miss and fills the cache', async () => {
    const db = setupDb()
    await setNodeFeatures(db, ADMIN, { ...defaultFeatures(), analytics: false }, TS)
    const kv = makeKV()
    const features = await getEffectiveFeatures({ CATALOG_DB: db, CATALOG_KV: kv })
    expect(features.analytics).toBe(false)
    const cached = kv._store.get(NODE_FEATURES_CACHE_KEY)
    expect(cached).toBeTruthy()
    expect(JSON.parse(cached as string).analytics).toBe(false)
  })

  it('fails open: no bindings → all enabled', async () => {
    expect(await getEffectiveFeatures({})).toEqual(defaultFeatures())
  })

  it('fails open: D1 throws → all enabled', async () => {
    const throwingDb = {
      prepare() {
        throw new Error('boom')
      },
    } as unknown as D1Database
    expect(await getEffectiveFeatures({ CATALOG_DB: throwingDb })).toEqual(defaultFeatures())
  })

  it('fails open: KV throws → falls through to D1', async () => {
    const db = setupDb()
    await setNodeFeatures(db, ADMIN, { ...defaultFeatures(), hero: false }, TS)
    const brokenKv = {
      get() {
        throw new Error('kv down')
      },
      put() {
        throw new Error('kv down')
      },
      delete() {
        throw new Error('kv down')
      },
    } as unknown as KVNamespace
    const features = await getEffectiveFeatures({ CATALOG_DB: db, CATALOG_KV: brokenKv })
    expect(features.hero).toBe(false)
  })

  it('fails open: corrupt cache body → falls through to D1', async () => {
    const db = setupDb()
    const kv = makeKV()
    kv._store.set(NODE_FEATURES_CACHE_KEY, '{not json')
    const features = await getEffectiveFeatures({ CATALOG_DB: db, CATALOG_KV: kv })
    expect(features).toEqual(defaultFeatures())
  })
})

describe('bustNodeFeaturesCache', () => {
  it('deletes the cache key', async () => {
    const kv = makeKV()
    kv._store.set(NODE_FEATURES_CACHE_KEY, '{}')
    await bustNodeFeaturesCache(kv)
    expect(kv._store.has(NODE_FEATURES_CACHE_KEY)).toBe(false)
  })

  it('is best-effort on missing binding and KV error', async () => {
    await bustNodeFeaturesCache(undefined)
    const brokenKv = {
      delete() {
        throw new Error('kv down')
      },
    } as unknown as KVNamespace
    await expect(bustNodeFeaturesCache(brokenKv)).resolves.toBeUndefined()
  })
})
