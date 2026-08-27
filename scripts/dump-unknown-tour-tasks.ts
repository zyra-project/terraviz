#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Inspector for the unknown-task types surfaced by
 * `sweep-tour-parser.ts`. Sweeps every SOS tour.json again and,
 * for each task name the parser doesn't recognize, dumps up to N
 * example task objects (verbatim JSON) so we can see what fields
 * they carry before extending the parser.
 *
 *   npx tsx scripts/dump-unknown-tour-tasks.ts [--per-task=2] [--task=addBubble]
 *
 * Used during 3c/A → 3c/B scope hand-off to extend
 * `cli/lib/tour-json-parser.ts` comprehensively for every
 * URL-bearing field we see in production tours.
 *
 * Pure-read; no mutations.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseTourFile } from '../cli/lib/tour-json-parser'

interface SosEntry {
  id: string
  runTourOnLoad?: string
}

interface UnknownSample {
  datasetId: string
  taskIndex: number
  task: unknown
}

function parseArgs(): { perTask: number; only: string | null; concurrency: number } {
  let perTask = 2
  let only: string | null = null
  let concurrency = 8
  for (const arg of process.argv.slice(2)) {
    const m = /^--per-task=(\d+)$/.exec(arg)
    if (m) perTask = Number(m[1])
    const t = /^--task=(.+)$/.exec(arg)
    if (t) only = t[1]
    const c = /^--concurrency=(\d+)$/.exec(arg)
    if (c) concurrency = Number(c[1])
  }
  // Defensive: --concurrency=0 spawns zero workers (Promise.all
  // on a zero-length array resolves immediately), making the
  // sweep look "successful" without inspecting a single tour.
  // --per-task=0 caps every sample list at zero so the dump
  // would emit no examples. Reject both explicitly.
  if (concurrency < 1) {
    console.error(`--concurrency must be >= 1 (got ${concurrency}).`)
    process.exit(2)
  }
  if (perTask < 1) {
    console.error(`--per-task must be >= 1 (got ${perTask}).`)
    process.exit(2)
  }
  return { perTask, only, concurrency }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        await worker(items[i])
      }
    }),
  )
}

async function main(): Promise<void> {
  const { perTask, only, concurrency } = parseArgs()
  const path = resolve('public/assets/sos-dataset-list.json')
  const snap = JSON.parse(readFileSync(path, 'utf-8')) as { datasets: SosEntry[] }
  const withTour = snap.datasets.filter(d => typeof d.runTourOnLoad === 'string' && d.runTourOnLoad)
  console.log(`Scanning ${withTour.length} tours${only ? ` for taskName="${only}"` : ''}...`)

  // taskName → samples (cap per-task to avoid console flood).
  const samples = new Map<string, UnknownSample[]>()

  await runWithConcurrency(withTour, concurrency, async entry => {
    try {
      const res = await fetch(entry.runTourOnLoad!)
      if (!res.ok) return
      const text = await res.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      if (!parsed || typeof parsed !== 'object') return
      const tasks = (parsed as { tourTasks?: unknown }).tourTasks
      if (!Array.isArray(tasks)) return
      const r = parseTourFile(parsed)
      for (const u of r.unknownTasks) {
        if (only && u.taskName !== only) continue
        const list = samples.get(u.taskName) ?? []
        if (list.length >= perTask) continue
        // Pull the raw task object out of the original tour.
        const task = tasks[u.taskIndex]
        list.push({ datasetId: entry.id, taskIndex: u.taskIndex, task })
        samples.set(u.taskName, list)
      }
    } catch {
      /* swallow; sweep already reports failures */
    }
  })

  console.log()
  if (samples.size === 0) {
    console.log(only ? `No samples for taskName="${only}".` : 'No unknown task types found.')
    return
  }
  const names = Array.from(samples.keys()).sort()
  for (const name of names) {
    const list = samples.get(name)!
    console.log(`━━━ ${name} (${list.length} sample${list.length > 1 ? 's' : ''}) ━━━`)
    for (const s of list) {
      console.log(`  source: ${s.datasetId}  taskIndex: ${s.taskIndex}`)
      // 2-space indent + JSON for human reading. Keep on stdout
      // so the operator can pipe through `tee`.
      const json = JSON.stringify(s.task, null, 2)
        .split('\n')
        .map(line => `    ${line}`)
        .join('\n')
      console.log(json)
      console.log()
    }
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})
