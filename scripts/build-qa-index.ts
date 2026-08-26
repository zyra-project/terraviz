// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * build-qa-index.ts — Fetches the HuggingFace Q&A dataset, filters to
 * datasets that exist in the app catalog, and outputs a compact JSON index.
 *
 * Usage:
 *   npx tsx scripts/build-qa-index.ts            # full rebuild (needs HuggingFace + S3 access)
 *   npx tsx scripts/build-qa-index.ts --refilter  # re-filter existing JSON against S3 catalog
 *
 * Output: public/assets/sos_qa_pairs.json
 *
 * Requires network access to:
 *   - HuggingFace datasets API (for Q&A data)
 *   - S3 SOS catalog (for app dataset title list)
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- Config ---
const HF_JSONL_URL = 'https://huggingface.co/datasets/HacksHaven/science-on-a-sphere-prompt-completions/resolve/main/sos_qa_pairs.jsonl'
const SOS_CATALOG_URLS = [
  'https://s3.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json',
  'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json',
]
const SUPPORTED_FORMATS = new Set(['video/mp4', 'image/png', 'image/jpg', 'images/jpg'])
const MAX_COMPLETION_CHARS = 1500
const OUTPUT_PATH = resolve(__dirname, '../public/assets/sos_qa_pairs.json')

// --- Types ---
interface HFRow {
  prompt: string
  completion: string
  title: string
  categories?: string[]
  tags?: string[]
  difficulty?: string
}

interface QAEntry {
  q: string  // prompt
  c: string  // completion
  d?: string // difficulty
}

type QAIndex = Record<string, QAEntry[]>

// --- Title normalization (mirrors DataService.normalizeTitle) ---
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\(movie\)\s*/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// --- Download JSONL from HuggingFace and parse ---
async function fetchAllRows(): Promise<HFRow[]> {
  console.log(`Downloading JSONL from HuggingFace...`)
  const res = await fetch(HF_JSONL_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HF download failed: ${res.status} ${res.statusText}`)

  const text = await res.text()
  const lines = text.trim().split('\n').filter(Boolean)
  const rows: HFRow[] = []

  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as HFRow)
    } catch {
      // skip malformed lines
    }
  }

  console.log(`  Parsed ${rows.length} rows from ${lines.length} lines`)
  return rows
}

// --- Fuzzy title matching ---
// Build a map from HF normalized titles to the closest app title.
// Handles cases where HF and S3 titles differ slightly (e.g. extra suffixes, punctuation variations).
function buildTitleMap(hfTitles: Set<string>, appTitles: Set<string>): Map<string, string> {
  const map = new Map<string, string>()
  const unmatchedHF: string[] = []

  for (const hf of hfTitles) {
    if (appTitles.has(hf)) {
      map.set(hf, hf)
    } else {
      // Try substring matching: does an app title contain the HF title or vice versa?
      let bestMatch: string | null = null
      for (const app of appTitles) {
        if (app.includes(hf) || hf.includes(app)) {
          bestMatch = app
          break
        }
      }
      if (bestMatch) {
        map.set(hf, bestMatch)
      } else {
        unmatchedHF.push(hf)
      }
    }
  }

  if (unmatchedHF.length > 0) {
    console.log(`\n  ${unmatchedHF.length} HF titles had no app match (expected — not in the ${appTitles.size} supported datasets)`)
  }

  // More useful: which app datasets have NO Q&A coverage?
  const coveredAppTitles = new Set(map.values())
  const uncoveredApp = [...appTitles].filter(t => !coveredAppTitles.has(t))
  if (uncoveredApp.length > 0) {
    console.log(`\n  ${uncoveredApp.length} app datasets have NO Q&A match in HF data:`)
    for (const t of uncoveredApp) {
      console.log(`    - "${t}"`)
    }
  }

  return map
}

// --- Build the filtered QA index ---
function buildIndex(rows: HFRow[], appTitles: Set<string>): { index: QAIndex; stats: { matched: number; dropped: number; appCoverage: number } } {
  // First pass: collect all unique HF titles
  const hfTitles = new Set<string>()
  for (const row of rows) {
    if (row.title) hfTitles.add(normalizeTitle(row.title))
  }
  console.log(`  HF dataset has ${hfTitles.size} unique normalized titles`)

  // Build fuzzy title map
  const titleMap = buildTitleMap(hfTitles, appTitles)

  const index: QAIndex = {}
  let matched = 0
  let dropped = 0
  const coveredTitles = new Set<string>()

  for (const row of rows) {
    if (!row.title || !row.prompt || !row.completion) {
      dropped++
      continue
    }

    const normalized = normalizeTitle(row.title)
    const mappedTitle = titleMap.get(normalized)

    if (!mappedTitle) {
      dropped++
      continue
    }

    coveredTitles.add(mappedTitle)

    if (!index[mappedTitle]) {
      index[mappedTitle] = []
    }

    // Check for near-duplicate prompts within this title
    const isDupe = index[mappedTitle].some(
      existing => existing.q === row.prompt.trim()
    )
    if (isDupe) {
      dropped++
      continue
    }

    let completion = row.completion.trim()
    if (completion.length > MAX_COMPLETION_CHARS) {
      // Truncate at last sentence boundary before the limit
      const truncated = completion.substring(0, MAX_COMPLETION_CHARS)
      const lastPeriod = truncated.lastIndexOf('. ')
      completion = lastPeriod > MAX_COMPLETION_CHARS * 0.5
        ? truncated.substring(0, lastPeriod + 1)
        : truncated + '…'
    }

    const entry: QAEntry = {
      q: row.prompt.trim(),
      c: completion,
    }
    if (row.difficulty) entry.d = row.difficulty

    index[mappedTitle].push(entry)
    matched++
  }

  return {
    index,
    stats: {
      matched,
      dropped,
      appCoverage: coveredTitles.size,
    },
  }
}

// --- Fetch app dataset titles ---
// Primary: SOS S3 catalog (filters by format + hidden, ~165 datasets)
// Fallback: local enriched metadata (all ~520 titles, no format filter)
async function fetchAppTitles(): Promise<Set<string>> {
  // Try S3 catalog URLs for the most accurate filter
  for (const url of SOS_CATALOG_URLS) {
    try {
      console.log(`Fetching SOS catalog from ${new URL(url).hostname}...`)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { datasets: Array<{ title: string; format: string; isHidden?: boolean }> }

      const titles = new Set<string>()
      for (const d of data.datasets) {
        if (!d.isHidden && SUPPORTED_FORMATS.has(d.format)) {
          titles.add(normalizeTitle(d.title))
        }
      }
      console.log(`  Found ${titles.size} datasets (filtered by format + hidden)`)
      return titles
    } catch (err) {
      console.warn(`  Failed (${err instanceof Error ? err.message : err}), trying next...`)
    }
  }

  // Fallback: use local enriched metadata file (includes all titles, not just supported formats)
  const enrichedPath = resolve(__dirname, '../public/assets/sos_dataset_metadata.json')
  const enrichedRaw = JSON.parse(readFileSync(enrichedPath, 'utf-8')) as Array<{ title?: string }>
  const titles = new Set<string>()
  for (const entry of enrichedRaw) {
    if (entry.title) titles.add(normalizeTitle(entry.title))
  }
  console.log(`  Loaded ${titles.size} titles from local enriched metadata (includes all formats)`)
  console.log(`  NOTE: Re-run with S3 access for accurate format filtering (~165 vs ${titles.size} titles)`)
  return titles
}

// --- Re-filter an existing QA index against the S3 catalog ---
async function refilter() {
  const appTitles = await fetchAppTitles()
  console.log(`App catalog: ${appTitles.size} datasets (after hidden + format filter)`)

  console.log('Loading existing QA index...')
  const existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8')) as QAIndex

  const filtered: QAIndex = {}
  let kept = 0
  let dropped = 0
  for (const [title, entries] of Object.entries(existing)) {
    if (appTitles.has(title)) {
      filtered[title] = entries
      kept += entries.length
    } else {
      dropped += entries.length
    }
  }

  console.log(`\n--- Results ---`)
  console.log(`Titles kept:   ${Object.keys(filtered).length} / ${Object.keys(existing).length}`)
  console.log(`Entries kept:  ${kept} / dropped: ${dropped}`)

  const json = JSON.stringify(filtered)
  writeFileSync(OUTPUT_PATH, json, 'utf-8')

  const sizeMB = (Buffer.byteLength(json, 'utf-8') / (1024 * 1024)).toFixed(2)
  console.log(`\nWrote ${OUTPUT_PATH}`)
  console.log(`File size: ${sizeMB} MB`)
}

// --- Full rebuild: fetch from HuggingFace + filter against S3 catalog ---
async function fullBuild() {
  const appTitles = await fetchAppTitles()
  console.log(`App catalog: ${appTitles.size} datasets (after hidden + format filter)`)

  console.log('\nFetching Q&A data from HuggingFace...')
  const rows = await fetchAllRows()
  console.log(`Fetched ${rows.length} rows total`)

  console.log('\nBuilding filtered index...')
  const { index, stats } = buildIndex(rows, appTitles)

  const titleCount = Object.keys(index).length

  console.log(`\n--- Results ---`)
  console.log(`Q&A entries kept:    ${stats.matched}`)
  console.log(`Entries dropped:     ${stats.dropped}`)
  console.log(`Unique titles in QA: ${titleCount}`)
  console.log(`App datasets with QA coverage: ${stats.appCoverage} / ${appTitles.size} (${Math.round(stats.appCoverage / appTitles.size * 100)}%)`)

  const json = JSON.stringify(index)
  writeFileSync(OUTPUT_PATH, json, 'utf-8')

  const sizeMB = (Buffer.byteLength(json, 'utf-8') / (1024 * 1024)).toFixed(2)
  console.log(`\nWrote ${OUTPUT_PATH}`)
  console.log(`File size: ${sizeMB} MB`)
}

// --- Entry point ---
const isRefilter = process.argv.includes('--refilter')

;(isRefilter ? refilter() : fullBuild()).catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
