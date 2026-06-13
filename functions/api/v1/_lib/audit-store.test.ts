/**
 * Unit tests for the `audit-store` helper. The four route-layer
 * call sites also have integration tests in
 * `functions/api/v1/publish/datasets.test.ts` that assert on the
 * resulting row shape; these tests cover the helper in isolation —
 * specifically the no-throw guarantee on a failing insert.
 */

import { describe, expect, it } from 'vitest'
import { writeAuditEvent, writeDatasetAudit } from './audit-store'
import { asD1, seedFixtures } from './test-helpers'

function makeDb() {
  return asD1(seedFixtures({ count: 0 }))
}

describe('writeAuditEvent', () => {
  it('inserts a row with the supplied fields and a generated ULID', async () => {
    const db = makeDb()
    const id = await writeAuditEvent(db, {
      actor_kind: 'publisher',
      actor_id: 'PUB123',
      action: 'dataset.create',
      subject_kind: 'dataset',
      subject_id: 'DS01',
      metadata_json: JSON.stringify({ slug: 'hello' }),
    })
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)

    const row = await db
      .prepare(
        `SELECT actor_kind, actor_id, action, subject_kind, subject_id, metadata_json
           FROM audit_events WHERE id = ?`,
      )
      .bind(id!)
      .first<{
        actor_kind: string
        actor_id: string
        action: string
        subject_kind: string
        subject_id: string
        metadata_json: string
      }>()
    expect(row).not.toBeNull()
    expect(row!.actor_kind).toBe('publisher')
    expect(row!.actor_id).toBe('PUB123')
    expect(row!.action).toBe('dataset.create')
    expect(row!.subject_id).toBe('DS01')
    expect(JSON.parse(row!.metadata_json)).toEqual({ slug: 'hello' })
  })

  it('returns null and does not throw when the insert fails', async () => {
    // Use a fake D1 that rejects every prepare/run pair, so we can
    // verify the helper swallows the error rather than re-raising
    // (the user-facing mutation has already succeeded).
    const failingDb = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error('simulated D1 failure')
          },
        }),
      }),
    } as unknown as D1Database

    const consoleSpy = console.error
    let captured: unknown = null
    console.error = (...args: unknown[]) => {
      captured = args
    }
    try {
      const id = await writeAuditEvent(failingDb, {
        actor_kind: 'publisher',
        actor_id: 'PUB123',
        action: 'dataset.create',
        subject_kind: 'dataset',
        subject_id: 'DS01',
      })
      expect(id).toBeNull()
      expect(captured).not.toBeNull()
    } finally {
      console.error = consoleSpy
    }
  })
})

describe('writeDatasetAudit', () => {
  it('stamps actor_kind=publisher and subject_kind=dataset', async () => {
    const db = makeDb()
    const id = await writeDatasetAudit(
      db,
      { id: 'PUB456', role: 'admin' },
      'dataset.publish',
      'DS02',
      { slug: 'auto' },
    )
    const row = await db
      .prepare(
        `SELECT actor_kind, subject_kind, metadata_json FROM audit_events WHERE id = ?`,
      )
      .bind(id!)
      .first<{ actor_kind: string; subject_kind: string; metadata_json: string }>()
    expect(row!.actor_kind).toBe('publisher')
    expect(row!.subject_kind).toBe('dataset')
    expect(JSON.parse(row!.metadata_json)).toEqual({ slug: 'auto' })
  })

  it('writes a NULL metadata_json when no metadata is supplied', async () => {
    const db = makeDb()
    const id = await writeDatasetAudit(
      db,
      { id: 'PUB456', role: 'admin' },
      'dataset.retract',
      'DS03',
    )
    const row = await db
      .prepare(`SELECT metadata_json FROM audit_events WHERE id = ?`)
      .bind(id!)
      .first<{ metadata_json: string | null }>()
    expect(row!.metadata_json).toBeNull()
  })
})
