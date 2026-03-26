/**
 * Docent Service — orchestrates LLM-first responses with local fallback.
 *
 * Tries the configured LLM provider. If unavailable or unconfigured,
 * falls back to the local docentEngine for instant offline responses.
 */

import type { Dataset, ChatMessage, ChatAction, DocentConfig } from '../types'
import { streamChat, checkAvailability, type AvailabilityResult, type LLMMessage, type LLMContentPart } from './llmProvider'
import { buildSystemPromptForTurn, buildCompressedHistory, getLoadDatasetTool } from './docentContext'
import { parseIntent, generateResponse, searchDatasets, evaluateAutoLoad } from './docentEngine'
import { logger } from '../utils/logger'

// --- Constants ---
const CONFIG_STORAGE_KEY = 'sos-docent-config'

/** The default vision-capable model for Cloudflare Workers AI. */
const CF_VISION_MODEL = 'llama-3.2-11b-vision'
const VISION_TIMEOUT_MS = 60000

/** Detect localhost dev where the Cloudflare /api proxy may be unavailable. */
export const isLocalDev = typeof window !== 'undefined'
  && ['localhost', '127.0.0.1'].includes(window.location.hostname)

/** Max dimension for the vision screenshot — keeps payload small. */
const VISION_MAX_SIZE = 512

/**
 * Capture the globe canvas as a compressed JPEG data URL, downsized to
 * at most VISION_MAX_SIZE px on the longest edge so the payload stays
 * small and the vision model can process it quickly.
 * Returns null if the canvas is not available.
 */
export function captureGlobeScreenshot(): string | null {
  const canvas = document.getElementById('globe-canvas') as HTMLCanvasElement | null
  if (!canvas) return null
  try {
    const { width, height } = canvas
    const scale = Math.min(1, VISION_MAX_SIZE / Math.max(width, height))
    if (scale < 1) {
      const offscreen = document.createElement('canvas')
      offscreen.width = Math.round(width * scale)
      offscreen.height = Math.round(height * scale)
      const ctx = offscreen.getContext('2d')
      if (!ctx) return canvas.toDataURL('image/jpeg', 0.6)
      ctx.drawImage(canvas, 0, 0, offscreen.width, offscreen.height)
      return offscreen.toDataURL('image/jpeg', 0.6)
    }
    return canvas.toDataURL('image/jpeg', 0.6)
  } catch {
    logger.warn('[Docent] Failed to capture globe screenshot')
    return null
  }
}

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

  const timeEl = document.getElementById('time-display')
  const timeText = timeEl?.textContent?.trim()
  if (timeText && timeText !== '--') {
    parts.push(`Time shown: ${timeText}`)
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

const DEFAULT_CONFIG: DocentConfig = {
  apiUrl: '/api',
  apiKey: '',
  model: 'llama-3.1-70b',
  enabled: true,
  readingLevel: 'general',
  visionEnabled: false,
}

/** Yielded by the service during response generation */
export type DocentStreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'action'; action: ChatAction }
  | { type: 'auto-load'; action: ChatAction; alternatives: ChatAction[] }
  | { type: 'rewrite'; text: string }
  | { type: 'done'; fallback: boolean }

/**
 * Load docent config from localStorage, merging with defaults.
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
 * Save docent config to localStorage.
 */
export function saveConfig(config: DocentConfig): void {
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config))
  } catch {
    // localStorage full or unavailable
  }
}

/**
 * Get the default config (for display in settings).
 */
export function getDefaultConfig(): DocentConfig {
  return { ...DEFAULT_CONFIG }
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

/**
 * Validate dataset IDs found in LLM text against the catalog.
 * Strips invalid <<LOAD:ID>> markers and bare INTERNAL_... IDs,
 * returning the cleaned text and the sets of valid/invalid IDs.
 * Pure function — does not log; callers decide when to log.
 */
export function validateAndCleanText(
  text: string,
  datasets: Dataset[],
): { cleanedText: string; validIds: Set<string>; invalidIds: Set<string> } {
  const validIds = new Set<string>()
  const invalidIds = new Set<string>()
  const datasetIdSet = new Set(datasets.map(d => d.id))

  // Collect all referenced IDs for validation
  for (const match of text.matchAll(/<?<LOAD:([^>]+)>>?/g)) {
    const id = match[1].trim()
    if (datasetIdSet.has(id)) {
      validIds.add(id)
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

  // Strip invalid <<LOAD:ID>> markers
  let cleanedText = text.replace(/<?<LOAD:([^>]+)>>?\n?/g, (match, id) => {
    const trimmedId = id.trim()
    if (invalidIds.has(trimmedId)) return ''
    return match
  })

  // Strip bare invalid INTERNAL_... IDs from prose
  cleanedText = cleanedText.replace(/\bINTERNAL_[A-Z0-9_]+\b/g, (id) => {
    if (invalidIds.has(id)) return ''
    return id
  })

  return { cleanedText, validIds, invalidIds }
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
 * and emit a rewrite chunk if any hallucinated IDs were stripped.
 */
async function* emitValidatedActions(
  accumulatedText: string,
  datasets: Dataset[],
  yieldedIds: Set<string>,
): AsyncGenerator<DocentStreamChunk> {
  const { cleanedText, validIds, invalidIds } = validateAndCleanText(accumulatedText, datasets)
  if (invalidIds.size > 0) {
    logger.warn('[Docent] Stripped hallucinated dataset IDs:', Array.from(invalidIds))
    yield { type: 'rewrite', text: cleanedText }
  }
  yield* yieldActionsForValidIds(validIds, datasets, yieldedIds)
}

export async function* processMessage(
  input: string,
  history: ChatMessage[],
  datasets: Dataset[],
  currentDataset: Dataset | null,
  config?: DocentConfig,
  screenshotDataUrl?: string | null,
  viewContext?: string,
): AsyncGenerator<DocentStreamChunk> {
  const cfg = config ?? loadConfig()

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
        const action: ChatAction = {
          type: 'load-dataset',
          datasetId: autoResult.autoLoad.id,
          datasetTitle: autoResult.autoLoad.title,
        }
        const alternatives: ChatAction[] = autoResult.alternatives.map(d => ({
          type: 'load-dataset',
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
        if (!yieldedIds.has(action.datasetId)) {
          yieldedIds.add(action.datasetId)
          yield { type: 'action', action }
        }
      }
    }
  }

  // --- Try LLM for richer text ---
  if (cfg.enabled && cfg.apiUrl) {
    let llmProducedText = false
    let accumulatedText = ''
    try {
      const turnIndex = Math.floor(history.length / 2)
      const visionActive = cfg.visionEnabled && !!screenshotDataUrl
      const systemPrompt = buildSystemPromptForTurn(datasets, currentDataset, turnIndex, cfg.readingLevel, visionActive)

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
        if (ctxParts.length > 0) {
          visionPrefix = `[This image is a scientific data visualization on a 3D globe, NOT a photograph. ${ctxParts.join('. ')}]\n`
        }
      }
      const visionText = visionPrefix + input
      const userMessage: LLMMessage = visionActive
        ? {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: screenshotDataUrl! } },
              { type: 'text', text: visionText },
            ] as LLMContentPart[],
          }
        : { role: 'user', content: input }

      const llmMessages: LLMMessage[] = [
        { role: 'system' as const, content: systemPrompt },
        ...buildCompressedHistory(history),
        userMessage,
      ]
      const tools = [getLoadDatasetTool()]

      // Auto-switch to vision model when using the default CF proxy
      const normalizedUrl = cfg.apiUrl.replace(/\/+$/, '')
      const visionCfg = visionActive && normalizedUrl === '/api'
        ? { ...cfg, model: CF_VISION_MODEL }
        : cfg

      const stream = streamChat(llmMessages, tools, visionCfg, visionActive ? { timeoutMs: VISION_TIMEOUT_MS } : undefined)

      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'delta':
            llmProducedText = true
            accumulatedText += chunk.text
            yield { type: 'delta', text: chunk.text }
            break

          case 'tool_call':
            if (chunk.call.name === 'load_dataset') {
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
            }
            break

          case 'error':
            // Treat LLM errors as hard failures — abort stream and fall back to local
            logger.info('[Docent] LLM error, falling back to local engine:', chunk.message)
            llmProducedText = false
            break

          case 'done':
            if (llmProducedText) {
              yield* emitValidatedActions(accumulatedText, datasets, yieldedIds)
              yield { type: 'done', fallback: false }
              return
            }
            break
        }
      }

      if (llmProducedText) {
        yield* emitValidatedActions(accumulatedText, datasets, yieldedIds)
        yield { type: 'done', fallback: false }
        return
      }
    } catch (err) {
      logger.info('[Docent] LLM stream failed, falling back:', err)
    }
  }

  // Local text fallback (actions already yielded above)
  logger.info('[Docent] Using local engine for text')
  yield { type: 'delta', text: localResponse.text }
  yield { type: 'done', fallback: true }
}
