/**
 * Docent Service — orchestrates LLM-first responses with local fallback.
 *
 * Tries the configured LLM provider. If unavailable or unconfigured,
 * falls back to the local docentEngine for instant offline responses.
 */

import type { Dataset, ChatMessage, ChatAction, DocentConfig } from '../types'
import { streamChat, checkAvailability } from './llmProvider'
import type { StreamChunk } from './llmProvider'
import { buildSystemPrompt, buildMessageHistory, getLoadDatasetTool } from './docentContext'
import { processUserMessage } from './docentEngine'
import { logger } from '../utils/logger'

// --- Constants ---
const CONFIG_STORAGE_KEY = 'sos-docent-config'

/** Detect whether we're running on a deployed site (not localhost dev). */
const isDeployed = typeof window !== 'undefined'
  && !['localhost', '127.0.0.1'].includes(window.location.hostname)

const DEFAULT_CONFIG: DocentConfig = {
  apiUrl: isDeployed ? '/api' : 'http://localhost:11434/v1',
  apiKey: '',
  model: isDeployed ? 'llama-3.1-8b' : 'llama3.2',
  enabled: true,
}

/** Yielded by the service during response generation */
export type DocentStreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'action'; action: ChatAction }
  | { type: 'done'; fallback: boolean }
  | { type: 'error'; message: string }

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
 * Test if the configured LLM is reachable.
 */
export async function testConnection(config: DocentConfig): Promise<boolean> {
  return checkAvailability(config)
}

/**
 * Process a user message and yield streaming response chunks.
 *
 * Tries LLM first. On failure, falls back to the local engine.
 */
export async function* processMessage(
  input: string,
  history: ChatMessage[],
  datasets: Dataset[],
  currentDataset: Dataset | null,
  config?: DocentConfig,
): AsyncGenerator<DocentStreamChunk> {
  const cfg = config ?? loadConfig()

  // Try LLM if enabled
  if (cfg.enabled && cfg.apiUrl) {
    let llmProducedOutput = false
    try {
      const systemPrompt = buildSystemPrompt(datasets, currentDataset)
      const llmMessages = [
        { role: 'system' as const, content: systemPrompt },
        ...buildMessageHistory(history),
        { role: 'user' as const, content: input },
      ]
      const tools = [getLoadDatasetTool()]

      const stream = streamChat(llmMessages, tools, cfg)

      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'delta':
            llmProducedOutput = true
            yield { type: 'delta', text: chunk.text }
            break

          case 'tool_call':
            if (chunk.call.name === 'load_dataset') {
              const args = chunk.call.arguments as { dataset_id?: string; dataset_title?: string }
              if (args.dataset_id) {
                llmProducedOutput = true
                yield {
                  type: 'action',
                  action: {
                    type: 'load-dataset',
                    datasetId: String(args.dataset_id),
                    datasetTitle: String(args.dataset_title ?? args.dataset_id),
                  },
                }
              }
            }
            break

          case 'error':
            logger.info('[Docent] LLM error, falling back to local engine:', chunk.message)
            break

          case 'done':
            if (llmProducedOutput) {
              yield { type: 'done', fallback: false }
              return
            }
            break
        }
      }

      // If we got here without output, fall through to local
      if (llmProducedOutput) {
        yield { type: 'done', fallback: false }
        return
      }
    } catch (err) {
      logger.info('[Docent] LLM stream failed, falling back:', err)
    }
  }

  // Local fallback
  logger.info('[Docent] Using local engine')
  const response = processUserMessage(input, datasets, currentDataset)
  yield { type: 'delta', text: response.text }
  if (response.actions) {
    for (const action of response.actions) {
      yield { type: 'action', action }
    }
  }
  yield { type: 'done', fallback: true }
}
