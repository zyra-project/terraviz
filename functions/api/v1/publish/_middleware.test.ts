/**
 * Tests for the publisher-API auth middleware.
 *
 * The middleware is a single Pages Function that wraps every route
 * in `functions/api/v1/publish/`. We exercise it directly by
 * invoking `onRequest(context)` with a stubbed `next()` so the test
 * doesn't require a downstream handler.
 *
 * Coverage:
 *   - 503 binding_missing.
 *   - 503 access_unconfigured (no Access env, no dev bypass).
 *   - 500 dev_bypass_unsafe (DEV_BYPASS_ACCESS=true on a non-loopback
 *     hostname).
 *   - 401 on missing assertion / invalid JWT.
 *   - 403 pending / suspended.
 *   - Calls next() with `context.data.publisher` populated for an
 *     active publisher.
 *   - Dev-bypass on loopback mints a staff/active publisher and
 *     calls next().
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequest } from './_middleware'
import { asD1, makeCtx, makeKV, seedFixtures } from '../_lib/test-helpers'

interface NextStub {
  fn: ReturnType<typeof vi.fn>
  response: Response
}

function stubNext(body = 'next-called'): NextStub {
  const response = new Response(body, { status: 200 })
  const fn = vi.fn(async () => response.clone())
  return { fn, response }
}

interface MakeCtxOpts {
  env: Record<string, unknown>
  url?: string
  headers?: Record<string, string>
}

function ctxWithNext(opts: MakeCtxOpts, next: NextStub) {
  const base = makeCtx({
    env: opts.env,
    url: opts.url ?? 'https://localhost/api/v1/publish/me',
    headers: opts.headers,
  })
  return Object.assign(base, { next: next.fn })
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('publish/_middleware', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 503 binding_missing when CATALOG_DB is not bound', async () => {
    const next = stubNext()
    const ctx = ctxWithNext({ env: {} }, next)
    const res = await onRequest(ctx)
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('binding_missing')
    expect(next.fn).not.toHaveBeenCalled()
  })

  it('returns 503 access_unconfigured when neither Access env nor dev bypass is set', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const next = stubNext()
    const res = await onRequest(ctxWithNext({ env }, next))
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('access_unconfigured')
    expect(next.fn).not.toHaveBeenCalled()
  })

  it('returns 500 dev_bypass_unsafe against a non-loopback hostname', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      DEV_BYPASS_ACCESS: 'true',
    }
    const next = stubNext()
    const res = await onRequest(
      ctxWithNext(
        { env, url: 'https://catalog.example.com/api/v1/publish/me' },
        next,
      ),
    )
    expect(res.status).toBe(500)
    expect((await readJson<{ error: string }>(res)).error).toBe('dev_bypass_unsafe')
    expect(next.fn).not.toHaveBeenCalled()
  })

  it('mints a staff publisher and calls next() under dev bypass on localhost', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      DEV_BYPASS_ACCESS: 'true',
      DEV_PUBLISHER_EMAIL: 'me@localhost',
    }
    const next = stubNext('downstream')
    const ctx = ctxWithNext({ env, url: 'http://localhost:8788/api/v1/publish/me' }, next)
    const res = await onRequest(ctx)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('downstream')
    expect(next.fn).toHaveBeenCalledTimes(1)

    // The publisher row was JIT-provisioned and stashed for handlers.
    const row = sqlite
      .prepare(`SELECT email, role, is_admin, status FROM publishers WHERE email = 'me@localhost'`)
      .get() as { email: string; role: string; is_admin: number; status: string }
    expect(row).toMatchObject({ role: 'staff', is_admin: 1, status: 'active' })

    interface PublisherCtxData {
      publisher?: { email?: string; role?: string }
    }
    const data = ctx.data as PublisherCtxData
    expect(data.publisher?.email).toBe('me@localhost')
    expect(data.publisher?.role).toBe('staff')
  })

  it('returns 401 unauthenticated when the assertion header is missing', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      ACCESS_TEAM_DOMAIN: 'team.cf.test',
      ACCESS_AUD: 'AUD-1',
    }
    const next = stubNext()
    const res = await onRequest(ctxWithNext({ env }, next))
    expect(res.status).toBe(401)
    expect((await readJson<{ error: string }>(res)).error).toBe('unauthenticated')
    expect(next.fn).not.toHaveBeenCalled()
  })

  it('returns 401 when the JWT verifier rejects the assertion', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      ACCESS_TEAM_DOMAIN: 'team.cf.test',
      ACCESS_AUD: 'AUD-1',
    }
    // Stub fetch so the JWKS endpoint returns 500 — verifier returns null.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const next = stubNext()
    const ctx = ctxWithNext(
      { env, headers: { 'Cf-Access-Jwt-Assertion': 'bogus.jwt.value' } },
      next,
    )
    const res = await onRequest(ctx)
    expect(res.status).toBe(401)
    expect(next.fn).not.toHaveBeenCalled()
  })

  it('returns 403 pending for a publisher row in the pending state', async () => {
    const sqlite = seedFixtures({ count: 0 })
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('PUB001', 'pending@example.com', 'pending', 'community', 0, 'pending', '2026-01-01T00:00:00.000Z')
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      DEV_BYPASS_ACCESS: 'true',
      DEV_PUBLISHER_EMAIL: 'pending@example.com',
    }
    const next = stubNext()
    const res = await onRequest(
      ctxWithNext({ env, url: 'http://localhost:8788/api/v1/publish/me' }, next),
    )
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe('pending')
    expect(next.fn).not.toHaveBeenCalled()
  })

  it('returns 403 suspended for a publisher row in the suspended state', async () => {
    const sqlite = seedFixtures({ count: 0 })
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('PUB002', 'banned@example.com', 'banned', 'community', 0, 'suspended', '2026-01-01T00:00:00.000Z')
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      DEV_BYPASS_ACCESS: 'true',
      DEV_PUBLISHER_EMAIL: 'banned@example.com',
    }
    const next = stubNext()
    const res = await onRequest(
      ctxWithNext({ env, url: 'http://localhost:8788/api/v1/publish/me' }, next),
    )
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe('suspended')
    expect(next.fn).not.toHaveBeenCalled()
  })
})
