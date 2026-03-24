/**
 * Docent Engine — the "brain" of the digital docent.
 *
 * Parses user intent, searches datasets by keyword/category/description,
 * and generates conversational responses with optional dataset actions.
 * Entirely client-side — no external AI API required.
 */

import type { Dataset, ChatMessage, ChatAction } from '../types'

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

// --- Greeting / help patterns ---
const GREETING_PATTERNS = /^(hi|hello|hey|howdy|greetings|good\s+(morning|afternoon|evening)|sup|yo)\b/i
const HELP_PATTERNS = /^(help|what can you do|how do(es)? (this|it) work|commands|options)\b/i
const WHAT_IS_PATTERNS = /^(what('?s| is) this|where am i|what am i (looking at|seeing))\b/i
const EXPLAIN_PATTERNS = /^(explain( this| it)?|tell me (about |more about )?(this|it|the current|what'?s showing)|describe (this|it|the current)|what does this (show|mean))/i
const RELATED_PATTERNS = /^(show me (something )?(similar|related|like this)|related|more like this|similar)/i
const CATEGORY_PATTERNS = /^(show me |find |browse |look at )?(atmosphere|ocean|land|space|climate|sun|moon|ice|snow|weather|solar|model|hurricane|coral|temperature|earthquake|tsunami|volcano|fire|ozone|magnetic|gravity|tectonic|water|carbon|satellite)/i

/**
 * Parse raw user input into a structured intent.
 */
export function parseIntent(input: string): DocentIntent {
  const trimmed = input.trim()

  if (GREETING_PATTERNS.test(trimmed)) return { type: 'greeting' }
  if (HELP_PATTERNS.test(trimmed)) return { type: 'help' }
  if (WHAT_IS_PATTERNS.test(trimmed)) return { type: 'what-is-this' }
  if (EXPLAIN_PATTERNS.test(trimmed)) return { type: 'explain-current' }
  if (RELATED_PATTERNS.test(trimmed)) return { type: 'related' }

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
    return `This is a ${cats.join(', ')} dataset.`
  }
  return ''
}

// --- Response generators ---

const GREETINGS = [
  "Welcome to Science on a Sphere! I'm your digital docent — ask me about any topic and I'll find a dataset to show you. Try asking about oceans, climate, hurricanes, or anything else that interests you.",
  "Hello! I'm here to guide you through over 500 visualizations of our planet and beyond. What would you like to explore? You can ask about a topic, or I can tell you more about whatever's on the globe right now.",
  "Hi there! Think of me as your personal guide to Earth science data. Ask me about weather, the ocean floor, space, volcanoes — or just say \"show me something interesting\" and I'll pick something out.",
]

const HELP_TEXT = `Here's how I can help:

• **Ask about a topic** — "Tell me about hurricanes" or "Show me ocean temperatures"
• **Explore categories** — "Show me atmosphere datasets" or "What about space?"
• **Learn about what's showing** — "Explain this" or "What am I looking at?"
• **Find related data** — "Show me something similar" or "More like this"
• **Search freely** — Just type any question and I'll find relevant datasets`

function randomGreeting(): string {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
}

/**
 * Generate a docent response for a given intent.
 */
export function generateResponse(
  intent: DocentIntent,
  datasets: Dataset[],
  currentDataset: Dataset | null,
): DocentResponse {
  switch (intent.type) {
    case 'greeting':
      return { text: randomGreeting() }

    case 'help':
      return { text: HELP_TEXT }

    case 'what-is-this':
    case 'explain-current': {
      if (!currentDataset) {
        return {
          text: "You're looking at Earth with real-time cloud cover. Browse the datasets or ask me about a topic — I'll load something onto the globe for you.",
        }
      }
      const desc = describeDataset(currentDataset)
      const cats = Object.keys(currentDataset.enriched?.categories ?? {})
      const timeRange = currentDataset.startTime && currentDataset.endTime
        ? ` This data covers ${new Date(currentDataset.startTime).toLocaleDateString()} through ${new Date(currentDataset.endTime).toLocaleDateString()}.`
        : ''
      const catText = cats.length > 0 ? ` It falls under: ${cats.join(', ')}.` : ''
      const source = currentDataset.organization ? ` Source: ${currentDataset.organization}.` : ''

      return {
        text: `**${currentDataset.title}**\n\n${desc}${timeRange}${catText}${source}`,
      }
    }

    case 'related': {
      if (!currentDataset) {
        return { text: "There's no dataset loaded right now. Ask me about a topic and I'll find something to show you!" }
      }
      const related = findRelated(datasets, currentDataset)
      if (related.length === 0) {
        return { text: `I couldn't find datasets closely related to "${currentDataset.title}". Try asking about a specific topic instead.` }
      }
      return {
        text: `Here are datasets related to **${currentDataset.title}**:`,
        actions: datasetActions(related),
      }
    }

    case 'category': {
      const results = findByCategory(datasets, intent.category)
      if (results.length === 0) {
        return { text: `I didn't find datasets in the "${intent.category}" category. Try a different topic or search term.` }
      }
      return {
        text: `Here are some **${intent.category}** datasets:`,
        actions: datasetActions(results),
      }
    }

    case 'search': {
      const results = searchDatasets(datasets, intent.query)
      if (results.length === 0) {
        // Try broader — single best word match
        const words = intent.query.split(/\s+/)
        for (const word of words) {
          if (word.length < 3) continue
          const fallback = searchDatasets(datasets, word, 3)
          if (fallback.length > 0) {
            return {
              text: `I didn't find an exact match for "${intent.query}", but here are some results for "${word}":`,
              actions: datasetActions(fallback.map(r => r.dataset)),
            }
          }
        }
        return {
          text: `I couldn't find datasets matching "${intent.query}". Try different keywords, or ask me about a broad topic like "ocean", "climate", or "space".`,
        }
      }

      const top = results[0].dataset
      const topDesc = describeDataset(top)
      const introText = results.length === 1
        ? `I found a dataset that matches: **${top.title}**\n\n${topDesc}`
        : `I found ${results.length} datasets matching "${intent.query}". Here's the best match:\n\n**${top.title}**\n${topDesc}`

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
