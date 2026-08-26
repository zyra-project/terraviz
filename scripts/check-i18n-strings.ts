// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Static check: hard-coded user-facing strings in `src/ui/` and
 * `src/services/docent*.ts`.
 *
 * Catches the regression mode the L1 i18n migration locked out:
 * a developer (or AI agent) writes
 *
 *     element.textContent = 'Submit form'
 *
 * instead of
 *
 *     element.textContent = t('form.submit')
 *
 * and the English label slips past type-check, past the
 * canonical-formatter, and into production for every locale.
 *
 * Heuristic (intentionally narrow — see `docs/I18N_PLAN.md` §CI
 * gates for the broader future scope):
 *
 *   - Walks .ts files matching the configured glob, skipping
 *     anything ending in `.test.ts` (tests have natural-language
 *     descriptions and fixture strings; not user-facing).
 *   - For each line, looks for a DOM-property assignment whose
 *     left side is one of the user-visible-string slots
 *     (`textContent`, `innerText`, `title`, `placeholder`, `alt`)
 *     OR a `setAttribute('aria-label'|'title'|'placeholder'|'alt', …)`
 *     call.
 *   - Flags the assignment if its right-hand side is a plain
 *     string literal (single, double, or backtick — no `${}`
 *     interpolation, no embedded `<` markup) AND contains at
 *     least three consecutive ASCII letters followed somewhere
 *     by a space (a coarse English-prose signature).
 *   - A literal is exempt if either:
 *       * the line carries an `// i18n-exempt: <reason>` comment
 *         (mandatory: state why), OR
 *       * the literal flows through `t()`, `plural()`, or
 *         `interpolate()` on the same line — call detected by
 *         a 60-char left-context scan.
 *
 * The intentionally tight scope means a clean run today; broader
 * checks (HTML-template literals, error messages, log-only
 * strings) can layer in as separate scripts without this one
 * needing per-line exemptions to keep passing.
 *
 * Exits 0 when clean. Exits 1 with a per-violation report on any
 * miss. Wired into the type-check chain via `package.json` so
 * CI catches regressions on every PR.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(HERE, '..')

interface ScanRoot {
  /** Path relative to repo root. */
  readonly dir: string
  /** Optional regex filter on filename — defaults to all `.ts`. */
  readonly filter?: RegExp
}

const SCAN_ROOTS: readonly ScanRoot[] = [
  { dir: 'src/ui' },
  { dir: 'src/services', filter: /^docent.*\.ts$/ },
  // VR / AR modules. The HUD, controller tooltips, tour overlay,
  // and loading scene all paint user-visible text onto Canvas 2D
  // surfaces via `ctx.fillText('...')` — invisible to the DOM-
  // property heuristics above. The fillText regex below catches
  // them.
  { dir: 'src/services', filter: /^vr.*\.ts$/ },
]

/** DOM property slots whose values render as user-visible text. */
const PROP_ASSIGNMENT_RE =
  /\.(textContent|innerText|innerHTML|title|placeholder|alt)\s*=\s*(['"`])(.*?)\2/g

/** `setAttribute('aria-label'|'title'|'placeholder'|'alt', '...')`. */
const SET_ATTR_RE =
  /setAttribute\s*\(\s*['"](aria-label|title|placeholder|alt)['"]\s*,\s*(['"`])(.*?)\2\s*\)/g

/** `ctx.fillText('literal', ...)` — canvas-rendered user-visible
 *  text. Matches `<anything>.fillText('...', ...)` so we catch any
 *  CanvasRenderingContext2D variable name (typically `ctx`, but VR
 *  code sometimes uses `c` or `context`). Same literal-extraction
 *  shape as `PROP_ASSIGNMENT_RE` — group 2 holds the text. */
const FILL_TEXT_RE =
  /\.fillText\s*\(\s*(['"`])(.*?)\1/g

/** ≥3 ASCII letters and at least one space — coarse English signature. */
const ENGLISH_PROSE_RE = /[A-Za-z]{3,}.* /

/** Calls that route a literal through the i18n layer. The check
 *  scans 60 chars left of the literal for any of these tokens. */
const I18N_CALL_RE = /\b(?:t|plural|interpolate)\s*\(/

/** Strict exemption marker. Requires the literal `i18n-exempt:`
 *  prefix followed by at least one non-whitespace character —
 *  i.e., a reason must be present. A bare `i18n-exempt` (no
 *  colon) or `i18n-exempt:` with no rationale after it does NOT
 *  bypass the check. The mandatory-reason convention is enforced
 *  here, not just documented. */
const I18N_EXEMPT_RE = /\bi18n-exempt:\s*\S/

class CheckError extends Error {}

interface Violation {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly snippet: string
  readonly literal: string
}

function walk(dir: string, filter: RegExp = /\.ts$/): string[] {
  const out: string[] = []
  const entries = readdirSync(dir)
  for (const name of entries) {
    const full = resolve(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walk(full, filter))
    } else if (filter.test(name) && !name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

function literalIsBare(literal: string): boolean {
  // Reject template-literal interpolation and any HTML markup —
  // narrow scope catches plain-text assignments only.
  if (literal.includes('${')) return false
  if (literal.includes('<')) return false
  return true
}

function literalLooksLikeProse(literal: string): boolean {
  return ENGLISH_PROSE_RE.test(literal)
}

function isExempt(line: string, literalIndex: number): boolean {
  if (I18N_EXEMPT_RE.test(line)) return true
  // Look 60 chars left of the literal for a t( / plural( / interpolate(
  // call. Catches `something(t('key'))`-style patterns where the literal
  // we're inspecting is already the localized translation key.
  const leftContext = line.slice(Math.max(0, literalIndex - 60), literalIndex)
  if (I18N_CALL_RE.test(leftContext)) return true
  return false
}

function scanLine(
  file: string,
  lineNumber: number,
  line: string,
): Violation[] {
  const violations: Violation[] = []
  const checks: Array<{ re: RegExp; literalGroup: number }> = [
    { re: PROP_ASSIGNMENT_RE, literalGroup: 3 },
    { re: SET_ATTR_RE, literalGroup: 3 },
    { re: FILL_TEXT_RE, literalGroup: 2 },
  ]
  for (const { re, literalGroup } of checks) {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(line)) !== null) {
      const literal = match[literalGroup] ?? ''
      if (!literalIsBare(literal)) continue
      if (!literalLooksLikeProse(literal)) continue
      if (isExempt(line, match.index)) continue
      violations.push({
        file,
        line: lineNumber,
        column: match.index + 1,
        snippet: line.trim(),
        literal,
      })
    }
  }
  return violations
}

export function scanFile(file: string): Violation[] {
  const text = readFileSync(file, 'utf-8')
  const lines = text.split('\n')
  const violations: Violation[] = []
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (ln === undefined) continue
    violations.push(...scanLine(file, i + 1, ln))
  }
  return violations
}

export function scanRepo(repoRoot: string = REPO_ROOT): Violation[] {
  const violations: Violation[] = []
  for (const root of SCAN_ROOTS) {
    const fullDir = resolve(repoRoot, root.dir)
    let files: string[]
    try {
      files = walk(fullDir, root.filter)
    } catch (err) {
      throw new CheckError(
        `[i18n-strings] could not walk ${root.dir}: ${(err as Error).message}`,
      )
    }
    for (const file of files) {
      violations.push(...scanFile(file))
    }
  }
  return violations
}

function formatReport(violations: readonly Violation[]): string {
  if (violations.length === 0) return ''
  const lines = [
    `[i18n-strings] ${violations.length} hard-coded user-visible string${
      violations.length === 1 ? '' : 's'
    } detected:`,
    '',
  ]
  for (const v of violations) {
    const rel = relative(REPO_ROOT, v.file)
    lines.push(`  ${rel}:${v.line}:${v.column}`)
    lines.push(`    ${v.snippet}`)
    lines.push(`    literal: ${JSON.stringify(v.literal)}`)
    lines.push('')
  }
  lines.push(
    'Fix each by routing the string through `t()` from `src/i18n/index.ts`.',
    'If the string is genuinely not user-facing (debug HUD, technical',
    'identifier, etc.), add `// i18n-exempt: <reason>` to the same line.',
    'See `docs/I18N_PLAN.md` and the Localization section of CLAUDE.md.',
  )
  return lines.join('\n')
}

function run(): void {
  let violations: Violation[]
  try {
    violations = scanRepo()
  } catch (err) {
    if (err instanceof CheckError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
  if (violations.length > 0) {
    console.error(formatReport(violations))
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('✓ No hard-coded user-visible strings detected.')
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run()
}

export { CheckError, formatReport, type Violation }
