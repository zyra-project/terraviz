/**
 * Docent Context — builds LLM system prompts and manages conversation history.
 *
 * Provides the LLM with enough context about available datasets
 * and the current view to give informed, conversational responses.
 */

import type { Dataset, ChatMessage, ReadingLevel } from '../types'
import type { LLMMessage, LLMTool } from './llmProvider'

// --- Constants ---
const MAX_HISTORY_MESSAGES = 50
const RECENT_EXCHANGE_COUNT = 3 // keep last N exchanges (user+docent pairs) verbatim

/**
 * Build a compact summary of available dataset categories with counts.
 */
export function buildCategorySummary(datasets: Dataset[]): string {
  const catCounts = new Map<string, number>()
  for (const d of datasets) {
    if (d.enriched?.categories) {
      for (const cat of Object.keys(d.enriched.categories)) {
        catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1)
      }
    }
  }

  const sorted = Array.from(catCounts.entries())
    .sort((a, b) => b[1] - a[1])

  return sorted.map(([cat, count]) => `- ${cat} (${count})`).join('\n')
}

/**
 * Build a compact description of the currently loaded dataset.
 */
export function buildCurrentDatasetContext(dataset: Dataset | null): string {
  if (!dataset) {
    return 'The user is currently viewing the default Earth globe with real-time cloud cover. No specific dataset is loaded.'
  }

  const parts: string[] = [
    `Currently loaded: "${dataset.title}"`,
  ]

  const desc = dataset.enriched?.description ?? dataset.abstractTxt
  if (desc) {
    const short = desc.length > 400 ? desc.substring(0, 400) + '…' : desc
    parts.push(`Description: ${short}`)
  }

  const cats = Object.keys(dataset.enriched?.categories ?? {})
  if (cats.length > 0) {
    parts.push(`Categories: ${cats.join(', ')}`)
  }

  const keywords = dataset.enriched?.keywords
  if (keywords && keywords.length > 0) {
    parts.push(`Keywords: ${keywords.slice(0, 10).join(', ')}`)
  }

  if (dataset.organization) {
    parts.push(`Source: ${dataset.organization}`)
  }

  if (dataset.startTime && dataset.endTime) {
    parts.push(`Time range: ${dataset.startTime} to ${dataset.endTime}`)
  }

  const related = dataset.enriched?.relatedDatasets
  if (related && related.length > 0) {
    parts.push(`Related datasets: ${related.map(r => r.title).join(', ')}`)
  }

  return parts.join('\n')
}

/**
 * Build a lookup string of datasets the LLM can reference by ID.
 * Compact format to save tokens: "ID | Title [Categories]"
 */
export function buildDatasetLookup(datasets: Dataset[]): string {
  // Include ALL datasets so the LLM knows the full catalog
  const sorted = [...datasets]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))

  return sorted.map(d => {
    const cats = Object.keys(d.enriched?.categories ?? {}).slice(0, 2).join(', ')
    return `${d.id} | ${d.title}${cats ? ` [${cats}]` : ''}`
  }).join('\n')
}

/**
 * Build a compact ID-only lookup for follow-up turns.
 * Much shorter than the full lookup — just "ID | Title" with no categories.
 */
export function buildCompactDatasetLookup(datasets: Dataset[]): string {
  const sorted = [...datasets]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))

  return sorted.map(d => `${d.id} | ${d.title}`).join('\n')
}

/**
 * Build the full system prompt for the LLM.
 * Backward-compatible wrapper — always includes the full catalog.
 */
export function buildSystemPrompt(datasets: Dataset[], currentDataset: Dataset | null): string {
  return buildSystemPromptForTurn(datasets, currentDataset, 0)
}

/**
 * Build a turn-aware system prompt.
 * Turn 0: includes the full dataset catalog.
 * Turn >= 1: includes a compact ID-only dataset reference to save tokens.
 */
/** Maps each reading level to system prompt instructions for tone and vocabulary. */
const READING_LEVEL_INSTRUCTIONS: Record<ReadingLevel, string> = {
  'young-learner': `## Reading Level: Young Learner
Explain everything as if talking to a curious 10-year-old. Use simple, everyday words and short sentences. Compare scientific concepts to things kids experience — weather, animals, food, sports, playground activities. Show excitement and wonder ("Wow!", "Cool, right?"). Avoid jargon entirely; if a science term is necessary, immediately explain it in plain language. Keep responses under 100 words.`,

  'general': '', // default — no extra instructions needed

  'in-depth': `## Reading Level: In-Depth
Provide thorough, informative responses suitable for a scientifically curious adult. Use proper scientific terminology but define technical terms on first use. You may exceed the 150-word limit up to 250 words when the topic warrants it. Explain the "how" and "why" behind phenomena, mention relevant measurement methods or data sources when appropriate, and connect topics to broader Earth system processes.`,

  'expert': `## Reading Level: Expert
Respond at a professional/graduate science level. Use precise scientific terminology freely without defining common domain terms. Focus on data specifics — resolution, temporal coverage, instrumentation, and methodology. Discuss limitations, uncertainties, and how datasets relate to current research. You may ignore the default 150-word limit and use up to 300 words when helpful. Assume the reader has strong background knowledge in Earth sciences.`,
}

export function buildSystemPromptForTurn(
  datasets: Dataset[],
  currentDataset: Dataset | null,
  turnIndex: number,
  readingLevel: ReadingLevel = 'general',
  visionActive: boolean = false,
): string {
  const categorySummary = buildCategorySummary(datasets)
  const currentContext = buildCurrentDatasetContext(currentDataset)

  const catalogSection = turnIndex === 0
    ? `## Dataset Reference
Here are some featured datasets you can recommend (ID | Title [Categories]):
${buildDatasetLookup(datasets)}`
    : `## Dataset Reference (compact)
Available datasets (ID | Title):
${buildCompactDatasetLookup(datasets)}`

  return `You are Orbit, a Digital Docent for Science on a Sphere — an interactive 3D globe that visualizes Earth science datasets from NOAA.

Your role is to be a warm, knowledgeable guide. You help visitors explore and understand environmental data by explaining what they're seeing and recommending relevant datasets to load onto the globe.

## STRICT RULES — FOLLOW EXACTLY
1. NEVER mention a dataset by name or ID unless it appears EXACTLY in the dataset reference list below. Do not invent, guess, or paraphrase dataset titles. If you are unsure whether a dataset exists, do NOT mention it.
2. NEVER describe what a dataset contains beyond what its title says. Do not invent data values, date ranges, or trends.
3. If no dataset in the list matches the user's question, say: "I don't have a dataset for that specific topic, but here are some related ones I can show you:" and suggest the closest matches from the list.
4. ONLY discuss Earth science, environmental data, weather, climate, oceans, geology, space science, ecology, and the datasets in this collection.
5. DECLINE off-topic requests politely: "That's outside my area! I'm here to help you explore Earth science data. Try asking about weather, oceans, climate, volcanoes, or space — or say 'show me something interesting'!"

## Current View
${currentContext}

## Available Categories
The collection has ${datasets.length} datasets across these categories:
${categorySummary}

${catalogSection}

## How to Load Datasets
To suggest a dataset, place its marker on its own line IMMEDIATELY after the sentence that mentions it:
<<LOAD:FULL_DATASET_ID>>

The FULL_DATASET_ID is the exact ID from the dataset reference list (e.g. INTERNAL_SOS_5).

Example — user asks about hurricanes:
Here's a dataset showing hurricane tracks over 70 years.
<<LOAD:INTERNAL_SOS_5>>
Another option focuses on wind patterns.
<<LOAD:INTERNAL_SOS_12>>

CRITICAL RULES — violations break the UI:
- NEVER write a dataset ID (INTERNAL_SOS_...) anywhere in your prose text. IDs must ONLY appear inside <<LOAD:...>> markers.
- Refer to datasets by their TITLE in prose, never by ID. The marker carries the ID silently.
- EVERY dataset you mention must have a <<LOAD:...>> marker. No exceptions.
- NEVER say "I'll load", "let me load", or "I've loaded" — the marker triggers loading automatically. Just place the marker.
- Do NOT ask the user if they want to load — just include the marker.
- Use the FULL ID exactly as listed (starts with INTERNAL_).

## Guidelines
- Be conversational and enthusiastic about science, but concise
- Refer to datasets by their human-readable title, never by ID
- When explaining a dataset, focus on what it reveals about our planet and why it matters
- If the user asks about a topic, find relevant datasets and explain what they show
- If asked "what is this" or "explain", describe the currently loaded dataset
- Suggest related datasets when relevant — help users discover connections between Earth systems
- If you don't know something specific, be honest and don't guess — point toward relevant data if possible
- Keep responses under 150 words unless the user asks for detail
- REMINDER: Never mention a dataset that is not in the reference list above. Every dataset title you mention must be copied exactly from the list.${READING_LEVEL_INSTRUCTIONS[readingLevel] ? '\n\n' + READING_LEVEL_INSTRUCTIONS[readingLevel] : ''}${visionActive ? `

## Vision Analysis Mode
The user has attached a screenshot of the current globe view along with metadata (dataset name, coordinates, timestamp). IMPORTANT: Always interpret the image in terms of the loaded dataset — do NOT guess that features are unrelated phenomena.
- The text before the user's question contains metadata: dataset name, coordinates, and time. USE this to interpret the image correctly.
- Whatever is visible on the globe IS the loaded dataset's data. Colors, patterns, and features represent the dataset's variables, not unrelated objects.
- Describe what you observe — colors, patterns, gradients, geographic features — and connect them to what the dataset measures.
- Be specific about regions and patterns. Use the coordinates to identify the geographic area.
- If no dataset is loaded, describe the default Earth view (continents, clouds, lighting).` : ''}`
}

/**
 * Restore [[LOAD:ID]] placeholders (set by the chat UI for inline buttons)
 * back to <<LOAD:ID>> so the LLM sees a consistent marker format in history.
 */
function restoreLoadMarkers(text: string): string {
  return text.replace(/\[\[LOAD:([^\]]+)\]\]/g, '<<LOAD:$1>>')
}

/**
 * Convert ChatMessage history to LLM message format, trimmed to max length.
 */
export function buildMessageHistory(messages: ChatMessage[]): LLMMessage[] {
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES)

  return trimmed.map(msg => ({
    role: msg.role === 'user' ? 'user' as const : 'assistant' as const,
    content: msg.role === 'user' ? msg.text : restoreLoadMarkers(msg.text),
  }))
}

/**
 * Summarize older messages into a compact string.
 * Extracts topics from user messages and loaded datasets from docent actions.
 */
export function summarizeOlderMessages(messages: ChatMessage[]): string {
  const topics: string[] = []
  const loadedDatasets: string[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const short = msg.text.length > 60 ? msg.text.substring(0, 60) + '…' : msg.text
      topics.push(short)
    } else if (msg.actions?.length) {
      for (const a of msg.actions) {
        if (a.type === 'load-dataset' && !loadedDatasets.includes(a.datasetTitle)) {
          loadedDatasets.push(a.datasetTitle)
        }
      }
    }
  }

  const parts: string[] = []
  if (topics.length > 0) parts.push(`Topics discussed: ${topics.join('; ')}`)
  if (loadedDatasets.length > 0) parts.push(`Datasets suggested: ${loadedDatasets.join(', ')}`)
  return parts.length > 0
    ? `[Conversation summary: ${parts.join('. ')}.]\n`
    : ''
}

/**
 * Build a compressed message history for the LLM.
 * Last N exchanges are kept verbatim; older messages are summarized.
 */
export function buildCompressedHistory(messages: ChatMessage[]): LLMMessage[] {
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES)

  // How many recent messages to keep verbatim (N exchanges = 2N messages)
  const recentCount = RECENT_EXCHANGE_COUNT * 2

  if (trimmed.length <= recentCount) {
    return trimmed.map(msg => ({
      role: msg.role === 'user' ? 'user' as const : 'assistant' as const,
      content: msg.role === 'user' ? msg.text : restoreLoadMarkers(msg.text),
    }))
  }

  const older = trimmed.slice(0, -recentCount)
  const recent = trimmed.slice(-recentCount)

  const result: LLMMessage[] = []

  const summary = summarizeOlderMessages(older)
  if (summary) {
    result.push({ role: 'system', content: summary })
  }

  for (const msg of recent) {
    result.push({
      role: msg.role === 'user' ? 'user' as const : 'assistant' as const,
      content: msg.role === 'user' ? msg.text : restoreLoadMarkers(msg.text),
    })
  }

  return result
}

/**
 * The tool definition for loading a dataset onto the globe.
 */
export function getLoadDatasetTool(): LLMTool {
  return {
    type: 'function',
    function: {
      name: 'load_dataset',
      description: 'Load a specific dataset onto the 3D globe for the user to view. Use this when recommending a dataset.',
      parameters: {
        type: 'object',
        properties: {
          dataset_id: {
            type: 'string',
            description: 'The dataset ID (e.g. "INTERNAL_SOS_768")',
          },
          dataset_title: {
            type: 'string',
            description: 'The human-readable dataset title',
          },
        },
        required: ['dataset_id', 'dataset_title'],
      },
    },
  }
}
