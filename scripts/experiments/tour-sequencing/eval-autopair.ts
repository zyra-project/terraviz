/**
 * Does "Approve all >= 90%" still fire sensibly?
 *
 *   npx tsx scripts/experiments/tour-sequencing/eval-autopair.ts <eonet.json>
 *
 * AUTO_PAIR_THRESHOLD (90) was calibrated against a lexical score that
 * saturated: ~25% of the catalogue sat at exactly 1.0 for a typical
 * event, so links cleared 0.90 constantly. Replacing that score with an
 * IDF-weighted cosine changes the distribution, and a shortcut that
 * silently stops firing — or starts firing on junk — is a curator-facing
 * regression either way.
 *
 * Run against REAL events (NASA EONET, mapped by the repo's own pure
 * `mapEonetEvent`) rather than hand-written drafts, so the event text is
 * nobody's invention. The live node has no approved events to sample.
 */

import { readFileSync } from 'node:fs'
import {
  buildEventTerms,
  buildIdf,
  isLiveDataset,
  proposeMatches,
  scoreGeo,
  scoreLexical,
  scoreTemporal,
  type MatchDataset,
  type MatchEvent,
} from '../../../functions/api/v1/_lib/events-matcher'
import { mapEonetFeed, type EonetFeed } from '../../../cli/lib/eonet'
import { loadCorpus } from './harness'

/** Frozen copy of the scoring this replaced, for a before/after read.
 *  Deliberately duplicated rather than imported: the point is to compare
 *  against code that no longer exists. */
const OLD_TOPICAL_BASE = 0.75
const OLD_LIVE_BONUS = 0.1
function oldLexical(ev: ReadonlySet<string>, ds: ReadonlySet<string>): number {
  let overlap = 0
  for (const t of ds) if (ev.has(t)) overlap++
  return overlap === 0 ? 0 : Math.min(1, 0.5 + 0.2 * overlap)
}
function oldScore(event: MatchEvent, d: MatchDataset, nowMs: number): number {
  const temporal = scoreTemporal(event, d, nowMs)
  const geo = scoreGeo(event, d.boundingBox)
  const lexical = event.terms && event.terms.size > 0 ? oldLexical(event.terms, d.subjectTerms ?? new Set()) : null
  if (lexical === null) {
    const present = [geo, temporal].filter((v): v is number => v !== null)
    return present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0
  }
  if (lexical === 0) return 0
  let score = lexical * (OLD_TOPICAL_BASE + (1 - OLD_TOPICAL_BASE) * (temporal ?? 0))
  if (isLiveDataset(d, nowMs)) score = Math.min(1, score + OLD_LIVE_BONUS)
  if (geo !== null) score = (score + geo) / 2
  return score
}

const THRESHOLD = 0.9
const LIMIT = 10 // DEFAULT_MATCH_LIMIT — what a curator actually sees

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1).padStart(5)}%`
}

function main(): void {
  const feedPath = process.argv[2]
  if (!feedPath) throw new Error('usage: eval-autopair.ts <eonet.json>')
  const feed = JSON.parse(readFileSync(feedPath, 'utf8')) as EonetFeed
  const events = mapEonetFeed(feed)
  const { rich, match } = loadCorpus()
  const idf = buildIdf(match)
  const nowMs = Date.parse('2026-08-27T00:00:00.000Z')

  let oldLinks = 0, oldAuto = 0, oldEventsWithAuto = 0, oldEventsWithLinks = 0
  let newLinks = 0, newAuto = 0, newEventsWithAuto = 0, newEventsWithLinks = 0
  const newTop: number[] = []
  const oldTop: number[] = []

  for (const body of events) {
    const ev: MatchEvent = {
      point: body.geometry?.point ?? null,
      boundingBox: body.geometry?.boundingBox ?? null,
      occurredStart: body.occurredStart ?? null,
      occurredEnd: body.occurredEnd ?? null,
      terms: buildEventTerms({
        title: body.title,
        summary: body.summary,
        categoryValues: Object.values(body.categories ?? {}).flat(),
        keywords: body.keywords,
      }),
    }

    const now = proposeMatches(ev, match, { nowMs, limit: LIMIT })
    newLinks += now.length
    const nAuto = now.filter(m => m.score >= THRESHOLD).length
    newAuto += nAuto
    if (now.length) { newEventsWithLinks++; newTop.push(now[0].score) }
    if (nAuto) newEventsWithAuto++

    const before = match
      .map(d => ({ datasetId: d.id, score: oldScore(ev, d, nowMs) }))
      .filter(m => m.score >= 0.5)
      .sort((a, b) => b.score - a.score || a.datasetId.localeCompare(b.datasetId))
      .slice(0, LIMIT)
    oldLinks += before.length
    const oAuto = before.filter(m => m.score >= THRESHOLD).length
    oldAuto += oAuto
    if (before.length) { oldEventsWithLinks++; oldTop.push(before[0].score) }
    if (oAuto) oldEventsWithAuto++
  }

  const n = events.length
  const med = (xs: number[]): string => {
    if (!xs.length) return 'n/a'
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)].toFixed(3)
  }

  console.log(`\nReal events (NASA EONET, mapped): ${n}   catalogue: ${match.length} datasets`)
  console.log(`Auto-pair fires at raw score >= ${THRESHOLD}; curator sees top ${LIMIT} per event.\n`)
  console.log('                                     before (saturating)   after (IDF cosine)')
  console.log(`  events with any proposed link        ${String(oldEventsWithLinks).padStart(5)}/${n}          ${String(newEventsWithLinks).padStart(5)}/${n}`)
  console.log(`  total proposed links                 ${String(oldLinks).padStart(11)}      ${String(newLinks).padStart(11)}`)
  console.log(`  links that auto-pair                 ${String(oldAuto).padStart(11)}      ${String(newAuto).padStart(11)}`)
  console.log(`  share of links auto-pairing          ${pct(oldAuto, oldLinks)}            ${pct(newAuto, newLinks)}`)
  console.log(`  events where the shortcut appears    ${String(oldEventsWithAuto).padStart(5)}/${n}          ${String(newEventsWithAuto).padStart(5)}/${n}`)
  console.log(`  median top score                     ${med(oldTop).padStart(11)}      ${med(newTop).padStart(11)}`)

  // What threshold would the new distribution need to keep the shortcut
  // useful without making it indiscriminate?
  console.log('\n  candidate thresholds under the new score:')
  for (const t of [0.7, 0.75, 0.8, 0.85, 0.9]) {
    let fires = 0, evs = 0
    for (const body of events) {
      const ev: MatchEvent = {
        point: body.geometry?.point ?? null,
        boundingBox: body.geometry?.boundingBox ?? null,
        occurredStart: body.occurredStart ?? null,
        occurredEnd: body.occurredEnd ?? null,
        terms: buildEventTerms({
          title: body.title,
          summary: body.summary,
          categoryValues: Object.values(body.categories ?? {}).flat(),
          keywords: body.keywords,
        }),
      }
      const now = proposeMatches(ev, match, { nowMs, limit: LIMIT })
      const f = now.filter(m => m.score >= t).length
      fires += f
      if (f) evs++
    }
    console.log(`    >= ${t.toFixed(2)}   ${String(fires).padStart(4)} links across ${String(evs).padStart(3)}/${n} events`)
  }

  // The decisive quality question: counting how often the shortcut
  // fires says nothing about whether it should. Print every link that
  // WOULD be mass-approved so the pairing can be judged by eye.
  // The scenario-family dedupe itself is NOT measured here. Importing
  // autoPairTargets would pull SPA UI modules into this project, which
  // is typed for Cloudflare Workers — `Response` and `import.meta.env`
  // mean different things in the two worlds and the conflict is real,
  // not a config nit. The dedupe is locked by unit tests next to the
  // function; measured against this same feed it took the 45 links
  // below down to 21, one scenario per family.
  console.log('\n  every link that auto-pairs (>= 0.90) — judge these:')
  const seen = new Map<string, number>()
  for (const body of events) {
    const ev: MatchEvent = {
      point: body.geometry?.point ?? null,
      boundingBox: body.geometry?.boundingBox ?? null,
      occurredStart: body.occurredStart ?? null,
      occurredEnd: body.occurredEnd ?? null,
      terms: buildEventTerms({
        title: body.title,
        summary: body.summary,
        categoryValues: Object.values(body.categories ?? {}).flat(),
        keywords: body.keywords,
      }),
    }
    for (const m of proposeMatches(ev, match, { nowMs, limit: LIMIT })) {
      if (m.score < THRESHOLD) continue
      const key = rich.get(m.datasetId)!.title
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
  }
  for (const [title, count] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(3)}x  ${title}`)
  }

  console.log('\n  sample (real event -> top match under the new score):')
  for (const body of events.slice(0, 6)) {
    const ev: MatchEvent = {
      point: body.geometry?.point ?? null,
      boundingBox: body.geometry?.boundingBox ?? null,
      occurredStart: body.occurredStart ?? null,
      occurredEnd: body.occurredEnd ?? null,
      terms: buildEventTerms({
        title: body.title,
        summary: body.summary,
        categoryValues: Object.values(body.categories ?? {}).flat(),
        keywords: body.keywords,
      }),
    }
    const top = proposeMatches(ev, match, { nowMs, limit: 1 })[0]
    console.log(
      `    ${body.title.slice(0, 42).padEnd(44)} ${top ? `${top.score.toFixed(3)}  ${rich.get(top.datasetId)!.title.slice(0, 40)}` : '(no match)'}`,
    )
  }
  console.log()
}

main()
