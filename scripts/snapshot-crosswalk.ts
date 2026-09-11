// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/** Offline, stdout-only tooling (no network, no file writes).
 * Run with `npx tsx scripts/snapshot-crosswalk.ts --bootstrap` to print review
 * candidates, or `--validate` to check the committed mapping and report drift.
 * Apply reviewed output through an editing API; never regenerate on import.
 * Source hashes identify the bootstrap inputs, NOT a runtime freshness gate:
 * title edits and reordering must not invalidate a reviewed identity link.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bootstrapCrosswalk, resolveCrosswalk } from '../cli/lib/snapshot-crosswalk'
import type { RawEnrichedEntry, RawSosEntry } from '../cli/lib/snapshot-import'

const root = new URL('../', import.meta.url)
const listPath = 'public/assets/sos-dataset-list.json'
const enrichedPath = 'public/assets/sos_dataset_metadata.json'
const crosswalkPath = 'public/assets/sos-enrichment-crosswalk.json'
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8').replace(/\r\n/g, '\n')
const listText = read(listPath)
const enrichedText = read(enrichedPath)
const operational = (JSON.parse(listText) as { datasets: RawSosEntry[] }).datasets
const enriched = JSON.parse(enrichedText) as RawEnrichedEntry[]
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

if (process.argv[2] === '--bootstrap') {
  const document = bootstrapCrosswalk(operational, enriched, {
    operational_source: listPath,
    enrichment_source: enrichedPath,
    operational_sha256: sha256(listText),
    enrichment_sha256: sha256(enrichedText),
    source_identifier: 'url',
    method: 'unique-normalized-title-bootstrap-v1',
    review: 'Baseline unique-title candidates pinned for code review; not scientific metadata verification. Duplicate operational rows with the same target share one pair; conflicting candidates are excluded. Native viewer runtime title merging is deferred and unchanged.',
  })
  // Compact pairs keep the reviewed artifact readable; deterministic byte output.
  const lines = JSON.stringify(document, null, 2).replace(
    /\[\n      ("[^"\n]+"),\n      ("[^"\n]+")\n    \]/g, '[$1, $2]',
  )
  process.stdout.write(lines + '\n')
  if (document.report.invalid || document.report.ambiguous) process.exitCode = 1
} else if (process.argv[2] === '--validate') {
  const { report } = resolveCrosswalk(operational, enriched, JSON.parse(read(crosswalkPath)))
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  if (report.invalid || report.ambiguous) process.exitCode = 1
} else {
  process.stderr.write('Usage: npx tsx scripts/snapshot-crosswalk.ts --bootstrap|--validate\n')
  process.exitCode = 2
}