// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Fails when a stylesheet uses a physical inline-axis property where a
 * logical one belongs.
 *
 * `<html dir>` is set automatically from the active locale
 * (src/i18n/rtl.ts), so an RTL locale mirrors the layout — but only for
 * properties that are direction-aware. A `padding-left` stays on the
 * left in Arabic and Hebrew, which puts it on the wrong side of the
 * content. The failure is invisible to anyone not reading an RTL
 * locale, which is why it needs a check rather than review attention.
 *
 * The rule and the two deliberate exceptions are documented in
 * CLAUDE.md §When you add CSS and docs/CSS_ARCHITECTURE_PLAN.md
 * §RTL safety.
 *
 * Exceptions, both handled here:
 *
 *   1. Classic centering — `left: 50%` paired with
 *      `transform: translate(-50%, -50%)`. `inset-inline-start: 50%`
 *      does not center in RTL, so the physical property is correct.
 *      Auto-exempt: a `left`/`right` whose value is exactly `50%`.
 *   2. Direction-sensitive slide transforms — `translateX(±100%)`
 *      paired with a `:root[dir="rtl"]` override that flips the sign.
 *      Not matched at all: this check never looks at `transform`.
 *
 * Anything else can annotate with an inline
 * `/* rtl-exempt: <reason> *​/` on the same line. The reason is
 * mandatory, same convention as `i18n-exempt:` and `doc-exempt:`.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** A physical property and the logical property that replaces it. */
interface Rule {
  readonly re: RegExp
  readonly fix: (m: RegExpMatchArray) => string
  /**
   * Set on the positional-offset rule only. `left`/`right` with a value
   * of exactly `50%` is the classic-centering exception — the physical
   * property is correct there, because `inset-inline-start: 50%` does
   * not center under RTL. No other rule has a value to test: the box
   * and border rules match only up to the colon, and `text-align`'s
   * value is the side itself.
   */
  readonly centeringExempt?: boolean
}

const SIDE_TO_LOGICAL: Record<string, string> = { left: 'start', right: 'end' }

const RULES: readonly Rule[] = [
  {
    // padding-left / margin-right / ...
    re: /(?:^|[^-\w])(padding|margin)-(left|right)\s*:/gi,
    fix: (m) => `${m[1]}-inline-${SIDE_TO_LOGICAL[m[2].toLowerCase()]}`,
  },
  {
    // border-left / border-right-color / ...
    re: /(?:^|[^-\w])border-(left|right)(-width|-color|-style)?\s*:/gi,
    fix: (m) => `border-inline-${SIDE_TO_LOGICAL[m[1].toLowerCase()]}${m[2] ?? ''}`,
  },
  {
    re: /text-align\s*:\s*(left|right)/gi,
    fix: (m) => `text-align: ${SIDE_TO_LOGICAL[m[1].toLowerCase()]}`,
  },
  {
    // Bare positional left/right. `50%` is the centering exception.
    re: /(?:^|[^-\w])(left|right)\s*:\s*([^;{}]+)/gi,
    fix: (m) => `inset-inline-${SIDE_TO_LOGICAL[m[1].toLowerCase()]}`,
    centeringExempt: true,
  },
]

/**
 * `/* rtl-exempt: <reason> *​/` — reason mandatory, same line.
 *
 * The reason is captured up to the comment terminator and must be
 * non-empty once trimmed. Testing "some non-space follows the colon"
 * (as the `doc-exempt:` regex does) is not enough here: `doc-exempt`
 * lives in a `//` comment with no terminator, whereas a bare
 * `/* rtl-exempt: *​/` would let the closing `*` itself satisfy that
 * test and silently exempt a line with no stated reason.
 */
const RTL_EXEMPT_RE = /\/\*[^\n]*?\brtl-exempt:([^\n]*?)(?:\*\/|$)/

export function hasRtlExempt(line: string): boolean {
  const m = RTL_EXEMPT_RE.exec(line)
  return m !== null && m[1].trim().length > 0
}

export interface Violation {
  readonly file: string
  readonly line: number
  readonly found: string
  readonly suggest: string
}

/** Strip `/* ... *​/` comment bodies so a property named inside prose
 *  (like this file's own header) is never matched. Preserves line
 *  structure so reported line numbers stay accurate. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

export function findViolations(file: string, css: string): Violation[] {
  const out: Violation[] = []
  const rawLines = css.split('\n')
  const lines = stripComments(css).split('\n')

  lines.forEach((line, i) => {
    // The exemption is read from the ORIGINAL line — it lives in a
    // comment, which `stripComments` has already blanked out.
    if (hasRtlExempt(rawLines[i] ?? '')) return

    for (const rule of RULES) {
      rule.re.lastIndex = 0
      let m: RegExpMatchArray | null
      while ((m = rule.re.exec(line)) !== null) {
        if (rule.centeringExempt && m[2]?.trim() === '50%') continue
        out.push({
          file,
          line: i + 1,
          found: m[0].replace(/^[^-\w]/, '').trim(),
          suggest: rule.fix(m),
        })
      }
    }
  })

  return out
}

/**
 * Scope: stylesheets belonging to the localized SPA.
 *
 * `poster/` is deliberately excluded. It is a standalone static poster
 * deployed to its own Cloudflare Pages project by
 * .github/workflows/poster.yml, which is kept separate from SPA CI
 * specifically so "the poster cannot delay or break SPA CI". It is
 * single-language English and never receives the `<html dir>` the i18n
 * runtime sets, so the RTL invariant does not apply to it — and pulling
 * it into the SPA's type-check chain would undo that isolation.
 */
const SCOPE = 'src/**/*.css'

function cssFiles(): string[] {
  const out = execFileSync('git', ['ls-files', SCOPE], { encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

function formatReport(violations: readonly Violation[]): string {
  const lines = [
    `[css-logical] ${violations.length} physical inline-axis ` +
      `${violations.length === 1 ? 'property' : 'properties'} found:`,
    '',
  ]
  for (const v of violations) {
    lines.push(`  ${v.file}:${v.line}  ${v.found}  →  use \`${v.suggest}\``)
  }
  lines.push(
    '',
    'Physical left/right properties do not mirror when an RTL locale',
    'sets `<html dir="rtl">`. Use the logical equivalent — see',
    'CLAUDE.md §When you add CSS. Classic centering (`left: 50%` with a',
    '`translate(-50%, -50%)`) is exempt automatically; anything else',
    'that genuinely must stay physical takes an inline',
    '`/* rtl-exempt: <reason> */` on the same line.',
  )
  return lines.join('\n')
}

export function run(): void {
  const violations = cssFiles().flatMap((f) => findViolations(f, readFileSync(f, 'utf8')))

  if (violations.length > 0) {
    console.error(formatReport(violations))
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('✓ No physical inline-axis properties in stylesheets.')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
