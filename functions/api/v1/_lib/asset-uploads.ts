/**
 * `asset_uploads` row-level helpers + per-kind validation rules.
 *
 * Sits between the route handlers (Commit C: init; Commit D:
 * complete) and the `asset_uploads` table introduced in
 * `migrations/catalog/0006_asset_uploads.sql`.
 *
 * Validation lives here, not in `validators.ts`, because the rule
 * set is asset-pipeline-specific (mime allow-list per kind, size
 * caps, content_digest claim shape) and would clutter the
 * dataset-draft validator with concerns that aren't about dataset
 * row content.
 *
 * The size caps mirror `CATALOG_PUBLISHING_TOOLS.md` "Validation
 * rules":
 *   - data (video):       ≤ 10 GB
 *   - data (image):       ≤ 100 MB
 *   - thumbnail / legend: ≤ 100 MB (image bucket — generous; the
 *                         portal warns at the 4096×4096 dimension cap
 *                         which produces ~30 MB at PNG worst case).
 *   - sphere_thumbnail:   ≤ 10 MB (small by construction —
 *                         512×256 WebP is ~40 KB).
 *   - caption:            ≤ 1 MB.
 */

import type { AssetKind } from './r2-store'

const SIZE_10_GB = 10 * 1024 * 1024 * 1024
const SIZE_100_MB = 100 * 1024 * 1024
const SIZE_10_MB = 10 * 1024 * 1024
const SIZE_1_MB = 1 * 1024 * 1024

/** Mime types accepted per asset kind. */
const MIME_ALLOWLIST: Record<AssetKind, ReadonlySet<string>> = {
  data: new Set([
    'video/mp4',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/json', // tour/json
  ]),
  thumbnail: new Set(['image/png', 'image/jpeg', 'image/webp']),
  legend: new Set(['image/png', 'image/jpeg', 'image/webp']),
  caption: new Set(['text/vtt']),
  sphere_thumbnail: new Set(['image/webp', 'image/jpeg']),
}

const ALL_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>([
  'data',
  'thumbnail',
  'legend',
  'caption',
  'sphere_thumbnail',
])

/** The body shape `POST .../asset` accepts. */
export interface AssetInitBody {
  kind?: unknown
  mime?: unknown
  size?: unknown
  content_digest?: unknown
}

export interface ValidatedAssetInit {
  kind: AssetKind
  mime: string
  size: number
  content_digest: string
}

export interface AssetInitValidationError {
  field: string
  code: string
  message: string
}

/**
 * Validate the body for `POST .../asset`. Returns the cleaned-up
 * shape on success or an `errors` array shaped like the rest of the
 * publisher API's validation envelopes.
 */
export function validateAssetInit(
  body: AssetInitBody,
): { ok: true; value: ValidatedAssetInit } | { ok: false; errors: AssetInitValidationError[] } {
  const errors: AssetInitValidationError[] = []

  // `kind` stays null until validation proves it's an enum member,
  // so subsequent mime/size checks branch on a real `AssetKind`
  // value rather than relying on JS quirks (e.g. `body.size >
  // undefined === false`) for the invalid case to "no-op."
  let kind: AssetKind | null = null
  if (typeof body.kind !== 'string' || !ALL_KINDS.has(body.kind as AssetKind)) {
    errors.push({
      field: 'kind',
      code: 'invalid_kind',
      message: `kind must be one of ${[...ALL_KINDS].join(', ')}.`,
    })
  } else {
    kind = body.kind as AssetKind
  }

  if (typeof body.mime !== 'string' || !body.mime) {
    errors.push({ field: 'mime', code: 'invalid_mime', message: 'mime is required.' })
  } else if (kind !== null) {
    if (!MIME_ALLOWLIST[kind].has(body.mime)) {
      errors.push({
        field: 'mime',
        code: 'mime_not_allowed',
        message: `mime "${body.mime}" is not allowed for kind "${kind}". Allowed: ${[...MIME_ALLOWLIST[kind]].join(', ')}.`,
      })
    }
  }

  if (
    typeof body.size !== 'number' ||
    !Number.isInteger(body.size) ||
    body.size <= 0
  ) {
    errors.push({
      field: 'size',
      code: 'invalid_size',
      message: 'size must be a positive integer (bytes).',
    })
  } else if (kind !== null) {
    const mime = typeof body.mime === 'string' ? body.mime : undefined
    const cap = maxSizeForKind(kind, mime)
    if (body.size > cap) {
      errors.push({
        field: 'size',
        code: 'size_exceeded',
        message: `size ${body.size} exceeds the ${formatBytes(cap)} cap for kind "${kind}".`,
      })
    }
  }

  if (typeof body.content_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(body.content_digest)) {
    errors.push({
      field: 'content_digest',
      code: 'invalid_digest',
      message: 'content_digest must be sha256:<64 lowercase hex chars>.',
    })
  }

  if (errors.length) return { ok: false, errors }
  // `kind` is non-null in the success path because errors would be
  // non-empty otherwise; the `!` makes the narrowing explicit.
  return {
    ok: true,
    value: {
      kind: kind!,
      mime: body.mime as string,
      size: body.size as number,
      content_digest: body.content_digest as string,
    },
  }
}

/**
 * Body shape `POST .../asset` accepts when initiating an
 * image-sequence upload (Phase 3pf). The presence of the `frames`
 * array is what routes the request into the image-sequence code
 * path; the parent body's `mime` field carries the per-frame MIME
 * (every frame must claim the same one — see
 * `validateImageSequenceInit`). Distinct from `AssetInitBody` so
 * the parsers stay focused; the route handler decides which
 * validator to call based on whether `frames` is present.
 */
export interface ImageSequenceInitBody {
  kind?: unknown
  mime?: unknown
  /** Sum of every frame's `size` (bytes). Cross-checked against
   *  the array totals — declared mismatch fails the request. */
  size?: unknown
  frames?: unknown
  /** SHA-256 of the canonical source-filenames JSON the publisher
   *  PUTs alongside the frames. The GHA runner re-hashes that
   *  blob and compares — see `verifySourceFilenamesBlob` in
   *  `cli/transcode-from-dispatch.ts`. The validator owns this
   *  field's shape check so the route handler's mint step never
   *  runs against a malformed claim. */
  source_filenames_digest?: unknown
}

/** One entry in the `frames` array passed by the client. */
export interface ImageSequenceFrameInit {
  filename: string
  digest: string
  size: number
}

export interface ValidatedImageSequenceInit {
  kind: 'data'
  mime: string
  /** Lowercase `png` / `jpg` / `webp` matching the `extForMime`
   *  convention so the R2 key the runner reads matches the one the
   *  PUT lands at. */
  extension: string
  /** Frames in the order the publisher provided them. Encode order
   *  is the array index; the per-frame R2 key embeds that index. */
  frames: ImageSequenceFrameInit[]
  totalSize: number
  /** Validated `sha256:<64-hex>` digest of the canonical
   *  source-filenames JSON blob. Stored on the asset_uploads row's
   *  `claimed_digest`; the runner re-verifies before encoding. */
  sourceFilenamesDigest: string
}

// Frame-count cap is shared with the GHA runner + portal
// uploader via a single source of truth in
// `cli/lib/image-sequence-constants.ts`. Re-exported here so
// existing call sites that import from this module keep working
// without churning their import paths. Phase 3pf-review/F —
// Copilot discussion_r3263124306.
import { MAX_IMAGE_SEQUENCE_FRAMES } from '../../../../src/types/image-sequence-constants'
export { MAX_IMAGE_SEQUENCE_FRAMES }

/** Aggregate-size cap on an image-sequence upload. Same 10 GB
 *  ceiling as the MP4-source path — the runner's GHA budget is
 *  what determines the absolute upper bound. */
const SIZE_IMAGE_SEQUENCE_TOTAL = SIZE_10_GB

/** Per-frame mime allow-list for image-sequence uploads. The
 *  validator additionally enforces that every frame in a single
 *  upload claims the *same* mime — mixed PNG + JPEG is rejected.
 *  See `docs/CATALOG_IMAGE_SEQUENCE_PLAN.md` §Open questions Q2. */
const IMAGE_SEQUENCE_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])

/**
 * Validate the body for `POST .../asset` when the client is
 * starting an image-sequence upload. Returns the cleaned-up shape
 * on success or a typed `errors` array (same envelope the
 * single-file validator returns).
 *
 * Rejection cases worth calling out explicitly:
 *
 *   - `frames` must be a non-empty array of length ≤
 *     MAX_IMAGE_SEQUENCE_FRAMES. Empty arrays would mint an
 *     `asset_uploads` row that the /complete handler couldn't
 *     reason about; the cap closes the in-browser-hashing and
 *     JSON-response-size axes.
 *   - `mime` must be a single value from the image-sequence
 *     allow-list. The per-frame mime is what ffmpeg's
 *     image-sequence input mode expects — mixed mimes inside one
 *     sequence would force the runner to demux, which the runner
 *     deliberately doesn't do (see plan §Open questions Q2).
 *   - Every frame's `digest` must match the same `sha256:<64hex>`
 *     shape the single-file path enforces.
 *   - Every frame's `filename` must be a non-empty string. The
 *     publisher's display naming is computed server-side from
 *     `slug` + `start_time` + `period` (see plan §"Frames as
 *     data"); the original filenames are kept only for the
 *     `source_filenames.json` audit blob.
 *   - Filenames must be unique within the upload. Duplicates
 *     would leave the publisher unable to distinguish their
 *     frames in the source-filenames manifest later.
 *   - The declared `size` on the parent body must equal the sum
 *     of `frames[*].size`. Surfaces a client/server disagreement
 *     before any bytes move.
 */
export function validateImageSequenceInit(
  body: ImageSequenceInitBody,
):
  | { ok: true; value: ValidatedImageSequenceInit }
  | { ok: false; errors: AssetInitValidationError[] } {
  const errors: AssetInitValidationError[] = []

  // `kind` must be `data` for image-sequence uploads — the only
  // supported sequence target today is the dataset's `data_ref`.
  if (body.kind !== 'data') {
    errors.push({
      field: 'kind',
      code: 'invalid_kind',
      message: 'kind must be "data" for image-sequence uploads.',
    })
  }

  let mime: string | null = null
  if (typeof body.mime !== 'string' || !body.mime) {
    errors.push({ field: 'mime', code: 'invalid_mime', message: 'mime is required.' })
  } else if (!IMAGE_SEQUENCE_MIME_ALLOWLIST.has(body.mime)) {
    errors.push({
      field: 'mime',
      code: 'mime_not_allowed',
      message: `mime "${body.mime}" is not allowed for an image-sequence upload. Allowed: ${[...IMAGE_SEQUENCE_MIME_ALLOWLIST].join(', ')}.`,
    })
  } else {
    mime = body.mime
  }

  if (!Array.isArray(body.frames)) {
    errors.push({
      field: 'frames',
      code: 'invalid_frames',
      message: 'frames must be an array.',
    })
    return { ok: false, errors }
  }
  // Cap + emptiness are sanity bounds, not soft suggestions —
  // early-return BEFORE the O(N) per-frame loop below so a
  // hostile client can't trigger a 1 000 000-iteration
  // validation pass with a single request. Phase 3pf-review/E —
  // Copilot discussion_r3263124264.
  if (body.frames.length === 0) {
    errors.push({
      field: 'frames',
      code: 'frames_empty',
      message: 'frames must contain at least one entry.',
    })
    return { ok: false, errors }
  }
  if (body.frames.length > MAX_IMAGE_SEQUENCE_FRAMES) {
    errors.push({
      field: 'frames',
      code: 'frames_too_many',
      message: `frames count ${body.frames.length} exceeds the cap of ${MAX_IMAGE_SEQUENCE_FRAMES}.`,
    })
    return { ok: false, errors }
  }

  // Per-frame validation. Each error references the offending
  // index in the field path so a publisher fixing a malformed
  // 47th frame doesn't have to manually count.
  const seenFilenames = new Set<string>()
  let totalSize = 0
  const validatedFrames: ImageSequenceFrameInit[] = []
  for (let i = 0; i < body.frames.length; i++) {
    const f = body.frames[i] as Record<string, unknown> | null | undefined
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      errors.push({
        field: `frames[${i}]`,
        code: 'invalid_frame',
        message: `frames[${i}] must be an object.`,
      })
      continue
    }
    const { filename, digest, size } = f as {
      filename?: unknown
      digest?: unknown
      size?: unknown
    }
    if (typeof filename !== 'string' || filename.length === 0) {
      errors.push({
        field: `frames[${i}].filename`,
        code: 'invalid_filename',
        message: `frames[${i}].filename must be a non-empty string.`,
      })
    } else if (seenFilenames.has(filename)) {
      errors.push({
        field: `frames[${i}].filename`,
        code: 'duplicate_filename',
        message: `frames[${i}].filename "${filename}" is duplicated within the upload.`,
      })
    } else {
      seenFilenames.add(filename)
    }
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      errors.push({
        field: `frames[${i}].digest`,
        code: 'invalid_digest',
        message: `frames[${i}].digest must be sha256:<64 lowercase hex chars>.`,
      })
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
      errors.push({
        field: `frames[${i}].size`,
        code: 'invalid_size',
        message: `frames[${i}].size must be a positive integer (bytes).`,
      })
    } else {
      totalSize += size
    }
    if (
      typeof filename === 'string' &&
      filename.length > 0 &&
      typeof digest === 'string' &&
      /^sha256:[0-9a-f]{64}$/.test(digest) &&
      typeof size === 'number' &&
      Number.isInteger(size) &&
      size > 0
    ) {
      validatedFrames.push({ filename, digest, size })
    }
  }

  if (totalSize > SIZE_IMAGE_SEQUENCE_TOTAL) {
    errors.push({
      field: 'size',
      code: 'size_exceeded',
      message: `Aggregate frame size ${formatBytes(totalSize)} exceeds the ${formatBytes(SIZE_IMAGE_SEQUENCE_TOTAL)} cap.`,
    })
  }

  if (
    typeof body.size !== 'number' ||
    !Number.isInteger(body.size) ||
    body.size <= 0
  ) {
    errors.push({
      field: 'size',
      code: 'invalid_size',
      message: 'size must be a positive integer (bytes) and equal the sum of frames[*].size.',
    })
  } else if (body.size !== totalSize && validatedFrames.length === body.frames.length) {
    // Only flag the sum-mismatch when every frame's size parsed
    // cleanly — otherwise the per-frame errors above are the
    // root cause and a sum-mismatch report would be noise.
    errors.push({
      field: 'size',
      code: 'size_sum_mismatch',
      message: `Declared size ${body.size} does not match the sum of frames[*].size (${totalSize}).`,
    })
  }

  // `source_filenames_digest` is the SHA-256 of the canonical
  // source-filenames JSON blob the publisher PUTs alongside the
  // frames. Owning it here keeps the route handler's mint step
  // from running against a malformed claim (N + 1 SigV4
  // computations before a 400 was the prior shape) and makes the
  // validator the single source of truth for the body's shape.
  if (
    typeof body.source_filenames_digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(body.source_filenames_digest)
  ) {
    errors.push({
      field: 'source_filenames_digest',
      code: 'invalid_digest',
      message:
        'source_filenames_digest must be sha256:<64 lowercase hex chars>. The client ' +
        'computes it from the canonical JSON of {filename, index} entries so the GHA ' +
        "runner can re-verify the manifest's contents before encoding.",
    })
  }

  if (errors.length) return { ok: false, errors }
  // Non-null narrowing — `mime` is set above on the success path
  // because the validator returns early on shape errors; the
  // explicit `!` makes the type narrowing visible.
  return {
    ok: true,
    value: {
      kind: 'data',
      mime: mime!,
      extension: extForMime(mime!),
      frames: validatedFrames,
      totalSize,
      sourceFilenamesDigest: body.source_filenames_digest as string,
    },
  }
}

/**
 * Per-kind size cap. Exposed for tests + the route handler to surface
 * in error messages without re-deriving the bytes-to-MB conversion.
 */
export function maxSizeForKind(kind: AssetKind, mime?: string): number {
  switch (kind) {
    case 'data':
      // Video uses the Stream upload ceiling; everything else uses
      // the image cap. The mime is what splits the two.
      return mime === 'video/mp4' ? SIZE_10_GB : SIZE_100_MB
    case 'thumbnail':
    case 'legend':
      return SIZE_100_MB
    case 'sphere_thumbnail':
      return SIZE_10_MB
    case 'caption':
      return SIZE_1_MB
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(0)} GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/**
 * Picks the file extension for a given mime. Used to build the
 * content-addressed R2 key. `application/json` maps to `json` so
 * tour assets land at `…/asset.json`.
 */
export function extForMime(mime: string): string {
  switch (mime) {
    case 'video/mp4':
      return 'mp4'
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'text/vtt':
      return 'vtt'
    case 'application/json':
      return 'json'
  }
  // Fall back to the first 8 alphanumerics after the slash. Validation
  // already restricts mime to the allowlist, so this is a safety net.
  const tail = mime.split('/').pop() ?? 'bin'
  return tail.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
}

/** Asset-upload row as stored in `asset_uploads`. */
export interface AssetUploadRow {
  id: string
  dataset_id: string
  publisher_id: string
  kind: AssetKind
  target: 'r2' | 'stream'
  target_ref: string
  mime: string
  declared_size: number
  claimed_digest: string
  status: 'pending' | 'completed' | 'failed'
  failure_reason: string | null
  created_at: string
  completed_at: string | null
  /** Source frame count for image-sequence uploads. NULL on every
   *  MP4-source / single-image / auxiliary-asset row. The /complete
   *  handler reads this to branch between the single-key and
   *  multi-key HEAD verification paths. */
  frame_count: number | null
}

export interface InsertAssetUploadInput {
  id: string
  dataset_id: string
  publisher_id: string
  kind: AssetKind
  target: 'r2' | 'stream'
  target_ref: string
  mime: string
  declared_size: number
  claimed_digest: string
  created_at: string
  /** Number of source frames for image-sequence uploads. NULL /
   *  unset for every other upload kind (MP4 video sources,
   *  single-image data, auxiliary assets). The /complete handler
   *  reads this to branch its HEAD-check loop between the
   *  single-key MP4 path and the multi-key frames path. */
  frame_count?: number
}

/** Insert a new pending row. */
export async function insertAssetUpload(
  db: D1Database,
  input: InsertAssetUploadInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO asset_uploads (
         id, dataset_id, publisher_id, kind, target, target_ref, mime,
         declared_size, claimed_digest, status, failure_reason,
         created_at, completed_at, frame_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`,
    )
    .bind(
      input.id,
      input.dataset_id,
      input.publisher_id,
      input.kind,
      input.target,
      input.target_ref,
      input.mime,
      input.declared_size,
      input.claimed_digest,
      input.created_at,
      input.frame_count ?? null,
    )
    .run()
}

/** Read one upload row by id. Returns null if not found. */
export async function getAssetUpload(
  db: D1Database,
  id: string,
): Promise<AssetUploadRow | null> {
  const row = await db
    .prepare(`SELECT * FROM asset_uploads WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<AssetUploadRow>()
  return row ?? null
}

/** Mark an upload completed. Idempotent — calling twice is a no-op. */
export async function markAssetUploadCompleted(
  db: D1Database,
  id: string,
  completedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE asset_uploads
         SET status = 'completed', completed_at = ?, failure_reason = NULL
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(completedAt, id)
    .run()
}

/** Mark an upload failed with a machine-readable reason code. */
export async function markAssetUploadFailed(
  db: D1Database,
  id: string,
  reason: string,
  completedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE asset_uploads
         SET status = 'failed', completed_at = ?, failure_reason = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(completedAt, reason, id)
    .run()
}

/**
 * Flip the appropriate `*_ref` (and digest) column on the
 * `datasets` row for a successfully-verified upload.
 *
 *   - `data` over R2:     data_ref + content_digest, clears source_digest
 *   - `data` over Stream: data_ref + source_digest, clears content_digest
 *                         (master-playlist hash for content_digest is a
 *                          Phase 4 manifest concern; Stream's bytes are
 *                          opaque so we trust the claim)
 *   - everything else:    *_ref + auxiliary_digests JSON merge
 *
 * Mutual exclusion of `content_digest` / `source_digest` keeps the
 * digest semantics unambiguous: a dataset whose `data_ref` flips
 * R2→Stream (or the reverse) doesn't end up with stale residue from
 * the previous backend in the inactive column.
 *
 * For auxiliary assets the JSON merge is done atomically inside the
 * UPDATE via SQLite's `json_set(coalesce(...), '$.<key>', ?)`. This
 * is concurrency-safe: two auxiliary uploads (or one upload + the
 * sphere-thumbnail job) racing on the same row update disjoint JSON
 * keys without clobbering each other. The previous read-then-write
 * pattern lost keys under that race.
 *
 * Does not invalidate the KV snapshot or stamp the asset_uploads
 * row — `applyAssetAndMarkCompleted` below batches both into a
 * single D1 transaction.
 */
export async function applyAssetToDataset(
  db: D1Database,
  datasetId: string,
  upload: AssetUploadRow,
  verifiedDigest: string,
  now: string,
): Promise<void> {
  await buildApplyAssetStatement(db, datasetId, upload, verifiedDigest, now).run()
}

/**
 * Apply the asset to the dataset row and mark the upload row
 * `completed` as a single D1 transaction (`db.batch`). If either
 * statement fails, both roll back — the dataset and upload rows
 * never end up in disagreement (e.g., dataset has the new ref but
 * upload still says `pending`, which would let a retry re-fire
 * side-effects like the sphere-thumbnail enqueue).
 *
 * The mark-completed UPDATE keeps its `WHERE status = 'pending'`
 * guard so a duplicate /complete call inside a tight retry window
 * is still a no-op (idempotent).
 */
export async function applyAssetAndMarkCompleted(
  db: D1Database,
  datasetId: string,
  upload: AssetUploadRow,
  verifiedDigest: string,
  now: string,
): Promise<void> {
  await db.batch([
    buildApplyAssetStatement(db, datasetId, upload, verifiedDigest, now),
    db
      .prepare(
        `UPDATE asset_uploads
           SET status = 'completed', completed_at = ?, failure_reason = NULL
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(now, upload.id),
  ])
}

/**
 * Just the dataset-row half of the video-source finalisation —
 * stamp `transcoding=1`, record the publisher's `source_digest`,
 * and conditionally clear `data_ref` for drafts. Used by the
 * /complete handler's "persist before dispatch" ordering so the
 * dispatch fires against a row whose state already matches what
 * the workflow expects. The asset_uploads row stays `pending`
 * and gets flipped to `completed` only after the dispatch is
 * confirmed (see `markTranscodingUploadCompleted` below).
 *
 * Conditional WHERE clause is the atomic counterpart to the
 * route's JS-level overlap check: stamp only if the row isn't
 * already bound to a *different* upload's transcode. Without
 * the SQL guard, two concurrent /complete calls could both
 * pass the JS check (each reading a transcoding=NULL row),
 * both UPDATE, and both dispatch — the later UPDATE wins
 * `active_transcode_upload_id` but the earlier workflow has
 * already been launched and becomes a stale/orphan run
 * (PR #112 followup — asset-uploads.ts:407). Returns
 * rows-affected; 0 means a concurrent upload won the race and
 * the caller should surface 409 `transcoding_in_progress`.
 *
 * `content_digest` clearing mirrors `data_ref`'s conditional
 * shape: drafts clear immediately (no public consumer reading
 * the old digest); published rows preserve the existing
 * digest *during* the transcode window so the row's integrity
 * metadata still describes the bundle public clients are
 * actively serving. `clearTranscoding` does the atomic
 * data_ref-swap-plus-digest-clear when /transcode-complete
 * lands — at that point the new HLS bundle is live and the
 * old digest no longer applies. PR #112 followup —
 * asset-uploads.ts:404 (the prior unconditional clear left
 * published rows without integrity metadata during a 1–10
 * minute window where public clients were still reading the
 * old bundle).
 */
export async function stampTranscodingForVideoSource(
  db: D1Database,
  datasetId: string,
  upload: AssetUploadRow,
  now: string,
): Promise<number> {
  // SQL guard mirrors the route's JS-level overlap check:
  //   • non-transcoding row → stamp (transcoding IS NULL or 0;
  //     both are idle states per the migration / type comments,
  //     so the guard treats them equivalently via
  //     `COALESCE(transcoding, 0) = 0`. The earlier
  //     `transcoding IS NULL` clause missed rows whose column
  //     happens to be 0 — those would falsely look like a
  //     concurrent transcode and the UPDATE would refuse a
  //     legitimate fresh stamp. PR #112 followup.)
  //   • same-upload retry → stamp (active = upload.id matches)
  //   • transcoding=1 + active=otherUpload → 0 rows changed
  //   • transcoding=1 + active=NULL → 0 rows changed (the
  //     route's JS check now rejects this case as a corrupted
  //     state requiring operator cleanup; the WHERE clause is
  //     the matching atomic-level defense). The earlier
  //     `active_transcode_upload_id IS NULL OR = ?` clause
  //     allowed a stamp to take over a stuck transcoding=1 row,
  //     which could start a second workflow alongside whatever
  //     workflow left the row in that shape. PR #112 followup.
  const result = await db
    .prepare(
      `UPDATE datasets
         SET transcoding = 1,
             active_transcode_upload_id = ?,
             data_ref = CASE WHEN published_at IS NULL THEN '' ELSE data_ref END,
             source_digest = ?,
             content_digest = CASE WHEN published_at IS NULL THEN NULL ELSE content_digest END,
             updated_at = ?
       WHERE id = ?
         AND (COALESCE(transcoding, 0) = 0 OR active_transcode_upload_id = ?)`,
    )
    .bind(upload.id, upload.claimed_digest, now, datasetId, upload.id)
    .run()
  return result.meta?.changes ?? 0
}

/**
 * Image-sequence parallel to `stampTranscodingForVideoSource`.
 * Sets the same transcoding lifecycle columns (transcoding=1,
 * active_transcode_upload_id, data_ref clear for drafts,
 * source_digest, content_digest clear for drafts) AND populates
 * the three Phase 3pf dataset-row columns (frame_count,
 * frame_extension, frame_source_filenames_ref) so the manifest
 * serializer surfaces the frame metadata as soon as the transcode
 * completes — no second UPDATE inside /transcode-complete needed.
 *
 * The same SQL guard the video version uses applies: a
 * non-transcoding row (transcoding NULL or 0) or a same-upload
 * retry stamps; any other transcoding=1 state refuses with
 * `changes=0`. Atomic with the route's JS-level overlap check so
 * a concurrent /complete that swapped the binding in the gap
 * between SELECT and UPDATE returns 409 rather than launching a
 * second workflow.
 *
 * `frame_source_filenames_ref` carries the R2 key of the
 * auxiliary JSON blob (built by `buildFrameSourceFilenamesKey`
 * in `r2-store.ts`). The caller is responsible for HEAD-checking
 * the blob before this stamp lands so a dangling ref never reaches
 * the row. `frame_extension` is what `extForMime` returned for
 * the upload's mime (`png` / `jpg` / `webp`).
 */
export async function stampTranscodingForFrameSource(
  db: D1Database,
  datasetId: string,
  upload: AssetUploadRow,
  frameCount: number,
  frameExtension: string,
  frameSourceFilenamesRef: string,
  now: string,
): Promise<number> {
  // The three `frame_*` columns are wrapped in the same
  // `published_at IS NULL` guard as `data_ref` / `content_digest`
  // so a re-upload of an already-published image-sequence row
  // doesn't surface a mid-transcode inconsistency: data_ref still
  // points at the OLD HLS bundle (preserved by the CASE above)
  // while the frame metadata would otherwise jump to the NEW
  // upload's prefix. The Phase 3pg `/frames` exposure layer reads
  // these columns to build `urlTemplate` — letting them diverge
  // from data_ref through the transcode window would surface a
  // stale view to consumers. /transcode-complete swaps all six
  // (data_ref, content_digest, source_digest, frame_count,
  // frame_extension, frame_source_filenames_ref) atomically when
  // the bundle is ready. Phase 3pf-review/E — Copilot
  // discussion suppressed-confidence #3.
  const result = await db
    .prepare(
      `UPDATE datasets
         SET transcoding = 1,
             active_transcode_upload_id = ?,
             data_ref = CASE WHEN published_at IS NULL THEN '' ELSE data_ref END,
             source_digest = ?,
             content_digest = CASE WHEN published_at IS NULL THEN NULL ELSE content_digest END,
             frame_count = CASE WHEN published_at IS NULL THEN ? ELSE frame_count END,
             frame_extension = CASE WHEN published_at IS NULL THEN ? ELSE frame_extension END,
             frame_source_filenames_ref = CASE WHEN published_at IS NULL THEN ? ELSE frame_source_filenames_ref END,
             updated_at = ?
       WHERE id = ?
         AND (COALESCE(transcoding, 0) = 0 OR active_transcode_upload_id = ?)`,
    )
    .bind(
      upload.id,
      upload.claimed_digest,
      frameCount,
      frameExtension,
      frameSourceFilenamesRef,
      now,
      datasetId,
      upload.id,
    )
    .run()
  return result.meta?.changes ?? 0
}

/**
 * Mark just the asset_uploads row as completed. The companion
 * dataset-row stamp lives in `stampTranscodingForVideoSource` /
 * `stampTranscodingForFrameSource`; the three are split so the
 * /complete handler can persist the dataset state, fire the
 * external dispatch, and then mark the upload completed only
 * after the dispatch confirms.
 *
 * Both source kinds (MP4 + image-sequence) share this helper —
 * the upload-row schema is identical and the lifecycle invariant
 * is the same. The earlier `markTranscodingUploadCompleted` name read
 * as MP4-specific and misled readers tracing the frame-source
 * flow; renamed in 3pf-review/B.
 *
 * The `WHERE status = 'pending'` guard makes this idempotent
 * against a retry in the same way `applyAssetAndMarkCompleted`
 * is — a duplicate /complete call inside a tight retry window
 * is a no-op rather than a double-update.
 */
export async function markTranscodingUploadCompleted(
  db: D1Database,
  uploadId: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE asset_uploads
         SET status = 'completed', completed_at = ?, failure_reason = NULL
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(now, uploadId)
    .run()
}

/** Snapshot of the columns we capture before stamping a
 *  transcode, so a dispatch failure can restore the row's
 *  prior state losslessly. Per-column null is the same value
 *  SQLite would write — a row that genuinely had no
 *  `content_digest` before the stamp gets that NULL preserved
 *  through the revert.
 *
 *  The three `frame_*` fields are NULL on the MP4-source path
 *  (the stamp doesn't touch them so the revert doesn't either —
 *  the revert's UPDATE writes the snapshot value back regardless,
 *  which is a no-op when both before and after are NULL). The
 *  image-sequence stamp populates them; the revert clears them
 *  back to their prior values (NULL on a fresh row, or the prior
 *  upload's values on a re-upload of an already-published row).
 *  Symmetric with how the existing `data_ref` / `content_digest`
 *  / `source_digest` fields work. */
export interface TranscodingStampSnapshot {
  data_ref: string
  content_digest: string | null
  source_digest: string | null
  frame_count: number | null
  frame_extension: string | null
  frame_source_filenames_ref: string | null
}

/**
 * Compensating update for the dispatch-failure path: revert the
 * transcoding stamp set by `stampTranscodingForVideoSource` so
 * the row goes back to the state it was in before /complete
 * was called. Best-effort — if this UPDATE itself fails, the
 * row stays stuck `transcoding=1` and an operator has to clear
 * it by hand. Failed compensation is logged at the call site so
 * `wrangler tail` shows it.
 *
 * Scoped to `AND active_transcode_upload_id = ?` so the revert
 * is a no-op when another upload has already re-stamped the row
 * in the gap between our stamp and our dispatch-failure handler.
 * Without that clause the revert would wipe the newer upload's
 * in-flight state (PR #112 followup — race window Copilot
 * flagged on complete.ts:405). Returns the number of rows
 * affected; a 0 means we lost the race and should log it (the
 * other upload now owns the row and our retry on the original
 * upload is a stale operation).
 *
 * Restores all three columns the stamp mutated: `data_ref`,
 * `content_digest`, and `source_digest`. The earlier shape
 * (data_ref restored, source_digest unconditionally cleared,
 * content_digest untouched) was lossy on draft rows whose
 * prior asset carried integrity metadata — the stamp cleared
 * content_digest (drafts wipe the digest along with data_ref),
 * and the revert had no way to bring it back. PR #112
 * followup — asset-uploads.ts:revertTranscodingStamp scope.
 */
export async function revertTranscodingStamp(
  db: D1Database,
  datasetId: string,
  upload: AssetUploadRow,
  prior: TranscodingStampSnapshot,
  now: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE datasets
         SET transcoding = NULL,
             active_transcode_upload_id = NULL,
             data_ref = ?,
             content_digest = ?,
             source_digest = ?,
             frame_count = ?,
             frame_extension = ?,
             frame_source_filenames_ref = ?,
             updated_at = ?
       WHERE id = ? AND active_transcode_upload_id = ?`,
    )
    .bind(
      prior.data_ref,
      prior.content_digest,
      prior.source_digest,
      prior.frame_count,
      prior.frame_extension,
      prior.frame_source_filenames_ref,
      now,
      datasetId,
      upload.id,
    )
    .run()
  // upload row may still be pending (we hadn't marked it yet);
  // leave the status alone so a retry works.
  return result.meta?.changes ?? 0
}

/**
 * Called by the GHA transcode workflow when the HLS bundle is
 * written to R2. Flips `data_ref` to the master.m3u8 path and
 * clears `transcoding`. The dataset row never sees `data_ref`
 * set while `transcoding=1` (which would lie to the manifest
 * endpoint) — the single UPDATE atomically swaps both columns.
 *
 * Reached via `POST /api/v1/publish/datasets/{id}/transcode-complete`
 * — a dedicated route added in 3pd/A-fix specifically because
 * the generic dataset PUT path refuses the `transcoding` field
 * by design (server-managed column). The workflow authenticates
 * with a `role=service` Cloudflare Access service token; the
 * route constructs `data_ref` server-side from the route id +
 * upload_id so the workflow can't accidentally point the row
 * at another dataset's bundle.
 *
 * Scoped to `AND active_transcode_upload_id = ?` so the route's
 * explicit upload-id check at the top of the handler is matched
 * by an atomic guard at the UPDATE itself — closes the TOCTOU
 * window where a *different* /asset/{...}/complete could swap
 * `active_transcode_upload_id` to a newer upload between the
 * route's SELECT and this UPDATE (PR #112 followup —
 * transcode-complete.ts:178). Returns rows-affected; the caller
 * uses 0 as a "lost the race, refuse to apply" signal and
 * surfaces it as 409 stale.
 */
/** Frame-source-specific metadata that swaps atomically with
 *  `data_ref` when /transcode-complete clears the transcode.
 *  All three columns mirror the values `stampTranscodingForFrameSource`
 *  wrote to the row on a draft, or were withheld pending the swap
 *  on a re-upload of a published row (see the guard comment on
 *  the stamp function). NULL when the upload is MP4-source.
 *  Phase 3pf-review/E — Copilot suppressed-confidence #3. */
export interface FrameSourceCompleteFields {
  frame_count: number
  frame_extension: string
  frame_source_filenames_ref: string
}

export async function clearTranscoding(
  db: D1Database,
  datasetId: string,
  uploadId: string,
  dataRef: string,
  now: string,
  frameSource: FrameSourceCompleteFields | null = null,
): Promise<number> {
  // `content_digest = NULL` here is the atomic counterpart to
  // the *conditional* clear in `stampTranscodingForVideoSource`:
  // we hold the published-row's old digest during the
  // transcode window so its integrity metadata still describes
  // the in-flight bundle, then drop it in the same UPDATE that
  // swaps data_ref to the new HLS master.m3u8. HLS bundles
  // don't carry a single content_digest (the bundle is many
  // segment files; integrity is per-segment via the master
  // manifest), so the cleared column is the correct steady
  // state for a post-/transcode-complete row. PR #112
  // followup — asset-uploads.ts:491.
  //
  // For frame-source uploads the three `frame_*` columns swap
  // atomically alongside `data_ref` — `stampTranscodingForFrameSource`
  // deliberately HELD their prior values on a published-row
  // re-upload so a mid-transcode `/frames` read wouldn't surface
  // a stale view; this UPDATE is where they actually transition
  // to the new upload's values. The companion stamp wrote them
  // unconditionally on drafts (where there's no prior published
  // state to preserve), so on the draft path this UPDATE is just
  // re-asserting the same values.
  if (frameSource) {
    const result = await db
      .prepare(
        `UPDATE datasets
           SET transcoding = NULL,
               active_transcode_upload_id = NULL,
               data_ref = ?,
               content_digest = NULL,
               frame_count = ?,
               frame_extension = ?,
               frame_source_filenames_ref = ?,
               updated_at = ?
         WHERE id = ? AND active_transcode_upload_id = ?`,
      )
      .bind(
        dataRef,
        frameSource.frame_count,
        frameSource.frame_extension,
        frameSource.frame_source_filenames_ref,
        now,
        datasetId,
        uploadId,
      )
      .run()
    return result.meta?.changes ?? 0
  }
  const result = await db
    .prepare(
      `UPDATE datasets
         SET transcoding = NULL,
             active_transcode_upload_id = NULL,
             data_ref = ?,
             content_digest = NULL,
             updated_at = ?
       WHERE id = ? AND active_transcode_upload_id = ?`,
    )
    .bind(dataRef, now, datasetId, uploadId)
    .run()
  return result.meta?.changes ?? 0
}

/**
 * Build (but do not execute) the `UPDATE datasets` statement for a
 * verified upload. Returns a prepared+bound D1PreparedStatement so
 * callers can either run it directly or include it in a batch.
 */
function buildApplyAssetStatement(
  db: D1Database,
  datasetId: string,
  upload: AssetUploadRow,
  verifiedDigest: string,
  now: string,
): D1PreparedStatement {
  if (upload.kind === 'data') {
    if (upload.target === 'stream') {
      return db
        .prepare(
          `UPDATE datasets
             SET data_ref = ?,
                 source_digest = ?,
                 content_digest = NULL,
                 updated_at = ?
           WHERE id = ?`,
        )
        .bind(upload.target_ref, verifiedDigest, now, datasetId)
    }
    return db
      .prepare(
        `UPDATE datasets
           SET data_ref = ?,
               content_digest = ?,
               source_digest = NULL,
               updated_at = ?
         WHERE id = ?`,
      )
      .bind(upload.target_ref, verifiedDigest, now, datasetId)
  }

  // Auxiliary asset — stamp `*_ref` + atomically merge into the
  // auxiliary_digests JSON via `json_set`. Both `refColumn` and
  // `jsonPath` come from fixed enum maps below (not user input), so
  // template-interpolating them into the SQL is safe.
  const refColumn = AUX_REF_COLUMN[upload.kind]
  const jsonPath = `$.${AUX_DIGEST_KEY[upload.kind]}`
  return db
    .prepare(
      `UPDATE datasets
         SET ${refColumn} = ?,
             auxiliary_digests = json_set(COALESCE(auxiliary_digests, '{}'), '${jsonPath}', ?),
             updated_at = ?
       WHERE id = ?`,
    )
    .bind(upload.target_ref, verifiedDigest, now, datasetId)
}

const AUX_REF_COLUMN: Record<Exclude<AssetKind, 'data'>, string> = {
  thumbnail: 'thumbnail_ref',
  sphere_thumbnail: 'sphere_thumbnail_ref',
  legend: 'legend_ref',
  caption: 'caption_ref',
}

const AUX_DIGEST_KEY: Record<Exclude<AssetKind, 'data'>, string> = {
  thumbnail: 'thumbnail',
  sphere_thumbnail: 'sphere_thumbnail',
  legend: 'legend',
  caption: 'caption',
}

