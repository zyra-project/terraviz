/**
 * Pure row-mapping helpers for the SOS catalog snapshot importer.
 *
 * Reads a parsed SOS dataset list (the shape of
 * `public/assets/sos-dataset-list.json`) plus the enriched metadata
 * file (`public/assets/sos_dataset_metadata.json`), merges them the
 * way `src/services/dataService.ts` does today, and emits a list of
 * outcomes — one per SOS row — that's either a publisher-API draft
 * body ready to POST, or a skip with a reason.
 *
 * NO file I/O, NO network. The caller (the `terraviz import-snapshot`
 * CLI subcommand wired up in Commit 1d/B) reads the JSON files off
 * disk, runs `mapSnapshot`, then drives the publisher API via the
 * existing `TerravizClient`.
 *
 * Idempotency (Decision 2 in the 1d brief): the SOS internal id —
 * e.g. `INTERNAL_SOS_768` — becomes the dataset row's `legacy_id`.
 * Commit 1d/B adds the column + a lookup so re-runs are no-ops on
 * rows already imported. Slugs are NOT used as the idempotency key
 * because publisher drafts may collide with SOS-derived slugs.
 *
 * Field mapping (matches `DatasetDraftBody` in
 * `functions/api/v1/_lib/validators.ts`):
 *   - title            ← SOS `title`
 *   - format           ← validator-allowed mime (see `mapFormat`)
 *   - data_ref         ← `vimeo:<id>` or `url:<href>`
 *   - abstract         ← enriched.description ?? SOS abstractTxt
 *   - organization     ← SOS organization
 *   - website_link     ← SOS websiteLink
 *   - thumbnail_ref    ← SOS thumbnailLink
 *   - legend_ref       ← SOS legendLink
 *   - caption_ref      ← SOS closedCaptionLink
 *   - start_time/end_time ← SOS, normalised to ISO-Z
 *   - period, weight, run_tour_on_load ← SOS, pass-through
 *   - is_hidden        ← SOS `isHidden` (preserves SOS curation flag)
 *   - visibility       ← `'public'` (these are public catalog entries)
 *   - license_statement ← conservative default (operator can override)
 *   - categories/keywords/tags ← merged + clipped to validator caps
 *
 * Slug is intentionally left unset; the publisher API derives one
 * via `deriveSlug(title)` and resolves collisions in
 * `dataset-mutations.ts`. We don't second-guess that.
 */

import { validateDraftCreate, type DatasetDraftBody } from '../../functions/api/v1/_lib/validators'

// --- Source-shape mirrors -----------------------------------------

/** A single row in `public/assets/sos-dataset-list.json`. */
export interface RawSosEntry {
  id: string
  localizationID?: string
  organization?: string
  title: string
  abstractTxt?: string
  startTime?: string
  endTime?: string
  period?: string
  dataLink: string
  format: string
  websiteLink?: string
  legendLink?: string
  thumbnailLink?: string
  closedCaptionLink?: string
  tags?: string[]
  weight?: number
  isHidden?: boolean
  runTourOnLoad?: string
}

/** A single row in `public/assets/sos_dataset_metadata.json`. */
export interface RawEnrichedEntry {
  url?: string
  title?: string
  description?: string
  categories?: Record<string, string[]>
  keywords?: string[]
  date_added?: string
}

// --- Outcome shape ------------------------------------------------

export type SkipReason =
  | 'missing_title'
  | 'missing_data_link'
  | 'unsupported_format'
  | 'duplicate_id'
  | 'invalid_after_mapping'

export interface MappedDraft {
  /** Idempotency key — the SOS `id` (e.g. `INTERNAL_SOS_768`). */
  legacyId: string
  /** Body for `POST /api/v1/publish/datasets`. */
  draft: DatasetDraftBody
}

export interface SkippedRow {
  /** SOS `id` if present; falls back to a synthetic placeholder. */
  legacyId: string
  reason: SkipReason
  /** Human-readable detail — for `--dry-run` and importer logs. */
  details?: string
}

export type ImportOutcome =
  | { kind: 'ok'; row: MappedDraft }
  | { kind: 'skipped'; row: SkippedRow }

export interface ImportPlan {
  outcomes: ImportOutcome[]
  counts: {
    ok: number
    skipped: Record<SkipReason, number>
  }
}

// --- Validator-driven caps ----------------------------------------
//
// These mirror `validators.ts` exactly. Kept inline so a contributor
// reading the mapper doesn't have to context-switch.

const TITLE_MAX = 200
const ABSTRACT_MAX = 8000
const ORGANIZATION_MAX = 100
const KEYWORDS_MAX_ITEMS = 20
const KEYWORDS_PER_ITEM_MAX = 40
const TAGS_MAX_ITEMS = 20
const TAGS_PER_ITEM_MAX = 40
const CATEGORIES_TOTAL_MAX = 6
const CATEGORY_VALUE_MAX = 80

/**
 * Default license statement for SOS-imported rows. The SOS catalog
 * mixes NOAA / NASA / partner content; this statement defers to
 * each dataset's originating organisation rather than overclaiming
 * a single SPDX id. `validateForPublish` requires either
 * `license_spdx` OR `license_statement`; the statement form keeps
 * the import honest.
 */
const DEFAULT_LICENSE_STATEMENT =
  'Licensed under the originating organisation\'s terms. ' +
  'Imported from the NOAA Science On a Sphere (SOS) catalog; ' +
  'see the linked website for attribution and redistribution rules.'

// --- Helpers ------------------------------------------------------

/** Mirror of `dataService.normalizeTitle` — used for enriched-row matching. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\(movie\)\s*/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Build the title→enriched lookup index. Last-write-wins on duplicate titles. */
export function buildEnrichedIndex(entries: RawEnrichedEntry[]): Map<string, RawEnrichedEntry> {
  const map = new Map<string, RawEnrichedEntry>()
  for (const e of entries) {
    if (!e.title) continue
    map.set(normalizeTitle(e.title), e)
  }
  return map
}

/**
 * Map a SOS `dataLink` to a `data_ref` scheme. Phase 1b's manifest
 * endpoint already resolves both forms — `vimeo:<id>` via the Vimeo
 * proxy and `url:<href>` via the single-file synthesis path.
 */
export function mapDataRef(dataLink: string): string {
  const m = dataLink.match(/vimeo\.com\/(\d+)/i)
  if (m) return `vimeo:${m[1]}`
  return `url:${dataLink}`
}

/**
 * Map the raw SOS `format` field onto the validator's allow-list.
 * Returns `null` for formats this pipeline can't render — the
 * caller skips with `unsupported_format`. The mapper is intentionally
 * strict: if a row's labelled format is unknown we surface it in the
 * dry-run rather than guessing from the data_link extension.
 */
export function mapFormat(rawFormat: string): string | null {
  const f = rawFormat.toLowerCase().trim()
  if (f === 'video/mp4') return 'video/mp4'
  if (f === 'image/png') return 'image/png'
  if (f === 'image/jpeg') return 'image/jpeg'
  if (f === 'image/jpg' || f === 'images/jpg') return 'image/jpeg'
  if (f === 'image/webp') return 'image/webp'
  if (f === 'tour/json') return 'tour/json'
  return null
}

/**
 * Coerce SOS-style `2024-06-01T12:00:00` (no zone) into ISO-Z.
 * Returns undefined for empty strings — the validator treats them
 * as absent rather than malformed.
 */
function toIsoZ(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (/Z$/.test(value)) return value
  // Add seconds if absent, then 'Z'.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
    return `${value}Z`
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return `${value}:00Z`
  }
  return undefined
}

/** Trim + size-clip; returns undefined if the result would be empty or non-string. */
function clipString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** Clip an array of strings to (maxItems, perItemMax); drops empties. */
function clipStringArray(
  values: string[] | undefined,
  maxItems: number,
  perItemMax: number,
): string[] | undefined {
  if (!values || values.length === 0) return undefined
  const out: string[] = []
  for (const v of values) {
    if (typeof v !== 'string') continue
    const trimmed = v.trim()
    if (!trimmed) continue
    out.push(trimmed.length > perItemMax ? trimmed.slice(0, perItemMax) : trimmed)
    if (out.length >= maxItems) break
  }
  return out.length ? out : undefined
}

/**
 * Clip a categories object to the validator's 6-total cap and the
 * 80-char value cap. Preserves facet ordering (object keys are
 * iteration-stable in JS) so the truncation is deterministic.
 */
function clipCategories(
  raw: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!raw) return undefined
  const out: Record<string, string[]> = {}
  let total = 0
  for (const [facet, values] of Object.entries(raw)) {
    if (!Array.isArray(values)) continue
    const kept: string[] = []
    for (const v of values) {
      if (typeof v !== 'string') continue
      const trimmed = v.trim()
      if (!trimmed) continue
      const clipped =
        trimmed.length > CATEGORY_VALUE_MAX ? trimmed.slice(0, CATEGORY_VALUE_MAX) : trimmed
      kept.push(clipped)
      total++
      if (total >= CATEGORIES_TOTAL_MAX) break
    }
    if (kept.length) out[facet] = kept
    if (total >= CATEGORIES_TOTAL_MAX) break
  }
  return Object.keys(out).length ? out : undefined
}

// --- Per-row mapper -----------------------------------------------

/**
 * Map a single SOS entry to a publisher-API draft body.
 *
 * Returns `{ kind: 'ok' }` for a row that passes
 * `validateDraftCreate`, or `{ kind: 'skipped' }` with the failure
 * reason. The mapper also runs the validator on its own output as
 * a belt-and-braces check — any rule that drifts (e.g. a future
 * stricter title regex) trips the `invalid_after_mapping` skip
 * path rather than producing a draft the API will reject.
 */
export function mapSnapshotEntry(
  sos: RawSosEntry,
  enriched: RawEnrichedEntry | undefined,
): ImportOutcome {
  const legacyId = sos.id || `UNKNOWN_${normalizeTitle(sos.title || '').slice(0, 32)}`

  if (!sos.title || !sos.title.trim()) {
    return { kind: 'skipped', row: { legacyId, reason: 'missing_title' } }
  }
  if (!sos.dataLink || !sos.dataLink.trim()) {
    return { kind: 'skipped', row: { legacyId, reason: 'missing_data_link' } }
  }
  const format = mapFormat(sos.format)
  if (!format) {
    return {
      kind: 'skipped',
      row: { legacyId, reason: 'unsupported_format', details: sos.format },
    }
  }

  const draft: DatasetDraftBody = {
    title: clipString(sos.title, TITLE_MAX),
    format,
    data_ref: mapDataRef(sos.dataLink),
    visibility: 'public',
    license_statement: DEFAULT_LICENSE_STATEMENT,
  }

  const abstract = clipString(enriched?.description, ABSTRACT_MAX) ?? clipString(sos.abstractTxt, ABSTRACT_MAX)
  if (abstract) draft.abstract = abstract

  const organization = clipString(sos.organization, ORGANIZATION_MAX)
  if (organization) draft.organization = organization

  const websiteLink = clipString(sos.websiteLink, 1024)
  if (websiteLink) draft.website_link = websiteLink

  const thumbnail = clipString(sos.thumbnailLink, 1024)
  if (thumbnail) draft.thumbnail_ref = thumbnail

  const legend = clipString(sos.legendLink, 1024)
  if (legend) draft.legend_ref = legend

  const caption = clipString(sos.closedCaptionLink, 1024)
  if (caption) draft.caption_ref = caption

  const start = toIsoZ(sos.startTime)
  if (start) draft.start_time = start
  const end = toIsoZ(sos.endTime)
  if (end) draft.end_time = end

  const period = clipString(sos.period, 100)
  if (period) draft.period = period

  if (typeof sos.weight === 'number') draft.weight = sos.weight
  if (typeof sos.isHidden === 'boolean') draft.is_hidden = sos.isHidden

  const runTour = clipString(sos.runTourOnLoad, 1024)
  if (runTour) draft.run_tour_on_load = runTour

  const categories = clipCategories(enriched?.categories)
  if (categories) draft.categories = categories

  const keywords = clipStringArray(enriched?.keywords, KEYWORDS_MAX_ITEMS, KEYWORDS_PER_ITEM_MAX)
  if (keywords) draft.keywords = keywords

  const tags = clipStringArray(sos.tags, TAGS_MAX_ITEMS, TAGS_PER_ITEM_MAX)
  if (tags) draft.tags = tags

  const validationErrors = validateDraftCreate(draft)
  if (validationErrors.length > 0) {
    return {
      kind: 'skipped',
      row: {
        legacyId,
        reason: 'invalid_after_mapping',
        details: validationErrors
          .map(e => `${e.field}: ${e.code}`)
          .join('; '),
      },
    }
  }

  return { kind: 'ok', row: { legacyId, draft } }
}

// --- Whole-snapshot mapper ----------------------------------------

/**
 * Map a parsed SOS snapshot to an import plan. De-duplicates by
 * SOS `id` (the upstream catalog has at least one repeated id —
 * see `seed-catalog.ts:170` — and first-wins keeps re-runs stable).
 */
export function mapSnapshot(
  sosList: RawSosEntry[],
  enrichedList: RawEnrichedEntry[],
): ImportPlan {
  const enrichedIndex = buildEnrichedIndex(enrichedList)
  const seen = new Set<string>()
  const outcomes: ImportOutcome[] = []
  const counts: ImportPlan['counts'] = {
    ok: 0,
    skipped: {
      missing_title: 0,
      missing_data_link: 0,
      unsupported_format: 0,
      duplicate_id: 0,
      invalid_after_mapping: 0,
    },
  }

  for (const sos of sosList) {
    if (sos.id) {
      if (seen.has(sos.id)) {
        outcomes.push({
          kind: 'skipped',
          row: { legacyId: sos.id, reason: 'duplicate_id' },
        })
        counts.skipped.duplicate_id++
        continue
      }
      seen.add(sos.id)
    }

    const enriched = sos.title ? enrichedIndex.get(normalizeTitle(sos.title)) : undefined
    const outcome = mapSnapshotEntry(sos, enriched)
    outcomes.push(outcome)
    if (outcome.kind === 'ok') counts.ok++
    else counts.skipped[outcome.row.reason]++
  }

  return { outcomes, counts }
}
