// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Reports planning docs whose `Last reviewed:` date has gone stale.
 *
 * Five docs carry the marker (federation-scoping, AGENT_SDK_EVALUATION,
 * HERO_ADMIN_SCOPING, PUBLISHER_ROLES_PLAN, WORDPRESS_INTEGRATION_PLAN),
 * and CLAUDE.md asks readers to verify freshness *before applying a
 * doc's directives* — "surface that to the user before proceeding rather
 * than silently applying potentially stale guidance". That instruction
 * currently depends on someone remembering to compare two dates.
 *
 * **Advisory by default, and deliberately not in the `type-check`
 * chain.** A date threshold that fails CI would break a build with no
 * code change, on whichever unrelated PR happens to be open the day a
 * doc crosses the line. Punishing the next person to push is not how you
 * get a doc reviewed. `--strict` exits non-zero for anyone who wants it
 * as a gate in their own workflow.
 *
 * What it cannot check: every one of these docs also carries a
 * "Revisit when:" list of prose triggers ("Phase 4 federation ships in
 * production", "the publisher-CLI pilot reveals auth-flow problems").
 * Those need judgement, not a date comparison, so a fresh date is
 * necessary but not sufficient — the report says so rather than implying
 * a clean run means the guidance is current.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** Past this age a doc is reported. CLAUDE.md's federation rule says
 *  "more than ~6 months old"; the others carry no explicit cadence, so
 *  they inherit it. */
export const STALE_AFTER_DAYS = 183

/** Reported before it is stale, so a review can be scheduled rather
 *  than discovered late. */
export const AGEING_AFTER_DAYS = 137

/**
 * The colon is REQUIRED, and must sit either inside or immediately after
 * the bold markers — `**Last reviewed:** D`, `**Last reviewed**: D`, or
 * `Last reviewed: D`.
 *
 * An earlier version made the colon optional, which matched prose that
 * merely *cites* another doc's date. `docs/CURRENT_EVENTS_PLAN.md` says
 * "**Last reviewed 2026-05-04** — within the ~6-month freshness window"
 * about federation-scoping.md; that was read as CURRENT_EVENTS_PLAN
 * declaring its own marker. The miscount was the harmless half. The
 * damaging half is that when federation-scoping does age out, the report
 * would name CURRENT_EVENTS_PLAN too and send the reader to update a
 * line that is not a marker at all.
 */
const MARKER = /Last reviewed(?::\*{0,2}|\*{0,2}:)\s*(\d{4}-\d{2}-\d{2})/

export type Freshness = 'current' | 'ageing' | 'stale'

export interface DocAge {
  readonly file: string
  readonly reviewed: string
  readonly days: number
  readonly status: Freshness
}

export function classify(days: number): Freshness {
  if (days >= STALE_AFTER_DAYS) return 'stale'
  if (days >= AGEING_AFTER_DAYS) return 'ageing'
  return 'current'
}

/** Returns null when the file carries no marker — most docs don't, and
 *  that is not a finding. */
export function readDocAge(file: string, text: string, today: Date): DocAge | null {
  const m = MARKER.exec(text)
  if (!m) return null
  const reviewed = m[1]
  const then = Date.parse(`${reviewed}T00:00:00Z`)
  if (Number.isNaN(then)) return null
  const days = Math.floor((today.getTime() - then) / 86_400_000)
  return { file, reviewed, days, status: classify(days) }
}

function markdownFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

export function formatReport(ages: readonly DocAge[]): string {
  const flagged = ages.filter((a) => a.status !== 'current')
  if (flagged.length === 0) return ''
  const months = (d: number) => (d / 30.4).toFixed(1)
  const lines = [`[doc-freshness] ${flagged.length} planning doc(s) due for review:`, '']
  for (const a of flagged) {
    lines.push(
      `  ${a.file}` +
        `\n    last reviewed ${a.reviewed} (${a.days}d, ~${months(a.days)} months) — ${a.status}`,
    )
  }
  lines.push(
    '',
    'Re-read the doc, confirm its directives still hold, and update the',
    '`Last reviewed:` line — or, if a "Revisit when:" trigger has fired,',
    'act on that instead of just bumping the date.',
    '',
    'A fresh date is necessary but not sufficient: the "Revisit when:"',
    'triggers are prose and cannot be checked here.',
  )
  return lines.join('\n')
}

export function run(argv: readonly string[] = process.argv.slice(2), today = new Date()): void {
  const strict = argv.includes('--strict')
  // `--quiet` suppresses the success line so a SessionStart hook can run
  // this every boot and stay silent until something actually ages out.
  const quiet = argv.includes('--quiet')
  const ages = markdownFiles()
    .map((f) => readDocAge(f, readFileSync(f, 'utf8'), today))
    .filter((a): a is DocAge => a !== null)
    .sort((a, b) => b.days - a.days)

  const report = formatReport(ages)
  if (report) {
    console.error(report)
    if (strict) process.exit(1)
    return
  }
  if (quiet) return
  // eslint-disable-next-line no-console
  console.log(`✓ ${ages.length} dated planning doc(s) reviewed within ${STALE_AFTER_DAYS} days.`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
