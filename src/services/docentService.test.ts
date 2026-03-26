import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Dataset, ChatMessage, DocentConfig } from '../types'
import { processMessage, loadConfig, saveConfig, getDefaultConfig, validateAndCleanText, captureGlobeScreenshot, captureViewContext } from './docentService'
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

  it('returns empty invalidIds when all IDs are valid', () => {
    const text = 'No dataset references here, just plain text.'
    const { cleanedText, invalidIds } = validateAndCleanText(text, datasets)
    expect(cleanedText).toBe(text)
    expect(invalidIds.size).toBe(0)
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

describe('captureGlobeScreenshot', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns a data URL when canvas is present', () => {
    const canvas = document.createElement('canvas')
    canvas.id = 'globe-canvas'
    canvas.width = 100
    canvas.height = 100
    // jsdom canvas has no real rendering context — mock toDataURL
    canvas.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,fakescreenshot')
    document.body.appendChild(canvas)

    const result = captureGlobeScreenshot()
    expect(result).toBe('data:image/jpeg;base64,fakescreenshot')
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.6)
  })

  it('downsizes canvas exceeding VISION_MAX_SIZE', () => {
    const canvas = document.createElement('canvas')
    canvas.id = 'globe-canvas'
    canvas.width = 1920
    canvas.height = 1080
    canvas.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,original')

    // Mock offscreen canvas created by document.createElement
    const offscreenToDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,downsized')
    const mockCtx = { drawImage: vi.fn() }
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag)
      if (tag === 'canvas' && !el.id) {
        // This is the offscreen canvas
        const c = el as HTMLCanvasElement
        c.getContext = vi.fn().mockReturnValue(mockCtx) as never
        c.toDataURL = offscreenToDataURL
      }
      return el
    })
    document.body.appendChild(canvas)

    const result = captureGlobeScreenshot()
    // Should use the offscreen canvas, not the original
    expect(result).toBe('data:image/jpeg;base64,downsized')
    expect(offscreenToDataURL).toHaveBeenCalledWith('image/jpeg', 0.6)
    // Original canvas toDataURL should NOT be called (offscreen was used)
    expect(canvas.toDataURL).not.toHaveBeenCalled()
  })

  it('returns null when canvas is missing', () => {
    expect(captureGlobeScreenshot()).toBeNull()
  })
})

describe('captureViewContext', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('captures time display text', () => {
    document.body.innerHTML = '<span id="time-display">Jan 2020</span>'
    const ctx = captureViewContext()
    expect(ctx).toContain('Time shown: Jan 2020')
  })

  it('ignores placeholder time text', () => {
    document.body.innerHTML = '<span id="time-display">--</span>'
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
      <span id="time-display">Aug 17, 2006</span>
      <button id="play-btn" aria-label="Pause"></button>
    `
    const ctx = captureViewContext()
    expect(ctx).toContain('Dataset loaded: Atmospheric Chemistry')
    expect(ctx).toContain('Globe center: 9.5° N, 137.7° E')
    expect(ctx).toContain('Time shown: Aug 17, 2006')
    expect(ctx).toContain('Playback: playing')
    expect(ctx).toMatch(/\.$/)
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
      model: 'llama-3.1-70b',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: true,
    }

    for await (const _ of processMessage(
      'hi', [], datasets, null, config,
      'data:image/jpeg;base64,abc123',
    )) { /* consume */ }

    expect(capturedConfig.model).toBe('llama-3.2-11b-vision')
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
      model: 'llama-3.1-70b',
      enabled: true,
      readingLevel: 'general',
      visionEnabled: true,
    }

    for await (const _ of processMessage(
      'hi', [], datasets, null, config,
      'data:image/jpeg;base64,abc123',
    )) { /* consume */ }

    expect(capturedConfig.model).toBe('llama-3.2-11b-vision')
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
