/**
 * Docent Context — builds LLM system prompts and manages conversation history.
 *
 * Provides the LLM with enough context about available datasets
 * and the current view to give informed, conversational responses.
 */

import type { Dataset, ChatMessage } from '../types'
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
export function buildSystemPromptForTurn(
  datasets: Dataset[],
  currentDataset: Dataset | null,
  turnIndex: number,
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

  return `You are a Digital Docent for Science on a Sphere — an interactive 3D globe that visualizes Earth science datasets from NOAA.

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
To load a dataset onto the globe, you MUST include this exact marker on its own line in your response:
<<LOAD:FULL_DATASET_ID>>

The FULL_DATASET_ID must be the complete ID from the dataset reference above (e.g. INTERNAL_SOS_5, not just "5").

Example — if the user asks about hurricanes, respond like this:
Great question! Here's a dataset showing hurricane tracks over 70 years.
<<LOAD:INTERNAL_SOS_5>>

IMPORTANT RULES:
- ALWAYS use <<LOAD:...>> markers — never write load_dataset() or any other format
- ALWAYS use the FULL dataset ID exactly as listed above (starts with INTERNAL_)
- Place the marker AFTER your explanation, on its own line
- Do NOT ask the user if they want to load it — just load it
- You can include multiple <<LOAD:...>> markers to suggest several datasets

## Guidelines
- Be conversational and enthusiastic about science, but concise
- When explaining a dataset, focus on what it reveals about our planet and why it matters
- If the user asks about a topic, find relevant datasets and explain what they show
- If asked "what is this" or "explain", describe the currently loaded dataset
- Suggest related datasets when relevant — help users discover connections between Earth systems
- If you don't know something specific, be honest and don't guess — point toward relevant data if possible
- Keep responses under 150 words unless the user asks for detail
- REMINDER: Never mention a dataset that is not in the reference list above. Every dataset title and ID you mention must be copied exactly from the list.`
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
