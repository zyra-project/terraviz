import { describe, it, expect } from 'vitest'
import type { Dataset, ChatMessage } from '../types'
import {
  buildCategorySummary,
  buildCurrentDatasetContext,
  buildDatasetLookup,
  buildSystemPrompt,
  buildSystemPromptForTurn,
  buildMessageHistory,
  buildCompressedHistory,
  summarizeOlderMessages,
  getLoadDatasetTool,
} from './docentContext'

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'TEST_001',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data',
    organization: 'NOAA',
    enriched: {
      description: 'Global sea surface temperature anomalies.',
      categories: { Ocean: ['Temperature'] },
      keywords: ['SST', 'ocean'],
    },
    ...overrides,
  }
}

const datasets = [
  makeDataset(),
  makeDataset({
    id: 'TEST_002',
    title: 'Hurricane Tracks',
    enriched: {
      description: 'Historical hurricane tracks.',
      categories: { Atmosphere: ['Hurricanes'] },
      keywords: ['hurricane'],
    },
  }),
]

describe('buildCategorySummary', () => {
  it('lists categories with counts', () => {
    const summary = buildCategorySummary(datasets)
    expect(summary).toContain('Ocean')
    expect(summary).toContain('Atmosphere')
    expect(summary).toContain('(1)')
  })

  it('handles datasets without categories', () => {
    const empty = [makeDataset({ enriched: undefined })]
    const summary = buildCategorySummary(empty)
    expect(summary).toBe('')
  })
})

describe('buildCurrentDatasetContext', () => {
  it('describes a loaded dataset', () => {
    const ctx = buildCurrentDatasetContext(makeDataset())
    expect(ctx).toContain('Sea Surface Temperature')
    expect(ctx).toContain('NOAA')
    expect(ctx).toContain('Ocean')
  })

  it('returns default message when no dataset loaded', () => {
    const ctx = buildCurrentDatasetContext(null)
    expect(ctx).toContain('default Earth')
  })

  it('includes time range when available', () => {
    const ds = makeDataset({
      startTime: '2020-01-01T00:00:00Z',
      endTime: '2020-12-31T00:00:00Z',
    })
    const ctx = buildCurrentDatasetContext(ds)
    expect(ctx).toContain('2020')
  })
})

describe('buildDatasetLookup', () => {
  it('lists datasets with IDs and titles', () => {
    const lookup = buildDatasetLookup(datasets)
    expect(lookup).toContain('TEST_001')
    expect(lookup).toContain('Sea Surface Temperature')
  })

  it('includes all datasets', () => {
    const lookup = buildDatasetLookup(datasets)
    const lines = lookup.split('\n').filter(Boolean)
    expect(lines.length).toBe(datasets.length)
  })

  it('includes category annotations', () => {
    const lookup = buildDatasetLookup(datasets)
    expect(lookup).toContain('[Ocean]')
  })
})

describe('buildSystemPrompt', () => {
  it('includes docent role description', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain('Orbit')
  })

  it('includes dataset count', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain(String(datasets.length))
  })

  it('includes current dataset context', () => {
    const prompt = buildSystemPrompt(datasets, makeDataset())
    expect(prompt).toContain('Sea Surface Temperature')
  })
})

describe('buildMessageHistory', () => {
  it('converts ChatMessages to LLM format', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', text: 'hello', timestamp: 1 },
      { id: '2', role: 'docent', text: 'Hi!', timestamp: 2 },
    ]
    const history = buildMessageHistory(messages)
    expect(history).toHaveLength(2)
    expect(history[0].role).toBe('user')
    expect(history[1].role).toBe('assistant')
  })

  it('trims to max 50 messages', () => {
    const messages: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      role: 'user' as const,
      text: `msg ${i}`,
      timestamp: i,
    }))
    const history = buildMessageHistory(messages)
    expect(history.length).toBeLessThanOrEqual(50)
    // Should keep the most recent
    expect(history[history.length - 1].content).toBe('msg 59')
  })
})

describe('buildSystemPromptForTurn', () => {
  it('includes dataset lookup on turn 0', () => {
    const prompt = buildSystemPromptForTurn(datasets, null, 0)
    expect(prompt).toContain('TEST_001')
    expect(prompt).toContain('Sea Surface Temperature')
  })

  it('uses compact dataset lookup on turn >= 1', () => {
    const prompt = buildSystemPromptForTurn(datasets, null, 1)
    // Compact lookup still includes IDs and titles
    expect(prompt).toContain('TEST_001')
    expect(prompt).toContain('Sea Surface Temperature')
    // But omits category annotations
    expect(prompt).not.toContain('[Ocean]')
    expect(prompt).toContain('compact')
  })

  it('still includes current dataset context on follow-up turns', () => {
    const prompt = buildSystemPromptForTurn(datasets, makeDataset(), 3)
    expect(prompt).toContain('Sea Surface Temperature')
    expect(prompt).toContain('Currently loaded')
  })

  it('injects no extra instructions for general reading level', () => {
    const prompt = buildSystemPromptForTurn(datasets, null, 0, 'general')
    expect(prompt).not.toContain('Reading Level')
  })

  it('defaults to general when no reading level is specified', () => {
    const withDefault = buildSystemPromptForTurn(datasets, null, 0)
    const withGeneral = buildSystemPromptForTurn(datasets, null, 0, 'general')
    expect(withDefault).toBe(withGeneral)
  })

  it('injects young-learner instructions', () => {
    const prompt = buildSystemPromptForTurn(datasets, null, 0, 'young-learner')
    expect(prompt).toContain('Reading Level: Young Learner')
    expect(prompt).toContain('curious 10-year-old')
  })

  it('injects in-depth instructions', () => {
    const prompt = buildSystemPromptForTurn(datasets, null, 0, 'in-depth')
    expect(prompt).toContain('Reading Level: In-Depth')
    expect(prompt).toContain('250 words')
  })

  it('injects expert instructions that override default word limit', () => {
    const prompt = buildSystemPromptForTurn(datasets, null, 0, 'expert')
    expect(prompt).toContain('Reading Level: Expert')
    expect(prompt).toContain('ignore the default 150-word limit')
    expect(prompt).toContain('300 words')
  })
})

describe('summarizeOlderMessages', () => {
  it('extracts topics from user messages', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', text: 'Tell me about hurricanes', timestamp: 1 },
      { id: '2', role: 'docent', text: 'Here are hurricane datasets', timestamp: 2 },
    ]
    const summary = summarizeOlderMessages(messages)
    expect(summary).toContain('hurricanes')
  })

  it('extracts loaded dataset titles from actions', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', text: 'oceans', timestamp: 1 },
      {
        id: '2', role: 'docent', text: 'Here', timestamp: 2,
        actions: [{ type: 'load-dataset', datasetId: 'T1', datasetTitle: 'Sea Surface Temp' }],
      },
    ]
    const summary = summarizeOlderMessages(messages)
    expect(summary).toContain('Sea Surface Temp')
  })

  it('returns empty string for no messages', () => {
    expect(summarizeOlderMessages([])).toBe('')
  })
})

describe('buildCompressedHistory', () => {
  it('returns all messages verbatim when under threshold', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', text: 'hello', timestamp: 1 },
      { id: '2', role: 'docent', text: 'Hi!', timestamp: 2 },
    ]
    const history = buildCompressedHistory(messages)
    expect(history).toHaveLength(2)
    expect(history[0].content).toBe('hello')
  })

  it('summarizes older messages and keeps recent verbatim', () => {
    const messages: ChatMessage[] = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      role: (i % 2 === 0 ? 'user' : 'docent') as 'user' | 'docent',
      text: `msg ${i}`,
      timestamp: i,
    }))
    const history = buildCompressedHistory(messages)
    // 6 recent messages + 1 summary = 7
    expect(history).toHaveLength(7)
    expect(history[0].role).toBe('system')
    expect(history[0].content).toContain('Conversation summary')
    // Last message should be the most recent
    expect(history[history.length - 1].content).toBe('msg 11')
  })

  it('includes dataset titles in summary from older actions', () => {
    const messages: ChatMessage[] = [
      { id: '0', role: 'user', text: 'oceans', timestamp: 0 },
      {
        id: '1', role: 'docent', text: 'Here', timestamp: 1,
        actions: [{ type: 'load-dataset', datasetId: 'T1', datasetTitle: 'Ocean Currents' }],
      },
      // 6 more recent messages
      ...Array.from({ length: 6 }, (_, i) => ({
        id: String(i + 2),
        role: (i % 2 === 0 ? 'user' : 'docent') as 'user' | 'docent',
        text: `recent ${i}`,
        timestamp: i + 2,
      })),
    ]
    const history = buildCompressedHistory(messages)
    const summaryMsg = history.find(m => m.role === 'system')
    expect(summaryMsg?.content).toContain('Ocean Currents')
  })
})

describe('getLoadDatasetTool', () => {
  it('returns a valid tool definition', () => {
    const tool = getLoadDatasetTool()
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('load_dataset')
    expect(tool.function.parameters).toBeDefined()
  })
})

describe('buildSystemPromptForTurn — vision mode', () => {
  it('includes vision instructions when visionActive is true', () => {
    const prompt = buildSystemPromptForTurn(datasets, null, 0, 'general', true)
    expect(prompt).toContain('Vision Analysis Mode')
    expect(prompt).toContain('screenshot')
    expect(prompt).toContain('loaded dataset')
  })

  it('omits vision instructions when visionActive is false', () => {
    const prompt = buildSystemPromptForTurn(datasets, null, 0, 'general', false)
    expect(prompt).not.toContain('Vision Analysis Mode')
  })

  it('omits vision instructions by default', () => {
    const prompt = buildSystemPromptForTurn(datasets, null, 0)
    expect(prompt).not.toContain('Vision Analysis Mode')
  })

  it('combines vision with reading level instructions', () => {
    const prompt = buildSystemPromptForTurn(datasets, null, 0, 'expert', true)
    expect(prompt).toContain('Vision Analysis Mode')
    expect(prompt).toContain('Reading Level: Expert')
  })
})
