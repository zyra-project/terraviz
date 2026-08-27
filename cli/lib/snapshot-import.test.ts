// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  buildEnrichedIndex,
  mapDataRef,
  mapFormat,
  mapSnapshot,
  mapSnapshotEntry,
  normalizeTitle,
  pickDataLink,
  type RawEnrichedEntry,
  type RawSosEntry,
} from './snapshot-import'

const sample: RawSosEntry = {
  id: 'INTERNAL_SOS_768',
  organization: 'NOAA',
  title: 'Hurricane Season - 2024',
  abstractTxt: 'Atlantic hurricane track animation.',
  startTime: '2024-06-01T12:00:00',
  endTime: '2024-11-30T12:00:00',
  format: 'video/mp4',
  websiteLink: 'http://sos.noaa.gov/Datasets/sosx_dataset_info.html?id=768',
  dataLink: 'https://vimeo.com/1107911993',
  thumbnailLink: 'https://example.org/thumb.jpg',
  legendLink: 'https://example.org/legend.png',
  weight: 10,
  isHidden: false,
  tags: ['Air', 'Water', 'People'],
}

const sampleEnriched: RawEnrichedEntry = {
  url: 'https://sos.noaa.gov/catalog/datasets/hurricane-season-2024',
  title: 'Hurricane Season - 2024',
  description: 'Long-form description from the enriched metadata file.',
  categories: { Air: ['Hurricanes'], Water: ['Storm Surge'] },
  keywords: ['Hurricanes', 'Tropical Storms', 'Atlantic Basin'],
  date_added: '2024-12-01',
}

describe('normalizeTitle', () => {
  it('lower-cases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeTitle('Hurricane Season - 2024')).toBe('hurricane season 2024')
    expect(normalizeTitle('Sea Level Rise (Movie)')).toBe('sea level rise')
    expect(normalizeTitle('  Argo  Buoys  ')).toBe('argo buoys')
  })
})

describe('mapDataRef', () => {
  it('extracts the vimeo id from a vimeo URL', () => {
    expect(mapDataRef('https://vimeo.com/1107911993')).toBe('vimeo:1107911993')
    expect(mapDataRef('https://vimeo.com/497773621')).toBe('vimeo:497773621')
  })

  it('passes non-vimeo URLs through with the url: prefix', () => {
    expect(mapDataRef('https://example.org/dataset.png')).toBe(
      'url:https://example.org/dataset.png',
    )
  })
})

describe('mapFormat', () => {
  it('passes validator-allowed mimes through unchanged', () => {
    expect(mapFormat('video/mp4')).toBe('video/mp4')
    expect(mapFormat('image/png')).toBe('image/png')
    expect(mapFormat('image/jpeg')).toBe('image/jpeg')
    expect(mapFormat('image/webp')).toBe('image/webp')
    expect(mapFormat('tour/json')).toBe('tour/json')
  })

  it('canonicalises SOS jpeg spellings', () => {
    expect(mapFormat('image/jpg')).toBe('image/jpeg')
    expect(mapFormat('images/jpg')).toBe('image/jpeg')
  })

  it('returns null for formats this pipeline cannot render', () => {
    expect(mapFormat('image/dds')).toBeNull()
    expect(mapFormat('satellites/tle')).toBeNull()
    expect(mapFormat('assetbundle')).toBeNull()
    expect(mapFormat('application/vnd.google-earth.kml')).toBeNull()
  })
})

describe('buildEnrichedIndex', () => {
  it('keys by normalized title and skips title-less entries', () => {
    const index = buildEnrichedIndex([
      sampleEnriched,
      { description: 'orphan' } as RawEnrichedEntry,
    ])
    expect(index.size).toBe(1)
    expect(index.get('hurricane season 2024')?.description).toBe(
      sampleEnriched.description,
    )
  })
})

describe('mapSnapshotEntry — happy path', () => {
  it('produces a publish-ready draft for a vimeo video row', () => {
    const outcome = mapSnapshotEntry(sample, sampleEnriched)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.legacyId).toBe('INTERNAL_SOS_768')
    const d = outcome.row.draft
    expect(d.title).toBe('Hurricane Season - 2024')
    expect(d.format).toBe('video/mp4')
    expect(d.data_ref).toBe('vimeo:1107911993')
    expect(d.visibility).toBe('public')
    expect(d.license_statement).toMatch(/originating organisation/i)
    expect(d.abstract).toBe(sampleEnriched.description)
    expect(d.organization).toBe('NOAA')
    expect(d.website_link).toBe(sample.websiteLink)
    expect(d.thumbnail_ref).toBe(sample.thumbnailLink)
    expect(d.legend_ref).toBe(sample.legendLink)
    expect(d.start_time).toBe('2024-06-01T12:00:00Z')
    expect(d.end_time).toBe('2024-11-30T12:00:00Z')
    expect(d.weight).toBe(10)
    expect(d.is_hidden).toBe(false)
    expect(d.categories).toEqual(sampleEnriched.categories)
    expect(d.keywords).toEqual(sampleEnriched.keywords)
    expect(d.tags).toEqual(['Air', 'Water', 'People'])
  })

  it('falls back to abstractTxt when no enriched description is available', () => {
    const outcome = mapSnapshotEntry(sample, undefined)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.abstract).toBe('Atlantic hurricane track animation.')
    expect(outcome.row.draft.categories).toBeUndefined()
    expect(outcome.row.draft.keywords).toBeUndefined()
  })

  it('omits abstract entirely when both sources are blank or whitespace-only', () => {
    const outcome = mapSnapshotEntry({ ...sample, abstractTxt: '\n   ' }, undefined)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.abstract).toBeUndefined()
  })

  it('keeps url: data_refs verbatim for non-vimeo image rows', () => {
    const imageRow: RawSosEntry = {
      ...sample,
      id: 'INTERNAL_SOS_770',
      title: 'Argo Buoys (by country)',
      format: 'image/png',
      dataLink: 'https://d3sik7mbbzunjo.cloudfront.net/oceans/argo_country/argo.png',
      tags: ['Water'],
    }
    const outcome = mapSnapshotEntry(imageRow, undefined)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.format).toBe('image/png')
    expect(outcome.row.draft.data_ref).toBe(
      'url:https://d3sik7mbbzunjo.cloudfront.net/oceans/argo_country/argo.png',
    )
  })

  it('drops empty start/end times rather than emitting an invalid ISO string', () => {
    const outcome = mapSnapshotEntry({ ...sample, startTime: '', endTime: '' }, undefined)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.start_time).toBeUndefined()
    expect(outcome.row.draft.end_time).toBeUndefined()
  })
})

describe('mapSnapshotEntry — skip paths', () => {
  it('skips rows missing a title', () => {
    const outcome = mapSnapshotEntry({ ...sample, title: '' }, undefined)
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') return
    expect(outcome.row.reason).toBe('missing_title')
  })

  it('skips rows missing a data link', () => {
    const outcome = mapSnapshotEntry({ ...sample, dataLink: '' }, undefined)
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') return
    expect(outcome.row.reason).toBe('missing_data_link')
  })

  it('skips rows with an unsupported format and records the offending value', () => {
    const outcome = mapSnapshotEntry(
      { ...sample, format: 'image/dds', dataLink: 'https://example.org/x.dds' },
      undefined,
    )
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') return
    expect(outcome.row.reason).toBe('unsupported_format')
    expect(outcome.row.details).toBe('image/dds')
  })

  it('synthesises a placeholder legacyId when SOS id is missing', () => {
    const outcome = mapSnapshotEntry(
      { ...sample, id: '', title: 'Anonymous Row' } as RawSosEntry,
      undefined,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.legacyId).toMatch(/^UNKNOWN_anonymous row$/)
  })
})

describe('mapSnapshotEntry — clipping to validator caps', () => {
  it('clips keywords to 20 entries, 40 chars each', () => {
    const longKeywords = Array.from({ length: 30 }, (_, i) => `keyword-${'x'.repeat(60)}-${i}`)
    const outcome = mapSnapshotEntry(sample, {
      ...sampleEnriched,
      keywords: longKeywords,
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    const k = outcome.row.draft.keywords!
    expect(k.length).toBe(20)
    for (const v of k) expect(v.length).toBeLessThanOrEqual(40)
  })

  it('clips tags to 20 entries and drops blank ones', () => {
    const outcome = mapSnapshotEntry(
      { ...sample, tags: ['', 'Air', '   ', 'Water', ...Array(25).fill('Land')] },
      undefined,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    const t = outcome.row.draft.tags!
    expect(t.length).toBe(20)
    expect(t[0]).toBe('Air')
    expect(t[1]).toBe('Water')
  })

  it('clips categories to a total of 6 entries', () => {
    const outcome = mapSnapshotEntry(sample, {
      ...sampleEnriched,
      categories: {
        Air: ['A1', 'A2', 'A3'],
        Water: ['W1', 'W2'],
        Land: ['L1', 'L2', 'L3'],
        People: ['P1', 'P2'],
      },
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    const cats = outcome.row.draft.categories!
    const total = Object.values(cats).reduce((n, v) => n + v.length, 0)
    expect(total).toBe(6)
    // Iteration order is preserved, so Air / Water / Land[0] should be kept.
    expect(cats.Air).toEqual(['A1', 'A2', 'A3'])
    expect(cats.Water).toEqual(['W1', 'W2'])
    expect(cats.Land).toEqual(['L1'])
    expect(cats.People).toBeUndefined()
  })

  it('clips an over-long title down to 200 chars', () => {
    const outcome = mapSnapshotEntry(
      { ...sample, title: 'X'.repeat(500) },
      undefined,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.title!.length).toBe(200)
  })
})

describe('mapSnapshot — whole-snapshot orchestration', () => {
  it('counts ok and skipped outcomes by reason', () => {
    const list: RawSosEntry[] = [
      sample,
      { ...sample, id: 'INTERNAL_SOS_001', title: 'Image Row', format: 'image/png',
        dataLink: 'https://example.org/x.png' },
      { ...sample, id: 'INTERNAL_SOS_002', title: '', format: 'video/mp4' },
      { ...sample, id: 'INTERNAL_SOS_003', format: 'assetbundle',
        dataLink: 'https://example.org/x.bundle' },
    ]
    const plan = mapSnapshot(list, [sampleEnriched])
    expect(plan.counts.ok).toBe(2)
    expect(plan.counts.skipped.missing_title).toBe(1)
    expect(plan.counts.skipped.unsupported_format).toBe(1)
    expect(plan.outcomes).toHaveLength(4)
  })

  it('first-wins on duplicate SOS ids', () => {
    const list: RawSosEntry[] = [
      sample,
      { ...sample, title: 'Hurricane Season - 2024 (revised)' },
    ]
    const plan = mapSnapshot(list, [])
    expect(plan.counts.ok).toBe(1)
    expect(plan.counts.skipped.duplicate_id).toBe(1)
    const dup = plan.outcomes[1]
    expect(dup.kind).toBe('skipped')
    if (dup.kind !== 'skipped') return
    expect(dup.row.reason).toBe('duplicate_id')
  })

  it('joins enriched metadata by normalized title', () => {
    const renamed: RawSosEntry = {
      ...sample,
      id: 'INTERNAL_SOS_999',
      title: 'Hurricane Season - 2024',
    }
    const plan = mapSnapshot([renamed], [sampleEnriched])
    expect(plan.counts.ok).toBe(1)
    const ok = plan.outcomes[0]
    if (ok.kind !== 'ok') throw new Error('expected ok')
    expect(ok.row.draft.abstract).toBe(sampleEnriched.description)
    expect(ok.row.draft.categories).toEqual(sampleEnriched.categories)
  })

  it('produces an empty plan for an empty input list', () => {
    const plan = mapSnapshot([], [])
    expect(plan.outcomes).toEqual([])
    expect(plan.counts.ok).toBe(0)
    expect(plan.counts.skipped.duplicate_id).toBe(0)
  })
})

describe('pickDataLink (3b/B)', () => {
  // The upstream snapshot has 4 rows that ship the field as
  // lowercase `datalink` instead of canonical `dataLink`. Without
  // this fallback those rows skip with `missing_data_link` even
  // though the URL is right there. Pin the fallback so a future
  // tighter typing of `RawSosEntry` can't remove the rescue.
  it('prefers canonical dataLink when set', () => {
    expect(
      pickDataLink({
        ...sample,
        dataLink: 'https://vimeo.com/111',
        datalink: 'https://vimeo.com/222',
      }),
    ).toBe('https://vimeo.com/111')
  })

  it('falls back to lowercase datalink when canonical is empty', () => {
    expect(
      pickDataLink({
        ...sample,
        dataLink: '',
        datalink: 'https://vimeo.com/222',
      }),
    ).toBe('https://vimeo.com/222')
  })

  it('returns empty string when neither is set', () => {
    expect(pickDataLink({ ...sample, dataLink: '', datalink: undefined })).toBe('')
  })

  it('treats whitespace-only canonical dataLink as empty (matches missing_data_link)', () => {
    expect(
      pickDataLink({
        ...sample,
        dataLink: '   ',
        datalink: 'https://vimeo.com/222',
      }),
    ).toBe('https://vimeo.com/222')
  })
})

describe('mapSnapshotEntry — case-mismatch rescue (3b/B)', () => {
  it('imports rows that have only lowercase datalink', () => {
    // Pre-3b this row would skip with `missing_data_link`. The
    // SOS snapshot has 4 such rows; rescuing them is the visible
    // win of the case-normalization fix.
    const lowercase: RawSosEntry = {
      ...sample,
      dataLink: '',
      datalink: 'https://vimeo.com/1234567',
    }
    const outcome = mapSnapshotEntry(lowercase, undefined)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.data_ref).toBe('vimeo:1234567')
  })

  it('still skips rows missing both forms', () => {
    const outcome = mapSnapshotEntry({ ...sample, dataLink: '', datalink: '' }, undefined)
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') return
    expect(outcome.row.reason).toBe('missing_data_link')
  })
})

describe('mapSnapshotEntry — Phase 3b auxiliary fields', () => {
  // The three SOS fields the Phase 1d import dropped: colorTableLink,
  // probingInfo, boundingVariables. Now mapped into the catalog as
  // color_table_ref / probing_info (JSON-stringified) /
  // bounding_variables (JSON-stringified) so future imports populate
  // them and 3b/C's backfill can read them for already-migrated rows.

  it('maps colorTableLink to color_table_ref', () => {
    const outcome = mapSnapshotEntry(
      { ...sample, colorTableLink: 'https://example.org/colortable.png' },
      undefined,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.color_table_ref).toBe('https://example.org/colortable.png')
  })

  it('omits color_table_ref when the SOS field is absent', () => {
    const outcome = mapSnapshotEntry({ ...sample }, undefined)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.color_table_ref).toBeUndefined()
  })

  it('JSON-stringifies probingInfo and persists it on probing_info', () => {
    const probing = {
      units: 'psu',
      minVal: 20,
      maxVal: 38,
      minPos: { x: 45, y: 99, XUnits: 'Pixels' as const, YUnits: 'Pixels' as const },
      maxPos: { x: 277, y: 99, XUnits: 'Pixels' as const, YUnits: 'Pixels' as const },
    }
    const outcome = mapSnapshotEntry({ ...sample, probingInfo: probing }, undefined)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    // Stringified for the validator's JSON-text contract — caller
    // parses on read. Round-tripping gives back the original object.
    expect(typeof outcome.row.draft.probing_info).toBe('string')
    expect(JSON.parse(outcome.row.draft.probing_info!)).toEqual(probing)
  })

  it('coerces SOS boundingVariables (string corners) into typed bounding_box numerics (3d/A)', () => {
    // SOS publishers store the corners as strings ("90", "-180").
    // The Phase 3d importer mapper coerces via Number() — typed
    // bbox numerics land on D1 via the publisher API, replacing
    // the legacy `bounding_variables` JSON-string column.
    const outcome = mapSnapshotEntry(
      { ...sample, boundingVariables: { n: '52.621', s: '21.1381', w: '-134.099', e: '-60.9016' } },
      undefined,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.bounding_box).toEqual({
      n: 52.621,
      s: 21.1381,
      w: -134.099,
      e: -60.9016,
    })
  })

  it('accepts boundingVariables with numeric corners (publisher-portal future case)', () => {
    const outcome = mapSnapshotEntry(
      { ...sample, boundingVariables: { n: 90, s: -90, w: -180, e: 180 } },
      undefined,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.bounding_box).toEqual({ n: 90, s: -90, w: -180, e: 180 })
  })

  it('drops a partial / malformed boundingVariables silently (a half-bbox is worse than none)', () => {
    const missingCorner = mapSnapshotEntry(
      { ...sample, boundingVariables: { n: '90', s: '-90', w: '-180' } },
      undefined,
    )
    expect(missingCorner.kind).toBe('ok')
    if (missingCorner.kind !== 'ok') return
    expect(missingCorner.row.draft.bounding_box).toBeUndefined()

    const nonNumeric = mapSnapshotEntry(
      { ...sample, boundingVariables: { n: 'oops', s: '0', w: '0', e: '0' } },
      undefined,
    )
    expect(nonNumeric.kind).toBe('ok')
    if (nonNumeric.kind !== 'ok') return
    expect(nonNumeric.row.draft.bounding_box).toBeUndefined()

    const outOfRange = mapSnapshotEntry(
      { ...sample, boundingVariables: { n: '100', s: '0', w: '0', e: '0' } },
      undefined,
    )
    expect(outOfRange.kind).toBe('ok')
    if (outOfRange.kind !== 'ok') return
    expect(outOfRange.row.draft.bounding_box).toBeUndefined()
  })

  it('refuses non-string / non-number corners (e.g. true → 1) so a malformed upstream row drops cleanly', () => {
    // Without the explicit type guard, `Number(true) === 1` would
    // pass the range check and persist as a real-valued bbox corner.
    // Booleans, arrays, objects, etc. all bail the whole bbox.
    const truthy = mapSnapshotEntry(
      {
        ...sample,
        boundingVariables: { n: true as unknown as string, s: '0', w: '0', e: '0' },
      },
      undefined,
    )
    expect(truthy.kind).toBe('ok')
    if (truthy.kind !== 'ok') return
    expect(truthy.row.draft.bounding_box).toBeUndefined()

    const empties = mapSnapshotEntry(
      { ...sample, boundingVariables: { n: '', s: '0', w: '0', e: '0' } },
      undefined,
    )
    expect(empties.kind).toBe('ok')
    if (empties.kind !== 'ok') return
    expect(empties.row.draft.bounding_box).toBeUndefined()
  })

  it('drops an oversized probingInfo silently (4096-char cap)', () => {
    // The validator caps JSON-text columns at 4096 chars. The
    // importer pre-filters so an oversize blob doesn't trigger
    // `invalid_after_mapping` — keeps the SOS import idempotent
    // even on rows the validator would otherwise reject.
    const huge = { blob: 'x'.repeat(5000) }
    const outcome = mapSnapshotEntry(
      { ...sample, probingInfo: huge as unknown as never },
      undefined,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.probing_info).toBeUndefined()
  })

  it('persists 3d non-Earth metadata (celestialBody / radiusMi / lonOrigin / isFlippedInY)', () => {
    const outcome = mapSnapshotEntry(
      {
        ...sample,
        celestialBody: 'Mars',
        radiusMi: 2106.1,
        lonOrigin: 180,
        isFlippedInY: true,
      },
      undefined,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.celestial_body).toBe('Mars')
    expect(outcome.row.draft.radius_mi).toBe(2106.1)
    expect(outcome.row.draft.lon_origin).toBe(180)
    expect(outcome.row.draft.is_flipped_in_y).toBe(true)
  })

  it('collapses empty / false defaults so the row stays terse on D1', () => {
    // SOS publishers sometimes ship `celestialBody: ""` (the
    // default Earth) and `isFlippedInY: false` (the default no-flip).
    // We treat those as "field omitted" so the wire / D1 row
    // stays clean — the serializer wouldn't emit them anyway.
    const outcome = mapSnapshotEntry(
      { ...sample, celestialBody: '', isFlippedInY: false },
      undefined,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.celestial_body).toBeUndefined()
    expect(outcome.row.draft.is_flipped_in_y).toBeUndefined()
  })

  it('drops a non-object probingInfo value silently', () => {
    // A future schema drift in the upstream snapshot could land a
    // string or number here; we defensively skip rather than
    // forcing the validator into the `invalid_json` path.
    const outcome = mapSnapshotEntry(
      { ...sample, probingInfo: 'not an object' as unknown as never },
      undefined,
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.row.draft.probing_info).toBeUndefined()
  })
})
