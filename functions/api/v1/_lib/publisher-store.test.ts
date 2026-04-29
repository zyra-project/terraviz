/**
 * Tests for getOrCreatePublisher.
 *
 * Coverage:
 *   - Lookup by email returns an existing row unchanged.
 *   - JIT defaults: user → community/pending, service → service/active,
 *     dev-bypass → staff/active+admin.
 *   - Display name fallback uses the local-part of the email.
 *   - The minted ULID is 26 chars in Crockford-base32.
 */

import { describe, expect, it } from 'vitest'
import { getOrCreatePublisher } from './publisher-store'
import { newUlid } from './ulid'
import { asD1, seedFixtures } from './test-helpers'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

describe('newUlid', () => {
  it('produces a 26-char Crockford-base32 string', () => {
    const id = newUlid()
    expect(id).toHaveLength(26)
    for (const ch of id) expect(ALPHABET).toContain(ch)
  })

  it('is monotonic-ish across calls', () => {
    const a = newUlid()
    const b = newUlid()
    expect(a).not.toBe(b)
  })

  it('respects an explicit timestamp for the prefix', () => {
    const a = newUlid(0)
    const b = newUlid(0)
    // Same time prefix; random suffix differs.
    expect(a.slice(0, 10)).toBe(b.slice(0, 10))
    expect(a).not.toBe(b)
  })
})

describe('getOrCreatePublisher', () => {
  it('returns an existing row by email without mutating it', async () => {
    const sqlite = seedFixtures({ count: 0 })
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('PUB000', 'staff@example.com', 'Staff Person', 'staff', 1, 'active', '2026-01-01T00:00:00.000Z')
    const db = asD1(sqlite)

    const row = await getOrCreatePublisher(db, {
      email: 'staff@example.com',
      sub: 'sub-1',
      type: 'user',
    })
    expect(row.id).toBe('PUB000')
    expect(row.role).toBe('staff')
    expect(row.is_admin).toBe(1)

    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM publishers').get() as {
      n: number
    }
    expect(count.n).toBe(1)
  })

  it('JIT-provisions community/pending for a new user identity', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const db = asD1(sqlite)
    const row = await getOrCreatePublisher(db, {
      email: 'newcomer@example.com',
      sub: 'sub-2',
      type: 'user',
    })
    expect(row.role).toBe('community')
    expect(row.is_admin).toBe(0)
    expect(row.status).toBe('pending')
    expect(row.email).toBe('newcomer@example.com')
    expect(row.display_name).toBe('newcomer')
    expect(row.id).toHaveLength(26)
  })

  it('JIT-provisions service/active for a service token', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const db = asD1(sqlite)
    const row = await getOrCreatePublisher(db, {
      email: 'svc-abc@service.local',
      sub: 'svc-abc',
      type: 'service',
    })
    expect(row.role).toBe('service')
    expect(row.is_admin).toBe(0)
    expect(row.status).toBe('active')
  })

  it('JIT-provisions staff/active+admin under dev bypass', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const db = asD1(sqlite)
    const row = await getOrCreatePublisher(
      db,
      { email: 'dev@localhost', sub: 'dev-local', type: 'user' },
      { devBypass: true },
    )
    expect(row.role).toBe('staff')
    expect(row.is_admin).toBe(1)
    expect(row.status).toBe('active')
  })

  it('persists the new row so a second call returns it unchanged', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const db = asD1(sqlite)
    const first = await getOrCreatePublisher(db, {
      email: 'twice@example.com',
      sub: 'sub-3',
      type: 'user',
    })
    const second = await getOrCreatePublisher(db, {
      email: 'twice@example.com',
      sub: 'sub-3',
      type: 'user',
    })
    expect(second.id).toBe(first.id)
    expect(second.created_at).toBe(first.created_at)
  })

  it('handles a concurrent first-hit without raising the UNIQUE constraint', async () => {
    // Two requests for the same email both miss the SELECT and
    // race to INSERT. The ON CONFLICT(email) DO NOTHING clause
    // turns the loser into a no-op; the re-SELECT then returns
    // whichever row won. End result: both callers get the same
    // publisher with no surface-level error.
    const sqlite = seedFixtures({ count: 0 })
    const db = asD1(sqlite)
    const identity = {
      email: 'race@example.com',
      sub: 'sub-race',
      type: 'user' as const,
    }
    const [a, b] = await Promise.all([
      getOrCreatePublisher(db, identity),
      getOrCreatePublisher(db, identity),
    ])
    expect(a.email).toBe('race@example.com')
    expect(b.email).toBe('race@example.com')
    expect(a.id).toBe(b.id)
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM publishers').get() as {
      n: number
    }
    expect(count.n).toBe(1)
  })
})
