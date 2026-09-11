// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { buildMetadataAudit, buildSnapshotMetadataAudit, parseCanonicalRows } from './metadata-audit'
import { bootstrapCrosswalk } from './snapshot-crosswalk'
import type { MetadataReadinessInput } from '../../functions/api/v1/_lib/metadata-readiness'

const ID = '01HYAAAAAAAAAAAAAAAAAAAAAA'
const base: MetadataReadinessInput = {
  id: ID, origin_node: 'source-node', format: 'image/png', resource_kind: 'product',
  license_spdx: 'MIT', bbox_provenance: 'measured', bbox_evidence: 'Measurement',
  bbox_n: 90, bbox_s: -90, bbox_w: -180, bbox_e: 180,
  temporal_semantics: 'represented', temporal_evidence: 'Acquisition', start_time: '2024-01-01T00:00:00Z', end_time: '2024-01-01T00:00:00Z',
}

describe('pure metadata census', () => {
  it('produces deterministic schema, scope, counts and overlapping inventories', () => {
    const rows: MetadataReadinessInput[] = [
      base,
      { ...base, origin_node: 'b', celestial_body: 'Mars' },
      { ...base, origin_node: 'c', format: 'tour/json' },
      { ...base, origin_node: 'd', resource_kind: 'unknown', license_spdx: null, license_statement: 'Grant text' },
      { ...base, origin_node: 'e', bbox_provenance: 'unknown', license_spdx: 'other', license_url: 'https://example.org/license' },
      { ...base, origin_node: 'f', temporal_semantics: 'unknown' },
    ]
    const report = buildMetadataAudit(rows)
    expect(report).toEqual(buildMetadataAudit(rows))
    expect(report).toMatchObject({ schema_version: 1, input_scope: 'canonical_enriched_rows', assessment: 'metadata_candidates_only', strict_failure: true,
      counts: { total: 6, item_candidate: 1, standalone_item_candidate: 1, collection_candidate: 1, needs_review: 1, excluded: 2 },
      inventory: { unknown_resource: 1, non_earth: 1, presentation: 1, represented_instant: 5, temporal_unknown: 1, license_spdx: 4, license_other: 2, license_text_asset_pending: 1, license_link_unverified: 1 },
    })
    expect(report.reason_counts.resource_non_earth_excluded).toBe(1)
    expect(report.results[1]).toMatchObject({ id: ID, index: 1, decision: 'excluded' })
  })
  it('keeps valid candidates non-strict-failing even though license links remain unverified', () => {
    expect(buildMetadataAudit([{ ...base, license_spdx: null, license_url: 'https://example.org/license' }]).strict_failure).toBe(false)
  })
  it('detects duplicate input identities without confusing distinct revisions or origins', () => {
    expect(buildMetadataAudit([base, base]).results.every(r => r.reasons.includes('identity_duplicate_input'))).toBe(true)
    expect(buildMetadataAudit([base, base]).inventory.identity_unresolved).toBe(2)
    expect(buildMetadataAudit([base, { ...base, origin_node: 'other-node' }]).strict_failure).toBe(false)
    const frames = ['frame-1', 'frame-2'].map(persisted_id => ({ ...base, frame_count: 2, item_identity: { kind: 'frame' as const, persisted_id } }))
    expect(buildMetadataAudit(frames).strict_failure).toBe(false)
  })
  it('does not echo private prose, credentials, URLs or evidence into the census', () => {
    const input = { ...base, abstract: 'DO_NOT_ECHO', bbox_evidence: 'DO_NOT_ECHO', private_profile: 'DO_NOT_ECHO', api_key: 'DO_NOT_ECHO' }
    expect(JSON.stringify(buildMetadataAudit([input]))).not.toContain('DO_NOT_ECHO')
  })
  it('accepts canonical partial rows; unknown fields and absent annotations are not guessed', () => {
    const rows = parseCanonicalRows([{ id: ID, origin_node: 'origin', extension_future: true }])
    expect(buildMetadataAudit(rows).results[0].decision).toBe('needs_review')
    expect(parseCanonicalRows([])).toEqual([])
  })
  it.each([{}, { datasets: [] }, [null], [{ id: ID, originNode: 'origin', format: 'image/png' }], [{ id: ID }], [{ id: ID, origin_node: 'origin', bbox_n: '90' }], [{ id: ID, origin_node: 'origin', item_identity: [] }], [{ id: ID, origin_node: 'origin', curated_license_evidence: { 'LicenseRef-X': 'not evidence object' } }]].map(input => ({ input })))('rejects malformed or public wire input: $input', ({ input }) => {
    expect(() => parseCanonicalRows(input)).toThrow()
  })
  it('reports mapper skips, imported provenance, unknown time and absent D1 identities', () => {
    const source = [{ id: 'INTERNAL_SOS_1', title: 'A product', format: 'image/png', dataLink: 'https://example.org/a.png', boundingVariables: { n: 90, s: -90, w: -180, e: 180 } },
      { id: 'INTERNAL_SOS_2', title: 'Missing data', format: 'image/png', dataLink: '' }]
    const enriched = [{ title: 'A product', url: 'https://sos.noaa.gov/catalog/datasets/a-product/' }]
    const crosswalk = bootstrapCrosswalk(source, enriched, { operational_source: 'list', enrichment_source: 'enriched', operational_sha256: 'a'.repeat(64), enrichment_sha256: 'b'.repeat(64), source_identifier: 'url', method: 'unique-normalized-title-bootstrap-v1', review: 'Test fixture reviewed' })
    const report = buildSnapshotMetadataAudit(source, enriched, crosswalk)
    expect(report).toMatchObject({ input_scope: 'bundled_snapshot_mapping', strict_failure: true, counts: { total: 1 }, snapshot: { source_rows: 2, mapped: 1, skipped: [{ source_id: 'INTERNAL_SOS_2', reason: 'snapshot_missing_data_link' }] } })
    expect(report.results[0]).toMatchObject({ id: null, source_id: 'INTERNAL_SOS_1', identity: { collection_id: null, item_id: null } })
    expect(report.results[0].reasons).toEqual(expect.arrayContaining(['identity_dataset_ulid_invalid', 'identity_origin_node_invalid', 'temporal_unknown', 'spatial_imported_requires_review']))
  })
})