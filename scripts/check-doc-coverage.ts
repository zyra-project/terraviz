/**
 * Static check: every source module under the configured coverage
 * roots is named in its documentation home.
 *
 * Motivation: the module maps in CLAUDE.md are the first thing a new
 * contributor (or AI agent) reads to orient in the codebase, but
 * they drift silently — a module lands, ships, and is never added.
 * A one-off audit (via the graphify code-graph tool) found dozens of
 * modules undocumented. This check locks the regression out the same
 * way `check-i18n-strings` locks out hard-coded English: cheaply, in
 * the `type-check` chain, on every PR.
 *
 * Coverage is an explicit manifest (`COVERAGE_ROOTS`) rather than a
 * single hard-coded directory, because the repo has more than one
 * documentation home and a "must be in CLAUDE.md" rule is only
 * correct for some of it:
 *
 *   - `src/`           → CLAUDE.md SPA module map
 *   - `src-tauri/src/` → CLAUDE.md Rust module map
 *   - `functions/`, `cli/` → `docs/BACKEND_MODULES.md` (the backend
 *     map — kept out of CLAUDE.md because it's helper-dense and
 *     route-shaped, and sits with the `docs/CATALOG_*` plan docs).
 *
 * "Documented" means the module's full repo-relative path (e.g.
 * `functions/api/v1/publish/datasets/[id].ts`) appears anywhere in
 * the root's `doc` file. The maps render each row as a full path —
 * `` `src/services/<name>` `` — so this matches, and a full-path
 * match is required because the route-based backend layout repeats
 * basenames across directories (three different `[id].ts`,
 * `manifest.ts`, `publish.ts`, …) — a basename match would let one
 * documented copy spuriously cover the rest.
 *
 * Exclusions (not module-map material):
 *   - `*.test.ts` — tests.
 *   - `*.d.ts` — ambient declarations.
 *   - Generated code: `messages.ts` / `messages.<locale>.ts` (the
 *     i18n codegen output — the i18n layer is documented
 *     conceptually in the Localization section, not per file).
 *   - `test-setup.ts` — vitest bootstrap, not a module.
 *   - Any file carrying a `// doc-exempt: <reason>` comment (reason
 *     mandatory, same convention as `i18n-exempt:`).
 *
 * Exits 0 when clean. Exits 1 with a per-module report on any miss.
 * Wired into the type-check chain via `package.json`.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(HERE, '..')

interface CoverageRoot {
  /** Directory to scan, relative to repo root. */
  readonly dir: string
  /** Doc file (relative to repo root) that must name each module. */
  readonly doc: string
  /** File-extension filter. */
  readonly ext: RegExp
}

const COVERAGE_ROOTS: readonly CoverageRoot[] = [
  { dir: 'src', doc: 'CLAUDE.md', ext: /\.ts$/ },
  { dir: 'src-tauri/src', doc: 'CLAUDE.md', ext: /\.rs$/ },
  // The backend (Cloudflare Pages Functions + publisher CLI) has its
  // own module map — it's helper-dense and route-shaped, and lives
  // alongside the `docs/CATALOG_*` plan docs rather than bloating the
  // SPA map in CLAUDE.md.
  { dir: 'functions', doc: 'docs/BACKEND_MODULES.md', ext: /\.ts$/ },
  { dir: 'cli', doc: 'docs/BACKEND_MODULES.md', ext: /\.ts$/ },
]

/** Basenames that are never module-map material (generated / infra). */
const EXCLUDE_BASENAME: readonly RegExp[] = [
  /\.test\.ts$/,
  /\.d\.ts$/,
  /^messages\.ts$/,
  /^messages\.[^.]+\.ts$/,
  /^test-setup\.ts$/,
]

/** `// doc-exempt: <reason>` — must be a real `//` line comment, with
 *  a reason (≥1 non-space char) on the SAME line. Requiring the `//`
 *  marker stops a stray `doc-exempt:` inside a string literal or other
 *  text from silently exempting a module. `[^\n]*` keeps the `//` and
 *  the marker on one line; `[^\S\n]` ("whitespace except newline")
 *  means a bare `doc-exempt:` at end of line does NOT count as a
 *  reason. */
const DOC_EXEMPT_RE = /\/\/[^\n]*\bdoc-exempt:[^\S\n]*\S/

class CheckError extends Error {}

export interface Undocumented {
  /** Path relative to repo root, e.g. `src/services/heroService.ts`. */
  readonly file: string
  /** Bare filename the doc was searched for, e.g. `heroService.ts`. */
  readonly basename: string
  /** Doc file the module should have appeared in. */
  readonly doc: string
}

function isExcluded(basename: string): boolean {
  return EXCLUDE_BASENAME.some(re => re.test(basename))
}

/** Recursively collect candidate module files under `dir`. */
function walk(dir: string, ext: RegExp): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, ext))
    } else if (ext.test(name) && !isExcluded(name)) {
      out.push(full)
    }
  }
  return out
}

function isExempt(file: string): boolean {
  return DOC_EXEMPT_RE.test(readFileSync(file, 'utf-8'))
}

/**
 * Return modules absent from their doc home. Pure over the
 * filesystem so the test can point it at a fixture repo root.
 */
export function findUndocumentedModules(repoRoot: string = REPO_ROOT): Undocumented[] {
  const docCache = new Map<string, string>()
  const readDoc = (rel: string): string => {
    let text = docCache.get(rel)
    if (text === undefined) {
      try {
        text = readFileSync(resolve(repoRoot, rel), 'utf-8')
      } catch (err) {
        throw new CheckError(
          `[doc-coverage] could not read ${rel}: ${(err as Error).message}`,
        )
      }
      docCache.set(rel, text)
    }
    return text
  }

  const missing: Undocumented[] = []
  for (const root of COVERAGE_ROOTS) {
    const fullDir = resolve(repoRoot, root.dir)
    // A missing root directory is not an error — it lets the test
    // point at a partial fixture, and tolerates optional surfaces.
    if (!existsSync(fullDir)) continue
    const doc = readDoc(root.doc)
    for (const file of walk(fullDir, root.ext)) {
      // Normalize to forward slashes: `relative()` yields `\` on
      // Windows, but the doc tables (and our basename split) use `/`.
      const rel = relative(repoRoot, file).split(sep).join('/')
      // Full-path match — basenames repeat across the backend's
      // route dirs, so a basename match would be ambiguous.
      if (doc.includes(rel)) continue
      if (isExempt(file)) continue
      missing.push({ file: rel, basename: rel.slice(rel.lastIndexOf('/') + 1), doc: root.doc })
    }
  }
  return missing
}

export function formatReport(missing: readonly Undocumented[]): string {
  if (missing.length === 0) return ''
  const lines = [
    `[doc-coverage] ${missing.length} module${
      missing.length === 1 ? '' : 's'
    } missing from the module map:`,
    '',
  ]
  for (const m of missing) lines.push(`  ${m.file}  → add to ${m.doc}`)
  lines.push(
    '',
    'Add a one-line row to the module map named beside each file',
    'above (CLAUDE.md for `src/` + `src-tauri/src/`, ',
    'docs/BACKEND_MODULES.md for `functions/` + `cli/`). If a module',
    'genuinely needs no row (throwaway shim, obvious from a',
    'documented sibling), add `// doc-exempt: <reason>` to its source.',
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
  console.log('✓ Every source module is documented in its module map.')
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run()
}

export { CheckError }
