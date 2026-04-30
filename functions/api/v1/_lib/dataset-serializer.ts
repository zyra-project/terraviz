/**
 * Maps `DatasetRow` + `DecorationRows` to the wire `Dataset` shape
 * that frontend consumers expect.
 *
 * Wire shape is the existing `src/types/index.ts` `Dataset` plus
 * the additive set documented in CATALOG_BACKEND_PLAN.md "API
 * surface" — `originNode`, `originNodeUrl`, `originDisplayName`,
 * `visibility`, `schemaVersion`. The federation `signature` field
 * is *not* set here; it lives on the federation feed serializer
 * (Phase 4).
 *
 * `dataLink` resolves to the manifest endpoint, not the underlying
 * vimeo / url / stream / r2 reference. Commit C lands the manifest
 * resolver; until then the `dataLink` URL 404s but the catalog
 * response itself is still well-formed. Commit H swaps the
 * frontend's `dataService.ts` to read from this endpoint and
 * follow the manifest link.
 */

import type { DatasetRow, DecorationRows, NodeIdentityRow } from './catalog-store'

/**
 * The wire `Dataset` shape — additive superset of the existing
 * frontend `Dataset` interface in `src/types/index.ts`. Phase 1a
 * keeps optional fields optional so older clients that don't know
 * about them ignore them silently.
 */
export interface WireDataset {
  id: string
  slug: string
  title: string
  format: string
  dataLink: string
  organization?: string
  abstractTxt?: string
  thumbnailLink?: string
  legendLink?: string
  closedCaptionLink?: string
  websiteLink?: string
  startTime?: string
  endTime?: string
  period?: string
  weight?: number
  isHidden?: boolean
  runTourOnLoad?: string
  tags?: string[]
  enriched?: {
    description?: string
    categories?: Record<string, string[]>
    keywords?: string[]
    relatedDatasets?: Array<{ title: string; url: string }>
    datasetDeveloper?: { name: string; affiliationUrl?: string }
    visDeveloper?: { name: string; affiliationUrl?: string }
  }
  // Phase-1a additive fields (always present).
  originNode: string
  originNodeUrl: string
  originDisplayName: string
  visibility: 'public' | 'federated' | 'restricted' | 'private'
  schemaVersion: number
  // License & attribution (additive — only set when populated).
  licenseSpdx?: string
  licenseUrl?: string
  licenseStatement?: string
  attributionText?: string
  rightsHolder?: string
  doi?: string
  citationText?: string
  // Lifecycle timestamps (additive — let federation subscribers see
  // when a row last changed).
  createdAt: string
  updatedAt: string
  publishedAt?: string
  /**
   * Bulk-import provenance — set by `terraviz import-snapshot` to
   * the SOS snapshot's internal id (e.g. `INTERNAL_SOS_768`). The
   * frontend's tour engine matches references to legacy IDs against
   * post-cutover ULID-keyed rows by falling back to this field
   * when a primary `id` lookup misses. NULL on rows the publisher
   * created by hand. Phase 1d/T.
   */
  legacyId?: string
}

function nonNull<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v
}

/**
 * Build the absolute manifest URL for a dataset. Same-origin so
 * the desktop Tauri app and the web bundle both follow it without
 * config; the proxy handles the cross-origin case.
 */
function manifestLink(baseUrl: string, datasetId: string): string {
  // Use a path-only string so subscribers and same-origin callers
  // can resolve relative; federation peers (Phase 4) resolve
  // against the origin node's base_url separately.
  return `/api/v1/datasets/${datasetId}/manifest`
}

/**
 * Group categories by facet. Frontend expects `categories` keyed
 * by facet name (e.g. "Theme") with arrays of values.
 */
function groupCategories(
  rows: Array<{ facet: string; value: string }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const r of rows) {
    const arr = out[r.facet] ?? []
    arr.push(r.value)
    out[r.facet] = arr
  }
  return out
}

export function serializeDataset(
  row: DatasetRow,
  decoration: DecorationRows,
  identity: NodeIdentityRow,
): WireDataset {
  const wire: WireDataset = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    format: row.format,
    dataLink: manifestLink(identity.base_url, row.id),
    organization: nonNull(row.organization),
    abstractTxt: nonNull(row.abstract),
    thumbnailLink: nonNull(row.thumbnail_ref),
    legendLink: nonNull(row.legend_ref),
    closedCaptionLink: nonNull(row.caption_ref),
    websiteLink: nonNull(row.website_link),
    startTime: nonNull(row.start_time),
    endTime: nonNull(row.end_time),
    period: nonNull(row.period),
    weight: row.weight,
    isHidden: row.is_hidden === 1 ? true : undefined,
    runTourOnLoad: nonNull(row.run_tour_on_load),
    tags: decoration.tags.length ? decoration.tags : undefined,

    originNode: row.origin_node,
    originNodeUrl: identity.base_url,
    originDisplayName: identity.display_name,
    visibility: row.visibility as WireDataset['visibility'],
    schemaVersion: row.schema_version,

    licenseSpdx: nonNull(row.license_spdx),
    licenseUrl: nonNull(row.license_url),
    licenseStatement: nonNull(row.license_statement),
    attributionText: nonNull(row.attribution_text),
    rightsHolder: nonNull(row.rights_holder),
    doi: nonNull(row.doi),
    citationText: nonNull(row.citation_text),

    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: nonNull(row.published_at),
    legacyId: nonNull(row.legacy_id),
  }

  // Enriched fields go under `enriched` to mirror the existing
  // frontend shape so `dataService.ts` doesn't need restructuring.
  const enriched: WireDataset['enriched'] = {}
  if (row.abstract) enriched.description = row.abstract
  if (decoration.categories.length) enriched.categories = groupCategories(decoration.categories)
  if (decoration.keywords.length) enriched.keywords = decoration.keywords
  if (decoration.related.length) {
    enriched.relatedDatasets = decoration.related.map(r => ({
      title: r.related_title,
      url: r.related_url,
    }))
  }
  for (const dev of decoration.developers) {
    const target = dev.role === 'data' ? 'datasetDeveloper' : 'visDeveloper'
    enriched[target] = {
      name: dev.name,
      affiliationUrl: dev.affiliation_url ?? undefined,
    }
  }
  if (Object.keys(enriched).length) wire.enriched = enriched

  return wire
}

/**
 * Latest `updated_at` across a row set. Used as the cursor stamp
 * so subscribers can pass it back as `?since=...` next time. Empty
 * input returns `null` to signal "no rows seen yet"; callers omit
 * the cursor in that case.
 */
export function maxUpdatedAt(rows: DatasetRow[]): string | null {
  let max: string | null = null
  for (const r of rows) {
    if (max === null || r.updated_at > max) max = r.updated_at
  }
  return max
}
