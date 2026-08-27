// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  buildProjectBody,
  DEFAULT_BUILD_CONFIG,
  ensureCustomDomain,
  ensurePagesProject,
  PagesProjectApi,
} from './pages-project'
import { renderGithubSecretsScript, GITHUB_SECRETS } from './github-secrets'

function stubPages(routes: Record<string, unknown>, seen: string[] = []): PagesProjectApi {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = new URL(url).pathname.replace(/^\/client\/v4/, '')
    seen.push(`${method} ${path}`)
    const key = `${method} ${path}`
    if (!(key in routes)) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: 'missing' }] }), {
        status: 404,
        statusText: 'Not Found',
      })
    }
    return new Response(JSON.stringify({ success: true, result: routes[key] }), { status: 200 })
  }) as unknown as typeof fetch
  return new PagesProjectApi('acct', { apiToken: 't', fetchImpl })
}

describe('buildProjectBody', () => {
  it('matches the build settings the guide prescribes', () => {
    const body = buildProjectBody('my-node')
    expect(body.build_config).toEqual(DEFAULT_BUILD_CONFIG)
    expect(body.build_config.build_command).toBe('npm run build')
    expect(body.build_config.destination_dir).toBe('dist')
    expect(body.production_branch).toBe('main')
  })

  it('accepts a different production branch', () => {
    expect(buildProjectBody('x', 'trunk').production_branch).toBe('trunk')
  })

  it('refuses an empty name', () => {
    expect(() => buildProjectBody('')).toThrow(/project name/)
  })
})

describe('ensurePagesProject', () => {
  it('adopts an existing project', async () => {
    const seen: string[] = []
    const api = stubPages(
      { 'GET /accounts/acct/pages/projects/my-node': { name: 'my-node' } },
      seen,
    )
    const res = await ensurePagesProject(api, { name: 'my-node' })
    expect(res.created).toBe(false)
    expect(seen.some(s => s.startsWith('POST'))).toBe(false)
  })

  it('reports an adopted project as Git-connected when it has a source', async () => {
    const api = stubPages({
      'GET /accounts/acct/pages/projects/my-node': {
        name: 'my-node',
        source: { type: 'github' },
      },
    })
    expect((await ensurePagesProject(api, { name: 'my-node' })).gitConnected).toBe(true)
  })

  // The Git handshake is OAuth with no API, so anything this creates
  // is Direct Upload — which changes where the VITE_* build vars have
  // to live, so the caller has to be told.
  it('reports a freshly created project as not Git-connected', async () => {
    const api = stubPages({
      'POST /accounts/acct/pages/projects': { name: 'my-node' },
    })
    const res = await ensurePagesProject(api, { name: 'my-node' })
    expect(res.created).toBe(true)
    expect(res.gitConnected).toBe(false)
  })
})

describe('ensureCustomDomain', () => {
  it('attaches a domain that is not yet present', async () => {
    const api = stubPages({
      'GET /accounts/acct/pages/projects/my-node/domains': [],
      'POST /accounts/acct/pages/projects/my-node/domains': {
        name: 'a.example.org',
        status: 'pending',
      },
    })
    const res = await ensureCustomDomain(api, 'my-node', 'a.example.org')
    expect(res).toEqual({ name: 'a.example.org', created: true, status: 'pending' })
  })

  it('adopts an attached domain and normalises the input', async () => {
    const seen: string[] = []
    const api = stubPages(
      {
        'GET /accounts/acct/pages/projects/my-node/domains': [
          { name: 'a.example.org', status: 'active' },
        ],
      },
      seen,
    )
    const res = await ensureCustomDomain(api, 'my-node', 'https://a.example.org/')
    expect(res).toEqual({ name: 'a.example.org', created: false, status: 'active' })
    expect(seen.some(s => s.startsWith('POST'))).toBe(false)
  })
})

describe('renderGithubSecretsScript', () => {
  // Values are shell references, never inlined, so the script is safe
  // to paste into an issue or a runbook.
  it('never inlines a value', () => {
    const script = renderGithubSecretsScript()
    for (const spec of GITHUB_SECRETS) {
      expect(script).toContain(`--body "$${spec.from}"`)
    }
  })

  it('scopes to a repo when one is known', () => {
    expect(renderGithubSecretsScript({ repo: 'me/mine' })).toContain('--repo me/mine')
    expect(renderGithubSecretsScript()).not.toContain('--repo')
  })

  it('flags secrets the current shell cannot supply', () => {
    const script = renderGithubSecretsScript({ available: new Set(['TERRAVIZ_SERVER']) })
    expect(script).toContain('⚠ $CF_ACCESS_CLIENT_ID is not set')
    expect(script).not.toContain('⚠ $TERRAVIZ_SERVER is not set')
  })

  // TERRAVIZ_SERVER is both a secret and a Variable — the secrets
  // context is not allowed in environment.url, so they are not
  // interchangeable and both have to be set.
  it('emits the TERRAVIZ_SERVER repo variable as well as the secret', () => {
    const script = renderGithubSecretsScript()
    expect(script).toContain('gh secret set TERRAVIZ_SERVER')
    expect(script).toContain('gh variable set TERRAVIZ_SERVER')
  })

  it('covers every declared secret', () => {
    const script = renderGithubSecretsScript()
    for (const spec of GITHUB_SECRETS) expect(script).toContain(`gh secret set ${spec.name}`)
  })
})
