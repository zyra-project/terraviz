/**
 * Self-contained HTML renderer for the visual report.
 *
 * Pure transform: a `ReportManifest` (+ optional regression diffs, wired
 * in a later phase) → one `index.html` string. The report sits next to
 * the PNGs in the output directory, so images are referenced by relative
 * filename. No framework, inline CSS, browser-free — unit-tested by
 * snapshotting the output for a fixture manifest.
 *
 * This is dev/CI output, not shipped UI, so its strings are deliberately
 * not routed through the app's i18n layer. (The i18n string check only
 * scans `src/`, so nothing here is flagged; this note is for the reader.)
 *
 * See `docs/VISUAL_REPORT_PLAN.md`.
 */

import type { SceneSignals } from '../core/signals'

import type {
  DiffComparison,
  DiffManifest,
  ReportManifest,
  ReportShot,
} from './types'

export interface SignalSummary {
  /** console errors + uncaught page errors. */
  errors: number
  /** console warnings (shown, but do not flip `ok`). */
  warnings: number
  /** failed requests + 4xx/5xx responses. */
  failures: number
  /** axe-core violations (0 when no scan ran). */
  axe: number
  /** errors + failures + axe — the "problem" count that gates `ok`. */
  total: number
  /** true when there are no hard problems. */
  ok: boolean
}

/** Reduce a scene's raw signals to display/gate counts. */
export function summarizeSignals(s: SceneSignals): SignalSummary {
  const errors = s.consoleErrors.length + s.pageErrors.length
  const warnings = s.consoleWarnings.length
  const failures = s.failedRequests.length + s.badResponses.length
  const axe = s.axeViolations?.length ?? 0
  const total = errors + failures + axe
  return { errors, warnings, failures, axe, total, ok: total === 0 }
}

/** Minimal HTML-escape for text interpolated into the report. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Group shots by scene, preserving first-seen scene order. */
function groupByScene(shots: ReportShot[]): Map<string, ReportShot[]> {
  const groups = new Map<string, ReportShot[]>()
  for (const shot of shots) {
    const list = groups.get(shot.scene)
    if (list) list.push(shot)
    else groups.set(shot.scene, [shot])
  }
  return groups
}

function badge(label: string, count: number, kind: string): string {
  if (count <= 0) return ''
  return `<span class="badge badge-${kind}">${escapeHtml(label)}: ${count}</span>`
}

/** The per-signal problem list shown under a shot, when non-empty. */
function renderProblems(s: SceneSignals): string {
  const lines: string[] = []
  for (const e of s.pageErrors) lines.push(`<li class="err">page error: ${escapeHtml(e)}</li>`)
  for (const e of s.consoleErrors) lines.push(`<li class="err">console error: ${escapeHtml(e)}</li>`)
  for (const r of s.failedRequests)
    lines.push(`<li class="warn">request failed (${escapeHtml(r.failure)}): ${escapeHtml(r.url)}</li>`)
  for (const r of s.badResponses)
    lines.push(`<li class="warn">HTTP ${r.status}: ${escapeHtml(r.url)}</li>`)
  for (const v of s.axeViolations ?? []) {
    // Link the rule id to its axe/Deque docs; list the offending node
    // selectors in an expandable <details> so the failure is locatable.
    const rule = v.helpUrl
      ? `<a href="${escapeHtml(v.helpUrl)}" target="_blank" rel="noopener">${escapeHtml(v.id)}</a>`
      : escapeHtml(v.id)
    const where =
      v.targets.length > 0
        ? `<details><summary>${v.nodes} node(s)</summary><ul class="a11y-targets">` +
          v.targets.map((t) => `<li><code>${escapeHtml(t)}</code></li>`).join('') +
          '</ul></details>'
        : `(${v.nodes} node(s))`
    lines.push(
      `<li class="a11y">a11y ${escapeHtml(v.impact ?? 'n/a')} — ${rule} ${where}</li>`,
    )
  }
  for (const w of s.consoleWarnings) lines.push(`<li class="muted">console warning: ${escapeHtml(w)}</li>`)
  if (lines.length === 0) return ''
  return `<ul class="problems">${lines.join('')}</ul>`
}

/** A "changed N.NN% (P px)" / "new" / "size changed" diff badge. */
function diffBadge(d: DiffComparison): string {
  if (d.status === 'new') return '<span class="badge badge-muted">new (no baseline)</span>'
  if (d.status === 'size-changed') return '<span class="badge badge-err">size changed</span>'
  if (d.status === 'changed')
    return `<span class="badge badge-err">changed ${(d.ratio * 100).toFixed(2)}% (${d.changedPixels} px)</span>`
  return '<span class="badge badge-ok">no visual change</span>'
}

/** Baseline + diff thumbnails for a changed shot (current is the main img). */
function renderDiffTriptych(d: DiffComparison): string {
  if (!d.changed) return ''
  const cells: string[] = []
  if (d.baselineFile) {
    cells.push(
      `<figure><figcaption>baseline</figcaption><a href="${escapeHtml(d.baselineFile)}" target="_blank" rel="noopener"><img loading="lazy" src="${escapeHtml(d.baselineFile)}" alt="baseline" /></a></figure>`,
    )
  }
  if (d.diffFile) {
    cells.push(
      `<figure><figcaption>diff</figcaption><a href="${escapeHtml(d.diffFile)}" target="_blank" rel="noopener"><img loading="lazy" src="${escapeHtml(d.diffFile)}" alt="diff" /></a></figure>`,
    )
  }
  if (cells.length === 0) return ''
  return `<div class="diff-row">${cells.join('')}</div>`
}

function renderShot(shot: ReportShot, diff?: DiffComparison): string {
  const sum = summarizeSignals(shot.signals)
  const badges =
    badge('errors', sum.errors, 'err') +
    badge('failed', sum.failures, 'warn') +
    badge('a11y', sum.axe, 'a11y') +
    badge('warnings', sum.warnings, 'muted')
  const status = sum.ok ? '<span class="badge badge-ok">ok</span>' : ''
  const diffMark = diff ? diffBadge(diff) : ''
  return `
      <figure class="shot ${sum.ok ? '' : 'has-problems'} ${diff?.changed ? 'changed' : ''}">
        <figcaption>
          <span class="vp">${escapeHtml(shot.viewport)} · ${shot.width}×${shot.height}</span>
          ${status}${diffMark}${badges}
        </figcaption>
        <a href="${escapeHtml(shot.file)}" target="_blank" rel="noopener">
          <img loading="lazy" src="${escapeHtml(shot.file)}" alt="${escapeHtml(shot.scene)} (${escapeHtml(shot.viewport)})" />
        </a>
        ${diff ? renderDiffTriptych(diff) : ''}
        ${renderProblems(shot.signals)}
      </figure>`
}

function renderScene(
  scene: string,
  shots: ReportShot[],
  diffs?: Map<string, DiffComparison>,
): string {
  const description = shots[0]?.description ?? ''
  const anyProblems = shots.some((s) => !summarizeSignals(s.signals).ok)
  const anyChanged = shots.some((s) => diffs?.get(s.file)?.changed)
  const heading =
    escapeHtml(scene) +
    (anyProblems ? ' <span class="badge badge-err">problems</span>' : '') +
    (anyChanged ? ' <span class="badge badge-err">changed</span>' : '')
  return `
    <section class="scene ${anyProblems || anyChanged ? 'scene-problems' : ''}" id="scene-${escapeHtml(scene)}">
      <h2>${heading}</h2>
      <p class="desc">${escapeHtml(description)}</p>
      <div class="shots">${shots.map((s) => renderShot(s, diffs?.get(s.file))).join('')}</div>
    </section>`
}

/** Render the whole report to a single self-contained HTML document. */
export function renderReportHtml(
  manifest: ReportManifest,
  opts: { diffs?: DiffManifest } = {},
): string {
  const diffs = opts.diffs
    ? new Map(opts.diffs.comparisons.map((c) => [c.file, c]))
    : undefined

  const groups = groupByScene(manifest.shots)
  const sceneCount = groups.size
  const problemScenes = [...groups.values()].filter((shots) =>
    shots.some((s) => !summarizeSignals(s.signals).ok),
  ).length
  const totalProblems = manifest.shots.reduce(
    (n, s) => n + summarizeSignals(s.signals).total,
    0,
  )
  const changedShots = diffs
    ? [...diffs.values()].filter((c) => c.changed).length
    : 0
  const diffSummary = opts.diffs
    ? ` · ${changedShots} shot(s) changed vs baseline`
    : ''

  const sections = [...groups.entries()]
    .map(([scene, shots]) => renderScene(scene, shots, diffs))
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Terraviz visual report</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  header { padding: 1.25rem 1.5rem; border-bottom: 1px solid #30363d;
    position: sticky; top: 0; background: #0d1117ee; backdrop-filter: blur(6px); z-index: 1; }
  header h1 { margin: 0 0 .25rem; font-size: 1.1rem; }
  header .meta { color: #8b949e; font-size: .82rem; }
  main { padding: 1.5rem; }
  .scene { margin-bottom: 2rem; border: 1px solid #30363d; border-radius: 10px; padding: 1rem 1.25rem; }
  .scene-problems { border-color: #6e2630; background: #1a0f12; }
  .scene h2 { margin: 0; font-size: 1rem; }
  .desc { color: #8b949e; margin: .25rem 0 1rem; }
  .shots { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }
  figure.shot { margin: 0; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; background: #161b22; }
  figure.has-problems { border-color: #6e2630; }
  figure.changed { border-color: #9e6a00; }
  .diff-row { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem; padding: .4rem;
    border-top: 1px solid #30363d; }
  .diff-row figure { margin: 0; }
  .diff-row figcaption { padding: .25rem .4rem; color: #8b949e; border: none; font-size: .72rem; }
  .diff-row img { border: 1px solid #30363d; }
  figcaption { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center;
    padding: .5rem .6rem; border-bottom: 1px solid #30363d; }
  figcaption .vp { color: #8b949e; margin-inline-end: auto; font-variant-numeric: tabular-nums; }
  img { display: block; width: 100%; height: auto; background: #000; }
  .badge { font-size: .72rem; padding: .1rem .4rem; border-radius: 999px; white-space: nowrap; }
  .badge-ok { background: #15311f; color: #56d364; }
  .badge-err { background: #4a1620; color: #ff7b72; }
  .badge-warn { background: #3a2a12; color: #e3b341; }
  .badge-a11y { background: #1c2b4a; color: #79c0ff; }
  .badge-muted { background: #21262d; color: #8b949e; }
  ul.problems { margin: 0; padding: .5rem .9rem; list-style: none; font-size: .78rem;
    border-top: 1px solid #30363d; max-height: 11rem; overflow: auto; }
  ul.problems li { padding: .12rem 0; }
  li.err { color: #ff7b72; } li.warn { color: #e3b341; }
  li.a11y { color: #79c0ff; } li.muted { color: #8b949e; }
  li.a11y a { color: #79c0ff; text-decoration: underline; }
  li.a11y details { display: inline-block; vertical-align: top; }
  li.a11y summary { cursor: pointer; color: #8b949e; }
  ul.a11y-targets { margin: .2rem 0 .2rem 1rem; padding: 0; list-style: disc; }
  ul.a11y-targets code { color: #adbac7; word-break: break-all; }
</style>
</head>
<body>
<header>
  <h1>Terraviz visual report</h1>
  <div class="meta">
    ${escapeHtml(manifest.baseUrl)} · ${escapeHtml(manifest.generatedAt)} ·
    ${sceneCount} scene(s) × ${manifest.viewports.length} viewport(s) ·
    ${problemScenes} scene(s) with problems · ${totalProblems} problem(s) total${diffSummary}
  </div>
</header>
<main>
${sections}
</main>
</body>
</html>
`
}
