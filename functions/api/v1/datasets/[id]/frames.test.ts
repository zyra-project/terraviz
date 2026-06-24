import { describe, expect, it } from 'vitest'
import { onRequestGet } from './frames'
import { asD1, makeCtx, makeKV, seedFixtures } from '../../_lib/test-helpers'

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

function buildManifest(count: number, digestSeed = 'a'): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      index: i,
      filename: `original_${i}.png`,
      digest: 'sha256:' + digestSeed.repeat(64),
    })),
  )
}

/** Seed a frames-source dataset. Returns the SQLite handle so tests
 *  that need to tweak rows further can do so. The seeded row has
 *  `frame_count`, `frame_extension`, and `frame_source_filenames_ref`
 *  set in lockstep — same shape `clearTranscoding` writes during
 *  real ingest. */
function seedFramesRow(
  opts: {
    frameCount?: number
    startTime?: string | null
    period?: string | null
  } = {},
): ReturnType<typeof seedFixtures> {
  const sqlite = seedFixtures({ count: 1 })
  // `in` checks distinguish "not supplied" (use default) from
  // "explicit null" (clear the column). `??` would conflate the
  // two and tests that want a pure-sequence row couldn't turn
  // off start_time / period.
  const startTime =
    'startTime' in opts ? opts.startTime : '2026-05-16T00:00:00.000Z'
  const period = 'period' in opts ? opts.period : 'PT1H'
  sqlite
    .prepare(
      `UPDATE datasets
          SET frame_count = ?, frame_extension = 'png',
              frame_source_filenames_ref = ?,
              start_time = ?, period = ?, source_digest = ?
        WHERE id = ?`,
    )
    .run(
      opts.frameCount ?? 5,
      `r2:uploads/${DATASET_ID}/${UPLOAD_ID}/source_filenames.json`,
      startTime,
      period,
      VALID_DIGEST,
      DATASET_ID,
    )
  return sqlite
}

interface FramesBody {
  datasetId: string
  count: number
  frames: Array<{
    index: number
    displayName: string
    originalFilename: string
    timestamp: string | null
    contentDigest: string
    url: string
  }>
  cursor: string | null
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/datasets/{id}/frames (3pg/B)', () => {
  it('returns the canonical wire shape for a time-series frames dataset', async () => {
    const sqlite = seedFramesRow({ frameCount: 5 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(5)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const ctx = makeCtx<'id'>({ env, params: { id: DATASET_ID } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<FramesBody>(res)
    expect(body.datasetId).toBe(DATASET_ID)
    expect(body.count).toBe(5)
    expect(body.frames).toHaveLength(5)
    expect(body.frames[0]).toEqual({
      index: 0,
      displayName: 'dataset-0_20260516T000000Z.png',
      originalFilename: 'original_0.png',
      timestamp: '2026-05-16T00:00:00.000Z',
      contentDigest: VALID_DIGEST,
      // Content-addressed: keyed by the frame's digest, no upload_id.
      url: `${PUBLIC_BASE}/videos/${DATASET_ID}/frames/sha256/${'a'.repeat(64)}.png`,
    })
    expect(body.cursor).toBeNull()
  })

  it('paginates via cursor when limit is below the frame count', async () => {
    const sqlite = seedFramesRow({ frameCount: 5 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(5)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const first = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?limit=2`,
      }),
    )
    const firstBody = await readJson<FramesBody>(first)
    expect(firstBody.frames.map(f => f.index)).toEqual([0, 1])
    expect(firstBody.cursor).toBe('2')

    const second = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?limit=2&cursor=2`,
      }),
    )
    const secondBody = await readJson<FramesBody>(second)
    expect(secondBody.frames.map(f => f.index)).toEqual([2, 3])
    expect(secondBody.cursor).toBe('4')

    const third = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?limit=2&cursor=4`,
      }),
    )
    const thirdBody = await readJson<FramesBody>(third)
    expect(thirdBody.frames.map(f => f.index)).toEqual([4])
    expect(thirdBody.cursor).toBeNull()
  })

  it('filters by ?at returning a single closest-frame', async () => {
    const sqlite = seedFramesRow({ frameCount: 10 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(10)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?at=2026-05-16T03:30:00Z`,
      }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<FramesBody>(res)
    expect(body.frames).toHaveLength(1)
    // 03:30 is equidistant between frames 3 and 4 — JavaScript
    // `Math.round` rounds half toward positive infinity (3.5 → 4),
    // so the equidistant case is deterministic, not browser-
    // dependent. (It is NOT round-half-to-even.)
    expect(body.frames[0].index).toBe(4)
  })

  it('filters by ?from / ?to returning the inclusive window', async () => {
    const sqlite = seedFramesRow({ frameCount: 24 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(24)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        url:
          `https://test.local/api/v1/datasets/${DATASET_ID}/frames` +
          `?from=2026-05-16T03:00:00Z&to=2026-05-16T05:00:00Z`,
      }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<FramesBody>(res)
    expect(body.frames.map(f => f.index)).toEqual([3, 4, 5])
  })

  it('returns an empty frames array (200) when ?from / ?to fall entirely outside the series', async () => {
    // Distinguish from "not a time series" (which 400s). Phase
    // 3pg/A review — Copilot discussion_r3277040920. The
    // pre-fix path called `findFrameWindow` and surfaced the
    // null return as `not_a_time_series` for both cases; this
    // test pins the post-fix behaviour for out-of-range windows
    // on a parseable time-series row.
    const sqlite = seedFramesRow({ frameCount: 24 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(24)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        // Series starts 2026-05-16; this window is in 2025.
        url:
          `https://test.local/api/v1/datasets/${DATASET_ID}/frames` +
          `?from=2025-01-01T00:00:00Z&to=2025-01-02T00:00:00Z`,
      }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<FramesBody>(res)
    expect(body.frames).toEqual([])
    expect(body.count).toBe(24)
    expect(body.cursor).toBeNull()
  })

  it('returns 400 invalid_range when only ?from or only ?to is supplied', async () => {
    const sqlite = seedFramesRow()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(5)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?from=2026-05-16T00:00:00Z`,
      }),
    )
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_range')
  })

  it('returns 400 not_a_time_series when ?at is set on a pure-sequence row', async () => {
    const sqlite = seedFramesRow({ startTime: null, period: null })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(5)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?at=2026-05-16T00:00:00Z`,
      }),
    )
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('not_a_time_series')
  })

  it('returns 404 not_a_frame_sequence when the dataset has no frames', async () => {
    const sqlite = seedFixtures({ count: 1 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(null),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(makeCtx<'id'>({ env, params: { id: DATASET_ID } }))
    expect(res.status).toBe(404)
    expect((await readJson<{ error: string }>(res)).error).toBe('not_a_frame_sequence')
  })

  it('returns 404 not_found for an unknown dataset', async () => {
    const sqlite = seedFixtures({ count: 1 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(null),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(
      makeCtx<'id'>({ env, params: { id: 'NOPE000AAAAAAAAAAAAAAAAAAA' } }),
    )
    expect(res.status).toBe(404)
    expect((await readJson<{ error: string }>(res)).error).toBe('not_found')
  })

  it('returns 503 when CATALOG_R2 is unbound', async () => {
    const sqlite = seedFramesRow()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(makeCtx<'id'>({ env, params: { id: DATASET_ID } }))
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('binding_missing')
  })

  it('returns 503 when R2_PUBLIC_BASE is unbound', async () => {
    const sqlite = seedFramesRow()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(5)),
    }
    const res = await onRequestGet(makeCtx<'id'>({ env, params: { id: DATASET_ID } }))
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('r2_unconfigured')
  })

  it('returns 500 invalid_frame_metadata when env is OK but the row is malformed', async () => {
    // Split the failure modes so the operator sees the actual cause
    // (row data vs deployment misconfig). With content-addressed
    // frames the per-frame URL is built from the manifest digest +
    // `frame_extension`; force a malformed extension (passes the
    // non-null row gate but `buildContentAddressedFrameKey` rejects
    // it) so the URL can't be built even though R2_PUBLIC_BASE is set.
    const sqlite = seedFramesRow()
    sqlite
      .prepare(`UPDATE datasets SET frame_extension = 'PNG' WHERE id = ?`)
      .run(DATASET_ID)
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(5)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(makeCtx<'id'>({ env, params: { id: DATASET_ID } }))
    expect(res.status).toBe(500)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_frame_metadata')
  })

  it('returns 503 when the manifest blob is missing', async () => {
    const sqlite = seedFramesRow()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(null),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(makeCtx<'id'>({ env, params: { id: DATASET_ID } }))
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('frame_manifest_missing')
  })

  it('returns 503 when the manifest length disagrees with frame_count', async () => {
    const sqlite = seedFramesRow({ frameCount: 5 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(4)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(makeCtx<'id'>({ env, params: { id: DATASET_ID } }))
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('frame_manifest_inconsistent')
  })

  it('rejects bad ?limit / ?cursor', async () => {
    const sqlite = seedFramesRow()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(5)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    let res = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?limit=0`,
      }),
    )
    expect(res.status).toBe(400)
    res = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?cursor=-1`,
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects non-canonical numeric forms in ?limit / ?cursor (3pg-review/E)', async () => {
    // Mirrors the strict frameIndex policy — `Number()` would
    // silently coerce these. Copilot discussion_r3282216200 /
    // _r3282216289.
    const sqlite = seedFramesRow()
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(5)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    for (const bad of ['1e2', '10.0', '0x10', '+5', ' 3 ']) {
      const limitRes = await onRequestGet(
        makeCtx<'id'>({
          env,
          params: { id: DATASET_ID },
          url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?limit=${encodeURIComponent(bad)}`,
        }),
      )
      expect(limitRes.status, `limit=${JSON.stringify(bad)}`).toBe(400)
      const cursorRes = await onRequestGet(
        makeCtx<'id'>({
          env,
          params: { id: DATASET_ID },
          url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?cursor=${encodeURIComponent(bad)}`,
        }),
      )
      expect(cursorRes.status, `cursor=${JSON.stringify(bad)}`).toBe(400)
    }
    // Empty cursor specifically — `?cursor=` is a string the
    // URL parser surfaces as the empty string, not null.
    const emptyCursor = await onRequestGet(
      makeCtx<'id'>({
        env,
        params: { id: DATASET_ID },
        url: `https://test.local/api/v1/datasets/${DATASET_ID}/frames?cursor=`,
      }),
    )
    expect(emptyCursor.status).toBe(400)
  })

  it('renders pure-sequence display names when period is null', async () => {
    const sqlite = seedFramesRow({ frameCount: 3, startTime: null, period: null })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(buildManifest(3)),
      R2_PUBLIC_BASE: PUBLIC_BASE,
    }
    const res = await onRequestGet(makeCtx<'id'>({ env, params: { id: DATASET_ID } }))
    const body = await readJson<FramesBody>(res)
    expect(body.frames[0].displayName).toBe('dataset-0_frame_00000.png')
    expect(body.frames[0].timestamp).toBeNull()
  })
})
