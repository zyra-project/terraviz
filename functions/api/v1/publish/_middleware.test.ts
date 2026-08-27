// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
 *   - Dev-bypass on loopback mints an admin/active publisher and
 *     calls next().
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { featureForPath, onRequest } from './_middleware'
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

  it('mints an admin publisher and calls next() under dev bypass on localhost', async () => {
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
    expect(row).toMatchObject({ role: 'admin', is_admin: 1, status: 'active' })

    interface PublisherCtxData {
      publisher?: { email?: string; role?: string }
    }
    const data = ctx.data as PublisherCtxData
    expect(data.publisher?.email).toBe('me@localhost')
    expect(data.publisher?.role).toBe('admin')
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
      .run('PUB001', 'pending@example.com', 'pending', 'publisher', 0, 'pending', '2026-01-01T00:00:00.000Z')
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
      .run('PUB002', 'banned@example.com', 'banned', 'publisher', 0, 'suspended', '2026-01-01T00:00:00.000Z')
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

  it('catches an unhandled downstream exception and returns 500 unhandled_exception', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      DEV_BYPASS_ACCESS: 'true',
      DEV_PUBLISHER_EMAIL: 'me@localhost',
    }
    // Replace `next` with one that throws — simulates a downstream
    // route handler erroring out (the original 3pc/B-fix2 scenario).
    const next = {
      fn: vi.fn(async () => {
        throw new Error('D1_ERROR: table datasets has no column named bbox_n: SQLITE_ERROR')
      }),
      response: new Response(),
    }
    const consoleSpy = console.error
    console.error = () => {}
    try {
      const res = await onRequest(
        ctxWithNext({ env, url: 'http://localhost:8788/api/v1/publish/me' }, next),
      )
      expect(res.status).toBe(500)
      const body = await readJson<{ error: string; message: string }>(res)
      expect(body.error).toBe('unhandled_exception')
      expect(body.message).toContain('D1_ERROR')
      expect(body.message).toContain('bbox_n')
    } finally {
      console.error = consoleSpy
    }
  })

  it('strips stack-frame fragments from the surfaced error message', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const env = {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      DEV_BYPASS_ACCESS: 'true',
      DEV_PUBLISHER_EMAIL: 'me@localhost',
    }
    // Synthesise a multi-line `.message` whose body looks like a
    // Node-style stack trace. The sanitizer must keep the first
    // line (the human-readable cause) and drop the rest.
    const fakeError = new Error(
      'Boom\n    at handler (file:///worker/index.js:42:13)\n    at next (file:///worker/middleware.js:7:5)',
    )
    const next = {
      fn: vi.fn(async () => {
        throw fakeError
      }),
      response: new Response(),
    }
    const consoleSpy = console.error
    console.error = () => {}
    try {
      const res = await onRequest(
        ctxWithNext({ env, url: 'http://localhost:8788/api/v1/publish/me' }, next),
      )
      const body = await readJson<{ message: string }>(res)
      expect(body.message).toBe('Boom')
      expect(body.message).not.toMatch(/\bat\b/)
      expect(body.message).not.toMatch(/file:\/\//)
    } finally {
      console.error = consoleSpy
    }
  })
})

describe('featureForPath', () => {
  it('maps each gated prefix to its feature', () => {
    expect(featureForPath('/api/v1/publish/events')).toBe('events')
    expect(featureForPath('/api/v1/publish/events/EV1/tour')).toBe('events')
    expect(featureForPath('/api/v1/publish/feeds/F1')).toBe('events')
    expect(featureForPath('/api/v1/publish/media/youtube-search')).toBe('events')
    expect(featureForPath('/api/v1/publish/blog/generate')).toBe('blog')
    expect(featureForPath('/api/v1/publish/featured-hero')).toBe('hero')
    expect(featureForPath('/api/v1/publish/tours/T1/publish')).toBe('tours')
    expect(featureForPath('/api/v1/publish/workflows/W1/run')).toBe('workflows')
    expect(featureForPath('/api/v1/publish/analytics')).toBe('analytics')
    expect(featureForPath('/api/v1/publish/datasets/DS1/publish')).toBe('datasets')
    expect(featureForPath('/api/v1/publish/featured')).toBe('datasets')
    expect(featureForPath('/api/v1/publish/featured/DS1')).toBe('datasets')
    expect(featureForPath('/api/v1/publish/feedback')).toBe('feedback')
  })

  it('matches on segment boundaries: featured-hero is hero, not datasets', () => {
    expect(featureForPath('/api/v1/publish/featured-hero')).toBe('hero')
    // And analytics-export is not swallowed by the analytics prefix.
    expect(featureForPath('/api/v1/publish/analytics-export')).toBeNull()
  })

  it('exempts the cron-invoked paths', () => {
    expect(featureForPath('/api/v1/publish/events/refresh')).toBeNull()
    expect(featureForPath('/api/v1/publish/workflows/due')).toBeNull()
  })

  it('never gates the identity/settings surfaces', () => {
    for (const path of [
      '/api/v1/publish/me',
      '/api/v1/publish/node-profile',
      '/api/v1/publish/node-profile/logo',
      '/api/v1/publish/node-settings',
      '/api/v1/publish/node-identity',
      '/api/v1/publish/publishers',
      '/api/v1/publish/publishers/PUB1',
      '/api/v1/publish/redirect-back',
    ]) {
      expect(featureForPath(path)).toBeNull()
    }
  })
})

describe('publish/_middleware feature gate', () => {
  function setupGateEnv(featuresJson: string | null) {
    const sqlite = seedFixtures({ count: 0 })
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES ('PUB-ADM', 'me@localhost', 'Me', 'admin', 1, 'active', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    if (featuresJson != null) {
      sqlite
        .prepare(
          `INSERT INTO node_settings (id, features_json, updated_by, updated_at)
           VALUES (1, ?, 'PUB-ADM', '2026-06-01T00:00:00.000Z')`,
        )
        .run(featuresJson)
    }
    return {
      sqlite,
      env: {
        CATALOG_DB: asD1(sqlite),
        CATALOG_KV: makeKV(),
        DEV_BYPASS_ACCESS: 'true',
        DEV_PUBLISHER_EMAIL: 'me@localhost',
      },
    }
  }

  it('returns 403 feature_disabled for a route of a disabled feature', async () => {
    const { env } = setupGateEnv(JSON.stringify({ blog: false }))
    const next = stubNext()
    const res = await onRequest(
      ctxWithNext({ env, url: 'http://localhost:8788/api/v1/publish/blog' }, next),
    )
    expect(res.status).toBe(403)
    const body = await readJson<{ error: string; feature: string }>(res)
    expect(body.error).toBe('feature_disabled')
    expect(body.feature).toBe('blog')
    expect(next.fn).not.toHaveBeenCalled()
  })

  it('serves a route whose feature is enabled and ungated routes', async () => {
    const { env } = setupGateEnv(JSON.stringify({ blog: false }))
    for (const url of [
      'http://localhost:8788/api/v1/publish/events', // enabled feature
      'http://localhost:8788/api/v1/publish/me', // never gated
    ]) {
      const next = stubNext('downstream')
      const res = await onRequest(ctxWithNext({ env, url }, next))
      expect(res.status).toBe(200)
      expect(next.fn).toHaveBeenCalledTimes(1)
    }
  })

  it('lets the cron-exempt refresh path through even when events is off', async () => {
    const { env } = setupGateEnv(JSON.stringify({ events: false }))
    const next = stubNext('downstream')
    const res = await onRequest(
      ctxWithNext({ env, url: 'http://localhost:8788/api/v1/publish/events/refresh' }, next),
    )
    expect(res.status).toBe(200)
    expect(next.fn).toHaveBeenCalledTimes(1)
  })

  it('fails open when the node_settings table is missing', async () => {
    const { env, sqlite } = setupGateEnv(null)
    sqlite.prepare('DROP TABLE node_settings').run()
    const next = stubNext('downstream')
    const res = await onRequest(
      ctxWithNext({ env, url: 'http://localhost:8788/api/v1/publish/blog' }, next),
    )
    expect(res.status).toBe(200)
    expect(next.fn).toHaveBeenCalledTimes(1)
  })
})
