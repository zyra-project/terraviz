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
  scoreLexical,
  TEMPORAL_HORIZON_MS,
  type MatchDataset,
} from './events-matcher'

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
    expect(m.signals).toEqual({ geo: 1, temporal: 1, lexical: null })
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
    expect(m).toEqual({ datasetId: 'd', score: 0, signals: { geo: null, temporal: null, lexical: null } })
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

  it('ranks an overlapping real-time dataset above an equally-topical static one', () => {
    const event = { occurredStart: '2026-06-25T00:00:00Z', terms: buildEventTerms({ title: 'Severe storm' }) }
    const subjectTerms = buildDatasetTerms({ title: 'Cloud imagery' })
    const live: MatchDataset = { id: 'live', startTime: '2026-01-01T00:00:00Z', period: 'PT15M', subjectTerms }
    const stat: MatchDataset = {
      id: 'static',
      startTime: '2026-06-20T00:00:00Z',
      endTime: '2026-06-30T00:00:00Z',
      subjectTerms,
    }
    expect(scoreMatch(event, live, NOW).score).toBeGreaterThan(scoreMatch(event, stat, NOW).score)
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

  it('skips hidden / unpublished / retracted datasets', async () => {
    const sqlite = seedFixtures({ count: 3 })
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
