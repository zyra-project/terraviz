// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import {
  buildGraph,
  datasetNodeId,
  facetValueNodeId,
  keywordNodeId,
  topCoOccurrences,
  type GraphNode,
} from './catalogGraph'
import type { Dataset } from '../types'

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'd1',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data.mp4',
    tags: ['Water'],
    ...overrides,
  }
}

describe('node ID helpers', () => {
  it('encodes facet-value IDs verbatim', () => {
    expect(facetValueNodeId('category', 'Water')).toBe('facet:category:Water')
    expect(facetValueNodeId('format', 'video')).toBe('facet:format:video')
  })

  it('lowercases keyword IDs so casing variants collapse', () => {
    expect(keywordNodeId('Hurricane')).toBe('keyword:hurricane')
    expect(keywordNodeId('HURRICANE')).toBe('keyword:hurricane')
  })

  it('namespaces dataset IDs', () => {
    expect(datasetNodeId('abc-123')).toBe('dataset:abc-123')
  })
})

describe('buildGraph — baseline shape', () => {
  it('emits one dataset node per filtered row plus category nodes by default', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd2', tags: ['Water'], format: 'image/jpeg' }),
      makeDataset({ id: 'd3', tags: ['Land'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {})

    const datasetNodes = graph.nodes.filter(n => n.kind === 'dataset')
    expect(datasetNodes).toHaveLength(3)
    expect(datasetNodes.map(n => n.id).sort()).toEqual([
      'dataset:d1', 'dataset:d2', 'dataset:d3',
    ])

    const categoryNodes = graph.nodes
      .filter((n): n is Extract<GraphNode, { kind: 'facet-value'; facet: string }> =>
        n.kind === 'facet-value' && n.facet === 'category')
    expect(categoryNodes.map(n => n.value).sort()).toEqual(['Land', 'Water'])

    // Format nodes are off by default — feedback from PR #137 review
    // was that they cluttered the discovery view; opt in via
    // includeFormatNodes: true.
    const formatNodes = graph.nodes
      .filter(n => n.kind === 'facet-value' && (n as { facet: string }).facet === 'format')
    expect(formatNodes).toHaveLength(0)

    expect(graph.filteredDatasetCount).toBe(3)
  })

  it('emits format nodes when includeFormatNodes is set', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd2', tags: ['Water'], format: 'image/jpeg' }),
    ]
    const graph = buildGraph(datasets, {}, '', { includeFormatNodes: true })
    const formatNodes = graph.nodes
      .filter((n): n is Extract<GraphNode, { kind: 'facet-value'; facet: string }> =>
        n.kind === 'facet-value' && n.facet === 'format')
    expect(formatNodes.map(n => n.value).sort()).toEqual(['image', 'video'])
  })

  it('counts memberships correctly per facet-value node', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }),
      makeDataset({ id: 'd2', tags: ['Water'] }),
      makeDataset({ id: 'd3', tags: ['Water'] }),
      makeDataset({ id: 'd4', tags: ['Land'] }),
    ]
    const graph = buildGraph(datasets, {})
    const waterNode = graph.nodes.find(n => n.id === facetValueNodeId('category', 'Water'))
    const landNode = graph.nodes.find(n => n.id === facetValueNodeId('category', 'Land'))
    expect(waterNode?.datasetCount).toBe(3)
    expect(landNode?.datasetCount).toBe(1)
  })

  it('assigns the right facet group / colour key to each node', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {}, '', { includeFormatNodes: true })
    const category = graph.nodes.find(n => n.id === facetValueNodeId('category', 'Water'))
    const format = graph.nodes.find(n => n.id === facetValueNodeId('format', 'video'))
    const dataset = graph.nodes.find(n => n.kind === 'dataset')
    expect(category?.group).toBe('category-content')
    expect(format?.group).toBe('format-medium')
    expect(dataset?.group).toBeNull()
  })

  it('emits a membership edge per (dataset, facet-value) pair', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water', 'Air'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {}, '', { includeFormatNodes: true })
    const membershipEdges = graph.edges.filter(e => e.kind === 'membership')
    // d1 attaches to: category:Water, category:Air, format:video → 3 edges
    expect(membershipEdges).toHaveLength(3)
    const targets = new Set(membershipEdges.map(e => e.source + '->' + e.target))
    expect(targets.size).toBe(3) // no duplicates
  })

  it('skips format-related membership edges when format nodes are off', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water', 'Air'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {})
    const membershipEdges = graph.edges.filter(e => e.kind === 'membership')
    // d1 attaches to: category:Water, category:Air → 2 edges (no format)
    expect(membershipEdges).toHaveLength(2)
  })

  it('respects filter state by passing it through to filterDatasets', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }),
      makeDataset({ id: 'd2', tags: ['Land'] }),
    ]
    const graph = buildGraph(datasets, {
      category: { kind: 'multi-select', values: ['Water'] },
    })
    expect(graph.filteredDatasetCount).toBe(1)
    expect(graph.nodes.filter(n => n.kind === 'dataset').map(n => n.id))
      .toEqual(['dataset:d1'])
    // Land node shouldn't appear — no dataset in the filtered set carries it.
    expect(graph.nodes.find(n => n.id === facetValueNodeId('category', 'Land')))
      .toBeUndefined()
  })

  it('honours prefix search tokens via parseSearchQuery, like the chip rail', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }),
      makeDataset({ id: 'd2', tags: ['Land'] }),
    ]
    const graph = buildGraph(datasets, {}, 'category:Water')
    expect(graph.filteredDatasetCount).toBe(1)
    expect(graph.nodes.find(n => n.id === 'dataset:d1')).toBeDefined()
    expect(graph.nodes.find(n => n.id === 'dataset:d2')).toBeUndefined()
  })

  it('excludes hidden datasets via filterDatasets', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }),
      makeDataset({ id: 'd2', tags: ['Water'], isHidden: true }),
    ]
    const graph = buildGraph(datasets, {})
    expect(graph.filteredDatasetCount).toBe(1)
  })
})

describe('buildGraph — co-occurrence', () => {
  it('omits co-occurrence edges when format nodes are off (the default)', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd2', tags: ['Water'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {})
    expect(graph.edges.filter(e => e.kind === 'co-occurrence')).toHaveLength(0)
  })

  it('emits one co-occurrence edge per (category, format) pair above the weight floor', () => {
    // 3 Water+video → weight 3; 1 Water+image → weight 1 (dropped at default 2);
    // 2 Land+video → weight 2 (kept)
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd2', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd3', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd4', tags: ['Water'], format: 'image/jpeg' }),
      makeDataset({ id: 'd5', tags: ['Land'], format: 'video/mp4' }),
      makeDataset({ id: 'd6', tags: ['Land'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {}, '', { includeFormatNodes: true })
    const coOcc = graph.edges.filter(e => e.kind === 'co-occurrence')
    const labelled = coOcc.map(e => ({
      pair: [e.source, e.target].sort().join('//'),
      weight: e.weight,
    }))
    expect(labelled).toContainEqual({
      pair: ['facet:category:Water', 'facet:format:video'].sort().join('//'),
      weight: 3,
    })
    expect(labelled).toContainEqual({
      pair: ['facet:category:Land', 'facet:format:video'].sort().join('//'),
      weight: 2,
    })
    // Water+image (weight 1) should be hidden at the default floor.
    expect(labelled.find(l => l.pair.includes('image'))).toBeUndefined()
  })

  it('honours minEdgeWeight = 1 to surface singletons', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd2', tags: ['Water'], format: 'image/jpeg' }),
    ]
    const graph = buildGraph(datasets, {}, '', { minEdgeWeight: 1, includeFormatNodes: true })
    const coOcc = graph.edges.filter(e => e.kind === 'co-occurrence')
    expect(coOcc).toHaveLength(2) // Water-video, Water-image
  })

  it('only emits cross-facet co-occurrence (no Category↔Category)', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water', 'Land'], format: 'video/mp4' }),
      makeDataset({ id: 'd2', tags: ['Water', 'Land'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {}, '', { includeFormatNodes: true })
    const coOcc = graph.edges.filter(e => e.kind === 'co-occurrence')
    // Should emit Water↔video and Land↔video but NOT Water↔Land.
    expect(coOcc.every(e => {
      const isCategory = (id: string) => id.startsWith('facet:category:')
      const isFormat = (id: string) => id.startsWith('facet:format:')
      return (isCategory(e.source) && isFormat(e.target)) ||
             (isFormat(e.source) && isCategory(e.target))
    })).toBe(true)
  })
})

describe('buildGraph — keyword expansion', () => {
  it('does not emit keyword nodes by default', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Water'],
        enriched: { keywords: ['hurricane', 'storm'] },
      }),
    ]
    const graph = buildGraph(datasets, {})
    expect(graph.nodes.find(n => n.kind === 'keyword')).toBeUndefined()
  })

  it('emits keyword nodes connected to the parent facet-value when expanded', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Water'],
        format: 'video/mp4',
        enriched: { keywords: ['hurricane', 'storm'] },
      }),
      makeDataset({
        id: 'd2',
        tags: ['Water'],
        format: 'video/mp4',
        enriched: { keywords: ['hurricane'] },
      }),
    ]
    const waterId = facetValueNodeId('category', 'Water')
    const graph = buildGraph(datasets, {}, '', {
      expandedKeywordParents: new Set([waterId]),
    })
    const keywordNodes = graph.nodes.filter(n => n.kind === 'keyword')
    expect(keywordNodes.map(n => n.id).sort()).toEqual([
      'keyword:hurricane', 'keyword:storm',
    ])
    const hurricane = keywordNodes.find(n => n.id === 'keyword:hurricane')
    expect(hurricane?.datasetCount).toBe(2)
  })

  it('only expands keywords whose datasets overlap with the expanded parent', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Water'],
        enriched: { keywords: ['hurricane'] },
      }),
      makeDataset({
        id: 'd2',
        tags: ['Land'],
        enriched: { keywords: ['drought'] },
      }),
    ]
    const waterId = facetValueNodeId('category', 'Water')
    const graph = buildGraph(datasets, {}, '', {
      expandedKeywordParents: new Set([waterId]),
    })
    const keywordNodes = graph.nodes.filter(n => n.kind === 'keyword')
    // Only `hurricane` should surface — `drought` lives under Land.
    expect(keywordNodes.map(n => n.id)).toEqual(['keyword:hurricane'])
  })

  it('falls back to tags when enriched.keywords is missing (mirrors keyword resolver)', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }), // no enriched
    ]
    const waterId = facetValueNodeId('category', 'Water')
    const graph = buildGraph(datasets, {}, '', {
      expandedKeywordParents: new Set([waterId]),
    })
    const keywords = graph.nodes.filter(n => n.kind === 'keyword')
    expect(keywords.map(n => n.value)).toEqual(['Water'])
  })

  it('deduplicates keyword nodes by case-insensitive value', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Water'],
        enriched: { keywords: ['Hurricane'] },
      }),
      makeDataset({
        id: 'd2',
        tags: ['Water'],
        enriched: { keywords: ['hurricane'] },
      }),
    ]
    const waterId = facetValueNodeId('category', 'Water')
    const graph = buildGraph(datasets, {}, '', {
      expandedKeywordParents: new Set([waterId]),
    })
    const keywords = graph.nodes.filter(n => n.kind === 'keyword')
    expect(keywords).toHaveLength(1)
    expect(keywords[0].datasetCount).toBe(2)
  })
})

describe('buildGraph — auto-expand keywords', () => {
  it('auto-expands the top-N keywords per Category cluster when opted in', () => {
    // Water cluster: hurricane × 3, storm × 2, mist × 1. Top-2 picks
    // are hurricane + storm; mist is dropped.
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], enriched: { keywords: ['hurricane', 'storm', 'mist'] } }),
      makeDataset({ id: 'd2', tags: ['Water'], enriched: { keywords: ['hurricane', 'storm'] } }),
      makeDataset({ id: 'd3', tags: ['Water'], enriched: { keywords: ['hurricane'] } }),
    ]
    const graph = buildGraph(datasets, {}, '', { autoExpandKeywordsPerCluster: 2 })
    const keywords = graph.nodes.filter(n => n.kind === 'keyword')
    expect(keywords.map(n => n.label).sort()).toEqual(['hurricane', 'storm'])
  })

  it('suppresses the tag-fallback echo so "Water" Category does not radiate "Water" keyword', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }), // no enriched.keywords → tag fallback
      makeDataset({ id: 'd2', tags: ['Water'], enriched: { keywords: ['storm'] } }),
    ]
    const graph = buildGraph(datasets, {}, '', { autoExpandKeywordsPerCluster: 6 })
    const keywords = graph.nodes.filter(n => n.kind === 'keyword')
    expect(keywords.map(n => n.label.toLowerCase())).not.toContain('water')
    expect(keywords.map(n => n.label.toLowerCase())).toContain('storm')
  })

  it('caps PER-CLUSTER, not globally, so each Category surfaces its own characteristic keywords', () => {
    const datasets: Dataset[] = [
      // Water: hurricane × 3
      makeDataset({ id: 'w1', tags: ['Water'], enriched: { keywords: ['hurricane'] } }),
      makeDataset({ id: 'w2', tags: ['Water'], enriched: { keywords: ['hurricane'] } }),
      makeDataset({ id: 'w3', tags: ['Water'], enriched: { keywords: ['hurricane'] } }),
      // Land: drought × 2
      makeDataset({ id: 'l1', tags: ['Land'], enriched: { keywords: ['drought'] } }),
      makeDataset({ id: 'l2', tags: ['Land'], enriched: { keywords: ['drought'] } }),
    ]
    const graph = buildGraph(datasets, {}, '', { autoExpandKeywordsPerCluster: 1 })
    const keywords = graph.nodes.filter(n => n.kind === 'keyword')
    expect(keywords.map(n => n.label).sort()).toEqual(['drought', 'hurricane'])
  })

  it('attaches an auto-expanded keyword only to clusters that picked it', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'w1', tags: ['Water'], enriched: { keywords: ['hurricane'] } }),
      makeDataset({ id: 'l1', tags: ['Land'], enriched: { keywords: ['drought'] } }),
    ]
    const graph = buildGraph(datasets, {}, '', { autoExpandKeywordsPerCluster: 6 })
    const hurricaneEdges = graph.edges
      .filter(e => e.source === 'keyword:hurricane' || e.target === 'keyword:hurricane')
    // hurricane should connect to its dataset (membership) and NOT to
    // the Land cluster (it only auto-expanded under Water).
    expect(hurricaneEdges.every(e =>
      e.source !== 'facet:category:Land' && e.target !== 'facet:category:Land',
    )).toBe(true)
  })

  it('reports datasetCount as the actually-connected count when a keyword spans multiple clusters but only one is expanded', () => {
    // Hurricane appears in 3 datasets globally (2 Water + 1 Land).
    // Only Water is expanded. The keyword's membership edges go
    // only to the 2 Water datasets (not the Land one). PR #137
    // review caught the discrepancy: pre-fix the tooltip would
    // show "3 datasets" while the rendered graph only showed 2
    // edges — disagreeing with what's actually on screen.
    const datasets: Dataset[] = [
      makeDataset({ id: 'w1', tags: ['Water'], enriched: { keywords: ['hurricane'] } }),
      makeDataset({ id: 'w2', tags: ['Water'], enriched: { keywords: ['hurricane'] } }),
      makeDataset({ id: 'l1', tags: ['Land'], enriched: { keywords: ['hurricane'] } }),
    ]
    const waterId = facetValueNodeId('category', 'Water')
    const graph = buildGraph(datasets, {}, '', {
      expandedKeywordParents: new Set([waterId]),
    })
    const hurricane = graph.nodes.find(n => n.id === 'keyword:hurricane')
    expect(hurricane?.datasetCount).toBe(2)
    // And verify the same value matches the rendered edges so the
    // tooltip / node-size mapping reads consistently with what
    // the user sees.
    const hurricaneDatasetEdges = graph.edges.filter(e =>
      (e.source === 'keyword:hurricane' && e.target.startsWith('dataset:')) ||
      (e.target === 'keyword:hurricane' && e.source.startsWith('dataset:')),
    )
    expect(hurricaneDatasetEdges).toHaveLength(2)
  })

  it('combines auto-expansion with explicit expandedKeywordParents — explicit parents surface ALL their keywords', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'w1', tags: ['Water'], enriched: { keywords: ['hurricane', 'storm', 'rare-kw'] } }),
    ]
    const waterId = facetValueNodeId('category', 'Water')
    const graph = buildGraph(datasets, {}, '', {
      autoExpandKeywordsPerCluster: 1, // auto would only pick 1
      expandedKeywordParents: new Set([waterId]), // but explicit expansion sees all 3
    })
    const keywords = graph.nodes.filter(n => n.kind === 'keyword')
    expect(keywords.map(n => n.label).sort()).toEqual(['hurricane', 'rare-kw', 'storm'])
  })

  it('does not auto-expand under Format clusters even when format nodes are on', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4', enriched: { keywords: ['hurricane'] } }),
    ]
    const graph = buildGraph(datasets, {}, '', {
      autoExpandKeywordsPerCluster: 6,
      includeFormatNodes: true,
    })
    const videoFormatId = facetValueNodeId('format', 'video')
    const keywordToVideoEdges = graph.edges.filter(e =>
      (e.source === 'keyword:hurricane' && e.target === videoFormatId) ||
      (e.target === 'keyword:hurricane' && e.source === videoFormatId),
    )
    expect(keywordToVideoEdges).toHaveLength(0)
  })
})

describe('topCoOccurrences', () => {
  it('returns the highest-weight co-occurring nodes desc', () => {
    const datasets: Dataset[] = [
      ...Array.from({ length: 5 }, (_, i) => makeDataset({
        id: `d${i}`, tags: ['Water'], format: 'video/mp4',
      })),
      ...Array.from({ length: 3 }, (_, i) => makeDataset({
        id: `e${i}`, tags: ['Water'], format: 'image/jpeg',
      })),
      ...Array.from({ length: 2 }, (_, i) => makeDataset({
        id: `f${i}`, tags: ['Water'], format: 'tour/json',
      })),
    ]
    const graph = buildGraph(datasets, {}, '', { includeFormatNodes: true })
    const top = topCoOccurrences(graph, facetValueNodeId('category', 'Water'), 3)
    expect(top.map(t => t.neighbourId)).toEqual([
      facetValueNodeId('format', 'video'),
      facetValueNodeId('format', 'image'),
      facetValueNodeId('format', 'tour'),
    ])
    expect(top[0].weight).toBe(5)
  })

  it('respects the limit argument', () => {
    const datasets: Dataset[] = [
      ...Array.from({ length: 5 }, (_, i) => makeDataset({
        id: `d${i}`, tags: ['Water'], format: 'video/mp4',
      })),
      ...Array.from({ length: 3 }, (_, i) => makeDataset({
        id: `e${i}`, tags: ['Water'], format: 'image/jpeg',
      })),
    ]
    const graph = buildGraph(datasets, {}, '', { includeFormatNodes: true })
    const top = topCoOccurrences(graph, facetValueNodeId('category', 'Water'), 1)
    expect(top).toHaveLength(1)
  })
})
