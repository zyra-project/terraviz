// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * QA Service — loads and queries the preprocessed Q&A knowledge base.
 *
 * The knowledge base is a static JSON file built from HuggingFace dataset
 * {@link https://huggingface.co/datasets/HacksHaven/science-on-a-sphere-prompt-completions}.
 * It is lazy-loaded on first chat open and cached in memory.
 */

import type { Dataset, QAEntry, QAIndex } from '../types'
import { searchDatasets } from './docentEngine'
import { logger } from '../utils/logger'

// --- Constants ---
const QA_ASSET_URL = '/assets/sos_qa_pairs.json'
const LOAD_TIMEOUT_MS = 5000
const MAX_CONTEXT_CHARS = 2400
const MAX_ENTRIES_TURN_0 = 1
const MAX_ENTRIES_TURN_N = 3

// --- Module state ---
let qaIndex: QAIndex | null = null
let loading: Promise<void> | null = null

/**
 * Normalize a dataset title for QA index lookup.
 * Mirrors DataService.normalizeTitle() — must stay in sync.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\(movie\)\s*/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Ensure the QA index is loaded. Safe to call multiple times —
 * only fetches once. Resolves when data is ready or times out.
 */
export async function ensureLoaded(): Promise<void> {
  if (qaIndex) return
  if (loading) return loading

  loading = (async () => {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS)

      const res = await fetch(QA_ASSET_URL, { signal: controller.signal })
      clearTimeout(timeout)

      if (!res.ok) {
        logger.warn(`[QA] Failed to load Q&A index: ${res.status}`)
        return
      }

      qaIndex = await res.json() as QAIndex
      const titleCount = Object.keys(qaIndex).length
      const entryCount = Object.values(qaIndex).reduce((s, a) => s + a.length, 0)
      logger.info(`[QA] Loaded ${entryCount} Q&A entries for ${titleCount} datasets`)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        logger.warn('[QA] Load timed out')
      } else {
        logger.warn('[QA] Load failed:', err)
      }
    }
  })()

  return loading
}

/** Check if the QA index has been loaded. */
export function isLoaded(): boolean {
  return qaIndex !== null
}

/**
 * Get all Q&A entries for a dataset by its raw (unnormalized) title.
 */
export function getEntriesForTitle(title: string): QAEntry[] {
  if (!qaIndex) return []
  return qaIndex[normalizeTitle(title)] ?? []
}

/**
 * Score a QA entry's relevance to a user query.
 * Returns 0–1 based on term overlap between query and the prompt + completion.
 */
function scoreEntry(entry: QAEntry, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
  if (terms.length === 0) return 0

  let hits = 0
  const promptLower = entry.q.toLowerCase()
  const completionLower = entry.c.toLowerCase()

  for (const term of terms) {
    if (promptLower.includes(term)) hits += 2
    else if (completionLower.includes(term)) hits += 1
  }

  return Math.min(1, hits / (terms.length * 2))
}

/**
 * Select the most relevant Q&A entries for a user query and current context.
 * Returns entries ranked by relevance, capped at the given limit.
 */
function selectEntries(
  query: string,
  currentDataset: Dataset | null,
  datasets: Dataset[],
  maxEntries: number,
): Array<{ entry: QAEntry; datasetTitle: string }> {
  if (!qaIndex) return []

  const candidates: Array<{ entry: QAEntry; datasetTitle: string; score: number }> = []

  // 1. Entries for the currently loaded dataset (boosted)
  if (currentDataset) {
    const entries = getEntriesForTitle(currentDataset.title)
    for (const entry of entries) {
      candidates.push({
        entry,
        datasetTitle: currentDataset.title,
        score: scoreEntry(entry, query) + 0.3, // boost for current dataset
      })
    }
  }

  // 2. Entries for datasets matching the user query
  const searchResults = searchDatasets(datasets, query, 3)
  for (const { dataset } of searchResults) {
    if (dataset.id === currentDataset?.id) continue // already included
    const entries = getEntriesForTitle(dataset.title)
    for (const entry of entries) {
      candidates.push({
        entry,
        datasetTitle: dataset.title,
        score: scoreEntry(entry, query),
      })
    }
  }

  // Sort by score descending and take top entries
  candidates.sort((a, b) => b.score - a.score)
  return candidates
    .filter(c => c.score > 0.1)
    .slice(0, maxEntries)
}

/**
 * Build a formatted QA context string for injection into the LLM system prompt.
 * Returns an empty string if no relevant entries are found.
 *
 * @param query - The user's current message
 * @param currentDataset - The currently loaded dataset (if any)
 * @param datasets - All available datasets
 * @param turnIndex - Current conversation turn (0 = first message)
 */
export function getRelevantQA(
  query: string,
  currentDataset: Dataset | null,
  datasets: Dataset[],
  turnIndex: number = 0,
): string {
  if (!qaIndex) return ''

  const maxEntries = turnIndex === 0 ? MAX_ENTRIES_TURN_0 : MAX_ENTRIES_TURN_N
  const selected = selectEntries(query, currentDataset, datasets, maxEntries)

  if (selected.length === 0) return ''

  const parts: string[] = []
  let totalChars = 0

  for (const { entry, datasetTitle } of selected) {
    // Truncate completion to fit budget
    const remainingBudget = MAX_CONTEXT_CHARS - totalChars
    if (remainingBudget <= 100) break

    let completion = entry.c
    if (completion.length > remainingBudget - 80) {
      // Truncate at sentence boundary
      const truncated = completion.substring(0, remainingBudget - 80)
      const lastPeriod = truncated.lastIndexOf('. ')
      completion = lastPeriod > truncated.length * 0.5
        ? truncated.substring(0, lastPeriod + 1)
        : truncated + '…'
    }

    parts.push(`About "${datasetTitle}":\nQ: ${entry.q}\nA: ${completion}`)
    totalChars += parts[parts.length - 1].length
  }

  return parts.join('\n\n')
}

/**
 * Look up a Q&A completion that best matches a user query for a specific dataset.
 * Used by the local engine fallback for richer responses.
 * Returns null if no good match is found.
 */
export function getBestAnswer(
  query: string,
  datasetTitle: string,
): string | null {
  if (!qaIndex) return null

  const entries = getEntriesForTitle(datasetTitle)
  if (entries.length === 0) return null

  let bestEntry: QAEntry | null = null
  let bestScore = 0.2 // minimum threshold

  for (const entry of entries) {
    const score = scoreEntry(entry, query)
    if (score > bestScore) {
      bestScore = score
      bestEntry = entry
    }
  }

  return bestEntry?.c ?? null
}
