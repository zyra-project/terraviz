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
  validateAssetInit,
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
