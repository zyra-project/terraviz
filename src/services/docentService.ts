/**
 * Docent Service — orchestrates LLM-first responses with local fallback.
 *
 * Tries the configured LLM provider. If unavailable or unconfigured,
 * falls back to the local docentEngine for instant offline responses.
 */

import type { Dataset, ChatMessage, ChatAction, DocentConfig, LegendCache, MapViewContext, LLMContextSnapshot, ReadingLevel } from '../types'
import { streamChat, checkAvailability, type AvailabilityResult, type LLMMessage, type LLMContentPart, type LLMToolCall } from './llmProvider'
import { isAvailable as isAppleIntelligenceAvailable, streamChatLocal } from './appleIntelligenceProvider'
import { buildSystemPrompt, buildCompressedHistory, buildLanguageReminderMessage, getSearchCatalogTool, getSearchDatasetsTool, getListFeaturedDatasetsTool, getSearchEventsTool, getLoadDatasetTool, getLoadFrameTool, getFlyToTool, getSetTimeTool, getFitBoundsTool, getAddMarkerTool, getToggleLabelsTool, getHighlightRegionTool } from './docentContext'
import { fetchApprovedEvents, type PublicEvent } from './eventsService'
import { parseIntent, generateResponse, searchDatasets, evaluateAutoLoad } from './docentEngine'
import { clearDegraded as clearDegradedState, markDegraded as markDegradedState } from './docentDegradedState'
import { apiFetch } from './catalogSource'
import { ensureLoaded as ensureQALoaded, getRelevantQA } from './qaService'
import { resolveRegion, boundsToGeoJSON } from '../data/regions'
import { resolveFrameQuery } from '../utils/frames'
import { logger } from '../utils/logger'
import { t } from '../i18n'

// --- Constants ---
const CONFIG_STORAGE_KEY = 'sos-docent-config'

/** Max approved events injected into the `[CURRENT EVENTS]` block per turn.
 *  The approved set is small in practice; the cap bounds token cost and
 *  keeps the highest-weighted events visible. */
const CURRENT_EVENTS_INJECTION_CAP = 12

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
  // Voice defaults — auto-speak off, so existing typed-chat behaviour
  // is unchanged until a user opts in (docs/ORBIT_VOICE_PLAN.md §8).
  voiceAutoSpeak: false,
  voiceProvider: 'auto',
  voiceRate: 1,
  voiceHandsFree: 'off',
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
  /** Phase 3pg/C — image-sequence indicator. Present only on
   *  frames-source rows; the LLM uses this to decide whether
   *  `<<LOAD_FRAME:...>>` is applicable for the row. */
  frames?: { count: number; startTime?: string; period?: string }
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
    if (d.frames) {
      result.frames = {
        count: d.frames.count,
        ...(d.startTime ? { startTime: d.startTime } : {}),
        ...(d.period ? { period: d.period } : {}),
      }
    }
    return result
  })
}

/** One approved event as the `search_events` tool returns it to the LLM. */
export interface EventSearchResult {
  id: string
  title: string
  source_name: string
  occurred: string
  dataset_id: string
}

/** Default / max events `search_events` returns in one call. */
const SEARCH_EVENTS_DEFAULT_LIMIT = 5
const SEARCH_EVENTS_MAX_LIMIT = 20

/**
 * Execute a `search_events` tool call — a pure, in-memory keyword filter
 * over the approved events already fetched for the turn (no network, works
 * on any deploy). An empty query lists all approved events (capped by
 * `limit`); otherwise a case-insensitive substring match over the event's
 * title + summary. Returns the compact shape the LLM needs to surface an
 * `<<EVENT:ID>>` marker — only these ids (plus the [CURRENT EVENTS] block)
 * are valid event references.
 */
export function executeSearchEvents(
  args: Record<string, unknown>,
  events: readonly PublicEvent[],
): { events: EventSearchResult[] } {
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
  const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? args.limit
    : SEARCH_EVENTS_DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(SEARCH_EVENTS_MAX_LIMIT, Math.floor(rawLimit)))
  const matched = query
    ? events.filter(ev => `${ev.title} ${ev.summary ?? ''}`.toLowerCase().includes(query))
    : events
  return {
    events: matched.slice(0, limit).map(ev => ({
      id: ev.id,
      title: ev.title,
      source_name: ev.source.name,
      occurred: (ev.occurredStart ?? ev.source.publishedAt ?? '').slice(0, 10),
      dataset_id: ev.datasetIds[0] ?? '',
    })),
  }
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
 * In Tauri contexts the webview origin is `tauri://localhost/`
 * with no Pages Functions backend, so the URL constructed below
 * is rewritten to the production deployment by `apiFetch` (see
 * `catalogSource.ts`). If the rewrite or the cross-origin request
 * fails, `executeSearchDatasets` / `executeListFeaturedDatasets`
 * catch the error and return `{ datasets: [] }`, falling through
 * to the legacy in-process `search_catalog` tool.
 */
const CATALOG_API_BASE = '/api'

/**
 * Per-session LRU cache for pre-search results. Phase 1f/C —
 * follow-up to 1d/AC restoring the [RELEVANT DATASETS] block.
 *
 * The hot path: every discovery turn (intent.type === 'search' /
 * 'category' / 'related') runs `executeSearchDatasets` to ground
 * the user message before the LLM stream starts (1d/AC, line 1099
 * below). Two follow-ups within a turn exchange — "show me
 * hurricanes" then "any others?" — re-run the same canonicalised
 * query and re-burn Workers AI embed neurons.
 *
 * The cache is module-level (= per-session, since the SPA
 * re-initialises this module on every page load) with:
 *   - 16-entry LRU eviction (small enough to keep memory tiny,
 *     large enough to absorb most multi-turn discovery flows).
 *   - 5-minute TTL (expires concurrent with the catalog snapshot's
 *     KV-side cache TTL — same staleness contract).
 *   - Canonical-query keying: lowercase + collapsed whitespace +
 *     stripped trailing punctuation. Conservative — no stemming
 *     or stop-word removal because those change semantics.
 *
 * The catalog backend's KV snapshot cache (`functions/api/v1/_lib/
 * snapshot.ts`) is the precedent for "5-minute staleness is OK
 * because publish/retract invalidate"; this is the same contract
 * applied at the docent-client layer, before the request leaves
 * the SPA.
 *
 * Decision-list note (Phase 1f #2 — cache scope): per-session
 * in-memory was chosen over per-user (localStorage — privacy
 * surface for raw queries) and per-deploy (CATALOG_KV — would
 * still re-burn Workers AI without caching the embedding too).
 * Revisit per-deploy after the cost panel (Commit E) shows
 * cross-session hot queries.
 */
const PRE_SEARCH_CACHE_LIMIT = 16
const PRE_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000

interface PreSearchCacheEntry {
  hits: SearchDatasetsHit[]
  expiresAt: number
}

const preSearchCache = new Map<string, PreSearchCacheEntry>()

function canonicalisePreSearchQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,;:]+$/u, '')
}

function preSearchCacheKey(query: string, limit: number): string {
  return `${canonicalisePreSearchQuery(query)}|${limit}`
}

/**
 * Test hook: drop every cached entry. The SPA never calls this in
 * production (the cache lives for the lifetime of the page); tests
 * call it from `beforeEach` to keep cases independent.
 */
export function clearPreSearchCache(): void {
  preSearchCache.clear()
}

/**
 * Execute a `search_datasets` tool call against the node catalog
 * backend. Returns the result shape the LLM expects to see in a
 * `tool` message reply. On error / unreachable / degraded, returns
 * an empty `{ datasets: [] }` so the LLM can move on (or call the
 * legacy `search_catalog` fallback).
 *
 * Phase 1f/C: results pass through the per-session pre-search
 * cache. The cache key normalises trivial query variations
 * ("hurricanes" / "Hurricanes  " / "hurricanes!" all hit the same
 * entry), bounded by limit. Empty results are cached too — a
 * genuine no-match shouldn't re-burn neurons in the same window.
 */
export async function executeSearchDatasets(
  args: Record<string, unknown>,
  config: DocentConfig,
): Promise<{ datasets: SearchDatasetsHit[]; degraded?: 'unconfigured' | 'quota_exhausted' }> {
  // Phase 1f/I — canonicalise once and use the canonical form for
  // BOTH the cache key and the wire `q=` parameter. Pre-1f/I the
  // cache keyed off the canonical form but sent the raw query on
  // the wire, so two queries that canonicalise the same ("Hurricanes!"
  // and "hurricanes") could produce different server responses but
  // collide on the cache. Sending the canonical form keeps the
  // cache contract honest: same canonical key ↔ same server input.
  const rawQuery = typeof args.query === 'string' ? args.query.trim() : ''
  const query = canonicalisePreSearchQuery(rawQuery)
  if (!query) return { datasets: [] }
  if (!config.apiUrl) return { datasets: [] }

  const limitArg = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : SEARCH_DATASETS_DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(SEARCH_DATASETS_MAX_LIMIT, Math.floor(limitArg)))

  // `query` is already canonicalised — preSearchCacheKey re-canonicalises
  // defensively (idempotent on canonical input) so a future caller
  // that bypasses the canonical-rawQuery normalisation above can't
  // poison the cache.
  const cacheKey = preSearchCacheKey(query, limit)
  const now = Date.now()
  const cached = preSearchCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    // Touch the entry's LRU position so a long-running session
    // keeps the active query set hot rather than rotating it out.
    preSearchCache.delete(cacheKey)
    preSearchCache.set(cacheKey, cached)
    return { datasets: cached.hits }
  }

  const url = new URL(`${CATALOG_API_BASE}/v1/search`, window.location.origin)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))

  let degradedReason: string | undefined
  let hits: SearchDatasetsHit[]
  try {
    const res = await apiFetch(url.toString(), { method: 'GET' })
    if (!res.ok) {
      logger.warn(`[Docent] search_datasets returned ${res.status}`)
      // Don't cache transient failures — the next turn should retry.
      return { datasets: [] }
    }
    const body = (await res.json()) as { datasets?: SearchDatasetsHit[]; degraded?: string }
    if (body.degraded) {
      logger.info(`[Docent] search_datasets degraded: ${body.degraded}`)
      degradedReason = body.degraded
      // Phase 1f/D — quota_exhausted on the search path drives the
      // same SPA-side badge as the LLM-side detection. Other
      // degraded reasons (`unconfigured`) are operator-misconfig
      // cases that surface their own messaging elsewhere.
      if (body.degraded === 'quota_exhausted') {
        markDegradedState('quota_exhausted')
      }
    }
    hits = Array.isArray(body.datasets) ? body.datasets : []
  } catch (err) {
    logger.warn('[Docent] search_datasets fetch failed:', err)
    // Network errors are also transient — same as non-OK responses.
    return { datasets: [] }
  }

  // Phase 1f/J — never cache a degraded response. quota_exhausted
  // is by definition transient (the badge clears as soon as a
  // subsequent successful round lands), and unconfigured points
  // at a binding that may get wired up mid-session. Caching either
  // would lock the same query into the empty result for the full
  // 5-minute TTL even after the underlying condition clears.
  //
  // Phase 1f/O — also propagate `degraded` up to processMessage so
  // it can short-circuit the LLM round on discovery turns and use
  // the local engine instead of burning another quota check on a
  // search-degraded session.
  if (degradedReason !== undefined) {
    return {
      datasets: hits,
      degraded: degradedReason as 'unconfigured' | 'quota_exhausted',
    }
  }

  preSearchCache.set(cacheKey, { hits, expiresAt: now + PRE_SEARCH_CACHE_TTL_MS })
  if (preSearchCache.size > PRE_SEARCH_CACHE_LIMIT) {
    // Map iteration order is insertion order; the first key is the
    // least-recently-touched (since touches re-insert above).
    const oldest = preSearchCache.keys().next().value
    if (oldest !== undefined) preSearchCache.delete(oldest)
  }
  return { datasets: hits }
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
    const res = await apiFetch(url.toString(), { method: 'GET' })
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
  /** Phase 3pg/C — single-frame load from an image-sequence dataset.
   *  `frameQuery` is the verbatim payload from the marker; client-
   *  side resolution happens in `resolveFrameQuery` against the
   *  dataset's `frames` envelope. */
  | { type: 'load-frame'; datasetId: string; datasetTitle: string; frameQuery: string; displayName: string }
  /** A cited current-event card from an `<<EVENT:ID>>` marker. The
   *  accompanying dataset load + fly/seek are emitted as ordinary
   *  load-dataset / fly-to / fit-bounds / set-time actions the marker
   *  expands into, so this variant carries only the citation display. */
  | { type: 'event-citation'; eventId: string; title: string; sourceName: string; sourceUrl: string }

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

  // Phase 1d/Z — case-insensitive id fallback. ULIDs are
  // Crockford base32 (uppercase canonical) and legacy_ids are
  // `INTERNAL_*` (uppercase). Llama-4-scout (and other models)
  // sometimes lowercase the id when emitting markers; an exact
  // case-sensitive lookup misses these. Re-try with the
  // upper-cased form before falling through to the legacy / title
  // / token-overlap heuristics.
  const idUpper = id.toUpperCase()
  if (idUpper !== id && datasetIdSet.has(idUpper)) return idUpper

  // Phase 1d/U — legacy_id fallback. Tour files and LLM responses
  // sometimes carry the row's bulk-import provenance id (e.g.
  // `INTERNAL_SOS_768`) instead of the post-cutover ULID. Resolve
  // those to the dataset's primary id before falling through to the
  // title-overlap heuristics; mirrors `dataService.getDatasetById`'s
  // legacyId fallback. The caller rewrites the marker payload to
  // `dataset.id` so the chat UI's marker round-trip works. 1d/Z
  // makes the comparison case-insensitive too.
  const byLegacy = datasets.find(
    d => d.legacyId === id || (d.legacyId && d.legacyId === idUpper),
  )
  if (byLegacy) return byLegacy

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

/** Loose normalization for title-vs-claim comparisons: lowercase,
 * collapse non-alphanumerics to single spaces, trim. Matches
 * "Sea-Ice Extent" against "sea ice extent" and copes with
 * smart-quotes / extra punctuation in LLM output. */
function normalizeTitleForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Whether an LLM-claimed title is plausibly the same dataset as the
 * catalog's actual title. Exact normalized match counts; substring
 * either direction also counts when both sides are non-trivial
 * (handles "Air Traffic" ⟷ "Air Traffic Flow Visualisation"). */
function titlesMatch(claim: string, actual: string): boolean {
  const c = normalizeTitleForCompare(claim)
  const a = normalizeTitleForCompare(actual)
  if (!c || !a) return false
  if (c === a) return true
  if (c.length >= 4 && a.length >= 4 && (c.includes(a) || a.includes(c))) return true
  return false
}

/** Strip mismatched title-claim phrases from the prose window
 * preceding a <<LOAD:ID>> marker. See reconcileMarkerProse for the
 * surrounding rationale. Returns the (possibly shortened) window. */
function stripMismatchedClaims(window: string, actualTitle: string): string {
  // Quote-bracketed claim: `the "X" dataset`, `loading 'X' dataset`, etc.
  // Smart-quote variants (‘’“”) included for
  // common LLM output. Whole match is dropped, not just the captured
  // group — leaving "the dataset" with extra spaces is uglier than
  // losing the whole "the 'X' dataset" phrase.
  const QUOTED_CLAIM = /\b(?:the|loading|recommend(?:ing|ed)?)\s+["'‘’“”]([^"'‘’“”\n]{2,80})["'‘’“”]\s+dataset\b/gi
  let out = window.replace(QUOTED_CLAIM, (match, claim: string) => {
    return titlesMatch(claim, actualTitle) ? match : ''
  })

  // Bold title on its own line right before the marker:
  //   "**Hurricane Tracks**\n<<LOAD:...>>"
  // Constrained to the trailing portion of the window so we don't
  // strip legitimate emphasis from earlier sentences.
  const BOLD_TAIL = /(?:^|\n)\s*\*\*([^*\n]{2,80})\*\*\s*$/
  const m = out.match(BOLD_TAIL)
  if (m && m.index !== undefined && !titlesMatch(m[1], actualTitle)) {
    out = out.slice(0, m.index)
  }

  return out
}

/** Walk every `<<LOAD:ID>>` marker in `text`, reconcile the
 * preceding prose against the marker's catalog-resolved title,
 * and inject a `→ Loads: <title>` confirmation line when the
 * preceding window doesn't already mention the actual title.
 * Markers whose ID isn't in the catalog are left untouched —
 * they're stripped earlier by the invalid-marker pass. */
function reconcileMarkerProse(text: string, datasets: Dataset[]): string {
  const PRECEDING_WINDOW = 250
  const out: string[] = []
  let lastEnd = 0

  for (const match of text.matchAll(/<<LOAD:([^>]+)>>/g)) {
    const id = match[1].trim()
    const matchStart = match.index ?? 0
    const matchEnd = matchStart + match[0].length
    const dataset = datasets.find(d => d.id === id)

    let preceding = text.slice(lastEnd, matchStart)
    if (dataset) {
      // Slice the strip window to ~PRECEDING_WINDOW chars so we
      // don't reach into earlier paragraphs. Keep anything before
      // that window verbatim.
      const windowStart = Math.max(0, preceding.length - PRECEDING_WINDOW)
      const before = preceding.slice(0, windowStart)
      const window = preceding.slice(windowStart)
      const stripped = stripMismatchedClaims(window, dataset.title)
      preceding = before + stripped

      // If the preceding window (post-strip) doesn't mention the
      // catalog title, inject an explicit "Loads: <title>" line
      // so the user has authoritative confirmation of what the
      // chip will load. Skip if the title already appears anywhere
      // in the window — no need for redundancy when the LLM got
      // it right.
      const haystack = preceding.slice(Math.max(0, preceding.length - PRECEDING_WINDOW)).toLowerCase()
      if (!haystack.includes(dataset.title.toLowerCase())) {
        const loadsLine = t('chat.action.loadsLabel', { title: dataset.title })
        preceding = preceding.replace(/\s*$/, '\n' + loadsLine + '\n')
      }
    }

    out.push(preceding, match[0])
    lastEnd = matchEnd
  }
  out.push(text.slice(lastEnd))
  return out.join('')
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
  events: readonly PublicEvent[] = [],
): { cleanedText: string; validIds: Set<string>; invalidIds: Set<string>; globeActions: ExtractedGlobeAction[] } {
  const validIds = new Set<string>()
  const invalidIds = new Set<string>()
  const globeActions: ExtractedGlobeAction[] = []
  const datasetIdSet = new Set(datasets.map(d => d.id))
  // Approved current events, keyed by uppercased id — the docent lowercases
  // ULIDs about as often as it lowercases dataset ids, so match tolerantly.
  const eventById = new Map<string, PublicEvent>()
  for (const ev of events) eventById.set(ev.id.toUpperCase(), ev)
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
      // 1d/Z — when the resolver case-normalised the id (e.g. the
      // LLM emitted lowercase but the canonical form is uppercase),
      // record the rewrite so the marker payload in the cleaned
      // text matches the canonical id the chat UI expects.
      if (id !== resolved) markerRewrites.set(id, resolved)
    } else if (resolved) {
      // Title or token-overlap match.
      validIds.add(resolved.id)
      if (id !== resolved.id) markerRewrites.set(id, resolved.id)
    } else {
      invalidIds.add(id)
    }
  }
  for (const match of text.matchAll(/\bINTERNAL_[A-Z0-9_]+\b/gi)) {
    const id = match[0]
    // Skip IDs already captured via markers
    if (validIds.has(id) || invalidIds.has(id)) continue
    // Phase 1d/Z — `i` flag added so the bare-mention path catches
    // lowercase emissions too (some LLMs lowercase identifiers).
    // The legacy_id fallback also normalises to uppercase before
    // comparing so `internal_sos_768` resolves to the
    // `INTERNAL_SOS_768`-keyed row.
    const idUpper = id.toUpperCase()
    if (datasetIdSet.has(id) || datasetIdSet.has(idUpper)) {
      validIds.add(datasetIdSet.has(id) ? id : idUpper)
      if (id !== idUpper) markerRewrites.set(id, idUpper)
    } else {
      // Phase 1d/U — same legacy_id fallback the marker path uses.
      const byLegacy = datasets.find(d => d.legacyId === idUpper)
      if (byLegacy) {
        validIds.add(byLegacy.id)
        markerRewrites.set(id, byLegacy.id)
      } else {
        invalidIds.add(id)
      }
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

  // Extract <<LOAD_FRAME:DATASET_ID:query>> markers (Phase 3pg/C).
  // `DATASET_ID` must be a known sequence dataset (with a `.frames`
  // envelope, set by Phase 3pg/A). `query` is anything the
  // resolver accepts: `latest` / `first`, `index=N`, a bare
  // integer, or an ISO 8601 timestamp. Markers whose dataset is
  // unknown or isn't a sequence row are silently dropped — same
  // policy as <<LOAD:...>> markers with hallucinated IDs.
  for (const match of text.matchAll(/<?<LOAD_FRAME:\s*([^:>]+):\s*([^>]+?)\s*>>?/g)) {
    const datasetId = match[1].trim()
    const frameQuery = match[2].trim()
    // Exact id first, then case-insensitive — matches the same
    // permissive policy `<<LOAD:...>>` markers use, since small
    // LLMs sometimes lowercase ULIDs or emit a legacyId variant.
    // Title-based fallback isn't safe here because the marker uses
    // `:` as the id↔query separator — a title with a colon would
    // confuse the parser.
    let dataset = datasets.find(d => d.id === datasetId)
    if (!dataset) {
      const lower = datasetId.toLowerCase()
      dataset = datasets.find(
        d => d.id.toLowerCase() === lower || (d.legacyId && d.legacyId.toLowerCase() === lower),
      )
    }
    if (!dataset || !dataset.frames) {
      // Unknown / non-sequence — fall through to the strip step
      // below, which will remove the literal marker from the
      // displayed text.
      continue
    }
    const resolved = resolveFrameQuery(dataset, frameQuery)
    if (!resolved) continue
    globeActions.push({
      type: 'load-frame',
      datasetId: dataset.id,
      datasetTitle: dataset.title,
      frameQuery,
      displayName: resolved.displayName,
    })
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

  // Extract <<EVENT:ID>> markers — a curator-approved current event
  // (`docs/CURRENT_EVENTS_PLAN.md` §6.2). We expand each one, entirely
  // from the approved event's own data (never LLM-authored numbers), into:
  //   - an `event-citation` card (headline + cited source),
  //   - a `load-dataset` of the dataset that explains it,
  //   - a place move (`fly-to` for a point, `fit-bounds` for a box / named
  //     region) and a `set-time` seek to when it happened.
  // The load + fly + seek then ride the ordinary post-load flush the LLM's
  // own <<LOAD>>+<<FLY>>+<<TIME>> sequences use. An id not present in the
  // approved set is dropped (stripped below) — the anti-hallucination gate.
  const EVENT_FLY_ALTITUDE_KM = 3000
  for (const match of text.matchAll(/<?<EVENT:\s*([^>]+?)\s*>>?\n?/g)) {
    const ev = eventById.get(match[1].trim().toUpperCase())
    if (!ev) continue
    globeActions.push({
      type: 'event-citation',
      eventId: ev.id,
      title: ev.title,
      sourceName: ev.source.name,
      sourceUrl: ev.source.url,
    })
    const datasetId = ev.datasetIds[0]
    if (datasetId && datasetIdSet.has(datasetId)) validIds.add(datasetId)
    const g = ev.geometry
    if (g.point) {
      globeActions.push({ type: 'fly-to', lat: g.point.lat, lon: g.point.lon, altitude: EVENT_FLY_ALTITUDE_KM })
    } else if (g.boundingBox) {
      const { n, s, w, e } = g.boundingBox
      globeActions.push({ type: 'fit-bounds', bounds: [w, s, e, n] })
    } else if (g.regionName) {
      const region = resolveRegion(g.regionName)
      if (region) globeActions.push({ type: 'fit-bounds', bounds: region.bounds, label: region.name })
    }
    if (ev.occurredStart && !isNaN(new Date(ev.occurredStart).getTime())) {
      globeActions.push({ type: 'set-time', isoDate: ev.occurredStart })
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

  // Reconcile prose claims against marker IDs. Mid-tier LLMs
  // routinely write a topical title in prose ("Hurricane Season")
  // immediately before a <<LOAD:ID>> marker that resolves to an
  // unrelated dataset ("Air Traffic"). The chip — sourced from
  // the catalog by id — shows the real title; the prose claim
  // contradicts it. Two passes per marker:
  //
  //   (1) Strip mismatched title-claim phrases from the
  //       preceding window. Patterns covered:
  //         - the "X" / 'X' dataset (quote-bracketed)
  //         - **X** on its own line right before the marker
  //
  //   (2) If the marker's actual title still isn't mentioned
  //       in the preceding window after pass (1), inject an
  //       explicit "→ Loads: **<title>**" line so the user has
  //       authoritative confirmation of what the chip will
  //       load — independent of the LLM's narrative.
  //
  // The injected `loadsLabel` is locale-aware (en: "→ Loads:",
  // es: "→ Carga:"). Dataset titles themselves stay in their
  // catalog form (English in L1) — translating titles is L3
  // metadata-pipeline work.
  cleanedText = reconcileMarkerProse(cleanedText, datasets)

  // Strip bare invalid INTERNAL_... IDs from prose. Case-insensitive
  // to match the detection regex above (1d/Z added the `i` flag for
  // detection but the strip pass kept the case-sensitive form, so
  // lowercase invalid mentions like `internal_sos_123` were detected
  // and reported but left in the user-visible text — 1d/AD).
  cleanedText = cleanedText.replace(/\bINTERNAL_[A-Z0-9_]+\b/gi, (id) => {
    if (invalidIds.has(id)) return ''
    return id
  })

  // Strip <<LOAD_FRAME:...>> markers from displayed text — the
  // action chunk emission below carries the frame load forward.
  cleanedText = cleanedText.replace(/<?<LOAD_FRAME:[^>]+>>?\n?/g, '')
  // Strip <<FLY:...>>, <<TIME:...>>, <<BOUNDS:...>>, <<MARKER:...>>, <<LABELS:...>> markers from displayed text
  cleanedText = cleanedText.replace(/<?<FLY:[^>]+>>?\n?/g, '')
  cleanedText = cleanedText.replace(/<?<TIME:[^>]+>>?\n?/g, '')
  cleanedText = cleanedText.replace(/<?<BOUNDS:[^>]+>>?\n?/g, '')
  cleanedText = cleanedText.replace(/<?<MARKER:[^>]+>>?\n?/g, '')
  cleanedText = cleanedText.replace(/<?<LABELS:[^>]+>>?\n?/g, '')
  cleanedText = cleanedText.replace(/<?<REGION:[^>]+>>?\n?/g, '')
  // Strip <<EVENT:...>> markers — valid ones are carried forward as the
  // event-citation + load + fly/seek actions; invalid ids just vanish.
  cleanedText = cleanedText.replace(/<?<EVENT:[^>]+>>?\n?/g, '')

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
  events: readonly PublicEvent[] = [],
): AsyncGenerator<DocentStreamChunk> {
  const { cleanedText, validIds, invalidIds, globeActions } = validateAndCleanText(accumulatedText, datasets, events)
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
    } else if (ga.type === 'load-frame') {
      yield {
        type: 'action',
        action: {
          type: 'load-frame',
          datasetId: ga.datasetId,
          datasetTitle: ga.datasetTitle,
          frameQuery: ga.frameQuery,
          displayName: ga.displayName,
        },
      }
    } else if (ga.type === 'event-citation') {
      yield {
        type: 'action',
        action: {
          type: 'event-citation',
          eventId: ga.eventId,
          title: ga.title,
          sourceName: ga.sourceName,
          sourceUrl: ga.sourceUrl,
        },
      }
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

    // Pre-search injection — Phase 1d/AC.
    //
    // Re-introduced after 1d/F's removal because the cutover's
    // tool-call-only grounding path turned out to be unreliable
    // on small/mid LLMs (llama-4-scout, sometimes 70b): when the
    // LLM short-circuits and doesn't call search_datasets, it
    // confabulates id-shaped strings the validator strips, and
    // the user sees prose without chips.
    //
    // 1d/F removed an in-memory keyword-scan injection; 1d/AC
    // restores the same SHAPE of injection but sources results
    // from the Vectorize-backed `search_datasets` instead.
    // Architectural cleanup of 1d (Vectorize as the single source
    // of search truth, no in-memory legacy keyword scan in the
    // primary path) is preserved; only the grounding mechanism
    // reverts to "hand the LLM real IDs in the user message".
    //
    // The `search_datasets` LLM tool stays in the tool list so the
    // model can refine for follow-up queries — it's no longer the
    // only path to grounded IDs.
    const needsPreSearch =
      intent.type === 'search' || intent.type === 'category' || intent.type === 'related'
    const preSearchQuery =
      intent.type === 'search' ? intent.query : intent.type === 'category' ? intent.category : input
    const preSearchResult = needsPreSearch
      ? await executeSearchDatasets({ query: preSearchQuery, limit: 5 }, cfg)
      : { datasets: [] as SearchDatasetsHit[] }
    const preSearchHits = preSearchResult.datasets
    // Phase 1f/O — search returned degraded (Workers AI quota
    // exhausted or embed bindings unconfigured). Short-circuit the
    // LLM round and fall through to the local engine: the LLM
    // would receive an empty [RELEVANT DATASETS] block and either
    // confabulate IDs (validator strips them, no chips) or
    // short-circuit with no recommendations. The local engine
    // searches the in-memory catalog and produces real chips
    // immediately, which is the better degraded UX. The badge
    // (already flipped via markDegradedState inside
    // executeSearchDatasets when degraded='quota_exhausted')
    // signals the state to the user. Only triggers on discovery
    // intents — non-discovery turns don't pre-search and aren't
    // affected.
    if (needsPreSearch && preSearchResult.degraded) {
      logger.warn(
        `[Docent] Pre-search degraded (${preSearchResult.degraded}) — ` +
          'short-circuiting to local engine to avoid an ungrounded LLM round',
      )
      // Mirror the !llmEnabled local-fallback path: run
      // `evaluateAutoLoad` for exact-match search intents BEFORE
      // emitting the load-dataset action chunks. Without this an
      // exact-title query during a degraded session would surface
      // the dataset as a button rather than auto-loading the best
      // match — a regression vs the chat-side-only fallback that
      // 1f/O introduced and Copilot's 6th-round review caught.
      if (intent.type === 'search' && searchResults) {
        const autoResult = evaluateAutoLoad(searchResults)
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
      // Emit the local engine's load-dataset actions (chips) that
      // were skipped above because llmEnabled was true at the
      // top-of-function check. Mirrors the !llmEnabled action
      // emission but inlined here because we only know to fire it
      // after the pre-search returns degraded.
      if (localResponse.actions) {
        for (const action of localResponse.actions) {
          if (action.type === 'load-dataset' && !yieldedIds.has(action.datasetId)) {
            yieldedIds.add(action.datasetId)
            yield { type: 'action', action }
          }
        }
      }
      yield { type: 'delta', text: localResponse.text }
      yield { type: 'done', fallback: true }
      return
    }

    // Approved current events (curator-gated) for the [CURRENT EVENTS]
    // injection, the `search_events` tool, and `<<EVENT:ID>>` validation.
    // Cached 60 s in eventsService and degrades to [] on any failure, so a
    // deploy without the events endpoint is a silent no-op here.
    const approvedEvents = await fetchApprovedEvents()

    let preSearchContext = ''
    if (preSearchHits.length > 0) {
      const lines = preSearchHits.map(h => {
        const cats = h.categories.join(', ')
        const snippet = h.abstract_snippet
          ? h.abstract_snippet.length > 200
            ? h.abstract_snippet.slice(0, 200) + '…'
            : h.abstract_snippet
          : ''
        return `- ${h.id} | ${h.title} | ${cats} | ${snippet}`
      })
      preSearchContext =
        `[RELEVANT DATASETS for your query:\n${lines.join('\n')}\nRefer to these by exact title and copy the id field verbatim into <<LOAD:ID>> markers.]\n`
    }

    // Phase 3pt/G follow-up — surface the available tours alongside
    // the dataset pre-search. Tours aren't indexed by Vectorize
    // (which backs `search_datasets` / `[RELEVANT DATASETS]`), so
    // without a parallel injection the LLM only finds them via
    // the last-ditch `search_catalog` fallback. The list is small
    // in practice (a handful of sample tours + publisher dock
    // entries per operator), so we include every visible tour
    // every turn rather than filtering by query — token cost is
    // ~40 tokens × N, and the LLM gets full visibility to decide
    // when a guided experience is appropriate (cold start, "show
    // me an overview", new visitor, etc.).
    const tourEntries = datasets.filter(d => d.format === 'tour/json')
    if (tourEntries.length > 0) {
      const tourLines = tourEntries.map(t => {
        const desc = t.abstractTxt
          ? t.abstractTxt.length > 150
            ? t.abstractTxt.slice(0, 150) + '…'
            : t.abstractTxt
          : ''
        return `- ${t.id} | ${t.title} | ${desc}`
      })
      preSearchContext +=
        `[AVAILABLE TOURS — guided experiences that walk the user through a topic with narration, camera movements, and dataset loads:\n${tourLines.join('\n')}\nRecommend a tour when the user seems new, asks for an overview, says they don't know where to start, or asks for a guided experience. Surface with the same <<LOAD:ID>> marker as a regular dataset — the SPA routes tour-format rows into the tour engine automatically.]\n`
    }

    // [CURRENT EVENTS] injection — the cold-start path for the Orbit
    // events surface (docs/CURRENT_EVENTS_PLAN.md §6.2). Like tours, the
    // approved set is small, so we inject every event (capped) each turn
    // rather than gating on a query; the model decides when a headline is
    // relevant. Only these ids are valid <<EVENT:ID>> payloads — this block
    // and the search_events tool are the anti-hallucination gate for events.
    if (approvedEvents.length > 0) {
      const eventLines = approvedEvents.slice(0, CURRENT_EVENTS_INJECTION_CAP).map(ev => {
        const when = (ev.occurredStart ?? ev.source.publishedAt ?? '').slice(0, 10)
        const datasetId = ev.datasetIds[0] ?? ''
        return `- ${ev.id} | ${ev.title} | ${ev.source.name}${when ? ' | ' + when : ''}${datasetId ? ' | dataset_id: ' + datasetId : ''}`
      })
      preSearchContext +=
        `[CURRENT EVENTS — reputable, curator-approved current events relevant to this node's data. Surface one with an <<EVENT:ID>> marker on its own line: it shows a cited card AND loads the dataset that explains it, flying the globe to where and when it happened. Only the ids below are valid; never invent an event, headline, or source:\n${eventLines.join('\n')}]\n`
    }

    const userMessage: LLMMessage = visionActive
      ? { role: 'user', content: [
          { type: 'image_url' as const, image_url: { url: screenshotDataUrl! } },
          { type: 'text' as const, text: statePrefix + preSearchContext + visionText },
        ] as LLMContentPart[] }
      : { role: 'user', content: statePrefix + preSearchContext + input }

    // Anchor a fresh language-reminder system message right before
    // the user's turn — the system prompt's respond-in-{language}
    // directive gets crowded out by tool-call back-and-forth on
    // mid-tier models. See buildLanguageReminderMessage for context.
    const languageReminder = buildLanguageReminderMessage()
    const llmMessages: LLMMessage[] = [
      { role: 'system' as const, content: systemPrompt },
      ...buildCompressedHistory(history),
      ...(languageReminder ? [languageReminder] : []),
      userMessage,
    ]
    // Tool ordering — Phase 1d cutover (catalog(1d/E)).
    //
    // search_datasets ranks first now that the catalog backend is
    // provisioned and the SOS snapshot has been imported (1d/B).
    // Semantic vector search is the primary discovery tool; the
    // empty-result fallback to search_catalog stays in the prompt
    // for self-hosting deploys that haven't wired Vectorize yet.
    // list_featured_datasets is the cold-start path. search_catalog
    // (legacy in-memory keyword scan) stays in the tool list as a
    // graceful-degradation fallback, but is no longer the default.
    //
    // 1c/L pinned search_catalog first to avoid the
    // unwired-Vectorize hallucination path; with the cutover in
    // place that mitigation is unnecessary. A regression here —
    // empty Vectorize, search_datasets first — would surface as
    // missing Load chips and is reverted by `git revert` of this
    // commit.
    const tools = [
      getSearchDatasetsTool(),
      getListFeaturedDatasetsTool(),
      getSearchCatalogTool(),
      getSearchEventsTool(),
      getLoadDatasetTool(),
      getLoadFrameTool(),
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
      // Tool-call results (search_datasets / list_featured_datasets /
      // legacy search_catalog) land here, normalised to the same minimal
      // shape. catalog(1d/AC) seeds with the pre-search results so the
      // safety net catches title-mentions when the LLM doesn't call a
      // tool (which post-1d/AC is the common case for discovery
      // intents — they're already grounded via [RELEVANT DATASETS]).
      const searchResultsThisAttempt: CatalogSearchResult[] = preSearchHits.map(h => ({
        id: h.id,
        title: h.title,
        categories: h.categories,
        description: h.abstract_snippet,
      }))

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
                  chunk.call.name === 'list_featured_datasets' ||
                  chunk.call.name === 'search_events'
                ) {
                  // All discovery tools need a tool-result message sent back
                  // to the LLM — queue for the end-of-round dispatch below.
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
                } else if (chunk.call.name === 'load_frame') {
                  // Phase 3pg/C — tool-call sibling of the
                  // <<LOAD_FRAME:...>> marker path. Same resolution
                  // policy: unknown dataset_id or non-sequence row
                  // silently drops the call rather than emitting a
                  // broken button.
                  const args = chunk.call.arguments as {
                    dataset_id?: string
                    dataset_title?: string
                    query?: string
                  }
                  const idStr = String(args.dataset_id ?? '')
                  const dataset = datasets.find(d => d.id === idStr)
                  if (!dataset || !dataset.frames) {
                    logger.warn('[Docent] Ignoring load_frame with unknown / non-sequence dataset_id:', idStr)
                  } else if (!args.query) {
                    logger.warn('[Docent] Ignoring load_frame with empty query for dataset:', idStr)
                  } else {
                    const query = String(args.query)
                    const resolved = resolveFrameQuery(dataset, query)
                    if (resolved) {
                      yield {
                        type: 'action',
                        action: {
                          type: 'load-frame',
                          datasetId: dataset.id,
                          datasetTitle: dataset.title,
                          frameQuery: query,
                          displayName: resolved.displayName,
                        },
                      }
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
                // Phase 1f/D — surface the SPA-side degraded badge
                // when the error is a 4006 quota signal. Other
                // errors leave the existing fallback path untouched.
                if (chunk.code === 'quota_exhausted') {
                  markDegradedState('quota_exhausted')
                }
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
            } else if (call.name === 'search_events') {
              // In-memory filter over the approved events already fetched
              // for this turn — no network, works on any deploy.
              const result = executeSearchEvents(call.arguments, approvedEvents)
              logger.info(`[Docent] search_events("${String(call.arguments.query ?? '')}") → ${result.events.length} result(s)`)
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
          // Phase 1f/D — a successful LLM round means quota is back
          // (Workers AI accepted the request and produced output).
          // Self-heal the degraded badge so the user knows
          // functionality is restored without a manual reload.
          clearDegradedState()
          yield* emitValidatedActions(accumulatedText, datasets, yieldedIds, approvedEvents)

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

          yield {
            type: 'done',
            fallback: false,
            llmContext: { ...llmContext, roundsCount: round },
          }
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
