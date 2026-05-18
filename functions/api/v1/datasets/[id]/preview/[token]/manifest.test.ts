/**
 * Tests for the token-gated preview manifest endpoint.
 *
 * Coverage mirrors `[token].test.ts` for the auth envelope (missing
 * binding, missing key, malformed / mismatched token) plus a smoke
 * test that the resolver runs against the unfiltered draft row
 * (the public manifest endpoint refuses unpublished rows by
 * design; this one must not).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet } from './manifest'
import { issuePreviewToken } from '../../../../_lib/preview-token'
import {
  asD1,
  makeCtx,
  makeKV,
  seedFixtures,
} from '../../../../_lib/test-helpers'

const SECRET = 'test-preview-secret'
const ID = 'DS000AAAAAAAAAAAAAAAAAAAAA'
const VIDEO_PROXY_BASE = 'https://video-proxy.test/video'

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

function setupEnv(extra: Record<string, unknown> = {}) {
  const sqlite = seedFixtures({ count: 1 })
  // Drop the published_at stamp so the row is a draft. The public
  // manifest endpoint would 404 on this row; the preview manifest
  // endpoint must return 200.
  sqlite.prepare('UPDATE datasets SET published_at = NULL WHERE id = ?').run(ID)
  return {
    sqlite,
    env: {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      PREVIEW_SIGNING_KEY: SECRET,
      ...extra,
    },
  }
}

describe('GET /api/v1/datasets/{id}/preview/{token}/manifest', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 503 when CATALOG_DB is missing', async () => {
    const ctx = makeCtx<'id' | 'token'>({ env: {}, params: { id: ID, token: 'x.y' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('binding_missing')
  })

  it('returns 503 preview_unconfigured when PREVIEW_SIGNING_KEY is missing', async () => {
    const sqlite = seedFixtures({ count: 1 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx<'id' | 'token'>({
      env,
      params: { id: ID, token: 'irrelevant.value' },
    })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('preview_unconfigured')
  })

  it('returns 401 for a malformed token', async () => {
    const { env } = setupEnv()
    const ctx = makeCtx<'id' | 'token'>({ env, params: { id: ID, token: 'not-a-token' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(401)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_token')
    // Errors must be non-cacheable so a token issued seconds after
    // an earlier 401 doesn't get masked by an intermediary cache.
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('returns 401 token_id_mismatch when path id and token id differ', async () => {
    const { env } = setupEnv()
    const token = await issuePreviewToken(SECRET, {
      kind: 'dataset',
      id: 'DSOTHER',
      publisher_id: 'PUB1',
    })
    const ctx = makeCtx<'id' | 'token'>({ env, params: { id: ID, token } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(401)
    expect((await readJson<{ error: string }>(res)).error).toBe('token_id_mismatch')
  })

  it('returns 404 when the row was deleted after the token was minted', async () => {
    const { env, sqlite } = setupEnv()
    const token = await issuePreviewToken(SECRET, {
      kind: 'dataset',
      id: ID,
      publisher_id: 'PUB1',
    })
    sqlite.prepare('DELETE FROM datasets WHERE id = ?').run(ID)
    const ctx = makeCtx<'id' | 'token'>({ env, params: { id: ID, token } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(404)
  })

  it('resolves a draft (unpublished) row that the public endpoint would refuse', async () => {
    const { env } = setupEnv({ VIDEO_PROXY_BASE })
    const token = await issuePreviewToken(SECRET, {
      kind: 'dataset',
      id: ID,
      publisher_id: 'PUB1',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: '100',
            title: 'Draft Title',
            duration: 12,
            hls: 'https://cdn.test/hls.m3u8',
            files: [
              { quality: '720p', size: 42, type: 'video/mp4', link: 'https://cdn.test/720.mp4' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const ctx = makeCtx<'id' | 'token'>({ env, params: { id: ID, token } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('private')
    expect(res.headers.get('cache-control')).toContain('no-store')
    const body = await readJson<{ kind: string; hls: string }>(res)
    expect(body.kind).toBe('video')
    expect(body.hls).toBe('https://cdn.test/hls.m3u8')
  })

  it('surfaces resolver errors with their typed envelope', async () => {
    const { sqlite, env } = setupEnv()
    // Mutate the row to a format/scheme mismatch — same case the
    // public manifest test covers, just reached via the token path.
    sqlite.prepare(`UPDATE datasets SET format = 'image/png' WHERE id = ?`).run(ID)
    const token = await issuePreviewToken(SECRET, {
      kind: 'dataset',
      id: ID,
      publisher_id: 'PUB1',
    })
    const ctx = makeCtx<'id' | 'token'>({ env, params: { id: ID, token } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('data_ref_format_mismatch')
  })
})
