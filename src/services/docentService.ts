/**
 * Docent Service — orchestrates LLM-first responses with local fallback.
 *
 * Tries the configured LLM provider. If unavailable or unconfigured,
 * falls back to the local docentEngine for instant offline responses.
 */

import type { Dataset, ChatMessage, ChatAction, DocentConfig, LegendCache, MapViewContext, LLMContextSnapshot, ReadingLevel } from '../types'
import { streamChat, checkAvailability, type AvailabilityResult, type LLMMessage, type LLMContentPart, type LLMToolCall } from './llmProvider'
import { isAvailable as isAppleIntelligenceAvailable, streamChatLocal } from './appleIntelligenceProvider'
import { buildSystemPrompt, buildCompressedHistory, getSearchCatalogTool, getSearchDatasetsTool, getListFeaturedDatasetsTool, getLoadDatasetTool, getFlyToTool, getSetTimeTool, getFitBoundsTool, getAddMarkerTool, getToggleLabelsTool, getHighlightRegionTool } from './docentContext'
import { parseIntent, generateResponse, searchDatasets, evaluateAutoLoad } from './docentEngine'
import { ensureLoaded as ensureQALoaded, getRelevantQA } from './qaService'
import { resolveRegion, boundsToGeoJSON } from '../data/regions'
import { logger } from '../utils/logger'

// --- Constants ---
const CONFIG_STORAGE_KEY = 'sos-docent-config'

/**
 * Default vision-capable model for Cloudflare Workers AI. `llama-4-scout`
 * is natively multimodal AND supports function calling, so the eye-icon
 * screenshot path can now call `search_catalog` alongside the image —
 * which was impossible with the previous `llama-3.2-11b-vision` fallback
 * (that model doesn't support tools and has a separate non-OpenAI API).
 */
const CF_VISION_MODEL = 'llama-4-scout'
const VISION_TIMEOUT_MS = 60000

/** Detect localhost dev where the Cloudflare /api proxy may be unavailable. */
export const isLocalDev = typeof window !== 'undefined'
  && ['localhost', '127.0.0.1'].includes(window.location.hostname)

/**
 * Read overlay context that the canvas screenshot doesn't capture
 * (coordinates, time label, dataset title, playback state, etc.)
 * so the LLM gets the full picture.
 */
export function captureViewContext(): string {
  const parts: string[] = []

  // Dataset title from the info panel header
  const titleEl = document.getElementById('info-title')
  const titleText = titleEl?.textContent?.trim()
  if (titleText) {
    parts.push(`Dataset loaded: ${titleText}`)
  }

  // Lat/lon coordinates shown on the globe overlay
  const coordEl = document.getElementById('latlng-display')
  const coordText = coordEl?.textContent?.trim()
  if (coordText) {
    parts.push(`Globe center: ${coordText}`)
  }

  const timeLabelEl = document.getElementById('time-label')
  if (timeLabelEl && !timeLabelEl.classList.contains('hidden')) {
    const timeEl = document.getElementById('time-display')
    const timeText = timeEl?.textContent?.trim()
    if (timeText && timeText !== '--') {
      parts.push(`Time shown: ${timeText}`)
    }
  }
  const playBtn = document.getElementById('play-btn')
  if (playBtn) {
    const isPlaying = playBtn.getAttribute('aria-label')?.toLowerCase().includes('pause')
    parts.push(isPlaying ? 'Playback: playing' : 'Playback: paused')
  }

  // Approximate viewing altitude from camera distance
  // Sphere radius = 1.0 in scene units ≈ Earth radius (6,371 km)
  const canvas = document.getElementById('globe-canvas') as HTMLCanvasElement | null
  const cameraZ = canvas?.dataset.cameraZ ? parseFloat(canvas.dataset.cameraZ) : null
  if (cameraZ !== null && !isNaN(cameraZ)) {
    const EARTH_RADIUS_KM = 6371
    const altitudeKm = Math.round((cameraZ - 1.0) * EARTH_RADIUS_KM)
    parts.push(`Viewing altitude: ~${altitudeKm.toLocaleString()} km`)
  }

  return parts.length > 0 ? parts.join('. ') + '.' : ''
}

// --- Legend cache ---

/** AbortController for any in-flight background legend describe call. */
let legendDescribeAbortController: AbortController | null = null

const legendCache: LegendCache = {
  legendBase64: null,
  legendMimeType: null,
  legendDescription: null,
  legendDescriptionForDatasetId: null,
}

/** Read the current time label from the globe overlay.
 * Returns null if the time label is hidden (no temporal data for the current dataset).
 */
export function readCurrentTime(): string | null {
  const labelEl = document.getElementById('time-label')
  if (!labelEl || labelEl.classList.contains('hidden')) return null
  const el = document.getElementById('time-display')
  const text = el?.textContent?.trim()
  return (text && text !== '--') ? text : null
}

/** Fetch a legend image URL and encode it as a full data URL.
 * Routes through the /api/legend proxy to avoid browser CORS restrictions.
 */
async function fetchLegendBase64(legendLink: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    // The /api/legend proxy fetches the image from the CF edge (no CORS issues).
    // On localhost the vite proxy forwards /api/* to the production CF deployment.
    const proxyUrl = `/api/legend?url=${encodeURIComponent(legendLink)}`
    const res = await fetch(proxyUrl)
    if (!res.ok) return null
    const blob = await res.blob()
    const mimeType = blob.type || 'image/png'
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve({ base64: reader.result as string, mimeType })
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * Fire a background LLM vision call to generate a text description of the legend.
 * Populates legendCache.legendDescription on success; fails silently on error.
 */
async function describeLegendAsync(dataset: Dataset, config: DocentConfig): Promise<void> {
  if (!dataset.legendLink || !dataset.id) return

  legendDescribeAbortController?.abort()
  const controller = new AbortController()
  legendDescribeAbortController = controller

  try {
    const encoded = await fetchLegendBase64(dataset.legendLink)
    if (controller.signal.aborted) return
    if (!encoded) return

    legendCache.legendBase64 = encoded.base64
    legendCache.legendMimeType = encoded.mimeType

    if (!config.enabled || !config.apiUrl) return

    // Always use the vision model for the describe call regardless of user's chat model
    const describeCfg: DocentConfig = { ...config, model: CF_VISION_MODEL }

    const describeMessages: LLMMessage[] = [
      {
        role: 'system',
        content: 'You are a precise scientific data transcription assistant. Your only job is to read numbers, units, and labels directly from legend images — never infer or use prior knowledge.',
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: encoded.base64 } },
          {
            type: 'text',
            text: `Transcribe this legend image for the dataset "${dataset.title}". For each colorbar or scale visible: (1) read the exact numbers shown at each labeled tick mark, (2) state the units exactly as written, (3) describe what the scale measures. If there are multiple scales, describe each one. Only report values explicitly visible in the image — do not guess, extrapolate, or apply prior scientific knowledge.`,
          },
        ] as LLMContentPart[],
      },
    ]

    let description = ''
    const stream = streamChat(describeMessages, [], describeCfg, { timeoutMs: VISION_TIMEOUT_MS })
    for await (const chunk of stream) {
      if (controller.signal.aborted) return
      if (chunk.type === 'delta') description += chunk.text
      if (chunk.type === 'done' || chunk.type === 'error') break
    }

    if (controller.signal.aborted) return
    if (description.trim()) {
      legendCache.legendDescription = description.trim()
      legendCache.legendDescriptionForDatasetId = dataset.id
    }
  } catch {
    // Fail silently — legend context is best-effort
  }
}

/**
 * Initialise the legend cache for a newly loaded dataset.
 * Clears the previous cache and fires a background fetch+describe.
 * Call this after a dataset successfully loads.
 */
export function initLegendForDataset(dataset: Dataset, config: DocentConfig): void {
  clearLegendCache()
  if (!dataset.legendLink) return
  void describeLegendAsync(dataset, config)
}

/**
 * Clear the legend cache and abort any in-flight describe call.
 * Call this when navigating home or loading a new dataset.
 */
export function clearLegendCache(): void {
  legendDescribeAbortController?.abort()
  legendDescribeAbortController = null
  legendCache.legendBase64 = null
  legendCache.legendMimeType = null
  legendCache.legendDescription = null
  legendCache.legendDescriptionForDatasetId = null
}

/** Read-only accessor for the current legend cache (consumed by processMessage). */
export function getLegendCache(): Readonly<LegendCache> {
  return legendCache
}

const IS_TAURI = typeof window !== 'undefined' && !!(window as any).__TAURI__
const tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null =
  IS_TAURI ? (window as any).__TAURI_INTERNALS__?.invoke ?? null : null

const DEFAULT_CONFIG: DocentConfig = {
  apiUrl: IS_TAURI ? '' : '/api',
  apiKey: '',
  // Default to llama-4-scout on the CF proxy. It's natively multimodal
  // (text + images in one model, no vision auto-switch needed) and
  // supports function calling (tools forwarded via toolStreamShim),
  // which enables highlight_region, add_marker, fly_to, and other
  // globe control tools to work on the CF path.
  model: IS_TAURI ? '' : 'llama-4-scout',
  enabled: true,
  readingLevel: 'general',
  visionEnabled: false,
  debugPrompt: false,
}

/** Yielded by the service during response generation */
export type DocentStreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'action'; action: ChatAction }
  | { type: 'auto-load'; action: ChatAction; alternatives: ChatAction[] }
  | { type: 'rewrite'; text: string }
  | { type: 'done'; fallback: boolean; llmContext?: LLMContextSnapshot }

/**
 * Load docent config from localStorage, merging with defaults.
 * On Tauri the API key field will be empty — use loadConfigWithKey() when you need it.
 */
export function loadConfig(): DocentConfig {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return { ...DEFAULT_CONFIG, ...parsed }
    }
  } catch {
    // corrupt data — use defaults
  }
  return { ...DEFAULT_CONFIG }
}

/**
 * Load config with the API key resolved from OS keychain on Tauri.
 * Falls back to loadConfig() on web.
 */
export async function loadConfigWithKey(): Promise<DocentConfig> {
  const config = loadConfig()
  if (tauriInvoke) {
    try {
      config.apiKey = (await tauriInvoke('get_api_key')) as string
    } catch {
      logger.warn('[Docent] Failed to read API key from keychain')
    }
  }
  return config
}

/**
 * Save docent config to localStorage.
 * On Tauri, the API key is stored in the OS keychain instead of localStorage
 * — but only if the keychain write succeeds. If the keychain is unavailable
 * (e.g. Android has no secure storage backend wired up yet), the full config
 * including the apiKey is stored in localStorage as a plaintext fallback so
 * the user doesn't lose their key on app restart.
 *
 * @param persistApiKey - When true (e.g. from the settings form), the apiKey
 *   value is written to the keychain even if empty (clearing the stored key).
 *   When false (default), the keychain is only updated if apiKey is non-empty,
 *   preventing programmatic saves (model auto-persist, etc.) from erasing it.
 */
export function saveConfig(config: DocentConfig, persistApiKey = false): void {
  const writeLocal = (cfg: DocentConfig) => {
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg))
    } catch {
      // localStorage full or unavailable
    }
  }

  if (!tauriInvoke) {
    // Web — everything including apiKey lives in localStorage
    writeLocal(config)
    return
  }

  // Tauri — try the OS keychain first. Only strip apiKey from the
  // localStorage blob once the keychain write has actually succeeded.
  if (persistApiKey || config.apiKey) {
    tauriInvoke('set_api_key', { key: config.apiKey })
      .then(() => {
        // Keychain owns the key — localStorage blob omits it
        writeLocal({ ...config, apiKey: '' })
      })
      .catch(() => {
        // Keychain unavailable (Android stub, or a real failure) — keep
        // the full config including apiKey in localStorage as a fallback.
        logger.warn('[Docent] Keychain unavailable, storing apiKey in localStorage')
        writeLocal(config)
      })
  } else {
    // No apiKey to persist — plain save of everything else
    writeLocal({ ...config, apiKey: '' })
  }
}

/**
 * Get the default config (for display in settings).
 */
export function getDefaultConfig(): DocentConfig {
  return { ...DEFAULT_CONFIG }
}

/** Whether the app is running in Tauri desktop mode. */
export { IS_TAURI }

/**
 * A single dataset summary returned by the `search_catalog` tool. Short
 * enough that 10 of them fit comfortably within any LLM context window.
 */
export interface CatalogSearchResult {
  id: string
  title: string
  categories: string[]
  description: string
  isTour?: boolean
  timeRange?: string
}

/** Maximum results `search_catalog` will return in a single call. */
const SEARCH_CATALOG_MAX_LIMIT = 10
/** Default limit if the LLM doesn't specify one. */
const SEARCH_CATALOG_DEFAULT_LIMIT = 5
/** Max description length included in each result (characters). */
const SEARCH_CATALOG_DESC_LEN = 220
/** Maximum tool-call rounds per LLM attempt — defensive cap against infinite loops. */
const MAX_TOOL_CALL_ROUNDS = 5

/**
 * Execute a `search_catalog` tool call locally. Runs the same keyword
 * scoring as `docentEngine.searchDatasets` and shapes the result into
 * compact summaries the LLM can use to recommend datasets.
 *
 * Pure function (no I/O) — results depend only on the in-memory catalog.
 */
export function executeSearchCatalog(
  args: Record<string, unknown>,
  datasets: Dataset[],
): CatalogSearchResult[] {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return []

  const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? args.limit
    : SEARCH_CATALOG_DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(SEARCH_CATALOG_MAX_LIMIT, Math.floor(rawLimit)))

  const results = searchDatasets(datasets, query, limit)
  return results.map(({ dataset: d }) => {
    const desc = d.enriched?.description ?? d.abstractTxt ?? ''
    const shortDesc = desc.length > SEARCH_CATALOG_DESC_LEN
      ? desc.slice(0, SEARCH_CATALOG_DESC_LEN).trim() + '…'
      : desc
    const result: CatalogSearchResult = {
      id: d.id,
      title: d.title,
      categories: Object.keys(d.enriched?.categories ?? {}),
      description: shortDesc,
    }
    if (d.format === 'tour/json') result.isTour = true
    if (d.startTime && d.endTime) {
      result.timeRange = `${d.startTime} to ${d.endTime}`
    }
    return result
  })
}

// ---------------------------------------------------------------------------
// Phase 1c — backend discovery tools (search_datasets + list_featured_datasets)
//
// Both call into the node catalog backend (`/api/v1/search?q=...` and
// `/api/v1/featured`) and shape the response into a payload the LLM can
// consume on the next round. Failures soft-degrade to an empty result —
// the legacy `search_catalog` tool stays in the tool list as a fallback,
// and the local engine fallback handles full LLM unavailability.
// ---------------------------------------------------------------------------

/** Hit shape forwarded back to the LLM after a search_datasets tool call. */
export interface SearchDatasetsHit {
  id: string
  title: string
  abstract_snippet: string
  categories: string[]
  peer_id: string
  score: number
}

/** Hit shape forwarded back to the LLM after a list_featured_datasets tool call. */
export interface FeaturedDatasetHit {
  id: string
  title: string
  abstract_snippet: string
  thumbnail_url: string | null
  categories: string[]
  position: number
}

/**
 * Default + max forwarded to `/api/v1/search` from the docent tool.
 * The MAX matches the route's server-side ceiling (50). The DEFAULT
 * is intentionally lower than the route's URL default (10): the
 * docent's LLM consumer prefers a tighter result set so the JSON
 * blob fed back into the model stays small. The tool definition
 * also advertises 5 to the LLM, so this is the value the model
 * gets when it omits `limit` from a tool call. Tests:
 * `getSearchDatasetsTool.accepts an optional limit parameter`.
 */
const SEARCH_DATASETS_DEFAULT_LIMIT = 5
const SEARCH_DATASETS_MAX_LIMIT = 50
/** Defaults match the route layer (`functions/api/v1/featured.ts`). */
const LIST_FEATURED_DEFAULT_LIMIT = 6
const LIST_FEATURED_MAX_LIMIT = 24

/**
 * Catalog backend base URL. Always relative — the catalog
 * endpoints live at the app origin (Cloudflare Pages Functions),
 * NOT at the LLM provider's URL. We deliberately do NOT route
 * through `config.apiUrl` because that's the chat-completions
 * endpoint and frequently points at OpenAI / Ollama / LM Studio
 * (`https://api.openai.com/v1`, `http://localhost:11434/v1`, …);
 * appending `/v1/search` to those would yield `…/v1/v1/search`,
 * 404 on every call, and silently break the docent's discovery
 * tools for anyone not using the bundled Cloudflare proxy.
 *
 * In Tauri contexts where the app runs from a `tauri://localhost/`
 * origin with no Pages backend, `fetch('/api/v1/search')` resolves
 * relative to that origin and 404s; `executeSearchDatasets` /
 * `executeListFeaturedDatasets` catch the error and return
 * `{ datasets: [] }`, falling through to the legacy in-process
 * `search_catalog` tool — same effective behaviour as pre-1c.
 */
const CATALOG_API_BASE = '/api'

/**
 * Execute a `search_datasets` tool call against the node catalog
 * backend. Returns the result shape the LLM expects to see in a
 * `tool` message reply. On error / unreachable / degraded, returns
 * an empty `{ datasets: [] }` so the LLM can move on (or call the
 * legacy `search_catalog` fallback).
 */
export async function executeSearchDatasets(
  args: Record<string, unknown>,
  config: DocentConfig,
): Promise<{ datasets: SearchDatasetsHit[] }> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return { datasets: [] }
  if (!config.apiUrl) return { datasets: [] }

  const limitArg = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : SEARCH_DATASETS_DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(SEARCH_DATASETS_MAX_LIMIT, Math.floor(limitArg)))

  const url = new URL(`${CATALOG_API_BASE}/v1/search`, window.location.origin)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))

  try {
    const res = await fetch(url.toString(), { method: 'GET' })
    if (!res.ok) {
      logger.warn(`[Docent] search_datasets returned ${res.status}`)
      return { datasets: [] }
    }
    const body = (await res.json()) as { datasets?: SearchDatasetsHit[]; degraded?: string }
    if (body.degraded) {
      logger.info(`[Docent] search_datasets degraded: ${body.degraded}`)
    }
    return { datasets: Array.isArray(body.datasets) ? body.datasets : [] }
  } catch (err) {
    logger.warn('[Docent] search_datasets fetch failed:', err)
    return { datasets: [] }
  }
}

/**
 * Execute a `list_featured_datasets` tool call. Same soft-degrade
 * semantics as `executeSearchDatasets`.
 */
export async function executeListFeaturedDatasets(
  args: Record<string, unknown>,
  config: DocentConfig,
): Promise<{ datasets: FeaturedDatasetHit[] }> {
  if (!config.apiUrl) return { datasets: [] }

  const limitArg = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : LIST_FEATURED_DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(LIST_FEATURED_MAX_LIMIT, Math.floor(limitArg)))

  const url = new URL(`${CATALOG_API_BASE}/v1/featured`, window.location.origin)
  url.searchParams.set('limit', String(limit))

  try {
    const res = await fetch(url.toString(), { method: 'GET' })
    if (!res.ok) {
      logger.warn(`[Docent] list_featured_datasets returned ${res.status}`)
      return { datasets: [] }
    }
    const body = (await res.json()) as { datasets?: FeaturedDatasetHit[] }
    return { datasets: Array.isArray(body.datasets) ? body.datasets : [] }
  } catch (err) {
    logger.warn('[Docent] list_featured_datasets fetch failed:', err)
    return { datasets: [] }
  }
}

/**
 * Test if the configured LLM is reachable and the model is available.
 */
export async function testConnection(config: DocentConfig): Promise<AvailabilityResult> {
  return checkAvailability(config)
}

/**
 * Process a user message and yield streaming response chunks.
 *
 * Hybrid approach: runs local engine instantly for immediate actions,
 * then streams LLM text in parallel. Falls back to local-only if LLM is unavailable.
 */

/** A globe-control action extracted from inline markers in LLM text. */
export type ExtractedGlobeAction =
  | { type: 'fly-to'; lat: number; lon: number; altitude?: number }
  | { type: 'set-time'; isoDate: string }
  | { type: 'fit-bounds'; bounds: [number, number, number, number]; label?: string }
  | { type: 'add-marker'; lat: number; lng: number; label?: string }
  | { type: 'toggle-labels'; visible: boolean }
  | { type: 'highlight-region'; geojson: GeoJSON.GeoJSON; label: string; bounds: [number, number, number, number] }

/**
 * Try to resolve the contents of a `<<LOAD:...>>` marker to a real
 * dataset. The LLM is supposed to put an `id` in there, but in
 * practice it often puts a title instead — sometimes verbatim from
 * a tool result, sometimes a slightly-massaged version
 * ("Arctic Sea Ice Extent" vs the catalog's
 * "Sea Ice Extent (Arctic 1979-2020)"). The chip pipeline punishes
 * any miss by stripping the marker entirely, so we resolve as
 * generously as we can without crossing into "load the wrong
 * dataset" territory.
 *
 * Resolution order:
 *   1. Exact id (post-`trim`).
 *   2. Title exact / startsWith bidirectional — original behaviour.
 *   3. Token-overlap fallback: split both into content words, drop
 *      stop words and stems shorter than 3 chars, count shared
 *      tokens. Resolve if the best dataset's overlap is unambiguous
 *      AND covers ≥ 60% of the marker's content words AND has
 *      ≥ 3 shared content words. The "unambiguous" gate forbids
 *      a tie at the top — better a stripped chip than the wrong
 *      dataset loaded.
 */
function resolveMarkerToDataset(
  rawId: string,
  datasetIdSet: Set<string>,
  datasets: Dataset[],
): Dataset | string | null {
  const id = rawId.trim()
  if (datasetIdSet.has(id)) return id
  if (id.length === 0) return null

  const idLower = id.toLowerCase()

  // Existing exact / startsWith bidirectional fallback.
  const byTitle = datasets.find(d => {
    const tLower = d.title.toLowerCase()
    return tLower === idLower || tLower.startsWith(idLower) || idLower.startsWith(tLower)
  })
  if (byTitle) return byTitle

  // Token-overlap fallback.
  const idTokens = tokeniseTitle(idLower)
  if (idTokens.size < 2) return null

  let best: { dataset: Dataset; overlap: number } | null = null
  let bestIsAmbiguous = false
  for (const d of datasets) {
    const titleTokens = tokeniseTitle(d.title.toLowerCase())
    if (titleTokens.size === 0) continue
    let overlap = 0
    for (const t of idTokens) if (titleTokens.has(t)) overlap++
    if (overlap === 0) continue
    if (best === null || overlap > best.overlap) {
      best = { dataset: d, overlap }
      bestIsAmbiguous = false
    } else if (overlap === best.overlap && d.id !== best.dataset.id) {
      bestIsAmbiguous = true
    }
  }

  if (!best || bestIsAmbiguous) return null
  if (best.overlap < 3) return null
  if (best.overlap / idTokens.size < 0.6) return null

  return best.dataset
}

/**
 * Stop words for the title-overlap matcher. Domain-generic words
 * ("data", "dataset", "global") show up in many titles and must not
 * drive a match by themselves.
 */
const TITLE_TOKEN_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'over', 'this', 'that', 'are',
  'data', 'datasets', 'dataset', 'global', 'world', 'earth',
])

function tokeniseTitle(s: string): Set<string> {
  const out = new Set<string>()
  for (const raw of s.split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue
    if (TITLE_TOKEN_STOP_WORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

/**
 * Validate dataset IDs found in LLM text against the catalog.
 * Also extracts <<FLY:...>> and <<TIME:...>> inline markers
 * (and bare `fly_to:` / `set_time:` fallback patterns).
 * Strips invalid <<LOAD:ID>> markers and bare INTERNAL_... IDs,
 * returning the cleaned text and the sets of valid/invalid IDs.
 * Logs warnings for unknown region markers.
 */
export function validateAndCleanText(
  text: string,
  datasets: Dataset[],
): { cleanedText: string; validIds: Set<string>; invalidIds: Set<string>; globeActions: ExtractedGlobeAction[] } {
  const validIds = new Set<string>()
  const invalidIds = new Set<string>()
  const globeActions: ExtractedGlobeAction[] = []
  const datasetIdSet = new Set(datasets.map(d => d.id))
  // When the title-overlap fallback rescues a marker, remember the
  // mapping so the strip step downstream can rewrite the marker to
  // the canonical id (rather than leaving the LLM's title-shaped
  // payload in there, which would break the chat UI's [[LOAD:...]]
  // round-trip when history is replayed).
  const markerRewrites = new Map<string, string>()

  // Collect all referenced IDs for validation
  for (const match of text.matchAll(/<?<LOAD:([^>]+)>>?/g)) {
    const id = match[1].trim()
    const resolved = resolveMarkerToDataset(id, datasetIdSet, datasets)
    if (typeof resolved === 'string') {
      validIds.add(resolved)
    } else if (resolved) {
      // Title or token-overlap match.
      validIds.add(resolved.id)
      if (id !== resolved.id) markerRewrites.set(id, resolved.id)
    } else {
      invalidIds.add(id)
    }
  }
  for (const match of text.matchAll(/\bINTERNAL_[A-Z0-9_]+\b/g)) {
    const id = match[0]
    // Skip IDs already captured via markers
    if (validIds.has(id) || invalidIds.has(id)) continue
    if (datasetIdSet.has(id)) {
      validIds.add(id)
    } else {
      invalidIds.add(id)
    }
  }

  // Fallback: detect dataset titles that appear on their own line without a marker.
  // Small LLMs often write the title on its own line instead of using <<LOAD:...>>.
  // Only match titles on their own line (not embedded in sentences) to avoid
  // false positives when the LLM merely discusses a dataset in prose.
  const alreadyReferencedIds = new Set([...validIds, ...invalidIds])
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.length < 10) continue
    for (const d of datasets) {
      if (alreadyReferencedIds.has(d.id)) continue
      if (d.title.length < 10) continue
      // Title must be the entire line (possibly with minor surrounding text like "- " or ":")
      const stripped = trimmed.replace(/^[-•*]\s*/, '').replace(/:?\s*$/, '')
      if (stripped.toLowerCase() === d.title.toLowerCase()) {
        validIds.add(d.id)
        alreadyReferencedIds.add(d.id)
      }
    }
  }

  // Extract <<FLY:lat,lon[,alt]>> markers
  for (const match of text.matchAll(/<?<FLY:\s*([-\d.]+)\s*,\s*([-\d.]+)(?:\s*,\s*([-\d.]+))?\s*>>?\n?/g)) {
    const lat = parseFloat(match[1])
    const lon = parseFloat(match[2])
    const alt = match[3] ? parseFloat(match[3]) : undefined
    if (!isNaN(lat) && !isNaN(lon)) {
      globeActions.push({ type: 'fly-to', lat, lon, altitude: alt })
    }
  }

  // Extract <<TIME:date>> markers
  for (const match of text.matchAll(/<?<TIME:\s*([^>]+?)\s*>>?\n?/g)) {
    const isoDate = match[1].trim()
    if (isoDate && !isNaN(new Date(isoDate).getTime())) {
      globeActions.push({ type: 'set-time', isoDate })
    }
  }

  // Extract <<BOUNDS:west,south,east,north[,label]>> markers
  for (const match of text.matchAll(/<?<BOUNDS:\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)(?:\s*,\s*([^>]*?))?\s*>>?\n?/g)) {
    const west = parseFloat(match[1])
    const south = parseFloat(match[2])
    const east = parseFloat(match[3])
    const north = parseFloat(match[4])
    const label = match[5]?.trim() || undefined
    if (!isNaN(west) && !isNaN(south) && !isNaN(east) && !isNaN(north)) {
      globeActions.push({ type: 'fit-bounds', bounds: [west, south, east, north], label })
    }
  }

  // Extract <<MARKER:lat,lng,label>> markers
  for (const match of text.matchAll(/<?<MARKER:\s*([-\d.]+)\s*,\s*([-\d.]+)(?:\s*,\s*([^>]*?))?\s*>>?\n?/g)) {
    const lat = parseFloat(match[1])
    const lng = parseFloat(match[2])
    const label = match[3]?.trim() || undefined
    if (!isNaN(lat) && !isNaN(lng)) {
      globeActions.push({ type: 'add-marker', lat, lng, label })
    }
  }

  // Extract <<LABELS:on|off>> markers
  for (const match of text.matchAll(/<?<LABELS:\s*(on|off)\s*>>?\n?/gi)) {
    globeActions.push({ type: 'toggle-labels', visible: match[1].toLowerCase() === 'on' })
  }

  // Extract <<REGION:name>> markers — resolve name to bounding box + GeoJSON
  for (const match of text.matchAll(/<?<REGION:\s*([^>]+?)\s*>>?\n?/g)) {
    const regionName = match[1].trim()
    const region = resolveRegion(regionName)
    if (region) {
      globeActions.push({
        type: 'highlight-region',
        geojson: boundsToGeoJSON(region.bounds, region.name),
        label: region.name,
        bounds: region.bounds,
      })
    } else {
      logger.warn('[Docent] Unknown region in <<REGION:...>> marker:', regionName)
    }
  }

  // Fallback: parse bare `fly_to: lat, lon, alt` patterns (LLMs that ignore marker instructions)
  for (const match of text.matchAll(/\bfly_to\s*[:(\s]\s*([-\d.]+)\s*,\s*([-\d.]+)(?:\s*,\s*([-\d.]+))?\s*\)?/gi)) {
    const lat = parseFloat(match[1])
    const lon = parseFloat(match[2])
    const alt = match[3] ? parseFloat(match[3]) : undefined
    if (!isNaN(lat) && !isNaN(lon)) {
      globeActions.push({ type: 'fly-to', lat, lon, altitude: alt })
    }
  }

  // Fallback: parse bare `set_time: date` patterns
  for (const match of text.matchAll(/\bset_time\s*[:(\s]\s*"?(\d{4}-\d{2}-\d{2}(?:T[^\s")\n]*)?)"?\s*\)?/gi)) {
    const isoDate = match[1].trim()
    if (isoDate && !isNaN(new Date(isoDate).getTime())) {
      globeActions.push({ type: 'set-time', isoDate })
    }
  }

  // Strip invalid <<LOAD:ID>> markers, and rewrite resolved-via-
  // fallback markers (where the LLM put a title in the marker
  // contents) so the marker carries the canonical id. The chat UI's
  // [[LOAD:...]]-roundtrip stores the marker in conversation
  // history; without rewriting, a follow-up turn would see the
  // title-shaped payload again and have to re-resolve it.
  //
  // The regex matches the same tolerant shape as the collect loop
  // above (`<?<LOAD:...>>?`) — small LLMs occasionally emit
  // single-bracket variants `<LOAD:ID>` or `<<LOAD:ID>` and we
  // collected those into `invalidIds`. Use the matched markers in
  // the rewrite step too, otherwise malformed shapes would be
  // classified as invalid yet stay visible in the prose.
  let cleanedText = text.replace(/<?<LOAD:([^>]+)>>?(\n?)/g, (match, id, trailing) => {
    const trimmedId = id.trim()
    if (invalidIds.has(trimmedId)) return ''
    const canonicalId = markerRewrites.get(trimmedId)
    if (canonicalId) return `<<LOAD:${canonicalId}>>${trailing}`
    return match
  })

  // Strip bare invalid INTERNAL_... IDs from prose
  cleanedText = cleanedText.replace(/\bINTERNAL_[A-Z0-9_]+\b/g, (id) => {
    if (invalidIds.has(id)) return ''
    return id
  })

  // Strip <<FLY:...>>, <<TIME:...>>, <<BOUNDS:...>>, <<MARKER:...>>, <<LABELS:...>> markers from displayed text
  cleanedText = cleanedText.replace(/<?<FLY:[^>]+>>?\n?/g, '')
  cleanedText = cleanedText.replace(/<?<TIME:[^>]+>>?\n?/g, '')
  cleanedText = cleanedText.replace(/<?<BOUNDS:[^>]+>>?\n?/g, '')
  cleanedText = cleanedText.replace(/<?<MARKER:[^>]+>>?\n?/g, '')
  cleanedText = cleanedText.replace(/<?<LABELS:[^>]+>>?\n?/g, '')
  cleanedText = cleanedText.replace(/<?<REGION:[^>]+>>?\n?/g, '')

  // Strip bare fly_to/set_time text patterns (entire line)
  cleanedText = cleanedText.replace(/^.*\bfly_to\s*[:(\s]\s*[-\d.,\s]+\)?\s*$/gim, '')
  cleanedText = cleanedText.replace(/^.*\bset_time\s*[:(\s]\s*"?[^")\n]*"?\s*\)?\s*$/gim, '')

  // Clean up excess blank lines left by stripped markers
  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n')

  return { cleanedText, validIds, invalidIds, globeActions }
}

/**
 * Yield action chunks for every valid dataset ID found in the text.
 * Accepts pre-computed validIds from validateAndCleanText() to avoid
 * duplicate work.
 */
async function* yieldActionsForValidIds(
  validIds: Set<string>,
  datasets: Dataset[],
  yieldedIds: Set<string>,
): AsyncGenerator<DocentStreamChunk> {
  for (const idStr of validIds) {
    const dataset = datasets.find(d => d.id === idStr)
    if (dataset && !yieldedIds.has(dataset.id)) {
      yieldedIds.add(dataset.id)
      yield {
        type: 'action',
        action: {
          type: 'load-dataset',
          datasetId: dataset.id,
          datasetTitle: dataset.title,
        },
      }
    }
  }
}

/**
 * Validate accumulated LLM text once, yield action chunks for valid IDs,
 * emit globe-control actions from inline markers, and emit a rewrite
 * chunk if any hallucinated IDs or markers were stripped.
 */
async function* emitValidatedActions(
  accumulatedText: string,
  datasets: Dataset[],
  yieldedIds: Set<string>,
): AsyncGenerator<DocentStreamChunk> {
  const { cleanedText, validIds, invalidIds, globeActions } = validateAndCleanText(accumulatedText, datasets)
  // Rewrite whenever the text was modified — covers stripped markers, hallucinated IDs,
  // and unresolved <<REGION:...>> names that still need to be removed from display.
  const needsRewrite = cleanedText !== accumulatedText
  if (invalidIds.size > 0) {
    logger.warn('[Docent] Stripped hallucinated dataset IDs:', Array.from(invalidIds))
  }
  if (needsRewrite) {
    yield { type: 'rewrite', text: cleanedText }
  }
  yield* yieldActionsForValidIds(validIds, datasets, yieldedIds)

  // Yield globe-control actions extracted from inline markers
  for (const ga of globeActions) {
    if (ga.type === 'fly-to') {
      yield { type: 'action', action: { type: 'fly-to', lat: ga.lat, lon: ga.lon, altitude: ga.altitude } }
    } else if (ga.type === 'set-time') {
      yield { type: 'action', action: { type: 'set-time', isoDate: ga.isoDate } }
    } else if (ga.type === 'fit-bounds') {
      yield { type: 'action', action: { type: 'fit-bounds', bounds: ga.bounds, label: ga.label } }
    } else if (ga.type === 'add-marker') {
      yield { type: 'action', action: { type: 'add-marker', lat: ga.lat, lng: ga.lng, label: ga.label } }
    } else if (ga.type === 'toggle-labels') {
      yield { type: 'action', action: { type: 'toggle-labels', visible: ga.visible } }
    } else if (ga.type === 'highlight-region') {
      // Highlight the region and navigate to it
      yield { type: 'action', action: { type: 'highlight-region', geojson: ga.geojson, label: ga.label } }
      yield { type: 'action', action: { type: 'fit-bounds', bounds: ga.bounds, label: ga.label } }
    }
  }
}

export async function* processMessage(
  input: string,
  history: ChatMessage[],
  datasets: Dataset[],
  currentDataset: Dataset | null,
  config?: DocentConfig,
  screenshotDataUrl?: string | null,
  viewContext?: string,
  mapViewContext?: MapViewContext | null,
): AsyncGenerator<DocentStreamChunk> {
  const cfg = config ?? await loadConfigWithKey()

  // --- Phase 3/4: Run local engine instantly for immediate results ---
  const intent = parseIntent(input)
  // Pre-compute search results once to avoid duplicate scoring work
  const searchResults = intent.type === 'search' ? searchDatasets(datasets, intent.query) : undefined
  const localResponse = generateResponse(intent, datasets, currentDataset, searchResults)
  const yieldedIds = new Set<string>()

  // When LLM is enabled, let it be the sole source of dataset recommendations.
  // Only use local engine actions as a fallback when LLM is unavailable.
  const llmEnabled = cfg.enabled && !!cfg.apiUrl

  if (!llmEnabled) {
    // Phase 2: Check for auto-load on search intents
    if (intent.type === 'search' && searchResults) {
      const results = searchResults
      const autoResult = evaluateAutoLoad(results)
      if (autoResult) {
        const action = {
          type: 'load-dataset' as const,
          datasetId: autoResult.autoLoad.id,
          datasetTitle: autoResult.autoLoad.title,
        }
        const alternatives = autoResult.alternatives.map(d => ({
          type: 'load-dataset' as const,
          datasetId: d.id,
          datasetTitle: d.title,
        }))
        yieldedIds.add(action.datasetId)
        for (const alt of alternatives) yieldedIds.add(alt.datasetId)
        yield { type: 'auto-load', action, alternatives }
      }
    }

    // Yield local actions immediately (skip any already yielded by auto-load)
    if (localResponse.actions) {
      for (const action of localResponse.actions) {
        if (action.type === 'load-dataset' && !yieldedIds.has(action.datasetId)) {
          yieldedIds.add(action.datasetId)
          yield { type: 'action', action }
        }
      }
    }
  }

  // --- Try LLM for richer text ---
  logger.info('[Docent] Config state:', { enabled: cfg.enabled, apiUrl: cfg.apiUrl, model: cfg.model })
  if (cfg.enabled && cfg.apiUrl) {
    const turnIndex = Math.floor(history.length / 2)
    const visionActive = cfg.visionEnabled && !!screenshotDataUrl
    const cache = getLegendCache()

    // Always pass legend text description and current time.
    // In vision mode these go into the vision prefix text (system prompts are often
    // deprioritised by small vision models); in non-vision mode into the system prompt.
    const legendDescription = cache.legendDescription ?? null
    const currentTime = readCurrentTime()

    // Best-effort Q&A knowledge retrieval (non-blocking if not yet loaded)
    await ensureQALoaded().catch(() => {})
    const qaContext = getRelevantQA(input, currentDataset, datasets, turnIndex)

    // Phase 3: the system prompt no longer includes the full catalog.
    // The LLM discovers datasets via the `search_catalog` tool instead.
    // `turnIndex` is still computed above for `getRelevantQA` (which tunes
    // its output based on conversation depth), but is NOT passed to the
    // prompt builder anymore.
    const systemPrompt = buildSystemPrompt(
      datasets, currentDataset, cfg.readingLevel, visionActive,
      !visionActive ? legendDescription : null,
      !visionActive ? currentTime : null,
      qaContext || null,
      mapViewContext,
    )

    if (cfg.debugPrompt) {
      logger.info('[Docent] Full system prompt:\n' + systemPrompt)
    }

    // Build the user message — multimodal if vision is active
    // Inject dataset context directly into the user text so the small
    // vision model can't miss it (system prompt context often gets lost)
    let visionPrefix = ''
    if (visionActive) {
      const ctxParts: string[] = []
      if (currentDataset) {
        ctxParts.push(`DATASET: "${currentDataset.title}"`)
        const desc = currentDataset.enriched?.description ?? currentDataset.abstractTxt
        if (desc) {
          const short = desc.length > 200 ? desc.substring(0, 200) + '…' : desc
          ctxParts.push(`ABOUT: ${short}`)
        }
      }
      if (viewContext) ctxParts.push(viewContext)
      if (currentTime) ctxParts.push(`TIME: ${currentTime}`)
      if (legendDescription) ctxParts.push(`LEGEND: ${legendDescription}`)
      if (ctxParts.length > 0) {
        visionPrefix = `[This image is a scientific data visualization on a 3D globe, NOT a photograph. ${ctxParts.join('. ')}]\n`
      }
    }
    const visionText = visionPrefix + input

    // In vision mode, attach globe screenshot.
    // Legend context is passed as text in visionPrefix above (CF proxy only supports one image).
    const visionContentParts: LLMContentPart[] = [
      { type: 'image_url', image_url: { url: screenshotDataUrl! } },
      { type: 'text', text: visionText },
    ]

    // Prepend globe state directly into the user message so small models
    // can't miss it — system messages are often deprioritised.
    const statePrefix = currentDataset
      ? `[GLOBE STATE: "${currentDataset.title}" is currently loaded on the globe.${currentTime ? ` Showing: ${currentTime}.` : ''}]\n`
      : '[GLOBE STATE: No dataset is loaded. The globe shows the default Earth view.]\n'

    // Phase 3 discovery: pre-search the catalog locally and inject the top
    // results into the user message as [RELEVANT DATASETS] context. This is
    // the primary discovery path — it works on every model regardless of
    // function-calling support. The system prompt tells the LLM to prefer
    // these pre-searched results and only call `search_catalog` as a
    // fallback for follow-up queries on a different topic.
    //
    // Strip punctuation and common question/stop words so the scoring in
    // searchDatasets isn't diluted. "What datasets show sea level rise?" →
    // search query "sea level rise", which scores well against real titles.
    const PRE_SEARCH_STOP_WORDS = new Set([
      'what', 'which', 'show', 'me', 'about', 'tell', 'the', 'a', 'an',
      'is', 'are', 'do', 'does', 'did', 'can', 'how', 'where', 'when',
      'why', 'i', 'my', 'your', 'you', 'we', 'us', 'it', 'its', 'of',
      'in', 'on', 'for', 'to', 'and', 'or', 'with', 'this', 'that',
      'some', 'any', 'have', 'has', 'there', 'here', 'please', 'thanks',
      'datasets', 'dataset', 'data', 'find', 'search', 'look', 'give',
      'want', 'like', 'need', 'related', 'something', 'anything',
    ])
    const preSearchQuery = input
      .replace(/[?!.,;:'"()[\]{}]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1 && !PRE_SEARCH_STOP_WORDS.has(w.toLowerCase()))
      .join(' ')
    // Only pre-search for intents that actually need dataset discovery.
    // Greetings, help, explain-current, and what-is-this don't benefit
    // from injecting a [RELEVANT DATASETS] block and would just add
    // noise tokens + risk steering the model toward irrelevant recs.
    const needsPreSearch = intent.type === 'search' || intent.type === 'category' || intent.type === 'related'
    const preSearchCatalogResults = needsPreSearch
      ? executeSearchCatalog({ query: preSearchQuery || input, limit: 5 }, datasets)
      : []

    let preSearchContext = ''
    if (preSearchCatalogResults.length > 0) {
      const lines = preSearchCatalogResults.map(r =>
        `- ${r.id} | ${r.title}${r.isTour ? ' [Tour]' : ''} | ${r.categories.join(', ')} | ${r.description}`
      )
      preSearchContext = `[RELEVANT DATASETS for your query:\n${lines.join('\n')}\nRefer to these by exact title and include <<LOAD:ID>> markers.]\n`
    }

    const userMessage: LLMMessage = visionActive
      ? { role: 'user', content: [
          { type: 'image_url' as const, image_url: { url: screenshotDataUrl! } },
          { type: 'text' as const, text: statePrefix + preSearchContext + visionText },
        ] as LLMContentPart[] }
      : { role: 'user', content: statePrefix + preSearchContext + input }

    const llmMessages: LLMMessage[] = [
      { role: 'system' as const, content: systemPrompt },
      ...buildCompressedHistory(history),
      userMessage,
    ]
    // search_catalog runs first because it scans the in-memory legacy
    // catalog and always returns valid IDs the marker validator
    // recognises. search_datasets / list_featured_datasets are wired
    // up but listed AFTER — they hit the node catalog backend, which
    // may not be provisioned yet on a given deploy. If the LLM picks
    // the new tools first and gets an empty result, it sometimes
    // hallucinates IDs that get stripped by validateAndCleanText
    // (Load chips disappear from prose). Putting search_catalog first
    // restores the pre-1c default; once Vectorize is provisioned in
    // production, swap the order back as part of the cutover.
    const tools = [
      getSearchCatalogTool(),
      getSearchDatasetsTool(),
      getListFeaturedDatasetsTool(),
      getLoadDatasetTool(),
      getFlyToTool(),
      getSetTimeTool(),
      getFitBoundsTool(),
      getAddMarkerTool(),
      getToggleLabelsTool(),
      getHighlightRegionTool(),
    ]

    // Auto-switch to vision model when using the default CF proxy
    const normalizedUrl = cfg.apiUrl.replace(/\/+$/, '')
    const visionCfg = visionActive && normalizedUrl === '/api'
      ? { ...cfg, model: CF_VISION_MODEL }
      : cfg

    // Phase 4: check if Apple Intelligence on-device model is available.
    // When it is, we route through streamChatLocal (Tauri plugin) instead of
    // streamChat (HTTP). The provider selection is transparent to the rest of
    // processMessage — both yield the same StreamChunk union.
    const useAppleIntelligence = cfg.model === 'apple-intelligence' && await isAppleIntelligenceAvailable()

    const llmContext: LLMContextSnapshot = {
      systemPrompt,
      model: useAppleIntelligence ? 'apple-intelligence' : visionCfg.model,
      readingLevel: cfg.readingLevel as ReadingLevel,
      visionEnabled: visionActive,
      fallback: false,
      historyCompressed: history.length > 6,
    }

    // Retry once on transient failures (empty stream, network error)
    const MAX_LLM_ATTEMPTS = 2
    for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
      let llmProducedText = false
      let accumulatedText = ''
      // Phase 3: each attempt maintains its own conversation state that may
      // grow across multiple streamChat rounds as the LLM calls search_catalog
      // and we feed the results back.
      const conversationMessages: LLMMessage[] = [...llmMessages]
      let attemptErrored = false
      let round = 0
      // Track all datasets returned by discovery tools across rounds in
      // this attempt so we can auto-inject Load buttons for any the LLM
      // mentions by title but forgets to tag with <<LOAD:...>> markers.
      // Seed with pre-search results so the auto-inject safety net can
      // match dataset titles in the LLM's prose even when the model
      // doesn't call any discovery tool. Any tool-call results are
      // appended later — both legacy `search_catalog` results and Phase
      // 1c `search_datasets` / `list_featured_datasets` results land
      // here, normalised to the same minimal shape (id + title).
      const searchResultsThisAttempt: CatalogSearchResult[] = [...preSearchCatalogResults]

      try {
        toolLoop: while (round < MAX_TOOL_CALL_ROUNDS) {
          round++

          // search_catalog calls that need a tool result message in reply.
          // Fire-and-forget tool calls (load_dataset, fly_to, etc.) are still
          // emitted as action chunks immediately and do NOT enter this queue.
          const pendingSearchCalls: LLMToolCall[] = []
          // Text produced in this round only — used for the assistant echo
          // when appending to conversationMessages for the next round.
          let roundText = ''

          logger.info(`[Docent] LLM request (attempt ${attempt}/${MAX_LLM_ATTEMPTS}, round ${round}/${MAX_TOOL_CALL_ROUNDS}):`, {
            provider: useAppleIntelligence ? 'apple-intelligence' : 'openai-compat',
            url: useAppleIntelligence ? '(on-device)' : `${visionCfg.apiUrl.replace(/\/+$/, '')}/chat/completions`,
            model: useAppleIntelligence ? 'apple-intelligence' : visionCfg.model,
            messageCount: conversationMessages.length,
            toolCount: tools.length,
            vision: visionActive,
          })

          // Phase 4: route to on-device provider when selected, otherwise HTTP
          const stream = useAppleIntelligence
            ? streamChatLocal(conversationMessages, tools, visionActive ? { timeoutMs: VISION_TIMEOUT_MS } : undefined)
            : streamChat(conversationMessages, tools, visionCfg, visionActive ? { timeoutMs: VISION_TIMEOUT_MS } : undefined)

          for await (const chunk of stream) {
            switch (chunk.type) {
              case 'delta':
                llmProducedText = true
                accumulatedText += chunk.text
                roundText += chunk.text
                yield { type: 'delta', text: chunk.text }
                break

              case 'tool_call':
                if (
                  chunk.call.name === 'search_catalog' ||
                  chunk.call.name === 'search_datasets' ||
                  chunk.call.name === 'list_featured_datasets'
                ) {
                  // All three discovery tools need a tool-result message
                  // sent back to the LLM — queue for the end-of-round
                  // dispatch below.
                  pendingSearchCalls.push(chunk.call)
                } else if (chunk.call.name === 'load_dataset') {
                  const args = chunk.call.arguments as { dataset_id?: string; dataset_title?: string }
                  let resolvedId: string | undefined
                  let resolvedTitle: string | undefined

                  if (args.dataset_id) {
                    const idStr = String(args.dataset_id)
                    const matchById = datasets.find(d => d.id === idStr)
                    if (matchById) {
                      resolvedId = idStr
                      resolvedTitle = matchById.title
                    } else {
                      logger.warn('[Docent] Ignoring tool_call with unknown dataset_id:', idStr)
                    }
                  }

                  // Fallback: resolve by title if ID is missing or invalid
                  if (!resolvedId && args.dataset_title) {
                    const titleLower = String(args.dataset_title).trim().toLowerCase()
                    const match = datasets.find(d => d.title.trim().toLowerCase() === titleLower)
                    if (match) {
                      resolvedId = match.id
                      resolvedTitle = match.title
                    }
                  }

                  if (resolvedId && !yieldedIds.has(resolvedId)) {
                    yieldedIds.add(resolvedId)
                    yield {
                      type: 'action',
                      action: {
                        type: 'load-dataset',
                        datasetId: resolvedId,
                        datasetTitle: resolvedTitle ?? String(args.dataset_title ?? resolvedId),
                      },
                    }
                  }
                } else if (chunk.call.name === 'fly_to') {
                  const args = chunk.call.arguments as { lat?: number; lon?: number; place?: string; altitude?: number }
                  if (typeof args.lat === 'number' && typeof args.lon === 'number') {
                    yield {
                      type: 'action',
                      action: { type: 'fly-to', lat: args.lat, lon: args.lon, altitude: args.altitude },
                    }
                  } else if (args.place) {
                    // Resolve place name to coordinates via region lookup
                    const region = resolveRegion(args.place)
                    if (region) {
                      const [west, south, east, north] = region.bounds
                      // Handle antimeridian-crossing bounds (west > east) by wrapping
                      const lon = west <= east
                        ? (west + east) / 2
                        : ((west + east + 360) / 2) % 360 - (((west + east + 360) / 2) % 360 > 180 ? 360 : 0)
                      yield {
                        type: 'action',
                        action: { type: 'fly-to', lat: (south + north) / 2, lon, altitude: args.altitude },
                      }
                    }
                  }
                } else if (chunk.call.name === 'set_time') {
                  const args = chunk.call.arguments as { date?: string }
                  if (args.date) {
                    yield {
                      type: 'action',
                      action: { type: 'set-time', isoDate: args.date },
                    }
                  }
                } else if (chunk.call.name === 'fit_bounds') {
                  const args = chunk.call.arguments as { west?: number; south?: number; east?: number; north?: number; label?: string }
                  if (typeof args.west === 'number' && typeof args.south === 'number' && typeof args.east === 'number' && typeof args.north === 'number') {
                    yield {
                      type: 'action',
                      action: { type: 'fit-bounds', bounds: [args.west, args.south, args.east, args.north], label: args.label },
                    }
                  }
                } else if (chunk.call.name === 'add_marker') {
                  const args = chunk.call.arguments as { lat?: number; lng?: number; label?: string }
                  if (typeof args.lat === 'number' && typeof args.lng === 'number') {
                    yield {
                      type: 'action',
                      action: { type: 'add-marker', lat: args.lat, lng: args.lng, label: args.label },
                    }
                  }
                } else if (chunk.call.name === 'toggle_labels') {
                  const args = chunk.call.arguments as { visible?: boolean }
                  if (typeof args.visible === 'boolean') {
                    yield {
                      type: 'action',
                      action: { type: 'toggle-labels', visible: args.visible },
                    }
                  }
                } else if (chunk.call.name === 'highlight_region') {
                  const args = chunk.call.arguments as { geojson?: GeoJSON.GeoJSON; name?: string; label?: string }
                  if (args.geojson) {
                    yield {
                      type: 'action',
                      action: { type: 'highlight-region', geojson: args.geojson, label: args.label },
                    }
                  } else if (args.name) {
                    // Resolve by name from the region lookup
                    const region = resolveRegion(args.name)
                    if (region) {
                      yield {
                        type: 'action',
                        action: { type: 'highlight-region', geojson: boundsToGeoJSON(region.bounds, region.name), label: region.name },
                      }
                      yield {
                        type: 'action',
                        action: { type: 'fit-bounds', bounds: region.bounds, label: region.name },
                      }
                    }
                  }
                }
                break

              case 'error':
                logger.warn(`[Docent] LLM error (attempt ${attempt}, round ${round}):`, chunk.message)
                attemptErrored = true
                llmProducedText = false
                break toolLoop

              case 'done':
                // Intentionally do NOT return here — let the inner for-await
                // finish its iteration so pendingSearchCalls is fully
                // populated. The end-of-round logic below decides whether to
                // loop for another streamChat call or exit.
                break
            }
          }

          // Stream finished for this round.
          if (pendingSearchCalls.length === 0) {
            // LLM didn't request any catalog searches — this round was the
            // final one, exit the tool loop.
            break
          }

          // LLM requested catalog searches. Execute them locally, append to
          // the conversation as an assistant-with-tool_calls message
          // followed by one tool-role message per call, then loop to stream
          // the LLM's follow-up response.
          conversationMessages.push({
            role: 'assistant',
            content: roundText || null,
            tool_calls: pendingSearchCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          })

          for (const call of pendingSearchCalls) {
            if (call.name === 'search_datasets') {
              const result = await executeSearchDatasets(call.arguments, cfg)
              for (const hit of result.datasets) {
                searchResultsThisAttempt.push({
                  id: hit.id,
                  title: hit.title,
                  categories: hit.categories,
                  description: hit.abstract_snippet,
                })
              }
              logger.info(
                `[Docent] search_datasets("${String(call.arguments.query ?? '')}") → ${result.datasets.length} result(s)`,
              )
              conversationMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(result),
              })
            } else if (call.name === 'list_featured_datasets') {
              const result = await executeListFeaturedDatasets(call.arguments, cfg)
              for (const hit of result.datasets) {
                searchResultsThisAttempt.push({
                  id: hit.id,
                  title: hit.title,
                  categories: hit.categories,
                  description: hit.abstract_snippet,
                })
              }
              logger.info(`[Docent] list_featured_datasets → ${result.datasets.length} result(s)`)
              conversationMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(result),
              })
            } else {
              // Legacy in-process search_catalog.
              const results = executeSearchCatalog(call.arguments, datasets)
              searchResultsThisAttempt.push(...results)
              logger.info(`[Docent] search_catalog("${String(call.arguments.query ?? '')}") → ${results.length} result(s)`)
              conversationMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(results),
              })
            }
          }
        }

        if (round >= MAX_TOOL_CALL_ROUNDS) {
          logger.warn(`[Docent] Hit MAX_TOOL_CALL_ROUNDS (${MAX_TOOL_CALL_ROUNDS}) without natural termination on attempt ${attempt}`)
        }

        if (!attemptErrored && llmProducedText) {
          yield* emitValidatedActions(accumulatedText, datasets, yieldedIds)

          // Safety net: if the LLM mentioned dataset titles from search_catalog
          // results in its prose but didn't emit <<LOAD:...>> markers for them,
          // auto-inject Load buttons. This catches the common failure mode where
          // the model writes "Sea Level Rise: This dataset..." without the
          // corresponding marker — the user sees the name but has no button.
          if (searchResultsThisAttempt.length > 0) {
            const lowerText = accumulatedText.toLowerCase()
            for (const sr of searchResultsThisAttempt) {
              if (yieldedIds.has(sr.id)) continue
              // Check if the dataset title appears in the prose. Use
              // bidirectional matching: the model might write a shortened
              // version of the title ("Sea Level Rise" vs catalog's "Sea
              // Level Rise: Global Sea Level Change"), or a lengthened
              // version ("Sea Level Rise 1993-2020" vs catalog's "Sea
              // Level Rise"). Also check the first segment before a colon
              // or dash separator as a common truncation point.
              const titleLower = sr.title.toLowerCase()
              const titleShort = titleLower.split(/[:\-—]/)[0].trim()
              if (
                lowerText.includes(titleLower) ||
                (titleShort.length >= 8 && lowerText.includes(titleShort))
              ) {
                yieldedIds.add(sr.id)
                logger.info(`[Docent] Auto-injecting Load button for "${sr.title}" (${sr.id}) — title found in prose but no marker emitted`)
                yield {
                  type: 'action',
                  action: {
                    type: 'load-dataset',
                    datasetId: sr.id,
                    datasetTitle: sr.title,
                  },
                }
              }
            }
          }

          yield { type: 'done', fallback: false, llmContext }
          return
        }

        if (!attemptErrored) {
          logger.warn(`[Docent] LLM stream completed but produced no text (attempt ${attempt})`)
        }
      } catch (err) {
        logger.warn(`[Docent] LLM stream failed (attempt ${attempt}):`, err)
      }

      // If this was the last attempt, fall through to local engine
      if (attempt < MAX_LLM_ATTEMPTS) {
        logger.warn('[Docent] Retrying LLM request...')
      }
    }
  }

  // Local text fallback (actions already yielded above)
  logger.warn('[Docent] Using local engine for text')
  yield { type: 'delta', text: localResponse.text }
  yield { type: 'done', fallback: true }
}
