// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootstrapCrosswalk, resolveCrosswalk, type SnapshotCrosswalk } from './snapshot-crosswalk'
import { mapSnapshot, type RawEnrichedEntry, type RawSosEntry } from './snapshot-import'

const read = (name: string) => readFileSync(resolve('public/assets', name), 'utf8').replace(/\r\n/g, '\n')
const baseline = JSON.parse(read('sos-enrichment-crosswalk.json')) as SnapshotCrosswalk
const listText = read('sos-dataset-list.json')
const enrichedText = read('sos_dataset_metadata.json')
const operational = (JSON.parse(listText) as { datasets: RawSosEntry[] }).datasets
const enriched = JSON.parse(enrichedText) as RawEnrichedEntry[]
const source: RawEnrichedEntry = { url: 'https://sos.noaa.gov/catalog/datasets/example', title: 'An Example', description: 'Enrichment' }
const row: RawSosEntry = { id: 'OPERATIONAL_42', title: 'An Example (Movie)', format: 'video/mp4', dataLink: 'https://example.org/video.mp4' }
const fixture: SnapshotCrosswalk = { ...baseline, mappings: [[row.id, source.url!]] }

describe('committed baseline', () => {
  it('reproduces the checked-in text through the stdout-only offline CLI (LF normalized)', () => {
    const output = execFileSync(process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/snapshot-crosswalk.ts', '--bootstrap'],
      { encoding: 'utf8' })
    expect(output).toBe(read('sos-enrichment-crosswalk.json'))
    const report = JSON.parse(execFileSync(process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/snapshot-crosswalk.ts', '--validate'],
      { encoding: 'utf8' }))
    expect(report).toMatchObject({ matched: 137, unmapped: 67, ambiguous: 0, invalid: 0 })
  })

  it('pins the source census: URLs are unique, numeric sos_id is not available', () => {
    expect(operational).toHaveLength(204)
    expect(enriched).toHaveLength(520)
    expect(new Set(enriched.map(e => e.url)).size).toBe(520)
    expect(enriched.every(e => !('sos_id' in e) && !('id' in e))).toBe(true)
    const report = resolveCrosswalk(operational, enriched, baseline).report
    expect(report).toMatchObject({ matched: 137, unmapped: 67, ambiguous: 0, invalid: 0 })
    expect(baseline.mappings).toHaveLength(136)
    expect(report.unmapped_ids).toEqual(baseline.report.unmapped_ids)
    expect(baseline.report.duplicate_operational_ids).toEqual(['INTERNAL_SOS_766_ONLINE'])
  })

  it('reproduces the reviewed baseline, including provenance hashes and full unmatched report', () => {
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
    expect(baseline.provenance.operational_sha256).toBe(sha256(listText))
    expect(baseline.provenance.enrichment_sha256).toBe(sha256(enrichedText))
    expect(bootstrapCrosswalk(operational, enriched, baseline.provenance)).toEqual(baseline)
    expect(bootstrapCrosswalk([...operational].reverse(), [...enriched].reverse(), baseline.provenance)).toEqual(baseline)
  })

  it('keeps authoritative mapping unchanged after titles and input ordering change', () => {
    const before = mapSnapshot(operational, enriched, baseline)
    const after = mapSnapshot(
      [...operational].reverse().map(e => ({ ...e, title: `Renamed ${e.id}` })),
      [...enriched].reverse().map(e => ({ ...e, title: 'All titles now collide' })),
      { ...baseline, mappings: [...baseline.mappings].reverse() },
    )
    expect(after.crosswalk).toEqual(before.crosswalk)
    const drafts = (plan: typeof before) => plan.outcomes.filter(o => o.kind === 'ok')
      .map(o => { const { title: _title, ...draft } = o.row.draft; return [o.row.legacyId, draft] })
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
    expect(drafts(after)).toEqual(drafts(before))
    expect(before.counts.skipped.duplicate_id).toBe(2)
  })
})

describe('crosswalk validation', () => {
  it('supports intentional many-to-one pairs, not duplicate source records', () => {
    const doc: SnapshotCrosswalk = { ...fixture, mappings: [...fixture.mappings, ['OTHER', source.url!]] }
    const result = resolveCrosswalk([row, { ...row, id: 'OTHER' }], [source], doc)
    expect(result.report).toMatchObject({ matched: 2, unmapped: 0, ambiguous: 0, invalid: 0 })
  })

  it.each([null, {}, { ...fixture, version: 2 }, { ...fixture, provenance: {} }, { ...fixture, mappings: {} }])(
    'rejects malformed documents and missing provenance', document => {
      const result = resolveCrosswalk([row], [source], document)
      expect(result.byOperationalId.size).toBe(0)
      expect(result.report.invalid).toBeGreaterThan(0)
    },
  )

  it.each([undefined, '', 'https://example.org/not-sos', 'https://sos.noaa.gov/catalog/datasets/example#fragment'])(
    'rejects missing or malformed source identity %s', url => {
      const result = resolveCrosswalk([row], [{ ...source, url }], fixture)
      expect(result.byOperationalId.size).toBe(0)
      expect(result.report.invalid).toBeGreaterThan(0)
    },
  )

  it('does not resolve duplicate sources even if titles differ', () => {
    const result = resolveCrosswalk([row], [source, { ...source, title: 'Other title' }], fixture)
    expect(result.report).toMatchObject({ matched: 0, ambiguous: 1 })
    expect(result.byOperationalId.size).toBe(0)
  })

  it('blocks a valid mapping if another malformed mapping claims the same operational id', () => {
    const result = resolveCrosswalk([row], [source], { ...fixture, mappings: [...fixture.mappings, [row.id, null]] })
    expect(result.report).toMatchObject({ matched: 0, invalid: 1 })
  })

  it('validates missing source references even for mappings not used by this operational subset', () => {
    const result = resolveCrosswalk([], [], fixture)
    expect(result.report.invalid).toBe(1)
    expect(result.report.issues[0]).toContain(row.id)
  })
})

describe('bootstrap candidates only', () => {
  it('normalizes punctuation/movie/whitespace only in this offline step', () => {
    const document = bootstrapCrosswalk([{ ...row, title: '  AN - Example (Movie)  ' }], [source], baseline.provenance)
    expect(document.mappings).toEqual(fixture.mappings)
  })

  it('reports ambiguous title candidates without guessing, independent of input order', () => {
    const sources = [source, { ...source, url: source.url + '-other' }]
    const document = bootstrapCrosswalk([row], sources, baseline.provenance)
    expect(document.mappings).toEqual([])
    expect(document.report).toMatchObject({ matched: 0, unmapped: 1, ambiguous: 1, invalid: 0 })
    expect(document.report.issues[0]).toContain(source.url)
    expect(bootstrapCrosswalk([row], [...sources].reverse(), baseline.provenance)).toEqual(document)
  })

  it('does not guess when repeated operational IDs point to different source candidates', () => {
    const document = bootstrapCrosswalk([row, { ...row, title: 'Other' }], [source,
      { ...source, title: 'Other', url: source.url + '-other' }], baseline.provenance)
    expect(document.mappings).toEqual([])
    expect(document.report.ambiguous).toBe(1)
  })

  it('reports unmatched titles and missing identity rather than synthesizing a key', () => {
    const document = bootstrapCrosswalk([{ ...row, id: '' }, { ...row, title: 'No match' }], [source], baseline.provenance)
    expect(document.mappings).toEqual([])
    expect(document.report).toMatchObject({ matched: 0, unmapped: 2, invalid: 1 })
    expect(document.report.unmapped_ids).toEqual(['<missing>', row.id])
  })

  it('rejects duplicate source identifiers despite unique title candidates', () => {
    const document = bootstrapCrosswalk([row], [source, { ...source, title: 'Different' }], baseline.provenance)
    expect(document.mappings).toEqual([])
    expect(document.report.ambiguous).toBe(1)
  })
})