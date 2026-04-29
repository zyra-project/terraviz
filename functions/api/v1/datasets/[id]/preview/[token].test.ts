/**
 * Tests for the anonymous preview consumer.
 *
 * Coverage:
 *   - 503 when CATALOG_DB is missing.
 *   - 401 invalid_token on a malformed or wrong-signed token.
 *   - 401 token_id_mismatch when the URL id doesn't match the
 *     token's claim.
 *   - 200 with the dataset row when a valid token is presented.
 *   - 404 when the row vanished after the token was minted.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet } from './[token]'
import { issuePreviewToken } from '../../../_lib/preview-token'
import { asD1, makeCtx, makeKV, seedFixtures } from '../../../_lib/test-helpers'

const SECRET = 'test-preview-secret'
const ID = 'DS000AAAAAAAAAAAAAAAAAAAAA'

function setupEnv() {
  const sqlite = seedFixtures({ count: 1 })
  return {
    sqlite,
    env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV(), PREVIEW_SIGNING_KEY: SECRET },
  }
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/datasets/{id}/preview/{token}', () => {
  it('returns 503 when CATALOG_DB is missing', async () => {
    const ctx = makeCtx<'id' | 'token'>({ env: {}, params: { id: ID, token: 'x.y' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
  })

  it('returns 503 preview_unconfigured when PREVIEW_SIGNING_KEY is missing', async () => {
    // The fail-closed contract from preview-token.ts: a production
    // deploy without PREVIEW_SIGNING_KEY refuses to verify any token
    // rather than falling back to a guessable dev secret.
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
  })

  it('returns 401 token_id_mismatch when the path id and token id differ', async () => {
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

  it('returns the dataset row for a matching token', async () => {
    const { env } = setupEnv()
    const token = await issuePreviewToken(SECRET, {
      kind: 'dataset',
      id: ID,
      publisher_id: 'PUB1',
    })
    const ctx = makeCtx<'id' | 'token'>({ env, params: { id: ID, token } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(200)
    const body = await readJson<{ dataset: { id: string; title: string } }>(res)
    expect(body.dataset.id).toBe(ID)
    expect(body.dataset.title).toBe('Test Dataset 0')
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
})
