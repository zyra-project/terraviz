#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * One-shot probe: fetch a real SOS tour.json and run it through
 * the Phase 3c parser to verify the classification + asset
 * discovery on production data.
 *
 *   npx tsx scripts/probe-tour-parser.ts <url-or-INTERNAL_ID>
 *
 * When given a SOS legacy_id (e.g. `INTERNAL_SOS_483_VIDEO`), the
 * script looks the runTourOnLoad URL up in
 * `public/assets/sos-dataset-list.json` so the operator doesn't
 * have to copy/paste the CDN URL.
 *
 * Pure-read; no mutations, no migration. Used during 3c/A → 3c/B
 * scope hand-off to confirm the parser sees real-world tours
 * the way the design predicts.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseTourFile } from '../cli/lib/tour-json-parser'

interface SosEntry {
  id: string
  title?: string
  runTourOnLoad?: string
}

function resolveTourUrl(arg: string): string {
  if (arg.startsWith('http://') || arg.startsWith('https://')) return arg
  const path = resolve('public/assets/sos-dataset-list.json')
  const snap = JSON.parse(readFileSync(path, 'utf-8')) as { datasets: SosEntry[] }
  const row = snap.datasets.find(r => r.id === arg)
  if (!row) {
    console.error(`No row found with legacy_id="${arg}" in ${path}`)
    process.exit(2)
  }
  if (!row.runTourOnLoad) {
    console.error(`Row ${arg} (${row.title}) has no runTourOnLoad`)
    process.exit(2)
  }
  console.log(`Resolved ${arg} → ${row.runTourOnLoad}`)
  return row.runTourOnLoad
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (!arg) {
    console.error('Usage: probe-tour-parser <url-or-INTERNAL_SOS_id>')
    process.exit(2)
  }
  const url = resolveTourUrl(arg)
  console.log(`Fetching ${url}…`)
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`fetch failed: ${res.status} ${res.statusText}`)
    process.exit(1)
  }
  const text = await res.text()
  // text.length is JS code-unit count, not byte count — non-ASCII
  // titles / captions inflate as multi-byte UTF-8 (e.g. `El Niño`,
  // wikipedia URLs with diacritics). Report the actual encoded
  // byte count so the diagnostic matches what the migration pump
  // will upload to R2.
  console.log(`tour.json size: ${Buffer.byteLength(text, 'utf8')} bytes`)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    console.error('JSON parse failed:', e instanceof Error ? e.message : e)
    console.error('First 200 chars of body:')
    console.error(text.slice(0, 200))
    process.exit(1)
  }

  // Top-level shape diagnostic — surfaces anything beyond
  // tourTasks (some SOS tours have tourOverlays / settings /
  // metadata that we should know about even if the parser
  // doesn't currently extract URLs from them).
  if (!parsed || typeof parsed !== 'object') {
    console.error('Top-level is not an object')
    process.exit(1)
  }
  const root = parsed as Record<string, unknown>
  const topKeys = Object.keys(root)
  console.log(`Top-level keys: ${topKeys.join(', ')}`)
  if (!Array.isArray(root.tourTasks)) {
    console.error('No tourTasks array — parser will produce empty result')
    process.exit(1)
  }
  console.log(`tourTasks count: ${root.tourTasks.length}`)

  const result = parseTourFile(parsed)
  console.log()
  console.log(`Discovered assets: ${result.assets.length}`)
  const byKind: Record<string, number> = {}
  for (const a of result.assets) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1
  for (const [k, n] of Object.entries(byKind)) console.log(`  ${k}: ${n}`)
  if (result.unknownTasks.length) {
    console.log()
    console.log(`Unknown task types (not migrated; counts may indicate parser blind spots):`)
    const counts: Record<string, number> = {}
    for (const u of result.unknownTasks) counts[u.taskName] = (counts[u.taskName] ?? 0) + 1
    for (const [name, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name.padEnd(40)} ${n}`)
    }
  }
  console.log()
  console.log('Assets by classification + source:')
  for (const a of result.assets) {
    const truncated = a.rawValue.length > 100 ? a.rawValue.slice(0, 97) + '...' : a.rawValue
    console.log(
      `  [${a.kind.padEnd(18)}] task#${String(a.source.taskIndex).padStart(3, ' ')} ${a.source.taskName}.${a.source.field}: ${truncated}`,
    )
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})
