/**
 * PR-comment / job-summary markdown for the visual report (Phase V5).
 *
 * Pure transform: a `ReportManifest` (+ optional `DiffManifest`) → a
 * compact markdown summary posted as an advisory PR comment and written
 * to the GitHub step summary. The leading `MARKER` lets the workflow
 * find and update its own comment in place instead of stacking new ones.
 *
 * Advisory by design — it reports, it never gates. See
 * `docs/VISUAL_REPORT_PLAN.md`.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { REPO_ROOT } from './core/browser'
import { summarizeSignals } from './report/render'
import type { DiffManifest, ReportManifest } from './report/types'

/** HTML comment marker used to find-and-update the existing PR comment. */
export const MARKER = '<!-- visual-report -->'

/** How many changed / problem rows to list before truncating. */
const MAX_ROWS = 12

export function renderPrSummary(
  manifest: ReportManifest,
  diff?: DiffManifest,
  opts: { runUrl?: string } = {},
): string {
  const shots = manifest.shots
  const problemShots = shots.filter((s) => !summarizeSignals(s.signals).ok)
  const totalProblems = shots.reduce(
    (n, s) => n + summarizeSignals(s.signals).total,
    0,
  )

  const lines: string[] = [
    MARKER,
    '## 🖼️ Visual report',
    '',
    `**${shots.length}** shot(s) · **${manifest.viewports.length}** viewport(s) ` +
      `(${manifest.viewports.join(', ')}) · **${problemShots.length}** with problems ` +
      `· **${totalProblems}** problem(s) total`,
  ]

  if (diff) {
    const changed = diff.comparisons.filter((c) => c.changed)
    const fresh = diff.comparisons.filter((c) => c.status === 'new')
    lines.push(
      '',
      `**Regression:** ${changed.length} shot(s) changed, ${fresh.length} new ` +
        `(baseline-less, soft pass), threshold ${diff.threshold}.`,
    )
    if (changed.length > 0) {
      lines.push('', '| Scene | Viewport | Change |', '| --- | --- | --- |')
      for (const c of changed.slice(0, MAX_ROWS)) {
        const amount =
          c.status === 'size-changed'
            ? 'size changed'
            : `${(c.ratio * 100).toFixed(2)}% (${c.changedPixels} px)`
        lines.push(`| ${c.scene} | ${c.viewport} | ${amount} |`)
      }
      if (changed.length > MAX_ROWS) lines.push(`| … | | +${changed.length - MAX_ROWS} more |`)
    }
  } else {
    lines.push('', '_No baseline to diff against (soft pass)._')
  }

  if (problemShots.length > 0) {
    lines.push('', '<details><summary>Shots with problems</summary>', '')
    lines.push('| Scene | Viewport | Errors | Failed req | a11y |', '| --- | --- | --- | --- | --- |')
    for (const s of problemShots.slice(0, MAX_ROWS)) {
      const sum = summarizeSignals(s.signals)
      lines.push(`| ${s.scene} | ${s.viewport} | ${sum.errors} | ${sum.failures} | ${sum.axe} |`)
    }
    if (problemShots.length > MAX_ROWS)
      lines.push(`| … | | | | +${problemShots.length - MAX_ROWS} more |`)
    lines.push('', '</details>')
  }

  lines.push(
    '',
    opts.runUrl
      ? `[Full report → \`visual-report\` artifact](${opts.runUrl})`
      : '_Full report in the `visual-report` artifact._',
    '',
    '<sub>Advisory — this check never fails the build. Visual review only.</sub>',
  )

  return lines.join('\n') + '\n'
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    // A genuinely-absent file is "doesn't exist"; anything else
    // (permissions, etc.) is a real error worth surfacing.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  // A present-but-invalid file is a real problem — don't mask it as
  // "missing", which would print a misleading "run report first".
  return JSON.parse(raw) as T
}

async function run(): Promise<void> {
  const outDir = resolve(
    process.env.SCREENSHOT_OUT_DIR ?? resolve(REPO_ROOT, 'report-out'),
  )
  const manifest = await readJsonIfExists<ReportManifest>(
    resolve(outDir, 'report.json'),
  )
  if (!manifest) {
    // eslint-disable-next-line no-console
    console.error(`No report.json in ${outDir}; run screenshots:report first.`)
    process.exitCode = 1
    return
  }
  const diff = await readJsonIfExists<DiffManifest>(resolve(outDir, 'diff.json'))
  const md = renderPrSummary(manifest, diff, { runUrl: process.env.VISUAL_RUN_URL })

  // eslint-disable-next-line no-console
  console.log(md)
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(summaryPath, md)
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((err) => {
    if (err instanceof Error) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  })
}

export { run }
