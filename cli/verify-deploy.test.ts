// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Coverage for `terraviz verify-deploy`.
 *
 * Each check in `lib/verify-checks.ts` is exercised independently
 * against a stubbed fetch; the runner is exercised against the
 * full check list with synthesised pass / fail / skip mixes.
 */

import { describe, expect, it } from 'vitest'
import {
  formatCheckTable,
  runChecks,
  VERIFY_CHECKS,
  type CheckDeps,
  type VerifyCheck,
} from './lib/verify-checks'
import { runVerifyDeploy } from './verify-deploy'
import type { CommandContext } from './commands'
import type { TerravizClient } from './lib/client'

function mkResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

function makeRouter(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const [pattern, factory] of Object.entries(routes)) {
      if (url.includes(pattern)) return factory()
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

function findCheck(name: string): VerifyCheck {
  const c = VERIFY_CHECKS.find(x => x.name === name)
  if (!c) throw new Error(`No check named ${name}`)
  return c
}

const baseDeps: CheckDeps = {
  serverUrl: 'https://example.test',
  authHeaders: { 'Cf-Access-Client-Id': 'cid', 'Cf-Access-Client-Secret': 'sec' },
  hasServiceToken: true,
  fetchImpl: (() => Promise.resolve(new Response('{}'))) as typeof fetch,
}

describe('node-identity check', () => {
  it('passes when /.well-known/terraviz.json carries node_id + ed25519 public_key', async () => {
    const fetchImpl = makeRouter({
      '/.well-known/terraviz.json': () =>
        mkResponse(200, { node_id: 'NODE-X', public_key: 'ed25519:AAAA' }),
    })
    const out = await findCheck('node-identity').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('pass')
    expect(out.detail).toMatch(/NODE-X/)
  })

  it('fails when node_id is missing', async () => {
    const fetchImpl = makeRouter({
      '/.well-known/terraviz.json': () => mkResponse(200, { public_key: 'ed25519:AAAA' }),
    })
    const out = await findCheck('node-identity').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('fail')
    // Must name a command that provisions the row on a *deployed*
    // node. `gen:node-key` only writes local files and the local D1,
    // so the previous hint left the operator stuck.
    expect(out.detail).toMatch(/init-node/)
    expect(out.detail).not.toMatch(/gen:node-key/)
  })

  it('fails on non-200', async () => {
    const fetchImpl = makeRouter({
      '/.well-known/terraviz.json': () => mkResponse(500, 'oops'),
    })
    const out = await findCheck('node-identity').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('fail')
    expect(out.detail).toMatch(/500/)
  })
})

describe('catalog-reachable / catalog-populated checks', () => {
  it('reachable passes on 200 + datasets[]', async () => {
    const fetchImpl = makeRouter({
      '/api/v1/catalog': () => mkResponse(200, { datasets: [] }),
    })
    const out = await findCheck('catalog-reachable').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('pass')
    expect(out.detail).toMatch(/0 datasets/)
  })

  it('populated fails when datasets is empty', async () => {
    const fetchImpl = makeRouter({
      '/api/v1/catalog': () => mkResponse(200, { datasets: [] }),
    })
    const out = await findCheck('catalog-populated').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('fail')
    expect(out.detail).toMatch(/import-snapshot/)
  })

  it('populated passes with at least one row', async () => {
    const fetchImpl = makeRouter({
      '/api/v1/catalog': () =>
        mkResponse(200, { datasets: [{ id: 'X' }, { id: 'Y' }] }),
    })
    const out = await findCheck('catalog-populated').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('pass')
    expect(out.detail).toMatch(/2 datasets/)
  })

  it('reachable fails on non-200 with a migrations hint', async () => {
    const fetchImpl = makeRouter({
      '/api/v1/catalog': () => mkResponse(503, 'unavailable'),
    })
    const out = await findCheck('catalog-reachable').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('fail')
    expect(out.detail).toMatch(/migrations/)
  })
})

describe('search-reachable check', () => {
  it('passes on 200 + datasets[] (the real wire contract — see functions/api/v1/search.ts)', async () => {
    // Phase 1f follow-up: the route returns `{datasets: [...]}`,
    // never `{hits: [...]}`. Pre-1f/M the stub used `hits` and
    // the check expected `hits`, so the test was internally
    // consistent but blessed the wrong shape — the real route
    // would have failed every healthy deployment.
    const fetchImpl = makeRouter({
      '/api/v1/search': () => mkResponse(200, { datasets: [{ id: 'X' }] }),
    })
    const out = await findCheck('search-reachable').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('pass')
    expect(out.detail).toMatch(/1 hit/)
  })

  it('fails on 200 + degraded=unconfigured with the bindings hint', async () => {
    // Real route signals "bindings missing" via 200 + body.degraded
    // + Warning header — never a 5xx. Pre-1f/M this test stubbed a
    // 503 response which the route never actually emits.
    const fetchImpl = makeRouter({
      '/api/v1/search': () => mkResponse(200, { datasets: [], degraded: 'unconfigured' }),
    })
    const out = await findCheck('search-reachable').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('fail')
    expect(out.detail).toMatch(/Workers AI/)
  })

  it('fails on 200 + degraded=quota_exhausted with the quota hint', async () => {
    const fetchImpl = makeRouter({
      '/api/v1/search': () => mkResponse(200, { datasets: [], degraded: 'quota_exhausted' }),
    })
    const out = await findCheck('search-reachable').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('fail')
    expect(out.detail).toMatch(/quota exhausted/i)
  })

  it('fails on a non-200 status (route itself is sick)', async () => {
    const fetchImpl = makeRouter({
      '/api/v1/search': () => mkResponse(500, 'oops'),
    })
    const out = await findCheck('search-reachable').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('fail')
    expect(out.detail).toMatch(/500/)
  })
})

describe('access-me check', () => {
  it('passes when /api/v1/publish/me returns the publisher row', async () => {
    const fetchImpl = makeRouter({
      '/api/v1/publish/me': () =>
        mkResponse(200, { email: 'svc@example.com', role: 'service' }),
    })
    const out = await findCheck('access-me').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('pass')
    expect(out.detail).toMatch(/svc@example.com.*service/)
  })

  it('fails on 401 with a token-rejected detail', async () => {
    const fetchImpl = makeRouter({
      '/api/v1/publish/me': () =>
        mkResponse(401, { error: 'unauthenticated', message: 'Invalid Access assertion.' }),
    })
    const out = await findCheck('access-me').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('fail')
    expect(out.detail).toMatch(/Access rejected/)
  })

  it('fails on 503 access_unconfigured with a Step 4 hint', async () => {
    const fetchImpl = makeRouter({
      '/api/v1/publish/me': () =>
        mkResponse(503, { error: 'access_unconfigured', message: 'No team domain.' }),
    })
    const out = await findCheck('access-me').run({ ...baseDeps, fetchImpl })
    expect(out.status).toBe('fail')
    expect(out.detail).toMatch(/ACCESS_TEAM_DOMAIN/)
  })
})

// ── runner-level tests ──────────────────────────────────────────

describe('runChecks', () => {
  it('skips service-token checks when no token is configured', async () => {
    const fetchImpl = makeRouter({
      '/.well-known/terraviz.json': () =>
        mkResponse(200, { node_id: 'X', public_key: 'ed25519:AA' }),
      '/api/v1/catalog': () => mkResponse(200, { datasets: [{ id: 'X' }] }),
      '/api/v1/search': () => mkResponse(200, { datasets: [] }),
    })
    const rows = await runChecks(VERIFY_CHECKS, {
      serverUrl: 'https://example.test',
      authHeaders: {},
      hasServiceToken: false,
      fetchImpl,
    })
    const skips = rows.filter(r => r.status === 'skip')
    // The two `requires: 'service-token'` checks land here.
    expect(skips.map(r => r.name).sort()).toEqual(['access-me', 'publisher-list'])
    for (const s of skips) {
      expect(s.detail).toMatch(/no service token/)
    }
  })

  it('forces SKIP for publisher checks when --skip-publish-checks is set', async () => {
    const fetchImpl = makeRouter({
      '/.well-known/terraviz.json': () =>
        mkResponse(200, { node_id: 'X', public_key: 'ed25519:AA' }),
      '/api/v1/catalog': () => mkResponse(200, { datasets: [{ id: 'X' }] }),
      '/api/v1/search': () => mkResponse(200, { datasets: [] }),
      '/api/v1/publish/me': () =>
        mkResponse(200, { email: 'a@b', role: 'service' }),
      '/api/v1/publish/datasets': () => mkResponse(200, { datasets: [] }),
    })
    const rows = await runChecks(
      VERIFY_CHECKS,
      {
        serverUrl: 'https://example.test',
        authHeaders: { 'Cf-Access-Client-Id': 'a', 'Cf-Access-Client-Secret': 'b' },
        hasServiceToken: true,
        fetchImpl,
      },
      { skipPublishChecks: true },
    )
    const skips = rows.filter(r => r.status === 'skip')
    expect(skips.map(r => r.name).sort()).toEqual(['access-me', 'publisher-list'])
    for (const s of skips) {
      expect(s.detail).toMatch(/--skip-publish-checks/)
    }
  })
})

describe('formatCheckTable', () => {
  it('emits an aligned table with status glyphs', () => {
    const rows = [
      { name: 'a', description: 'A', status: 'pass' as const, detail: 'ok' },
      { name: 'bbb', description: 'BBB', status: 'fail' as const, detail: 'nope' },
      { name: 'cc', description: 'CC', status: 'skip' as const, detail: 's' },
    ]
    const out = formatCheckTable(rows)
    expect(out).toMatch(/\bOK\b.*a\s+A\s+ok/)
    expect(out).toMatch(/FAIL\s+bbb\s+BBB\s+nope/)
    expect(out).toMatch(/SKIP\s+cc\s+CC\s+s/)
  })
})

describe('runVerifyDeploy', () => {
  function mkCtx(
    options: Record<string, string | boolean> = {},
  ): CommandContext & { stdoutBuf: () => string; stderrBuf: () => string } {
    let stdout = ''
    let stderr = ''
    return {
      client: {} as TerravizClient,
      args: { positional: [], options },
      stdout: { write: (s: string) => ((stdout += s), true) },
      stderr: { write: (s: string) => ((stderr += s), true) },
      stdoutBuf: () => stdout,
      stderrBuf: () => stderr,
    }
  }

  it('returns 0 when every check passes', async () => {
    const ctx = mkCtx()
    const fetchImpl = makeRouter({
      '/.well-known/terraviz.json': () =>
        mkResponse(200, { node_id: 'X', public_key: 'ed25519:AA' }),
      '/api/v1/catalog': () => mkResponse(200, { datasets: [{ id: 'X' }] }),
      '/api/v1/search': () => mkResponse(200, { datasets: [] }),
    })
    const code = await runVerifyDeploy(ctx, {
      config: { server: 'https://example.test', insecureLocal: false },
      fetchImpl,
    })
    expect(code).toBe(0)
    expect(ctx.stdoutBuf()).toMatch(/passed/)
  })

  it('returns 1 when any check fails', async () => {
    const ctx = mkCtx()
    const fetchImpl = makeRouter({
      '/.well-known/terraviz.json': () => mkResponse(500, 'oops'),
      '/api/v1/catalog': () => mkResponse(200, { datasets: [{ id: 'X' }] }),
      '/api/v1/search': () => mkResponse(200, { datasets: [] }),
    })
    const code = await runVerifyDeploy(ctx, {
      config: { server: 'https://example.test', insecureLocal: false },
      fetchImpl,
    })
    expect(code).toBe(1)
    expect(ctx.stdoutBuf()).toMatch(/CATALOG_BACKEND_DEVELOPMENT.md/)
  })

  it('honours --skip-publish-checks even when a service token is configured', async () => {
    const ctx = mkCtx({ 'skip-publish-checks': true })
    const fetchImpl = makeRouter({
      '/.well-known/terraviz.json': () =>
        mkResponse(200, { node_id: 'X', public_key: 'ed25519:AA' }),
      '/api/v1/catalog': () => mkResponse(200, { datasets: [{ id: 'X' }] }),
      '/api/v1/search': () => mkResponse(200, { datasets: [] }),
    })
    const code = await runVerifyDeploy(ctx, {
      config: {
        server: 'https://example.test',
        insecureLocal: false,
        clientId: 'cid',
        clientSecret: 'sec',
      },
      fetchImpl,
    })
    expect(code).toBe(0)
    expect(ctx.stdoutBuf()).toMatch(/SKIP/)
  })
})
