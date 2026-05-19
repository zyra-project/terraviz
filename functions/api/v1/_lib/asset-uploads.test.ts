/**
 * Tests for the asset-upload row helpers + the per-kind validation.
 *
 * Covers:
 *   - validateAssetInit accepts the happy-path bodies for every
 *     kind / mime pair the allowlist permits.
 *   - validateAssetInit refuses unknown kinds, missing fields,
 *     mismatched mime/kind, oversized payloads (with kind-specific
 *     caps), malformed digests.
 *   - extForMime maps every allowlist mime onto the documented
 *     extension and falls back safely for unknown mimes.
 *   - insertAssetUpload + getAssetUpload + markAssetUploadCompleted/
 *     Failed round-trip rows through the SQL fake. Re-marking a
 *     non-pending row is a no-op.
 */

import { describe, expect, it } from 'vitest'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'
import { asD1 } from './test-helpers'
import {
  extForMime,
  getAssetUpload,
  insertAssetUpload,
  markAssetUploadCompleted,
  markAssetUploadFailed,
  maxSizeForKind,
  MAX_IMAGE_SEQUENCE_FRAMES,
  validateAssetInit,
  validateImageSequenceInit,
} from './asset-uploads'

const SHA64 = 'a'.repeat(64)
const HAPPY_DIGEST = `sha256:${SHA64}`

function makeDb() {
  const sqlite = freshMigratedDb()
  // Seed publisher + dataset rows so the FK constraints are satisfied.
  const ts = '2026-04-29T12:00:00.000Z'
  sqlite
    .prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
       VALUES ('NODE000', 'Test', 'https://test.local', 'k', ?)`,
    )
    .run(ts)
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, status, created_at)
       VALUES ('PUB001', 'p@test.local', 'P', 'staff', 'active', ?)`,
    )
    .run(ts)
  sqlite
    .prepare(
      `INSERT INTO datasets (id, slug, origin_node, title, format, data_ref,
                             weight, visibility, is_hidden, schema_version,
                             created_at, updated_at, publisher_id)
       VALUES ('DS001AAAAAAAAAAAAAAAAAAAAA', 'd', 'NODE000', 'D', 'video/mp4',
               '', 0, 'public', 0, 1, ?, ?, 'PUB001')`,
    )
    .run(ts, ts)
  return { d1: asD1(sqlite), sqlite }
}

describe('validateAssetInit', () => {
  it('accepts a video data upload', () => {
    const result = validateAssetInit({
      kind: 'data',
      mime: 'video/mp4',
      size: 50 * 1024 * 1024,
      content_digest: HAPPY_DIGEST,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('data')
  })

  it('accepts an image thumbnail', () => {
    const result = validateAssetInit({
      kind: 'thumbnail',
      mime: 'image/png',
      size: 1234,
      content_digest: HAPPY_DIGEST,
    })
    expect(result.ok).toBe(true)
  })

  it('accepts a sphere thumbnail in webp', () => {
    const result = validateAssetInit({
      kind: 'sphere_thumbnail',
      mime: 'image/webp',
      size: 50_000,
      content_digest: HAPPY_DIGEST,
    })
    expect(result.ok).toBe(true)
  })

  it('accepts a VTT caption', () => {
    const result = validateAssetInit({
      kind: 'caption',
      mime: 'text/vtt',
      size: 5_000,
      content_digest: HAPPY_DIGEST,
    })
    expect(result.ok).toBe(true)
  })

  it('refuses an unknown kind', () => {
    const result = validateAssetInit({
      kind: 'manifest',
      mime: 'application/json',
      size: 1,
      content_digest: HAPPY_DIGEST,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].field).toBe('kind')
    expect(result.errors[0].code).toBe('invalid_kind')
  })

  it('refuses a mime/kind mismatch', () => {
    const result = validateAssetInit({
      kind: 'caption',
      mime: 'image/png',
      size: 1,
      content_digest: HAPPY_DIGEST,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].field).toBe('mime')
    expect(result.errors[0].code).toBe('mime_not_allowed')
  })

  it('refuses oversized payloads per kind', () => {
    const cases = [
      { kind: 'data' as const, mime: 'video/mp4', size: 11 * 1024 ** 3 }, // > 10 GB
      { kind: 'data' as const, mime: 'image/png', size: 200 * 1024 ** 2 }, // > 100 MB
      { kind: 'thumbnail' as const, mime: 'image/png', size: 200 * 1024 ** 2 },
      { kind: 'sphere_thumbnail' as const, mime: 'image/webp', size: 50 * 1024 ** 2 }, // > 10 MB
      { kind: 'caption' as const, mime: 'text/vtt', size: 2 * 1024 ** 2 }, // > 1 MB
    ]
    for (const c of cases) {
      const r = validateAssetInit({ ...c, content_digest: HAPPY_DIGEST })
      expect(r.ok).toBe(false)
      if (r.ok) return
      const sizeErr = r.errors.find(e => e.field === 'size')
      expect(sizeErr?.code).toBe('size_exceeded')
    }
  })

  it('refuses non-positive sizes', () => {
    const r = validateAssetInit({
      kind: 'thumbnail',
      mime: 'image/png',
      size: 0,
      content_digest: HAPPY_DIGEST,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].field).toBe('size')
    expect(r.errors[0].code).toBe('invalid_size')
  })

  it('refuses non-sha256 digests', () => {
    for (const digest of ['md5:abc', 'sha256:zzz', SHA64, '', 'sha256:' + SHA64.toUpperCase()]) {
      const r = validateAssetInit({
        kind: 'thumbnail',
        mime: 'image/png',
        size: 1,
        content_digest: digest,
      })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.errors[0].field).toBe('content_digest')
    }
  })

  it('reports multiple errors at once when the body is broadly bad', () => {
    const r = validateAssetInit({
      kind: 'unknown',
      mime: 'something/weird',
      size: -1,
      content_digest: 'nope',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    const fields = new Set(r.errors.map(e => e.field))
    expect(fields.has('kind')).toBe(true)
    expect(fields.has('size')).toBe(true)
    expect(fields.has('content_digest')).toBe(true)
  })
})

describe('maxSizeForKind', () => {
  it('uses 10 GB for video data, 100 MB for non-video data', () => {
    expect(maxSizeForKind('data', 'video/mp4')).toBe(10 * 1024 ** 3)
    expect(maxSizeForKind('data', 'image/png')).toBe(100 * 1024 ** 2)
  })

  it('uses small caps for sphere thumb + caption', () => {
    expect(maxSizeForKind('sphere_thumbnail')).toBe(10 * 1024 ** 2)
    expect(maxSizeForKind('caption')).toBe(1 * 1024 ** 2)
  })
})

describe('validateImageSequenceInit', () => {
  // Helper: build a happy-path body with N frames whose digests
  // are deterministic-but-unique so failure-mode tests can shape
  // it from a known-good baseline.
  function happyBody(frameCount: number, mime = 'image/png'): Record<string, unknown> {
    const frames = Array.from({ length: frameCount }, (_, i) => ({
      filename: `frame_${String(i + 1).padStart(5, '0')}.png`,
      digest: `sha256:${String(i).padStart(64, '0').slice(0, 64)}`,
      size: 4_000_000,
    }))
    const size = frames.reduce((sum, f) => sum + f.size, 0)
    return {
      kind: 'data',
      mime,
      frames,
      size,
      // Validator now owns the digest's shape check — every
      // happy-path body needs a well-formed value to pass.
      source_filenames_digest: `sha256:${'f'.repeat(64)}`,
    }
  }

  it('accepts a happy-path body and surfaces totals + extension', () => {
    const result = validateImageSequenceInit(happyBody(3))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('data')
    expect(result.value.mime).toBe('image/png')
    expect(result.value.extension).toBe('png')
    expect(result.value.frames).toHaveLength(3)
    expect(result.value.totalSize).toBe(12_000_000)
  })

  it('maps image/jpeg → extension "jpg" so R2 keys use one extension convention', () => {
    // Stay consistent with the single-image content-addressed
    // path that already uses `jpg` for JPEG via `extForMime`.
    const body = happyBody(2, 'image/jpeg')
    // Mutate filenames to .jpg so the test fixture is internally
    // consistent — the per-frame mime is what drives extension
    // selection, not the filename, but readers expect them to
    // line up.
    ;(body.frames as Array<Record<string, unknown>>).forEach((f, i) => {
      f.filename = `frame_${String(i + 1).padStart(5, '0')}.jpg`
    })
    const result = validateImageSequenceInit(body)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.extension).toBe('jpg')
  })

  it('rejects a missing frames array', () => {
    const result = validateImageSequenceInit({ kind: 'data', mime: 'image/png', size: 100 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some(e => e.code === 'invalid_frames')).toBe(true)
  })

  it('rejects an empty frames array', () => {
    const result = validateImageSequenceInit({
      kind: 'data',
      mime: 'image/png',
      size: 0,
      frames: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some(e => e.code === 'frames_empty')).toBe(true)
  })

  it('rejects frames over the cap', () => {
    const result = validateImageSequenceInit(happyBody(MAX_IMAGE_SEQUENCE_FRAMES + 1))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some(e => e.code === 'frames_too_many')).toBe(true)
  })

  it('rejects a mime outside the image-sequence allowlist', () => {
    const result = validateImageSequenceInit(happyBody(2, 'video/mp4'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some(e => e.code === 'mime_not_allowed')).toBe(true)
  })

  it('rejects a non-data kind', () => {
    const body = happyBody(2)
    body.kind = 'thumbnail'
    const result = validateImageSequenceInit(body)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some(e => e.code === 'invalid_kind')).toBe(true)
  })

  it('rejects duplicate filenames', () => {
    const body = happyBody(3)
    const frames = body.frames as Array<Record<string, unknown>>
    frames[2].filename = frames[0].filename
    const result = validateImageSequenceInit(body)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const dup = result.errors.find(e => e.code === 'duplicate_filename')
    expect(dup).toBeDefined()
    expect(dup?.field).toBe('frames[2].filename')
  })

  it('rejects per-frame digests that aren\'t sha256:<64hex>', () => {
    const body = happyBody(2)
    ;(body.frames as Array<Record<string, unknown>>)[1].digest = 'sha256:not-hex'
    const result = validateImageSequenceInit(body)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const e = result.errors.find(e => e.field === 'frames[1].digest')
    expect(e?.code).toBe('invalid_digest')
  })

  it('rejects non-positive-integer per-frame sizes', () => {
    const body = happyBody(2)
    ;(body.frames as Array<Record<string, unknown>>)[0].size = 0
    ;(body.frames as Array<Record<string, unknown>>)[1].size = 'big'
    const result = validateImageSequenceInit(body)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.filter(e => e.code === 'invalid_size').length).toBe(2)
  })

  it('rejects an aggregate over 10 GB', () => {
    // Construct a body whose individual frame sizes are valid but
    // whose sum exceeds the 10 GB ceiling. 10 frames at 1.1 GB
    // each = 11 GB.
    const frames = Array.from({ length: 10 }, (_, i) => ({
      filename: `frame_${i}.png`,
      digest: `sha256:${'a'.repeat(64)}`,
      size: 1_100_000_000,
    }))
    // Filenames need to be unique too.
    frames.forEach((f, i) => {
      f.filename = `frame_${i}.png`
      f.digest = `sha256:${String(i).padStart(64, '0').slice(0, 64)}`
    })
    const total = frames.reduce((sum, f) => sum + f.size, 0)
    const result = validateImageSequenceInit({
      kind: 'data',
      mime: 'image/png',
      frames,
      size: total,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some(e => e.code === 'size_exceeded')).toBe(true)
  })

  it('rejects a declared total that does not match the sum of per-frame sizes', () => {
    const body = happyBody(3)
    body.size = 12_000_001 // off by 1
    const result = validateImageSequenceInit(body)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some(e => e.code === 'size_sum_mismatch')).toBe(true)
  })

  it('rejects a missing or malformed source_filenames_digest', () => {
    // Validator owns the field's shape check (3pf-review/A) so the
    // route handler's mint step never runs against a malformed
    // claim. The MAX_TOTAL_BYTES sum + this digest gate are the
    // last two body-shape pre-conditions a successful mint depends
    // on.
    const missing = happyBody(2)
    delete missing.source_filenames_digest
    const missingResult = validateImageSequenceInit(missing)
    expect(missingResult.ok).toBe(false)
    if (missingResult.ok) return
    expect(
      missingResult.errors.some(
        e => e.field === 'source_filenames_digest' && e.code === 'invalid_digest',
      ),
    ).toBe(true)

    const malformed = happyBody(2)
    malformed.source_filenames_digest = 'not-a-digest'
    const malformedResult = validateImageSequenceInit(malformed)
    expect(malformedResult.ok).toBe(false)
    if (malformedResult.ok) return
    expect(
      malformedResult.errors.some(
        e => e.field === 'source_filenames_digest' && e.code === 'invalid_digest',
      ),
    ).toBe(true)
  })

  it('surfaces the validated source-filenames digest on the success path', () => {
    const body = happyBody(2)
    body.source_filenames_digest = `sha256:${'b'.repeat(64)}`
    const result = validateImageSequenceInit(body)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sourceFilenamesDigest).toBe(`sha256:${'b'.repeat(64)}`)
  })

  it('suppresses the sum-mismatch report when per-frame size errors are the root cause', () => {
    // A frame with a non-numeric size produces an invalid_size
    // error AND would otherwise produce a (noisy) sum-mismatch
    // error too. The validator only surfaces the per-frame
    // error so the publisher's fix-it message points at the
    // actual problem.
    const body = happyBody(2)
    ;(body.frames as Array<Record<string, unknown>>)[1].size = 'big'
    body.size = 4_000_000 // would never match because one frame's size doesn't sum
    const result = validateImageSequenceInit(body)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some(e => e.code === 'size_sum_mismatch')).toBe(false)
    expect(result.errors.some(e => e.code === 'invalid_size')).toBe(true)
  })
})

describe('extForMime', () => {
  it('maps allowlist mimes onto the documented extensions', () => {
    expect(extForMime('video/mp4')).toBe('mp4')
    expect(extForMime('image/png')).toBe('png')
    expect(extForMime('image/jpeg')).toBe('jpg')
    expect(extForMime('image/webp')).toBe('webp')
    expect(extForMime('text/vtt')).toBe('vtt')
    expect(extForMime('application/json')).toBe('json')
  })

  it('falls back to the post-slash slug for unknown mimes', () => {
    expect(extForMime('application/octet-stream')).toBe('octetstr')
  })
})

describe('asset_uploads row helpers', () => {
  it('round-trips a pending row through insert + get', async () => {
    const { d1 } = makeDb()
    await insertAssetUpload(d1, {
      id: 'UP001',
      dataset_id: 'DS001AAAAAAAAAAAAAAAAAAAAA',
      publisher_id: 'PUB001',
      kind: 'thumbnail',
      target: 'r2',
      target_ref: `r2:datasets/DS001/by-digest/sha256/${SHA64}/thumbnail.png`,
      mime: 'image/png',
      declared_size: 1234,
      claimed_digest: HAPPY_DIGEST,
      created_at: '2026-04-29T12:00:00.000Z',
    })
    const row = await getAssetUpload(d1, 'UP001')
    expect(row).toMatchObject({
      id: 'UP001',
      dataset_id: 'DS001AAAAAAAAAAAAAAAAAAAAA',
      kind: 'thumbnail',
      target: 'r2',
      status: 'pending',
      failure_reason: null,
      completed_at: null,
        frame_count: null,
    })
  })

  it('marks completed only while still pending; second mark is a no-op', async () => {
    const { d1 } = makeDb()
    await insertAssetUpload(d1, {
      id: 'UP002',
      dataset_id: 'DS001AAAAAAAAAAAAAAAAAAAAA',
      publisher_id: 'PUB001',
      kind: 'data',
      target: 'stream',
      target_ref: 'stream:abc123',
      mime: 'video/mp4',
      declared_size: 100,
      claimed_digest: HAPPY_DIGEST,
      created_at: '2026-04-29T12:00:00.000Z',
    })
    await markAssetUploadCompleted(d1, 'UP002', '2026-04-29T12:01:00.000Z')
    const after = await getAssetUpload(d1, 'UP002')
    expect(after?.status).toBe('completed')
    expect(after?.completed_at).toBe('2026-04-29T12:01:00.000Z')

    // Second mark must not move the timestamp or reset the status.
    await markAssetUploadCompleted(d1, 'UP002', '2026-04-29T12:02:00.000Z')
    const stillAfter = await getAssetUpload(d1, 'UP002')
    expect(stillAfter?.completed_at).toBe('2026-04-29T12:01:00.000Z')
  })

  it('marks failed with a reason code while pending', async () => {
    const { d1 } = makeDb()
    await insertAssetUpload(d1, {
      id: 'UP003',
      dataset_id: 'DS001AAAAAAAAAAAAAAAAAAAAA',
      publisher_id: 'PUB001',
      kind: 'data',
      target: 'r2',
      target_ref: 'r2:k',
      mime: 'image/png',
      declared_size: 1,
      claimed_digest: HAPPY_DIGEST,
      created_at: '2026-04-29T12:00:00.000Z',
    })
    await markAssetUploadFailed(d1, 'UP003', 'digest_mismatch', '2026-04-29T12:01:00.000Z')
    const after = await getAssetUpload(d1, 'UP003')
    expect(after?.status).toBe('failed')
    expect(after?.failure_reason).toBe('digest_mismatch')
  })
})

describe('applyAssetToDataset — atomic json_set merge', () => {
  it('preserves prior auxiliary_digests keys when stamping a new one', async () => {
    const { d1, sqlite } = makeDb()
    const datasetId = 'DS001AAAAAAAAAAAAAAAAAAAAA'
    // Pre-existing legend digest left by an earlier upload.
    sqlite
      .prepare(`UPDATE datasets SET auxiliary_digests = ? WHERE id = ?`)
      .run(JSON.stringify({ legend: 'sha256:legendexisting' }), datasetId)
    // New thumbnail upload completes — should add `thumbnail` without
    // dropping the existing `legend` key.
    const { applyAssetToDataset } = await import('./asset-uploads')
    await applyAssetToDataset(
      d1,
      datasetId,
      {
        id: 'UP-AUX',
        dataset_id: datasetId,
        publisher_id: 'PUB001',
        kind: 'thumbnail',
        target: 'r2',
        target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64}/thumbnail.png`,
        mime: 'image/png',
        declared_size: 1234,
        claimed_digest: HAPPY_DIGEST,
        status: 'pending',
        failure_reason: null,
        created_at: '2026-04-29T12:00:00.000Z',
        completed_at: null,
        frame_count: null,
      },
      HAPPY_DIGEST,
      '2026-04-29T12:01:00.000Z',
    )
    const row = sqlite
      .prepare(`SELECT auxiliary_digests, thumbnail_ref FROM datasets WHERE id = ?`)
      .get(datasetId) as { auxiliary_digests: string; thumbnail_ref: string }
    const aux = JSON.parse(row.auxiliary_digests) as Record<string, string>
    expect(aux.legend).toBe('sha256:legendexisting')
    expect(aux.thumbnail).toBe(HAPPY_DIGEST)
    expect(row.thumbnail_ref).toContain('thumbnail.png')
  })

  it('clears source_digest when an R2 data upload completes', async () => {
    const { d1, sqlite } = makeDb()
    const datasetId = 'DS001AAAAAAAAAAAAAAAAAAAAA'
    // Pre-existing source_digest from a prior Stream-backed upload.
    sqlite
      .prepare(`UPDATE datasets SET source_digest = ? WHERE id = ?`)
      .run('sha256:stalefromstream', datasetId)
    const { applyAssetToDataset } = await import('./asset-uploads')
    await applyAssetToDataset(
      d1,
      datasetId,
      {
        id: 'UP-DATA',
        dataset_id: datasetId,
        publisher_id: 'PUB001',
        kind: 'data',
        target: 'r2',
        target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64}/asset.png`,
        mime: 'image/png',
        declared_size: 1234,
        claimed_digest: HAPPY_DIGEST,
        status: 'pending',
        failure_reason: null,
        created_at: '2026-04-29T12:00:00.000Z',
        completed_at: null,
        frame_count: null,
      },
      HAPPY_DIGEST,
      '2026-04-29T12:01:00.000Z',
    )
    const row = sqlite
      .prepare(`SELECT content_digest, source_digest FROM datasets WHERE id = ?`)
      .get(datasetId) as { content_digest: string; source_digest: string | null }
    expect(row.content_digest).toBe(HAPPY_DIGEST)
    expect(row.source_digest).toBeNull()
  })

  it('clears content_digest when a Stream data upload completes', async () => {
    const { d1, sqlite } = makeDb()
    const datasetId = 'DS001AAAAAAAAAAAAAAAAAAAAA'
    sqlite
      .prepare(`UPDATE datasets SET content_digest = ? WHERE id = ?`)
      .run('sha256:stalefromr2', datasetId)
    const { applyAssetToDataset } = await import('./asset-uploads')
    await applyAssetToDataset(
      d1,
      datasetId,
      {
        id: 'UP-DATA-STREAM',
        dataset_id: datasetId,
        publisher_id: 'PUB001',
        kind: 'data',
        target: 'stream',
        target_ref: 'stream:abc123',
        mime: 'video/mp4',
        declared_size: 1234,
        claimed_digest: HAPPY_DIGEST,
        status: 'pending',
        failure_reason: null,
        created_at: '2026-04-29T12:00:00.000Z',
        completed_at: null,
        frame_count: null,
      },
      HAPPY_DIGEST,
      '2026-04-29T12:01:00.000Z',
    )
    const row = sqlite
      .prepare(`SELECT content_digest, source_digest FROM datasets WHERE id = ?`)
      .get(datasetId) as { content_digest: string | null; source_digest: string }
    expect(row.source_digest).toBe(HAPPY_DIGEST)
    expect(row.content_digest).toBeNull()
  })

  it('initialises auxiliary_digests from null without crashing', async () => {
    const { d1, sqlite } = makeDb()
    const datasetId = 'DS001AAAAAAAAAAAAAAAAAAAAA'
    // auxiliary_digests starts NULL after fixture insert.
    const { applyAssetToDataset } = await import('./asset-uploads')
    await applyAssetToDataset(
      d1,
      datasetId,
      {
        id: 'UP-FRESH',
        dataset_id: datasetId,
        publisher_id: 'PUB001',
        kind: 'sphere_thumbnail',
        target: 'r2',
        target_ref: `r2:datasets/${datasetId}/by-digest/sha256/${SHA64}/sphere-thumbnail.webp`,
        mime: 'image/webp',
        declared_size: 1234,
        claimed_digest: HAPPY_DIGEST,
        status: 'pending',
        failure_reason: null,
        created_at: '2026-04-29T12:00:00.000Z',
        completed_at: null,
        frame_count: null,
      },
      HAPPY_DIGEST,
      '2026-04-29T12:01:00.000Z',
    )
    const row = sqlite
      .prepare(`SELECT auxiliary_digests FROM datasets WHERE id = ?`)
      .get(datasetId) as { auxiliary_digests: string }
    const aux = JSON.parse(row.auxiliary_digests) as Record<string, string>
    expect(aux.sphere_thumbnail).toBe(HAPPY_DIGEST)
  })
})

describe('transcoding lifecycle UPDATEs are scoped to active_transcode_upload_id', () => {
  // PR #112 followup — Copilot flagged that both `clearTranscoding`
  // and `revertTranscodingStamp` previously matched on dataset id
  // alone. That opened a TOCTOU race: between the route's SELECT
  // (which reads `active_transcode_upload_id`) and the UPDATE, a
  // *different* /asset/.../complete could re-stamp the row to a
  // newer upload, and our clear/revert would clobber it. The fix
  // is an `AND active_transcode_upload_id = ?` clause on each
  // UPDATE, with the rows-affected count surfaced to the caller
  // so a lost race is observable as 0 (not a silent no-op).

  const DATASET_ID = 'DS001AAAAAAAAAAAAAAAAAAAAA'
  const UPLOAD_A = 'UPA0000000000000000000000A'
  const UPLOAD_B = 'UPB0000000000000000000000B'

  function seedTranscodingRow(
    sqlite: ReturnType<typeof freshMigratedDb>,
    activeUploadId: string,
  ) {
    sqlite
      .prepare(
        `UPDATE datasets
           SET transcoding = 1,
               active_transcode_upload_id = ?,
               source_digest = ?,
               data_ref = '',
               updated_at = ?
         WHERE id = ?`,
      )
      .run(activeUploadId, `sha256:${'a'.repeat(64)}`, '2026-04-29T12:00:00.000Z', DATASET_ID)
  }

  function uploadStub(id: string) {
    return {
      id,
      dataset_id: DATASET_ID,
      publisher_id: 'PUB001',
      kind: 'data' as const,
      target: 'r2' as const,
      target_ref: `r2:uploads/${DATASET_ID}/${id}/source.mp4`,
      mime: 'video/mp4',
      declared_size: 1234,
      claimed_digest: HAPPY_DIGEST,
      status: 'pending' as const,
      failure_reason: null,
      created_at: '2026-04-29T12:00:00.000Z',
      completed_at: null,
      // NULL on every MP4-source row — the field discriminates
      // sequence uploads from single-file uploads.
      frame_count: null,
    }
  }

  it('clearTranscoding applies (changes=1) when active_transcode_upload_id matches', async () => {
    const { d1, sqlite } = makeDb()
    seedTranscodingRow(sqlite, UPLOAD_A)
    const { clearTranscoding } = await import('./asset-uploads')
    const changes = await clearTranscoding(
      d1,
      DATASET_ID,
      UPLOAD_A,
      `r2:videos/${DATASET_ID}/${UPLOAD_A}/master.m3u8`,
      '2026-04-29T12:30:00.000Z',
    )
    expect(changes).toBe(1)
    const row = sqlite
      .prepare(
        `SELECT transcoding, active_transcode_upload_id, data_ref
         FROM datasets WHERE id = ?`,
      )
      .get(DATASET_ID) as {
      transcoding: number | null
      active_transcode_upload_id: string | null
      data_ref: string
    }
    expect(row.transcoding).toBeNull()
    expect(row.active_transcode_upload_id).toBeNull()
    expect(row.data_ref).toBe(`r2:videos/${DATASET_ID}/${UPLOAD_A}/master.m3u8`)
  })

  it('clearTranscoding is a no-op (changes=0) when active_transcode_upload_id has been swapped', async () => {
    // Simulates the TOCTOU race: the route checked the row, found
    // UPLOAD_A bound, but by the time clearTranscoding runs the
    // row has been re-stamped to UPLOAD_B. The UPDATE must not
    // wipe UPLOAD_B's in-flight state.
    const { d1, sqlite } = makeDb()
    seedTranscodingRow(sqlite, UPLOAD_B)
    const { clearTranscoding } = await import('./asset-uploads')
    const changes = await clearTranscoding(
      d1,
      DATASET_ID,
      UPLOAD_A,
      `r2:videos/${DATASET_ID}/${UPLOAD_A}/master.m3u8`,
      '2026-04-29T12:30:00.000Z',
    )
    expect(changes).toBe(0)
    const row = sqlite
      .prepare(
        `SELECT transcoding, active_transcode_upload_id, data_ref
         FROM datasets WHERE id = ?`,
      )
      .get(DATASET_ID) as {
      transcoding: number | null
      active_transcode_upload_id: string | null
      data_ref: string
    }
    expect(row.transcoding).toBe(1)
    expect(row.active_transcode_upload_id).toBe(UPLOAD_B)
    expect(row.data_ref).toBe('')
  })

  it('revertTranscodingStamp restores prior digest state losslessly (changes=1)', async () => {
    // PR #112 followup — the prior signature only restored
    // data_ref and unconditionally cleared source_digest, which
    // was lossy on a draft row whose pre-stamp asset had
    // integrity metadata. The new shape passes a snapshot of
    // all three columns the stamp mutated.
    const { d1, sqlite } = makeDb()
    seedTranscodingRow(sqlite, UPLOAD_A)
    const { revertTranscodingStamp } = await import('./asset-uploads')
    const priorContentDigest = `sha256:${'c'.repeat(64)}`
    const priorSourceDigest = `sha256:${'s'.repeat(64)}`
    const changes = await revertTranscodingStamp(
      d1,
      DATASET_ID,
      uploadStub(UPLOAD_A),
      {
        data_ref: 'r2:datasets/old/asset.png',
        content_digest: priorContentDigest,
        source_digest: priorSourceDigest,
        frame_count: null,
        frame_extension: null,
        frame_source_filenames_ref: null,
      },
      '2026-04-29T12:05:00.000Z',
    )
    expect(changes).toBe(1)
    const row = sqlite
      .prepare(
        `SELECT transcoding, active_transcode_upload_id, source_digest,
                content_digest, data_ref
         FROM datasets WHERE id = ?`,
      )
      .get(DATASET_ID) as {
      transcoding: number | null
      active_transcode_upload_id: string | null
      source_digest: string | null
      content_digest: string | null
      data_ref: string
    }
    expect(row.transcoding).toBeNull()
    expect(row.active_transcode_upload_id).toBeNull()
    // All three pre-stamp values are now restored to exactly
    // what we passed in — the revert is genuinely lossless.
    expect(row.data_ref).toBe('r2:datasets/old/asset.png')
    expect(row.content_digest).toBe(priorContentDigest)
    expect(row.source_digest).toBe(priorSourceDigest)
  })

  it('revertTranscodingStamp preserves NULL digests when the prior row had none', async () => {
    // A fresh draft with no prior asset legitimately has both
    // digests as NULL. The revert must round-trip NULL → NULL
    // rather than e.g. coalescing them to the stamp's claim.
    const { d1, sqlite } = makeDb()
    seedTranscodingRow(sqlite, UPLOAD_A)
    const { revertTranscodingStamp } = await import('./asset-uploads')
    const changes = await revertTranscodingStamp(
      d1,
      DATASET_ID,
      uploadStub(UPLOAD_A),
      {
        data_ref: '',
        content_digest: null,
        source_digest: null,
        frame_count: null,
        frame_extension: null,
        frame_source_filenames_ref: null,
      },
      '2026-04-29T12:05:00.000Z',
    )
    expect(changes).toBe(1)
    const row = sqlite
      .prepare(
        `SELECT data_ref, content_digest, source_digest FROM datasets WHERE id = ?`,
      )
      .get(DATASET_ID) as {
      data_ref: string
      content_digest: string | null
      source_digest: string | null
    }
    expect(row.data_ref).toBe('')
    expect(row.content_digest).toBeNull()
    expect(row.source_digest).toBeNull()
  })

  it('revertTranscodingStamp is a no-op (changes=0) when another upload has taken over', async () => {
    // Race window: we stamped UPLOAD_A, dispatch failed, but
    // meanwhile UPLOAD_B's /complete swapped the binding. The
    // revert must not clobber UPLOAD_B's stamp — that would
    // wipe a newer in-flight transcode.
    const { d1, sqlite } = makeDb()
    seedTranscodingRow(sqlite, UPLOAD_B)
    const { revertTranscodingStamp } = await import('./asset-uploads')
    const changes = await revertTranscodingStamp(
      d1,
      DATASET_ID,
      uploadStub(UPLOAD_A),
      {
        data_ref: 'r2:videos/old/master.m3u8',
        content_digest: null,
        source_digest: null,
        frame_count: null,
        frame_extension: null,
        frame_source_filenames_ref: null,
      },
      '2026-04-29T12:05:00.000Z',
    )
    expect(changes).toBe(0)
    const row = sqlite
      .prepare(
        `SELECT transcoding, active_transcode_upload_id, source_digest
         FROM datasets WHERE id = ?`,
      )
      .get(DATASET_ID) as {
      transcoding: number | null
      active_transcode_upload_id: string | null
      source_digest: string | null
    }
    expect(row.transcoding).toBe(1)
    expect(row.active_transcode_upload_id).toBe(UPLOAD_B)
    expect(row.source_digest).toBe(`sha256:${'a'.repeat(64)}`)
  })

  it('stampTranscodingForVideoSource applies (changes=1) on a non-transcoding row', async () => {
    const { d1, sqlite } = makeDb()
    // Row starts non-transcoding (the makeDb default) and carries
    // a pre-existing content_digest from an earlier image upload —
    // the stamp must NULL it because the row's asset is being
    // replaced by a video.
    sqlite
      .prepare(`UPDATE datasets SET content_digest = ? WHERE id = ?`)
      .run(`sha256:${'b'.repeat(64)}`, DATASET_ID)
    const { stampTranscodingForVideoSource } = await import('./asset-uploads')
    const changes = await stampTranscodingForVideoSource(
      d1,
      DATASET_ID,
      uploadStub(UPLOAD_A),
      '2026-04-29T12:00:00.000Z',
    )
    expect(changes).toBe(1)
    const row = sqlite
      .prepare(
        `SELECT transcoding, active_transcode_upload_id, source_digest, content_digest
         FROM datasets WHERE id = ?`,
      )
      .get(DATASET_ID) as {
      transcoding: number | null
      active_transcode_upload_id: string | null
      source_digest: string | null
      content_digest: string | null
    }
    expect(row.transcoding).toBe(1)
    expect(row.active_transcode_upload_id).toBe(UPLOAD_A)
    expect(row.source_digest).toBe(HAPPY_DIGEST)
    // Stale content_digest from the previous asset is cleared so
    // it doesn't outlive the transcode window (PR #112 followup —
    // asset-uploads.ts:404).
    expect(row.content_digest).toBeNull()
  })

  it('stampTranscodingForVideoSource is idempotent (changes=1) when the same upload is already stamped', async () => {
    // Retry-safety: a second /complete call for the SAME upload
    // re-stamps the same values, which the WHERE clause permits
    // because `active_transcode_upload_id = UPLOAD_A` matches.
    const { d1, sqlite } = makeDb()
    seedTranscodingRow(sqlite, UPLOAD_A)
    const { stampTranscodingForVideoSource } = await import('./asset-uploads')
    const changes = await stampTranscodingForVideoSource(
      d1,
      DATASET_ID,
      uploadStub(UPLOAD_A),
      '2026-04-29T12:05:00.000Z',
    )
    expect(changes).toBe(1)
  })

  it('stampTranscodingForVideoSource is a no-op (changes=0) when a different upload owns the row', async () => {
    // The race scenario Copilot flagged: two concurrent /complete
    // calls both pass the route's JS-level overlap check (each
    // sees a non-transcoding snapshot), then both UPDATE. With
    // the SQL guard `active_transcode_upload_id IS NULL OR = ?`,
    // only the first stamp wins — the second sees changes=0 and
    // its caller surfaces 409 rather than launching a stale
    // workflow.
    const { d1, sqlite } = makeDb()
    seedTranscodingRow(sqlite, UPLOAD_B)
    const { stampTranscodingForVideoSource } = await import('./asset-uploads')
    const changes = await stampTranscodingForVideoSource(
      d1,
      DATASET_ID,
      uploadStub(UPLOAD_A),
      '2026-04-29T12:05:00.000Z',
    )
    expect(changes).toBe(0)
    // The UPLOAD_B stamp is untouched.
    const row = sqlite
      .prepare(
        `SELECT active_transcode_upload_id, source_digest FROM datasets WHERE id = ?`,
      )
      .get(DATASET_ID) as {
      active_transcode_upload_id: string | null
      source_digest: string | null
    }
    expect(row.active_transcode_upload_id).toBe(UPLOAD_B)
  })

  it('stampTranscodingForVideoSource treats transcoding=0 as idle (changes=1)', async () => {
    // PR #112 followup — the migration/type comments treat both
    // NULL and 0 as "not transcoding", but the earlier SQL
    // guard's `transcoding IS NULL` clause refused 0-valued
    // rows. The route's JS check (`if (dataset.transcoding &&
    // ...)`) correctly skips them, so the SQL guard would
    // refuse a legitimate fresh stamp on a row whose column
    // happened to be 0 instead of NULL (e.g., a hand-edited
    // reset, or any external code writing 0 rather than NULL).
    // The fix is `COALESCE(transcoding, 0) = 0`.
    const { d1, sqlite } = makeDb()
    sqlite
      .prepare(`UPDATE datasets SET transcoding = 0 WHERE id = ?`)
      .run(DATASET_ID)
    const { stampTranscodingForVideoSource } = await import('./asset-uploads')
    const changes = await stampTranscodingForVideoSource(
      d1,
      DATASET_ID,
      uploadStub(UPLOAD_A),
      '2026-04-29T12:00:00.000Z',
    )
    expect(changes).toBe(1)
    const row = sqlite
      .prepare(`SELECT transcoding, active_transcode_upload_id FROM datasets WHERE id = ?`)
      .get(DATASET_ID) as {
      transcoding: number | null
      active_transcode_upload_id: string | null
    }
    expect(row.transcoding).toBe(1)
    expect(row.active_transcode_upload_id).toBe(UPLOAD_A)
  })

  it('stampTranscodingForVideoSource refuses (changes=0) on a corrupted transcoding=1 + active=NULL row', async () => {
    // PR #112 followup — the earlier `active_transcode_upload_id
    // IS NULL OR = ?` SQL guard was too permissive: a row with
    // transcoding=1 but NULL active binding (pre-migration-0012,
    // manual reset, partial revert) would let a fresh stamp take
    // over and dispatch a second workflow alongside whatever was
    // already running. The new guard
    // (`transcoding IS NULL OR active = ?`) refuses unless the
    // row is genuinely non-transcoding or already bound to this
    // upload.
    const { d1, sqlite } = makeDb()
    // Manually craft the corrupted state — the lifecycle helpers
    // never produce this on their own, but a pre-migration or
    // operator edit could leave a row in this shape.
    sqlite
      .prepare(
        `UPDATE datasets
           SET transcoding = 1,
               active_transcode_upload_id = NULL,
               updated_at = ?
         WHERE id = ?`,
      )
      .run('2026-04-29T12:00:00.000Z', DATASET_ID)
    const { stampTranscodingForVideoSource } = await import('./asset-uploads')
    const changes = await stampTranscodingForVideoSource(
      d1,
      DATASET_ID,
      uploadStub(UPLOAD_A),
      '2026-04-29T12:05:00.000Z',
    )
    expect(changes).toBe(0)
    // Row state unchanged — the stamp didn't take over a
    // corrupted-but-transcoding row.
    const row = sqlite
      .prepare(
        `SELECT transcoding, active_transcode_upload_id FROM datasets WHERE id = ?`,
      )
      .get(DATASET_ID) as {
      transcoding: number | null
      active_transcode_upload_id: string | null
    }
    expect(row.transcoding).toBe(1)
    expect(row.active_transcode_upload_id).toBeNull()
  })

  it('stampTranscodingForVideoSource preserves content_digest on a PUBLISHED row', async () => {
    // PR #112 followup (asset-uploads.ts:404): published rows
    // keep `data_ref` pointing at the prior HLS bundle while
    // the new one transcodes, so the public manifest endpoint
    // keeps serving it. The integrity metadata (content_digest)
    // should follow the same shape — preserved during the
    // transcode window, swapped atomically by `clearTranscoding`
    // when /transcode-complete lands. Clearing it during stamp
    // would leave a 1–10 minute window where the row points at
    // a valid bundle but advertises no digest.
    const { d1, sqlite } = makeDb()
    const previousDigest = `sha256:${'p'.repeat(64)}`
    sqlite
      .prepare(
        `UPDATE datasets
            SET published_at = ?, data_ref = 'r2:videos/old/master.m3u8',
                content_digest = ?
          WHERE id = ?`,
      )
      .run('2026-04-01T00:00:00.000Z', previousDigest, DATASET_ID)
    const { stampTranscodingForVideoSource } = await import('./asset-uploads')
    const changes = await stampTranscodingForVideoSource(
      d1,
      DATASET_ID,
      uploadStub(UPLOAD_A),
      '2026-04-29T12:00:00.000Z',
    )
    expect(changes).toBe(1)
    const row = sqlite
      .prepare(
        `SELECT transcoding, data_ref, source_digest, content_digest
         FROM datasets WHERE id = ?`,
      )
      .get(DATASET_ID) as {
      transcoding: number | null
      data_ref: string
      source_digest: string | null
      content_digest: string | null
    }
    // Transcoding is stamped, source_digest carries the new
    // claim, but data_ref AND content_digest both stay frozen
    // for the duration of the workflow.
    expect(row.transcoding).toBe(1)
    expect(row.data_ref).toBe('r2:videos/old/master.m3u8')
    expect(row.source_digest).toBe(HAPPY_DIGEST)
    expect(row.content_digest).toBe(previousDigest)
  })

  it('clearTranscoding clears content_digest atomically with the data_ref swap', async () => {
    // PR #112 followup (asset-uploads.ts:491): the atomic
    // counterpart to the published-row preservation above —
    // when /transcode-complete lands, the new HLS bundle is
    // live and the old digest no longer describes it. HLS
    // bundles don't carry a single content_digest (the bundle
    // is many segment files; integrity is per-segment via the
    // master manifest), so NULL is the correct steady state.
    const { d1, sqlite } = makeDb()
    const previousDigest = `sha256:${'p'.repeat(64)}`
    sqlite
      .prepare(
        `UPDATE datasets
            SET published_at = ?, transcoding = 1,
                active_transcode_upload_id = ?,
                data_ref = 'r2:videos/old/master.m3u8',
                content_digest = ?,
                source_digest = ?
          WHERE id = ?`,
      )
      .run(
        '2026-04-01T00:00:00.000Z',
        UPLOAD_A,
        previousDigest,
        HAPPY_DIGEST,
        DATASET_ID,
      )
    const { clearTranscoding } = await import('./asset-uploads')
    const newDataRef = `r2:videos/${DATASET_ID}/${UPLOAD_A}/master.m3u8`
    const changes = await clearTranscoding(
      d1,
      DATASET_ID,
      UPLOAD_A,
      newDataRef,
      '2026-04-29T12:30:00.000Z',
    )
    expect(changes).toBe(1)
    const row = sqlite
      .prepare(
        `SELECT transcoding, active_transcode_upload_id, data_ref, content_digest
         FROM datasets WHERE id = ?`,
      )
      .get(DATASET_ID) as {
      transcoding: number | null
      active_transcode_upload_id: string | null
      data_ref: string
      content_digest: string | null
    }
    expect(row.transcoding).toBeNull()
    expect(row.active_transcode_upload_id).toBeNull()
    expect(row.data_ref).toBe(newDataRef)
    // The previously-preserved digest is now NULL — the new
    // bundle is an HLS package without a single hash.
    expect(row.content_digest).toBeNull()
  })
})
