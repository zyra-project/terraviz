// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Docent Engine — the "brain" of the digital docent.
 *
 * Parses user intent, searches datasets by keyword/category/description,
 * and generates conversational responses with optional dataset actions.
 * Entirely client-side — no external AI API required.
 */

import type { Dataset, ChatMessage, ChatAction } from '../types'
import { getBestAnswer } from './qaService'
import { getLocale, t, type Locale, type MessageKey } from '../i18n'
import { formatDate } from '../i18n/format'

// --- Constants ---
const MAX_RESULTS = 5
const MIN_SCORE_THRESHOLD = 0.3
const TITLE_WEIGHT = 4
const KEYWORD_WEIGHT = 3
const CATEGORY_WEIGHT = 2
const DESCRIPTION_WEIGHT = 1
const TAG_WEIGHT = 2
const AUTO_LOAD_THRESHOLD = 0.7
const AUTO_LOAD_GAP = 0.25

/** Intent types the engine can detect */
export type DocentIntent =
  | { type: 'search'; query: string }
  | { type: 'category'; category: string }
  | { type: 'explain-current' }
  | { type: 'related' }
  | { type: 'greeting' }
  | { type: 'help' }
  | { type: 'what-is-this' }

/** The engine's response before it becomes a ChatMessage */
export interface DocentResponse {
  text: string
  actions?: ChatAction[]
}

// --- Greeting / help / explain / related patterns ---
//
// The conversational-intent matchers (greeting, help, what-is-this,
// explain, related) read their alternation lists from the active
// locale's `docent.patterns.*` keys — comma-separated phrases the
// translator writes in their language. Compiled patterns are cached
// per-locale; locale changes require a reload (the canonical
// language-switch UX), so the cache is steady-state across a
// session and never grows beyond the SUPPORTED_LOCALES set.
//
// Category matching stays English-only: dataset metadata is English
// in L1, and translating a category trigger word ("huracán") to its
// English category name ("hurricane") needs a dedicated mapping
// that belongs to the L3 dataset-metadata effort. A non-English
// user typing "huracán" falls through to free-text search, which
// will not match the English "Hurricane" tag — known L1 limitation.
const CATEGORY_PATTERNS = /^(show me |find |browse |look at )?(atmosphere|ocean|land|space|climate|sun|moon|ice|snow|weather|solar|model|hurricane|coral|temperature|earthquake|tsunami|volcano|fire|ozone|magnetic|gravity|tectonic|water|carbon|satellite)/i

/** Escape a string for inclusion in a RegExp source. */
function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/** Compile a comma-separated phrase list (from a locale file) into
 * a RegExp anchored at the input start. Each phrase's internal
 * whitespace is matched as `\s+` so single/multi-space input
 * variations match. The `u` flag makes `\b` Unicode-aware so
 * letters with diacritics (`í`, `é`, `ñ`) count as word characters
 * and don't create spurious word-boundary matches. Returns `null`
 * if the phrase list is empty (no matcher for that intent in this
 * locale). */
function compilePatternList(phrases: string): RegExp | null {
  const alternatives = phrases
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => p.split(/\s+/).map(escapeRegex).join('\\s+'))
  if (alternatives.length === 0) return null
  return new RegExp(`^(?:${alternatives.join('|')})\\b`, 'iu')
}

interface CompiledPatterns {
  greeting: RegExp | null
  help: RegExp | null
  whatIs: RegExp | null
  explain: RegExp | null
  related: RegExp | null
}

const PATTERN_KEYS: ReadonlyArray<{ field: keyof CompiledPatterns; key: MessageKey }> = [
  { field: 'greeting', key: 'docent.patterns.greeting' },
  { field: 'help', key: 'docent.patterns.help' },
  { field: 'whatIs', key: 'docent.patterns.whatIs' },
  { field: 'explain', key: 'docent.patterns.explain' },
  { field: 'related', key: 'docent.patterns.related' },
]

const patternCache = new Map<Locale, CompiledPatterns>()

function getPatterns(): CompiledPatterns {
  const locale = getLocale()
  let cached = patternCache.get(locale)
  if (cached) return cached
  cached = {
    greeting: null, help: null, whatIs: null, explain: null, related: null,
  }
  for (const { field, key } of PATTERN_KEYS) {
    cached[field] = compilePatternList(t(key))
  }
  patternCache.set(locale, cached)
  return cached
}

/** Test-only: drop the compiled-pattern cache so locale-mocked tests
 * see a fresh compilation against whatever `t()` returns. */
export function __resetIntentCacheForTests(): void {
  patternCache.clear()
}

/**
 * Parse raw user input into a structured intent.
 */
export function parseIntent(input: string): DocentIntent {
  const trimmed = input.trim()
  const p = getPatterns()

  if (p.greeting?.test(trimmed)) return { type: 'greeting' }
  if (p.help?.test(trimmed)) return { type: 'help' }
  if (p.whatIs?.test(trimmed)) return { type: 'what-is-this' }
  if (p.explain?.test(trimmed)) return { type: 'explain-current' }
  if (p.related?.test(trimmed)) return { type: 'related' }

  const catMatch = trimmed.match(CATEGORY_PATTERNS)
  if (catMatch) {
    const category = catMatch[catMatch.length - 1]
    return { type: 'category', category: category.toLowerCase() }
  }

  return { type: 'search', query: trimmed }
}

/**
 * Score a dataset against a search query. Returns 0–1.
 */
export function scoreDataset(dataset: Dataset, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return 0

  let totalScore = 0
  const maxPossible = terms.length * (TITLE_WEIGHT + KEYWORD_WEIGHT + CATEGORY_WEIGHT + DESCRIPTION_WEIGHT + TAG_WEIGHT)

  for (const term of terms) {
    const title = dataset.title.toLowerCase()
    if (title.includes(term)) totalScore += TITLE_WEIGHT

    const keywords = dataset.enriched?.keywords ?? []
    if (keywords.some(k => k.toLowerCase().includes(term))) totalScore += KEYWORD_WEIGHT

    const categories = Object.keys(dataset.enriched?.categories ?? {})
    const subCategories = Object.values(dataset.enriched?.categories ?? {}).flat()
    if ([...categories, ...subCategories].some(c => c.toLowerCase().includes(term))) totalScore += CATEGORY_WEIGHT

    const desc = (dataset.enriched?.description ?? dataset.abstractTxt ?? '').toLowerCase()
    if (desc.includes(term)) totalScore += DESCRIPTION_WEIGHT

    if (dataset.tags?.some(t => t.toLowerCase().includes(term))) totalScore += TAG_WEIGHT
  }

  return maxPossible > 0 ? totalScore / maxPossible : 0
}

/**
 * Find datasets matching a query, ranked by relevance.
 */
export function searchDatasets(datasets: Dataset[], query: string, limit = MAX_RESULTS): Array<{ dataset: Dataset; score: number }> {
  return datasets
    .map(d => ({ dataset: d, score: scoreDataset(d, query) }))
    .filter(r => r.score >= MIN_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Find datasets in a given category.
 */
export function findByCategory(datasets: Dataset[], category: string, limit = MAX_RESULTS): Dataset[] {
  const cat = category.toLowerCase()
  return datasets
    .filter(d => {
      const cats = Object.keys(d.enriched?.categories ?? {}).map(c => c.toLowerCase())
      const subs = Object.values(d.enriched?.categories ?? {}).flat().map(s => s.toLowerCase())
      const tags = (d.tags ?? []).map(t => t.toLowerCase())
      return [...cats, ...subs, ...tags].some(c => c.includes(cat))
    })
    .slice(0, limit)
}

/**
 * Find datasets related to the given dataset (by related links, categories, keywords).
 */
export function findRelated(datasets: Dataset[], current: Dataset, limit = MAX_RESULTS): Dataset[] {
  // First try the enriched relatedDatasets links
  const relatedTitles = (current.enriched?.relatedDatasets ?? []).map(r => r.title.toLowerCase())
  const byRelated = datasets.filter(d =>
    d.id !== current.id && relatedTitles.some(rt => d.title.toLowerCase().includes(rt) || rt.includes(d.title.toLowerCase()))
  )
  if (byRelated.length >= limit) return byRelated.slice(0, limit)

  // Fall back to keyword/category overlap scoring
  const currentKeywords = new Set([
    ...(current.enriched?.keywords ?? []),
    ...(current.tags ?? []),
    ...Object.keys(current.enriched?.categories ?? {}),
    ...Object.values(current.enriched?.categories ?? {}).flat()
  ].map(k => k.toLowerCase()))

  if (currentKeywords.size === 0) return byRelated.slice(0, limit)

  const scored = datasets
    .filter(d => d.id !== current.id && !byRelated.includes(d))
    .map(d => {
      const dKeywords = [
        ...(d.enriched?.keywords ?? []),
        ...(d.tags ?? []),
        ...Object.keys(d.enriched?.categories ?? {}),
        ...Object.values(d.enriched?.categories ?? {}).flat()
      ].map(k => k.toLowerCase())
      const overlap = dKeywords.filter(k => currentKeywords.has(k)).length
      return { dataset: d, overlap }
    })
    .filter(r => r.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)

  const combined = [...byRelated, ...scored.map(s => s.dataset)]
  return combined.slice(0, limit)
}

/**
 * Evaluate whether the top search result is confident enough to auto-load.
 * Returns the auto-load candidate and remaining alternatives, or null.
 */
export function evaluateAutoLoad(
  results: Array<{ dataset: Dataset; score: number }>,
): { autoLoad: Dataset; alternatives: Dataset[] } | null {
  if (results.length === 0) return null
  const top = results[0]
  if (top.score < AUTO_LOAD_THRESHOLD) return null
  if (results.length >= 2 && top.score - results[1].score < AUTO_LOAD_GAP) return null
  return {
    autoLoad: top.dataset,
    alternatives: results.slice(1).map(r => r.dataset),
  }
}

/**
 * Build dataset action cards from a list of datasets.
 */
function datasetActions(datasets: Dataset[]): ChatAction[] {
  return datasets.map(d => ({
    type: 'load-dataset' as const,
    datasetId: d.id,
    datasetTitle: d.title,
  }))
}

/**
 * Describe a dataset in a friendly sentence.
 */
function describeDataset(dataset: Dataset): string {
  const desc = dataset.enriched?.description ?? dataset.abstractTxt
  if (desc) {
    const short = desc.length > 200 ? desc.substring(0, 200).trim() + '…' : desc
    return short
  }
  const cats = Object.keys(dataset.enriched?.categories ?? {})
  if (cats.length > 0) {
    return t('docent.describe.categories', { categories: cats.join(', ') })
  }
  return ''
}

// --- Response generators ---

const GREETING_KEYS = ['docent.greeting.1', 'docent.greeting.2', 'docent.greeting.3'] as const

function randomGreeting(): string {
  const key = GREETING_KEYS[Math.floor(Math.random() * GREETING_KEYS.length)]
  return t(key)
}

/**
 * Generate a docent response for a given intent.
 */
export function generateResponse(
  intent: DocentIntent,
  datasets: Dataset[],
  currentDataset: Dataset | null,
  precomputedSearchResults?: Array<{ dataset: Dataset; score: number }>,
): DocentResponse {
  switch (intent.type) {
    case 'greeting':
      return { text: randomGreeting() }

    case 'help':
      return { text: t('docent.help') }

    case 'what-is-this':
    case 'explain-current': {
      if (!currentDataset) {
        return { text: t('docent.explain.noDataset') }
      }
      const desc = describeDataset(currentDataset)
      const cats = Object.keys(currentDataset.enriched?.categories ?? {})
      const timeRange = currentDataset.startTime && currentDataset.endTime
        ? t('docent.explain.timeRange', {
            start: formatDate(currentDataset.startTime),
            end: formatDate(currentDataset.endTime),
          })
        : ''
      const catText = cats.length > 0
        ? t('docent.explain.categories', { categories: cats.join(', ') })
        : ''
      const source = currentDataset.organization
        ? t('docent.explain.source', { source: currentDataset.organization })
        : ''

      // Try to enrich with Q&A knowledge
      const qaAnswer = getBestAnswer(
        intent.type === 'what-is-this' ? 'what is this about' : 'explain',
        currentDataset.title,
      )
      const qaExtra = qaAnswer ? `\n\n${qaAnswer.length > 500 ? qaAnswer.substring(0, 500) + '…' : qaAnswer}` : ''

      return {
        text: `**${currentDataset.title}**\n\n${desc}${timeRange}${catText}${source}${qaExtra}`,
      }
    }

    case 'related': {
      if (!currentDataset) {
        return { text: t('docent.related.noDataset') }
      }
      const related = findRelated(datasets, currentDataset)
      if (related.length === 0) {
        return { text: t('docent.related.none', { title: currentDataset.title }) }
      }
      return {
        text: t('docent.related.list', { title: currentDataset.title }),
        actions: datasetActions(related),
      }
    }

    case 'category': {
      const results = findByCategory(datasets, intent.category)
      if (results.length === 0) {
        return { text: t('docent.category.none', { category: intent.category }) }
      }
      return {
        text: t('docent.category.list', { category: intent.category }),
        actions: datasetActions(results),
      }
    }

    case 'search': {
      const results = precomputedSearchResults ?? searchDatasets(datasets, intent.query)
      if (results.length === 0) {
        // Try broader — single best word match
        const words = intent.query.split(/\s+/)
        for (const word of words) {
          if (word.length < 3) continue
          const fallback = searchDatasets(datasets, word, 3)
          if (fallback.length > 0) {
            return {
              text: t('docent.search.fallbackResults', { query: intent.query, word }),
              actions: datasetActions(fallback.map(r => r.dataset)),
            }
          }
        }
        return { text: t('docent.search.none', { query: intent.query }) }
      }

      const top = results[0].dataset
      const topDesc = describeDataset(top)
      const qaSearchAnswer = getBestAnswer(intent.query, top.title)
      const qaSnippet = qaSearchAnswer
        ? `\n${qaSearchAnswer.length > 400 ? qaSearchAnswer.substring(0, 400) + '…' : qaSearchAnswer}`
        : ''
      const introText = results.length === 1
        ? t('docent.search.singleMatch', { title: top.title, desc: topDesc, qa: qaSnippet })
        : t('docent.search.multipleMatches', {
            count: results.length,
            query: intent.query,
            title: top.title,
            desc: topDesc,
            qa: qaSnippet,
          })

      return {
        text: introText,
        actions: datasetActions(results.map(r => r.dataset)),
      }
    }
  }
}

/**
 * Create a unique message ID.
 */
export function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
}

/**
 * Process user input and return a docent ChatMessage.
 */
export function processUserMessage(
  input: string,
  datasets: Dataset[],
  currentDataset: Dataset | null,
): ChatMessage {
  const intent = parseIntent(input)
  const response = generateResponse(intent, datasets, currentDataset)
  return {
    id: createMessageId(),
    role: 'docent',
    text: response.text,
    actions: response.actions,
    timestamp: Date.now(),
  }
}
