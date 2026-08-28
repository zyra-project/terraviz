#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Sweep probe: fetch every SOS tour.json referenced by
 * `public/assets/sos-dataset-list.json` (`runTourOnLoad` field),
 * run it through the Phase 3c parser, and aggregate the
 * unknown-task and asset-classification results so we can
 * extend the parser comprehensively rather than one tour at a
 * time.
 *
 *   npx tsx scripts/sweep-tour-parser.ts [--concurrency=8] [--limit=N]
 *
 * Output is operator-facing:
 *   - Per-tour status table (ok / fetch-failed / parse-failed)
 *   - Aggregate asset-kind counts
 *   - Aggregate unknown-task counts, with up to 3 sample
 *     dataset ids per unknown task name so we can re-probe a
 *     specific tour to inspect the task's fields.
 *
 * Pure-read; no mutations, no migration. Same caveat as
 * `probe-tour-parser.ts`: must run from an environment that can
 * reach NOAA's CDN (sandbox cannot — 403).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseTourFile, type TourParseResult } from '../cli/lib/tour-json-parser'

interface SosEntry {
  id: string
  title?: string
  runTourOnLoad?: string
}

interface TourResult {
  id: string
  url: string
  status: 'ok' | 'fetch-failed' | 'parse-failed' | 'no-tour-tasks'
  bytes?: number
  parse?: TourParseResult
  error?: string
}

function parseArgs(): { concurrency: number; limit: number | null } {
  let concurrency = 8
  let limit: number | null = null
  for (const arg of process.argv.slice(2)) {
    const m = /^--concurrency=(\d+)$/.exec(arg)
    if (m) concurrency = Number(m[1])
    const l = /^--limit=(\d+)$/.exec(arg)
    if (l) limit = Number(l[1])
  }
  // Defensive: --concurrency=0 would silently spawn zero workers
  // (Promise.all on a zero-length array resolves immediately),
  // making the sweep look "successful" without scanning a single
  // tour. Same for --limit=0. Reject these explicitly so the
  // operator sees a usage error instead of an empty aggregate.
  if (concurrency < 1) {
    console.error(`--concurrency must be >= 1 (got ${concurrency}).`)
    process.exit(2)
  }
  if (limit !== null && limit < 1) {
    console.error(`--limit must be >= 1 when provided (got ${limit}).`)
    process.exit(2)
  }
  return { concurrency, limit }
}

async function fetchAndParse(entry: SosEntry): Promise<TourResult> {
  const url = entry.runTourOnLoad!
  try {
    const res = await fetch(url)
    if (!res.ok) {
      return { id: entry.id, url, status: 'fetch-failed', error: `${res.status} ${res.statusText}` }
    }
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      return {
        id: entry.id,
        url,
        bytes: text.length,
        status: 'parse-failed',
        error: e instanceof Error ? e.message : String(e),
      }
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { tourTasks?: unknown }).tourTasks)) {
      return { id: entry.id, url, bytes: text.length, status: 'no-tour-tasks' }
    }
    return { id: entry.id, url, bytes: text.length, status: 'ok', parse: parseTourFile(parsed) }
  } catch (e) {
    return { id: entry.id, url, status: 'fetch-failed', error: e instanceof Error ? e.message : String(e) }
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onResult: (result: R, index: number, item: T) => void,
): Promise<void> {
  let next = 0
  const total = items.length
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (true) {
        const i = next++
        if (i >= total) return
        const r = await worker(items[i], i)
        onResult(r, i, items[i])
      }
    }),
  )
}

async function main(): Promise<void> {
  const { concurrency, limit } = parseArgs()
  const path = resolve('public/assets/sos-dataset-list.json')
  const snap = JSON.parse(readFileSync(path, 'utf-8')) as { datasets: SosEntry[] }
  const withTour = snap.datasets.filter(d => typeof d.runTourOnLoad === 'string' && d.runTourOnLoad)
  const items = limit ? withTour.slice(0, limit) : withTour
  console.log(`Sweep: ${items.length} of ${snap.datasets.length} rows have runTourOnLoad`)
  console.log(`Concurrency: ${concurrency}`)
  console.log()

  const results: TourResult[] = []
  let done = 0
  await runWithConcurrency(items, concurrency, fetchAndParse, r => {
    results.push(r)
    done++
    // One-line progress per tour so the operator sees the sweep
    // is alive on slow connections. status icon, id, byte count.
    const icon =
      r.status === 'ok' ? 'OK' :
      r.status === 'no-tour-tasks' ? '--' :
      r.status === 'fetch-failed' ? 'F!' : 'P!'
    const tail =
      r.status === 'ok'
        ? `${r.parse!.assets.length} assets, ${r.parse!.unknownTasks.length} unknown`
        : r.error ?? ''
    console.log(`  [${icon}] (${done}/${items.length}) ${r.id.padEnd(36)} ${tail}`)
  })

  console.log()
  console.log('━━━ Aggregate ━━━')

  // Status summary
  const byStatus: Record<string, number> = {}
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  for (const [s, n] of Object.entries(byStatus)) console.log(`  ${s.padEnd(20)} ${n}`)

  // Asset-kind totals across all ok tours
  const kindCounts: Record<string, number> = {}
  let totalAssets = 0
  for (const r of results) {
    if (r.status !== 'ok') continue
    for (const a of r.parse!.assets) {
      kindCounts[a.kind] = (kindCounts[a.kind] ?? 0) + 1
      totalAssets++
    }
  }
  console.log()
  console.log(`Assets discovered: ${totalAssets}`)
  for (const [k, n] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${n}`)
  }

  // Unknown-task aggregate
  const unknownCounts: Record<string, number> = {}
  const unknownSamples: Record<string, string[]> = {}
  for (const r of results) {
    if (r.status !== 'ok') continue
    const seenInThisTour = new Set<string>()
    for (const u of r.parse!.unknownTasks) {
      unknownCounts[u.taskName] = (unknownCounts[u.taskName] ?? 0) + 1
      if (!seenInThisTour.has(u.taskName)) {
        seenInThisTour.add(u.taskName)
        const samples = unknownSamples[u.taskName] ?? (unknownSamples[u.taskName] = [])
        if (samples.length < 3) samples.push(r.id)
      }
    }
  }
  console.log()
  if (Object.keys(unknownCounts).length === 0) {
    console.log('No unknown task types across the sweep — parser covers every task name seen.')
  } else {
    console.log(`Unknown task types across all tours:`)
    for (const [name, n] of Object.entries(unknownCounts).sort((a, b) => b[1] - a[1])) {
      const samples = (unknownSamples[name] ?? []).join(', ')
      console.log(`  ${name.padEnd(40)} ${String(n).padStart(5)}   e.g. ${samples}`)
    }
  }

  // Surface fetch/parse failures in detail so the operator can
  // investigate (these are real CDN gaps or non-JSON responses,
  // not parser bugs).
  const failures = results.filter(r => r.status !== 'ok' && r.status !== 'no-tour-tasks')
  if (failures.length) {
    console.log()
    console.log(`Failures (${failures.length}):`)
    for (const f of failures) {
      console.log(`  [${f.status}] ${f.id}: ${f.error ?? ''}`)
    }
  }

  // Surface tours that fetched OK but have no tourTasks — useful
  // diagnostic: empty tours don't need migration but it's worth
  // knowing the count.
  const empty = results.filter(r => r.status === 'no-tour-tasks')
  if (empty.length) {
    console.log()
    console.log(`Empty / non-tour responses (${empty.length}):`)
    for (const e of empty) console.log(`  ${e.id}  (${e.bytes ?? '?'} bytes)`)
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})
