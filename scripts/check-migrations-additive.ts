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

interface Finding {
  file: string
  code: string
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
  let scanned = 0
  for (const dir of MIGRATION_DIRS) {
    const absDir = join(REPO_ROOT, dir)
    if (!existsSync(absDir)) continue
    for (const name of readdirSync(absDir)) {
      if (!name.endsWith('.sql')) continue
      scanned++
      findings.push(...scanFile(join(absDir, name), join(dir, name)))
    }
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

  console.log(`✓ ${scanned} migration file(s) are additive (or reviewed-destructive).`)
}

// Run only when invoked directly (`tsx scripts/check-migrations-additive.ts`),
// not when imported by the unit test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
