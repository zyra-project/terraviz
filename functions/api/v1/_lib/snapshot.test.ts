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
 *   - The generation: a random token, never shared by two databases,
 *     replaced by each invalidation; a missing row is given a fresh
 *     token on read, never a fixed value that could come back.
 *   - lookupSnapshot: a payload is served only under the current
 *     generation. An older stamp, no stamp (an entry from before the
 *     check) and a `null` stamp are misses. When the generation cannot
 *     be read, a payload this code wrote is served unverified, logged
 *     as an error; an entry from before the check, which has no TTL,
 *     is not.
 *   - The isolate copy: served only in KV's place (its put failed),
 *     under the current generation or unverified when D1 cannot be
 *     read, and within the TTL; a copy whose put landed is never
 *     served, so a KV delete retires it; a stale KV entry beside a
 *     current copy is deleted once per generation; a render under no
 *     generation does not replace a copy.
 *   - writeSnapshot: every put carries the TTL that bounds the cases
 *     the check cannot cover; a failing put is a warning, not a throw.
 *   - invalidateSnapshot: generation, then delete, with or without a
 *     KV binding; each failure is logged at the level of what it
 *     exposes, a missing table names its migration, and none throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  buildAndCacheSnapshot,
  invalidateSnapshot,
  lookupSnapshot,
  readSnapshot,
  readSnapshotGeneration,
  resetSnapshotIsolateCopyForTests,
  SNAPSHOT_KEY,
  SNAPSHOT_TTL_SECONDS,
  writeSnapshot,
  type SnapshotPayload,
  type StoredSnapshot,
} from './snapshot'
import { asD1, makeFailingD1, makeFailingKV, makeKV, seedFixtures } from './test-helpers'

const BASE: Omit<SnapshotPayload, 'generation'> = {
  etag: '"abc"',
  generatedAt: '2026-11-09T00:00:00.000Z',
  body: '{"datasets":[]}',
  contentType: 'application/json; charset=utf-8',
}

let warn: MockInstance<typeof console.warn>
let error: MockInstance<typeof console.error>
beforeEach(() => {
  resetSnapshotIsolateCopyForTests()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  error.mockRestore()
  vi.useRealTimers()
})

function logged(spy: MockInstance<typeof console.warn>): string {
  return spy.mock.calls.map(c => c.join(' ')).join('\n')
}

/** A migrated database, its current generation, and a KV holding `stored` if given. */
async function setup(stored?: StoredSnapshot) {
  const sqlite = seedFixtures({ count: 0 })
  const kv = makeKV()
  if (stored) kv._store.set(SNAPSHOT_KEY, JSON.stringify(stored))
  const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: kv }
  return { sqlite, kv, env, generation: await readSnapshotGeneration(env.CATALOG_DB) }
}

/** `env` with a KV over the same store whose delete rejects. */
function withFailingDelete<E extends { CATALOG_KV: ReturnType<typeof makeKV> }>(env: E): E {
  const kv = Object.create(env.CATALOG_KV) as ReturnType<typeof makeKV>
  kv.delete = vi.fn(async () => {
    throw new Error('KV delete timed out')
  })
  return { ...env, CATALOG_KV: kv }
}

/** `env` with a KV over the same store whose put rejects: the free tier's daily writes spent. */
function withFailingPut<E extends { CATALOG_KV: ReturnType<typeof makeKV> }>(env: E): E {
  const kv = Object.create(env.CATALOG_KV) as ReturnType<typeof makeKV>
  kv.put = vi.fn(async () => {
    throw new Error('KV put limit exceeded')
  })
  return { ...env, CATALOG_KV: kv }
}

const render = (body: string) => async () => ({ body, contentType: 'application/json', etag: `"${body}"` })

describe('readSnapshot', () => {
  it('is a miss when CATALOG_KV is not bound', async () => {
    expect(await readSnapshot({})).toBeNull()
  })

  it('returns a stored snapshot', async () => {
    const kv = makeKV()
    const payload: SnapshotPayload = { ...BASE, generation: 'g' }
    kv._store.set(SNAPSHOT_KEY, JSON.stringify(payload))
    expect(await readSnapshot({ CATALOG_KV: kv })).toEqual(payload)
    expect(warn).not.toHaveBeenCalled()
  })

  it('treats a KV read that rejects as a miss, and logs it', async () => {
    expect(await readSnapshot({ CATALOG_KV: makeFailingKV() })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0].join(' ')).toMatch(/KV snapshot read failed.*KV namespace not found/)
  })
})

describe('snapshot generation', () => {
  it('is a random token that each invalidation replaces', async () => {
    const { env, generation: first } = await setup()
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    await invalidateSnapshot(env)
    const second = await readSnapshotGeneration(env.CATALOG_DB)
    await invalidateSnapshot(env)
    const third = await readSnapshotGeneration(env.CATALOG_DB)
    expect(second).toMatch(/^[0-9a-f]{32}$/)
    expect(new Set([first, second, third]).size).toBe(3)
  })

  it('is never shared by two databases, so a stamp cannot match another timeline', async () => {
    const a = await setup()
    const b = await setup()
    expect(a.generation).not.toBe(b.generation)
  })

  it('gives a missing row a fresh token on read, never a fixed value that could come back', async () => {
    const { sqlite, env, generation } = await setup()
    sqlite.prepare('DELETE FROM catalog_snapshot_generation').run()
    const first = await readSnapshotGeneration(env.CATALOG_DB)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(first).not.toBe(generation)
    expect(await readSnapshotGeneration(env.CATALOG_DB)).toBe(first)
    sqlite.prepare('DELETE FROM catalog_snapshot_generation').run()
    expect(await readSnapshotGeneration(env.CATALOG_DB)).not.toBe(first)
  })
})

describe('lookupSnapshot', () => {
  it('serves a payload stamped with the current generation', async () => {
    const { kv, env, generation } = await setup()
    const payload = { ...BASE, generation }
    kv._store.set(SNAPSHOT_KEY, JSON.stringify(payload))
    expect(await lookupSnapshot(env)).toEqual({ hit: true, payload })
  })

  it('misses a payload from an older generation, handing back the current one', async () => {
    const { kv, env, generation: old } = await setup()
    await invalidateSnapshot(env)
    kv._store.set(SNAPSHOT_KEY, JSON.stringify({ ...BASE, generation: old }))
    const current = await readSnapshotGeneration(env.CATALOG_DB)
    expect(await lookupSnapshot(env)).toEqual({ hit: false, generation: current })
  })

  it('misses a payload written before the generation check existed', async () => {
    const { env, generation } = await setup(BASE)
    expect(await lookupSnapshot(env)).toEqual({ hit: false, generation })
  })

  it('misses a payload rendered while the generation could not be read', async () => {
    const { env, generation } = await setup({ ...BASE, generation: null })
    expect(await lookupSnapshot(env)).toEqual({ hit: false, generation })
  })

  it('misses with the current generation when nothing is cached', async () => {
    const { env, generation } = await setup()
    expect(await lookupSnapshot(env)).toEqual({ hit: false, generation })
  })

  it('serves a payload this code wrote unverified when the generation cannot be read, logged as an error', async () => {
    const { kv } = await setup({ ...BASE, generation: 'stamp' })
    const lookup = await lookupSnapshot({ CATALOG_DB: makeFailingD1(), CATALOG_KV: kv })
    expect(lookup).toEqual({ hit: true, payload: { ...BASE, generation: 'stamp' } })
    expect(logged(error)).toMatch(
      new RegExp(`generation read failed — serving the cached snapshot unverified.*at most ${SNAPSHOT_TTL_SECONDS} s.*database unavailable`),
    )
  })

  it('never serves an entry from before the check unverified, since it has no TTL', async () => {
    const { kv } = await setup(BASE)
    const lookup = await lookupSnapshot({ CATALOG_DB: makeFailingD1(), CATALOG_KV: kv })
    expect(lookup).toEqual({ hit: false, generation: null })
    expect(logged(error)).toMatch(/generation read failed — rendering from D1/)
  })

  it('misses with no generation when it cannot be read and nothing is cached', async () => {
    const lookup = await lookupSnapshot({ CATALOG_DB: makeFailingD1(), CATALOG_KV: makeKV() })
    expect(lookup).toEqual({ hit: false, generation: null })
    expect(logged(error)).toMatch(/generation read failed — rendering from D1.*database unavailable/)
  })

  it('names the migration when the table is missing', async () => {
    const { sqlite, env } = await setup({ ...BASE, generation: null })
    sqlite.prepare('DROP TABLE catalog_snapshot_generation').run()
    expect(await lookupSnapshot(env)).toEqual({ hit: true, payload: { ...BASE, generation: null } })
    expect(logged(error)).toMatch(/no such table.*migration 0062 has not been applied.*wrangler d1 migrations apply CATALOG_DB --remote/)
  })
})

describe('the isolate copy', () => {
  it('serves the last render under the current generation when it could not reach KV', async () => {
    const { env, generation } = await setup()
    const failingPut = withFailingPut(env)
    const built = await buildAndCacheSnapshot(failingPut, generation, render('one'))
    expect(await lookupSnapshot(failingPut)).toEqual({ hit: true, payload: built })
    const noKV = { CATALOG_DB: env.CATALOG_DB }
    expect(await lookupSnapshot(noKV)).toEqual({ hit: true, payload: built })
  })

  it('is never served once its put landed, so a KV delete retires it', async () => {
    const { kv, env, generation } = await setup()
    await buildAndCacheSnapshot(env, generation, render('one'))
    // The generation write of an invalidation failed; its delete landed.
    kv._store.delete(SNAPSHOT_KEY)
    expect(await lookupSnapshot(env)).toEqual({ hit: false, generation })
  })

  it('stops serving it once the generation changes', async () => {
    const { env, generation } = await setup()
    const noKV = { CATALOG_DB: env.CATALOG_DB }
    await buildAndCacheSnapshot(noKV, generation, render('one'))
    await invalidateSnapshot(noKV)
    expect((await lookupSnapshot(noKV)).hit).toBe(false)
  })

  it('stops serving it once it is older than the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T00:00:00.000Z'))
    const { env, generation } = await setup()
    const noKV = { CATALOG_DB: env.CATALOG_DB }
    await buildAndCacheSnapshot(noKV, generation, render('one'))
    vi.setSystemTime(Date.now() + SNAPSHOT_TTL_SECONDS * 1000 - 1)
    expect((await lookupSnapshot(noKV)).hit).toBe(true)
    vi.setSystemTime(Date.now() + 1)
    expect((await lookupSnapshot(noKV)).hit).toBe(false)
  })

  it('keeps its copy when a later render had no generation to stamp', async () => {
    const { env, generation } = await setup()
    const noKV = { CATALOG_DB: env.CATALOG_DB }
    const one = await buildAndCacheSnapshot(noKV, generation, render('one'))
    await buildAndCacheSnapshot(noKV, null, render('two'))
    expect(await lookupSnapshot(noKV)).toEqual({ hit: true, payload: one })
  })

  it('fails open like a KV entry when the generation cannot be read', async () => {
    const { env, generation } = await setup()
    const built = await buildAndCacheSnapshot({ CATALOG_DB: env.CATALOG_DB }, generation, render('one'))
    expect(await lookupSnapshot({ CATALOG_DB: makeFailingD1() })).toEqual({ hit: true, payload: built })
    expect(logged(error)).toMatch(/generation read failed — serving the cached snapshot unverified/)
  })

  it('does not fail open with a copy whose put landed', async () => {
    const { kv, env, generation } = await setup()
    await buildAndCacheSnapshot(env, generation, render('one'))
    kv._store.delete(SNAPSHOT_KEY)
    expect(await lookupSnapshot({ CATALOG_DB: makeFailingD1(), CATALOG_KV: kv })).toEqual({
      hit: false,
      generation: null,
    })
  })

  it('deletes a stale KV entry it finds beside a current copy, once per generation', async () => {
    const { kv, env, generation: old } = await setup()
    await invalidateSnapshot(env)
    const current = await readSnapshotGeneration(env.CATALOG_DB)
    const failingPut = withFailingPut(env)
    const built = await buildAndCacheSnapshot(failingPut, current, render('one'))

    // KV answers again, still holding the pre-outage entry.
    kv._store.set(SNAPSHOT_KEY, JSON.stringify({ ...BASE, generation: old }))
    expect(await lookupSnapshot(env)).toEqual({ hit: true, payload: built })
    expect(kv._store.has(SNAPSHOT_KEY)).toBe(false)

    kv._store.set(SNAPSHOT_KEY, JSON.stringify({ ...BASE, generation: old }))
    const deletes = vi.mocked(kv.delete).mock.calls.length
    await lookupSnapshot(env)
    expect(vi.mocked(kv.delete).mock.calls.length).toBe(deletes)
  })
})

describe('writeSnapshot', () => {
  it('puts the payload with the snapshot TTL', async () => {
    const kv = makeKV()
    const payload: SnapshotPayload = { ...BASE, generation: 'g' }
    await writeSnapshot({ CATALOG_KV: kv }, payload)
    expect(kv.put).toHaveBeenCalledWith(SNAPSHOT_KEY, JSON.stringify(payload), {
      expirationTtl: SNAPSHOT_TTL_SECONDS,
    })
  })

  it('logs a failing put as a warning and does not throw', async () => {
    await writeSnapshot({ CATALOG_KV: makeFailingKV() }, { ...BASE, generation: 'g' })
    expect(logged(warn)).toMatch(/KV snapshot write failed — not cached.*KV namespace not found/)
    expect(error).not.toHaveBeenCalled()
  })
})

describe('invalidateSnapshot', () => {
  it('replaces the generation and deletes the entry, logging nothing', async () => {
    const { kv, env, generation } = await setup({ ...BASE, generation: 'g' })
    await invalidateSnapshot(env)
    expect(await readSnapshotGeneration(env.CATALOG_DB)).not.toBe(generation)
    expect(kv._store.has(SNAPSHOT_KEY)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('replaces the generation without a KV binding, since D1 can be shared with a deployment that has one', async () => {
    const { env, generation } = await setup()
    await invalidateSnapshot({ CATALOG_DB: env.CATALOG_DB })
    expect(await readSnapshotGeneration(env.CATALOG_DB)).not.toBe(generation)
    expect(error).not.toHaveBeenCalled()
  })

  it('logs a failed delete as a warning when the generation write landed, since the entry is then a miss', async () => {
    const { kv, env, generation } = await setup()
    kv._store.set(SNAPSHOT_KEY, JSON.stringify({ ...BASE, generation }))
    await invalidateSnapshot(withFailingDelete(env))
    expect(kv._store.has(SNAPSHOT_KEY)).toBe(true)
    expect((await lookupSnapshot(env)).hit).toBe(false)
    expect(logged(warn)).toMatch(/KV snapshot delete failed — the generation write landed.*KV delete timed out/)
    expect(error).not.toHaveBeenCalled()
  })

  it('logs a failed generation write as an error even when the delete landed, naming the migration', async () => {
    const { sqlite, kv, env } = await setup({ ...BASE, generation: 'g' })
    sqlite.prepare('DROP TABLE catalog_snapshot_generation').run()
    await invalidateSnapshot(env)
    expect(kv._store.has(SNAPSHOT_KEY)).toBe(false)
    const line = logged(error)
    expect(line).toMatch(/snapshot generation write failed — the KV entry was deleted, but a catalog rendered before this write still counts as current/)
    expect(line).toMatch(/isolates whose KV write failed keep their copy/)
    expect(line).toMatch(/A withheld dataset is still in the public catalog/)
    expect(line).toMatch(/no such table.*migration 0062 has not been applied.*from an up-to-date main checkout/)
  })

  it('does not claim a KV delete it never made when KV is unbound', async () => {
    await invalidateSnapshot({ CATALOG_DB: makeFailingD1() })
    expect(logged(error)).toMatch(/snapshot generation write failed — a catalog rendered before this write/)
    expect(logged(error)).not.toMatch(/KV entry was deleted/)
  })

  it('logs both failing as an error naming the TTL bound, and does not throw', async () => {
    const { kv, env } = await setup({ ...BASE, generation: 'g' })
    await invalidateSnapshot(withFailingDelete({ ...env, CATALOG_DB: makeFailingD1() }))
    expect(kv._store.has(SNAPSHOT_KEY)).toBe(true)
    const line = logged(error)
    expect(line).toMatch(new RegExp(`snapshot invalidation failed.*at most ${SNAPSHOT_TTL_SECONDS} s`))
    expect(line).toMatch(/Generation write: D1_ERROR: database unavailable\. KV delete: KV delete timed out\./)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not claim a generation write landed when CATALOG_DB is unbound', async () => {
    const { env } = await setup({ ...BASE, generation: 'g' })
    await invalidateSnapshot(withFailingDelete({ CATALOG_KV: env.CATALOG_KV }))
    expect(logged(error)).toMatch(/Generation write: CATALOG_DB is not bound\./)
    expect(logged(warn)).not.toMatch(/generation write landed/)
  })
})
