// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { onRequestGet, buildReturnTo, safeTeamDomain } from './logout'

function makeContext(
  url: string,
  env: Partial<{ ACCESS_TEAM_DOMAIN: string }> = {},
): Parameters<PagesFunction>[0] {
  return {
    request: new Request(url),
    env,
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/logout',
  } as unknown as Parameters<PagesFunction>[0]
}

describe('buildReturnTo', () => {
  it('returns origin + trailing slash', () => {
    const req = new Request('https://terraviz.example.org/api/v1/logout')
    expect(buildReturnTo(req)).toBe('https://terraviz.example.org/')
  })

  it('preserves the protocol from the request', () => {
    const req = new Request('http://localhost:5173/api/v1/logout')
    expect(buildReturnTo(req)).toBe('http://localhost:5173/')
  })
})

describe('safeTeamDomain', () => {
  it.each<[string | undefined, string | null]>([
    [undefined, null],
    ['', null],
    ['zyra-project.cloudflareaccess.com', 'zyra-project.cloudflareaccess.com'],
    ['https://zyra-project.cloudflareaccess.com', 'zyra-project.cloudflareaccess.com'],
    ['zyra-project.cloudflareaccess.com/', 'zyra-project.cloudflareaccess.com'],
    ['zyra-project.cloudflareaccess.com///', 'zyra-project.cloudflareaccess.com'],
    ['bad domain with spaces.com', null],
    ['no/slashes/allowed', null],
    ['scheme:colons.com', null],
    ['custom.access.example.org', 'custom.access.example.org'],
  ])('safeTeamDomain(%j) → %j', (input, expected) => {
    expect(safeTeamDomain(input)).toBe(expected)
  })
})

describe('GET /api/v1/logout', () => {
  it('302s to the Cloudflare Access logout URL when ACCESS_TEAM_DOMAIN is set', async () => {
    const ctx = makeContext('https://terraviz.example.org/api/v1/logout', {
      ACCESS_TEAM_DOMAIN: 'zyra-project.cloudflareaccess.com',
    })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'https://zyra-project.cloudflareaccess.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fterraviz.example.org%2F',
    )
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('uses the request origin (not a hardcoded domain) for returnTo', async () => {
    const ctx = makeContext(
      'https://claude-catalog-publisher-por.terraviz.pages.dev/api/v1/logout',
      { ACCESS_TEAM_DOMAIN: 'zyra-project.cloudflareaccess.com' },
    )
    const res = await onRequestGet(ctx)
    const location = res.headers.get('location')!
    expect(location).toContain(
      encodeURIComponent('https://claude-catalog-publisher-por.terraviz.pages.dev/'),
    )
  })

  it('strips an accidental protocol prefix on ACCESS_TEAM_DOMAIN', async () => {
    const ctx = makeContext('https://terraviz.example.org/api/v1/logout', {
      ACCESS_TEAM_DOMAIN: 'https://zyra-project.cloudflareaccess.com/',
    })
    const res = await onRequestGet(ctx)
    expect(res.headers.get('location')).toMatch(
      /^https:\/\/zyra-project\.cloudflareaccess\.com\/cdn-cgi\/access\/logout/,
    )
  })

  it('falls back to / when ACCESS_TEAM_DOMAIN is unset (dev mode)', async () => {
    const ctx = makeContext('https://terraviz.example.org/api/v1/logout', {})
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })

  it('falls back to / when ACCESS_TEAM_DOMAIN is malformed (defensive)', async () => {
    const ctx = makeContext('https://terraviz.example.org/api/v1/logout', {
      ACCESS_TEAM_DOMAIN: 'not a valid domain',
    })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })
})
