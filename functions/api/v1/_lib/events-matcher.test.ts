// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Unit tests for the current-events geo/temporal matcher. The pure
 * scoring functions are exercised directly; `runMatcherForEvent` runs
 * against the real migration SQL via the `asD1` / `seedFixtures`
 * harness.
 */

import { describe, it, expect } from 'vitest'
import { asD1, seedFixtures } from './test-helpers'
import { insertCurrentEvent, listLinksForEvent } from './events-store'
import {
  scoreGeo,
  scoreTemporal,
  isLiveDataset,
  scoreMatch,
  proposeMatches,
  runMatcherForEvent,
  tokenize,
  buildEventTerms,
  buildDatasetTerms,
  buildEventEmbeddingText,
  blendTopical,
  buildIdf,
  scoreLexical,
  SEMANTIC_WEIGHT,
  TEMPORAL_HORIZON_MS,
  type MatchDataset,
  type MatcherEnv,
} from './events-matcher'
import { embedDatasetText } from './embeddings'
import { upsertEmbedding, __clearMockStore } from './vectorize-store'

const NOW = Date.parse('2026-06-26T00:00:00.000Z')
const DAY = 86_400_000

function seededDatasetId(i: number): string {
  return `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)
}

describe('scoreGeo', () => {
  it('returns null when there is no dataset box', () => {
    expect(scoreGeo({ boundingBox: { n: 1, s: 0, w: 0, e: 1 } }, null)).toBeNull()
    expect(scoreGeo({ boundingBox: { n: 1, s: 0, w: 0, e: 1 } }, undefined)).toBeNull()
  })

  it('returns null when the event has no geometry', () => {
    expect(scoreGeo({}, { n: 1, s: 0, w: 0, e: 1 })).toBeNull()
  })

  it('scores identical boxes as 1 and disjoint boxes as 0', () => {
    const box = { n: 10, s: 0, w: 0, e: 10 }
    expect(scoreGeo({ boundingBox: box }, box)).toBeCloseTo(1)
    expect(scoreGeo({ boundingBox: { n: 30, s: 20, w: 20, e: 30 } }, box)).toBe(0)
  })

  it('computes intersection-over-union for partial overlap', () => {
    // a = 10x10 = 100, b = 10x10 = 100, intersection = 5x5 = 25 → IoU = 25/175
    const a = { n: 10, s: 0, w: 0, e: 10 }
    const b = { n: 15, s: 5, w: 5, e: 15 }
    expect(scoreGeo({ boundingBox: a }, b)).toBeCloseTo(25 / 175)
  })

  it('scores an event point 1 inside the box and 0 outside', () => {
    const box = { n: 10, s: 0, w: 0, e: 10 }
    expect(scoreGeo({ point: { lat: 5, lon: 5 } }, box)).toBe(1)
    expect(scoreGeo({ point: { lat: 50, lon: 50 } }, box)).toBe(0)
  })
})

describe('isLiveDataset', () => {
  it('is false without a parseable period', () => {
    expect(isLiveDataset({ id: 'x', period: null }, NOW)).toBe(false)
    expect(isLiveDataset({ id: 'x', period: 'nonsense' }, NOW)).toBe(false)
  })

  it('is true for a recurring period with no end', () => {
    expect(isLiveDataset({ id: 'x', period: 'PT15M' }, NOW)).toBe(true)
  })

  it('is true when the end is within two cadences of now, false beyond', () => {
    const fresh = new Date(NOW - 20 * 60_000).toISOString() // 20 min ago
    const stale = new Date(NOW - 60 * 60_000).toISOString() // 60 min ago
    expect(isLiveDataset({ id: 'x', period: 'PT15M', endTime: fresh }, NOW)).toBe(true)
    expect(isLiveDataset({ id: 'x', period: 'PT15M', endTime: stale }, NOW)).toBe(false)
  })
})

describe('scoreTemporal', () => {
  const liveDs: MatchDataset = { id: 'live', startTime: '2026-01-01T00:00:00Z', period: 'PT15M' }

  it('returns null when the event has no start', () => {
    expect(scoreTemporal({}, liveDs, NOW)).toBeNull()
  })

  it('returns null when the dataset has no timestamps', () => {
    expect(
      scoreTemporal({ occurredStart: '2026-06-26T00:00:00Z' }, { id: 'x', period: 'PT15M' }, NOW),
    ).toBeNull()
  })

  it('scores 1 when the event falls inside a live dataset coverage (extended to now)', () => {
    // live dataset started in Jan with no end → coverage runs to now;
    // an event today overlaps.
    expect(scoreTemporal({ occurredStart: '2026-06-25T12:00:00Z' }, liveDs, NOW)).toBe(1)
  })

  it('scores 1 when the event interval overlaps a static dataset window', () => {
    const staticDs: MatchDataset = {
      id: 's',
      startTime: '2020-01-01T00:00:00Z',
      endTime: '2020-12-31T00:00:00Z',
    }
    expect(scoreTemporal({ occurredStart: '2020-06-01T00:00:00Z' }, staticDs, NOW)).toBe(1)
  })

  it('decays with the gap for a non-overlapping static dataset', () => {
    const staticDs: MatchDataset = {
      id: 's',
      startTime: '2020-01-01T00:00:00Z',
      endTime: '2020-01-02T00:00:00Z',
    }
    // event 7 days after the window end → 1 - 7/14 = 0.5
    const sevenDaysAfter = new Date(Date.parse('2020-01-02T00:00:00Z') + 7 * DAY).toISOString()
    expect(scoreTemporal({ occurredStart: sevenDaysAfter }, staticDs, NOW)).toBeCloseTo(0.5)
    // event one horizon past the end → 0
    const horizonAfter = new Date(
      Date.parse('2020-01-02T00:00:00Z') + TEMPORAL_HORIZON_MS,
    ).toISOString()
    expect(scoreTemporal({ occurredStart: horizonAfter }, staticDs, NOW)).toBeCloseTo(0)
  })
})

describe('scoreMatch', () => {
  it('averages the present signals and reports both', () => {
    const event = { boundingBox: { n: 10, s: 0, w: 0, e: 10 }, occurredStart: '2026-06-25T00:00:00Z' }
    const ds: MatchDataset = {
      id: 'd',
      boundingBox: { n: 10, s: 0, w: 0, e: 10 }, // geo = 1
      startTime: '2026-01-01T00:00:00Z',
      period: 'PT15M', // live → temporal = 1
    }
    const m = scoreMatch(event, ds, NOW)
    expect(m.signals).toEqual({ geo: 1, temporal: 1, lexical: null, semantic: null })
    expect(m.score).toBeCloseTo(1)
  })

  it('uses only the temporal signal when geo has nothing to read', () => {
    const event = { occurredStart: '2026-06-25T00:00:00Z' }
    const ds: MatchDataset = { id: 'd', startTime: '2026-01-01T00:00:00Z', period: 'PT15M' }
    const m = scoreMatch(event, ds, NOW)
    expect(m.signals.geo).toBeNull()
    expect(m.signals.temporal).toBe(1)
    expect(m.score).toBe(1)
  })

  it('scores 0 with all signals null when nothing is readable', () => {
    const m = scoreMatch({}, { id: 'd' }, NOW)
    expect(m).toEqual({ datasetId: 'd', score: 0, signals: { geo: null, temporal: null, lexical: null, semantic: null } })
  })
})

describe('semantic signal (blendTopical + scoreMatch)', () => {
  it('blends lexical and semantic by SEMANTIC_WEIGHT when both present', () => {
    expect(blendTopical(0.5, 0.8)).toBeCloseTo((1 - SEMANTIC_WEIGHT) * 0.5 + SEMANTIC_WEIGHT * 0.8)
  })

  it('uses whichever signal is present when only one is', () => {
    expect(blendTopical(0.6, null)).toBe(0.6)
    expect(blendTopical(null, 0.9)).toBe(0.9)
    expect(blendTopical(null, null)).toBeNull()
  })

  it('lets semantic stand alone when lexical is 0 (no evidence, not counter-evidence)', () => {
    // Blending a lexical 0 in would halve the semantic score and cap a
    // semantic-only neighbour below the DEFAULT_MIN_SCORE gate.
    expect(blendTopical(0, 0.9)).toBe(0.9)
    expect(blendTopical(0, 0)).toBe(0)
  })

  it('surfaces a dataset on semantic alone when it has no lexical overlap', () => {
    // Event has topic terms; the dataset shares none of them (lexical 0) but
    // is a strong embedding neighbour → topical is driven by semantic.
    const event = {
      occurredStart: '2026-06-25T00:00:00Z',
      terms: buildEventTerms({ title: 'coral bleaching' }),
    }
    const ds: MatchDataset = {
      id: 'd',
      startTime: '2026-01-01T00:00:00Z',
      period: 'PT15M',
      subjectTerms: buildDatasetTerms({ title: 'reef stress index' }), // no shared tokens
      semantic: 0.9,
    }
    const m = scoreMatch(event, ds, NOW)
    expect(m.signals.lexical).toBe(0)
    expect(m.signals.semantic).toBe(0.9)
    expect(m.score).toBeGreaterThan(0.5)
  })

  it('a strong semantic-only match clears the gate even for a non-live dataset', () => {
    // The Copilot-flagged case: no lexical overlap, no LIVE_BONUS to rescue
    // it. Semantic must stand alone (not be halved by the blend) so the
    // 0.9 neighbour scores 0.9 · (0.75 + 0.25·1) = 0.9 ≥ DEFAULT_MIN_SCORE.
    const event = {
      occurredStart: '2026-06-25T00:00:00Z',
      terms: buildEventTerms({ title: 'coral bleaching' }),
    }
    const ds: MatchDataset = {
      id: 'd',
      startTime: '2026-01-01T00:00:00Z',
      endTime: '2026-12-31T00:00:00Z', // static coverage window, NOT live
      subjectTerms: buildDatasetTerms({ title: 'reef stress index' }),
      semantic: 0.9,
    }
    const m = scoreMatch(event, ds, NOW)
    expect(isLiveDataset(ds, NOW)).toBe(false)
    expect(m.score).toBeGreaterThanOrEqual(0.5)
    const proposed = proposeMatches(event, [ds], { nowMs: NOW })
    expect(proposed.map(p => p.datasetId)).toEqual(['d'])
  })

  it('a weak semantic-only match stays below the default gate', () => {
    const event = { occurredStart: '2026-06-25T00:00:00Z', terms: buildEventTerms({ title: 'coral bleaching' }) }
    const ds: MatchDataset = {
      id: 'd',
      subjectTerms: buildDatasetTerms({ title: 'reef stress index' }),
      semantic: 0.2, // faint neighbour
    }
    // 0.2 · TOPICAL_BASE(0.75) = 0.15 — below DEFAULT_MIN_SCORE, so it won't propose.
    expect(scoreMatch(event, ds, NOW).score).toBeLessThan(0.5)
  })

  it('buildEventEmbeddingText joins the event fields, skipping blanks', () => {
    expect(buildEventEmbeddingText({ title: 'Storm', summary: '', categoryValues: ['Severe'], keywords: ['wind'] }))
      .toBe('Storm\nSevere\nwind')
    expect(buildEventEmbeddingText({})).toBe('')
  })
})

describe('topical signal', () => {
  it('tokenize drops stopwords + digits and stems plurals', () => {
    expect(tokenize('Severe Storms near 29.0°N on 2026-06-24')).toEqual(['severe', 'storm'])
  })

  it('stems -oes / -ies plurals so they match their singulars', () => {
    expect(tokenize('Volcanoes and anomalies')).toEqual(['volcano', 'anomaly'])
  })

  it('a volcano event reaches a volcano-subject dataset (no special-case key)', () => {
    const ev = buildEventTerms({ categoryValues: ['Volcanoes'] })
    expect(ev.has('volcano')).toBe(true)
    expect(scoreLexical(ev, buildDatasetTerms({ title: 'Volcanic ash and aerosols' }))).toBeGreaterThan(0)
  })

  it('buildEventTerms expands a category into related dataset topics', () => {
    const terms = buildEventTerms({ title: 'Tropical cyclone', categoryValues: ['Severe Storms'] })
    expect(terms.has('storm')).toBe(true)
    // "Severe Storms" → expands to cloud / precipitation so it can reach
    // a cloud or precipitation dataset.
    expect(terms.has('cloud')).toBe(true)
    expect(terms.has('precipitation')).toBe(true)
  })

  it('scoreLexical rises with overlap and is 0 with none', () => {
    const ev = buildEventTerms({ categoryValues: ['Severe Storms'] })
    expect(scoreLexical(ev, buildDatasetTerms({ title: 'Cloud cover' }))).toBeGreaterThan(0)
    expect(scoreLexical(ev, buildDatasetTerms({ title: 'Sea surface salinity' }))).toBe(0)
  })

  it('a topically-irrelevant dataset scores 0 even when live + temporally overlapping', () => {
    const event = { occurredStart: '2026-06-25T00:00:00Z', terms: buildEventTerms({ title: 'Severe storm' }) }
    const unrelated: MatchDataset = {
      id: 'sst',
      startTime: '2026-01-01T00:00:00Z',
      period: 'PT15M', // live, temporal would be 1
      subjectTerms: buildDatasetTerms({ title: 'Sea surface temperature' }),
    }
    expect(scoreMatch(event, unrelated, NOW).score).toBe(0)
  })

  it('does not saturate: more shared terms keeps raising the score', () => {
    // The previous formula was min(1, 0.5 + 0.2 * overlap), so three
    // shared terms pinned it at 1.0 and every dataset beyond that was
    // indistinguishable. Measured on the live catalogue, ~25% of rows
    // scored exactly 1.0 against a typical event.
    const event = buildEventTerms({ title: 'Wildfire smoke over the northern Rockies' })
    const corpus = [
      // Abstracts included: 79% of real catalogue rows have one, and a
      // title-only dataset has so few terms that its cosine clamps.
      { id: 'a', subjectTerms: buildDatasetTerms({ title: 'Smoke forecast', abstract: 'Gridded product distributed for research and situational awareness, updated on a regular cadence with quality control applied across coverage regions and archived for retrospective analysis.' }) },
      { id: 'b', subjectTerms: buildDatasetTerms({ title: 'Wildfire smoke forecast', abstract: 'Gridded product distributed for research and situational awareness, updated on a regular cadence with quality control applied across coverage regions and archived for retrospective analysis.' }) },
      { id: 'c', subjectTerms: buildDatasetTerms({ title: 'Wildfire smoke over northern terrain', abstract: 'Gridded product distributed for research and situational awareness, updated on a regular cadence with quality control applied across coverage regions and archived for retrospective analysis.' }) },
      { id: 'd', subjectTerms: buildDatasetTerms({ title: 'Sea surface salinity', abstract: 'Gridded product distributed for research and situational awareness, updated on a regular cadence with quality control applied across coverage regions and archived for retrospective analysis.' }) },
    ]
    // Filler so the candidate set is big enough for cosines to land
    // below the calibration ceiling, where the ordering is visible.
    const filler = [
      'Bathymetry seafloor elevation grid', 'Population density gridded estimates',
      'Solar irradiance spectral measurements', 'Earthquake epicentres catalogue',
      'Vegetation index seasonal composite', 'Carbon dioxide concentration model',
      'Aurora electrojet indices', 'Snow cover extent daily',
      'Ocean currents surface drift', 'Lightning strike density climatology',
    ].map((title, i) => ({ id: `x${i}`, subjectTerms: buildDatasetTerms({ title }) }))
    const idf = buildIdf([...corpus, ...filler])
    const s = corpus.map(c => scoreLexical(event, c.subjectTerms, idf))
    expect(s[0]).toBeGreaterThan(0)
    // Two shared terms beat one. Under the old formula these were
    // 0.7 and 0.9, and anything from three terms up was flat at 1.0.
    expect(s[1]).toBeGreaterThan(s[0])
    // `c` is a near-verbatim restatement of the event, so it reaching
    // the calibration ceiling is correct rather than a saturation bug —
    // the distinction is that it takes a near-perfect match to get
    // there now, where three incidental words used to be enough.
    expect(s[2]).toBeGreaterThanOrEqual(s[1])
    expect(s[3]).toBe(0)
  })

  it('weights a rare shared term above a common one', () => {
    // `aurora` appears once in the corpus; `temperature` in every row.
    // Sharing the rare word should count for more than sharing the
    // ubiquitous one — without IDF both were worth exactly the same,
    // which is how glue words became topical evidence.
    const corpus = [
      { id: 'rare', subjectTerms: buildDatasetTerms({ title: 'Aurora temperature' }) },
      { id: 'common1', subjectTerms: buildDatasetTerms({ title: 'Ocean temperature' }) },
      { id: 'common2', subjectTerms: buildDatasetTerms({ title: 'Land temperature' }) },
      { id: 'common3', subjectTerms: buildDatasetTerms({ title: 'Air temperature' }) },
    ]
    const idf = buildIdf(corpus)
    expect(idf.get('aurora')!).toBeGreaterThan(idf.get('temperature')!)
    const event = buildEventTerms({ title: 'Aurora temperature' })
    expect(scoreLexical(event, corpus[0].subjectTerms, idf)).toBeGreaterThan(
      scoreLexical(event, corpus[1].subjectTerms, idf),
    )
  })

  it('does not let a long abstract outrank a precise title', () => {
    // The failure this replaced: a dataset pooling ~100 tokens of prose
    // beat every on-topic dataset on three incidental words. The
    // dataset's own term mass now sits in the denominator, so padding
    // stops paying.
    const event = buildEventTerms({ title: 'Hurricane in the Gulf' })
    const precise = { id: 'precise', subjectTerms: buildDatasetTerms({ title: 'Hurricane tracks' }) }
    const padded = {
      id: 'padded',
      subjectTerms: buildDatasetTerms({
        title: 'Ocean carbon exchange',
        abstract:
          'This dataset covers the gulf and coastal margins where fluxes are expected to vary, including shelf regions, estuaries, upwelling zones, seasonal stratification, biological productivity, and long term monitoring across many basins worldwide.',
      }),
    }
    const idf = buildIdf([precise, padded])
    expect(scoreLexical(event, precise.subjectTerms, idf)).toBeGreaterThan(
      scoreLexical(event, padded.subjectTerms, idf),
    )
  })

  it('ranks an overlapping real-time dataset above an equally-topical static one', () => {
    // Against a varied corpus — the regime production actually runs in,
    // where a cosine lands mid-range instead of at the 1.0 ceiling.
    const event = { occurredStart: '2026-06-25T00:00:00Z', terms: buildEventTerms({ title: 'Severe storm' }) }
    const subjectTerms = buildDatasetTerms({
      title: 'Cloud imagery',
      abstract:
        'Visible and infrared imagery of cloud cover captured by geostationary platforms, updated continuously for forecasting across ocean and land regions.',
    })
    const live: MatchDataset = { id: 'live', startTime: '2026-01-01T00:00:00Z', period: 'PT15M', subjectTerms }
    const stat: MatchDataset = {
      id: 'static',
      startTime: '2026-06-20T00:00:00Z',
      endTime: '2026-06-30T00:00:00Z',
      subjectTerms,
    }
    const filler = [
      'Sea surface salinity from orbital radiometers',
      'Global vegetation index seasonal composite',
      'Earthquake epicentres catalogue historical',
      'Aurora oval auroral electrojet indices',
      'Carbon dioxide concentration model output',
      'Bathymetry seafloor elevation grid',
      'Population density gridded estimates',
      'Solar irradiance spectral measurements',
    ].map((title, i) => ({ id: `f${i}`, subjectTerms: buildDatasetTerms({ title }) }))
    const idf = buildIdf([live, stat, ...filler])
    expect(scoreMatch(event, live, NOW, idf).score).toBeGreaterThan(
      scoreMatch(event, stat, NOW, idf).score,
    )
  })

  it('never lets the liveness boost push a score past 1, and never inverts the order', () => {
    // Regression guard for the additive-bonus-with-clamp shape: at
    // score 1 there was no headroom left, so `min(1, score + BONUS)`
    // returned 1 for both and the preference vanished precisely for
    // the strongest matches. The multiplicative form keeps live ahead
    // wherever the score is below 1.
    const event = { occurredStart: '2026-06-25T00:00:00Z', terms: buildEventTerms({ title: 'Severe storm' }) }
    const subjectTerms = buildDatasetTerms({ title: 'Storm cloud precipitation wind imagery' })
    const live: MatchDataset = { id: 'live', startTime: '2026-01-01T00:00:00Z', period: 'PT15M', subjectTerms }
    const stat: MatchDataset = {
      id: 'static',
      startTime: '2026-06-20T00:00:00Z',
      endTime: '2026-06-30T00:00:00Z',
      subjectTerms,
    }
    const liveScore = scoreMatch(event, live, NOW).score
    const statScore = scoreMatch(event, stat, NOW).score
    expect(liveScore).toBeLessThanOrEqual(1)
    expect(liveScore).toBeGreaterThanOrEqual(statScore)
  })
})

describe('proposeMatches', () => {
  const event = { occurredStart: '2026-06-25T00:00:00Z' }
  const datasets: MatchDataset[] = [
    { id: 'LIVE', startTime: '2026-01-01T00:00:00Z', period: 'PT15M' }, // temporal 1
    { id: 'OLD', startTime: '2000-01-01T00:00:00Z', endTime: '2000-02-01T00:00:00Z' }, // ~0
    { id: 'NONE' }, // 0, filtered
  ]

  it('keeps matches at or above minScore, ranked, capped', () => {
    const out = proposeMatches(event, datasets, { nowMs: NOW, minScore: 0.5 })
    expect(out.map(m => m.datasetId)).toEqual(['LIVE'])
    expect(out[0].score).toBe(1)
  })

  it('honours the limit', () => {
    const many: MatchDataset[] = Array.from({ length: 5 }, (_, i) => ({
      id: `D${i}`,
      startTime: '2026-01-01T00:00:00Z',
      period: 'PT15M',
    }))
    expect(proposeMatches(event, many, { nowMs: NOW, limit: 2 })).toHaveLength(2)
  })
})

describe('runMatcherForEvent', () => {
  it('writes proposed links for the topically + temporally matching datasets', async () => {
    const sqlite = seedFixtures({ count: 2 })
    const db = asD1(sqlite)

    // DS000 → a live realtime cloud dataset (topically related to a storm
    // event, covering now); DS001 → an unrelated old static dataset.
    sqlite
      .prepare(`UPDATE datasets SET start_time = ?, end_time = NULL, period = ?, title = ? WHERE id = ?`)
      .run('2026-01-01T00:00:00Z', 'PT15M', 'Cloud cover (real-time)', seededDatasetId(0))
    sqlite
      .prepare(`UPDATE datasets SET start_time = ?, end_time = ?, period = NULL WHERE id = ?`)
      .run('2000-01-01T00:00:00Z', '2000-02-01T00:00:00Z', seededDatasetId(1))

    const { id: eventId } = await insertCurrentEvent(db, {
      originNode: 'NODE000',
      title: 'Severe storm now',
      sourceName: 'NOAA',
      sourceUrl: 'https://example.gov/x',
      occurredStart: '2026-06-25T12:00:00Z',
    })

    const matches = await runMatcherForEvent(db, eventId, { now: NOW })

    // The unrelated "Test Dataset 1" has no topical overlap → filtered.
    expect(matches.map(m => m.datasetId)).toEqual([seededDatasetId(0)])
    expect(matches[0].signals).toMatchObject({ geo: null, temporal: 1 })
    expect(matches[0].signals.lexical).toBeGreaterThan(0)

    // Persisted as a proposed link, readable from the store.
    const links = await listLinksForEvent(db, eventId)
    expect(links).toHaveLength(1)
    expect(links[0].dataset_id).toBe(seededDatasetId(0))
    expect(links[0].status).toBe('proposed')
    expect(links[0].match_score).toBeGreaterThan(0.5)
    const sig = JSON.parse(links[0].signals_json!)
    expect(sig).toMatchObject({ geo: null, temporal: 1 })
    expect(sig.lexical).toBeGreaterThan(0)
  })

  it('returns an empty list for an unknown event', async () => {
    const db = asD1(seedFixtures({ count: 1 }))
    expect(await runMatcherForEvent(db, 'NOPE000000000000000000000A', { now: NOW })).toEqual([])
  })

  it('attaches a semantic signal from Vectorize when the env is configured', async () => {
    const sqlite = seedFixtures({ count: 2 })
    const db = asD1(sqlite)
    // DS000 is topically + temporally matching (as in the first test); DS001
    // is a plain live dataset with NO lexical overlap with the event.
    sqlite
      .prepare(`UPDATE datasets SET start_time = ?, end_time = NULL, period = ?, title = ? WHERE id = ?`)
      .run('2026-01-01T00:00:00Z', 'PT15M', 'Cloud cover (real-time)', seededDatasetId(0))
    sqlite
      .prepare(`UPDATE datasets SET start_time = ?, end_time = NULL, period = ?, title = ? WHERE id = ?`)
      .run('2026-01-01T00:00:00Z', 'PT15M', 'Ocean salinity climatology', seededDatasetId(1))

    const env: MatcherEnv = { MOCK_AI: 'true', MOCK_VECTORIZE: 'true' }
    __clearMockStore(env)
    // Seed DS001's vector so it is the event's nearest neighbour even though
    // it shares no keywords: embed the exact text runMatcherForEvent will
    // build for this event and store it as DS001's vector (cosine → 1).
    const eventText = buildEventEmbeddingText({ title: 'Severe storm now' })
    const eventVector = await embedDatasetText(env, eventText)
    await upsertEmbedding(env, {
      dataset_id: seededDatasetId(1),
      values: eventVector,
      metadata: { peer_id: 'local', category: 'oceans', visibility: 'public', embedding_version: 1 },
    })

    const { id: eventId } = await insertCurrentEvent(db, {
      originNode: 'NODE000',
      title: 'Severe storm now',
      sourceName: 'NOAA',
      sourceUrl: 'https://example.gov/x',
      occurredStart: '2026-06-25T12:00:00Z',
    })

    const matches = await runMatcherForEvent(db, eventId, { now: NOW, env })
    const byId = new Map(matches.map(m => [m.datasetId, m]))

    // DS000 still matches lexically; DS001 — no lexical overlap — now surfaces
    // purely on the seeded semantic neighbour.
    const ds1 = byId.get(seededDatasetId(1))
    expect(ds1).toBeDefined()
    expect(ds1!.signals.lexical).toBe(0)
    expect(ds1!.signals.semantic).toBeGreaterThan(0.9)
    // Persisted with the semantic signal in signals_json.
    const links = await listLinksForEvent(db, eventId)
    const link1 = links.find(l => l.dataset_id === seededDatasetId(1))
    expect(JSON.parse(link1!.signals_json!).semantic).toBeGreaterThan(0.9)
  })

  it('runs pure lexical/temporal (semantic null) when the env is unconfigured', async () => {
    // A realistic candidate count, not one row. The topical score is an
    // IDF-weighted cosine over the candidate set, so a single-dataset
    // corpus gives every term the same rarity and an event whose terms
    // are mostly TOPIC_EXPANSIONS bridges scores below the floor. That
    // small-catalogue behaviour is real and documented on
    // LEXICAL_REFERENCE — a brand-new node with a handful of datasets
    // may need a lower reference — but it is not what this test is for.
    const sqlite = seedFixtures({ count: 12 })
    const db = asD1(sqlite)
    sqlite
      .prepare(`UPDATE datasets SET start_time = ?, end_time = NULL, period = ?, title = ? WHERE id = ?`)
      .run('2026-01-01T00:00:00Z', 'PT15M', 'Cloud cover (real-time)', seededDatasetId(0))
    const { id: eventId } = await insertCurrentEvent(db, {
      originNode: 'NODE000',
      title: 'Severe storm now',
      sourceName: 'NOAA',
      sourceUrl: 'https://example.gov/x',
      occurredStart: '2026-06-25T12:00:00Z',
    })
    // No env → semantic stays null; the lexical/temporal match is unchanged.
    const matches = await runMatcherForEvent(db, eventId, { now: NOW })
    expect(matches[0].signals.semantic).toBeNull()
    expect(matches[0].signals.lexical).toBeGreaterThan(0)
  })

  it('skips hidden / unpublished / retracted datasets', async () => {
    // 12 rows, of which three are made to match and two of those are
    // disqualified. The extra rows exist so the surviving candidate set
    // is a realistic size — see the note on the previous test.
    const sqlite = seedFixtures({ count: 12 })
    const db = asD1(sqlite)
    // All three would match (topically + temporally); disqualify two.
    for (let i = 0; i < 3; i++) {
      sqlite
        .prepare(`UPDATE datasets SET start_time = ?, period = ?, title = ? WHERE id = ?`)
        .run('2026-01-01T00:00:00Z', 'PT15M', 'Cloud imagery (real-time)', seededDatasetId(i))
    }
    sqlite.prepare(`UPDATE datasets SET is_hidden = 1 WHERE id = ?`).run(seededDatasetId(1))
    sqlite
      .prepare(`UPDATE datasets SET retracted_at = ? WHERE id = ?`)
      .run('2026-06-01T00:00:00Z', seededDatasetId(2))

    const { id: eventId } = await insertCurrentEvent(db, {
      originNode: 'NODE000',
      title: 'Storm now',
      sourceName: 'NOAA',
      sourceUrl: 'https://example.gov/x',
      occurredStart: '2026-06-25T12:00:00Z',
    })

    const matches = await runMatcherForEvent(db, eventId, { now: NOW })
    expect(matches.map(m => m.datasetId)).toEqual([seededDatasetId(0)])
  })
})
