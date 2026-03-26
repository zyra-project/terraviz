/**
 * Docent Service — orchestrates LLM-first responses with local fallback.
 *
 * Tries the configured LLM provider. If unavailable or unconfigured,
 * falls back to the local docentEngine for instant offline responses.
 */

import type { Dataset, ChatMessage, ChatAction, DocentConfig } from '../types'
import { streamChat, checkAvailability, type AvailabilityResult } from './llmProvider'
import { buildSystemPromptForTurn, buildCompressedHistory, getLoadDatasetTool } from './docentContext'
import { parseIntent, generateResponse, searchDatasets, evaluateAutoLoad } from './docentEngine'
import { logger } from '../utils/logger'

// --- Constants ---
const CONFIG_STORAGE_KEY = 'sos-docent-config'

/** Detect localhost dev where the Cloudflare /api proxy may be unavailable. */
export const isLocalDev = typeof window !== 'undefined'
  && ['localhost', '127.0.0.1'].includes(window.location.hostname)

const DEFAULT_CONFIG: DocentConfig = {
  apiUrl: '/api',
  apiKey: '',
  model: 'llama-3.1-70b',
  enabled: true,
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
      const systemPrompt = buildSystemPromptForTurn(datasets, currentDataset, turnIndex)
      const llmMessages = [
        { role: 'system' as const, content: systemPrompt },
        ...buildCompressedHistory(history),
        { role: 'user' as const, content: input },
      ]
      const tools = [getLoadDatasetTool()]

      const stream = streamChat(llmMessages, tools, cfg)

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
