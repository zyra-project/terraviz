// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Render the sequencing experiment as (a) a blind A/B pack for
 * independent judging and (b) a human-readable HTML report.
 *
 *   npx tsx scripts/experiments/tour-sequencing/report.ts <run.json> <outdir>
 *
 * Blind means blind: which side is score-order and which is the
 * candidate signal alternates by event index, and the key is written
 * to a separate file the judges are not given.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface Stop { id: string; title: string; tags: string[]; score: number | null }
interface WeightRow { ids: string[]; titles: string[]; meanAdjacentSimilarity: number; distinctTags: number; meanMatchScore: number; movedFromScoreOrder: boolean }
interface EventRow {
  key: string
  archetype: string
  title: string
  poolSize: number
  scoreOrder: Stop[]
  variants: Record<string, Record<string, WeightRow>>
}

const [, , runPath, outDir] = process.argv
if (!runPath || !outDir) throw new Error('usage: report.ts <run.json> <outdir>')
mkdirSync(outDir, { recursive: true })

const run = JSON.parse(readFileSync(runPath, 'utf8')) as {
  coverage: Record<string, number>
  summary: Array<{ variant: string; label: string; eventsWhereOrderMoved: string; meanMatchScoreDelta: number; meanAdjacentSimilarityDelta: number }>
  perEvent: EventRow[]
}

const CANDIDATE = 'v4'
const WEIGHT = '0.45'

const blind: unknown[] = []
const key: unknown[] = []
for (const [i, e] of run.perEvent.entries()) {
  const scored = e.scoreOrder.map(s => ({ title: s.title, tags: s.tags }))
  const cand = e.variants[CANDIDATE][WEIGHT]
  const candStops = cand.ids.map(id => {
    const hit = e.scoreOrder.find(s => s.id === id)
    return { title: hit?.title ?? cand.titles[cand.ids.indexOf(id)], tags: hit?.tags ?? [] }
  })
  // Alternate which side gets which ordering, by index, so a judge
  // cannot learn "B is always the new one".
  const flip = i % 2 === 1
  blind.push({
    event: e.key,
    headline: e.title,
    optionA: flip ? candStops : scored,
    optionB: flip ? scored : candStops,
  })
  key.push({ event: e.key, optionA: flip ? 'candidate' : 'score-order', optionB: flip ? 'score-order' : 'candidate' })
}
writeFileSync(join(outDir, 'blind-pairs.json'), JSON.stringify(blind, null, 2))
writeFileSync(join(outDir, 'blind-key.json'), JSON.stringify(key, null, 2))

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const stopList = (stops: Array<{ title: string; tags: string[] }>): string =>
  `<ol>${stops.map(s => `<li><span class="t">${esc(s.title)}</span>${s.tags.length ? `<span class="tags">${s.tags.map(t => `<em>${esc(t)}</em>`).join('')}</span>` : ''}</li>`).join('')}</ol>`

const rows = run.perEvent
  .map(e => {
    const cand = e.variants[CANDIDATE][WEIGHT]
    const candStops = cand.ids.map(id => {
      const hit = e.scoreOrder.find(s => s.id === id)
      return { title: hit?.title ?? '(unknown)', tags: hit?.tags ?? [] }
    })
    return `<section>
      <h3>${esc(e.title)}</h3>
      <p class="meta">${esc(e.archetype)} · pool of ${e.poolSize} candidates${cand.movedFromScoreOrder ? '' : ' · <strong>order unchanged</strong>'}</p>
      <div class="pair">
        <div><h4>Score order (today)</h4>${stopList(e.scoreOrder.map(s => ({ title: s.title, tags: s.tags })))}</div>
        <div><h4>Layered signal (proposed)</h4>${stopList(candStops)}</div>
      </div>
    </section>`
  })
  .join('\n')

const summaryRows = run.summary
  .map(
    s =>
      `<tr><td><code>${s.variant}</code></td><td>${esc(s.label)}</td><td>${s.eventsWhereOrderMoved}</td><td>${s.meanMatchScoreDelta}</td><td>${s.meanAdjacentSimilarityDelta}</td></tr>`,
  )
  .join('')

writeFileSync(
  join(outDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Tour sequencing experiment</title>
<style>
 :root{--bg:#fff;--fg:#14181d;--mut:#5b6672;--line:#e3e8ee;--acc:#0b6bcb}
 @media(prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e8edf3;--mut:#9aa7b4;--line:#242c35;--acc:#6fb3ff}}
 body{background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,sans-serif;margin:0 auto;padding:2rem 1.25rem;max-width:1100px}
 h1{font-size:1.6rem;margin:0 0 .25rem} h3{margin:0 0 .2rem;font-size:1.05rem}
 h4{margin:0 0 .4rem;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
 .meta{color:var(--mut);font-size:.85rem;margin:0 0 .75rem}
 section{border-top:1px solid var(--line);padding:1.25rem 0}
 .pair{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
 @media(max-width:720px){.pair{grid-template-columns:1fr}}
 ol{margin:0;padding-left:1.2rem} li{margin:.3rem 0}
 .tags em{font-style:normal;color:var(--mut);font-size:.75rem;border:1px solid var(--line);border-radius:999px;padding:.05rem .45rem;margin-inline-start:.35rem}
 table{border-collapse:collapse;width:100%;font-size:.9rem;margin:1rem 0 2rem}
 th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line)}
 th{color:var(--mut);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
 code{font-family:ui-monospace,monospace}
 .lede{color:var(--mut);max-width:70ch}
</style>
<h1>Tour shot sequencing — real catalogue, real matcher</h1>
<p class="lede">${run.coverage.datasets} live datasets, ${run.coverage.withTags} carrying tags (${Math.round((100 * run.coverage.withTags) / run.coverage.datasets)}%), <strong>${run.coverage.withCategories} with categories, ${run.coverage.withKeywords} with keywords, ${run.coverage.withBbox} with a bounding box</strong>. Candidate pools come from the real <code>proposeMatches</code>; orderings from the shipped MMR loop under each signal at variety weight ${WEIGHT}.</p>
<table><thead><tr><th>Variant</th><th>Signal</th><th>Order moved</th><th>Δ mean match score</th><th>Δ mean adjacent similarity</th></tr></thead><tbody>${summaryRows}</tbody></table>
${rows}
`,
)
console.log(`wrote ${outDir}/index.html, blind-pairs.json, blind-key.json`)
