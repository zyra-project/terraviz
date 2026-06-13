/**
 * Tests for the hero_override singleton helpers (§9.1 admin store).
 *
 * Coverage:
 *   - getHeroOverride returns null when empty, the row when set.
 *   - setHeroOverride upserts the singleton (a second set replaces).
 *   - setHeroOverride 404s an unknown dataset_id.
 *   - clearHeroOverride is idempotent.
 *   - toPublicHero shapes with/without headline.
 *   - validateHeroInput enforces the mandatory-window contract.
 */

import { describe, expect, it } from 'vitest'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'
import { asD1 } from './test-helpers'
import {
  clearHeroOverride,
  getHeroOverride,
  HERO_HEADLINE_MAX_LEN,
  setHeroOverride,
  toPublicHero,
  validateHeroInput,
} from './hero-override-store'
import type { PublisherRow } from './publisher-store'

const TS = '2026-05-01T00:00:00.000Z'

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

function setupDb(datasetCount = 2) {
  const sqlite = freshMigratedDb()
  sqlite
    .prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
       VALUES ('NODE000', 'T', 'https://t', 'k', ?)`,
    )
    .run(TS)
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, TS)
  const ids: string[] = []
  for (let i = 0; i < datasetCount; i++) {
    const id = `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)
    ids.push(id)
    sqlite
      .prepare(
        `INSERT INTO datasets (id, slug, origin_node, title, abstract, format, data_ref,
                               weight, visibility, is_hidden, schema_version,
                               created_at, updated_at, published_at, publisher_id)
         VALUES (?, ?, 'NODE000', ?, ?, 'video/mp4', 'vimeo:1',
                 0, 'public', 0, 1, ?, ?, ?, ?)`,
      )
      .run(id, `dataset-${i}`, `Dataset ${i}`, 'Abstract.', TS, TS, TS, ADMIN.id)
  }
  return { db: asD1(sqlite), ids }
}

const validInput = (datasetId: string) => ({
  dataset_id: datasetId,
  window_start: '2026-05-01T00:00:00.000Z',
  window_end: '2026-06-01T00:00:00.000Z',
  headline: null,
})

describe('getHeroOverride / setHeroOverride / clearHeroOverride', () => {
  it('returns null when no override is set', async () => {
    const { db } = setupDb()
    expect(await getHeroOverride(db)).toBeNull()
  })

  it('sets and reads back the singleton', async () => {
    const { db, ids } = setupDb()
    const res = await setHeroOverride(db, ADMIN, validInput(ids[0]), TS)
    expect(res.ok).toBe(true)
    const row = await getHeroOverride(db)
    expect(row).toMatchObject({ dataset_id: ids[0], set_by: ADMIN.id, set_at: TS })
  })

  it('a second set replaces the first (singleton)', async () => {
    const { db, ids } = setupDb()
    await setHeroOverride(db, ADMIN, validInput(ids[0]), TS)
    await setHeroOverride(db, ADMIN, { ...validInput(ids[1]), headline: 'New' }, TS)
    const row = await getHeroOverride(db)
    expect(row?.dataset_id).toBe(ids[1])
    expect(row?.headline).toBe('New')
  })

  it('404s an unknown dataset_id', async () => {
    const { db } = setupDb()
    const res = await setHeroOverride(db, ADMIN, validInput('GHOSTGHOSTGHOSTGHOSTGHOST'), TS)
    expect(res).toMatchObject({ ok: false, status: 404, error: 'not_found' })
  })

  it('clear is idempotent', async () => {
    const { db, ids } = setupDb()
    await setHeroOverride(db, ADMIN, validInput(ids[0]), TS)
    await clearHeroOverride(db)
    await clearHeroOverride(db) // again — no throw
    expect(await getHeroOverride(db)).toBeNull()
  })

  it('retiring the pinned dataset cascades the override away', async () => {
    const { db, ids } = setupDb()
    await setHeroOverride(db, ADMIN, validInput(ids[0]), TS)
    await db.prepare(`DELETE FROM datasets WHERE id = ?`).bind(ids[0]).run()
    expect(await getHeroOverride(db)).toBeNull()
  })
})

describe('toPublicHero', () => {
  it('shapes a row, including the optional headline', () => {
    expect(
      toPublicHero({ dataset_id: 'a', window_start: 's', window_end: 'e', headline: 'Hi', set_by: 'p', set_at: TS }),
    ).toEqual({ datasetId: 'a', window: { start: 's', end: 'e' }, headline: 'Hi' })
  })
  it('omits a null headline', () => {
    const out = toPublicHero({ dataset_id: 'a', window_start: 's', window_end: 'e', headline: null, set_by: 'p', set_at: TS })
    expect(out).not.toHaveProperty('headline')
  })
})

describe('validateHeroInput', () => {
  it('accepts a valid body and trims the headline', () => {
    const res = validateHeroInput({ dataset_id: 'a', window: { start: '2026-05-01', end: '2026-06-01' }, headline: '  Hi  ' })
    expect(res).toEqual({ ok: true, value: { dataset_id: 'a', window_start: '2026-05-01', window_end: '2026-06-01', headline: 'Hi' } })
  })

  it('requires dataset_id and both window bounds', () => {
    const res = validateHeroInput({})
    expect(res.ok).toBe(false)
    if (!res.ok) {
      const fields = res.errors.map(e => e.field)
      expect(fields).toContain('dataset_id')
      expect(fields).toContain('window.start')
      expect(fields).toContain('window.end')
    }
  })

  it('rejects unparseable window bounds', () => {
    const res = validateHeroInput({ dataset_id: 'a', window: { start: 'nope', end: 'also-nope' } })
    expect(res.ok).toBe(false)
  })

  it('rejects start >= end', () => {
    const res = validateHeroInput({ dataset_id: 'a', window: { start: '2026-06-01', end: '2026-05-01' } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.some(e => e.code === 'invalid_range')).toBe(true)
  })

  it('rejects an over-long headline', () => {
    const res = validateHeroInput({
      dataset_id: 'a',
      window: { start: '2026-05-01', end: '2026-06-01' },
      headline: 'x'.repeat(HERO_HEADLINE_MAX_LEN + 1),
    })
    expect(res.ok).toBe(false)
  })
})
