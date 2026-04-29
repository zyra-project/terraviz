/**
 * Tests for the sphere-thumbnail generation job.
 *
 * Coverage:
 *   - Stream sources call the documented Stream thumbnail URL with
 *     the right query params (width/height/time/fit), persist the
 *     bytes to R2 at the predictable key, and stamp
 *     `sphere_thumbnail_ref` + `auxiliary_digests.sphere_thumbnail`
 *     on the dataset row.
 *   - R2 image sources go through Cloudflare Images URL
 *     transformations when `CF_IMAGES_RESIZE_BASE` is set.
 *   - R2 image sources fall back to the source bytes when no
 *     Images integration is configured.
 *   - Unsupported source schemes (vimeo:, url:) return null without
 *     mutating the row.
 *   - Fetch failures throw, surfaced by the queue's error handler.
 *   - The auxiliary_digests merge preserves prior keys.
 */

import { describe, expect, it, vi } from 'vitest'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'
import { asD1 } from './test-helpers'
import { generateSphereThumbnail } from './sphere-thumbnail-job'

const HELLO_BYTES = new TextEncoder().encode('hello world')
const HELLO_BUFFER = HELLO_BYTES.buffer.slice(
  HELLO_BYTES.byteOffset,
  HELLO_BYTES.byteOffset + HELLO_BYTES.byteLength,
) as ArrayBuffer
// SHA-256("hello world") (well-known fixture)
const HELLO_DIGEST =
  'sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'

interface R2Recording {
  key: string
  bytes: ArrayBuffer
  contentType: string | undefined
}

function makeBucket(): { bucket: R2Bucket; writes: R2Recording[] } {
  const writes: R2Recording[] = []
  const bucket = {
    put: async (
      key: string,
      bytes: ArrayBuffer,
      opts?: { httpMetadata?: { contentType?: string } },
    ) => {
      writes.push({ key, bytes, contentType: opts?.httpMetadata?.contentType })
    },
  } as unknown as R2Bucket
  return { bucket, writes }
}

function setupDb() {
  const sqlite = freshMigratedDb()
  const ts = '2026-04-29T12:00:00.000Z'
  sqlite
    .prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, public_key, created_at)
       VALUES ('NODE000', 'T', 'https://t', 'k', ?)`,
    )
    .run(ts)
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, status, created_at)
       VALUES ('PUB001', 'p@t', 'P', 'staff', 'active', ?)`,
    )
    .run(ts)
  const datasetId = 'DS001AAAAAAAAAAAAAAAAAAAAA'
  sqlite
    .prepare(
      `INSERT INTO datasets (id, slug, origin_node, title, format, data_ref,
                             weight, visibility, is_hidden, schema_version,
                             created_at, updated_at, publisher_id)
       VALUES (?, 'd', 'NODE000', 'D', 'video/mp4', 'stream:abc',
               0, 'public', 0, 1, ?, ?, 'PUB001')`,
    )
    .run(datasetId, ts, ts)
  return { sqlite, datasetId }
}

describe('generateSphereThumbnail — Stream sources', () => {
  it('hits Stream thumbnail URL and persists the bytes + digest', async () => {
    const { sqlite, datasetId } = setupDb()
    const { bucket, writes } = makeBucket()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_R2: bucket,
      STREAM_CUSTOMER_SUBDOMAIN: 'customer-real.cloudflarestream.com',
    }
    const fetchStub = vi.fn(async (url: string) =>
      new Response(HELLO_BUFFER, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
    ) as unknown as typeof fetch

    const result = await generateSphereThumbnail(
      env,
      { dataset_id: datasetId, source_ref: 'stream:abc123' },
      { fetchImpl: fetchStub },
    )
    expect(result).toEqual({
      ok: true,
      sphere_thumbnail_ref: `r2:datasets/${datasetId}/sphere-thumbnail.jpg`,
      digest: HELLO_DIGEST,
      size: HELLO_BYTES.byteLength,
    })

    expect(fetchStub).toHaveBeenCalledOnce()
    const calledUrl = (fetchStub as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]
    expect(calledUrl).toBe(
      'https://customer-real.cloudflarestream.com/abc123/thumbnails/thumbnail.jpg?width=512&height=256&time=25%25&fit=crop',
    )
    expect(writes).toHaveLength(1)
    expect(writes[0].key).toBe(`datasets/${datasetId}/sphere-thumbnail.jpg`)
    expect(writes[0].contentType).toBe('image/jpeg')

    const row = sqlite
      .prepare(`SELECT sphere_thumbnail_ref, auxiliary_digests FROM datasets WHERE id = ?`)
      .get(datasetId) as { sphere_thumbnail_ref: string; auxiliary_digests: string }
    expect(row.sphere_thumbnail_ref).toBe(`r2:datasets/${datasetId}/sphere-thumbnail.jpg`)
    const aux = JSON.parse(row.auxiliary_digests) as Record<string, string>
    expect(aux.sphere_thumbnail).toBe(HELLO_DIGEST)
  })

  it('falls back to MOCK_STREAM subdomain when no real subdomain is set', async () => {
    const { sqlite, datasetId } = setupDb()
    const { bucket } = makeBucket()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_R2: bucket,
      MOCK_STREAM: 'true',
    }
    const fetchStub = vi.fn(async () =>
      new Response(HELLO_BUFFER, { status: 200 }),
    ) as unknown as typeof fetch
    await generateSphereThumbnail(
      env,
      { dataset_id: datasetId, source_ref: 'stream:abc' },
      { fetchImpl: fetchStub },
    )
    const url = (fetchStub as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]
    expect(url).toContain('customer-mock.cloudflarestream.com')
  })
})

describe('generateSphereThumbnail — R2 image sources', () => {
  it('routes through Cloudflare Images URL transformations when configured', async () => {
    const { sqlite, datasetId } = setupDb()
    const { bucket } = makeBucket()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_R2: bucket,
      CF_IMAGES_RESIZE_BASE: 'https://images.example.com',
      CATALOG_R2_BUCKET: 'terraviz-assets',
    }
    const fetchStub = vi.fn(async () =>
      new Response(HELLO_BUFFER, { status: 200 }),
    ) as unknown as typeof fetch
    await generateSphereThumbnail(
      env,
      {
        dataset_id: datasetId,
        source_ref: `r2:datasets/${datasetId}/by-digest/sha256/aaa/asset.png`,
      },
      { fetchImpl: fetchStub },
    )
    const url = (fetchStub as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]
    expect(url).toBe(
      `https://images.example.com/cdn-cgi/image/fit=fill,width=512,height=256,format=jpeg/terraviz-assets/datasets/${datasetId}/by-digest/sha256/aaa/asset.png`,
    )
  })

  it('falls back to MOCK_R2 host when neither Images nor real R2 endpoint is set', async () => {
    const { sqlite, datasetId } = setupDb()
    const { bucket } = makeBucket()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_R2: bucket,
      MOCK_R2: 'true',
      CATALOG_R2_BUCKET: 'terraviz-assets',
    }
    const fetchStub = vi.fn(async () =>
      new Response(HELLO_BUFFER, { status: 200 }),
    ) as unknown as typeof fetch
    await generateSphereThumbnail(
      env,
      { dataset_id: datasetId, source_ref: `r2:datasets/${datasetId}/asset.png` },
      { fetchImpl: fetchStub },
    )
    const url = (fetchStub as unknown as { mock: { calls: [string][] } }).mock.calls[0][0]
    expect(url).toBe(
      `https://mock-r2.localhost/terraviz-assets/datasets/${datasetId}/asset.png`,
    )
  })

  it('returns null for an unsupported source scheme', async () => {
    const { sqlite, datasetId } = setupDb()
    const { bucket, writes } = makeBucket()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_R2: bucket,
    }
    const fetchStub = vi.fn() as unknown as typeof fetch
    const result = await generateSphereThumbnail(
      env,
      { dataset_id: datasetId, source_ref: 'vimeo:12345' },
      { fetchImpl: fetchStub },
    )
    expect(result).toBeNull()
    expect(writes).toHaveLength(0)
    const row = sqlite
      .prepare(`SELECT sphere_thumbnail_ref FROM datasets WHERE id = ?`)
      .get(datasetId) as { sphere_thumbnail_ref: string | null }
    expect(row.sphere_thumbnail_ref).toBeNull()
  })

  it('returns null for an R2 source when no resize integration AND no fallback is configured', async () => {
    const { sqlite, datasetId } = setupDb()
    const { bucket, writes } = makeBucket()
    // No CF_IMAGES_RESIZE_BASE, no MOCK_R2, no R2_S3_ENDPOINT — nothing to fetch from.
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_R2: bucket }
    const fetchStub = vi.fn() as unknown as typeof fetch
    const result = await generateSphereThumbnail(
      env,
      { dataset_id: datasetId, source_ref: 'r2:datasets/x/asset.png' },
      { fetchImpl: fetchStub },
    )
    expect(result).toBeNull()
    expect(writes).toHaveLength(0)
  })
})

describe('generateSphereThumbnail — error paths', () => {
  it('throws when the source fetch fails', async () => {
    const { sqlite, datasetId } = setupDb()
    const { bucket } = makeBucket()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_R2: bucket,
      STREAM_CUSTOMER_SUBDOMAIN: 'customer-real.cloudflarestream.com',
    }
    const fetchStub = vi.fn(async () =>
      new Response('', { status: 502 }),
    ) as unknown as typeof fetch
    await expect(
      generateSphereThumbnail(
        env,
        { dataset_id: datasetId, source_ref: 'stream:abc' },
        { fetchImpl: fetchStub },
      ),
    ).rejects.toThrow(/sphere thumbnail fetch failed.*502/)
  })

  it('throws when CATALOG_R2 is not bound', async () => {
    const { sqlite, datasetId } = setupDb()
    const env = { CATALOG_DB: asD1(sqlite) }
    await expect(
      generateSphereThumbnail(env, { dataset_id: datasetId, source_ref: 'stream:abc' }),
    ).rejects.toThrow(/CATALOG_R2 binding/)
  })

  it('throws when CATALOG_DB is not bound', async () => {
    const { bucket } = makeBucket()
    const env = { CATALOG_R2: bucket } // no CATALOG_DB
    await expect(
      generateSphereThumbnail(env, { dataset_id: 'DS001', source_ref: 'stream:abc' }),
    ).rejects.toThrow(/CATALOG_DB binding/)
  })

  it('preserves prior auxiliary_digests entries on merge', async () => {
    const { sqlite, datasetId } = setupDb()
    sqlite
      .prepare(`UPDATE datasets SET auxiliary_digests = ? WHERE id = ?`)
      .run(JSON.stringify({ thumbnail: 'sha256:old' }), datasetId)
    const { bucket } = makeBucket()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_R2: bucket,
      STREAM_CUSTOMER_SUBDOMAIN: 'customer-real.cloudflarestream.com',
    }
    const fetchStub = vi.fn(async () =>
      new Response(HELLO_BUFFER, { status: 200 }),
    ) as unknown as typeof fetch
    await generateSphereThumbnail(
      env,
      { dataset_id: datasetId, source_ref: 'stream:abc' },
      { fetchImpl: fetchStub },
    )
    const row = sqlite
      .prepare(`SELECT auxiliary_digests FROM datasets WHERE id = ?`)
      .get(datasetId) as { auxiliary_digests: string }
    const aux = JSON.parse(row.auxiliary_digests) as Record<string, string>
    expect(aux.thumbnail).toBe('sha256:old')
    expect(aux.sphere_thumbnail).toBe(HELLO_DIGEST)
  })
})
