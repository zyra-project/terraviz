/**
 * Evaluate the event→dataset matcher on the real catalogue.
 *
 *   npx tsx scripts/experiments/tour-sequencing/eval-matcher.ts
 *
 * Two kinds of measurement, deliberately separated:
 *
 *   Label-free (primary). How many datasets share the top score, and
 *   how many distinct scores exist in the top 20. These need no
 *   judgement about relevance, so they cannot be gamed by whoever picks
 *   the labels. A matcher that puts a quarter of the catalogue at
 *   exactly 1.0 is broken regardless of which datasets those are.
 *
 *   Labelled (secondary). Precision@4 against a hand-picked relevant
 *   set per event. Written by reading titles and asking "would a
 *   curator accept this stop", NOT by keyword-matching the event text —
 *   otherwise a keyword-based fix would be grading its own homework.
 *   Where a dataset is genuinely relevant despite sharing no words with
 *   the headline it is included (e.g. Precipitation for a hurricane),
 *   and where the current winner is genuinely defensible it is included
 *   too (Clouds - Real-Time for a hurricane), which makes the bar
 *   harder for any change, not easier.
 */

import { buildIdf, proposeMatches, scoreMatch } from '../../../functions/api/v1/_lib/events-matcher'
import { loadCorpus } from './harness'
import { DRAFT_EVENTS } from './events'

/** Relevant-title substrings per event, matched case-insensitively. */
const RELEVANT: Record<string, readonly string[]> = {
  // Broadened from an initial list that named specific storms and so
  // scored "Hurricane Maria" as irrelevant to a hurricane event. Any
  // dataset whose title names a hurricane or tropical cyclone counts.
  hurricane: [
    'Hurricane', 'Tropical Cyclones',
    'Precipitation - Real-time', 'Clouds - Real-Time', 'Winds: GEOS-5', 'Wind Streamers',
  ],
  wildfire: ['Smoke', 'Wildfire', 'Fires - Real-time', 'Aerosol'],
  quake: ['Earthquake', 'Plate Tectonic', 'Tsunami'],
  drought: [
    'Drought Risk', 'Precipitation - Real-time', 'Vegetation: Seasonal',
    'Temperature Anomaly: Yearly', 'Soil',
  ],
  seaice: ['Sea Ice', 'Snow and Ice', 'Arctic'],
  coral: ['Sea Surface Temperature', 'Coral', 'Reef', 'Biosphere'],
  aurora: ['Aurora', 'Magnetic Declination', 'Magnetic Anomaly', 'Solar Resources'],
  nogeo: ['Carbon Dioxide', 'Temperature Anomaly: Yearly', 'Ocean-Atmosphere CO2', 'Air Temperature Change'],
}

const TOP = 4
const nowMs = Date.parse('2026-08-27T00:00:00.000Z')

function main(): void {
  const { rich, match } = loadCorpus()
  // Same corpus statistics proposeMatches builds internally.
  const idf = buildIdf(match)
  const isRelevant = (eventKey: string, title: string): boolean =>
    (RELEVANT[eventKey] ?? []).some(s => title.toLowerCase().includes(s.toLowerCase()))

  let tieMassTotal = 0
  let precisionTotal = 0
  let saturatedTotal = 0

  console.log('event      | pool | tied@top | distinct@20 | P@4  | top-4 titles')
  console.log('-'.repeat(120))
  for (const event of DRAFT_EVENTS) {
    // Score EVERY dataset, not just the ones above the floor, so the
    // tie mass is measured over the whole catalogue.
    const scored = match
      .map(d => scoreMatch(event.match, d, nowMs, idf))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score || a.datasetId.localeCompare(b.datasetId))
    const max = scored[0]?.score ?? 0
    const tiedAtTop = scored.filter(m => Math.abs(m.score - max) < 1e-9).length
    const distinctTop20 = new Set(scored.slice(0, 20).map(m => m.score.toFixed(6))).size
    const saturatedLexical = scored.filter(m => m.signals.lexical === 1).length

    const top = proposeMatches(event.match, match, { nowMs, limit: TOP })
    const titles = top.map(m => rich.get(m.datasetId)!.title)
    const hits = titles.filter(t => isRelevant(event.key, t)).length
    const p = hits / Math.max(1, titles.length)

    tieMassTotal += tiedAtTop
    precisionTotal += p
    saturatedTotal += saturatedLexical

    console.log(
      `${event.key.padEnd(10)} | ${String(scored.length).padStart(4)} | ${String(tiedAtTop).padStart(8)} | ${String(distinctTop20).padStart(11)} | ${p.toFixed(2)} | ${titles.map(t => t.slice(0, 30)).join(' · ')}`,
    )
  }
  const n = DRAFT_EVENTS.length
  console.log('-'.repeat(120))
  console.log(
    `MEAN       |      | ${(tieMassTotal / n).toFixed(1).padStart(8)} |             | ${(precisionTotal / n).toFixed(2)} | mean datasets at lexical==1.0: ${(saturatedTotal / n).toFixed(1)}`,
  )
}

main()
