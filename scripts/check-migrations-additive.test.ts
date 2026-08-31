// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { findDestructive, findPrefixCollisions } from './check-migrations-additive'

describe('findDestructive', () => {
  it('passes additive migrations (CREATE TABLE / ADD COLUMN)', () => {
    expect(findDestructive('CREATE TABLE foo (id INTEGER PRIMARY KEY);')).toEqual([])
    expect(findDestructive('ALTER TABLE foo ADD COLUMN bar TEXT;')).toEqual([])
    expect(findDestructive('CREATE INDEX idx ON foo(bar);')).toEqual([])
  })

  it('flags DROP TABLE', () => {
    expect(findDestructive('DROP TABLE foo;')).toContain('DROP TABLE')
  })

  it('flags column drops and renames', () => {
    expect(findDestructive('ALTER TABLE foo DROP COLUMN bar;')).toContain('DROP COLUMN')
    expect(findDestructive('ALTER TABLE foo RENAME TO baz;')).toContain('ALTER ... RENAME')
  })

  it('reports a single code per statement (no overlapping ALTER…DROP duplicate)', () => {
    // ALTER TABLE ... DROP COLUMN matches both the DROP COLUMN and the
    // broader ALTER ... DROP probes; only the most-specific is kept.
    expect(findDestructive('ALTER TABLE foo DROP COLUMN bar;')).toEqual(['DROP COLUMN'])
  })

  it('flags DELETE FROM', () => {
    expect(findDestructive('DELETE FROM foo WHERE id = 1;')).toContain('DELETE FROM')
  })

  it('ignores destructive keywords inside comments', () => {
    expect(findDestructive('-- DROP TABLE foo (described, not executed)\nCREATE TABLE foo (id INT);')).toEqual([])
    expect(findDestructive('/* DROP COLUMN bar */ CREATE TABLE foo (id INT);')).toEqual([])
  })

  it('respects the reviewed-destructive opt-in marker', () => {
    const sql = '-- destructive: reviewed — post-backfill drop\nALTER TABLE foo DROP COLUMN bar;'
    expect(findDestructive(sql)).toEqual([])
  })

  it('does not false-positive on column names containing "drop"', () => {
    // A column literally named e.g. `backdrop` shouldn't trip the
    // word-boundaried DROP probe.
    expect(findDestructive('ALTER TABLE foo ADD COLUMN backdrop TEXT;')).toEqual([])
  })
})

/**
 * The `0036` pair is the reason this exists.
 *
 * Two migrations shipped under the same number. Wrangler copes — it
 * orders by leading number then by full filename, a total order — so
 * nothing is broken. The hazard is the tidy-up: `d1_migrations` keys on
 * the full filename, so renaming an applied file makes wrangler run it
 * again, and `0036_blog_cover_image.sql` is an `ALTER TABLE ... ADD
 * COLUMN` that then fails with `duplicate column name` and aborts every
 * migration behind it.
 *
 * So the shipped pair is frozen and the check guards the next one,
 * while renumbering is still free.
 */
describe('findPrefixCollisions', () => {
  const FROZEN = [['0036_a.sql', '0036_b.sql']]

  it('passes a clean sequence', () => {
    expect(findPrefixCollisions('m', ['0001_a.sql', '0002_b.sql', '0003_c.sql'], FROZEN)).toEqual([])
  })

  it('reports a number claimed twice', () => {
    const out = findPrefixCollisions('m', ['0007_a.sql', '0007_b.sql'], FROZEN)
    expect(out).toEqual([{ dir: 'm', migrationNumber: 7, files: ['0007_a.sql', '0007_b.sql'] }])
  })

  // Wrangler reads the prefix with `parseInt`, so `0043` and `43` are
  // one migration number to it. Bucketing the prefix as text filed them
  // apart and reported no collision for two files wrangler considers
  // tied. Review catch on #368.
  it('treats differently-padded prefixes as the same number', () => {
    const out = findPrefixCollisions('m', ['0043_existing.sql', '43_new.sql'], FROZEN)
    expect(out).toEqual([
      { dir: 'm', migrationNumber: 43, files: ['0043_existing.sql', '43_new.sql'] },
    ])
  })

  // The same normalization has to reach the freeze, or a shipped
  // collision could be re-reported under a different padding.
  it('honours a freeze across padding differences', () => {
    const frozen = [['0043_existing.sql', '43_new.sql']]
    expect(findPrefixCollisions('m', ['0043_existing.sql', '43_new.sql'], frozen)).toEqual([])
  })

  // Numeric ordering: a string compare would put 10 before 9.
  it('orders findings by number, not by prefix text', () => {
    const out = findPrefixCollisions(
      'm',
      ['9_a.sql', '9_b.sql', '0010_c.sql', '0010_d.sql'],
      FROZEN,
    )
    expect(out.map(c => c.migrationNumber)).toEqual([9, 10])
  })

  it('lets a frozen pair through', () => {
    expect(findPrefixCollisions('m', ['0036_a.sql', '0036_b.sql'], FROZEN)).toEqual([])
  })

  // The freeze is the exact pair, not the number. A third file under a
  // frozen number is a new collision and still has to be caught —
  // otherwise grandfathering one mistake would license every later one
  // that happened to pick the same number.
  it('still catches a third file added to a frozen number', () => {
    const out = findPrefixCollisions('m', ['0036_a.sql', '0036_b.sql', '0036_c.sql'], FROZEN)
    expect(out).toHaveLength(1)
    expect(out[0].files).toEqual(['0036_a.sql', '0036_b.sql', '0036_c.sql'])
  })

  it('ignores non-sql and unnumbered files', () => {
    expect(findPrefixCollisions('m', ['README.md', 'notes.txt', 'seed.sql'], FROZEN)).toEqual([])
  })

  // Order-independent: readdir order is not guaranteed, so a frozen set
  // must match however the directory happens to enumerate.
  it('recognises a frozen pair regardless of listing order', () => {
    expect(findPrefixCollisions('m', ['0036_b.sql', '0036_a.sql'], FROZEN)).toEqual([])
  })

  // …and regardless of the order the freeze itself is written in. The
  // first version normalized only the directory listing, so a
  // hand-written set listed out of order would have failed CI over a
  // file nobody touched. Review catch on #368.
  it('recognises a frozen set that is itself listed out of order', () => {
    const unsorted = [['0036_b.sql', '0036_a.sql']]
    expect(findPrefixCollisions('m', ['0036_a.sql', '0036_b.sql'], unsorted)).toEqual([])
    expect(findPrefixCollisions('m', ['0036_b.sql', '0036_a.sql'], unsorted)).toEqual([])
  })
})
