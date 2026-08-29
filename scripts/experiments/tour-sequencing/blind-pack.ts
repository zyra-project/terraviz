/**
 * Build a THREE-arm blind pack for judging tour stop orderings.
 *
 *   npx tsx scripts/experiments/tour-sequencing/blind-pack.ts <outdir>
 *
 * Arms per event:
 *   score  — plain match-score order, what ships today
 *   cand   — the candidate signal (v3) at variety weight 0.45
 *   anti   — the SAME loop with the penalty inverted, so it deliberately
 *            clusters lookalikes together
 *
 * `anti` is the point. The previous round of judging had no control, so
 * a preference for the candidate could not be distinguished from judges
 * inventing differences between near-identical lists. If judges cannot
 * reliably rank `cand` above `anti`, the instrument is not measuring
 * anything and no preference it reports should be believed.
 *
 * Arm→label assignment rotates by event index so no label is
 * systematically one arm.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { proposeMatches } from '../../../functions/api/v1/_lib/events-matcher'
import { loadCorpus } from './harness'
import { orderWith } from './mmr'
import { DRAFT_EVENTS } from './events'
import { VARIANTS, type RichCandidate } from './signals'

const outDir = process.argv[2]
if (!outDir) throw new Error('usage: blind-pack.ts <outdir>')
mkdirSync(outDir, { recursive: true })

const CANDIDATE = VARIANTS.find(v => v.key === 'v3')!
const STOPS = 4
const WEIGHT = 0.45
const LABELS = ['A', 'B', 'C'] as const

const { rich, match } = loadCorpus()
const nowMs = Date.parse('2026-08-27T00:00:00.000Z')

const pack: unknown[] = []
const key: unknown[] = []

for (const [i, event] of DRAFT_EVENTS.entries()) {
  const pool: RichCandidate[] = proposeMatches(event.match, match, { nowMs, limit: 40 }).map(m => ({
    ...rich.get(m.datasetId)!,
    matchScore: m.score,
  }))
  if (pool.length < STOPS) continue

  const byId = new Map(pool.map(c => [c.id, c]))
  const render = (ids: string[]): Array<{ title: string; tags: string[] }> =>
    ids.map(id => ({ title: byId.get(id)!.title, tags: [...byId.get(id)!.tags] }))

  const arms = {
    score: render(
      [...pool]
        .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0) || a.id.localeCompare(b.id))
        .slice(0, STOPS)
        .map(c => c.id),
    ),
    cand: render(orderWith(pool, CANDIDATE.fn, STOPS, WEIGHT)),
    anti: render(orderWith(pool, CANDIDATE.fn, STOPS, WEIGHT, true)),
  }

  // Rotate arm→label by event index.
  const order: Array<keyof typeof arms> = [
    (['score', 'cand', 'anti'] as const)[i % 3],
    (['cand', 'anti', 'score'] as const)[i % 3],
    (['anti', 'score', 'cand'] as const)[i % 3],
  ]
  const entry: Record<string, unknown> = { event: event.key, headline: event.title }
  const mapping: Record<string, string> = {}
  order.forEach((arm, slot) => {
    entry[`option${LABELS[slot]}`] = arms[arm]
    mapping[`option${LABELS[slot]}`] = arm
  })
  pack.push(entry)
  key.push({ event: event.key, ...mapping })
}

writeFileSync(join(outDir, 'blind-pairs.json'), JSON.stringify(pack, null, 2))
writeFileSync(join(outDir, 'blind-key.json'), JSON.stringify(key, null, 2))
console.log(`wrote ${pack.length} three-arm events to ${outDir}`)
