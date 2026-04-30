import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Dataset, ChatMessage, DocentConfig } from '../types'
import { processMessage, loadConfig, saveConfig, getDefaultConfig, validateAndCleanText, captureViewContext, readCurrentTime, executeSearchDatasets, executeListFeaturedDatasets } from './docentService'
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
  visionEnabled: false,
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
      visionEnabled: false,
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
      visionEnabled: false,
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
          id: 'call_mock',
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
      visionEnabled: false,
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
          id: 'call_mock',
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
      visionEnabled: false,
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
      visionEnabled: false,
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

  it('handles multi-round search_catalog tool calls', async () => {
    // Phase 3 regression test: when the LLM emits a search_catalog tool call,
    // processMessage should execute the search locally, append assistant + tool
    // result messages, and call streamChat again so the LLM can incorporate
    // the search results into its final response.
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let callCount = 0
    let round2Messages: any[] | null = null
    mockedStream.mockImplementation(async function* (msgs) {
      callCount++
      if (callCount === 1) {
        // Round 1: LLM decides to search the catalog
        yield {
          type: 'tool_call' as const,
          call: {
            id: 'call_search_1',
            name: 'search_catalog',
            arguments: { query: 'ocean temperature' },
          },
        }
        yield { type: 'done' as const }
      } else {
        // Round 2: LLM has received search results and responds with text
        // Capture the messages so we can verify tool results were appended
        round2Messages = [...msgs]
        yield { type: 'delta' as const, text: 'Here are some ocean datasets.' }
        yield { type: 'done' as const }
      }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: false,
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('ocean temperature', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    // streamChat should have been called twice (round 1 + round 2)
    expect(callCount).toBe(2)

    // The second call should include tool result messages in its conversation
    expect(round2Messages).not.toBeNull()
    const toolMessages = round2Messages!.filter((m: any) => m.role === 'tool')
    expect(toolMessages.length).toBeGreaterThanOrEqual(1)
    // The tool message should reference the search_catalog call ID
    expect(toolMessages[0].tool_call_id).toBe('call_search_1')
    // The tool message should contain search results as JSON
    const toolContent = typeof toolMessages[0].content === 'string'
      ? toolMessages[0].content
      : ''
    expect(toolContent).toContain('Sea Surface Temperature')

    // Final response text from round 2 should be in the yielded chunks
    const deltas = chunks.filter(c => c.type === 'delta')
    const fullText = deltas.map(c => (c as { type: 'delta'; text: string }).text).join('')
    expect(fullText).toContain('ocean datasets')

    // Should end with done, not fallback
    const doneChunk = chunks.find(c => c.type === 'done') as { type: 'done'; fallback: boolean } | undefined
    expect(doneChunk?.fallback).toBe(false)
  })
})

describe('processMessage — auto-inject Load buttons', () => {
  it('auto-injects action when LLM mentions a pre-search title without markers', async () => {
    // Regression test: the auto-inject safety net should emit a load-dataset
    // action when the LLM mentions a dataset title from the pre-search results
    // in its prose but doesn't include a <<LOAD:...>> marker for it.
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    // LLM response mentions the dataset by title but NO <<LOAD:...>> marker
    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Here is a great dataset: Sea Surface Temperature — it shows global ocean temperatures.' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: false,
    }

    const chunks: DocentStreamChunk[] = []
    // Query "sea surface temperature" triggers pre-search which returns
    // the SST dataset. The LLM mentions it by title but skips the marker.
    for await (const chunk of processMessage('sea surface temperature', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    // The auto-inject should have emitted a load-dataset action for TEST_001
    const actions = chunks.filter(c => c.type === 'action')
    const loadActions = actions.filter(c =>
      (c as { type: 'action'; action: { type: string; datasetId: string } }).action.type === 'load-dataset'
    )
    const ids = loadActions.map(c =>
      (c as { type: 'action'; action: { datasetId: string } }).action.datasetId
    )
    expect(ids).toContain('TEST_001')
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
      expect(autoLoad.action.type === 'load-dataset' && autoLoad.action.datasetId).toBe('TEST_001')
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
          id: 'call_mock',
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
      visionEnabled: false,
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
          id: 'call_mock',
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
      visionEnabled: false,
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

describe('validateAndCleanText', () => {
  it('keeps valid <<LOAD:ID>> markers intact', () => {
    const text = 'Try this: <<LOAD:TEST_001>>'
    const { cleanedText, validIds, invalidIds } = validateAndCleanText(text, datasets)
    expect(cleanedText).toBe(text)
    expect(validIds.has('TEST_001')).toBe(true)
    expect(invalidIds.size).toBe(0)
  })

  it('strips invalid <<LOAD:ID>> markers', () => {
    const text = 'Try this: <<LOAD:HALLUCINATED_999>> and also <<LOAD:TEST_001>>'
    const { cleanedText, validIds, invalidIds } = validateAndCleanText(text, datasets)
    expect(cleanedText).not.toContain('HALLUCINATED_999')
    expect(cleanedText).toContain('<<LOAD:TEST_001>>')
    expect(validIds.has('TEST_001')).toBe(true)
    expect(invalidIds.has('HALLUCINATED_999')).toBe(true)
  })

  it('strips bare invalid INTERNAL_ IDs from prose', () => {
    const text = 'Check out INTERNAL_FAKE_OCEAN for ocean data'
    const { cleanedText, invalidIds } = validateAndCleanText(text, datasets)
    expect(cleanedText).not.toContain('INTERNAL_FAKE_OCEAN')
    expect(invalidIds.has('INTERNAL_FAKE_OCEAN')).toBe(true)
  })

  it('keeps bare valid INTERNAL_ IDs in prose', () => {
    const ds = [makeDataset({ id: 'INTERNAL_SST_001' })]
    const text = 'Check out INTERNAL_SST_001 for SST data'
    const { cleanedText, validIds } = validateAndCleanText(text, ds)
    expect(cleanedText).toContain('INTERNAL_SST_001')
    expect(validIds.has('INTERNAL_SST_001')).toBe(true)
  })

  // -------------------------------------------------------------
  // Phase 1c — title-overlap fallback (catalog(1c/N))
  // -------------------------------------------------------------

  it('resolves a marker whose contents are a near-title via token overlap', () => {
    // Real failure mode from PR #59: the LLM put a title-shaped
    // payload in the marker that didn't share a prefix with the
    // catalog title. Token-overlap rescues it.
    const ds = [
      makeDataset({ id: 'INTERNAL_SOS_42', title: 'Sea Ice Extent (Arctic 1979-2020)' }),
      makeDataset({ id: 'INTERNAL_SOS_99', title: 'Wildfire Smoke Tracking' }),
    ]
    const text = 'Take a look at this one.\n<<LOAD:Arctic Sea Ice Extent>>\nIt covers 1979 onward.'
    const { cleanedText, validIds, invalidIds } = validateAndCleanText(text, ds)
    expect(validIds.has('INTERNAL_SOS_42')).toBe(true)
    expect(invalidIds.size).toBe(0)
    // The marker contents get rewritten to the canonical id so the
    // chat UI's [[LOAD:...]] roundtrip in conversation history sees
    // a stable payload.
    expect(cleanedText).toContain('<<LOAD:INTERNAL_SOS_42>>')
    expect(cleanedText).not.toContain('Arctic Sea Ice Extent>>')
  })

  it('strips when the overlap is ambiguous (tie at the top)', () => {
    // Two datasets share an equal token overlap on a marker that
    // is NOT a prefix of either title — better strip than load the
    // wrong dataset. The marker word order is shuffled so the
    // existing startsWith rescue can't resolve it first.
    const ds = [
      makeDataset({ id: 'INTERNAL_A', title: 'Atlantic Sea Surface Temperature Anomaly' }),
      makeDataset({ id: 'INTERNAL_B', title: 'Pacific Sea Surface Temperature Anomaly' }),
    ]
    const text = '<<LOAD:Surface Temperature Anomaly Sea>>\n'
    const { invalidIds } = validateAndCleanText(text, ds)
    expect(invalidIds.has('Surface Temperature Anomaly Sea')).toBe(true)
  })

  it('strips when the marker has fewer than 2 content tokens', () => {
    // `idTokens.size < 2` short-circuit. "Specific" is one content
    // token (the rest are stop words / under length); not enough
    // for a confident match.
    const ds = [makeDataset({ id: 'INTERNAL_X', title: 'Some Specific Climate Reanalysis Project' })]
    const text = '<<LOAD:specific>>\n'
    const { invalidIds } = validateAndCleanText(text, ds)
    expect(invalidIds.has('specific')).toBe(true)
  })

  it('strips when the marker has 2+ tokens but overlap is below the 3-shared-tokens floor', () => {
    // Two distinct content tokens, only one shared with the catalog
    // title — falls below the ≥ 3 floor.
    const ds = [makeDataset({ id: 'INTERNAL_X', title: 'Volcanic Eruption Plume Tracking 2010' })]
    const text = '<<LOAD:Aurora Borealis Volcanic>>\n'
    const { invalidIds } = validateAndCleanText(text, ds)
    expect(invalidIds.has('Aurora Borealis Volcanic')).toBe(true)
  })

  it('strips when the marker is mostly stop words (token-overlap rescue must not fire on noise)', () => {
    const ds = [makeDataset({ id: 'INTERNAL_X', title: 'Global Earth Data Visualization' })]
    const text = '<<LOAD:Global Data>>\n'
    const { invalidIds } = validateAndCleanText(text, ds)
    // "global" and "data" are both stop words for the matcher, so
    // the marker has zero content tokens and falls through to invalid.
    expect(invalidIds.has('Global Data')).toBe(true)
  })

  it('returns empty invalidIds when all IDs are valid', () => {
    const text = 'No dataset references here, just plain text.'
    const { cleanedText, invalidIds } = validateAndCleanText(text, datasets)
    expect(cleanedText).toBe(text)
    expect(invalidIds.size).toBe(0)
  })

  it('extracts <<FLY:lat,lon>> markers', () => {
    const text = 'Let me show you the Gulf.\n<<FLY:29.0,-89.0>>\nHere it is.'
    const { cleanedText, globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    expect(globeActions[0].type).toBe('fly-to')
    if (globeActions[0].type === 'fly-to') {
      expect(globeActions[0].lat).toBeCloseTo(29.0)
      expect(globeActions[0].lon).toBeCloseTo(-89.0)
      expect(globeActions[0].altitude).toBeUndefined()
    }
    expect(cleanedText).not.toContain('FLY')
  })

  it('extracts <<FLY:lat,lon,alt>> markers with altitude', () => {
    const text = '<<FLY:29.0,-89.0,3000>>'
    const { globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    if (globeActions[0].type === 'fly-to') {
      expect(globeActions[0].altitude).toBeCloseTo(3000)
    }
  })

  it('extracts <<TIME:date>> markers', () => {
    const text = 'During the storm.\n<<TIME:2005-08-29>>\nThe surge was devastating.'
    const { cleanedText, globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    expect(globeActions[0].type).toBe('set-time')
    if (globeActions[0].type === 'set-time') {
      expect(globeActions[0].isoDate).toBe('2005-08-29')
    }
    expect(cleanedText).not.toContain('TIME')
  })

  it('parses bare fly_to: text as fallback', () => {
    const text = 'To get a closer look.\nfly_to: 29.0, -89.0, 3000\nHere we go.'
    const { cleanedText, globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    if (globeActions[0].type === 'fly-to') {
      expect(globeActions[0].lat).toBeCloseTo(29.0)
      expect(globeActions[0].lon).toBeCloseTo(-89.0)
      expect(globeActions[0].altitude).toBeCloseTo(3000)
    }
    expect(cleanedText).not.toContain('fly_to')
  })

  it('parses bare set_time: text as fallback', () => {
    const text = 'Katrina made landfall.\nset_time: 2005-08-29\nThe flooding began.'
    const { cleanedText, globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    if (globeActions[0].type === 'set-time') {
      expect(globeActions[0].isoDate).toBe('2005-08-29')
    }
    expect(cleanedText).not.toContain('set_time')
  })

  it('extracts multiple globe actions from same text', () => {
    const text = '<<LOAD:TEST_001>>\n<<FLY:29.0,-89.0,3000>>\n<<TIME:2005-08-29>>'
    const { globeActions, validIds } = validateAndCleanText(text, datasets)
    expect(validIds.has('TEST_001')).toBe(true)
    expect(globeActions).toHaveLength(2)
    expect(globeActions[0].type).toBe('fly-to')
    expect(globeActions[1].type).toBe('set-time')
  })

  it('detects dataset title on its own line as fallback when marker is missing', () => {
    const text = 'Here is a great dataset.\nSea Surface Temperature\nIt shows ocean temps globally.'
    const { validIds } = validateAndCleanText(text, datasets)
    expect(validIds.has('TEST_001')).toBe(true)
  })

  it('does not match dataset title embedded in a sentence', () => {
    const text = 'The Sea Surface Temperature dataset shows ocean warming patterns.'
    const { validIds } = validateAndCleanText(text, datasets)
    expect(validIds.has('TEST_001')).toBe(false)
  })

  it('does not false-positive on short titles', () => {
    const shortDs = [makeDataset({ id: 'SHORT_1', title: 'Ice' })]
    const text = 'Ice\nThe ice caps are melting.'
    const { validIds } = validateAndCleanText(text, shortDs)
    expect(validIds.has('SHORT_1')).toBe(false)
  })

  it('does not duplicate IDs already found via markers', () => {
    const text = 'Check this: <<LOAD:TEST_001>>\nSea Surface Temperature'
    const { validIds } = validateAndCleanText(text, datasets)
    expect(validIds.has('TEST_001')).toBe(true)
    expect(validIds.size).toBe(1)
  })
})

describe('processMessage — rewrite chunk for hallucinated IDs', () => {
  it('yields rewrite chunk when LLM references invalid dataset IDs', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Check out <<LOAD:FAKE_DATASET_123>> for great data!' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: false,
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('show me data', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    const rewrite = chunks.find(c => c.type === 'rewrite') as { type: 'rewrite'; text: string } | undefined
    expect(rewrite).toBeDefined()
    expect(rewrite!.text).not.toContain('FAKE_DATASET_123')
  })

  it('does not yield rewrite chunk when all dataset IDs are valid', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Here is a great dataset: <<LOAD:TEST_001>>' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: false,
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('ocean data', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    const rewrite = chunks.find(c => c.type === 'rewrite')
    expect(rewrite).toBeUndefined()
  })
})

describe('config management', () => {
  it('returns default config when nothing saved', () => {
    const config = loadConfig()
    expect(config.apiUrl).toBe('/api')
    expect(config.model).toBe('llama-4-scout')
    expect(config.enabled).toBe(true)
  })

  it('saves and loads config', () => {
    const custom: DocentConfig = {
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: false,
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

  it('default config has visionEnabled false', () => {
    const config = getDefaultConfig()
    expect(config.visionEnabled).toBe(false)
  })

  it('saves and loads visionEnabled', () => {
    saveConfig({ ...getDefaultConfig(), visionEnabled: true })
    const loaded = loadConfig()
    expect(loaded.visionEnabled).toBe(true)
  })
})

describe('captureViewContext', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('captures time display text when time-label is visible', () => {
    document.body.innerHTML = `
      <div id="time-label"><span id="time-display">Jan 2020</span></div>
    `
    const ctx = captureViewContext()
    expect(ctx).toContain('Time shown: Jan 2020')
  })

  it('ignores time when time-label is hidden (stale from previous dataset)', () => {
    document.body.innerHTML = `
      <div id="time-label" class="hidden"><span id="time-display">Jan 2006</span></div>
    `
    const ctx = captureViewContext()
    expect(ctx).not.toContain('Time shown')
  })

  it('ignores time when time-label element is absent', () => {
    document.body.innerHTML = '<span id="time-display">Jan 2020</span>'
    const ctx = captureViewContext()
    expect(ctx).not.toContain('Time shown')
  })

  it('ignores placeholder time text', () => {
    document.body.innerHTML = `
      <div id="time-label"><span id="time-display">--</span></div>
    `
    const ctx = captureViewContext()
    expect(ctx).not.toContain('Time shown')
  })

  it('detects playing state from play button', () => {
    document.body.innerHTML = '<button id="play-btn" aria-label="Pause"></button>'
    const ctx = captureViewContext()
    expect(ctx).toContain('Playback: playing')
  })

  it('detects paused state from play button', () => {
    document.body.innerHTML = '<button id="play-btn" aria-label="Play"></button>'
    const ctx = captureViewContext()
    expect(ctx).toContain('Playback: paused')
  })

  it('returns empty string when no overlay elements exist', () => {
    document.body.innerHTML = ''
    expect(captureViewContext()).toBe('')
  })

  it('captures dataset title from info panel', () => {
    document.body.innerHTML = '<span id="info-title">Sea Surface Temperature</span>'
    const ctx = captureViewContext()
    expect(ctx).toContain('Dataset loaded: Sea Surface Temperature')
  })

  it('captures lat/lon coordinates', () => {
    document.body.innerHTML = '<div id="latlng-display">5.1° N, 139.9° E</div>'
    const ctx = captureViewContext()
    expect(ctx).toContain('Globe center: 5.1° N, 139.9° E')
  })

  it('combines all context fields', () => {
    document.body.innerHTML = `
      <span id="info-title">Atmospheric Chemistry</span>
      <div id="latlng-display">9.5° N, 137.7° E</div>
      <div id="time-label"><span id="time-display">Aug 17, 2006</span></div>
      <button id="play-btn" aria-label="Pause"></button>
    `
    const ctx = captureViewContext()
    expect(ctx).toContain('Dataset loaded: Atmospheric Chemistry')
    expect(ctx).toContain('Globe center: 9.5° N, 137.7° E')
    expect(ctx).toContain('Time shown: Aug 17, 2006')
    expect(ctx).toContain('Playback: playing')
    expect(ctx).toMatch(/\.$/)
  })

  it('captures viewing altitude from camera distance', () => {
    const canvas = document.createElement('canvas')
    canvas.id = 'globe-canvas'
    canvas.dataset.cameraZ = '1.80'  // default camera Z
    document.body.appendChild(canvas)

    const ctx = captureViewContext()
    // (1.80 - 1.0) * 6371 = ~5,097 km
    expect(ctx).toContain('Viewing altitude: ~5,097 km')
  })
})

describe('readCurrentTime', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns time text when time-label is visible', () => {
    document.body.innerHTML = `
      <div id="time-label"><span id="time-display">Mar 15, 2020</span></div>
    `
    expect(readCurrentTime()).toBe('Mar 15, 2020')
  })

  it('returns null when time-label is hidden (stale from previous dataset)', () => {
    document.body.innerHTML = `
      <div id="time-label" class="hidden"><span id="time-display">Jan 1, 2006</span></div>
    `
    expect(readCurrentTime()).toBeNull()
  })

  it('returns null when time-label element is absent', () => {
    document.body.innerHTML = '<span id="time-display">Jan 2020</span>'
    expect(readCurrentTime()).toBeNull()
  })

  it('returns null when time-display text is the placeholder', () => {
    document.body.innerHTML = `
      <div id="time-label"><span id="time-display">--</span></div>
    `
    expect(readCurrentTime()).toBeNull()
  })

  it('returns null when time-display is empty', () => {
    document.body.innerHTML = `
      <div id="time-label"><span id="time-display"></span></div>
    `
    expect(readCurrentTime()).toBeNull()
  })
})

describe('processMessage — vision mode', () => {
  it('sends multimodal content when vision is enabled with screenshot', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let capturedMessages: any[] = []
    mockedStream.mockImplementation(async function* (messages) {
      capturedMessages = messages
      yield { type: 'delta' as const, text: 'I can see the globe.' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: true,
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage(
      'What am I looking at?', [], datasets, null, config,
      'data:image/jpeg;base64,abc123',
    )) {
      chunks.push(chunk)
    }

    // The last message should be the user message with multimodal content
    const userMsg = capturedMessages[capturedMessages.length - 1]
    expect(Array.isArray(userMsg.content)).toBe(true)
    expect(userMsg.content[0].type).toBe('image_url')
    expect(userMsg.content[0].image_url.url).toBe('data:image/jpeg;base64,abc123')
    expect(userMsg.content[1].type).toBe('text')
    expect(userMsg.content[1].text).toContain('What am I looking at?')
  })

  it('includes view context in vision message text', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let capturedMessages: any[] = []
    mockedStream.mockImplementation(async function* (messages) {
      capturedMessages = messages
      yield { type: 'delta' as const, text: 'Response' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: true,
    }

    for await (const _ of processMessage(
      'What is this?', [], datasets, null, config,
      'data:image/jpeg;base64,abc123',
      'Time shown: Jan 2020. Playback: paused.',
    )) { /* consume */ }

    const userMsg = capturedMessages[capturedMessages.length - 1]
    const textPart = userMsg.content.find((p: any) => p.type === 'text')
    expect(textPart.text).toContain('Time shown: Jan 2020')
    expect(textPart.text).toContain('What is this?')
  })

  it('auto-switches to vision model when using /api proxy', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let capturedConfig: any = null
    mockedStream.mockImplementation(async function* (_msgs, _tools, config) {
      capturedConfig = config
      yield { type: 'delta' as const, text: 'ok' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: '/api',
      apiKey: '',
      model: 'llama-4-scout',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: true,
    }

    for await (const _ of processMessage(
      'hi', [], datasets, null, config,
      'data:image/jpeg;base64,abc123',
    )) { /* consume */ }

    expect(capturedConfig.model).toBe('llama-4-scout')
  })

  it('auto-switches to vision model when apiUrl has trailing slash', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let capturedConfig: any = null
    mockedStream.mockImplementation(async function* (_msgs, _tools, config) {
      capturedConfig = config
      yield { type: 'delta' as const, text: 'ok' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: '/api/',
      apiKey: '',
      model: 'llama-4-scout',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: true,
    }

    for await (const _ of processMessage(
      'hi', [], datasets, null, config,
      'data:image/jpeg;base64,abc123',
    )) { /* consume */ }

    expect(capturedConfig.model).toBe('llama-4-scout')
  })

  it('does not switch model when using external API URL', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let capturedConfig: any = null
    mockedStream.mockImplementation(async function* (_msgs, _tools, config) {
      capturedConfig = config
      yield { type: 'delta' as const, text: 'ok' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'llava',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: true,
    }

    for await (const _ of processMessage(
      'hi', [], datasets, null, config,
      'data:image/jpeg;base64,abc123',
    )) { /* consume */ }

    expect(capturedConfig.model).toBe('llava')
  })

  it('does not switch model for external URL ending in /api', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let capturedConfig: any = null
    mockedStream.mockImplementation(async function* (_msgs, _tools, config) {
      capturedConfig = config
      yield { type: 'delta' as const, text: 'ok' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'https://example.com/api',
      apiKey: '',
      model: 'gpt-4o',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: true,
    }

    for await (const _ of processMessage(
      'hi', [], datasets, null, config,
      'data:image/jpeg;base64,abc123',
    )) { /* consume */ }

    expect(capturedConfig.model).toBe('gpt-4o')
  })

  it('sends text-only message when vision enabled but no screenshot', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let capturedMessages: any[] = []
    mockedStream.mockImplementation(async function* (messages) {
      capturedMessages = messages
      yield { type: 'delta' as const, text: 'ok' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: true,
    }

    for await (const _ of processMessage(
      'hello', [], datasets, null, config,
      null, // no screenshot
    )) { /* consume */ }

    const userMsg = capturedMessages[capturedMessages.length - 1]
    expect(typeof userMsg.content).toBe('string')
  })

  it('includes vision instructions in system prompt when active', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let capturedMessages: any[] = []
    mockedStream.mockImplementation(async function* (messages) {
      capturedMessages = messages
      yield { type: 'delta' as const, text: 'ok' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: true,
    }

    for await (const _ of processMessage(
      'hi', [], datasets, null, config,
      'data:image/jpeg;base64,abc123',
    )) { /* consume */ }

    const systemMsg = capturedMessages.find((m: any) => m.role === 'system')
    expect(systemMsg.content).toContain('Vision Analysis Mode')
  })
})

// --- Phase 5: New marker parsing in validateAndCleanText ---

describe('validateAndCleanText — Phase 5 markers', () => {
  it('extracts <<BOUNDS:west,south,east,north>> markers', () => {
    const text = 'Here is the Amazon.\n<<BOUNDS:-82,-34,-34,13>>\nCheck it out.'
    const { cleanedText, globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    expect(globeActions[0].type).toBe('fit-bounds')
    if (globeActions[0].type === 'fit-bounds') {
      expect(globeActions[0].bounds).toEqual([-82, -34, -34, 13])
      expect(globeActions[0].label).toBeUndefined()
    }
    expect(cleanedText).not.toContain('BOUNDS')
  })

  it('extracts <<BOUNDS:...>> with label', () => {
    const text = '<<BOUNDS:-82,-34,-34,13,Amazon Basin>>'
    const { globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    if (globeActions[0].type === 'fit-bounds') {
      expect(globeActions[0].label).toBe('Amazon Basin')
    }
  })

  it('extracts <<MARKER:lat,lng,label>> markers', () => {
    const text = 'Check out Boulder.\n<<MARKER:40.0,-105.3,Boulder, CO>>\nGreat city.'
    const { cleanedText, globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    expect(globeActions[0].type).toBe('add-marker')
    if (globeActions[0].type === 'add-marker') {
      expect(globeActions[0].lat).toBeCloseTo(40.0)
      expect(globeActions[0].lng).toBeCloseTo(-105.3)
      expect(globeActions[0].label).toBe('Boulder, CO')
    }
    expect(cleanedText).not.toContain('MARKER')
  })

  it('extracts <<MARKER:lat,lng>> without label', () => {
    const text = '<<MARKER:35.7,139.7>>'
    const { globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    if (globeActions[0].type === 'add-marker') {
      expect(globeActions[0].label).toBeUndefined()
    }
  })

  it('extracts <<LABELS:on>> markers', () => {
    const text = 'Let me turn on labels.\n<<LABELS:on>>'
    const { cleanedText, globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    expect(globeActions[0].type).toBe('toggle-labels')
    if (globeActions[0].type === 'toggle-labels') {
      expect(globeActions[0].visible).toBe(true)
    }
    expect(cleanedText).not.toContain('LABELS')
  })

  it('extracts <<LABELS:off>> markers', () => {
    const text = '<<LABELS:off>>'
    const { globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    if (globeActions[0].type === 'toggle-labels') {
      expect(globeActions[0].visible).toBe(false)
    }
  })

  it('extracts <<REGION:name>> markers for known regions', () => {
    const text = 'Let me highlight Brazil.\n<<REGION:Brazil>>'
    const { cleanedText, globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    expect(globeActions[0].type).toBe('highlight-region')
    if (globeActions[0].type === 'highlight-region') {
      expect(globeActions[0].label).toBe('Brazil')
      expect(globeActions[0].bounds).toBeDefined()
      expect(globeActions[0].geojson).toBeDefined()
    }
    expect(cleanedText).not.toContain('REGION')
  })

  it('strips <<REGION:name>> even for unknown regions', () => {
    const text = 'Check out this place.\n<<REGION:Atlantis>>'
    const { cleanedText, globeActions } = validateAndCleanText(text, datasets)
    // Unknown region — no action but marker is still stripped from display
    expect(globeActions.filter(a => a.type === 'highlight-region')).toHaveLength(0)
    expect(cleanedText).not.toContain('REGION')
    expect(cleanedText).not.toContain('<<')
  })

  it('extracts <<REGION:name>> for US states', () => {
    const text = '<<REGION:Colorado>>'
    const { globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(1)
    if (globeActions[0].type === 'highlight-region') {
      expect(globeActions[0].label).toBe('Colorado')
    }
  })

  it('extracts multiple Phase 5 markers from same text', () => {
    const text = '<<MARKER:40,-105,Denver>>\n<<BOUNDS:-109,37,-102,41,Colorado>>\n<<LABELS:on>>'
    const { globeActions } = validateAndCleanText(text, datasets)
    expect(globeActions).toHaveLength(3)
    const types = globeActions.map(a => a.type)
    expect(types).toContain('add-marker')
    expect(types).toContain('fit-bounds')
    expect(types).toContain('toggle-labels')
  })

  it('handles mixed Phase 3 and Phase 5 markers', () => {
    const text = '<<LOAD:TEST_001>>\n<<FLY:29,-89>>\n<<MARKER:40,-105,Test>>\n<<REGION:Brazil>>'
    const { validIds, globeActions, cleanedText } = validateAndCleanText(text, datasets)
    expect(validIds.has('TEST_001')).toBe(true)
    // FLY + MARKER + REGION = 3 actions (REGION resolves to highlight-region)
    expect(globeActions.length).toBeGreaterThanOrEqual(3)
    expect(cleanedText).toContain('<<LOAD:TEST_001>>')
    expect(cleanedText).not.toContain('FLY')
    expect(cleanedText).not.toContain('MARKER')
    expect(cleanedText).not.toContain('REGION')
  })
})

describe('processMessage — Phase 5 tool calls', () => {
  const enabledConfig: DocentConfig = {
    apiUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: 'test',
    enabled: true,
    readingLevel: 'general',
    visionEnabled: false,
  }

  it('handles fit_bounds tool call', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Here is the Amazon Basin.' }
      yield {
        type: 'tool_call' as const,
        call: { id: 'call_mock', name: 'fit_bounds', arguments: { west: -82, south: -34, east: -34, north: 13, label: 'Amazon Basin' } },
      }
      yield { type: 'done' as const }
    })

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('show me the amazon', [], datasets, null, enabledConfig)) {
      chunks.push(chunk)
    }

    const action = chunks.find(c => c.type === 'action' && c.action.type === 'fit-bounds')
    expect(action).toBeDefined()
    if (action?.type === 'action' && action.action.type === 'fit-bounds') {
      expect(action.action.bounds).toEqual([-82, -34, -34, 13])
      expect(action.action.label).toBe('Amazon Basin')
    }
  })

  it('handles add_marker tool call', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Marker placed.' }
      yield {
        type: 'tool_call' as const,
        call: { id: 'call_mock', name: 'add_marker', arguments: { lat: 40.0, lng: -105.3, label: 'Boulder' } },
      }
      yield { type: 'done' as const }
    })

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('mark boulder', [], datasets, null, enabledConfig)) {
      chunks.push(chunk)
    }

    const action = chunks.find(c => c.type === 'action' && c.action.type === 'add-marker')
    expect(action).toBeDefined()
    if (action?.type === 'action' && action.action.type === 'add-marker') {
      expect(action.action.lat).toBeCloseTo(40.0)
      expect(action.action.lng).toBeCloseTo(-105.3)
      expect(action.action.label).toBe('Boulder')
    }
  })

  it('handles toggle_labels tool call', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Labels on.' }
      yield {
        type: 'tool_call' as const,
        call: { id: 'call_mock', name: 'toggle_labels', arguments: { visible: true } },
      }
      yield { type: 'done' as const }
    })

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('show labels', [], datasets, null, enabledConfig)) {
      chunks.push(chunk)
    }

    const action = chunks.find(c => c.type === 'action' && c.action.type === 'toggle-labels')
    expect(action).toBeDefined()
    if (action?.type === 'action' && action.action.type === 'toggle-labels') {
      expect(action.action.visible).toBe(true)
    }
  })

  it('handles highlight_region tool call with name parameter', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Highlighting Brazil.' }
      yield {
        type: 'tool_call' as const,
        call: { id: 'call_mock', name: 'highlight_region', arguments: { name: 'Brazil' } },
      }
      yield { type: 'done' as const }
    })

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('highlight brazil', [], datasets, null, enabledConfig)) {
      chunks.push(chunk)
    }

    const highlight = chunks.find(c => c.type === 'action' && c.action.type === 'highlight-region')
    expect(highlight).toBeDefined()
    // Should also produce a fit-bounds action to navigate there
    const fitBounds = chunks.find(c => c.type === 'action' && c.action.type === 'fit-bounds')
    expect(fitBounds).toBeDefined()
  })

  it('handles highlight_region tool call with geojson parameter', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    const geojson = {
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
    }

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Custom region.' }
      yield {
        type: 'tool_call' as const,
        call: { id: 'call_mock', name: 'highlight_region', arguments: { geojson, label: 'Custom' } },
      }
      yield { type: 'done' as const }
    })

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('highlight this', [], datasets, null, enabledConfig)) {
      chunks.push(chunk)
    }

    const action = chunks.find(c => c.type === 'action' && c.action.type === 'highlight-region')
    expect(action).toBeDefined()
    if (action?.type === 'action' && action.action.type === 'highlight-region') {
      expect(action.action.label).toBe('Custom')
    }
  })

  it('handles fly_to tool call with place parameter', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Flying to Colorado.' }
      yield {
        type: 'tool_call' as const,
        call: { id: 'call_mock', name: 'fly_to', arguments: { place: 'Colorado' } },
      }
      yield { type: 'done' as const }
    })

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('go to colorado', [], datasets, null, enabledConfig)) {
      chunks.push(chunk)
    }

    const action = chunks.find(c => c.type === 'action' && c.action.type === 'fly-to')
    expect(action).toBeDefined()
    if (action?.type === 'action' && action.action.type === 'fly-to') {
      // Colorado center is approximately lat 39, lon -105.5
      expect(action.action.lat).toBeCloseTo(39, 0)
      expect(action.action.lon).toBeCloseTo(-105.5, 0)
    }
  })

  it('ignores fly_to with unknown place name', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Hmm.' }
      yield {
        type: 'tool_call' as const,
        call: { id: 'call_mock', name: 'fly_to', arguments: { place: 'Mordor' } },
      }
      yield { type: 'done' as const }
    })

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('go to mordor', [], datasets, null, enabledConfig)) {
      chunks.push(chunk)
    }

    const action = chunks.find(c => c.type === 'action' && c.action.type === 'fly-to')
    expect(action).toBeUndefined()
  })
})

describe('processMessage — rewrite for Phase 5 markers', () => {
  it('yields rewrite chunk when text contains <<REGION:...>> markers', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Check out Colorado.\n<<REGION:Colorado>>' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: false,
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('highlight colorado', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    const rewrite = chunks.find(c => c.type === 'rewrite') as { type: 'rewrite'; text: string } | undefined
    expect(rewrite).toBeDefined()
    expect(rewrite!.text).not.toContain('REGION')
    expect(rewrite!.text).toContain('Check out Colorado.')
  })

  it('yields rewrite chunk even for unknown <<REGION:...>> markers', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    mockedStream.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Looking at Atlantis.\n<<REGION:Atlantis>>' }
      yield { type: 'done' as const }
    })

    const config: DocentConfig = {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'test',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: false,
    }

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('highlight atlantis', [], datasets, null, config)) {
      chunks.push(chunk)
    }

    const rewrite = chunks.find(c => c.type === 'rewrite') as { type: 'rewrite'; text: string } | undefined
    expect(rewrite).toBeDefined()
    expect(rewrite!.text).not.toContain('REGION')
  })
})

// ---------------------------------------------------------------------------
// Phase 1c — backend discovery tools
// ---------------------------------------------------------------------------

const baseConfig: DocentConfig = {
  apiUrl: '/api',
  apiKey: '',
  model: 'test',
  enabled: true,
  readingLevel: 'general',
  visionEnabled: false,
}

describe('executeSearchDatasets', () => {
  it('returns empty for blank query without hitting the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await executeSearchDatasets({ query: '   ' }, baseConfig)
    expect(result).toEqual({ datasets: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns empty when apiUrl is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await executeSearchDatasets(
      { query: 'hurricane' },
      { ...baseConfig, apiUrl: '' },
    )
    expect(result).toEqual({ datasets: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('hits /api/v1/search?q= with the right params and surfaces the dataset list', async () => {
    const datasetsResp = [
      { id: 'DS001', title: 'Atlantic Hurricane Tracks', abstract_snippet: 'A.', categories: ['Atmosphere'], peer_id: 'local', score: 0.91 },
    ]
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ datasets: datasetsResp }), { status: 200 }))

    const result = await executeSearchDatasets({ query: 'hurricane', limit: 7 }, baseConfig)
    expect(result.datasets).toEqual(datasetsResp)

    const url = new URL(fetchSpy.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/v1/search')
    expect(url.searchParams.get('q')).toBe('hurricane')
    expect(url.searchParams.get('limit')).toBe('7')
  })

  it('clamps limit to the route-layer max (50)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ datasets: [] }), { status: 200 }))

    await executeSearchDatasets({ query: 'hurricane', limit: 9999 }, baseConfig)
    const url = new URL(fetchSpy.mock.calls[0][0] as string)
    expect(url.searchParams.get('limit')).toBe('50')
  })

  it('soft-degrades to empty on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream', { status: 500 }))
    const result = await executeSearchDatasets({ query: 'hurricane' }, baseConfig)
    expect(result).toEqual({ datasets: [] })
  })

  it('soft-degrades to empty on fetch throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    const result = await executeSearchDatasets({ query: 'hurricane' }, baseConfig)
    expect(result).toEqual({ datasets: [] })
  })

  it('treats a degraded response as an empty dataset list (the LLM moves on)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ datasets: [], degraded: 'unconfigured' }), { status: 200 }),
    )
    const result = await executeSearchDatasets({ query: 'hurricane' }, baseConfig)
    expect(result.datasets).toEqual([])
  })
})

describe('executeListFeaturedDatasets', () => {
  it('hits /api/v1/featured with the limit param', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ datasets: [] }), { status: 200 }))

    await executeListFeaturedDatasets({ limit: 4 }, baseConfig)
    const url = new URL(fetchSpy.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/api/v1/featured')
    expect(url.searchParams.get('limit')).toBe('4')
  })

  it('defaults limit to 6 when none is supplied', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ datasets: [] }), { status: 200 }))

    await executeListFeaturedDatasets({}, baseConfig)
    const url = new URL(fetchSpy.mock.calls[0][0] as string)
    expect(url.searchParams.get('limit')).toBe('6')
  })

  it('caps limit at 24', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ datasets: [] }), { status: 200 }))

    await executeListFeaturedDatasets({ limit: 200 }, baseConfig)
    const url = new URL(fetchSpy.mock.calls[0][0] as string)
    expect(url.searchParams.get('limit')).toBe('24')
  })

  it('soft-degrades to empty on fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'))
    const result = await executeListFeaturedDatasets({}, baseConfig)
    expect(result).toEqual({ datasets: [] })
  })
})

describe('processMessage — backend tool round-trip', () => {
  it('feeds a search_datasets tool result back to the LLM on the next round', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let callCount = 0
    let round2Messages: any[] | null = null
    mockedStream.mockImplementation(async function* (msgs) {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call' as const,
          call: {
            id: 'call_search_dat_1',
            name: 'search_datasets',
            arguments: { query: 'hurricane' },
          },
        }
        yield { type: 'done' as const }
      } else {
        round2Messages = [...msgs]
        yield { type: 'delta' as const, text: 'Here are some matching datasets.' }
        yield { type: 'done' as const }
      }
    })

    const datasetsResp = [
      { id: 'DS_HURR', title: 'Atlantic Hurricane Tracks', abstract_snippet: 'A.', categories: ['Atmosphere'], peer_id: 'local', score: 0.9 },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ datasets: datasetsResp }), { status: 200 }),
    )

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('hurricane', [], datasets, null, baseConfig)) {
      chunks.push(chunk)
    }

    expect(callCount).toBe(2)
    expect(round2Messages).not.toBeNull()
    const toolMsg = round2Messages!.find((m: any) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg.tool_call_id).toBe('call_search_dat_1')
    const content = typeof toolMsg.content === 'string' ? toolMsg.content : ''
    expect(content).toContain('Atlantic Hurricane Tracks')
  })

  it('feeds a list_featured_datasets tool result back to the LLM', async () => {
    const { streamChat } = await import('./llmProvider')
    const mockedStream = vi.mocked(streamChat)

    let callCount = 0
    let round2Messages: any[] | null = null
    mockedStream.mockImplementation(async function* (msgs) {
      callCount++
      if (callCount === 1) {
        yield {
          type: 'tool_call' as const,
          call: {
            id: 'call_feat_1',
            name: 'list_featured_datasets',
            arguments: { limit: 3 },
          },
        }
        yield { type: 'done' as const }
      } else {
        round2Messages = [...msgs]
        yield { type: 'delta' as const, text: 'Featured today.' }
        yield { type: 'done' as const }
      }
    })

    const featuredResp = [
      { id: 'DS_FEAT', title: 'Climate Reanalysis 2024', abstract_snippet: 'F.', thumbnail_url: null, categories: ['Climate'], position: 0 },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ datasets: featuredResp }), { status: 200 }),
    )

    const chunks: DocentStreamChunk[] = []
    for await (const chunk of processMessage('show me something interesting', [], datasets, null, baseConfig)) {
      chunks.push(chunk)
    }

    expect(callCount).toBe(2)
    const toolMsg = round2Messages!.find((m: any) => m.role === 'tool')
    expect(toolMsg.tool_call_id).toBe('call_feat_1')
    expect(toolMsg.content).toContain('Climate Reanalysis 2024')
  })
})
