// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the catalog snapshot cache's read side.
 *
 * Coverage:
 *   - No binding: a miss.
 *   - A stored snapshot comes back as written.
 *   - A KV read that rejects is a miss, not a throw, and is logged so
 *     the broken binding shows up in Workers Logs (the 2026-11-09
 *     NOAA-GSL outage: `CATALOG_KV` bound to a deleted namespace
 *     turned every catalog read into a 500).
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { readSnapshot, SNAPSHOT_KEY, type SnapshotPayload } from './snapshot'
import { makeFailingKV, makeKV } from './test-helpers'

const PAYLOAD: SnapshotPayload = {
  etag: '"abc"',
  generatedAt: '2026-11-09T00:00:00.000Z',
  body: '{"datasets":[]}',
  contentType: 'application/json; charset=utf-8',
}

describe('readSnapshot', () => {
  let warn: MockInstance<typeof console.warn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

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
