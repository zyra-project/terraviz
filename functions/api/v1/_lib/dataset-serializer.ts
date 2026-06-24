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
  /** Color-ramp image used by interactive probing — populated
   * verbatim from the catalog's `color_table_ref`. Distinct from
   * `legendLink` in ~2 of 14 overlap cases. Optional; omitted when
   * the row carries no value. */
  colorTableLink?: string
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
  /** Probing metadata recovered from the SOS snapshot — pixel
   * coords on the color table image mapped to data values. Wire
   * type is the parsed JSON object (not the raw string D1 stores).
   * Phase 3b. */
  probingInfo?: unknown
  /** Geographic bounding box (NSWE in degrees) for the dataset's
   * spatial extent. Phase 3d promoted from the legacy
   * `bounding_variables` JSON column to typed columns. Omitted
   * when any `bbox_*` column is NULL (a partial bbox can't drive
   * the SPA's regional projection — better to drop than to emit
   * half a box). Note: a row with all four corners populated to
   * `{n:90, s:-90, w:-180, e:180}` is still emitted — the
   * presence of `boundingBox` doesn't encode "regional vs
   * global"; the SPA can short-circuit at render time if it
   * sees a worldwide box. */
  boundingBox?: { n: number; s: number; w: number; e: number }
  /** Celestial body the dataset visualises. Omitted (== Earth)
   * for the common case. Non-Earth values cue the SPA's Phase 3e
   * base-texture swap. */
  celestialBody?: string
  /** Radius of the celestial body in miles, when non-Earth.
   * Paired with `celestialBody`. */
  radiusMi?: number
  /** Globe longitude rotation reference in degrees (0 = prime
   * meridian centered). Omitted when 0 (the default). */
  lonOrigin?: number
  /** Image Y-axis flip flag. Omitted when false. */
  isFlippedInY?: boolean
  /**
   * For `tour/json` rows: the resolved URL the SPA's tour engine
   * fetches the tour document from, bypassing the manifest endpoint
   * indirection (which only handles `video|image` manifests).
   * Surfaced from the row's `data_ref` so the post-1d node-catalog
   * source matches the pre-cutover legacy SOS path: a tour dataset
   * carries a fetchable JSON URL, the engine fetches and runs it.
   * Older clients that don't read this field fall back to
   * `dataLink` and 415 — the new shape is additive and opt-in.
   */
  tourJsonUrl?: string
  /**
   * Image-sequence frame surface — populated only when the row was
   * transcoded from an image-sequence upload (Phase 3pg/A). The
   * envelope is the minimum any consumer needs to enumerate or
   * address individual frames:
   *
   *   - `count` is the post-transcode frame count.
   *   - `urlTemplate` is the public per-frame URL with a literal
   *     `{index}` token consumers substitute with the zero-padded
   *     5-digit frame number. The extension is baked into the
   *     template so the consumer doesn't need a separate field.
   *   - `framesDigest` (optional) is the SHA-256 of the canonical
   *     source-filenames blob — the same hash the publisher signed
   *     off on during ingest. A consumer that wants a cache-
   *     invalidation signal can compare templates instead; the
   *     per-upload prefix in `urlTemplate` changes on every re-
   *     upload, so the two carry the same "is this the same source
   *     set" answer.
   *
   * Time origin and step live on the parent `WireDataset`
   * (`startTime` + `period`); consumers compute frame N's
   * timestamp as `startTime + period × index`. Display naming
   * (`{slug}_{timestamp}.{ext}` for time-series, `{slug}_frame_{NNNNN}.{ext}`
   * for pure-sequence rows) is server-rendered by the `/frames`
   * endpoint Phase 3pg/B ships — clients that want it can apply
   * the same rule locally without an extra round-trip.
   */
  frames?: WireDatasetFrames
}

/**
 * Image-sequence frame envelope on `WireDataset` (Phase 3pg/A).
 * See the field comment on `WireDataset.frames` for the rationale
 * behind each member.
 */
export interface WireDatasetFrames {
  count: number
  urlTemplate: string
  framesDigest?: string
}

/**
 * Pluggable callback that turns a row's `data_ref` (e.g.
 * `url:https://...`, `r2:tours/foo.json`) into a publicly-readable
 * URL. Lives outside the serializer so the serializer doesn't have
 * to import the env or the R2 helper directly; call sites pass a
 * resolver that closes over the bindings they have on hand. Returns
 * null when the scheme isn't a directly-fetchable file (e.g.
 * `vimeo:`, `stream:`, `peer:`) — those formats don't go through
 * the tour-engine fetch path anyway.
 */
export type DataRefResolver = (dataRef: string) => string | null

/**
 * Resolves an `r2:<key>` auxiliary-asset reference (the post-3b
 * shape on `thumbnail_ref` / `legend_ref` / `caption_ref` /
 * `color_table_ref` columns) to a publicly-readable URL. Bare
 * `https://` values pass through unchanged so pre-migration
 * rows on NOAA CloudFront still serialize correctly.
 *
 * The callback shape lets the serializer stay env-agnostic — the
 * route handler binds it once via `resolveAssetRef` from
 * `r2-public-url.ts`. When omitted, the serializer falls back
 * to verbatim passthrough (useful in tests that don't care
 * about R2 resolution); production routes must always pass one
 * or the SPA receives unrenderable `r2:` strings.
 */
export type AssetRefResolver = (ref: string | null | undefined) => string | null

/**
 * Pluggable callback that returns the dataset-level per-frame URL
 * template for an image-sequence upload. Takes the row's `datasetId`
 * and the node `baseUrl`, and returns a URL with a literal `{index}`
 * token consumers substitute with the zero-padded 5-digit frame
 * number.
 *
 * Since frames are content-addressed, no single direct-R2 `{index}`
 * template can exist (each index maps to an arbitrary hash), so the
 * template points at the `/frames/{index}` **redirect** endpoint —
 * `${baseUrl}/api/v1/datasets/{datasetId}/frames/{index}` — which 302s
 * to the content-addressed object (see `buildFramesRedirectTemplate`).
 * The `/frames` *list* endpoint emits direct content-addressed URLs
 * separately, so bulk download skips the hop.
 *
 * Lives outside the serializer for the same reason `DataRefResolver`
 * does — keeps the serializer free of env bindings; call sites close
 * over what they have on hand. Returns null when R2 public-base
 * resolution falls through (frames not advertised), mirroring
 * `AssetRefResolver`'s shape.
 */
export type FramesUrlTemplateResolver = (
  datasetId: string,
  baseUrl: string,
) => string | null

function nonNull<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v
}

/** Like `nonNull` but also drops empty / whitespace-only strings.
 * Used by Phase 3d's `celestial_body` so a legacy row with
 * `celestial_body = ''` doesn't surface as `celestialBody: ""`
 * on the wire — preserves the "omitted == Earth" convention. */
function nonBlank(v: string | null | undefined): string | undefined {
  if (v == null) return undefined
  const trimmed = v.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Apply an optional asset-ref resolver, falling back to
 * verbatim passthrough when none is provided. */
function resolveAsset(
  ref: string | null | undefined,
  resolver: AssetRefResolver | undefined,
): string | undefined {
  if (!ref) return undefined
  if (!resolver) return ref
  return nonNull(resolver(ref))
}

/**
 * Parse a JSON-stringified text column into its object form for
 * the wire. Empty / null / unparseable values become `undefined`
 * so the field is omitted from the serialized row. Used for
 * Phase 3b's `probing_info` — validated on write, so a parse
 * failure here only happens if the row was edited out-of-band.
 */
function parseJsonField(v: string | null | undefined): unknown {
  if (v == null || v.length === 0) return undefined
  try {
    return JSON.parse(v) as unknown
  } catch {
    return undefined
  }
}

/**
 * Assemble the wire-side `boundingBox` field from the four
 * `bbox_*` columns, or return undefined if any corner is missing.
 * A partial bbox can't drive the SPA's Phase 3e regional
 * projection — better to omit than to send half a box.
 */
function assembleBoundingBox(
  row: DatasetRow,
): { n: number; s: number; w: number; e: number } | undefined {
  const { bbox_n, bbox_s, bbox_w, bbox_e } = row
  if (bbox_n == null || bbox_s == null || bbox_w == null || bbox_e == null) {
    return undefined
  }
  return { n: bbox_n, s: bbox_s, w: bbox_w, e: bbox_e }
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
  resolveDataRef?: DataRefResolver,
  resolveAssetRef?: AssetRefResolver,
  resolveFramesUrlTemplate?: FramesUrlTemplateResolver,
): WireDataset {
  // Auxiliary asset URLs may be either:
  //   - bare https:// (pre-Phase-3b: NOAA CloudFront), or
  //   - `r2:<key>` (post-Phase-3b migration: R2-hosted under
  //     datasets/<id>/<asset>.<ext> — and post-Phase-3c, also
  //     `r2:tours/<id>/tour.json` for migrated tour files).
  // The SPA renders these as <img src=...> / <track src=...>
  // and fetches `runTourOnLoad` as JSON; neither can resolve a
  // `r2:` scheme. The resolver flips r2: to a publicly-readable
  // URL via R2_PUBLIC_BASE. Bare URLs pass through unchanged.
  // See r2-public-url.ts:resolveAssetRef.
  const wire: WireDataset = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    format: row.format,
    dataLink: manifestLink(identity.base_url, row.id),
    organization: nonNull(row.organization),
    abstractTxt: nonNull(row.abstract),
    thumbnailLink: resolveAsset(row.thumbnail_ref, resolveAssetRef),
    legendLink: resolveAsset(row.legend_ref, resolveAssetRef),
    closedCaptionLink: resolveAsset(row.caption_ref, resolveAssetRef),
    colorTableLink: resolveAsset(row.color_table_ref, resolveAssetRef),
    websiteLink: nonNull(row.website_link),
    startTime: nonNull(row.start_time),
    endTime: nonNull(row.end_time),
    period: nonNull(row.period),
    weight: row.weight,
    isHidden: row.is_hidden === 1 ? true : undefined,
    runTourOnLoad: resolveAsset(row.run_tour_on_load, resolveAssetRef),
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
    // `probing_info` is JSON-stringified text in D1. Parsing here
    // keeps the wire-side shape friendly for consumers; a malformed
    // string is dropped silently (returned as undefined) rather
    // than 500-ing the read endpoint. Phase 3b's write-side
    // validator (validateJsonStringField) only checks JSON
    // parseability + the 4096-char cap — NOT the object's
    // field-level shape.
    probingInfo: parseJsonField(row.probing_info),
    // Phase 3d typed metadata. boundingBox surfaces only when all
    // four corners are non-null (a partial bbox is meaningless to
    // any consumer). celestialBody / radiusMi / lonOrigin /
    // isFlippedInY surface only when populated — empty / default
    // values are dropped so the wire stays terse for the common
    // (Earth, global, prime-meridian, no-flip) case.
    boundingBox: assembleBoundingBox(row),
    // celestial_body: empty / whitespace-only strings collapse
    // to undefined alongside true NULLs, so a legacy row that
    // sneaked through with `celestial_body = ''` doesn't surface
    // as `celestialBody: ""` (which would conflict with the
    // "omitted == Earth" convention the SPA expects).
    celestialBody: nonBlank(row.celestial_body),
    radiusMi: row.radius_mi != null ? row.radius_mi : undefined,
    lonOrigin: row.lon_origin != null ? row.lon_origin : undefined,
    isFlippedInY: row.is_flipped_in_y === 1 ? true : undefined,
  }

  // Tour rows carry a fetchable JSON URL alongside the manifest
  // URL, since the manifest endpoint refuses tour formats. The
  // resolver is optional — a caller that doesn't pass one (e.g.
  // a unit test) just gets a wire row without `tourJsonUrl`,
  // which falls back to `dataLink` (and 415s) the same way old
  // clients do.
  if (row.format === 'tour/json' && resolveDataRef) {
    const tourUrl = resolveDataRef(row.data_ref)
    if (tourUrl) wire.tourJsonUrl = tourUrl
  }

  // Image-sequence frame envelope. Phase 3pg/A — populated only
  // when:
  //   - `frame_count` is non-null (transcode landed, so the frame
  //     surface is consistent with the active `data_ref`);
  //   - `frame_extension` and `frame_source_filenames_ref` are
  //     also populated (clearTranscoding swaps them atomically with
  //     `data_ref` — any drift would indicate a hand-edited row);
  //   - the resolver is supplied AND returns a non-null template
  //     (no `R2_PUBLIC_BASE` binding → no frames surface yet, same
  //     fail-quiet shape `resolveAssetRefStrict` uses for the
  //     thumbnail / legend fields).
  //
  // The `source_digest` column carries the SHA-256 of the
  // canonical source-filenames blob for frames uploads (the
  // publisher-signed hash that the runner verifies during
  // download). Surfacing it as `framesDigest` lets consumers
  // cache the enumeration and notice re-uploads — though the
  // template-comparison shortcut is usually enough since the
  // per-upload prefix in `urlTemplate` also changes on every
  // re-upload.
  if (
    row.frame_count != null &&
    row.frame_extension != null &&
    row.frame_source_filenames_ref != null &&
    resolveFramesUrlTemplate
  ) {
    const urlTemplate = resolveFramesUrlTemplate(row.id, identity.base_url)
    if (urlTemplate) {
      const frames: WireDatasetFrames = {
        count: row.frame_count,
        urlTemplate,
      }
      if (row.source_digest) frames.framesDigest = row.source_digest
      wire.frames = frames
    }
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
