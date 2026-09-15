// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  buildMetadataIdentity, evaluateLicense, evaluateMetadataReadiness, evaluateSpatial,
  evaluateTemporal, isMetadataUlid, isSafeLicenseUrl, type MetadataReadinessInput,
} from './metadata-readiness'
import { newUlid } from './ulid'
import { validateForPublish } from './validators'
import type { DatasetRow } from './catalog-store'

const ID = '01HYAAAAAAAAAAAAAAAAAAAAAA'
function product(overrides: MetadataReadinessInput = {}): MetadataReadinessInput {
  return {
    id: ID, origin_node: 'origin-node', schema_version: 1, format: 'image/png', resource_kind: 'product',
    bbox_n: 40, bbox_s: 20, bbox_w: 170, bbox_e: -170, bbox_provenance: 'measured', bbox_evidence: 'Source grid corners',
    temporal_semantics: 'represented', temporal_evidence: 'Acquisition metadata',
    start_time: '2024-02-29T12:00:00Z', end_time: '2024-02-29T12:00:00Z', license_spdx: 'CC-BY-4.0',
    ...overrides,
  }
}

describe('strict SPDX readiness independent of native publishing', () => {
  it.each(['MIT', 'CC0-1.0', 'MIT OR Apache-2.0', '(MIT OR Apache-2.0) AND BSD-3-Clause', 'GPL-2.0-only WITH Classpath-exception-2.0', 'GPL-2.0+'])('parses real SPDX: %s', license_spdx => {
    expect(evaluateLicense({ license_spdx })).toMatchObject({ ready: true, kind: 'spdx', link_status: 'not_required' })
  })
  it.each(['', ' ', 'Made-Up-1.0', 'MIT OR', 'MIT Apache-2.0', '(MIT OR Apache-2.0', 'mit', 'MIT WITH Fake-exception', 'MIT AND OR Apache-2.0', 'MIT / Apache-2.0', 'NONE', 'NOASSERTION'])('never falls back after malformed SPDX: %s', license_spdx => {
    expect(evaluateLicense({ license_spdx, license_statement: 'Real license text', license_url: 'https://example.org/license' })).toMatchObject({ ready: false, reasons: ['license_spdx_malformed'] })
  })
  it('rejects uncurated LicenseRefs even when a general license statement exists', () => {
    expect(evaluateLicense({ license_spdx: 'MIT OR LicenseRef-Partner', license_statement: 'Not curated to this reference' }).reasons).toEqual(['license_ref_evidence_missing'])
    expect(evaluateLicense({ license_spdx: 'DocumentRef-Agency:LicenseRef-Partner' }).ready).toBe(false)
  })
  it('requires curated evidence for every custom leaf, including DocumentRefs', () => {
    const input: MetadataReadinessInput = {
      license_spdx: 'LicenseRef-A AND DocumentRef-Agency:LicenseRef-B',
      curated_license_evidence: { 'LicenseRef-A': { statement: 'Curated grant A' } },
    }
    expect(evaluateLicense(input).ready).toBe(false)
    input.curated_license_evidence!['DocumentRef-Agency:LicenseRef-B'] = { url: 'https://example.org/license' }
    expect(evaluateLicense(input)).toMatchObject({ ready: true, kind: 'other', requires_exposed_text_asset: true, reasons: ['license_ref_curated_as_other', 'license_text_asset_pending', 'license_link_unverified'] })
  })
  it.each([undefined, null, 'other'])('accepts non-SPDX text but requires a future exposed asset (%s)', license_spdx => {
    expect(evaluateLicense({ license_spdx, license_statement: 'Redistribution permitted with attribution.' })).toMatchObject({ ready: true, kind: 'other', link_status: 'pending_exposed_asset', requires_exposed_text_asset: true })
  })
  it.each(['http://example.org/license', 'https://example.org/license?q=terms#grant'])('accepts syntax-only license links without claiming reachability: %s', license_url => {
    expect(evaluateLicense({ license_spdx: 'other', license_url })).toMatchObject({ ready: true, link_status: 'unverified', reasons: ['license_link_unverified'] })
  })
  it.each(['//example.org/license', '/license', 'javascript:alert(1)', 'data:text/plain,license', 'ftp://example.org/license', 'https:example.org', 'https://user:secret@example.org/license', 'https://example.org/white space', 'https://example.org\\license', 'https://example.org/\nlicense'])('rejects unsafe link: %s', url => {
    expect(isSafeLicenseUrl(url)).toBe(false)
    expect(evaluateLicense({ license_url: url }).ready).toBe(false)
  })
  it('rejects missing/blank other evidence, and does not mistake attribution for license text', () => {
    expect(evaluateLicense({ license_spdx: 'other', license_statement: '  ', attribution_text: 'NOAA', rights_holder: 'NOAA' }).ready).toBe(false)
  })
  it('leaves permissive native publish validation unchanged', () => {
    const draft = { title: 'Native product', format: 'image/png', data_ref: 'url:https://example.org/image.png', visibility: 'public', slug: 'native-product', license_spdx: 'Definitely-not-SPDX' }
    expect(validateForPublish(draft)).toEqual([])
    expect(evaluateLicense(draft).ready).toBe(false)
  })
})

describe('truthful spatial and represented-time metadata', () => {
  it('retains a measured antimeridian box without world expansion', () => {
    expect(evaluateSpatial(product())).toEqual({ ready: true, status: 'known', reasons: [], bounds: { n: 40, s: 20, w: 170, e: -170 } })
  })
  it('does not turn missing provenance or bounds into global extent', () => {
    expect(evaluateSpatial({})).toMatchObject({ ready: false, status: 'unknown', bounds: null })
    expect(evaluateSpatial(product({ bbox_provenance: undefined }))).toMatchObject({ ready: false, bounds: null })
    expect(evaluateSpatial(product({ bbox_n: null }))).toMatchObject({ reasons: ['spatial_bounds_invalid'] })
  })
  it.each(['imported', 'inferred'] as const)('requires review for %s even with evidence', bbox_provenance => {
    expect(evaluateSpatial(product({ bbox_provenance }))).toMatchObject({ ready: false, status: 'review', bounds: null })
    expect(evaluateMetadataReadiness(product({ bbox_provenance })).decision).toBe('needs_review')
  })
  it('only accepts declared global when all four explicit bounds and evidence agree', () => {
    expect(evaluateSpatial(product({ bbox_provenance: 'declared_global' })).ready).toBe(false)
    const global = product({ bbox_provenance: 'declared_global', bbox_n: 90, bbox_s: -90, bbox_w: -180, bbox_e: 180 })
    expect(evaluateSpatial(global).ready).toBe(true)
    expect(evaluateSpatial({ ...global, bbox_evidence: ' ' }).ready).toBe(false)
  })
  it.each([{ bbox_n: 91 }, { bbox_s: -91 }, { bbox_w: -181 }, { bbox_e: 181 }, { bbox_s: 50 }, { bbox_n: NaN }, { bbox_w: Infinity }])('rejects invalid coordinates: %j', overrides => {
    expect(evaluateSpatial(product(overrides)).ready).toBe(false)
  })
  it.each(['2023-02-29T00:00:00Z', '2024-02-30T00:00:00Z', '2024-04-31T00:00:00Z', '1900-02-29T00:00:00Z', '2024-13-01T00:00:00Z', '2024-00-01T00:00:00Z', '2024-01-00T00:00:00Z', '2024-01-01T24:00:00Z', '2024-01-01T12:60:00Z', '2024-01-01T12:00:60Z', '2024-01-01', '2024-01-01T00:00:00', '2024-01-01T00:00:00+24:00', '2024-01-01T00:00:00+01:60', '2024-01-01T00:00:00-00:00', '0000-01-01T00:00:00Z'])('rejects calendar/instant error: %s', start_time => {
    expect(evaluateTemporal(product({ start_time, end_time: start_time })).reasons).toEqual(['temporal_date_invalid'])
  })
  it('handles true leap dates, offsets, intervals and equal instants', () => {
    expect(evaluateTemporal(product()).status).toBe('instant')
    expect(evaluateTemporal(product({ start_time: '2000-02-29T00:00:00Z', end_time: '2000-02-29T01:00:00+01:00' })).status).toBe('instant')
    expect(evaluateTemporal(product({ end_time: '2024-03-01T00:00:00Z' })).status).toBe('interval')
    expect(evaluateTemporal(product({ start_time: '2024-03-01T00:00:00Z' })).reasons).toEqual(['temporal_interval_reversed'])
  })
  it('compares sub-millisecond fractions without rounding to a false instant', () => {
    expect(evaluateTemporal(product({ start_time: '2024-02-29T12:00:00.00001Z', end_time: '2024-02-29T12:00:00.00002Z' })).status).toBe('interval')
    expect(evaluateTemporal(product({ start_time: '2024-02-29T12:00:00.00002Z', end_time: '2024-02-29T12:00:00.00001Z' })).ready).toBe(false)
  })
  it('requires both interval endpoints and represented evidence', () => {
    expect(evaluateTemporal(product({ end_time: null })).reasons).toEqual(['temporal_interval_incomplete'])
    expect(evaluateTemporal(product({ temporal_evidence: ' ' })).reasons).toEqual(['temporal_evidence_missing'])
    expect(evaluateTemporal(product({ start_time: null, end_time: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-02-01T00:00:00Z', published_at: '2024-02-01T00:00:00Z' })).reasons).toEqual(['temporal_interval_incomplete'])
  })
  it.each(['publication', 'schedule', 'unknown', undefined] as const)('never uses %s or mutation timestamps as represented time', temporal_semantics => {
    expect(evaluateTemporal(product({ temporal_semantics, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-02-01T00:00:00Z', published_at: '2024-02-01T00:00:00Z' }))).toMatchObject({ ready: false, status: 'unknown', interval: null })
  })
})

describe('stable immutable identity and eligibility', () => {
  it('validates IDs minted by the existing utility including timestamp extremes', () => {
    expect(isMetadataUlid(newUlid(0))).toBe(true)
    expect(isMetadataUlid(newUlid(281474976710655))).toBe(true)
  })
  it.each(['81HYAAAAAAAAAAAAAAAAAAAAAA', '01HYAAAAAAAAAAAAAAAAAAAAAI', '01HYAAAAAAAAAAAAAAAAAAAAAO', '01HYAAAAAAAAAAAAAAAAAAAAAU', ID.toLowerCase(), 'my-slug', 'INTERNAL_SOS_768', ID + 'A'])('rejects invalid/overflow ULID: %s', id => {
    expect(buildMetadataIdentity(product({ id })).ready).toBe(false)
  })
  it('reuses the static dataset ULID, namespaced by immutable origin, not slug or mirror host', () => {
    const a = product({ slug: 'old-name' })
    const b = { ...a, slug: 'renamed', local_node: 'mirror-node', originNodeUrl: 'https://different-host.example' }
    expect(buildMetadataIdentity(a)).toEqual(buildMetadataIdentity(b))
    expect(buildMetadataIdentity(a)).toMatchObject({ ready: true, collection_id: `origin-node-${ID}`, item_id: ID, mode: 'one_item' })
    expect(buildMetadataIdentity(product({ origin_node: 'another-origin' })).collection_id).not.toBe(buildMetadataIdentity(a).collection_id)
    expect(buildMetadataIdentity(product({ origin_node: undefined })).ready).toBe(false)
  })
  it.each(['https://mirror.example', '../origin', 'origin/child', ' origin', 'origin\n'])('rejects non-namespace origin: %s', origin_node => {
    expect(buildMetadataIdentity(product({ origin_node })).ready).toBe(false)
  })
  it.each([{ frame_count: 12 }, { publication_kind: 'sequence' }, { publication_kind: 'workflow' }, { workflow_id: 'workflow-1' }] as MetadataReadinessInput[])('does not fabricate mutable product identities: %j', overrides => {
    const result = buildMetadataIdentity(product({ ...overrides, updated_at: '2024-02-29T12:00:00Z', slug: 'revision-looking-name' }))
    expect(result).toMatchObject({ ready: false, item_id: null })
    expect(result.reasons).toContain('identity_persisted_id_missing')
    expect(evaluateMetadataReadiness(product(overrides)).decision).toBe('needs_review')
  })
  it('uses only explicit persisted frame/revision identifiers', () => {
    expect(buildMetadataIdentity(product({ frame_count: 2, item_identity: { kind: 'frame', persisted_id: 'immutable-frame-9' } }))).toMatchObject({ ready: true, item_id: `${ID}-frame-immutable-frame-9` })
    expect(buildMetadataIdentity(product({ workflow_id: 'workflow-1', item_identity: { kind: 'revision', persisted_id: 'immutable-revision-2' } }))).toMatchObject({ ready: true, item_id: `${ID}-revision-immutable-revision-2` })
    expect(buildMetadataIdentity(product({ frame_count: 2, item_identity: { kind: 'one_item' } })).ready).toBe(false)
    expect(buildMetadataIdentity(product({ item_identity: { kind: 'one_item', persisted_id: 'replacement' } })).ready).toBe(false)
    expect(buildMetadataIdentity(product({ frame_count: 2, item_identity: { kind: 'frame', persisted_id: '../path' } })).ready).toBe(false)
  })
  it.each([0, -1, 1.5, NaN, Infinity])('never downgrades an invalid frame count to a one-Item identity: %s', frame_count => {
    expect(buildMetadataIdentity(product({ frame_count }))).toMatchObject({ ready: false, item_id: null })
  })
  it.each([
    [{}, 'item_candidate'],
    [{ temporal_semantics: 'unknown' }, 'collection_candidate'],
    [{ temporal_semantics: 'publication' }, 'collection_candidate'],
    [{ bbox_provenance: 'unknown' }, 'standalone_item_candidate'],
    [{ bbox_provenance: 'unknown', temporal_semantics: 'unknown' }, 'needs_review'],
    [{ resource_kind: 'unknown' }, 'needs_review'],
    [{ resource_kind: 'presentation' }, 'excluded'],
    [{ format: 'tour/json' }, 'excluded'],
    [{ celestial_body: 'Mars' }, 'excluded'],
    [{ celestial_body: ' Earth ' }, 'item_candidate'],
    [{ schema_version: 42 }, 'needs_review'],
    [{ schema_version: undefined }, 'item_candidate'],
    [{ format: 'unknown/format' }, 'needs_review'],
  ] as Array<[MetadataReadinessInput, string]>)('classifies %j as %s', (overrides, decision) => {
    expect(evaluateMetadataReadiness(product(overrides)).decision).toBe(decision)
  })
  it('fails unknown annotations closed and ignores unrelated extension fields', () => {
    expect(evaluateMetadataReadiness({}).decision).toBe('needs_review')
    expect(evaluateMetadataReadiness(product({ bbox_provenance: 'future' as never })).decision).toBe('needs_review')
    expect(evaluateMetadataReadiness(product({ temporal_semantics: 'future' as never })).decision).toBe('needs_review')
    const input = { ...product(), future_extension: 'not used' }
    expect(evaluateMetadataReadiness(input)).toEqual(evaluateMetadataReadiness(product()))
  })
  it('never mutates input and does not treat readiness as publication authorization', () => {
    const row = Object.freeze(product({ visibility: 'private', is_hidden: 1, published_at: null }))
    const before = JSON.stringify(row)
    expect(evaluateMetadataReadiness(row).decision).toBe('item_candidate')
    expect(JSON.stringify(row)).toBe(before)
  })
  it('remains structurally compatible with the canonical store row', () => {
    const canonical: Partial<DatasetRow> = product()
    expect(evaluateMetadataReadiness(canonical).decision).toBe('item_candidate')
  })
})