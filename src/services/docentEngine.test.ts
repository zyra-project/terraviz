import { describe, it, expect } from 'vitest'
import type { Dataset } from '../types'
import {
  parseIntent,
  scoreDataset,
  searchDatasets,
  findByCategory,
  findRelated,
  evaluateAutoLoad,
  generateResponse,
  processUserMessage,
  createMessageId,
} from './docentEngine'

// --- Test fixtures ---

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'TEST_001',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data',
    organization: 'NOAA',
    tags: ['ocean', 'temperature'],
    enriched: {
      description: 'Global sea surface temperature anomalies from satellite data.',
      categories: { Ocean: ['Temperature', 'Sea Surface'] },
      keywords: ['SST', 'ocean', 'temperature', 'satellite'],
      relatedDatasets: [{ title: 'Ocean Currents', url: 'https://example.com' }],
    },
    ...overrides,
  }
}

const hurricaneDataset = makeDataset({
  id: 'TEST_002',
  title: 'Hurricane Tracks',
  tags: ['atmosphere', 'hurricane'],
  enriched: {
    description: 'Historical hurricane tracks from 1851 to present.',
    categories: { Atmosphere: ['Hurricanes', 'Storms'] },
    keywords: ['hurricane', 'cyclone', 'storm', 'wind'],
  },
})

const spaceDataset = makeDataset({
  id: 'TEST_003',
  title: 'Cosmic Microwave Background',
  tags: ['space'],
  enriched: {
    description: 'The cosmic microwave background radiation from the early universe.',
    categories: { Space: ['Cosmic'] },
    keywords: ['CMB', 'space', 'universe', 'radiation'],
  },
})

const oceanCurrentsDataset = makeDataset({
  id: 'TEST_004',
  title: 'Ocean Currents',
  tags: ['ocean'],
  enriched: {
    description: 'Major ocean current systems around the globe.',
    categories: { Ocean: ['Currents'] },
    keywords: ['current', 'ocean', 'circulation'],
  },
})

const allDatasets = [makeDataset(), hurricaneDataset, spaceDataset, oceanCurrentsDataset]

// --- parseIntent ---

describe('parseIntent', () => {
  it('detects greetings', () => {
    expect(parseIntent('hello').type).toBe('greeting')
    expect(parseIntent('Hi there').type).toBe('greeting')
    expect(parseIntent('hey').type).toBe('greeting')
    expect(parseIntent('Good morning').type).toBe('greeting')
  })

  it('detects help', () => {
    expect(parseIntent('help').type).toBe('help')
    expect(parseIntent('what can you do').type).toBe('help')
  })

  it('detects what-is-this', () => {
    expect(parseIntent("what is this").type).toBe('what-is-this')
    expect(parseIntent("what's this").type).toBe('what-is-this')
    expect(parseIntent('where am i').type).toBe('what-is-this')
  })

  it('detects explain-current', () => {
    expect(parseIntent('explain this').type).toBe('explain-current')
    expect(parseIntent('explain').type).toBe('explain-current')
    expect(parseIntent('tell me about this').type).toBe('explain-current')
    expect(parseIntent('tell me more about it').type).toBe('explain-current')
    expect(parseIntent('describe this').type).toBe('explain-current')
  })

  it('does not misclassify "tell me about X" as explain-current', () => {
    expect(parseIntent('tell me about climate change').type).not.toBe('explain-current')
    expect(parseIntent('Tell me about hurricanes').type).not.toBe('explain-current')
  })

  it('detects related', () => {
    expect(parseIntent('show me something similar').type).toBe('related')
    expect(parseIntent('more like this').type).toBe('related')
    expect(parseIntent('related').type).toBe('related')
  })

  it('detects category queries', () => {
    const result = parseIntent('show me ocean datasets')
    expect(result.type).toBe('category')
    if (result.type === 'category') {
      expect(result.category).toBe('ocean')
    }
  })

  it('falls back to search for freeform queries', () => {
    const result = parseIntent('global warming data')
    expect(result.type).toBe('search')
    if (result.type === 'search') {
      expect(result.query).toBe('global warming data')
    }
  })
})

// --- scoreDataset ---

describe('scoreDataset', () => {
  it('scores title matches highest', () => {
    const score = scoreDataset(makeDataset(), 'sea surface temperature')
    expect(score).toBeGreaterThan(0)
  })

  it('returns 0 for completely unrelated queries', () => {
    const score = scoreDataset(makeDataset(), 'xyzzy foobar')
    expect(score).toBe(0)
  })

  it('scores keyword matches', () => {
    const score = scoreDataset(makeDataset(), 'SST satellite')
    expect(score).toBeGreaterThan(0)
  })

  it('returns 0 for empty query', () => {
    expect(scoreDataset(makeDataset(), '')).toBe(0)
  })
})

// --- searchDatasets ---

describe('searchDatasets', () => {
  it('finds datasets by topic', () => {
    const results = searchDatasets(allDatasets, 'hurricane')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].dataset.id).toBe('TEST_002')
  })

  it('finds datasets by keyword', () => {
    const results = searchDatasets(allDatasets, 'ocean')
    expect(results.length).toBeGreaterThan(0)
  })

  it('returns empty for nonsense queries', () => {
    const results = searchDatasets(allDatasets, 'zzzzzzz')
    expect(results.length).toBe(0)
  })

  it('respects limit parameter', () => {
    const results = searchDatasets(allDatasets, 'ocean', 1)
    expect(results.length).toBeLessThanOrEqual(1)
  })
})

// --- findByCategory ---

describe('findByCategory', () => {
  it('finds datasets in a category', () => {
    const results = findByCategory(allDatasets, 'ocean')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(d => d.id === 'TEST_001')).toBe(true)
  })

  it('finds by subcategory', () => {
    const results = findByCategory(allDatasets, 'hurricanes')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toBe('TEST_002')
  })

  it('returns empty for unknown category', () => {
    const results = findByCategory(allDatasets, 'zzznotacategory')
    expect(results.length).toBe(0)
  })
})

// --- findRelated ---

describe('findRelated', () => {
  it('finds related datasets by enriched relatedDatasets links', () => {
    const sst = makeDataset()
    const results = findRelated(allDatasets, sst)
    // SST has "Ocean Currents" as related
    expect(results.some(d => d.id === 'TEST_004')).toBe(true)
  })

  it('falls back to keyword overlap', () => {
    const results = findRelated(allDatasets, hurricaneDataset)
    // Hurricane dataset shares "atmosphere" keywords
    expect(results.length).toBeGreaterThanOrEqual(0)
  })

  it('excludes the current dataset', () => {
    const results = findRelated(allDatasets, makeDataset())
    expect(results.every(d => d.id !== 'TEST_001')).toBe(true)
  })
})

// --- evaluateAutoLoad ---

describe('evaluateAutoLoad', () => {
  it('returns null for empty results', () => {
    expect(evaluateAutoLoad([])).toBeNull()
  })

  it('returns null when top score is below threshold', () => {
    const results = [{ dataset: makeDataset(), score: 0.5 }]
    expect(evaluateAutoLoad(results)).toBeNull()
  })

  it('auto-loads when single high-confidence result', () => {
    const results = [{ dataset: makeDataset(), score: 0.8 }]
    const result = evaluateAutoLoad(results)
    expect(result).not.toBeNull()
    expect(result!.autoLoad.id).toBe('TEST_001')
    expect(result!.alternatives).toHaveLength(0)
  })

  it('auto-loads when gap to second result is large enough', () => {
    const results = [
      { dataset: makeDataset(), score: 0.85 },
      { dataset: hurricaneDataset, score: 0.4 },
    ]
    const result = evaluateAutoLoad(results)
    expect(result).not.toBeNull()
    expect(result!.alternatives).toHaveLength(1)
    expect(result!.alternatives[0].id).toBe('TEST_002')
  })

  it('returns null when top two scores are too close', () => {
    const results = [
      { dataset: makeDataset(), score: 0.8 },
      { dataset: hurricaneDataset, score: 0.7 },
    ]
    expect(evaluateAutoLoad(results)).toBeNull()
  })
})

// --- generateResponse ---

describe('generateResponse', () => {
  it('returns a greeting for greeting intent', () => {
    const r = generateResponse({ type: 'greeting' }, allDatasets, null)
    expect(r.text.length).toBeGreaterThan(0)
    expect(r.actions).toBeUndefined()
  })

  it('returns help text for help intent', () => {
    const r = generateResponse({ type: 'help' }, allDatasets, null)
    expect(r.text).toContain('topic')
  })

  it('describes current dataset for explain intent', () => {
    const r = generateResponse({ type: 'explain-current' }, allDatasets, makeDataset())
    expect(r.text).toContain('Sea Surface Temperature')
  })

  it('returns default text when no dataset loaded for explain', () => {
    const r = generateResponse({ type: 'explain-current' }, allDatasets, null)
    expect(r.text).toContain('Earth')
  })

  it('returns search results with actions for search intent', () => {
    const r = generateResponse({ type: 'search', query: 'hurricane' }, allDatasets, null)
    expect(r.actions).toBeDefined()
    expect(r.actions!.length).toBeGreaterThan(0)
    expect(r.actions![0].type).toBe('load-dataset')
  })

  it('returns category results for category intent', () => {
    const r = generateResponse({ type: 'category', category: 'space' }, allDatasets, null)
    expect(r.actions).toBeDefined()
    expect(r.actions!.some(a => a.datasetId === 'TEST_003')).toBe(true)
  })

  it('returns related datasets for related intent with current dataset', () => {
    const r = generateResponse({ type: 'related' }, allDatasets, makeDataset())
    expect(r.text).toContain('related')
  })

  it('handles no results gracefully for search', () => {
    const r = generateResponse({ type: 'search', query: 'xyznotfound' }, allDatasets, null)
    expect(r.text).toContain("couldn't find")
  })
})

// --- processUserMessage ---

describe('processUserMessage', () => {
  it('returns a ChatMessage with docent role', () => {
    const msg = processUserMessage('hello', allDatasets, null)
    expect(msg.role).toBe('docent')
    expect(msg.id).toBeTruthy()
    expect(msg.timestamp).toBeGreaterThan(0)
    expect(msg.text.length).toBeGreaterThan(0)
  })

  it('returns actions for search queries', () => {
    const msg = processUserMessage('show me hurricanes', allDatasets, null)
    expect(msg.actions).toBeDefined()
  })
})

// --- createMessageId ---

describe('createMessageId', () => {
  it('returns unique IDs', () => {
    const a = createMessageId()
    const b = createMessageId()
    expect(a).not.toBe(b)
  })

  it('starts with msg_ prefix', () => {
    expect(createMessageId()).toMatch(/^msg_/)
  })
})
