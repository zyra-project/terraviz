import { describe, it, expect } from 'vitest'
import type { Dataset, ChatMessage } from '../types'
import {
  buildCategorySummary,
  buildCurrentDatasetContext,
  buildDatasetLookup,
  buildSystemPrompt,
  buildMessageHistory,
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

  it('respects limit', () => {
    const lookup = buildDatasetLookup(datasets, 1)
    const lines = lookup.split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(1)
  })

  it('includes category annotations', () => {
    const lookup = buildDatasetLookup(datasets)
    expect(lookup).toContain('[Ocean]')
  })
})

describe('buildSystemPrompt', () => {
  it('includes docent role description', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain('Digital Docent')
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

  it('trims to max 20 messages', () => {
    const messages: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      role: 'user' as const,
      text: `msg ${i}`,
      timestamp: i,
    }))
    const history = buildMessageHistory(messages)
    expect(history.length).toBeLessThanOrEqual(20)
    // Should keep the most recent
    expect(history[history.length - 1].content).toBe('msg 29')
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
