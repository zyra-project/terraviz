// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Screenshot coverage report (phase S6).
 *
 * Pure transform: given the key sets each captured scene rendered and
 * the full key set from `locales/en.json`, report how much of the UI
 * string surface has at least one screenshot. Coverage is best-effort
 * context for translators, never a gate — the capturer prints it and
 * (in CI) writes a job summary, but it does NOT fail the build.
 *
 * Lives in the capturer rather than the uploader so it's visible on
 * pull requests (capture runs on PRs; upload does not) and needs no
 * Weblate token. See `docs/WEBLATE_SCREENSHOT_SYNC_PLAN.md`.
 */

export interface CoverageStats {
  /** Total translatable keys in `en.json`. */
  totalKeys: number
  /** Keys that appear in at least one screenshot. */
  coveredKeys: number
  /** Fraction covered, 0–100, one decimal. */
  percent: number
  /** `en.json` keys that appear in no screenshot (sorted). */
  uncovered: string[]
  /** Captured keys not present in `en.json` — stale or dynamically
   *  derived keys worth a look (sorted). */
  unknown: string[]
}

/**
 * @param capturedKeySets one entry per scene — the keys it rendered
 * @param enKeys          every key in `locales/en.json`
 */
export function computeCoverage(
  capturedKeySets: readonly (readonly string[])[],
  enKeys: ReadonlySet<string>,
): CoverageStats {
  const captured = new Set<string>()
  for (const set of capturedKeySets) {
    for (const k of set) captured.add(k)
  }

  let coveredKeys = 0
  for (const k of captured) {
    if (enKeys.has(k)) coveredKeys++
  }

  const uncovered = [...enKeys].filter((k) => !captured.has(k)).sort()
  const unknown = [...captured].filter((k) => !enKeys.has(k)).sort()

  const totalKeys = enKeys.size
  const percent =
    totalKeys === 0 ? 0 : Math.round((coveredKeys / totalKeys) * 1000) / 10

  return { totalKeys, coveredKeys, percent, uncovered, unknown }
}

/** One-line console summary. */
export function formatCoverageLine(stats: CoverageStats): string {
  return (
    `Coverage: ${stats.coveredKeys}/${stats.totalKeys} keys ` +
    `(${stats.percent}%) have a screenshot`
  )
}

/** GitHub Actions step-summary markdown. */
export function formatCoverageMarkdown(
  stats: CoverageStats,
  sceneCount: number,
  cropCount = 0,
): string {
  const lines = [
    '## Weblate screenshot coverage',
    '',
    `- **Scenes captured:** ${sceneCount}`,
    `- **Per-string close-up crops:** ${cropCount}`,
    `- **Keys with a screenshot:** ${stats.coveredKeys} / ${stats.totalKeys} (${stats.percent}%)`,
  ]
  if (stats.unknown.length > 0) {
    lines.push(
      '',
      `> ⚠️ ${stats.unknown.length} captured key(s) are not in \`en.json\` ` +
        '(stale or dynamically built). First few: ' +
        stats.unknown.slice(0, 10).map((k) => `\`${k}\``).join(', '),
    )
  }
  return lines.join('\n') + '\n'
}
