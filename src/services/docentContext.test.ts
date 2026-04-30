import { describe, it, expect } from 'vitest'
import type { Dataset, ChatMessage } from '../types'
import {
  buildCategorySummary,
  buildCurrentDatasetContext,
  buildSystemPrompt,
  buildMessageHistory,
  buildCompressedHistory,
  summarizeOlderMessages,
  getSearchCatalogTool,
  getSearchDatasetsTool,
  getListFeaturedDatasetsTool,
  getLoadDatasetTool,
  getFlyToTool,
  getSetTimeTool,
  getFitBoundsTool,
  getAddMarkerTool,
  getToggleLabelsTool,
  getHighlightRegionTool,
  buildViewContextSection,
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

describe('getSearchCatalogTool', () => {
  it('returns a function-type tool schema', () => {
    const tool = getSearchCatalogTool()
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('search_catalog')
  })

  it('requires a query parameter', () => {
    const tool = getSearchCatalogTool()
    const params = tool.function.parameters as Record<string, unknown>
    expect(params.required).toEqual(['query'])
    const props = params.properties as Record<string, { type: string }>
    expect(props.query.type).toBe('string')
  })

  it('accepts an optional limit parameter', () => {
    const tool = getSearchCatalogTool()
    const params = tool.function.parameters as Record<string, unknown>
    const props = params.properties as Record<string, { type: string }>
    expect(props.limit.type).toBe('number')
  })

  it('description explains catalog-as-tool pattern', () => {
    const tool = getSearchCatalogTool()
    // Reviewer-facing reminder that the prompt depends on this tool being
    // called rather than the catalog being stuffed in the system prompt.
    expect(tool.function.description).toMatch(/search.*catalog/i)
  })
})

describe('getSearchDatasetsTool (Phase 1c)', () => {
  it('returns the search_datasets function tool', () => {
    const tool = getSearchDatasetsTool()
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('search_datasets')
  })

  it('requires a query parameter', () => {
    const tool = getSearchDatasetsTool()
    const params = tool.function.parameters as Record<string, unknown>
    expect(params.required).toEqual(['query'])
    const props = params.properties as Record<string, { type: string }>
    expect(props.query.type).toBe('string')
  })

  it('caps limit at the route-layer maximum (50)', () => {
    const tool = getSearchDatasetsTool()
    const params = tool.function.parameters as Record<string, unknown>
    const props = params.properties as Record<string, { maximum: number }>
    expect(props.limit.maximum).toBe(50)
  })

  it('description flags it as semantic / vector search', () => {
    const tool = getSearchDatasetsTool()
    expect(tool.function.description).toMatch(/semantic|vector/i)
  })
})

describe('getListFeaturedDatasetsTool (Phase 1c)', () => {
  it('returns the list_featured_datasets function tool', () => {
    const tool = getListFeaturedDatasetsTool()
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('list_featured_datasets')
  })

  it('takes no required parameters', () => {
    const tool = getListFeaturedDatasetsTool()
    const params = tool.function.parameters as Record<string, unknown>
    expect(params.required).toBeUndefined()
  })

  it('caps limit at the route-layer maximum (24)', () => {
    const tool = getListFeaturedDatasetsTool()
    const params = tool.function.parameters as Record<string, unknown>
    const props = params.properties as Record<string, { maximum: number }>
    expect(props.limit.maximum).toBe(24)
  })

  it('description targets cold-start prompts', () => {
    const tool = getListFeaturedDatasetsTool()
    expect(tool.function.description).toMatch(/cold[- ]start|interesting|where to start/i)
  })
})

describe('buildSystemPrompt', () => {
  it('includes docent role description', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain('Orbit')
  })

  it('includes current dataset context', () => {
    const prompt = buildSystemPrompt(datasets, makeDataset())
    expect(prompt).toContain('Sea Surface Temperature')
  })

  it('does NOT stuff the dataset catalog into the prompt', () => {
    // Phase 3: the full catalog is retrieved via the search_catalog tool,
    // not embedded in the system prompt. Verify no dataset IDs leak in.
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).not.toContain('TEST_001')
    expect(prompt).not.toContain('TEST_002')
    // And that the old "Dataset Reference" section heading is gone
    expect(prompt).not.toContain('Dataset Reference')
  })

  it('instructs the LLM to use search_catalog for recommendations', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain('search_catalog')
  })

  it('instructs the LLM to call tools silently (no narration)', () => {
    // Regression: early Phase 3 preview observed the LLM narrating tool
    // calls in prose ("Here's a search for...") — the prompt now explicitly
    // forbids this. See PR #27 screenshot discussion for context.
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toMatch(/CALL TOOLS SILENTLY/i)
    expect(prompt).toContain('do NOT narrate')
  })

  it('requires a <<LOAD:...>> marker for every dataset recommended from tool results', () => {
    // Regression: the preview showed the LLM listing dataset titles in prose
    // without load markers, so no Load buttons appeared. The prompt now
    // spells out that markers are MANDATORY for every title mentioned from
    // a search_catalog result.
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toMatch(/MANDATORY.*<<LOAD:/i)
  })

  it('restricts the "I do not have a dataset" preface to zero-results only', () => {
    // Regression: the original prompt told the LLM to prefix fallback
    // results with "I don't have a dataset for that specific topic, but
    // here are some related ones" — which the model then used even when
    // search_catalog returned real (if semantically adjacent) results,
    // producing self-contradictory output. The prompt now reserves that
    // phrase for the zero-results case ONLY.
    const prompt = buildSystemPrompt(datasets, null)
    // The phrase should still appear (for the true zero-results case)
    // but the rule should now explicitly restrict it.
    expect(prompt).toContain('ONLY for the case')
    expect(prompt).toContain('zero entries')
  })

  it('still includes current dataset context on follow-up conversations', () => {
    // buildSystemPrompt is called per-request; the dataset context reflects
    // whatever is currently loaded on the globe regardless of turn index.
    const prompt = buildSystemPrompt(datasets, makeDataset())
    expect(prompt).toContain('Sea Surface Temperature')
    expect(prompt).toContain('Currently loaded')
  })

  it('injects no extra instructions for general reading level', () => {
    const prompt = buildSystemPrompt(datasets, null, 'general')
    expect(prompt).not.toContain('Reading Level')
  })

  it('defaults to general when no reading level is specified', () => {
    const withDefault = buildSystemPrompt(datasets, null)
    const withGeneral = buildSystemPrompt(datasets, null, 'general')
    expect(withDefault).toBe(withGeneral)
  })

  it('injects young-learner instructions', () => {
    const prompt = buildSystemPrompt(datasets, null, 'young-learner')
    expect(prompt).toContain('Reading Level: Young Learner')
    expect(prompt).toContain('curious 10-year-old')
  })

  it('injects in-depth instructions', () => {
    const prompt = buildSystemPrompt(datasets, null, 'in-depth')
    expect(prompt).toContain('Reading Level: In-Depth')
    expect(prompt).toContain('250 words')
  })

  it('injects expert instructions that override default word limit', () => {
    const prompt = buildSystemPrompt(datasets, null, 'expert')
    expect(prompt).toContain('Reading Level: Expert')
    expect(prompt).toContain('ignore the default 150-word limit')
    expect(prompt).toContain('300 words')
  })

  // ------------------------------------------------------------------
  // Phase 1c — static prompt: catalog state no longer affects content
  // ------------------------------------------------------------------

  it('does NOT include the per-turn dataset count', () => {
    // The pre-1c prompt rendered "The collection has N datasets across..."
    // — it now ships a static description. Same prompt for any catalog
    // size; only currentDataset / readingLevel / etc shape it.
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).not.toMatch(/has\s+\d+\s+datasets across/i)
    expect(prompt).not.toMatch(/collection has \d+/i)
  })

  it('produces an identical prompt for catalogs of different sizes', () => {
    // Static-prompt invariant: feeding 0 datasets and many datasets
    // through `buildSystemPrompt` produces the same string when the
    // other inputs match.
    const small = buildSystemPrompt([], null)
    const large = buildSystemPrompt([...datasets, ...datasets, ...datasets], null)
    expect(large).toBe(small)
  })

  it('mentions the new search_datasets tool', () => {
    expect(buildSystemPrompt(datasets, null)).toContain('search_datasets')
  })

  it('mentions the new list_featured_datasets tool for cold-start prompts', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain('list_featured_datasets')
    expect(prompt).toMatch(/cold[- ]start|where to start|something interesting/i)
  })

  it('lists search_datasets as the primary discovery tool, search_catalog as the fallback (post-1d cutover)', () => {
    // Phase 1d/E flips the ordering set by 1c/L: with the catalog
    // backend provisioned and the SOS snapshot imported,
    // search_datasets is the default and search_catalog is the
    // empty-result fallback for self-hosters who haven't wired
    // Vectorize. Reverting this test alongside docentService.ts
    // and docentContext.ts is what a single git revert of the
    // cutover commit produces.
    const prompt = buildSystemPrompt(datasets, null)
    const searchCatalogAt = prompt.indexOf('search_catalog')
    const searchDatasetsAt = prompt.indexOf('search_datasets')
    expect(searchCatalogAt).toBeGreaterThan(-1)
    expect(searchDatasetsAt).toBeGreaterThan(-1)
    expect(searchDatasetsAt).toBeLessThan(searchCatalogAt)
  })

  it('tells the LLM to fall back to search_catalog when search_datasets returns empty', () => {
    // Critical anti-hallucination guard: production has Vectorize
    // unwired, so search_datasets returns `{datasets: [],
    // degraded: 'unconfigured'}`. Without an explicit fallback
    // instruction, some models invent IDs from training data.
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toMatch(/empty.*fall back to.*search_catalog/i)
    expect(prompt).toMatch(/never invent.*titles or IDs|never guess/i)
  })

  it('forbids inventing "related" dataset names without a fresh tool call', () => {
    // Real reply seen on PR #59 / catalog(1c/M):
    //   > Here are some related datasets:
    //   > This one shows sea ice extent in the Arctic.
    //   > Another option is
    //   > which shows ocean color data...
    // The first dataset was real (tool result, valid chip). The
    // "related" suggestions were fabricated — the LLM mentioned
    // dataset names it remembered from training-time knowledge,
    // markers got stripped, sentences turned into half-formed
    // prose. Guard the explicit instruction not to do this.
    const prompt = buildSystemPrompt(datasets, null)
    // The strict rule must call out related/similar datasets explicitly.
    expect(prompt).toMatch(/no exceptions for.*related/i)
    // The Guidelines line that originally said "Suggest related datasets
    // when relevant" must now require a tool call.
    expect(prompt).toMatch(/related.*MUST call a discovery tool first|must call.*discovery tool/i)
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

// Phase 3: `buildSystemPromptForTurn` was merged into `buildSystemPrompt`
// — the turn-aware catalog stuffing was replaced with the search_catalog
// tool. Reading-level and current-dataset tests for the renamed function
// live in the `buildSystemPrompt` describe block above.

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

describe('getFlyToTool', () => {
  it('returns a valid tool definition with lat, lon, place, and altitude', () => {
    const tool = getFlyToTool()
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('fly_to')
    expect(tool.function.parameters.properties).toHaveProperty('lat')
    expect(tool.function.parameters.properties).toHaveProperty('lon')
    expect(tool.function.parameters.properties).toHaveProperty('place')
    expect(tool.function.parameters.properties).toHaveProperty('altitude')
  })
})

describe('getSetTimeTool', () => {
  it('returns a valid tool definition with date required', () => {
    const tool = getSetTimeTool()
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('set_time')
    expect(tool.function.parameters.required).toContain('date')
    expect(tool.function.parameters.properties).toHaveProperty('date')
  })
})

describe('buildSystemPrompt — globe control tools', () => {
  it('includes fly_to and set_time instructions in system prompt', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain('fly_to')
    expect(prompt).toContain('set_time')
    expect(prompt).toContain('Globe Control Markers')
  })
})

describe('buildSystemPrompt — vision mode', () => {
  it('includes vision instructions when visionActive is true', () => {
    const prompt = buildSystemPrompt(datasets, null, 'general', true)
    expect(prompt).toContain('Vision Analysis Mode')
    expect(prompt).toContain('DATA VISUALIZATION')
    expect(prompt).toContain('loaded dataset')
  })

  it('omits vision instructions when visionActive is false', () => {
    const prompt = buildSystemPrompt(datasets, null, 'general', false)
    expect(prompt).not.toContain('Vision Analysis Mode')
  })

  it('omits vision instructions by default', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).not.toContain('Vision Analysis Mode')
  })

  it('combines vision with reading level instructions', () => {
    const prompt = buildSystemPrompt(datasets, null, 'expert', true)
    expect(prompt).toContain('Vision Analysis Mode')
    expect(prompt).toContain('Reading Level: Expert')
  })
})

// --- Phase 5: New tool definitions ---

describe('getFitBoundsTool', () => {
  it('returns a valid tool definition with required bounds params', () => {
    const tool = getFitBoundsTool()
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('fit_bounds')
    const required = tool.function.parameters.required as string[]
    expect(required).toContain('west')
    expect(required).toContain('south')
    expect(required).toContain('east')
    expect(required).toContain('north')
    expect(tool.function.parameters.properties).toHaveProperty('label')
  })
})

describe('getAddMarkerTool', () => {
  it('returns a valid tool definition with lat and lng required', () => {
    const tool = getAddMarkerTool()
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('add_marker')
    const required = tool.function.parameters.required as string[]
    expect(required).toContain('lat')
    expect(required).toContain('lng')
    expect(tool.function.parameters.properties).toHaveProperty('label')
  })
})

describe('getToggleLabelsTool', () => {
  it('returns a valid tool definition with visible required', () => {
    const tool = getToggleLabelsTool()
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('toggle_labels')
    const required = tool.function.parameters.required as string[]
    expect(required).toContain('visible')
  })
})

describe('getHighlightRegionTool', () => {
  it('returns a valid tool definition with name and geojson params', () => {
    const tool = getHighlightRegionTool()
    expect(tool.type).toBe('function')
    expect(tool.function.name).toBe('highlight_region')
    expect(tool.function.parameters.properties).toHaveProperty('name')
    expect(tool.function.parameters.properties).toHaveProperty('geojson')
    expect(tool.function.parameters.properties).toHaveProperty('label')
  })

  it('does not require any specific parameter (name or geojson)', () => {
    const tool = getHighlightRegionTool()
    // Either name or geojson can be used, neither is strictly required
    expect(tool.function.parameters.required).toBeUndefined()
  })
})

// --- Phase 5: View context section ---

describe('buildViewContextSection', () => {
  it('returns empty string for null context', () => {
    expect(buildViewContextSection(null)).toBe('')
  })

  it('includes center coordinates', () => {
    const ctx = buildViewContextSection({
      center: { lat: 40.0, lng: -105.3 },
      zoom: 4.5,
      bearing: 0,
      pitch: 0,
      bounds: { west: -140, south: 10, east: -60, north: 60 },
      visibleCountries: [],
      visibleOceans: [],
    })
    expect(ctx).toContain('40.0')
    expect(ctx).toContain('105.3')
  })

  it('includes zoom level', () => {
    const ctx = buildViewContextSection({
      center: { lat: 0, lng: 0 },
      zoom: 3.2,
      bearing: 0,
      pitch: 0,
      bounds: { west: -90, south: -45, east: 90, north: 45 },
      visibleCountries: [],
      visibleOceans: [],
    })
    expect(ctx).toContain('3.2')
  })

  it('includes visible countries when present', () => {
    const ctx = buildViewContextSection({
      center: { lat: 0, lng: 0 },
      zoom: 3,
      bearing: 0,
      pitch: 0,
      bounds: { west: -90, south: -45, east: 90, north: 45 },
      visibleCountries: ['United States', 'Canada', 'Mexico'],
      visibleOceans: [],
    })
    expect(ctx).toContain('United States')
    expect(ctx).toContain('Canada')
    expect(ctx).toContain('Mexico')
  })

  it('includes visible oceans when present', () => {
    const ctx = buildViewContextSection({
      center: { lat: 0, lng: 0 },
      zoom: 2,
      bearing: 0,
      pitch: 0,
      bounds: { west: -180, south: -60, east: 180, north: 60 },
      visibleCountries: [],
      visibleOceans: ['Pacific Ocean', 'Atlantic Ocean'],
    })
    expect(ctx).toContain('Pacific Ocean')
    expect(ctx).toContain('Atlantic Ocean')
  })

  it('truncates long country lists with count', () => {
    const countries = Array.from({ length: 20 }, (_, i) => `Country ${i}`)
    const ctx = buildViewContextSection({
      center: { lat: 0, lng: 0 },
      zoom: 1,
      bearing: 0,
      pitch: 0,
      bounds: { west: -180, south: -90, east: 180, north: 90 },
      visibleCountries: countries,
      visibleOceans: [],
    })
    expect(ctx).toContain('+5 more')
    expect(ctx).toContain('Country 0')
    expect(ctx).not.toContain('Country 19')
  })
})

// --- Phase 5: System prompt includes new markers ---

describe('buildSystemPrompt — Phase 5 markers', () => {
  it('includes BOUNDS marker instructions', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain('<<BOUNDS:')
  })

  it('includes MARKER marker instructions', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain('<<MARKER:')
  })

  it('includes LABELS marker instructions', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain('<<LABELS:')
  })

  it('includes REGION marker instructions', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).toContain('<<REGION:')
  })

  it('includes geographic context when mapViewContext is provided', () => {
    const prompt = buildSystemPrompt(datasets, null, 'general', false, null, null, null, {
      center: { lat: 40.0, lng: -105.3 },
      zoom: 4.5,
      bearing: 0,
      pitch: 0,
      bounds: { west: -140, south: 10, east: -60, north: 60 },
      visibleCountries: ['United States'],
      visibleOceans: ['Pacific Ocean'],
    })
    expect(prompt).toContain('Geographic Context')
    expect(prompt).toContain('United States')
    expect(prompt).toContain('Pacific Ocean')
  })

  it('omits geographic context when mapViewContext is not provided', () => {
    const prompt = buildSystemPrompt(datasets, null)
    expect(prompt).not.toContain('Geographic Context')
  })
})
