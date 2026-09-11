// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
// doc-exempt: Snapshot importer identity contract; documented with its existing snapshot-import module.

/** Offline identity resolution, separate from the bootstrap-only title heuristic.
 * Enrichment currently has no sos_id: its exact catalog URL is the source ID.
 * URLs are opaque identifiers here, never fetched or derived from current titles.
 * Many operational IDs may intentionally reference one unique source record.
 */
import type { RawEnrichedEntry, RawSosEntry } from './snapshot-import'

export interface CrosswalkReport {
  /** Operational rows, including repeated occurrences of an operational ID. */
  matched: number
  unmapped: number
  /** Number of ambiguous identity groups; never resolved by input ordering. */
  ambiguous: number
  /** Number of invalid records / references, not an operational-row count. */
  invalid: number
  unmapped_ids: string[]
  issues: string[]
}

export interface SnapshotCrosswalk {
  version: 1
  provenance: {
    operational_source: string
    enrichment_source: string
    operational_sha256: string
    enrichment_sha256: string
    source_identifier: 'url'
    method: 'unique-normalized-title-bootstrap-v1'
    review: string
  }
  /** [immutable operational id, exact enrichment source URL]; no title keys. */
  mappings: Array<[string, string]>
  /** Historical bootstrap evidence only; validation recomputes live counts. */
  report: CrosswalkReport & { duplicate_operational_ids: string[] }
}

export function isOperationalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 &&
    value === value.trim() && !/[\x00-\x1f\x7f]/.test(value)
}

function isSourceId(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'sos.noaa.gov' &&
      url.pathname.startsWith('/catalog/datasets/') && url.pathname.length > 18 &&
      !url.username && !url.password && !url.port && !url.search && !url.hash
  } catch { return false }
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    groups.set(id, [...(groups.get(id) ?? []), row])
  }
  return groups
}

function emptyReport(): CrosswalkReport {
  return { matched: 0, unmapped: 0, ambiguous: 0, invalid: 0, unmapped_ids: [], issues: [] }
}

/** Fail closed per mapping. CLI callers must reject any invalid/ambiguous report
 * before API access. Missing mappings are normal: keep operational metadata only.
 * A duplicate mapping blocks that operational ID even if both targets are equal.
 */
export function resolveCrosswalk(
  operational: RawSosEntry[], enriched: RawEnrichedEntry[], document: unknown,
): { byOperationalId: Map<string, RawEnrichedEntry>; report: CrosswalkReport } {
  const report = emptyReport()
  const byOperationalId = new Map<string, RawEnrichedEntry>()
  const invalid = (message: string) => { report.invalid++; report.issues.push(message) }
  const ambiguous = (message: string) => { report.ambiguous++; report.issues.push(message) }
  const sources = groupBy(enriched, row => row?.url ?? '')
  for (const [id, rows] of sources) {
    if (!isSourceId(id)) invalid(`Missing/invalid enrichment source URL (${rows.length} rows): ${id}`)
    else if (rows.length > 1) ambiguous(`Duplicate enrichment source URL: ${id}`)
  }
  const doc = document as Partial<SnapshotCrosswalk> | null
  const p = doc?.provenance
  if (doc?.version !== 1 || !Array.isArray(doc.mappings) ||
      p?.source_identifier !== 'url' || p.method !== 'unique-normalized-title-bootstrap-v1' ||
      !p.operational_source || !p.enrichment_source || !p.review ||
      !/^[a-f0-9]{64}$/.test(p.operational_sha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(p.enrichment_sha256 ?? '')) {
    invalid('Invalid crosswalk version, mappings, or source provenance')
  } else {
    const mappings = new Map<string, string[]>()
    const blocked = new Set<string>()
    for (const pair of doc.mappings) {
      if (!Array.isArray(pair) || pair.length !== 2 || !isOperationalId(pair[0]) || !isSourceId(pair[1])) {
        invalid(`Invalid crosswalk mapping: ${JSON.stringify(pair)}`)
        if (Array.isArray(pair) && typeof pair[0] === 'string') blocked.add(pair[0])
        continue
      }
      mappings.set(pair[0], [...(mappings.get(pair[0]) ?? []), pair[1]])
    }
    for (const [id, targets] of mappings) {
      if (targets.length !== 1) { ambiguous(`Duplicate crosswalk operational ID: ${id}`); continue }
      if (blocked.has(id)) continue
      const rows = sources.get(targets[0])
      if (!rows) { invalid(`Missing enrichment source for ${id}: ${targets[0]}`); continue }
      if (rows.length !== 1) continue
      byOperationalId.set(id, rows[0])
    }
  }
  for (const row of operational) {
    if (isOperationalId(row.id) && byOperationalId.has(row.id)) report.matched++
    else { report.unmapped++; report.unmapped_ids.push(row.id || '<missing>') }
  }
  report.unmapped_ids.sort()
  report.issues.sort()
  return { byOperationalId, report }
}

/** ONLY the offline candidate generator uses titles. Never call during import.
 * The persisted pairs require review; there is no fuzzy or first/last-wins match.
 * Repeated operational rows may share a pair only if ALL resolve to that pair.
 */
export function bootstrapCrosswalk(
  operational: RawSosEntry[], enriched: RawEnrichedEntry[],
  provenance: SnapshotCrosswalk['provenance'],
): SnapshotCrosswalk {
  const normalize = (title: string) => title.toLowerCase().replace(/\s*\(movie\)\s*/g, '')
    .replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
  const titles = groupBy(enriched, row => normalize(row.title ?? ''))
  const ids = groupBy(operational, row => row.id)
  const mappings: SnapshotCrosswalk['mappings'] = []
  const issues: string[] = []
  let ambiguous = 0
  let invalid = 0
  for (const [id, rows] of ids) {
    if (!isOperationalId(id)) { invalid++; issues.push('Missing/invalid operational ID'); continue }
    const candidates = rows.map(row => {
      const title = normalize(row.title ?? '')
      return title ? titles.get(title) ?? [] : []
    })
    const targets = new Set(candidates.flat().map(row => row.url))
    if (candidates.some(matches => matches.length > 1) || targets.size > 1 ||
        (targets.size === 1 && candidates.some(matches => matches.length === 0))) {
      ambiguous++
      issues.push(`Ambiguous title candidates for ${id}: ${[...targets].sort().join(', ')}`)
      continue
    }
    if (targets.size === 1) {
      const target = [...targets][0]
      if (isSourceId(target)) mappings.push([id, target])
      else { invalid++; issues.push(`Missing/invalid candidate source URL for ${id}`) }
    }
  }
  mappings.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const document: SnapshotCrosswalk = {
    version: 1, provenance, mappings,
    report: { ...emptyReport(), duplicate_operational_ids: [...ids]
      .filter(([, rows]) => rows.length > 1).map(([id]) => id).sort() },
  }
  const resolved = resolveCrosswalk(operational, enriched, document)
  // Drop source-identity collisions even when a title candidate was unique.
  document.mappings = mappings.filter(([id]) => resolved.byOperationalId.has(id))
  document.report = { ...resolved.report,
    ambiguous: resolved.report.ambiguous + ambiguous,
    invalid: resolved.report.invalid + invalid,
    issues: [...resolved.report.issues, ...issues].sort(),
    duplicate_operational_ids: document.report.duplicate_operational_ids,
  }
  return document
}