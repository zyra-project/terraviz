/**
 * Unit tests for `publisher-mutations` — the user-administration
 * store helper. Covers list filters + pagination, the partial-update
 * path with is_admin syncing, the audit row each update writes, and
 * the two guardrails (self-lockout, last-admin).
 */

import { describe, expect, it } from 'vitest'
import {
  countActiveAdmins,
  getPublisher,
  listPublishers,
  updatePublisher,
} from './publisher-mutations'
import type { PublisherRow } from './publisher-store'
import { asD1, seedFixtures } from './test-helpers'
import type Database from 'better-sqlite3'

interface SeedPublisher {
  id: string
  email: string
  display_name?: string
  role: string
  is_admin?: number
  status: string
  created_at?: string
}

function seedPublisher(sqlite: Database.Database, p: SeedPublisher): void {
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, affiliation, org_id, role, is_admin, status, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      p.id,
      p.email,
      p.display_name ?? p.email.split('@')[0],
      p.role,
      p.is_admin ?? (p.role === 'admin' ? 1 : 0),
      p.status,
      p.created_at ?? '2026-01-01T00:00:00.000Z',
    )
}

function actor(overrides: Partial<PublisherRow> = {}): PublisherRow {
  return {
    id: 'PUB-ADMIN',
    email: 'admin@example.com',
    display_name: 'Admin',
    affiliation: null,
    org_id: null,
    role: 'admin',
    is_admin: 1,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('listPublishers', () => {
  it('filters by status and role and matches email/name substrings', async () => {
    const sqlite = seedFixtures({ count: 0 })
    seedPublisher(sqlite, { id: 'PUB01', email: 'alice@noaa.gov', role: 'admin', status: 'active' })
    seedPublisher(sqlite, { id: 'PUB02', email: 'bob@example.com', role: 'publisher', status: 'pending' })
    seedPublisher(sqlite, { id: 'PUB03', email: 'carol@example.com', role: 'publisher', status: 'active' })
    const db = asD1(sqlite)

    const pending = await listPublishers(db, { status: 'pending' })
    expect(pending.publishers.map(p => p.id)).toEqual(['PUB02'])

    const publishers = await listPublishers(db, { role: 'publisher' })
    expect(publishers.publishers.map(p => p.id)).toEqual(['PUB02', 'PUB03'])

    const search = await listPublishers(db, { q: 'CAROL' })
    expect(search.publishers.map(p => p.id)).toEqual(['PUB03'])
  })

  it('paginates with a cursor and reports next_cursor', async () => {
    const sqlite = seedFixtures({ count: 0 })
    for (const id of ['PUB01', 'PUB02', 'PUB03']) {
      seedPublisher(sqlite, { id, email: `${id}@e`, role: 'publisher', status: 'active' })
    }
    const db = asD1(sqlite)

    const page1 = await listPublishers(db, { limit: 2 })
    expect(page1.publishers.map(p => p.id)).toEqual(['PUB01', 'PUB02'])
    expect(page1.next_cursor).toBe('PUB02')

    const page2 = await listPublishers(db, { limit: 2, cursor: page1.next_cursor! })
    expect(page2.publishers.map(p => p.id)).toEqual(['PUB03'])
    expect(page2.next_cursor).toBeNull()
  })
})

describe('countActiveAdmins', () => {
  it('counts active admins and honors the exception', async () => {
    const sqlite = seedFixtures({ count: 0 })
    seedPublisher(sqlite, { id: 'PUB01', email: 'a@e', role: 'admin', status: 'active' })
    seedPublisher(sqlite, { id: 'PUB02', email: 'b@e', role: 'admin', status: 'active' })
    seedPublisher(sqlite, { id: 'PUB03', email: 'c@e', role: 'admin', status: 'suspended' })
    const db = asD1(sqlite)
    expect(await countActiveAdmins(db)).toBe(2)
    expect(await countActiveAdmins(db, 'PUB01')).toBe(1)
  })
})

describe('updatePublisher', () => {
  it('approves a pending account and writes an approve audit row', async () => {
    const sqlite = seedFixtures({ count: 0 })
    seedPublisher(sqlite, { id: 'PUB-ADMIN', email: 'admin@example.com', role: 'admin', status: 'active' })
    seedPublisher(sqlite, { id: 'PUB-NEW', email: 'new@example.com', role: 'publisher', status: 'pending' })
    const db = asD1(sqlite)

    const res = await updatePublisher(db, 'PUB-NEW', { status: 'active' }, actor())
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.publisher.status).toBe('active')

    const audit = await db
      .prepare(`SELECT action, subject_kind, subject_id FROM audit_events ORDER BY id DESC LIMIT 1`)
      .first<{ action: string; subject_kind: string; subject_id: string }>()
    expect(audit).toMatchObject({
      action: 'publisher.approve',
      subject_kind: 'publisher',
      subject_id: 'PUB-NEW',
    })
  })

  it('promotes to admin and syncs the is_admin mirror', async () => {
    const sqlite = seedFixtures({ count: 0 })
    seedPublisher(sqlite, { id: 'PUB-ADMIN', email: 'admin@example.com', role: 'admin', status: 'active' })
    seedPublisher(sqlite, { id: 'PUB-P', email: 'p@example.com', role: 'publisher', status: 'active' })
    const db = asD1(sqlite)

    const res = await updatePublisher(db, 'PUB-P', { role: 'admin' }, actor())
    expect(res.ok).toBe(true)
    const row = await getPublisher(db, 'PUB-P')
    expect(row?.role).toBe('admin')
    expect(row?.is_admin).toBe(1)
  })

  it('404s for an unknown publisher', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const db = asD1(sqlite)
    const res = await updatePublisher(db, 'NOPE', { status: 'active' }, actor())
    expect(res).toMatchObject({ ok: false, status: 404, error: 'not_found' })
  })

  it('rejects with no_changes when the patch is empty', async () => {
    const sqlite = seedFixtures({ count: 0 })
    seedPublisher(sqlite, { id: 'PUB-P', email: 'p@example.com', role: 'publisher', status: 'active' })
    const db = asD1(sqlite)
    const res = await updatePublisher(db, 'PUB-P', {}, actor())
    expect(res).toMatchObject({ ok: false, status: 400, error: 'no_changes' })
  })

  it('writes no audit row for a profile-only edit (no role/status change)', async () => {
    const sqlite = seedFixtures({ count: 0 })
    seedPublisher(sqlite, { id: 'PUB-ADMIN', email: 'admin@example.com', role: 'admin', status: 'active' })
    seedPublisher(sqlite, { id: 'PUB-P', email: 'p@example.com', role: 'publisher', status: 'active' })
    const db = asD1(sqlite)
    const res = await updatePublisher(db, 'PUB-P', { display_name: 'Renamed' }, actor())
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.publisher.display_name).toBe('Renamed')
    const audit = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE subject_id = 'PUB-P'`)
      .first<{ n: number }>()
    expect(audit?.n).toBe(0)
  })

  it('blocks self-lockout: an admin cannot demote their own account', async () => {
    const sqlite = seedFixtures({ count: 0 })
    seedPublisher(sqlite, { id: 'PUB-ADMIN', email: 'admin@example.com', role: 'admin', status: 'active' })
    seedPublisher(sqlite, { id: 'PUB-OTHER', email: 'other@example.com', role: 'admin', status: 'active' })
    const db = asD1(sqlite)
    const res = await updatePublisher(db, 'PUB-ADMIN', { role: 'publisher' }, actor())
    expect(res).toMatchObject({ ok: false, status: 409, error: 'self_lockout' })
  })

  it('blocks self-lockout: an admin cannot suspend themselves', async () => {
    const sqlite = seedFixtures({ count: 0 })
    seedPublisher(sqlite, { id: 'PUB-ADMIN', email: 'admin@example.com', role: 'admin', status: 'active' })
    seedPublisher(sqlite, { id: 'PUB-OTHER', email: 'other@example.com', role: 'admin', status: 'active' })
    const db = asD1(sqlite)
    const res = await updatePublisher(db, 'PUB-ADMIN', { status: 'suspended' }, actor())
    expect(res).toMatchObject({ ok: false, status: 409, error: 'self_lockout' })
  })

  it('blocks demoting the last active admin', async () => {
    const sqlite = seedFixtures({ count: 0 })
    // Only one active admin in the deploy — and the actor is a
    // different (hypothetical) admin so the self-lockout guard is not
    // what trips here.
    seedPublisher(sqlite, { id: 'PUB-LAST', email: 'last@example.com', role: 'admin', status: 'active' })
    const db = asD1(sqlite)
    const res = await updatePublisher(db, 'PUB-LAST', { role: 'publisher' }, actor({ id: 'PUB-GHOST' }))
    expect(res).toMatchObject({ ok: false, status: 409, error: 'last_admin' })
  })

  it('allows demoting an admin while another active admin remains', async () => {
    const sqlite = seedFixtures({ count: 0 })
    seedPublisher(sqlite, { id: 'PUB-A', email: 'a@example.com', role: 'admin', status: 'active' })
    seedPublisher(sqlite, { id: 'PUB-B', email: 'b@example.com', role: 'admin', status: 'active' })
    const db = asD1(sqlite)
    const res = await updatePublisher(db, 'PUB-B', { role: 'publisher' }, actor({ id: 'PUB-A' }))
    expect(res.ok).toBe(true)
    const row = await getPublisher(db, 'PUB-B')
    expect(row?.role).toBe('publisher')
    expect(row?.is_admin).toBe(0)
  })
})
