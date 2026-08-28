// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * check-migrations-additive — CI guard for auto-applied D1 migrations.
 *
 * The deploy job applies `migrations/**` to the remote D1 on every
 * push to `main` (see `.github/workflows/ci.yml`). Auto-apply is only
 * safe for ADDITIVE migrations — a new table/column is fine to land
 * before the new Functions deploy, and `wrangler d1 migrations apply`
 * is idempotent. DESTRUCTIVE statements (dropping a table/column,
 * renaming, deleting rows) need expand/contract choreography and a
 * human in the loop, so this check fails CI when it finds one UNLESS
 * the migration file explicitly opts in with:
 *
 *     -- destructive: reviewed
 *
 * That marker is the author asserting "I know this drops/renames/
 * deletes, and I've reasoned about the rollout." It keeps the
 * auto-apply path safe-by-default while still allowing a reviewed
 * destructive migration through.
 *
 * Scans `migrations/*.sql` and `migrations/catalog/*.sql`. Both hold
 * migrations and nothing else — the generated catalog snapshot used to
 * sit in the first of them and needed excluding by name; it now lives
 * in `schema/`, which this never scans.
 *
 * Also fails when two migrations claim the same number. That is not a
 * correctness bug in itself — wrangler orders by leading number and
 * breaks ties on the full filename, so the sequence stays deterministic
 * — but it is a trap, because the obvious repair is unsafe. See
 * `FROZEN_COLLISIONS`.
 *
 * Run via `npm run check:migrations` (wired into the type-check chain).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const MIGRATION_DIRS = ['migrations', join('migrations', 'catalog')]
const REVIEWED_MARKER = /--\s*destructive:\s*reviewed\b/i

/** A destructive-pattern probe applied per-statement (comment-stripped,
 *  whitespace-collapsed, upper-cased). */
const DESTRUCTIVE: Array<{ code: string; test: (stmt: string) => boolean }> = [
  { code: 'DROP TABLE', test: s => /\bDROP\s+TABLE\b/.test(s) },
  { code: 'DROP COLUMN', test: s => /\bDROP\s+COLUMN\b/.test(s) },
  { code: 'ALTER ... DROP', test: s => /\bALTER\s+TABLE\b/.test(s) && /\bDROP\b/.test(s) },
  { code: 'ALTER ... RENAME', test: s => /\bALTER\s+TABLE\b/.test(s) && /\bRENAME\b/.test(s) },
  { code: 'DELETE FROM', test: s => /\bDELETE\s+FROM\b/.test(s) },
]

/** Strip `-- line` and `/* block *​/` comments so a keyword inside a
 *  comment doesn't read as a statement. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
}

/**
 * Number collisions that already shipped and must stay collided.
 *
 * `migrations/catalog/` carries two `0036` files. Renumbering either
 * one looks like the obvious tidy-up and is the reason this list
 * exists, because `d1_migrations.name` is the **full filename**
 * (`TEXT UNIQUE`), not the number. Both files are recorded there
 * separately on every node that has migrated. Rename one and wrangler
 * no longer recognises it, so it runs it a second time:
 *
 *   - `0036_blog_cover_image.sql` is `ALTER TABLE ... ADD COLUMN`.
 *     Re-running it fails with `duplicate column name:
 *     cover_image_url`, and a failed migration aborts the run, so
 *     every later migration is blocked too. Renaming this file breaks
 *     every existing node.
 *   - `0036_youtube_channels_disabled.sql` is `CREATE TABLE IF NOT
 *     EXISTS`, so re-running it is harmless — but renaming it still
 *     buys nothing and leaves the node's `d1_migrations` holding two
 *     rows for one migration.
 *
 * Nothing is broken as things stand: the two are independent (one adds
 * columns to `blog_posts`, the other creates a new table), and
 * wrangler's order is total. Freeze them, and stop the *next* pair.
 */
const FROZEN_COLLISIONS: string[][] = [
  ['0036_blog_cover_image.sql', '0036_youtube_channels_disabled.sql'],
]

interface Finding {
  file: string
  code: string
}

export interface PrefixCollision {
  dir: string
  /**
   * The number *wrangler* derives, via
   * `parseInt(name.split('_')[0], 10)` — numeric, not the literal text.
   * `0043_a.sql` and `43_b.sql` are one migration number to wrangler,
   * so they have to be one here too.
   */
  migrationNumber: number
  files: string[]
}

/**
 * Report migration numbers claimed by more than one file in `names`,
 * excluding sets listed in `frozen`. A frozen set matches only when it
 * is exactly the files present — adding a third file to a frozen number
 * fails, which is the case this is here to catch. Pure; exported for
 * unit tests.
 */
export function findPrefixCollisions(
  dir: string,
  names: string[],
  frozen: string[][] = FROZEN_COLLISIONS,
): PrefixCollision[] {
  const byNumber = new Map<number, string[]>()
  for (const name of names) {
    if (!name.endsWith('.sql')) continue
    const prefix = name.split('_')[0]
    // Numbered files only. A `.sql` with no leading number is not
    // part of the sequence and cannot collide within it.
    if (!/^\d+$/.test(prefix)) continue
    // Keyed by value, mirroring wrangler's `leadingMigrationNumber`.
    // Bucketing the text would file `0043` and `43` apart and report
    // no collision for two files wrangler considers tied.
    const migrationNumber = parseInt(prefix, 10)
    byNumber.set(migrationNumber, [...(byNumber.get(migrationNumber) ?? []), name])
  }

  // Both sides are normalized. `files` comes from readdir, whose order
  // is not guaranteed, and a frozen set is hand-written — so neither can
  // be assumed sorted. Comparing a sorted set against an unsorted
  // literal would fail a freeze that is spelled correctly but listed in
  // another order, which reads as CI rejecting a file nobody touched.
  const frozenSorted = frozen.map(set => [...set].sort())
  const isFrozen = (files: string[]): boolean =>
    frozenSorted.some(set => set.length === files.length && set.every((f, i) => f === files[i]))

  const collisions: PrefixCollision[] = []
  for (const [migrationNumber, files] of byNumber) {
    if (files.length < 2) continue
    const sorted = [...files].sort()
    if (isFrozen(sorted)) continue
    collisions.push({ dir, migrationNumber, files: sorted })
  }
  // Numeric, so 9 sorts before 10 whatever the padding. A string compare
  // got this right only while every prefix was padded to the same width.
  return collisions.sort((a, b) => a.migrationNumber - b.migrationNumber)
}

/**
 * Return the destructive-statement codes in `sql`, or an empty array
 * when the file is additive or carries the `-- destructive: reviewed`
 * opt-in marker. Pure — exported for unit tests.
 */
export function findDestructive(sql: string): string[] {
  if (REVIEWED_MARKER.test(sql)) return []
  const statements = stripComments(sql)
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim().toUpperCase())
    .filter(Boolean)
  const codes: string[] = []
  for (const stmt of statements) {
    // One code per destructive statement: the probes are ordered
    // most-specific first (DROP COLUMN before the broader ALTER ...
    // DROP), so a single `ALTER TABLE ... DROP COLUMN` reports just
    // `DROP COLUMN` instead of two overlapping codes.
    const match = DESTRUCTIVE.find(probe => probe.test(stmt))
    if (match) codes.push(match.code)
  }
  return codes
}

function scanFile(absPath: string, relPath: string): Finding[] {
  const raw = readFileSync(absPath, 'utf8')
  return findDestructive(raw).map(code => ({ file: relPath, code }))
}

function main(): void {
  const findings: Finding[] = []
  const collisions: PrefixCollision[] = []
  let scanned = 0
  for (const dir of MIGRATION_DIRS) {
    const absDir = join(REPO_ROOT, dir)
    if (!existsSync(absDir)) continue
    const names = readdirSync(absDir).filter(n => n.endsWith('.sql'))
    for (const name of names) {
      scanned++
      findings.push(...scanFile(join(absDir, name), join(dir, name)))
    }
    collisions.push(...findPrefixCollisions(dir, names))
  }

  if (collisions.length > 0) {
    console.error('✗ Two or more migrations claim the same number:\n')
    for (const c of collisions) {
      // The number is spelled out because it is not always the shared
      // prefix text — wrangler reads it with parseInt, so `0043` and
      // `43` are one number, and seeing "43" explains a pairing the
      // filenames alone make look like a mistake in the report.
      console.error(`  ${c.dir}: ${c.migrationNumber} — ${c.files.join(', ')}`)
    }
    console.error(
      '\nWrangler tolerates this — it orders by leading number, then by full\n' +
        'filename, so the sequence stays deterministic. The problem is the repair.\n' +
        '`d1_migrations` records the full filename, so renaming a file that has\n' +
        'already been applied makes wrangler run it again. An\n' +
        '`ALTER TABLE ... ADD COLUMN` then fails with `duplicate column name`, and\n' +
        'that failure aborts every migration after it.\n\n' +
        'So renumber the one that has NOT shipped yet, now, while renaming it is\n' +
        'still free. Once it merges and a node applies it, the number is permanent.\n',
    )
    process.exit(1)
  }

  if (findings.length > 0) {
    console.error('✗ Destructive DDL found in auto-applied migrations:\n')
    for (const f of findings) {
      console.error(`  ${f.file}: ${f.code}`)
    }
    console.error(
      '\nThe deploy job auto-applies migrations to the remote D1 on push to main.\n' +
        'Destructive statements need expand/contract choreography + review. If you\n' +
        'have reasoned about the rollout, opt in by adding this line to the migration:\n\n' +
        '    -- destructive: reviewed\n',
    )
    process.exit(1)
  }

  console.log(
    `✓ ${scanned} migration file(s) are additive (or reviewed-destructive), ` +
      'and no unfrozen number is claimed twice.',
  )
}

// Run only when invoked directly (`tsx scripts/check-migrations-additive.ts`),
// not when imported by the unit test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
