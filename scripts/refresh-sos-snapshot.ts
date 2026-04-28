/**
 * scripts/refresh-sos-snapshot.ts
 *
 * Pulls the upstream SOS dataset list from the public S3 bucket and
 * writes a fresh `public/assets/sos-dataset-list.json` snapshot.
 * `db:seed` reads from the snapshot rather than the network, keeping
 * CI offline-friendly and the seed run deterministic across days.
 *
 * Run on demand:
 *
 *     npm run refresh:sos-snapshot
 *
 * The snapshot is checked in. If the upstream list changes shape,
 * this script is the place that surfaces it (the seed importer
 * type-checks against the existing shape).
 */

import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// Same URL `src/services/dataService.ts` reads from at runtime.
const SOURCE_URL =
  'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json'
const TARGET = resolve(REPO_ROOT, 'public/assets/sos-dataset-list.json')

async function main(): Promise<void> {
  console.log(`Fetching ${SOURCE_URL}`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText} from upstream`)
    process.exit(1)
  }
  const body = await res.text()
  // Validate shape minimally.
  const parsed = JSON.parse(body) as { datasets?: unknown[] }
  if (!Array.isArray(parsed.datasets)) {
    console.error('Unexpected response shape — missing datasets[] array.')
    process.exit(1)
  }
  writeFileSync(TARGET, body)
  console.log(`Wrote ${parsed.datasets.length} datasets to ${TARGET}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
