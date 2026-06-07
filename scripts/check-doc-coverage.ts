/**
 * Static check: every service module in `src/services/` is named
 * in the CLAUDE.md module map.
 *
 * Motivation: the module map in CLAUDE.md is the first thing a new
 * contributor (or AI agent) reads to orient in the codebase, but
 * it drifts silently — a service lands, ships, and is never added
 * to the table. A one-off audit found ~29 of 49 service modules
 * undocumented. This check locks the regression out the same way
 * `check-i18n-strings` locks out hard-coded English: cheaply, in
 * the `type-check` chain, on every PR.
 *
 * Intentionally narrow scope (so a clean run stays clean):
 *
 *   - Scans only the TOP LEVEL of `src/services/` (not nested
 *     dirs like `orbitCharacter/`), `.ts` files, skipping
 *     `*.test.ts`.
 *   - "Documented" means the filename (e.g. `relatedDatasets.ts`)
 *     appears verbatim anywhere in `CLAUDE.md`. The map renders
 *     each row as `` `src/services/<name>` `` so a substring match
 *     on the basename is sufficient and robust to table reflow.
 *   - A module is exempt if its source carries a
 *     `// doc-exempt: <reason>` comment (reason mandatory), mirroring
 *     the `i18n-exempt:` convention. Use it for throwaway shims or
 *     modules whose role is obvious from a documented sibling.
 *
 * This deliberately does NOT cover `src/ui/`, `functions/`, or
 * `cli/`: the UI layer is only partially mapped by design, and the
 * backend has its own `docs/CATALOG_*` plan docs rather than the
 * SPA module map. Those surfaces can get their own checks later
 * without this one needing exemptions to keep passing.
 *
 * Exits 0 when clean. Exits 1 with a per-module report on any
 * miss. Wired into the type-check chain via `package.json`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(HERE, '..')

const SERVICES_DIR = 'src/services'
const DOC_FILE = 'CLAUDE.md'

/** `// doc-exempt: <reason>` — reason (≥1 non-space char) mandatory,
 *  and on the SAME line as the marker. `[^\S\n]` is "whitespace
 *  except newline", so a bare `doc-exempt:` at end of line followed
 *  by code on the next line does NOT count as a reason. */
const DOC_EXEMPT_RE = /\bdoc-exempt:[^\S\n]*\S/

class CheckError extends Error {}

export interface Undocumented {
  /** Path relative to repo root, e.g. `src/services/heroService.ts`. */
  readonly file: string
  /** Bare filename the doc was searched for, e.g. `heroService.ts`. */
  readonly basename: string
}

/** Top-level `*.ts` service modules, excluding tests. */
function serviceModules(repoRoot: string): string[] {
  const dir = resolve(repoRoot, SERVICES_DIR)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (err) {
    throw new CheckError(
      `[doc-coverage] could not read ${SERVICES_DIR}: ${(err as Error).message}`,
    )
  }
  const out: string[] = []
  for (const name of entries) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    const full = resolve(dir, name)
    if (!statSync(full).isFile()) continue
    out.push(full)
  }
  return out
}

function isExempt(file: string): boolean {
  return DOC_EXEMPT_RE.test(readFileSync(file, 'utf-8'))
}

/**
 * Return the service modules absent from the doc. Pure over the
 * filesystem so the test can point it at a fixture repo root.
 */
export function findUndocumentedModules(repoRoot: string = REPO_ROOT): Undocumented[] {
  let doc: string
  try {
    doc = readFileSync(resolve(repoRoot, DOC_FILE), 'utf-8')
  } catch (err) {
    throw new CheckError(
      `[doc-coverage] could not read ${DOC_FILE}: ${(err as Error).message}`,
    )
  }
  const missing: Undocumented[] = []
  for (const file of serviceModules(repoRoot)) {
    const basename = file.slice(file.lastIndexOf('/') + 1)
    if (doc.includes(basename)) continue
    if (isExempt(file)) continue
    missing.push({ file: relative(repoRoot, file), basename })
  }
  return missing
}

export function formatReport(missing: readonly Undocumented[]): string {
  if (missing.length === 0) return ''
  const lines = [
    `[doc-coverage] ${missing.length} service module${
      missing.length === 1 ? '' : 's'
    } missing from ${DOC_FILE}'s module map:`,
    '',
  ]
  for (const m of missing) lines.push(`  ${m.file}`)
  lines.push(
    '',
    `Add a row to the module-map table in ${DOC_FILE} (see the`,
    '"Module map" section). If a module genuinely needs no row',
    '(throwaway shim, obvious from a documented sibling), add',
    '`// doc-exempt: <reason>` to its source.',
  )
  return lines.join('\n')
}

function run(): void {
  let missing: Undocumented[]
  try {
    missing = findUndocumentedModules()
  } catch (err) {
    if (err instanceof CheckError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
  if (missing.length > 0) {
    console.error(formatReport(missing))
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('✓ Every src/services module is in the CLAUDE.md module map.')
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run()
}

export { CheckError }
