/**
 * Tour shot-sequencing experiment (`docs/TOUR_DIRECTION_PLAN.md` D1).
 *
 *   npx tsx scripts/experiments/tour-sequencing/run.ts [--json out.json]
 *
 * Runs the REAL matcher (`proposeMatches`) over the REAL catalogue
 * snapshot for a set of draft events, then orders each candidate pool
 * under every similarity variant across a sweep of variety weights,
 * and reports what actually changes.
 *
 * The point is not to pick a winner automatically. It is to show which
 * signals are alive on real data, how often ordering moves at all, and
 * what match score it costs when it does.
 */

import { writeFileSync } from 'node:fs'
import { proposeMatches } from '../../../functions/api/v1/_lib/events-matcher'
import { loadCorpus } from './harness'
import { orderWith } from './mmr'
import { orderTourStops, type StopCandidate } from '../../../functions/api/v1/_lib/tour-stop-order'
import { DRAFT_EVENTS } from './events'
import { VARIANTS, type RichCandidate, type SimilarityFn } from './signals'

const STOPS = 4
const WEIGHTS = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1]

function meanAdjacentSimilarity(order: readonly RichCandidate[], sim: SimilarityFn): number {
  if (order.length < 2) return 0
  let total = 0
  for (let i = 1; i < order.length; i++) total += sim(order[i - 1], order[i])
  return total / (order.length - 1)
}

function distinctTags(order: readonly RichCandidate[]): number {
  return new Set(order.flatMap(c => c.tags)).size
}

function meanScore(order: readonly RichCandidate[]): number {
  if (order.length === 0) return 0
  return order.reduce((s, c) => s + (c.matchScore ?? 0), 0) / order.length
}

function main(): void {
  const { rich, match } = loadCorpus()
  const nowMs = Date.parse('2026-08-27T00:00:00.000Z')

  // Corpus facts, measured not assumed.
  const all = [...rich.values()]
  const coverage = {
    datasets: all.length,
    withTags: all.filter(c => c.tags.length > 0).length,
    withCategories: all.filter(c => c.categories.length > 0).length,
    withKeywords: all.filter(c => c.keywords.length > 0).length,
    withBbox: all.filter(c => c.bbox !== null).length,
    withBothTimes: all.filter(c => c.startMs !== null && c.endMs !== null).length,
    distinctTags: new Set(all.flatMap(c => c.tags)).size,
  }

  // Guard-the-guard: proof that the fidelity check above was live.
  let guardSawSignal = false
  let maxShippedSimilarity = 0

  const perEvent: unknown[] = []
  const variantTotals = new Map<string, { moved: number; events: number; scoreDelta: number; adjDelta: number }>()
  for (const v of VARIANTS) variantTotals.set(v.key, { moved: 0, events: 0, scoreDelta: 0, adjDelta: 0 })

  for (const event of DRAFT_EVENTS) {
    const matches = proposeMatches(event.match, match, { nowMs, limit: 40 })
    const pool: RichCandidate[] = matches
      .map(m => {
        const base = rich.get(m.datasetId)!
        return { ...base, matchScore: m.score }
      })
    const scoreOrder = [...pool]
      .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0) || a.id.localeCompare(b.id))
      .slice(0, STOPS)

    // Self-check: the harness loop must reproduce the shipped function
    // on the shipped signal, or nothing below means anything.
    //
    // An earlier revision of this guard was VACUOUS. It ran on a corpus
    // where every candidate had empty facets, so `stopSimilarity` was 0
    // for every pair, the MMR penalty was multiplied by zero on both
    // sides, and each collapsed to the same plain score sort. It would
    // have passed against a deliberately broken loop — and did, under a
    // mutation test. `guardSawSignal` below is the fix: the guard has to
    // prove it exercised a non-zero penalty at least once, or the run
    // aborts rather than reporting numbers nothing verified.
    if (pool.length > 0) {
      const shippedStops: StopCandidate[] = pool.map(c => ({
        id: c.id,
        matchScore: c.matchScore,
        categories: c.categories,
        keywords: c.keywords,
        bbox: c.bbox,
      }))
      const viaShipped = orderTourStops(shippedStops, { limit: STOPS })
      const viaHarness = orderWith(pool, VARIANTS[0].fn, STOPS, 0.45)
      if (viaShipped.join() !== viaHarness.join()) {
        throw new Error(`harness diverged from orderTourStops on event ${event.key}`)
      }
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const s = VARIANTS[0].fn(pool[i], pool[j])
          if (s > 0) guardSawSignal = true
          if (s > maxShippedSimilarity) maxShippedSimilarity = s
        }
      }
    }

    const variants: Record<string, unknown> = {}
    for (const v of VARIANTS) {
      const byWeight: Record<string, unknown> = {}
      for (const w of WEIGHTS) {
        const ids = orderWith(pool, v.fn, STOPS, w)
        const ordered = ids.map(id => pool.find(c => c.id === id)!)
        byWeight[String(w)] = {
          ids,
          titles: ordered.map(c => c.title),
          movedFromScoreOrder: ids.join() !== scoreOrder.map(c => c.id).join(),
          meanAdjacentSimilarity: Number(meanAdjacentSimilarity(ordered, v.fn).toFixed(4)),
          distinctTags: distinctTags(ordered),
          meanMatchScore: Number(meanScore(ordered).toFixed(4)),
        }
      }
      const at = byWeight['0.45'] as { movedFromScoreOrder: boolean; meanMatchScore: number; meanAdjacentSimilarity: number }
      const baseline = byWeight['0'] as { meanMatchScore: number; meanAdjacentSimilarity: number }
      const totals = variantTotals.get(v.key)!
      totals.events += 1
      if (at.movedFromScoreOrder) totals.moved += 1
      totals.scoreDelta += at.meanMatchScore - baseline.meanMatchScore
      totals.adjDelta += at.meanAdjacentSimilarity - baseline.meanAdjacentSimilarity
      variants[v.key] = byWeight
    }

    perEvent.push({
      key: event.key,
      archetype: event.archetype,
      title: event.title,
      poolSize: pool.length,
      scoreOrder: scoreOrder.map(c => ({ id: c.id, title: c.title, tags: c.tags, score: c.matchScore })),
      variants,
    })
  }

  if (!guardSawSignal) {
    throw new Error(
      'fidelity guard was vacuous: the shipped similarity scored 0 for every candidate pair, ' +
        'so it could not distinguish the harness loop from any other algorithm. Refusing to ' +
        'report numbers this run did not verify.',
    )
  }

  const summary = [...variantTotals.entries()].map(([key, t]) => ({
    variant: key,
    label: VARIANTS.find(v => v.key === key)!.label,
    eventsWhereOrderMoved: `${t.moved}/${t.events}`,
    meanMatchScoreDelta: Number((t.scoreDelta / t.events).toFixed(4)),
    meanAdjacentSimilarityDelta: Number((t.adjDelta / t.events).toFixed(4)),
  }))

  const out = { generatedFor: 'D1 sequencing experiment', stops: STOPS, weights: WEIGHTS, coverage, summary, perEvent }
  const jsonIndex = process.argv.indexOf('--json')
  if (jsonIndex !== -1 && process.argv[jsonIndex + 1]) {
    writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(out, null, 2))
  }

  console.log(
    '\n=== fidelity guard: live (max shipped-signal similarity seen: %s) ===',
    maxShippedSimilarity.toFixed(4),
  )
  console.log('\n=== corpus coverage (live catalogue, %d datasets) ===', coverage.datasets)
  for (const [k, v] of Object.entries(coverage)) {
    if (k === 'datasets') continue
    const pct = typeof v === 'number' && k.startsWith('with') ? ` (${Math.round((100 * v) / coverage.datasets)}%)` : ''
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(4)}${pct}`)
  }
  console.log('\n=== candidate pools ===')
  for (const e of perEvent as Array<{ key: string; poolSize: number; archetype: string }>) {
    console.log(`  ${e.key.padEnd(10)} pool=${String(e.poolSize).padStart(3)}  ${e.archetype}`)
  }
  console.log('\n=== variant summary @ varietyWeight 0.45 (vs plain score order) ===')
  for (const s of summary) {
    console.log(
      `  ${s.variant}  moved ${s.eventsWhereOrderMoved.padEnd(5)}  Δscore ${String(s.meanMatchScoreDelta).padStart(8)}  Δadj-sim ${String(s.meanAdjacentSimilarityDelta).padStart(8)}  ${s.label}`,
    )
  }
  console.log()
}

main()
