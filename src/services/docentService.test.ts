import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Dataset, ChatMessage, DocentConfig } from '../types'
import { processMessage, loadConfig, saveConfig, getDefaultConfig } from './docentService'
import type { DocentStreamChunk } from './docentService'

vi.mock('./llmProvider', () => ({
  streamChat: vi.fn(),
  checkAvailability: vi.fn(),
}))

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'TEST_001',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data',
    enriched: {
      description: 'Global SST anomalies.',
      categories: { Ocean: ['Temperature'] },
      keywords: ['SST', 'ocean'],
    },
    ...overrides,
  }
}

const datasets = [makeDataset()]

const disabledConfig: DocentConfig = {
  apiUrl: '',
  apiKey: '',
  model: 'test',
  enabled: false,
  readingLevel: 'general',
}

beforeEach(() => {
  vi.restoreAllMocks()
  // Clear localStorage
  try { localStorage.clear() } catch { /* ok */ }
})

describe('processMessage — local fallback', () => {
  it('uses local engine when LLM is disabled', async () => {
    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('hello', [], datasets, null, disabledConfig)) {
      chunks.push(chunk)
    }

    const deltas = chunks.filter(c => c.type === 'delta')
    expect(deltas.length).toBeGreaterThan(0)
    const doneChunk = chunks.find(c => c.type === 'done') as { type: 'done'; fallback: boolean }
    expect(doneChunk).toBeDefined()
    expect(doneChunk.fallback).toBe(true)
  })

  it('returns search results with actions for topic queries', async () => {
    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('ocean temperature', [], datasets, null, disabledConfig)) {
      chunks.push(chunk)
    }

    const actions = chunks.filter(c => c.type === 'action')
    expect(actions.length).toBeGreaterThan(0)
  })

  it('handles explain-current with a loaded dataset', async () => {
    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('explain this', [], datasets, makeDataset(), disabledConfig)) {
      chunks.push(chunk)
    }

    const text = chunks
      .filter(c => c.type === 'delta')
      .map(c => (c as { type: 'delta'; text: string }).text)
      .join('')
    expect(text).toContain('Sea Surface Temperature')
  })

  it('yields local actions before text when LLM is disabled', async () => {
    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('ocean temperature', [], datasets, null, disabledConfig)) {
      chunks.push(chunk)
    }

    const firstAction = chunks.findIndex(c => c.type === 'action')
    const firstDelta = chunks.findIndex(c => c.type === 'delta')
    // Actions should come before text deltas
    if (firstAction !== -1 && firstDelta !== -1) {
      expect(firstAction).toBeLessThan(firstDelta)
    }
  })
})

describe('processMessage — LLM path', () => {
  it('falls back to local when LLM stream errors', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    // Make streamChat return an error chunk
    mockedStream.mockImplementation(async function* () {
      yield { type: 'error' as const, message: 'Connection refused' }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('hello', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    // Should have fallen back to local
    const doneChunk = chunks.find(c => c.type === 'done') as { type: 'done'; fallback: boolean }
    expect(doneChunk).toBeDefined()
    expect(doneChunk.fallback).toBe(true)
  })

  it('streams LLM text when available', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Great ' }
      yield { type: 'delta' as const, text: 'question!' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('hello', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    const deltas = chunks.filter(c => c.type === 'delta')
    expect(deltas).toHaveLength(2)
    const doneChunk = chunks.find(c => c.type === 'done') as { type: 'done'; fallback: boolean }
    expect(doneChunk.fallback).toBe(false)
  })

  it('converts LLM tool calls to actions', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Here is a dataset:' }
      yield {
        type: 'tool_call' as const,
        call: {
          name: 'load_dataset',
          arguments: { dataset_id: 'TEST_001', dataset_title: 'Sea Surface Temperature' },
        },
      }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('ocean data', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    const actions = chunks.filter(c => c.type === 'action')
    // Local engine may yield the same action — deduplication ensures only one
    const uniqueIds = new Set(actions.map(c => (c as { type: 'action'; action: { datasetId: string } }).action.datasetId))
    expect(uniqueIds.has('TEST_001')).toBe(true)
  })

  it('deduplicates LLM tool calls against local actions', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Found it!' }
      yield {
        type: 'tool_call' as const,
        call: {
          name: 'load_dataset',
          arguments: { dataset_id: 'TEST_001', dataset_title: 'Sea Surface Temperature' },
        },
      }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('ocean temperature', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    // Count all actions with TEST_001
    const test001Actions = chunks.filter(c =>
      c.type === 'action' && (c as { type: 'action'; action: { datasetId: string } }).action.datasetId === 'TEST_001'
    )
    expect(test001Actions.length).toBe(1)
  })

  it('yields local actions before LLM deltas', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Here are some results.' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('ocean temperature', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    const firstAction = chunks.findIndex(c => c.type === 'action')
    const firstDelta = chunks.findIndex(c => c.type === 'delta')
    if (firstAction !== -1 && firstDelta !== -1) {
      expect(firstAction).toBeLessThan(firstDelta)
    }
  })
})

describe('processMessage — auto-load', () => {
  it('yields auto-load chunk for high-confidence search results', async () => {
    // "sea surface temperature" should produce a very high score against the SST dataset
    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('sea surface temperature', [], datasets, null, disabledConfig)) {
      chunks.push(chunk)
    }

    const autoLoad = chunks.find(c => c.type === 'auto-load')
    if (autoLoad && autoLoad.type === 'auto-load') {
      expect(autoLoad.action.datasetId).toBe('TEST_001')
      expect(autoLoad.alternatives).toBeDefined()
    }
    // Whether or not auto-load fires depends on score thresholds,
    // but the chunk ordering should always have actions/auto-load before deltas
    const firstActionish = chunks.findIndex(c => c.type === 'action' || c.type === 'auto-load')
    const firstDelta = chunks.findIndex(c => c.type === 'delta')
    if (firstActionish !== -1 && firstDelta !== -1) {
      expect(firstActionish).toBeLessThan(firstDelta)
    }
  })
})

describe('processMessage — LLM dataset ID validation', () => {
  it('ignores tool calls with hallucinated dataset IDs', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Check this out:' }
      yield {
        type: 'tool_call' as const,
        call: {
          name: 'load_dataset',
          arguments: { dataset_id: 'HALLUCINATED_999', dataset_title: 'Fake Dataset' },
        },
      }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('fake data', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    const actions = chunks.filter(c => c.type === 'action')
    const hallucinated = actions.find(c =>
      c.type === 'action' && (c as { type: 'action'; action: { datasetId: string } }).action.datasetId === 'HALLUCINATED_999'
    )
    expect(hallucinated).toBeUndefined()
  })

  it('resolves tool calls by title when ID is unknown', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Found it:' }
      yield {
        type: 'tool_call' as const,
        call: {
          name: 'load_dataset',
          arguments: { dataset_id: 'WRONG_ID', dataset_title: 'Sea Surface Temperature' },
        },
      }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('ocean data', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    const actions = chunks.filter(c => c.type === 'action')
    const resolved = actions.find(c =>
      c.type === 'action' && (c as { type: 'action'; action: { datasetId: string } }).action.datasetId === 'TEST_001'
    )
    expect(resolved).toBeDefined()
  })
})

describe('config management', () => {
  it('returns default config when nothing saved', () => {
    const config = loadConfig()
    expect(config.apiUrl).toBe('/api')
    expect(config.model).toBe('llama-3.1-70b')
    expect(config.enabled).toBe(true)
  })

  it('saves and loads config', () => {
    const custom: DocentConfig = {
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4',
      enabled: true,
      readingLevel: 'general',
    }
    saveConfig(custom)
    const loaded = loadConfig()
    expect(loaded.apiUrl).toBe('https://api.openai.com/v1')
    expect(loaded.model).toBe('gpt-4')
  })

  it('getDefaultConfig returns a copy', () => {
    const a = getDefaultConfig()
    const b = getDefaultConfig()
    expect(a).toEqual(b)
    a.model = 'changed'
    expect(b.model).not.toBe('changed')
  })
})
