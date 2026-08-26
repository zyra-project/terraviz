// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * check-license-headers — every source file names its licence, and CI says so.
 *
 * ## Why the short form
 *
 * Apache 2.0 does not require per-file headers. Its appendix says "we
 * recommend", and the `LICENSE` + `NOTICE` at the root already satisfy the
 * licence. What a per-file marker buys is machine readability — scanners,
 * REUSE and GitHub all read SPDX identifiers — and here that costs two lines
 * rather than the sixteen of the full boilerplate.
 *
 * Sixteen would be the wrong trade in this repository specifically. 526 of its
 * 540 non-test source files open with a doc comment explaining what the file is
 * for, and those comments are the thing that makes a 305,000-line codebase
 * navigable — the module map in CLAUDE.md is an index *into* them. Pushing
 * every one sixteen lines down to make room for identical legal text works
 * against the project's own documentation discipline, and across ~900 covered
 * files it would add ~14,000 lines nobody reads twice. Two lines buy the same
 * machine readability for ~2,700.
 *
 * ## What counts as correct
 *
 * The SPDX line and a copyright line, in that order, above everything except a
 * line that must come first. Matched by POSITION, not searched for: an earlier
 * generation of this check on a sibling repository scanned the first eight
 * lines for the two strings, which returns true for a file that merely *talks*
 * about them — and the two files most likely to do that are this one and its
 * test. A header deleted from either would have gone unnoticed by the check
 * written to notice it.
 *
 * The year is deliberately loose and the holder deliberately is not. A file
 * edited in a later year should be free to say `2026-2027` without failing a
 * check that has no opinion about copyright terms; a file quietly attributing
 * itself to somebody else is exactly the drift worth catching.
 *
 * ## Prologues
 *
 * Some files cannot take a header at line 1, and inserting above the line that
 * must lead fails SILENTLY IN BOTH DIRECTIONS — the file still parses, still
 * typechecks, still passes every test:
 *
 *   - `#!` shebang — stops being a shebang, so the script stops being runnable.
 *   - `<!doctype html>` — the browser drops into quirks mode.
 *   - `// swift-tools-version:` — SwiftPM refuses the manifest.
 *   - `# -*- coding: … -*-` (PEP 263) — honoured only on line 1 or 2.
 *   - `<?xml … ?>` — must lead an XML document.
 *
 * So `prologueLines` is tested per language rather than assumed, and the header
 * goes after that line rather than before it. Note that the Swift and Python
 * cases are position-sensitive rather than merely pattern-matched: a
 * `// swift-tools-version:` comment further down a Swift file is an ordinary
 * comment, and a coding declaration on line 3 is ordinary text.
 *
 * ## One source of truth for the holder
 *
 * `COPYRIGHT` below is the constant the headers are written from, and the same
 * constant `LICENSE`, `NOTICE`, `package.json`, `CITATION.cff` and the Cargo
 * manifests are checked against. Changing the holder is then one edit here plus
 * a `--fix`, rather than a sweep across ~900 files that nothing would catch a
 * miss in.
 *
 * Run:  npm run check:license           # check; exits non-zero on a miss
 *       npm run check:license -- --fix  # insert or repair what is missing
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(import.meta.dirname, '..')

/** The SPDX short identifier every manifest in the repo must agree on. */
export const LICENSE_ID = 'Apache-2.0'
export const SPDX = `SPDX-License-Identifier: ${LICENSE_ID}`
export const COPYRIGHT = 'Copyright 2026 The Zyra Project'

/** The holder alone, so the year can move and the holder cannot. */
const HOLDER = COPYRIGHT.replace(/^Copyright\s+\d{4}(-\d{4})?\s+/, '')

// ---------------------------------------------------------------------------
// Comment styles
// ---------------------------------------------------------------------------

export interface CommentStyle {
  readonly open: string
  readonly close: string
}

const SLASH: CommentStyle = { open: '// ', close: '' }
const BLOCK: CommentStyle = { open: '/* ', close: ' */' }
const HASH: CommentStyle = { open: '# ', close: '' }
const MARKUP: CommentStyle = { open: '<!-- ', close: ' -->' }
const DASH: CommentStyle = { open: '-- ', close: '' }

/**
 * How a header is spelled in each language this repository writes.
 *
 * Getting this wrong is not cosmetic in either direction: a markup-style header
 * in a code file is a syntax error, and a code-style header in a markup file
 * renders as visible text on the page. Both directions are tested.
 *
 * Returning `null` is how a file kind opts out of coverage entirely — see
 * `COVERED` below for what is deliberately not here and why.
 */
export function commentStyle(file: string): CommentStyle | null {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|swift)$/.test(file)) return SLASH
  if (/\.css$/.test(file)) return BLOCK
  if (/\.(py|sh|bash)$/.test(file)) return HASH
  if (/\.html?$/.test(file)) return MARKUP
  if (/\.sql$/.test(file)) return DASH
  return null
}

/**
 * The file kinds carrying headers, as one glob list for `git ls-files`.
 *
 * Deliberately absent, so the omissions read as decisions rather than
 * oversights:
 *
 *   - `.json` has no comment syntax. `tsconfig.json` tolerates comments but
 *     `package.json` and every generated schema do not, and a rule with an
 *     exception per file is a rule that erodes.
 *   - `.md` is prose, not source. 109 documents whose licence the root LICENSE
 *     already states, and a scanner reading Markdown for SPDX is not a case
 *     worth serving.
 *   - `.yml` / `.yaml` / `.toml` are configuration. The Cargo and npm manifests
 *     carry a `license` field instead, which is what tooling actually reads,
 *     and that field is checked below.
 *
 * Full REUSE compliance would additionally want a `.license` sidecar next to
 * every binary asset — 23 PNGs, 17 JPEGs, 8 MP4s, the basemap textures. That is
 * a bigger commitment than machine-readable source licensing and is a separate
 * decision, not an accident of this list.
 */
const COVERED = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs',
  '*.rs', '*.swift', '*.css', '*.py', '*.sh', '*.bash', '*.html', '*.htm', '*.sql']

/**
 * Paths that are source, are covered by the globs above, and still must not
 * carry our header — vendored third-party code, whose copyright is not ours to
 * assert.
 *
 * A path manifest rather than an in-file `license-exempt:` marker, on purpose:
 * the whole point of vendored code is that we do not edit it, so the exemption
 * cannot live inside the file. The reason is mandatory, same convention as
 * `i18n-exempt:` and `doc-exempt:` elsewhere in this repo.
 *
 * Empty today. `.claude/skills/graphify/` is vendored (MIT) but ships only
 * Markdown and reference data — no file the globs above would match.
 */
const EXEMPT: readonly { readonly prefix: string; readonly reason: string }[] = []

/** Belt-and-braces against a build artifact that somehow got tracked. */
const NEVER = /(^|\/)(node_modules|dist|build|coverage|report-out|screenshots-out|graphify-out|src-tauri\/(target|gen))\//

// ---------------------------------------------------------------------------
// Prologues
// ---------------------------------------------------------------------------

const SHEBANG = /^#!/
/** PEP 263. Honoured on line 1 or 2 only, which is why position is checked. */
const PY_CODING = /^[ \t]*#.*coding[:=][ \t]*[-\w.]+/
/** SwiftPM reads this only as the first line of a manifest. */
const SWIFT_TOOLS = /^\/\/[ \t]*swift-tools-version[ \t]*:/
const XML_DECL = /^[ \t]*<\?xml\b/i
const DOCTYPE = /^[ \t]*<!doctype\b/i

/**
 * How many leading lines must stay above the header.
 *
 * Every branch here is a line that changes meaning when it stops being first,
 * and every one of them fails quietly — which is why this is a tested function
 * rather than a `startsWith('#!')` at the call site.
 */
export function prologueLines(file: string, text: string): number {
  const lines = text.split('\n')
  const at = (n: number): string => lines[n] ?? ''
  const isMarkup = /\.html?$/.test(file)
  let i = 0

  // A shebang is only a shebang on line 1.
  if (SHEBANG.test(at(i))) i++

  // PEP 263: line 1, or line 2 when a shebang took line 1. Anywhere lower it is
  // an ordinary comment, so the position guard is the point.
  if (/\.py$/.test(file) && i <= 1 && PY_CODING.test(at(i))) i++

  // Package.swift stops being a manifest if this is displaced. Same position
  // reasoning: further down it is just a comment.
  if (/\.swift$/.test(file) && i === 0 && SWIFT_TOOLS.test(at(i))) i++

  // An XML declaration then a doctype, in that order — XHTML can carry both.
  if (isMarkup && XML_DECL.test(at(i))) i++
  if (isMarkup && DOCTYPE.test(at(i))) i++

  return i
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const spdxLine = (style: CommentStyle): string => `${style.open}${SPDX}${style.close}`

/**
 * Year loose, holder pinned. `2026` and `2026-2027` both pass; a different
 * holder does not.
 */
const copyrightRe = (style: CommentStyle): RegExp =>
  new RegExp(
    `^${escapeRe(style.open)}Copyright \\d{4}(-\\d{4})? ${escapeRe(HOLDER)}${escapeRe(style.close)}$`,
  )

/** The header as it is written into a file: two lines, then a blank. */
export function headerLines(style: CommentStyle): string[] {
  return [spdxLine(style), `${style.open}${COPYRIGHT}${style.close}`, '']
}

/**
 * Is the header actually AT THE TOP, rather than merely mentioned near it?
 *
 * Position is the whole point — see the module comment. Both lines are matched
 * in place, at the first index a prologue leaves free.
 */
export function hasHeader(file: string, text: string, style: CommentStyle): boolean {
  const lines = text.split('\n')
  const skip = prologueLines(file, text)
  return lines[skip] === spdxLine(style) && copyrightRe(style).test(lines[skip + 1] ?? '')
}

/**
 * Insert the header, or repair one that is wrong.
 *
 * Repair rather than insert-only, because the failure this protects against is
 * not only absence. A file carrying an SPDX line with a stale holder, or an
 * SPDX line with no copyright line under it, would otherwise collect a SECOND
 * header above the first every time somebody ran `--fix` — the stacking the
 * idempotency requirement is about, wearing a different shape. So an existing
 * SPDX line at the header position (and a copyright line under it, if any) is
 * consumed before the correct block goes in.
 */
export function addHeader(file: string, text: string, style: CommentStyle): string {
  const lines = text.split('\n')
  const skip = prologueLines(file, text)
  const rest = lines.slice(skip)

  // Consume a header that is already there but wrong, so repair never stacks.
  const staleSpdx = new RegExp(`^${escapeRe(style.open)}\\s*${escapeRe(SPDX)}`)
  const anyCopyright = new RegExp(`^${escapeRe(style.open)}\\s*Copyright\\b`)
  if (staleSpdx.test(rest[0] ?? '')) {
    rest.shift()
    if (anyCopyright.test(rest[0] ?? '')) rest.shift()
  }

  // A prologue is already followed by a blank line in some files. Do not leave
  // two, and do not leave zero.
  while (rest.length > 0 && rest[0].trim() === '') rest.shift()

  return [...lines.slice(0, skip), ...headerLines(style), ...rest].join('\n')
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Every source file, tracked or merely written.
 *
 * `git ls-files` alone lists only TRACKED files, which makes the local check
 * disagree with CI in the one direction that hurts: a file you have just
 * written and not yet `git add`ed passes here and fails there, so you find out
 * after pushing rather than before. `--others --exclude-standard` adds the
 * untracked files git would not ignore — precisely the set about to become
 * tracked. Ignored paths (node_modules, dist, the generated `src/i18n/messages*.ts`
 * and `src/styles/tokens.css`) stay out by the same rule, with no second list
 * to keep in step.
 *
 * `-z` because a repository this size will eventually contain a path with a
 * space or a quote in it, and `ls-files` escapes those in its default output.
 */
export function sourceFiles(root: string): string[] {
  const run = (args: string[]): string[] =>
    execFileSync('git', [...args, '-z', '--', ...COVERED], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean)

  const all = new Set([...run(['ls-files']), ...run(['ls-files', '--others', '--exclude-standard'])])

  return [...all]
    .filter(f => !NEVER.test(f))
    .filter(f => !EXEMPT.some(e => f === e.prefix || f.startsWith(e.prefix)))
    .filter(f => commentStyle(f) !== null)
    .sort()
}

// ---------------------------------------------------------------------------
// Metadata agreement
// ---------------------------------------------------------------------------

/**
 * The manifests must name the same licence and holder as the headers.
 *
 * A LICENSE file is invisible to everything downstream: citation tooling reads
 * CITATION.cff, package tooling reads the manifest `license` field, and neither
 * opens LICENSE. Checking them against the constants above — rather than
 * against each other, or against memory — is what makes changing the holder one
 * edit instead of a sweep nothing verifies.
 */
export function metadataDrift(root: string): string[] {
  const problems: string[] = []
  const read = (rel: string): string | null => {
    const full = join(root, rel)
    return existsSync(full) ? readFileSync(full, 'utf8') : null
  }

  for (const rel of ['LICENSE', 'NOTICE']) {
    const text = read(rel)
    if (text === null) problems.push(`${rel} is missing`)
    else if (!text.includes(COPYRIGHT)) {
      problems.push(`${rel} does not carry "${COPYRIGHT}" — it has drifted from the header constant`)
    }
  }

  const pkg = read('package.json')
  if (pkg !== null) {
    const declared = (JSON.parse(pkg) as { license?: string }).license
    if (declared !== LICENSE_ID) {
      problems.push(
        `package.json declares license ${declared === undefined ? '(nothing)' : `"${declared}"`}, not "${LICENSE_ID}" — ` +
          'npm publishes the manifest field, never the LICENSE file',
      )
    }
  }

  const cff = read('CITATION.cff')
  if (cff !== null) {
    const declared = /^license:[ \t]*(\S+)[ \t]*$/m.exec(cff)?.[1]
    if (declared !== LICENSE_ID) {
      problems.push(
        `CITATION.cff declares license ${declared === undefined ? '(nothing)' : `"${declared}"`}, not "${LICENSE_ID}" — ` +
          'Zenodo records this field, not the LICENSE file',
      )
    }
  }

  for (const rel of ['src-tauri/Cargo.toml', 'src-tauri/plugins/apple-intelligence/Cargo.toml']) {
    const toml = read(rel)
    if (toml === null) continue
    const declared = /^license[ \t]*=[ \t]*"([^"]*)"/m.exec(toml)?.[1]
    if (declared !== LICENSE_ID) {
      problems.push(
        `${rel} declares license ${declared === undefined ? '(nothing)' : `"${declared}"`}, not "${LICENSE_ID}"`,
      )
    }
  }

  return problems
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export function check(root: string, fix: boolean): { missing: string[]; total: number } {
  const files = sourceFiles(root)
  const missing: string[] = []
  for (const rel of files) {
    const style = commentStyle(rel)
    if (style === null) continue
    const full = join(root, rel)
    const text = readFileSync(full, 'utf8')
    if (hasHeader(rel, text, style)) continue
    if (fix) writeFileSync(full, addHeader(rel, text, style))
    missing.push(rel)
  }
  return { missing, total: files.length }
}

const REPORT_LIMIT = 20

function main(): void {
  const fix = process.argv.includes('--fix')
  const { missing, total } = check(REPO_ROOT, fix)
  const drift = metadataDrift(REPO_ROOT)

  if (fix) {
    console.log(
      missing.length === 0
        ? `check:license: all ${total} source files already carried the header`
        : `check:license: wrote the header into ${missing.length} of ${total} source files`,
    )
    if (drift.length > 0) {
      // Not auto-fixable: which manifest is right is a decision, not a repair.
      console.error('\n✗ Licence metadata still disagrees with the header constant:\n')
      for (const p of drift) console.error(`  ${p}`)
      console.error(`\nThe constants are COPYRIGHT and LICENSE_ID in ${'scripts/check-license-headers.ts'}.`)
      process.exit(1)
    }
    return
  }

  if (missing.length === 0 && drift.length === 0) {
    console.log(
      `✓ check:license: all ${total} source files open with the SPDX header, ` +
        'and every licence manifest names the same holder',
    )
    return
  }

  if (missing.length > 0) {
    console.error(`✗ ${missing.length} of ${total} source files have no SPDX header:\n`)
    for (const f of missing.slice(0, REPORT_LIMIT)) console.error(`  ${f}`)
    if (missing.length > REPORT_LIMIT) {
      console.error(`  … and ${missing.length - REPORT_LIMIT} more`)
    }
    console.error('\nRun: npm run check:license -- --fix')
  }

  if (drift.length > 0) {
    if (missing.length > 0) console.error('')
    console.error('✗ Licence metadata disagrees with the header constant:\n')
    for (const p of drift) console.error(`  ${p}`)
    console.error('\nThe constants are COPYRIGHT and LICENSE_ID in scripts/check-license-headers.ts.')
  }

  process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
