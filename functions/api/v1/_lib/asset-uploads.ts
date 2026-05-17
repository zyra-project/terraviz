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
         created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
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
 * confirmed (see `markVideoUploadCompleted` below).
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
 * Mark just the asset_uploads row as completed. The companion
 * dataset-row stamp lives in `stampTranscodingForVideoSource`
 * above; the two are split so the /complete handler can persist
 * the dataset state, fire the external dispatch, and then mark
 * the upload completed only after the dispatch confirms.
 *
 * The `WHERE status = 'pending'` guard makes this idempotent
 * against a retry in the same way `applyAssetAndMarkCompleted`
 * is — a duplicate /complete call inside a tight retry window
 * is a no-op rather than a double-update.
 */
export async function markVideoUploadCompleted(
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

/** Snapshot of the digest columns we capture before stamping
 *  a transcode, so a dispatch failure can restore the row's
 *  prior integrity metadata losslessly. Per-column null is
 *  the same value SQLite would write — a row that genuinely
 *  had no `content_digest` before the stamp gets that NULL
 *  preserved through the revert. */
export interface TranscodingStampSnapshot {
  data_ref: string
  content_digest: string | null
  source_digest: string | null
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
             updated_at = ?
       WHERE id = ? AND active_transcode_upload_id = ?`,
    )
    .bind(
      prior.data_ref,
      prior.content_digest,
      prior.source_digest,
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
export async function clearTranscoding(
  db: D1Database,
  datasetId: string,
  uploadId: string,
  dataRef: string,
  now: string,
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

