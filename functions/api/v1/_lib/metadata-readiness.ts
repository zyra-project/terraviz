// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/** Offline policy checks, NOT STAC serialization or native publish validation.
 * Canonical snake_case columns come from DatasetRow, not public WireDataset.
 * Unknown extra fields are ignored; absent provenance is unknown. Publication
 * and mutation timestamps are never interpreted as represented scientific time.
 */
import parseSpdx from 'spdx-expression-parse'
import type { BboxProvenance, ResourceKind, TemporalSemantics } from './validators'

export type MetadataDecision = 'item_candidate' | 'collection_candidate' |
  'standalone_item_candidate' | 'excluded' | 'needs_review'

/** Enrichment is caller-supplied, never inferred by fetching an asset or parsing
 * a slug, cadence, URL, or updated_at. A D1 export must join workflow ownership
 * to identify recurring products. persisted_id asserts an actually stored,
 * immutable frame/revision key, not a transient frame index or timestamp.
 * These annotations are NOT new DatasetRow columns or native wire fields.
 */
export interface MetadataReadinessInput {
  // Structural subset of DatasetRow, without importing its D1 runtime types
  // into CLI consumers. New provenance vocabulary shares the validator types.
  id?: string
  origin_node?: string
  legacy_id?: string | null
  schema_version?: number
  format?: string
  resource_kind?: ResourceKind
  celestial_body?: string | null
  bbox_n?: number | null
  bbox_s?: number | null
  bbox_w?: number | null
  bbox_e?: number | null
  bbox_provenance?: BboxProvenance
  bbox_evidence?: string | null
  temporal_semantics?: TemporalSemantics
  temporal_evidence?: string | null
  start_time?: string | null
  end_time?: string | null
  license_spdx?: string | null
  license_statement?: string | null
  license_url?: string | null
  frame_count?: number | null
  // Explicitly NOT identity, represented-time, or license fallbacks. They are
  // accepted to make the separation from the native row contract unambiguous.
  slug?: string
  created_at?: string
  updated_at?: string
  published_at?: string | null
  visibility?: string
  is_hidden?: number
  attribution_text?: string | null
  rights_holder?: string | null
  publication_kind?: 'indivisible' | 'sequence' | 'workflow' | 'unknown'
  workflow_id?: string | null
  item_identity?: { kind: 'one_item' | 'frame' | 'revision'; persisted_id?: string }
  /** Exact parsed LicenseRef leaf -> curator evidence; required for EACH ref. */
  curated_license_evidence?: Record<string, { statement?: string; url?: string }>
}

export interface ReadinessCheck {
  ready: boolean
  reasons: string[]
}

export interface LicenseReadiness extends ReadinessCheck {
  kind: 'spdx' | 'other' | 'unresolved'
  /** Syntax-only checking: no network access or assertion of reachability. */
  link_status: 'unverified' | 'pending_exposed_asset' | 'not_required' | 'missing'
  requires_exposed_text_asset: boolean
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Safe syntactic link only. Credentials, controls, relative/protocol-relative
 * URLs and URL-parser repairs (e.g. https:foo or backslashes) are not evidence. */
export function isSafeLicenseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return !!url.hostname && !url.username && !url.password && ['http:', 'https:'].includes(url.protocol)
  } catch { return false }
}

function licenseRefs(tree: parseSpdx.Info): string[] {
  if ('conjunction' in tree) return [...licenseRefs(tree.left), ...licenseRefs(tree.right)]
  return tree.license.includes('LicenseRef-') ? [tree.license] : []
}

export function evaluateLicense(input: MetadataReadinessInput): LicenseReadiness {
  const fail = (reason: string): LicenseReadiness => ({ ready: false, kind: 'unresolved', reasons: [reason], link_status: 'missing', requires_exposed_text_asset: false })
  const expression = input.license_spdx
  if (expression != null && typeof expression !== 'string') return fail('license_spdx_malformed')
  if (expression != null && expression !== 'other') {
    let tree: parseSpdx.Info
    try { tree = parseSpdx(expression) } catch { return fail('license_spdx_malformed') }
    const refs = [...new Set(licenseRefs(tree))]
    if (!refs.length) return { ready: true, kind: 'spdx', reasons: [], link_status: 'not_required', requires_exposed_text_asset: false }
    let textAsset = false
    let unverified = false
    for (const ref of refs) {
      const evidence = Object.hasOwn(input.curated_license_evidence ?? {}, ref) ? input.curated_license_evidence?.[ref] : undefined
      if (!evidence || (!nonempty(evidence.statement) && !isSafeLicenseUrl(evidence.url))) return fail('license_ref_evidence_missing')
      if (isSafeLicenseUrl(evidence.url)) unverified = true
      else textAsset = true
    }
    return {
      ready: true, kind: 'other', requires_exposed_text_asset: textAsset,
      link_status: textAsset ? 'pending_exposed_asset' : 'unverified',
      reasons: ['license_ref_curated_as_other', ...(textAsset ? ['license_text_asset_pending'] : []), ...(unverified ? ['license_link_unverified'] : [])],
    }
  }
  const link = isSafeLicenseUrl(input.license_url)
  const text = nonempty(input.license_statement)
  if (!link && !text) return fail(nonempty(input.license_url) ? 'license_url_unsafe' : 'license_evidence_missing')
  return {
    ready: true, kind: 'other', link_status: link ? 'unverified' : 'pending_exposed_asset',
    requires_exposed_text_asset: !link,
    reasons: [link ? 'license_link_unverified' : 'license_text_asset_pending', ...(!link && nonempty(input.license_url) ? ['license_url_unsafe'] : [])],
  }
}

export interface SpatialReadiness extends ReadinessCheck {
  status: 'known' | 'unknown' | 'review'
  /** NSWE retained deliberately; antimeridian w > e is valid, never expanded. */
  bounds: { n: number; s: number; w: number; e: number } | null
}

export function evaluateSpatial(input: MetadataReadinessInput): SpatialReadiness {
  const result = (status: SpatialReadiness['status'], reason: string): SpatialReadiness => ({ ready: false, status, bounds: null, reasons: [reason] })
  const p = input.bbox_provenance ?? 'unknown'
  if (p === 'unknown') return result('unknown', 'spatial_unknown')
  if (p === 'imported' || p === 'inferred') return result('review', `spatial_${p}_requires_review`)
  if (p !== 'measured' && p !== 'declared_global') return result('review', 'spatial_provenance_unsupported')
  if (!nonempty(input.bbox_evidence)) return result('review', 'spatial_evidence_missing')
  const { bbox_n: n, bbox_s: s, bbox_w: w, bbox_e: e } = input
  if (typeof n !== 'number' || typeof s !== 'number' || typeof w !== 'number' || typeof e !== 'number' ||
      ![n, s, w, e].every(Number.isFinite) || n < s || s < -90 || n > 90 || w < -180 || w > 180 || e < -180 || e > 180) {
    return result('review', 'spatial_bounds_invalid')
  }
  if (p === 'declared_global' && !(n === 90 && s === -90 && w === -180 && e === 180)) return result('review', 'spatial_global_bounds_mismatch')
  return { ready: true, status: 'known', bounds: { n, s, w, e }, reasons: [] }
}

/** Strict calendar validation, unlike Date.parse's February rollover. Accepts
 * complete RFC3339 instants (Z or numeric offset), never bare dates, leap-second
 * guesses or 24:00. Fraction precision is retained when ordering equal seconds. */
function parseInstant(value: unknown): { seconds: number; fraction: string } | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!m) return null
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null
  const zone = m[8]
  // RFC3339 -00:00 denotes an unknown local offset, not a known instant.
  if (zone === '-00:00' || (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) return null
  const seconds = Date.parse(`${value.slice(0, 19)}${zone}`) / 1000
  return Number.isFinite(seconds) ? { seconds, fraction: m[7] ?? '' } : null
}

export interface TemporalReadiness extends ReadinessCheck {
  status: 'instant' | 'interval' | 'unknown' | 'review'
  interval: [string, string] | null
}

export function evaluateTemporal(input: MetadataReadinessInput): TemporalReadiness {
  const fail = (status: 'unknown' | 'review', reason: string): TemporalReadiness => ({ ready: false, status, interval: null, reasons: [reason] })
  const semantics = input.temporal_semantics ?? 'unknown'
  if (semantics !== 'represented') {
    if (!['unknown', 'publication', 'schedule'].includes(semantics)) return fail('review', 'temporal_semantics_unsupported')
    return fail('unknown', `temporal_${semantics}`)
  }
  if (!nonempty(input.temporal_evidence)) return fail('review', 'temporal_evidence_missing')
  if (!nonempty(input.start_time) || !nonempty(input.end_time)) return fail('review', 'temporal_interval_incomplete')
  const start = parseInstant(input.start_time)
  const end = parseInstant(input.end_time)
  if (!start || !end) return fail('review', 'temporal_date_invalid')
  const length = Math.max(start.fraction.length, end.fraction.length)
  const sf = start.fraction.padEnd(length, '0'), ef = end.fraction.padEnd(length, '0')
  if (start.seconds > end.seconds || (start.seconds === end.seconds && sf > ef)) return fail('review', 'temporal_interval_reversed')
  return { ready: true, status: start.seconds === end.seconds && sf === ef ? 'instant' : 'interval', interval: [input.start_time, input.end_time], reasons: [] }
}

/** The existing ulid.ts exports only newUlid. Enforce its uppercase Crockford
 * encoding plus the ULID 128-bit ceiling here, without changing that utility. */
export function isMetadataUlid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)
}

export interface MetadataIdentity extends ReadinessCheck {
  collection_id: string | null
  item_id: string | null
  mode: 'one_item' | 'frame' | 'revision' | 'unknown'
}

export function buildMetadataIdentity(input: MetadataReadinessInput): MetadataIdentity {
  const reasons: string[] = []
  if (!isMetadataUlid(input.id)) reasons.push('identity_dataset_ulid_invalid')
  // Origin is an opaque persisted node namespace, NOT a host URL or local node.
  if (typeof input.origin_node !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.origin_node)) reasons.push('identity_origin_node_invalid')
  const collection_id = reasons.length ? null : `${input.origin_node}-${input.id}`
  const kind = input.publication_kind
  if (input.frame_count != null && (!Number.isSafeInteger(input.frame_count) || input.frame_count < 1)) reasons.push('identity_frame_count_invalid')
  const workflow = nonempty(input.workflow_id) || kind === 'workflow'
  const sequence = (input.frame_count != null && input.frame_count > 0) || kind === 'sequence'
  const expected = workflow ? 'revision' : sequence ? 'frame' : 'one_item'
  const supplied = input.item_identity
  let mode: MetadataIdentity['mode'] = expected
  let item_id: string | null = null
  if (kind != null && !['indivisible', 'sequence', 'workflow'].includes(kind)) {
    reasons.push('identity_publication_kind_unknown')
    mode = 'unknown'
  } else if (supplied && supplied.kind !== expected) {
    reasons.push('identity_mode_conflict')
  } else if (expected === 'one_item') {
    if (supplied?.persisted_id != null) reasons.push('identity_one_item_must_reuse_dataset_ulid')
    else if (collection_id) item_id = input.id!
  } else if (!supplied || !nonempty(supplied.persisted_id)) {
    reasons.push('identity_persisted_id_missing')
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(supplied.persisted_id)) {
    reasons.push('identity_persisted_id_invalid')
  } else if (collection_id) {
    item_id = `${input.id}-${expected}-${supplied.persisted_id}`
  }
  return { ready: reasons.length === 0, collection_id, item_id: reasons.length ? null : item_id, mode, reasons }
}

export interface MetadataReadiness {
  decision: MetadataDecision
  reasons: string[]
  resource: 'product' | 'presentation' | 'unknown'
  body: 'earth' | 'non_earth' | 'unknown'
  spatial: SpatialReadiness
  temporal: TemporalReadiness
  license: LicenseReadiness
  identity: MetadataIdentity
}

/** Candidates describe metadata shape only, NOT publication authorization,
 * reachable assets, valid STAC, or deployed-catalog completeness. Future routes
 * must separately apply visibility/published/hidden/retracted access policy. */
export function evaluateMetadataReadiness(input: MetadataReadinessInput): MetadataReadiness {
  const spatial = evaluateSpatial(input), temporal = evaluateTemporal(input)
  const license = evaluateLicense(input), identity = buildMetadataIdentity(input)
  const resource = input.format === 'tour/json' || input.resource_kind === 'presentation' ? 'presentation' : input.resource_kind === 'product' ? 'product' : 'unknown'
  // Native contract defines NULL/empty celestial_body as Earth, not the bbox.
  const body = input.celestial_body != null && typeof input.celestial_body !== 'string' ? 'unknown' :
    nonempty(input.celestial_body) && input.celestial_body.trim().toLowerCase() !== 'earth' ? 'non_earth' : 'earth'
  const reasons = [...spatial.reasons, ...temporal.reasons, ...license.reasons, ...identity.reasons]
  const schemaKnown = input.schema_version == null || input.schema_version === 1
  if (!schemaKnown) reasons.push('schema_version_unsupported')
  if (resource === 'unknown') reasons.push('resource_kind_unknown')
  if (resource === 'presentation') reasons.push('resource_presentation_excluded')
  if (body === 'non_earth') reasons.push('resource_non_earth_excluded')
  if (body === 'unknown') reasons.push('celestial_body_invalid')
  const formatKnown = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(input.format ?? '')
  if (!formatKnown && resource !== 'presentation') reasons.push('resource_format_unsupported')
  let decision: MetadataDecision = 'needs_review'
  if (resource === 'presentation' || body === 'non_earth') decision = 'excluded'
  else if (schemaKnown && resource === 'product' && body === 'earth' && formatKnown && license.ready && identity.ready && spatial.status !== 'review' && temporal.status !== 'review') {
    if (spatial.ready && temporal.ready) decision = 'item_candidate'
    else if (spatial.ready) decision = 'collection_candidate'
    else if (temporal.ready) decision = 'standalone_item_candidate'
  }
  return { decision, reasons, resource, body, spatial, temporal, license, identity }
}