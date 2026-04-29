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

  if (typeof body.kind !== 'string' || !ALL_KINDS.has(body.kind as AssetKind)) {
    errors.push({
      field: 'kind',
      code: 'invalid_kind',
      message: `kind must be one of ${[...ALL_KINDS].join(', ')}.`,
    })
  }
  const kind = body.kind as AssetKind

  if (typeof body.mime !== 'string' || !body.mime) {
    errors.push({ field: 'mime', code: 'invalid_mime', message: 'mime is required.' })
  } else if (kind && MIME_ALLOWLIST[kind]) {
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
  } else if (kind && body.size > maxSizeForKind(kind, body.mime as string | undefined)) {
    const cap = maxSizeForKind(kind, body.mime as string | undefined)
    errors.push({
      field: 'size',
      code: 'size_exceeded',
      message: `size ${body.size} exceeds the ${formatBytes(cap)} cap for kind "${kind}".`,
    })
  }

  if (typeof body.content_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(body.content_digest)) {
    errors.push({
      field: 'content_digest',
      code: 'invalid_digest',
      message: 'content_digest must be sha256:<64 lowercase hex chars>.',
    })
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    value: {
      kind,
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
