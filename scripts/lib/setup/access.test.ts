// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  AccessApi,
  AUTOMATION_POLICY_NAME,
  buildAppBody,
  buildServicePolicy,
  buildStaffPolicy,
  ensureAccessApplication,
  ensurePolicies,
  ensureServiceToken,
  publisherDestinations,
  PUBLISHER_PATHS,
  STAFF_POLICY_NAME,
} from './access'

/** Route stub keyed by "METHOD /path-suffix". */
function stubApi(
  routes: Record<string, unknown>,
  opts: { fail?: { status: number; body: unknown } } = {},
): { api: AccessApi; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = new URL(url).pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, '')
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    if (opts.fail) {
      return new Response(JSON.stringify(opts.fail.body), {
        status: opts.fail.status,
        statusText: 'Forbidden',
      })
    }
    const key = `${method} ${path}`
    if (!(key in routes)) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: `no stub for ${key}` }] }), {
        status: 404,
        statusText: 'Not Found',
      })
    }
    return new Response(JSON.stringify({ success: true, result: routes[key] }), { status: 200 })
  }) as unknown as typeof fetch

  return { api: new AccessApi({ apiToken: 't', accountId: 'acct', fetchImpl }), calls }
}

describe('publisherDestinations', () => {
  it('covers the API and the portal on both hosts', () => {
    const d = publisherDestinations('terraviz.example.org', 'my-node.pages.dev')
    expect(d).toEqual([
      'terraviz.example.org/api/v1/publish',
      'terraviz.example.org/publish',
      'terraviz.example.org/publish/*',
      'my-node.pages.dev/api/v1/publish',
      'my-node.pages.dev/publish',
      'my-node.pages.dev/publish/*',
    ])
  })

  it('gates the preview host too — leaving it out makes every preview portal public', () => {
    const d = publisherDestinations('terraviz.example.org', 'my-node.pages.dev')
    expect(d.filter(x => x.startsWith('my-node.pages.dev'))).toHaveLength(PUBLISHER_PATHS.length)
  })

  it('strips a scheme and trailing slash from the host', () => {
    expect(publisherDestinations('https://a.example/')).toEqual([
      'a.example/api/v1/publish',
      'a.example/publish',
      'a.example/publish/*',
    ])
  })

  it('works with only one host', () => {
    expect(publisherDestinations('a.example')).toHaveLength(3)
  })
})

describe('buildAppBody', () => {
  it('produces a self-hosted app with a 24h session', () => {
    const body = buildAppBody({ name: 'App', destinations: ['a.example/publish'] })
    expect(body.type).toBe('self_hosted')
    expect(body.session_duration).toBe('24h')
    expect(body.app_launcher_visible).toBe(false)
  })

  it('sets domain and destinations consistently for both API generations', () => {
    const dests = ['a.example/api/v1/publish', 'a.example/publish']
    const body = buildAppBody({ name: 'App', destinations: dests })
    expect(body.domain).toBe(dests[0])
    expect(body.destinations).toEqual(dests.map(uri => ({ type: 'public', uri })))
  })

  it('refuses to build an app that gates nothing', () => {
    expect(() => buildAppBody({ name: 'App', destinations: [] })).toThrow(/at least one/)
  })
})

describe('buildStaffPolicy', () => {
  // The `email` selector is an exact match on one address and picking
  // it by mistake is this project's most common Access misconfig, so
  // the builder can only emit the suffix form.
  it('always uses the email_domain suffix match, never an exact email', () => {
    const p = buildStaffPolicy('your-org.org')
    expect(p.include).toEqual([{ email_domain: { domain: 'your-org.org' } }])
    expect(JSON.stringify(p)).not.toContain('"email"')
  })

  it('tolerates a leading @ and normalises case', () => {
    expect(buildStaffPolicy('@Your-Org.ORG').include).toEqual([
      { email_domain: { domain: 'your-org.org' } },
    ])
  })

  it('is an Allow decision named Staff', () => {
    const p = buildStaffPolicy('a.org')
    expect(p.decision).toBe('allow')
    expect(p.name).toBe(STAFF_POLICY_NAME)
  })

  it('rejects something that is not a domain', () => {
    expect(() => buildStaffPolicy('nonsense')).toThrow(/not a valid email domain/)
    expect(() => buildStaffPolicy('')).toThrow()
  })
})

describe('buildServicePolicy', () => {
  it('is a non_identity decision including the token', () => {
    const p = buildServicePolicy('tok-123')
    expect(p.decision).toBe('non_identity')
    expect(p.include).toEqual([{ service_token: { token_id: 'tok-123' } }])
    expect(p.name).toBe(AUTOMATION_POLICY_NAME)
  })

  it('refuses an empty token id', () => {
    expect(() => buildServicePolicy('')).toThrow(/service token id/)
  })
})

describe('AccessApi.getTeamDomain', () => {
  it('reads auth_domain from the organization', async () => {
    const { api } = stubApi({ 'GET /access/organizations': { auth_domain: 'acme.cloudflareaccess.com' } })
    expect(await api.getTeamDomain()).toBe('acme.cloudflareaccess.com')
  })

  // Zero Trust onboarding is a manual prerequisite; a null is how the
  // caller detects that it hasn't happened.
  it('returns null when Zero Trust is not onboarded', async () => {
    const { api } = stubApi({})
    expect(await api.getTeamDomain()).toBeNull()
  })

  // Reporting an under-scoped token as "not onboarded" sends the
  // operator to a dashboard page where the work is already done and
  // there is nothing to fix — the actual remedy is on the token.
  it('rethrows a permissions failure instead of reporting it as not-onboarded', async () => {
    const { api } = stubApi(
      {},
      {
        fail: {
          status: 403,
          body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
        },
      },
    )
    await expect(api.getTeamDomain()).rejects.toThrow(/Access: Organizations/)
  })

  it('rethrows a server-side failure rather than swallowing it', async () => {
    const { api } = stubApi({}, { fail: { status: 500, body: { success: false } } })
    await expect(api.getTeamDomain()).rejects.toThrow(/500/)
  })
})

describe('AccessApi error handling', () => {
  it('names the permissions the token is missing', async () => {
    const { api } = stubApi(
      {},
      { fail: { status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } } },
    )
    await expect(api.listApps()).rejects.toThrow(/Access: Apps and Policies/)
  })
})

describe('ensureAccessApplication', () => {
  it('adopts an application with the same name rather than minting a second AUD', async () => {
    const { api, calls } = stubApi({
      'GET /access/apps': [{ id: 'app1', name: 'Terraviz Publisher', aud: 'aud-existing' }],
    })
    const res = await ensureAccessApplication(api, {
      name: 'Terraviz Publisher',
      destinations: ['a.example/publish'],
    })
    expect(res).toEqual({
      app: { id: 'app1', name: 'Terraviz Publisher', aud: 'aud-existing' },
      created: false,
    })
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0)
  })

  it('creates and returns the AUD when absent', async () => {
    const { api, calls } = stubApi({
      'GET /access/apps': [],
      'POST /access/apps': { id: 'app2', name: 'Terraviz Publisher', aud: 'aud-new' },
    })
    const res = await ensureAccessApplication(api, {
      name: 'Terraviz Publisher',
      destinations: ['a.example/publish', 'b.example/publish'],
    })
    expect(res.created).toBe(true)
    expect(res.app.aud).toBe('aud-new')
    const post = calls.find(c => c.method === 'POST')!
    expect((post.body as { destinations: unknown[] }).destinations).toHaveLength(2)
  })

  it('fails loudly if the create response carries no AUD', async () => {
    const { api } = stubApi({
      'GET /access/apps': [],
      'POST /access/apps': { id: 'app3', name: 'X', aud: '' },
    })
    await expect(
      ensureAccessApplication(api, { name: 'X', destinations: ['a/publish'] }),
    ).rejects.toThrow(/no AUD/)
  })
})

describe('ensureServiceToken', () => {
  it('returns the secret on creation', async () => {
    const { api } = stubApi({
      'GET /access/service_tokens': [],
      'POST /access/service_tokens': {
        id: 'tok1',
        name: 'terraviz-cli',
        client_id: 'cid',
        client_secret: 'csecret',
      },
    })
    const res = await ensureServiceToken(api, 'terraviz-cli')
    expect(res).toEqual({
      id: 'tok1',
      name: 'terraviz-cli',
      clientId: 'cid',
      clientSecret: 'csecret',
      created: true,
    })
  })

  // Cloudflare returns client_secret only at creation. Emitting an
  // empty string here would produce a plausible-looking credential
  // that cannot authenticate.
  it('adopts an existing token without inventing a secret', async () => {
    const { api, calls } = stubApi({
      'GET /access/service_tokens': [{ id: 'tok1', name: 'terraviz-cli', client_id: 'cid' }],
    })
    const res = await ensureServiceToken(api, 'terraviz-cli')
    expect(res.created).toBe(false)
    expect(res.clientSecret).toBeUndefined()
    expect('clientSecret' in res && res.clientSecret === '').toBe(false)
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0)
  })
})

describe('ensurePolicies', () => {
  it('creates both policies on a fresh application', async () => {
    const { api, calls } = stubApi({
      'GET /access/apps/app1/policies': [],
      'POST /access/apps/app1/policies': { id: 'p', name: 'x', decision: 'allow' },
    })
    const res = await ensurePolicies(api, 'app1', {
      emailDomain: 'your-org.org',
      serviceTokenId: 'tok1',
    })
    expect(res.created).toEqual([STAFF_POLICY_NAME, AUTOMATION_POLICY_NAME])
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(2)
  })

  it('skips a policy that already exists', async () => {
    const { api, calls } = stubApi({
      'GET /access/apps/app1/policies': [{ id: 'p1', name: STAFF_POLICY_NAME, decision: 'allow' }],
      'POST /access/apps/app1/policies': { id: 'p2', name: 'x', decision: 'non_identity' },
    })
    const res = await ensurePolicies(api, 'app1', {
      emailDomain: 'your-org.org',
      serviceTokenId: 'tok1',
    })
    expect(res.existing).toEqual([STAFF_POLICY_NAME])
    expect(res.created).toEqual([AUTOMATION_POLICY_NAME])
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })

  it('creates no Staff policy when no email domain was supplied', async () => {
    const { api } = stubApi({
      'GET /access/apps/app1/policies': [],
      'POST /access/apps/app1/policies': { id: 'p', name: 'x', decision: 'non_identity' },
    })
    const res = await ensurePolicies(api, 'app1', { serviceTokenId: 'tok1' })
    expect(res.created).toEqual([AUTOMATION_POLICY_NAME])
  })
})
