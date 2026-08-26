// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Field-level validators for the publisher-API write paths.
 *
 * Mirrors the table in `CATALOG_PUBLISHING_TOOLS.md` "Validation
 * rules". Inline rather than `ajv` because the rule set is small,
 * bounded, and benefits from being read alongside the doc — the
 * single source of truth is the table the doc maintains, and a
 * 200-line file that mirrors it row-for-row is easier to audit than
 * a JSON schema indirection.
 *
 * Two validation tiers correspond to the doc's "Required-vs-
 * recommended split":
 *   - `validateDraftCreate` / `validateDraftUpdate` accept a partial
 *     body — only title and format are required to persist a draft.
 *   - `validateForPublish` is the stricter check the publish handler
 *     runs before stamping `published_at`. Adds slug, data_ref,
 *     visibility, license; matches Phase-3's full required set.
 *
 * Returns are an array of `ValidationError` objects — empty array
 * means "ok, write it". The publisher API surfaces errors as
 * `{ errors: [{ field, code, message }] }` per the doc.
 */

import {
  COLOR_SCALE_MAX_CHARS,
  parseColorScale,
  RENDER_ENCODING_DATA_LUMA,
} from '../../../../src/types/color-scale'

const RESERVED_SLUGS = new Set([
  'api',
  'publish',
  'assets',
  'tours',
  'well-known',
  'admin',
])

const VISIBILITY_VALUES = new Set(['public', 'federated', 'restricted', 'private'])
const FORMAT_VALUES = new Set([
  'video/mp4',
  'image/png',
  'image/jpeg',
  'image/webp',
  'tour/json',
])

const SLUG_RE = /^[a-z][a-z0-9-]{2,63}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

export interface ValidationError {
  field: string
  code: string
  message: string
}

export interface DatasetDraftBody {
  title?: string
  slug?: string
  abstract?: string
  organization?: string
  format?: string
  data_ref?: string
  thumbnail_ref?: string
  legend_ref?: string
  caption_ref?: string
  /** Fourth auxiliary-asset URL: the color ramp used for
   * interactive probing. Same shape rules as the other `_ref`
   * fields (clipped to 1024 chars). Phase 3b restores this from
   * the SOS `colorTableLink` field. */
  color_table_ref?: string
  /** JSON-stringified probing metadata (pixel coords → data
   * value mapping). The validator accepts the *stringified* form
   * — callers JSON.stringify before sending. Bound on length so
   * a malformed blob can't bloat the column. */
  probing_info?: string
  /** Geographic bounding box (NSWE in degrees) for the dataset's
   * spatial extent. Phase 3d replaced the 3b `bounding_variables`
   * JSON string with this typed object. Validation: n/s in
   * [-90, 90], w/e in [-180, 180], n >= s. */
  bounding_box?: { n: number; s: number; w: number; e: number }
  /** Celestial body the dataset visualises. Free-form string
   * (Earth / Mars / Moon / Sun / …) bounded to 64 chars. NULL /
   * empty == Earth. */
  celestial_body?: string
  /** Radius of the celestial body in miles. Pair with
   * `celestial_body` for non-Earth datasets. Must be a positive
   * finite number. */
  radius_mi?: number
  /** Globe longitude rotation reference in degrees, [-180, 180]. */
  lon_origin?: number
  /** Image Y-axis flip flag for inverted-Y imagery. `null`
   * clears the column on UPDATE; omission leaves it untouched. */
  is_flipped_in_y?: boolean | null
  /** How the frames encode their pixels — `'data-luma'`, or `null`
   * to clear the column on UPDATE. Omission leaves it untouched,
   * and an absent value means the dataset is a picture. */
  render_encoding?: string | null
  /** JSON sidecar (palette + scale) for data-encoded datasets. */
  color_scale?: string | null
  /** Source frames per second for an image-sequence encode — each
   *  frame is held 1/playback_fps seconds. Null clears the column on
   *  UPDATE; absent leaves it untouched. Independent of the
   *  data-encoded pair above: a picture published as a frame
   *  sequence wants a readable speed too. */
  playback_fps?: number | null
  website_link?: string
  start_time?: string
  end_time?: string
  period?: string
  weight?: number
  visibility?: string
  is_hidden?: boolean
  run_tour_on_load?: string
  license_spdx?: string
  license_url?: string
  license_statement?: string
  attribution_text?: string
  rights_holder?: string
  doi?: string
  citation_text?: string
  categories?: Record<string, string[]>
  keywords?: string[]
  tags?: string[]
  /**
   * Idempotency key for bulk-imported rows. Phase 1d's
   * `terraviz import-snapshot` sets this from the SOS snapshot's
   * internal id (e.g. `INTERNAL_SOS_768`). NULL on rows the
   * publisher created by hand.
   */
  legacy_id?: string
}

export interface TourDraftBody {
  title?: string
  slug?: string
  description?: string
  tour_json_ref?: string
  thumbnail_ref?: string
  visibility?: string
}

function err(field: string, code: string, message: string): ValidationError {
  return { field, code, message }
}

function hasControlChars(s: string): boolean {
  // Disallow C0 controls except CR (\x0D), LF (\x0A), and HT
  // (\x09), plus DEL (\x7F). Written as explicit `\xHH` escapes
  // (rather than embedded raw control bytes) for two reasons:
  //   • CodeQL's "overly permissive regular expression range" rule
  //     can't always tell from raw bytes that a `\x00-\x08` span is
  //     intentional; spelling the bounds out hex-by-hex makes the
  //     classification obvious and silences alert #21.
  //   • A future editor that visualises the file with non-printables
  //     hidden won't accidentally widen the range.
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(s)
}

export function looksLikeUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Turn a title into a default slug. The publisher can override.
 *
 * The slug must satisfy `SLUG_RE` (`/^[a-z][a-z0-9-]{2,63}$/`) —
 * a lowercase-letter lead, 3-64 chars total. Titles that start
 * with a digit (e.g. "360 Media — National Marine Sanctuaries",
 * "120 Years of Earthquakes") would otherwise produce an invalid
 * digit-leading slug and trip `validateForPublish` at flip-to-
 * published time, even though `validateDraftCreate` accepted the
 * row. The Phase-1d SOS bulk import surfaced exactly this case;
 * the fix is to fall back to a `dataset-` prefix when the leading
 * character of the derived slug isn't a letter.
 */
export function deriveSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '')
  if (!base) return 'dataset'
  if (!/^[a-z]/.test(base)) {
    // Reserve room for the `dataset-` prefix within the 64-char cap.
    return `dataset-${base}`.slice(0, 64).replace(/-+$/, '')
  }
  return base
}

function validateTitle(title: unknown, errors: ValidationError[]): void {
  if (typeof title !== 'string') {
    errors.push(err('title', 'required', 'Title is required.'))
    return
  }
  const trimmed = title.trim()
  if (trimmed.length < 3) {
    errors.push(err('title', 'too_short', 'Title must be at least 3 characters.'))
  } else if (trimmed.length > 200) {
    errors.push(err('title', 'too_long', 'Title must be at most 200 characters.'))
  }
  if (hasControlChars(trimmed)) {
    errors.push(err('title', 'invalid_characters', 'Title contains control characters.'))
  }
}

function validateSlug(slug: unknown, errors: ValidationError[], required: boolean): void {
  if (slug == null || slug === '') {
    if (required) errors.push(err('slug', 'required', 'Slug is required.'))
    return
  }
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    errors.push(
      err(
        'slug',
        'invalid_format',
        'Slug must match /^[a-z][a-z0-9-]{2,63}$/.',
      ),
    )
    return
  }
  if (RESERVED_SLUGS.has(slug)) {
    errors.push(err('slug', 'reserved', `Slug "${slug}" is reserved.`))
  }
}

function validateAbstract(abstract: unknown, errors: ValidationError[]): void {
  if (abstract == null) return
  if (typeof abstract !== 'string') {
    errors.push(err('abstract', 'invalid_type', 'Abstract must be a string.'))
    return
  }
  if (abstract.length > 8000) {
    errors.push(err('abstract', 'too_long', 'Abstract must be at most 8000 characters.'))
  }
  // Lightweight script-tag rejection. The portal's markdown
  // pipeline applies a stricter allow-list at render time; this
  // catches the obvious injection at the API edge.
  if (/<\s*script\b/i.test(abstract)) {
    errors.push(err('abstract', 'unsafe_html', 'Abstract may not contain raw script tags.'))
  }
}

function validateFormat(format: unknown, errors: ValidationError[], required: boolean): void {
  if (format == null) {
    if (required) errors.push(err('format', 'required', 'Format is required.'))
    return
  }
  if (typeof format !== 'string' || !FORMAT_VALUES.has(format)) {
    errors.push(
      err('format', 'invalid_value', `Format must be one of: ${[...FORMAT_VALUES].join(', ')}.`),
    )
  }
}

function validateVisibility(
  visibility: unknown,
  errors: ValidationError[],
  required: boolean,
): void {
  if (visibility == null) {
    if (required) errors.push(err('visibility', 'required', 'Visibility is required.'))
    return
  }
  if (typeof visibility !== 'string' || !VISIBILITY_VALUES.has(visibility)) {
    errors.push(
      err(
        'visibility',
        'invalid_value',
        `Visibility must be one of: ${[...VISIBILITY_VALUES].join(', ')}.`,
      ),
    )
  }
}

function validateOptionalString(
  field: string,
  value: unknown,
  maxLen: number,
  errors: ValidationError[],
): void {
  if (value == null) return
  if (typeof value !== 'string') {
    errors.push(err(field, 'invalid_type', `${field} must be a string.`))
    return
  }
  if (value.length > maxLen) {
    errors.push(err(field, 'too_long', `${field} must be at most ${maxLen} characters.`))
  }
}

/**
 * legacy_id has tighter rules than the generic optional-string set:
 * empty / whitespace-only values bypass the createDataset 409
 * pre-check (which truthy-checks `body.legacy_id`) and would later
 * fail as an opaque SQLite UNIQUE-constraint error on the second
 * row that lands as ''. Reject blanks at the validator edge so the
 * mutation layer never sees them.
 */
function validateLegacyId(value: unknown, errors: ValidationError[]): void {
  if (value == null) return
  if (typeof value !== 'string') {
    errors.push(err('legacy_id', 'invalid_type', 'legacy_id must be a string.'))
    return
  }
  if (value.trim().length === 0) {
    errors.push(
      err('legacy_id', 'too_short', 'legacy_id may not be empty or whitespace-only.'),
    )
    return
  }
  if (value.length > 100) {
    errors.push(err('legacy_id', 'too_long', 'legacy_id must be at most 100 characters.'))
  }
}

function validateUrlField(field: string, value: unknown, errors: ValidationError[]): void {
  if (value == null || value === '') return
  if (typeof value !== 'string' || !looksLikeUrl(value)) {
    errors.push(err(field, 'invalid_url', `${field} must be a well-formed http(s) URL.`))
  }
}

/**
 * Validate a JSON-stringified blob column. Used for Phase 3b's
 * `probing_info` — arrives as a plain string on the wire (caller
 * does the JSON.stringify) but must parse as well-formed JSON
 * before D1 accepts it, so the serializer's `JSON.parse` on read
 * never throws. Length-capped to keep a runaway blob from
 * bloating the row.
 */
function validateJsonStringField(
  field: string,
  value: unknown,
  maxLen: number,
  errors: ValidationError[],
): void {
  if (value == null || value === '') return
  if (typeof value !== 'string') {
    errors.push(err(field, 'invalid_type', `${field} must be a JSON-stringified string.`))
    return
  }
  if (value.length > maxLen) {
    errors.push(err(field, 'too_long', `${field} must be at most ${maxLen} characters.`))
    return
  }
  try {
    JSON.parse(value)
  } catch {
    errors.push(err(field, 'invalid_json', `${field} must be a JSON-stringified value.`))
  }
}

/**
 * Validate the typed `bounding_box: { n, s, w, e }` field. Phase 3d.
 *
 *   - Each corner must be a finite number.
 *   - Latitudes (n, s) in [-90, 90]; longitudes (w, e) in [-180, 180].
 *   - n must be >= s (a box where the "north" edge sits south of
 *     the "south" edge is malformed; the SPA's regional projection
 *     would silently flip it).
 *   - w may be > e (antimeridian-crossing boxes are valid — e.g.
 *     a Pacific box can have w=170, e=-170; the SPA wraps).
 *
 * Each violation produces a distinct `invalid_value` error
 * pinpointing the offending sub-field so the publisher API's
 * 400 response tells the caller exactly which corner is wrong.
 */
function validateBoundingBox(value: unknown, errors: ValidationError[]): void {
  if (value == null) return
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(err('bounding_box', 'invalid_type', 'bounding_box must be an object { n, s, w, e }.'))
    return
  }
  const v = value as Record<string, unknown>
  const corners: Array<['n' | 's' | 'w' | 'e', number, number]> = [
    ['n', -90, 90],
    ['s', -90, 90],
    ['w', -180, 180],
    ['e', -180, 180],
  ]
  const nums: Partial<Record<'n' | 's' | 'w' | 'e', number>> = {}
  for (const [key, min, max] of corners) {
    const raw = v[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      errors.push(
        err(`bounding_box.${key}`, 'invalid_type', `bounding_box.${key} must be a finite number.`),
      )
      continue
    }
    if (raw < min || raw > max) {
      errors.push(
        err(
          `bounding_box.${key}`,
          'invalid_value',
          `bounding_box.${key} must be in [${min}, ${max}] (got ${raw}).`,
        ),
      )
      continue
    }
    nums[key] = raw
  }
  if (nums.n !== undefined && nums.s !== undefined && nums.n < nums.s) {
    errors.push(
      err(
        'bounding_box',
        'invalid_value',
        `bounding_box.n must be >= bounding_box.s (got n=${nums.n}, s=${nums.s}).`,
      ),
    )
  }
}

/**
 * Validate `render_encoding` and its `color_scale` sidecar.
 *
 * Stricter than the neighbouring `probing_info` check, which only
 * asks for parseable JSON under a length cap. `probing_info` is
 * documentation of an SOS payload that nothing renders; `color_scale`
 * decides what colour every pixel of a published dataset is and what
 * number the globe reports under the cursor, so a malformed one has
 * to be refused at write time rather than discovered by a viewer.
 *
 * The pairing is enforced in both directions: `data-luma` without a
 * sidecar renders as raw grayscale, and a sidecar without `data-luma`
 * is silently ignored — both are almost certainly a publishing
 * mistake, so both are errors.
 */
function validateRenderEncoding(
  encoding: unknown,
  colorScale: unknown,
  errors: ValidationError[],
): void {
  const hasEncoding = encoding != null && encoding !== ''
  if (hasEncoding) {
    if (typeof encoding !== 'string') {
      errors.push(err('render_encoding', 'invalid_type', 'render_encoding must be a string.'))
      return
    }
    if (encoding !== RENDER_ENCODING_DATA_LUMA) {
      errors.push(
        err(
          'render_encoding',
          'invalid_value',
          `render_encoding must be '${RENDER_ENCODING_DATA_LUMA}' (got '${encoding}').`,
        ),
      )
      return
    }
  }

  const hasScale = colorScale != null && colorScale !== ''
  if (hasScale) {
    if (typeof colorScale !== 'string') {
      errors.push(
        err(
          'color_scale',
          'invalid_type',
          'color_scale must be a JSON-stringified object (palette stops + scale), sent as a string.',
        ),
      )
      return
    }
    if (colorScale.length > COLOR_SCALE_MAX_CHARS) {
      errors.push(
        err('color_scale', 'too_long', `color_scale must be at most ${COLOR_SCALE_MAX_CHARS} characters.`),
      )
      return
    }
    if (parseColorScale(colorScale) === null) {
      errors.push(
        err(
          'color_scale',
          'invalid_value',
          'color_scale must be a JSON object with >= 2 palette stops ' +
            '({ t, rgba }, in any order — they are sorted on parse) and ' +
            'finite, distinct vmin / vmax. An optional dataMinLuma must be ' +
            'an integer in 0..254, and must agree with transparentRange ' +
            'about where data starts when both are given.',
        ),
      )
      return
    }
  }

  if (hasEncoding && !hasScale) {
    errors.push(
      err(
        'color_scale',
        'invalid_value',
        `color_scale is required when render_encoding is '${RENDER_ENCODING_DATA_LUMA}' — ` +
          'without it the frames render as raw grayscale.',
      ),
    )
  }
  if (hasScale && !hasEncoding) {
    errors.push(
      err(
        'render_encoding',
        'invalid_value',
        `render_encoding must be '${RENDER_ENCODING_DATA_LUMA}' when color_scale is set; ` +
          'otherwise the sidecar is ignored.',
      ),
    )
  }
}

/**
 * Validate `lon_origin` (degrees, [-180, 180]). Phase 3d. */
function validateLonOrigin(value: unknown, errors: ValidationError[]): void {
  if (value == null) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(err('lon_origin', 'invalid_type', 'lon_origin must be a finite number.'))
    return
  }
  if (value < -180 || value > 180) {
    errors.push(
      err('lon_origin', 'invalid_value', `lon_origin must be in [-180, 180] (got ${value}).`),
    )
  }
}

/**
 * Validate `playback_fps` (source frames per second).
 *
 * Rejected rather than silently coerced. The transcode already falls
 * back to the catalog default for a non-positive value, but a publisher
 * who typed 0 would get a dataset that plays at 30 fps with the form
 * still showing 0 — an accepted write that did not take effect. A
 * structured 400 says so at the point of the mistake.
 *
 * Sub-1 is valid and is the interesting range: 0.5 holds each frame two
 * seconds. The upper bound is the output rate, above which extra source
 * frames would be dropped by the `-r 30` on each rendition rather than
 * shown faster. Kept as a local constant rather than importing
 * OUTPUT_FRAME_RATE: `functions/` must not depend on `cli/`. */
const MAX_PLAYBACK_FPS = 30

function validatePlaybackFps(value: unknown, errors: ValidationError[]): void {
  if (value == null) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(err('playback_fps', 'invalid_type', 'playback_fps must be a finite number.'))
    return
  }
  if (value <= 0 || value > MAX_PLAYBACK_FPS) {
    errors.push(
      err(
        'playback_fps',
        'invalid_value',
        `playback_fps must be in (0, ${MAX_PLAYBACK_FPS}] (got ${value}).`,
      ),
    )
  }
}

/**
 * Validate `radius_mi` (positive finite number; bounded loosely
 * at 1e9 so an absurd publisher-side bug surfaces before D1
 * accepts it). Phase 3d. */
function validateRadiusMi(value: unknown, errors: ValidationError[]): void {
  if (value == null) return
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(err('radius_mi', 'invalid_type', 'radius_mi must be a finite number.'))
    return
  }
  if (value <= 0 || value > 1_000_000_000) {
    errors.push(
      err('radius_mi', 'invalid_value', `radius_mi must be positive and < 1e9 (got ${value}).`),
    )
  }
}

function validateIsoDate(field: string, value: unknown, errors: ValidationError[]): void {
  if (value == null || value === '') return
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    errors.push(err(field, 'invalid_iso_date', `${field} must be an ISO 8601 timestamp.`))
  }
}

function validateTimeRange(body: DatasetDraftBody, errors: ValidationError[]): void {
  validateIsoDate('start_time', body.start_time, errors)
  validateIsoDate('end_time', body.end_time, errors)
  if (
    body.start_time &&
    body.end_time &&
    body.start_time > body.end_time
  ) {
    errors.push(err('end_time', 'before_start', 'end_time must be ≥ start_time.'))
  }
  // The doc's "both-or-neither" rule. A draft that only has
  // start_time is fine — the editor may be filling them in — but a
  // publish-readiness check will trip if they're not paired.
}

function validateCategories(value: unknown, errors: ValidationError[]): void {
  if (value == null) return
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(err('categories', 'invalid_type', 'Categories must be an object of facet→values.'))
    return
  }
  let total = 0
  for (const [facet, values] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(values)) {
      errors.push(err(`categories.${facet}`, 'invalid_type', 'Each facet must be an array of strings.'))
      continue
    }
    for (const v of values) {
      if (typeof v !== 'string' || v.length === 0 || v.length > 80) {
        errors.push(
          err(
            `categories.${facet}`,
            'invalid_value',
            'Each category value must be 1-80 characters.',
          ),
        )
      }
      total++
    }
  }
  if (total > 6) {
    errors.push(err('categories', 'too_many', 'Datasets may have at most 6 categories.'))
  }
}

function validateStringArray(
  field: string,
  value: unknown,
  maxItems: number,
  perItemMax: number,
  errors: ValidationError[],
): void {
  if (value == null) return
  if (!Array.isArray(value)) {
    errors.push(err(field, 'invalid_type', `${field} must be an array of strings.`))
    return
  }
  if (value.length > maxItems) {
    errors.push(err(field, 'too_many', `${field} may have at most ${maxItems} entries.`))
  }
  for (const v of value) {
    if (typeof v !== 'string' || v.length === 0 || v.length > perItemMax) {
      errors.push(
        err(field, 'invalid_value', `Each ${field} entry must be 1-${perItemMax} characters.`),
      )
    }
  }
}

/**
 * Validate the body of `POST /publish/datasets` (create draft).
 * Required: title, format. Slug is optional (will be derived).
 * Everything else is graded as a draft — the publish handler
 * re-runs `validateForPublish` before flipping `published_at`.
 */
export function validateDraftCreate(body: DatasetDraftBody): ValidationError[] {
  const errors: ValidationError[] = []
  validateTitle(body.title, errors)
  validateFormat(body.format, errors, /* required */ true)
  validateSlug(body.slug, errors, /* required */ false)
  validateAbstract(body.abstract, errors)
  validateOptionalString('organization', body.organization, 100, errors)
  validateVisibility(body.visibility, errors, /* required */ false)
  validateOptionalString('data_ref', body.data_ref, 1024, errors)
  validateOptionalString('color_table_ref', body.color_table_ref, 1024, errors)
  validateJsonStringField('probing_info', body.probing_info, 4096, errors)
  validateBoundingBox(body.bounding_box, errors)
  validateOptionalString('celestial_body', body.celestial_body, 64, errors)
  validateRadiusMi(body.radius_mi, errors)
  validateLonOrigin(body.lon_origin, errors)
  validatePlaybackFps(body.playback_fps, errors)
  validateRenderEncoding(body.render_encoding, body.color_scale, errors)
  // null is allowed (clears the column on UPDATE; treated as
  // the column's default "no flip" on INSERT). Anything else
  // non-boolean is a type error.
  if (
    body.is_flipped_in_y !== undefined &&
    body.is_flipped_in_y !== null &&
    typeof body.is_flipped_in_y !== 'boolean'
  ) {
    errors.push(err('is_flipped_in_y', 'invalid_type', 'is_flipped_in_y must be a boolean.'))
  }
  validateUrlField('website_link', body.website_link, errors)
  validateTimeRange(body, errors)
  validateCategories(body.categories, errors)
  validateStringArray('keywords', body.keywords, 20, 40, errors)
  validateStringArray('tags', body.tags, 20, 40, errors)
  validateOptionalString('license_spdx', body.license_spdx, 100, errors)
  validateUrlField('license_url', body.license_url, errors)
  validateOptionalString('license_statement', body.license_statement, 4000, errors)
  validateOptionalString('attribution_text', body.attribution_text, 1000, errors)
  validateOptionalString('rights_holder', body.rights_holder, 200, errors)
  validateOptionalString('doi', body.doi, 200, errors)
  validateOptionalString('citation_text', body.citation_text, 4000, errors)
  validateLegacyId(body.legacy_id, errors)
  return errors
}

/**
 * Validate the body of `PUT /publish/datasets/{id}` (edit). Same
 * surface as create except every field is optional — a partial
 * patch is the intended shape.
 */
export function validateDraftUpdate(body: DatasetDraftBody): ValidationError[] {
  const errors: ValidationError[] = []
  if (body.title !== undefined) validateTitle(body.title, errors)
  if (body.format !== undefined) validateFormat(body.format, errors, /* required */ false)
  if (body.slug !== undefined) validateSlug(body.slug, errors, /* required */ false)
  if (body.abstract !== undefined) validateAbstract(body.abstract, errors)
  validateOptionalString('organization', body.organization, 100, errors)
  if (body.visibility !== undefined) validateVisibility(body.visibility, errors, false)
  validateOptionalString('data_ref', body.data_ref, 1024, errors)
  validateOptionalString('color_table_ref', body.color_table_ref, 1024, errors)
  validateJsonStringField('probing_info', body.probing_info, 4096, errors)
  validateBoundingBox(body.bounding_box, errors)
  validateOptionalString('celestial_body', body.celestial_body, 64, errors)
  validateRadiusMi(body.radius_mi, errors)
  validateLonOrigin(body.lon_origin, errors)
  validatePlaybackFps(body.playback_fps, errors)
  validateRenderEncoding(body.render_encoding, body.color_scale, errors)
  // null is allowed (clears the column on UPDATE; treated as
  // the column's default "no flip" on INSERT). Anything else
  // non-boolean is a type error.
  if (
    body.is_flipped_in_y !== undefined &&
    body.is_flipped_in_y !== null &&
    typeof body.is_flipped_in_y !== 'boolean'
  ) {
    errors.push(err('is_flipped_in_y', 'invalid_type', 'is_flipped_in_y must be a boolean.'))
  }
  validateUrlField('website_link', body.website_link, errors)
  validateTimeRange(body, errors)
  validateCategories(body.categories, errors)
  validateStringArray('keywords', body.keywords, 20, 40, errors)
  validateStringArray('tags', body.tags, 20, 40, errors)
  validateOptionalString('license_spdx', body.license_spdx, 100, errors)
  validateUrlField('license_url', body.license_url, errors)
  validateOptionalString('license_statement', body.license_statement, 4000, errors)
  validateLegacyId(body.legacy_id, errors)
  return errors
}

/**
 * Stricter validation run by the publish handler before flipping
 * `published_at`. Requires the full Phase-3 required set: title,
 * slug, format, data_ref, visibility, license.
 */
export function validateForPublish(body: DatasetDraftBody): ValidationError[] {
  const errors: ValidationError[] = []
  validateTitle(body.title, errors)
  validateSlug(body.slug, errors, /* required */ true)
  validateFormat(body.format, errors, /* required */ true)
  validateVisibility(body.visibility, errors, /* required */ true)
  if (!body.data_ref) {
    errors.push(err('data_ref', 'required', 'A data_ref is required to publish.'))
  } else {
    validateOptionalString('data_ref', body.data_ref, 1024, errors)
  }
  if (!body.license_spdx && !body.license_statement) {
    errors.push(
      err(
        'license',
        'required',
        'Either license_spdx or license_statement must be set to publish.',
      ),
    )
  }
  validateAbstract(body.abstract, errors)
  validateTimeRange(body, errors)
  validateCategories(body.categories, errors)
  validateStringArray('keywords', body.keywords, 20, 40, errors)
  validateStringArray('tags', body.tags, 20, 40, errors)
  return errors
}

export function validateTourDraft(body: TourDraftBody): ValidationError[] {
  const errors: ValidationError[] = []
  validateTitle(body.title, errors)
  validateSlug(body.slug, errors, /* required */ false)
  validateOptionalString('description', body.description, 8000, errors)
  validateOptionalString('tour_json_ref', body.tour_json_ref, 1024, errors)
  if (body.visibility !== undefined) validateVisibility(body.visibility, errors, false)
  return errors
}

/** Internal — re-exported for tests. */
export const __internal = { hasControlChars, looksLikeUrl, deriveSlug }
