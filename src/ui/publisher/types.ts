/**
 * Wire types for portal-bound publisher API responses.
 *
 * Mirrors a subset of the server-side `DatasetRow` and related
 * shapes the portal actually reads — kept here rather than imported
 * from `functions/api/v1/_lib/catalog-store.ts` so the portal
 * doesn't pull server-side types (and their transitive
 * dependencies) into the lazy chunk. The subset is intentionally
 * narrow; we expand it as later sub-phases consume more fields.
 *
 * Fields are documented to match the server-side definitions. A
 * structural drift between portal and server is caught at runtime
 * (the portal renders missing fields as empty / undefined gracefully)
 * rather than at build time, which matches how the rest of the
 * SPA's wire types work.
 */

/** Lifecycle status derived from published_at / retracted_at. */
export type DatasetLifecycle = 'draft' | 'published' | 'retracted'

/**
 * Subset of `DatasetRow` the portal list / detail surfaces
 * consume. The server returns the full row; we cast through this
 * interface to make portal call sites declare which fields they
 * read.
 *
 * The list-view subset is intentionally narrower than the
 * detail-view subset (`PublisherDatasetDetail` below) — the
 * list endpoint serializes every column, but the list page only
 * reads the few it renders.
 */
export interface PublisherDataset {
  id: string
  slug: string
  title: string
  abstract: string | null
  organization: string | null
  format: string
  visibility: string
  created_at: string
  updated_at: string
  published_at: string | null
  retracted_at: string | null
  publisher_id: string | null
  legacy_id: string | null
  /** The row's `thumbnail_ref` resolved to a publicly-readable URL,
   *  for a thumbnail cell in the list table. Null/absent when there's
   *  no thumbnail or it can't be resolved (no R2 public base bound). */
  thumbnail_url?: string | null
}

/**
 * Full dataset shape the detail page reads. Extends the list-view
 * subset with the auxiliary refs (thumbnail / legend / caption),
 * licensing, attribution, and time-range fields the detail card
 * surfaces.
 */
export interface PublisherDatasetDetail extends PublisherDataset {
  data_ref: string
  thumbnail_ref: string | null
  legend_ref: string | null
  caption_ref: string | null
  // Render hints (Phase 3d typed metadata) — used by the globe-
  // thumbnail generator to render the dataset the way the live globe
  // does (regional data clips to its bbox, flipped data isn't
  // upside-down, dateline-centered data is oriented right). Optional
  // so older payloads / fixtures without them still type-check;
  // `overlayFromRow` treats absent the same as null.
  bbox_n?: number | null
  bbox_s?: number | null
  bbox_w?: number | null
  bbox_e?: number | null
  lon_origin?: number | null
  is_flipped_in_y?: number | null
  celestial_body?: string | null
  website_link: string | null
  start_time: string | null
  end_time: string | null
  period: string | null
  run_tour_on_load: string | null
  license_spdx: string | null
  license_url: string | null
  license_statement: string | null
  attribution_text: string | null
  rights_holder: string | null
  doi: string | null
  citation_text: string | null
  /** 1 while a video transcode is in flight (Phase 3pd); NULL/0
   *  otherwise. The detail page polls every 5 s while this is
   *  set and stops once it clears. */
  transcoding?: number | null
  /** ULID of the asset_uploads row whose GHA workflow currently
   *  owns the row's transcoding stamp. Used server-side to
   *  reject overlapping dispatches and to verify /transcode-
   *  complete callbacks; the UI doesn't render it but receives
   *  it so debugging from devtools is straightforward.
   *  Migration 0012. */
  active_transcode_upload_id?: string | null
}

export interface ListDatasetsResponse {
  datasets: PublisherDataset[]
  next_cursor: string | null
}

export interface DatasetDetailResponse {
  dataset: PublisherDatasetDetail
  /** The dataset's raw `data_ref` resolved to a publicly-readable
   *  URL (an `r2:` ref → its public origin, a bare URL → itself).
   *  Null when it can't be resolved (no R2 public base bound). The
   *  edit form uses it to offer the globe-thumbnail generator's
   *  "Generate from this dataset's data" one-click path for already-
   *  uploaded image datasets. */
  data_url?: string | null
  /** The dataset's `thumbnail_ref` / `legend_ref` resolved to
   *  publicly-readable URLs, so the edit form can render an actual
   *  image preview of each (not just the `r2:` ref text). Null/absent
   *  when unset or unresolvable. */
  thumbnail_url?: string | null
  legend_url?: string | null
  /** Decoration arrays sit alongside the row rather than inline
   *  because the server stores them in separate join tables; the
   *  edit form prefills its chip inputs from these. */
  keywords: string[]
  tags: string[]
}

/**
 * Compute the lifecycle status from the timestamp pair the server
 * returns. The server applies the same logic when interpreting
 * `?status=` filters; this client-side derivation lets the portal
 * tag a row with its current lifecycle without an extra API call.
 */
export function lifecycleOf(d: PublisherDataset): DatasetLifecycle {
  if (d.retracted_at) return 'retracted'
  if (d.published_at) return 'published'
  return 'draft'
}

/** Account status on the publishers table. */
export type PublisherStatus = 'pending' | 'active' | 'suspended'

/**
 * Subset of the server-side `publishers` row the admin Users tab
 * reads. The PATCH endpoint accepts `role ∈ admin|publisher|readonly`
 * (service is reserved for machine tokens and not hand-assignable).
 */
export interface PublisherSummary {
  id: string
  email: string
  display_name: string
  affiliation: string | null
  role: string
  is_admin: number
  status: PublisherStatus
  created_at: string
}

export interface ListPublishersResponse {
  publishers: PublisherSummary[]
  next_cursor: string | null
}

/** PATCH body for `/api/v1/publish/publishers/{id}`. */
export interface UpdatePublisherPayload {
  role?: string
  // Only active|suspended are PATCH-able — `pending` is the
  // provisioning default and is rejected by the route.
  status?: 'active' | 'suspended'
  display_name?: string
  affiliation?: string | null
}
