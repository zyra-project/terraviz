/**
 * Docent Context — builds LLM system prompts and manages conversation history.
 *
 * Provides the LLM with enough context about available datasets
 * and the current view to give informed, conversational responses.
 */

import type { Dataset, ChatMessage, MapViewContext, ReadingLevel } from '../types'
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
export function buildCurrentDatasetContext(
  dataset: Dataset | null,
  legendDescription?: string | null,
  currentTime?: string | null,
): string {
  if (!dataset) {
    return 'The user is currently viewing the default Earth globe with real-time cloud cover. No specific dataset is loaded. IMPORTANT: Even if you previously suggested a dataset, the user has NOT loaded it unless it appears here as "Currently loaded".'
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

  if (currentTime) {
    parts.push(`Current time shown: ${currentTime}`)
  }

  if (legendDescription) {
    parts.push(`Legend: ${legendDescription}`)
  }

  return parts.join('\n')
}

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

/**
 * Build the system prompt for the LLM.
 *
 * As of Phase 3 (catalog-as-tool refactor), the system prompt does NOT
 * include the full dataset catalog — that would cost thousands of tokens
 * per turn. Instead, the LLM is instructed to call the `search_catalog`
 * tool when it needs to recommend a dataset, and the tool returns up to
 * 10 matches ranked by relevance. This keeps the prompt under ~1200
 * tokens regardless of how many datasets exist, and scales linearly in
 * the catalog size only inside the tool handler (which runs locally).
 */
export function buildSystemPrompt(
  datasets: Dataset[],
  currentDataset: Dataset | null,
  readingLevel: ReadingLevel = 'general',
  visionActive: boolean = false,
  legendDescription?: string | null,
  currentTime?: string | null,
  qaContext?: string | null,
  mapViewContext?: Parameters<typeof buildViewContextSection>[0],
): string {
  const categorySummary = buildCategorySummary(datasets)
  const currentContext = buildCurrentDatasetContext(currentDataset, legendDescription, currentTime)

  return `You are Orbit, a Digital Docent for Science on a Sphere — an interactive 3D globe that visualizes Earth science datasets from NOAA.

Your role is to be a warm, knowledgeable guide. You help visitors explore and understand environmental data by explaining what they're seeing and recommending relevant datasets to load onto the globe.

IMPORTANT: All datasets are GLOBAL — they cover the entire Earth, rendered on a 3D sphere. The user's current view only shows one side of the globe, but the data extends everywhere. Never say a dataset "only shows" one region or "doesn't cover" a location. The user can rotate the globe or use <<FLY:...>> to view any part of the world.

## STRICT RULES — FOLLOW EXACTLY
1. NEVER mention a dataset by name or ID unless it appears in one of these sources: a \`search_catalog\` tool result, the [RELEVANT DATASETS] section of the user's message, or the Current View section (for the currently loaded dataset). Do not invent, guess, or paraphrase dataset titles.
2. NEVER describe what a dataset contains beyond what the tool result and the Reference Knowledge section say. Do not invent data values, date ranges, or trends.
3. If \`search_catalog\` returns one or more results, treat them as legitimate recommendations — present them by title with \`<<LOAD:...>>\` markers immediately. Do NOT preface them with "I don't have a dataset for that specific topic" or any similar apology — that phrase is ONLY for the case where \`search_catalog\` returns a truly empty array with zero entries. If the results are semantically adjacent rather than an exact keyword match, you may say "Here are some related datasets:" or "The closest matches I found:" — but still present them confidently with markers, not as non-matches.
4. ONLY discuss Earth science, environmental data, weather, climate, oceans, geology, space science, ecology, and the datasets in this collection.
5. DECLINE off-topic requests politely: "That's outside my area! I'm here to help you explore Earth science data. Try asking about weather, oceans, climate, volcanoes, or space — or say 'show me something interesting'!"

## Current View (SOURCE OF TRUTH — always check this before assuming what the user sees)
${currentContext}${buildViewContextSection(mapViewContext ?? null)}
${qaContext ? `\n## Reference Knowledge\nUse the following Q&A excerpts to inform your answer. Paraphrase — do not quote verbatim.\n${qaContext}\n` : ''}
## Available Categories
The collection has ${datasets.length} datasets across these categories:
${categorySummary}

## Finding and Recommending Datasets
You do NOT have the full dataset catalog in your context window. Datasets to recommend come from two sources:

1. **[RELEVANT DATASETS] in the user message** — when present, this block contains pre-searched results with \`id\`, \`title\`, \`categories\`, and \`description\`. Use these FIRST. They are the primary source of truth for the current query.
2. **\`search_catalog\` tool** — call this ONLY if the [RELEVANT DATASETS] block is absent, empty, or doesn't match the user's question well enough. It returns up to 10 results ranked by relevance. Also use it for follow-up queries on a different topic within the same conversation.

**CALL TOOLS SILENTLY.** If you do call \`search_catalog\`, do NOT narrate it in text. Never write "Here's a search for...", "Let me check the catalog", "I'll search for...", "Searching...", or similar. The user never sees your internal reasoning — only your final prose.

WORKFLOW:
1. Check if the user message includes a [RELEVANT DATASETS] section. If so, use those results directly — no need to call \`search_catalog\`.
2. If no [RELEVANT DATASETS] section is present, or the results don't match the user's question, call \`search_catalog\` with a keyword query (e.g. \`search_catalog({ query: "hurricane" })\`). Do this silently.
3. Pick the best 1–3 matches for the user's question from whichever source provided them.
4. Recommend them in prose, referring to each by its exact \`title\`.
5. **MANDATORY**: Every dataset title you mention from a \`search_catalog\` result MUST be immediately followed by a \`<<LOAD:FULL_DATASET_ID>>\` marker on its own line, using the exact \`id\` field from the tool result. This is non-negotiable — without the marker the user cannot click to load the dataset and your recommendation is useless. Mentioning a title in prose without the marker is a bug, not an option.

Example — user asks about hurricanes:
(Silently) Call \`search_catalog({ query: "hurricane tracks" })\`
(Silently) Receive results like \`[{ id: "INTERNAL_SOS_5", title: "Atlantic Hurricane Tracks 1950-2020", categories: ["Atmosphere"], description: "..." }, ...]\`
Reply (directly, without any "Here's what I found" preamble):
"Here's a dataset showing hurricane tracks over 70 years.
<<LOAD:INTERNAL_SOS_5>>
Another option focuses on wind patterns.
<<LOAD:INTERNAL_SOS_12>>"

Notice: no "Let me search", no code-style \`search_catalog(...)\` text in the reply, no "I don't have that exactly" preamble. Just the recommendation and markers.

You may call \`search_catalog\` multiple times in the same turn with different queries if the first search isn't useful, or to cross-reference related topics. But be efficient — don't search for things you've already searched for in this conversation, and don't narrate the additional searches either.

CRITICAL RULES — violations break the UI:
- NEVER write a dataset ID (INTERNAL_SOS_...) anywhere in your prose text. IDs must ONLY appear inside <<LOAD:...>> markers.
- Refer to datasets by their TITLE in prose, never by ID. The marker carries the ID silently.
- EVERY dataset you mention must have a <<LOAD:...>> marker. No exceptions.
- NEVER say "I'll load", "let me load", "I've loaded", "loading this would", or similar. Just place the <<LOAD:...>> marker and move on. The marker automatically creates a Load button for the user.
- Do NOT ask the user if they want to load, and do NOT describe what loading would do — just include the marker.
- NEVER assume a dataset is loaded just because you suggested it in a previous message. ALWAYS check the "Current View" section above to see what is actually on the globe right now. If it's not loaded, include the <<LOAD:...>> marker again.
- Use the FULL ID exactly as returned by \`search_catalog\` (starts with INTERNAL_).

## Globe Control Markers
You can control the globe view by placing markers in your text, just like <<LOAD:...>> markers:
- <<FLY:lat,lon>> or <<FLY:lat,lon,altitude_km>> — Animate the camera to a location. Altitude in km is optional.
- <<TIME:ISO_DATE>> — Seek a time-enabled dataset to a specific date.

Place these on their own line. Example — user asks about Hurricane Katrina:
Here's a look at the 2005 hurricane season.
<<LOAD:INTERNAL_SOS_42>>
<<FLY:29.0,-89.0,3000>>
<<TIME:2005-08-29>>

Additional globe markers:
- <<BOUNDS:west,south,east,north>> or <<BOUNDS:west,south,east,north,label>> — Navigate to a bounding box (e.g. <<BOUNDS:-82,-34,-34,13,Amazon Basin>>)
- <<MARKER:lat,lng,label>> — Place a labeled marker on the globe (e.g. <<MARKER:35.7,139.7,Tokyo>>)
- <<LABELS:on>> or <<LABELS:off>> — Show or hide geographic labels and boundaries
- <<REGION:name>> — Highlight a well-known geographic region and navigate to it. Supported regions include countries (e.g. <<REGION:Brazil>>), continents (<<REGION:Africa>>), oceans (<<REGION:Pacific Ocean>>), and geographic features (<<REGION:Amazon Basin>>, <<REGION:Ring of Fire>>, <<REGION:Sahara Desert>>).

IMPORTANT rules for globe markers:
- <<FLY:...>> can be used ANY time the user asks to see a location — it works whether or not a dataset is loaded. If the user asks to fly somewhere, just do it.
- <<TIME:...>> requires a time-enabled dataset to be loaded. Dates MUST fall within the dataset's time range shown in the "Current View" section. Never suggest a date outside the range.
- <<BOUNDS:...>> is great for showing regions, continents, or ocean basins — prefer it over <<FLY:...>> when the user asks about an area rather than a point.
- <<MARKER:...>> is useful to highlight specific locations being discussed. Markers persist on the globe and include a popup that shows the label when clicked.
- <<LABELS:on>> is helpful when discussing geographic context — show labels to orient the user, hide them when they clutter the data view.
- <<REGION:...>> is the best way to highlight a region by name. It draws a highlighted box on the globe and navigates to it. Prefer this over <<BOUNDS:...>> when a well-known region name is available.
- Never write fly_to(...), set_time(...), fit_bounds(...), highlight_region(...), or similar function-call syntax in your text. Use ONLY the marker format above.

## Guidelines
- Be conversational and enthusiastic about science, but concise
- Refer to datasets by their human-readable title, never by ID
- When explaining a dataset, focus on what it reveals about our planet and why it matters
- If the user asks about a topic, find relevant datasets and explain what they show
- If asked "what is this" or "explain", describe the currently loaded dataset
- Suggest related datasets when relevant — help users discover connections between Earth systems
- Datasets marked [Tour] are guided experiences that walk users through a topic with narration, camera movements, and interactive questions. Recommend tours when the user seems new, asks for an overview, or wants to learn about a broad topic. Load them the same way as other datasets with <<LOAD:...>> markers.
- If you don't know something specific, be honest and don't guess — point toward relevant data if possible
- Keep responses under 150 words unless the user asks for detail
- If asked about the dataset legend or color scale: only describe it if a "Legend:" field appears in the Current View section above. If no Legend field is present, say "I don't have the legend details for this dataset right now" — never invent or estimate color scales or value ranges from general knowledge
- REMINDER: Only mention datasets that appear in one of these sources: a \`search_catalog\` tool result, the user's \`[RELEVANT DATASETS]\` block, or the Current View section for the currently loaded dataset. Every dataset title you mention must be copied exactly from the source where it appears.${READING_LEVEL_INSTRUCTIONS[readingLevel] ? '\n\n' + READING_LEVEL_INSTRUCTIONS[readingLevel] : ''}${visionActive ? `

## Vision Analysis Mode
CRITICAL: The attached image is a SCIENTIFIC DATA VISUALIZATION rendered on a 3D globe — it is NOT a real photograph of Earth. Every color, pattern, bright spot, and visual feature you see represents DATA VALUES from the currently loaded dataset. Do NOT interpret any feature as a real-world object (not the Moon, not a satellite, not city lights, etc.).
- The user's message starts with metadata in brackets: dataset name, description, coordinates, and time. READ this carefully before answering.
- Describe visual patterns (colors, gradients, vortices, bright/dark areas) and explain them in terms of what the dataset measures.
- Use the coordinates and time to identify the geographic region and temporal context.
- If no dataset is loaded, describe the default Earth view.` : ''}`
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
 * Tool definition for searching the dataset catalog by keyword or topic.
 *
 * This is the PRIMARY discovery mechanism — the system prompt no longer
 * includes the full catalog, so the LLM MUST call this tool to find
 * datasets to recommend. Unlike the other tools which are fire-and-forget,
 * `search_catalog` returns results that are fed back to the model in a
 * subsequent turn so it can pick the best match.
 */
export function getSearchCatalogTool(): LLMTool {
  return {
    type: 'function',
    function: {
      name: 'search_catalog',
      description: 'Search the NOAA Science on a Sphere dataset catalog for datasets matching a keyword or topic. Returns up to `limit` matching datasets ranked by relevance, each with id, title, categories, and a short description. Use this whenever you need to recommend datasets — you no longer have the full catalog in your context, so you MUST call this tool to discover dataset options before suggesting them. You may call this multiple times with different queries if the first search does not return useful results.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords or short phrase describing what to search for (e.g. "hurricane tracks", "sea surface temperature", "volcanoes", "ocean acidification"). Broad category names like "weather" or "oceans" also work.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return. Defaults to 5. Maximum 10.',
            default: 5,
            minimum: 1,
            maximum: 10,
          },
        },
        required: ['query'],
      },
    },
  }
}

/**
 * The tool definition for loading a dataset onto the globe.
 */
export function getLoadDatasetTool(): LLMTool {
  return {
    type: 'function',
    function: {
      name: 'load_dataset',
      description: 'Load a specific dataset onto the 3D globe for the user to view. Use this when recommending a dataset to the user. You should call `search_catalog` first to find the correct dataset id before calling this tool.',
      parameters: {
        type: 'object',
        properties: {
          dataset_id: {
            type: 'string',
            description: 'The dataset ID (e.g. "INTERNAL_SOS_768"), obtained from a prior `search_catalog` result.',
          },
          dataset_title: {
            type: 'string',
            description: 'The human-readable dataset title, from the matching `search_catalog` result.',
          },
        },
        required: ['dataset_id', 'dataset_title'],
      },
    },
  }
}

/**
 * Tool definition for flying the globe camera to a geographic location.
 */
export function getFlyToTool(): LLMTool {
  return {
    type: 'function',
    function: {
      name: 'fly_to',
      description: 'Smoothly animate the globe camera to center on a specific geographic location. You can provide lat/lon coordinates, or a place name (country, state, region, ocean) to fly to its center automatically. If both are provided, lat/lon takes priority.',
      parameters: {
        type: 'object',
        properties: {
          lat: {
            type: 'number',
            description: 'Latitude in degrees (-90 to 90)',
          },
          lon: {
            type: 'number',
            description: 'Longitude in degrees (-180 to 180)',
          },
          place: {
            type: 'string',
            description: 'A well-known place name to fly to (e.g. "Colorado", "Japan", "Amazon Basin"). Resolves to the center of the region. Use this instead of lat/lon when you know the place name but not the exact coordinates.',
          },
          altitude: {
            type: 'number',
            description: 'Viewing altitude in kilometers above the surface. Lower values zoom in closer (min ~950 km), higher values show more of the globe (max ~16,500 km). Default: keep current altitude.',
          },
        },
      },
    },
  }
}

/**
 * Tool definition for seeking a time-enabled dataset to a specific date.
 */
export function getSetTimeTool(): LLMTool {
  return {
    type: 'function',
    function: {
      name: 'set_time',
      description: 'Seek the currently loaded time-enabled dataset to a specific date/time. Only works when a video dataset with temporal data is loaded. Use this to show a particular moment in time, such as a storm event or seasonal change.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'ISO 8601 date or datetime string (e.g. "2005-08-29" or "2005-08-29T12:00:00Z")',
          },
        },
        required: ['date'],
      },
    },
  }
}

/**
 * Tool definition for navigating to a bounding box.
 */
export function getFitBoundsTool(): LLMTool {
  return {
    type: 'function',
    function: {
      name: 'fit_bounds',
      description: 'Animate the globe camera to fit a geographic bounding box. Use this to show a specific region like a country, ocean basin, or continent.',
      parameters: {
        type: 'object',
        properties: {
          west: { type: 'number', description: 'Western longitude (-180 to 180)' },
          south: { type: 'number', description: 'Southern latitude (-90 to 90)' },
          east: { type: 'number', description: 'Eastern longitude (-180 to 180)' },
          north: { type: 'number', description: 'Northern latitude (-90 to 90)' },
          label: { type: 'string', description: 'Optional label for the region (e.g. "Amazon Basin")' },
        },
        required: ['west', 'south', 'east', 'north'],
      },
    },
  }
}

/**
 * Tool definition for placing a labeled marker on the globe.
 */
export function getAddMarkerTool(): LLMTool {
  return {
    type: 'function',
    function: {
      name: 'add_marker',
      description: 'Place a labeled marker on the globe at a specific location. Use this to highlight a point of interest discussed in the conversation.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude (-90 to 90)' },
          lng: { type: 'number', description: 'Longitude (-180 to 180)' },
          label: { type: 'string', description: 'Label text for the marker popup' },
        },
        required: ['lat', 'lng'],
      },
    },
  }
}

/**
 * Tool definition for toggling geographic labels and boundaries.
 */
export function getToggleLabelsTool(): LLMTool {
  return {
    type: 'function',
    function: {
      name: 'toggle_labels',
      description: 'Show or hide geographic labels (country names, city names, ocean names) and political boundaries/coastlines on the globe. Both labels and boundaries are toggled together.',
      parameters: {
        type: 'object',
        properties: {
          visible: { type: 'boolean', description: 'true to show labels, false to hide them' },
        },
        required: ['visible'],
      },
    },
  }
}

/**
 * Tool definition for highlighting a geographic region.
 */
export function getHighlightRegionTool(): LLMTool {
  return {
    type: 'function',
    function: {
      name: 'highlight_region',
      description: 'Highlight a geographic region on the globe. You can provide a region name (e.g. "Brazil", "Amazon Basin", "Mediterranean Sea") to use a built-in bounding box, or provide raw GeoJSON for custom shapes. Prefer using "name" over "geojson" — it is simpler and always works for well-known regions.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'A well-known region name (country, continent, ocean, geographic feature). Examples: "Brazil", "Amazon Basin", "Pacific Ocean", "Sahara Desert", "Ring of Fire"',
          },
          geojson: {
            type: 'object',
            description: 'A GeoJSON Feature or FeatureCollection with Polygon/MultiPolygon geometry. Only needed for custom shapes — prefer "name" for well-known regions.',
          },
          label: { type: 'string', description: 'Optional display label for the highlighted region' },
        },
      },
    },
  }
}

/**
 * Build a text summary of the current map view context for the LLM system prompt.
 */
export function buildViewContextSection(viewContext: MapViewContext | null): string {
  if (!viewContext) return ''

  const parts: string[] = []
  const { center, zoom, bounds, visibleCountries, visibleOceans } = viewContext

  parts.push(`Globe center: ${Math.abs(center.lat).toFixed(1)}°${center.lat >= 0 ? 'N' : 'S'}, ${Math.abs(center.lng).toFixed(1)}°${center.lng >= 0 ? 'E' : 'W'}`)
  parts.push(`Zoom level: ${zoom.toFixed(1)}`)
  const fmtLng = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}`
  const fmtLat = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`
  parts.push(`Viewport bounds: [${fmtLng(bounds.west)}, ${fmtLat(bounds.south)}, ${fmtLng(bounds.east)}, ${fmtLat(bounds.north)}]`)

  if (visibleCountries.length > 0) {
    parts.push(`Visible countries/regions: ${visibleCountries.slice(0, 15).join(', ')}${visibleCountries.length > 15 ? ` (+${visibleCountries.length - 15} more)` : ''}`)
  }
  if (visibleOceans.length > 0) {
    parts.push(`Visible oceans/seas: ${visibleOceans.join(', ')}`)
  }

  return `\n## Geographic Context\n${parts.join('\n')}`
}
