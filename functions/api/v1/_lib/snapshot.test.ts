// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the catalog snapshot cache.
 *
 * Coverage:
 *   - readSnapshot: no binding is a miss; a stored snapshot comes back
 *     as written; a KV read that rejects is a miss, not a throw, and
 *     is logged so the broken binding shows up in Workers Logs (the
 *     2026-11-09 NOAA-GSL outage: `CATALOG_KV` bound to a deleted
 *     namespace turned every catalog read into a 500).
 *   - The generation: 0 on a fresh database and on one with no row,
 *     and each invalidation adds 1, recreating a missing row.
 *   - lookupSnapshot: a payload is served only under the current
 *     generation. An older one, one with no stamp (written before
 *     migration 0062) and one stamped `null` are misses. When the
 *     generation cannot be read, a cached payload is served
 *     unverified and the read is logged as an error.
 *   - writeSnapshot: every put carries the TTL that bounds those
 *     unverified cases; a failing put is a warning, not a throw.
 *   - invalidateSnapshot: bump then delete; each failure is logged at
 *     the level of what it exposes, and none throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  invalidateSnapshot,
  lookupSnapshot,
  readSnapshot,
  readSnapshotGeneration,
  SNAPSHOT_KEY,
  SNAPSHOT_TTL_SECONDS,
  writeSnapshot,
  type SnapshotPayload,
} from './snapshot'
import { asD1, makeFailingD1, makeFailingKV, makeKV, seedFixtures } from './test-helpers'

const PAYLOAD: SnapshotPayload = {
  etag: '"abc"',
  generatedAt: '2026-11-09T00:00:00.000Z',
  body: '{"datasets":[]}',
  contentType: 'application/json; charset=utf-8',
  generation: 0,
}

let warn: MockInstance<typeof console.warn>
let error: MockInstance<typeof console.error>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  error.mockRestore()
})

function logged(spy: MockInstance<typeof console.warn>): string {
  return spy.mock.calls.map(c => c.join(' ')).join('\n')
}

/** A migrated database and a KV holding `payload`. */
function setup(payload?: Partial<SnapshotPayload>) {
  const sqlite = seedFixtures({ count: 0 })
  const kv = makeKV()
  if (payload) kv._store.set(SNAPSHOT_KEY, JSON.stringify(payload))
  return { sqlite, kv, env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv } }
}

/** `env` with a KV whose delete rejects and every other call works. */
function withFailingDelete<E extends { CATALOG_KV: ReturnType<typeof makeKV> }>(env: E): E {
  const kv = Object.create(env.CATALOG_KV) as ReturnType<typeof makeKV>
  kv.delete = vi.fn(async () => {
    throw new Error('KV delete timed out')
  })
  return { ...env, CATALOG_KV: kv }
}

describe('readSnapshot', () => {
  it('is a miss when CATALOG_KV is not bound', async () => {
    expect(await readSnapshot({})).toBeNull()
  })

  it('returns a stored snapshot', async () => {
    const kv = makeKV()
    kv._store.set(SNAPSHOT_KEY, JSON.stringify(PAYLOAD))
    expect(await readSnapshot({ CATALOG_KV: kv })).toEqual(PAYLOAD)
    expect(warn).not.toHaveBeenCalled()
  })

  it('treats a KV read that rejects as a miss, and logs it', async () => {
    expect(await readSnapshot({ CATALOG_KV: makeFailingKV() })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0].join(' ')).toMatch(/KV snapshot read failed.*KV namespace not found/)
  })
})

describe('snapshot generation', () => {
  it('starts at 0, and each invalidation adds 1', async () => {
    const { env } = setup()
    expect(await readSnapshotGeneration(env.CATALOG_DB)).toBe(0)
    await invalidateSnapshot(env)
    await invalidateSnapshot(env)
    expect(await readSnapshotGeneration(env.CATALOG_DB)).toBe(2)
  })

  it('reads a missing row as 0, and the next invalidation recreates it at 1', async () => {
    const { sqlite, env } = setup()
    sqlite.prepare('DELETE FROM catalog_snapshot_generation').run()
    expect(await readSnapshotGeneration(env.CATALOG_DB)).toBe(0)
    await invalidateSnapshot(env)
    expect(await readSnapshotGeneration(env.CATALOG_DB)).toBe(1)
  })
})

describe('lookupSnapshot', () => {
  it('serves a payload stamped with the current generation', async () => {
    const { env } = setup(PAYLOAD)
    expect(await lookupSnapshot(env)).toEqual({ hit: true, payload: PAYLOAD })
  })

  it('misses a payload from an older generation, handing back the current one', async () => {
    const { kv, env } = setup()
    await invalidateSnapshot(env)
    kv._store.set(SNAPSHOT_KEY, JSON.stringify(PAYLOAD))
    expect(await lookupSnapshot(env)).toEqual({ hit: false, generation: 1 })
  })

  it('misses a payload written before the generation check existed', async () => {
    const { generation: _omitted, ...legacy } = PAYLOAD
    const { env } = setup(legacy)
    expect(await lookupSnapshot(env)).toEqual({ hit: false, generation: 0 })
  })

  it('misses a payload rendered while the generation could not be read', async () => {
    const { env } = setup({ ...PAYLOAD, generation: null })
    expect(await lookupSnapshot(env)).toEqual({ hit: false, generation: 0 })
  })

  it('misses with the current generation when nothing is cached', async () => {
    const { env } = setup()
    expect(await lookupSnapshot(env)).toEqual({ hit: false, generation: 0 })
  })

  it('serves the cached payload unverified when the generation cannot be read, logged as an error', async () => {
    const { kv } = setup({ ...PAYLOAD, generation: 7 })
    const lookup = await lookupSnapshot({ CATALOG_DB: makeFailingD1(), CATALOG_KV: kv })
    expect(lookup).toEqual({ hit: true, payload: { ...PAYLOAD, generation: 7 } })
    expect(logged(error)).toMatch(
      new RegExp(`generation read failed — serving the cached snapshot unverified.*at most ${SNAPSHOT_TTL_SECONDS} s.*database unavailable`),
    )
  })

  it('misses with no generation when it cannot be read and nothing is cached', async () => {
    const lookup = await lookupSnapshot({ CATALOG_DB: makeFailingD1(), CATALOG_KV: makeKV() })
    expect(lookup).toEqual({ hit: false, generation: null })
    expect(logged(error)).toMatch(/generation read failed — rendering from D1.*database unavailable/)
  })

  it('treats a database without migration 0062 as a generation it cannot read', async () => {
    const { sqlite, env } = setup(PAYLOAD)
    sqlite.prepare('DROP TABLE catalog_snapshot_generation').run()
    expect(await lookupSnapshot(env)).toEqual({ hit: true, payload: PAYLOAD })
    expect(logged(error)).toMatch(/generation read failed.*no such table/)
  })
})

describe('writeSnapshot', () => {
  it('puts the payload with the snapshot TTL', async () => {
    const kv = makeKV()
    await writeSnapshot({ CATALOG_KV: kv }, PAYLOAD)
    expect(kv.put).toHaveBeenCalledWith(SNAPSHOT_KEY, JSON.stringify(PAYLOAD), {
      expirationTtl: SNAPSHOT_TTL_SECONDS,
    })
  })

  it('logs a failing put as a warning and does not throw', async () => {
    await writeSnapshot({ CATALOG_KV: makeFailingKV() }, PAYLOAD)
    expect(logged(warn)).toMatch(/KV snapshot write failed — not cached.*KV namespace not found/)
    expect(error).not.toHaveBeenCalled()
  })
})

describe('invalidateSnapshot', () => {
  it('bumps the generation and deletes the entry, logging nothing', async () => {
    const { kv, env } = setup(PAYLOAD)
    await invalidateSnapshot(env)
    expect(await readSnapshotGeneration(env.CATALOG_DB)).toBe(1)
    expect(kv._store.has(SNAPSHOT_KEY)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('does nothing without a KV binding', async () => {
    const { env } = setup()
    await invalidateSnapshot({ CATALOG_DB: env.CATALOG_DB })
    expect(await readSnapshotGeneration(env.CATALOG_DB)).toBe(0)
  })

  it('logs a failed delete as a warning when the bump landed, since the entry is then a miss', async () => {
    const { kv, env } = setup(PAYLOAD)
    await invalidateSnapshot(withFailingDelete(env))
    expect(kv._store.has(SNAPSHOT_KEY)).toBe(true)
    expect(await lookupSnapshot(env)).toEqual({ hit: false, generation: 1 })
    expect(logged(warn)).toMatch(/KV snapshot delete failed — the generation bump landed.*KV delete timed out/)
    expect(error).not.toHaveBeenCalled()
  })

  it('logs a failed bump as an error even when the delete landed', async () => {
    const { sqlite, kv, env } = setup(PAYLOAD)
    sqlite.prepare('DROP TABLE catalog_snapshot_generation').run()
    await invalidateSnapshot(env)
    expect(kv._store.has(SNAPSHOT_KEY)).toBe(false)
    expect(logged(error)).toMatch(/snapshot generation bump failed — the KV entry was deleted.*no such table/)
  })

  it('logs both failing as an error naming the TTL bound, and does not throw', async () => {
    const { kv } = setup(PAYLOAD)
    await invalidateSnapshot({ CATALOG_DB: makeFailingD1(), CATALOG_KV: makeFailingKV() })
    expect(kv._store.has(SNAPSHOT_KEY)).toBe(true)
    const line = logged(error)
    expect(line).toMatch(new RegExp(`snapshot invalidation failed.*at most ${SNAPSHOT_TTL_SECONDS} s`))
    expect(line).toMatch(/Generation bump: D1_ERROR: database unavailable\. KV delete: KV namespace not found\./)
  })
})
