import { describe, it, expect } from 'vitest'
import { normalizeTitle, recommendRelated, scoreRelatedness } from './relatedDatasets'
import type { Dataset } from '../types'

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'test-1',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data.mp4',
    ...overrides,
  }
}

describe('scoreRelatedness', () => {
  it('returns 0 for the same dataset (no self-recommendation)', () => {
    const d = makeDataset({
      enriched: { categories: { Atmosphere: ['Temperature'] }, keywords: ['climate'] },
    })
    expect(scoreRelatedness(d, d)).toBe(0)
  })

  it('returns 0 when neither categories nor keywords overlap', () => {
    const a = makeDataset({
      id: 'a',
      enriched: { categories: { Atmosphere: ['Temperature'] }, keywords: ['climate'] },
    })
    const b = makeDataset({
      id: 'b',
      enriched: { categories: { Ocean: ['Currents'] }, keywords: ['biology'] },
    })
    expect(scoreRelatedness(a, b)).toBe(0)
  })

  it('weights categories at 2× keywords', () => {
    const target = makeDataset({
      id: 't',
      enriched: { categories: { Atmosphere: ['Temperature'] }, keywords: ['sst', 'climate'] },
    })
    // Same category alone → 2 points
    const catMatch = makeDataset({
      id: 'cat',
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    expect(scoreRelatedness(target, catMatch)).toBe(2)

    // Same keywords alone → 1 per match
    const kwMatch = makeDataset({
      id: 'kw',
      enriched: { keywords: ['sst', 'climate'] },
    })
    expect(scoreRelatedness(target, kwMatch)).toBe(2)
  })

  it('treats categories as group:value tokens, not bare leaf strings', () => {
    const target = makeDataset({
      id: 't',
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    // Same leaf "Temperature" but under a different group — should NOT match.
    const sameLeaf = makeDataset({
      id: 'other',
      enriched: { categories: { Ocean: ['Temperature'] } },
    })
    expect(scoreRelatedness(target, sameLeaf)).toBe(0)
  })

  it('falls back to tags when enriched categories are absent', () => {
    const target = makeDataset({ id: 't', tags: ['Air', 'Climate'] })
    const candidate = makeDataset({ id: 'c', tags: ['Air', 'Water'] })
    expect(scoreRelatedness(target, candidate)).toBeGreaterThan(0)
  })

  it('lowercases keywords so case variation does not lose a match', () => {
    const target = makeDataset({
      id: 't',
      enriched: { keywords: ['Climate', 'SST'] },
    })
    const candidate = makeDataset({
      id: 'c',
      enriched: { keywords: ['climate', 'sst'] },
    })
    expect(scoreRelatedness(target, candidate)).toBe(2)
  })
})

describe('recommendRelated', () => {
  it('returns an empty list when no candidate clears the min-score threshold', () => {
    const target = makeDataset({
      id: 't',
      enriched: { keywords: ['unique'] },
    })
    const catalog = [
      makeDataset({ id: 'a', enriched: { keywords: ['nothing'] } }),
      makeDataset({ id: 'b', enriched: { keywords: ['shared-once'] } }),
    ]
    expect(recommendRelated(target, catalog)).toEqual([])
  })

  it('orders results by descending score', () => {
    const target = makeDataset({
      id: 't',
      enriched: {
        categories: { Atmosphere: ['Temperature'] },
        keywords: ['sst', 'climate', 'noaa'],
      },
    })
    const weakerByCategory = makeDataset({
      id: 'weaker',
      title: 'Weaker',
      // 2 (category) + 1 (one keyword) = 3
      enriched: { categories: { Atmosphere: ['Temperature'] }, keywords: ['climate'] },
    })
    const strongerByCategory = makeDataset({
      id: 'stronger',
      title: 'Stronger',
      // 2 (category) + 2 (two keywords) = 4
      enriched: { categories: { Atmosphere: ['Temperature'] }, keywords: ['climate', 'sst'] },
    })

    const ranked = recommendRelated(target, [weakerByCategory, strongerByCategory])
    expect(ranked.map((d) => d.id)).toEqual(['stronger', 'weaker'])
  })

  it('caps the result list at 5 entries', () => {
    const target = makeDataset({
      id: 't',
      enriched: { keywords: ['climate', 'ocean'] },
    })
    const catalog = Array.from({ length: 12 }, (_, i) =>
      makeDataset({
        id: `c-${i}`,
        title: `Candidate ${i}`,
        enriched: { keywords: ['climate', 'ocean'] },
      }),
    )
    expect(recommendRelated(target, catalog).length).toBe(5)
  })

  it('excludes the target dataset from its own recommendations', () => {
    const target = makeDataset({
      id: 't',
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    const ranked = recommendRelated(target, [target])
    expect(ranked).toEqual([])
  })

  it('excludes hidden datasets from recommendations', () => {
    const target = makeDataset({
      id: 't',
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    const hidden = makeDataset({
      id: 'hidden',
      isHidden: true,
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    expect(recommendRelated(target, [hidden])).toEqual([])
  })

  it('honours excludeIds (de-dupe against manual related-dataset list)', () => {
    const target = makeDataset({
      id: 't',
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    const manual = makeDataset({
      id: 'manual',
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    const algorithmic = makeDataset({
      id: 'algo',
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    const ranked = recommendRelated(target, [manual, algorithmic], new Set(['manual']))
    expect(ranked.map((d) => d.id)).toEqual(['algo'])
  })

  it('honours manualTitles to suppress same-title (different-id) duplicates', () => {
    const target = makeDataset({
      id: 't',
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    const matchingTitle = makeDataset({
      id: 'movie-version',
      title: 'Sea Ice (Movie)',
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    const ranked = recommendRelated(
      target,
      [matchingTitle],
      new Set(),
      new Set(['sea ice']),
    )
    expect(ranked).toEqual([])
  })

  it('breaks score ties by weight, then title', () => {
    const target = makeDataset({
      id: 't',
      enriched: { categories: { Atmosphere: ['Temperature'] } },
    })
    const sameScore: Dataset[] = [
      makeDataset({
        id: 'b',
        title: 'B',
        weight: 0,
        enriched: { categories: { Atmosphere: ['Temperature'] } },
      }),
      makeDataset({
        id: 'a',
        title: 'A',
        weight: 5,
        enriched: { categories: { Atmosphere: ['Temperature'] } },
      }),
      makeDataset({
        id: 'c',
        title: 'C',
        weight: 0,
        enriched: { categories: { Atmosphere: ['Temperature'] } },
      }),
    ]
    const ranked = recommendRelated(target, sameScore)
    // 'a' first (highest weight), then 'b' and 'c' alphabetically.
    expect(ranked.map((d) => d.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('normalizeTitle', () => {
  it('strips "(Movie)" markers and lowercases', () => {
    expect(normalizeTitle('Sea Ice (Movie)')).toBe('sea ice')
    expect(normalizeTitle('Sea Ice')).toBe('sea ice')
    expect(normalizeTitle('  SEA ICE  ')).toBe('sea ice')
  })
})
