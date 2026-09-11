// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/** Pure offline census. Never loads config, credentials, a database or assets. */
import {
  evaluateMetadataReadiness,
  type MetadataReadinessInput,
  type MetadataDecision,
} from '../../functions/api/v1/_lib/metadata-readiness'
import { mapSnapshot, type RawSosEntry, type RawEnrichedEntry } from './snapshot-import'
import type { SnapshotCrosswalk } from './snapshot-crosswalk'

export const METADATA_AUDIT_SCHEMA_VERSION = 1
export type AuditScope = 'canonical_enriched_rows' | 'bundled_snapshot_mapping'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Accept canonical D1-shaped rows with optional caller enrichment. Raw public
 * WireDataset is deliberately rejected: it omits authoritative provenance and
 * uses originNode, boundingBox, etc. Unknown annotations are ignored, not echoed.
 * Omitted native annotations keep their documented unknown/NULL defaults.
 */
export function parseCanonicalRows(value: unknown): MetadataReadinessInput[] {
  if (!Array.isArray(value)) throw new Error('input_array_required')
  return value.map((row: unknown, index) => {
    const invalid = (): never => { throw new Error(`canonical_row_invalid:${index}`) }
    if (!record(row) || typeof row.id !== 'string' || typeof row.origin_node !== 'string') return invalid()
    for (const key of ['legacy_id', 'format', 'celestial_body', 'license_spdx', 'license_url', 'license_statement', 'bbox_provenance', 'bbox_evidence', 'temporal_semantics', 'temporal_evidence', 'resource_kind', 'start_time', 'end_time', 'publication_kind', 'workflow_id']) {
      if (row[key] != null && typeof row[key] !== 'string') return invalid()
    }
    for (const key of ['bbox_n', 'bbox_s', 'bbox_w', 'bbox_e', 'frame_count', 'schema_version']) {
      if (row[key] != null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]))) return invalid()
    }
    if (row.item_identity != null && (!record(row.item_identity) || typeof row.item_identity.kind !== 'string' ||
        (row.item_identity.persisted_id != null && typeof row.item_identity.persisted_id !== 'string'))) return invalid()
    if (row.curated_license_evidence != null) {
      if (!record(row.curated_license_evidence)) return invalid()
      for (const evidence of Object.values(row.curated_license_evidence)) {
        if (!record(evidence) || (evidence.statement != null && typeof evidence.statement !== 'string') ||
            (evidence.url != null && typeof evidence.url !== 'string')) return invalid()
      }
    }
    return row as MetadataReadinessInput
  })
}

export function buildMetadataAudit(rows: readonly MetadataReadinessInput[], scope: AuditScope = 'canonical_enriched_rows') {
  const counts: Record<MetadataDecision, number> = { item_candidate: 0, collection_candidate: 0, standalone_item_candidate: 0, excluded: 0, needs_review: 0 }
  const inventory = {
    unknown_resource: 0, non_earth: 0, presentation: 0,
    spatial_unknown: 0, spatial_review: 0, represented_instant: 0, represented_interval: 0,
    temporal_unknown: 0, temporal_review: 0,
    license_spdx: 0, license_other: 0, license_unresolved: 0,
    license_link_unverified: 0, license_text_asset_pending: 0, identity_unresolved: 0,
  }
  const reason_counts: Record<string, number> = {}
  const duplicates = new Map<string, number>()
  for (const row of rows) {
    if (row.id && row.origin_node) {
      const key = JSON.stringify([row.origin_node, row.id, row.item_identity?.kind ?? 'one_item', row.item_identity?.persisted_id ?? null])
      duplicates.set(key, (duplicates.get(key) ?? 0) + 1)
    }
  }
  const results = rows.map((row, index) => {
    const result = evaluateMetadataReadiness(row)
    const key = JSON.stringify([row.origin_node, row.id, row.item_identity?.kind ?? 'one_item', row.item_identity?.persisted_id ?? null])
    if ((duplicates.get(key) ?? 0) > 1) {
      result.reasons.push('identity_duplicate_input')
      result.identity.ready = false
      result.identity.reasons.push('identity_duplicate_input')
      if (result.decision !== 'excluded') result.decision = 'needs_review'
    }
    counts[result.decision]++
    if (result.resource === 'unknown') inventory.unknown_resource++
    if (result.body === 'non_earth') inventory.non_earth++
    if (result.resource === 'presentation') inventory.presentation++
    if (result.spatial.status === 'unknown') inventory.spatial_unknown++
    if (result.spatial.status === 'review') inventory.spatial_review++
    if (result.temporal.status === 'instant') inventory.represented_instant++
    if (result.temporal.status === 'interval') inventory.represented_interval++
    if (result.temporal.status === 'unknown') inventory.temporal_unknown++
    if (result.temporal.status === 'review') inventory.temporal_review++
    inventory[`license_${result.license.kind}`]++
    if (result.license.reasons.includes('license_link_unverified')) inventory.license_link_unverified++
    if (result.license.requires_exposed_text_asset) inventory.license_text_asset_pending++
    if (!result.identity.ready) inventory.identity_unresolved++
    for (const reason of result.reasons) reason_counts[reason] = (reason_counts[reason] ?? 0) + 1
    return { index, id: row.id ?? null, source_id: row.legacy_id ?? null, ...result }
  })
  return {
    schema_version: METADATA_AUDIT_SCHEMA_VERSION,
    input_scope: scope,
    assessment: 'metadata_candidates_only' as const,
    limitations: [
      'not_stac_validation', 'not_publication_authorization', 'no_network_or_link_reachability_checks',
      'local_input_only_not_deployed_catalog_census', 'workflow_and_immutable_identity_enrichment_is_caller_supplied',
    ],
    counts: { total: rows.length, ...counts }, inventory, reason_counts, results,
    strict_failure: counts.excluded > 0 || counts.needs_review > 0,
  }
}

/** Map the committed sources through the same crosswalk-aware importer. Source
 * operational IDs are diagnostic labels only: NEVER invent D1 ULIDs/origin_node.
 * Mapper skips remain visible rather than disappearing from the denominator.
 */
export function buildSnapshotMetadataAudit(sos: RawSosEntry[], enriched: RawEnrichedEntry[], crosswalk: SnapshotCrosswalk) {
  const plan = mapSnapshot(sos, enriched, crosswalk)
  const rows: MetadataReadinessInput[] = []
  const skipped: Array<{ source_id: string; reason: string }> = []
  for (const outcome of plan.outcomes) {
    if (outcome.kind === 'skipped') {
      skipped.push({ source_id: outcome.row.legacyId, reason: `snapshot_${outcome.row.reason}` })
      continue
    }
    const d = outcome.row.draft
    rows.push({
      legacy_id: outcome.row.legacyId, format: d.format, resource_kind: d.resource_kind ?? 'unknown',
      celestial_body: d.celestial_body, license_spdx: d.license_spdx, license_statement: d.license_statement, license_url: d.license_url,
      bbox_n: d.bounding_box?.n, bbox_s: d.bounding_box?.s, bbox_w: d.bounding_box?.w, bbox_e: d.bounding_box?.e,
      bbox_provenance: d.bbox_provenance ?? 'unknown', bbox_evidence: d.bbox_evidence,
      temporal_semantics: d.temporal_semantics ?? 'unknown', temporal_evidence: d.temporal_evidence,
      start_time: d.start_time, end_time: d.end_time,
    })
  }
  const report = buildMetadataAudit(rows, 'bundled_snapshot_mapping')
  return {
    ...report,
    snapshot: {
      source_rows: sos.length, enrichment_rows: enriched.length, mapped: rows.length, skipped,
      // Counts only: don't echo curator prose/URLs from arbitrary input documents.
      crosswalk: { matched: plan.crosswalk.matched, unmapped: plan.crosswalk.unmapped, ambiguous: plan.crosswalk.ambiguous, invalid: plan.crosswalk.invalid },
      reasons: [
        'snapshot_has_no_persisted_dataset_identity',
        ...(plan.crosswalk.invalid ? ['snapshot_crosswalk_invalid'] : []),
        ...(plan.crosswalk.ambiguous ? ['snapshot_crosswalk_ambiguous'] : []),
        ...(plan.crosswalk.unmapped ? ['snapshot_crosswalk_unmapped'] : []),
      ],
    },
    strict_failure: report.strict_failure || skipped.length > 0 || plan.crosswalk.invalid > 0 || plan.crosswalk.ambiguous > 0 || plan.crosswalk.unmapped > 0,
  }
}