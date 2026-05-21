import { describe, expect, it } from 'vitest'
import { onRequestGet, onRequestHead } from './[frameIndex]'
import { asD1, makeCtx, makeKV, seedFixtures } from '../../../_lib/test-helpers'

const DATASET_ID = 'DS000AAAAAAAAAAAAAAAAAAAAA'
const UPLOAD_ID = '01HYAAAAAAAAAAAAAAAAAAAAAA'
const PUBLIC_BASE = 'https://assets.test'
const VALID_DIGEST = 'sha256:' + 'a'.repeat(64)

function makeBucket(content: string | null): R2Bucket {
  return {
    get: async () => {
      if (!content) return null
      return { text: async () => content } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
}

function buildManifest(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      index: i,
      filename: `original_${i}.png`,
      digest: VALID_DIGEST,
    })),
  )
}

function seedFramesRow(frameCount: number = 5): ReturnType<typeof seedFixtures> {
  const sqlite = seedFixtures({ count: 1 })
  sqlite
    .prepare(
      `UPDATE datasets
          SET frame_count = ?, frame_extension = 'png',
              frame_source_filenames_ref = ?,
              start_time = '2026-05-16T00:00:00.000Z',
              period = 'PT1H',
              source_digest = ?
        WHERE id = ?`,
    )
    .run(
      frameCount,
      `r2:uploads/${DATASET_ID}/${UPLOAD_ID}/source_filenames.json`,
      VALID_DIGEST,
      DATASET_ID,
    )
  return sqlite
}

function envWithFrames(frameCount: number = 5) {
  const sqlite = seedFramesRow(frameCount)
  return {
    CATALOG_DB: asD1(sqlite),
    CATALOG_KV: makeKV(),
    CATALOG_R2: makeBucket(buildManifest(frameCount)),
    R2_PUBLIC_BASE: PUBLIC_BASE,
  }
}

describe('GET /api/v1/datasets/{id}/frames/{frameIndex} (3pg/B)', () => {
  it('returns 302 with the per-frame public URL', async () => {
    const env = envWithFrames(5)
    const res = await onRequestGet(
      makeCtx<'id' | 'frameIndex'>({
        env,
        params: { id: DATASET_ID, frameIndex: '3' },
      }),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(
      `${PUBLIC_BASE}/uploads/${DATASET_ID}/${UPLOAD_ID}/frames/00003.png`,
    )
    // RFC 9530 Content-Digest header — `sha-256=:<base64>:`.
    expect(res.headers.get('Content-Digest')).toMatch(/^sha-256=:[A-Za-z0-9+/=]+:$/)
  })

  it('accepts both padded and unpadded index forms', async () => {
    const env = envWithFrames(5)
    for (const variant of ['3', '03', '00003']) {
      const res = await onRequestGet(
        makeCtx<'id' | 'frameIndex'>({
          env,
          params: { id: DATASET_ID, frameIndex: variant },
        }),
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('Location')).toContain('frames/00003.png')
    }
  })

  it('returns 404 for an out-of-range frame index', async () => {
    const env = envWithFrames(5)
    const res = await onRequestGet(
      makeCtx<'id' | 'frameIndex'>({
        env,
        params: { id: DATASET_ID, frameIndex: '99' },
      }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for a non-integer index', async () => {
    const env = envWithFrames(5)
    const res = await onRequestGet(
      makeCtx<'id' | 'frameIndex'>({
        env,
        params: { id: DATASET_ID, frameIndex: 'banana' },
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects non-canonical numeric forms (3e2, 0x10, 3.0, leading +)', async () => {
    // The route contract says "non-negative base-10 integer".
    // `Number()` would silently accept these forms; the digit-
    // only regex rejects them with the same error code as
    // alpha input. Phase 3pg-review/B — Copilot
    // discussion_r3277221610.
    const env = envWithFrames(5)
    for (const variant of ['3e2', '0x10', '3.0', '+3', '-1', '1_000', ' 3 ']) {
      const res = await onRequestGet(
        makeCtx<'id' | 'frameIndex'>({
          env,
          params: { id: DATASET_ID, frameIndex: variant },
        }),
      )
      expect(res.status, `variant ${JSON.stringify(variant)}`).toBe(400)
    }
  })

  it('HEAD returns 200 with digest + content-type but no body', async () => {
    const env = envWithFrames(5)
    const res = await onRequestHead(
      makeCtx<'id' | 'frameIndex'>({
        env,
        method: 'HEAD',
        params: { id: DATASET_ID, frameIndex: '2' },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Digest')).toMatch(/^sha-256=:[A-Za-z0-9+/=]+:$/)
    expect(res.headers.get('X-Frame-Url')).toContain('frames/00002.png')
    const body = await res.text()
    expect(body).toBe('')
  })

  it('HEAD propagates 404 for a missing dataset', async () => {
    const env = envWithFrames(5)
    const res = await onRequestHead(
      makeCtx<'id' | 'frameIndex'>({
        env,
        method: 'HEAD',
        params: { id: 'NOPE000AAAAAAAAAAAAAAAAAAA', frameIndex: '0' },
      }),
    )
    expect(res.status).toBe(404)
  })
})
