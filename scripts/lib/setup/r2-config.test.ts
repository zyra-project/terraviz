// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { matchZone } from './cf-request'
import {
  buildCorsRules,
  DEV_ORIGIN,
  ensureR2CustomDomain,
  R2ConfigApi,
  TAURI_ORIGINS,
  toDashboardJson,
} from './r2-config'

const SITE = 'https://terraviz.example.org'

describe('buildCorsRules', () => {
  // R2 treats HEAD and GET as distinct for CORS even though the Fetch
  // spec calls HEAD simple. Omit it and the zip dialog's size probe
  // is blocked outright.
  it('lists HEAD explicitly on the read rule', () => {
    const [read] = buildCorsRules({ site: SITE })
    expect(read.allowed.methods).toEqual(['GET', 'HEAD'])
  })

  // Content-Range is not CORS-safelisted, so the Range-GET size
  // fallback cannot read it. The symptom is "size unknown" with no
  // console error, which looks like an app bug.
  it('exposes Content-Range and Content-Length', () => {
    const [read] = buildCorsRules({ site: SITE })
    expect(read.exposeHeaders).toEqual(['Content-Length', 'Content-Range'])
  })

  it('exposes ETag on the write rule, which the uploader reads', () => {
    const [, write] = buildCorsRules({ site: SITE })
    expect(write.allowed.methods).toEqual(['PUT', 'POST'])
    expect(write.exposeHeaders).toEqual(['ETag'])
    expect(write.allowed.headers).toEqual(['Content-Type'])
  })

  it('adds a scheme when the site was given bare', () => {
    const [read] = buildCorsRules({ site: 'terraviz.example.org' })
    expect(read.allowed.origins).toEqual([SITE])
  })

  it('strips a trailing slash', () => {
    const [read] = buildCorsRules({ site: `${SITE}/` })
    expect(read.allowed.origins).toEqual([SITE])
  })

  it('adds the dev origin to both rules when asked', () => {
    const [read, write] = buildCorsRules({ site: SITE, includeLocalhost: true })
    expect(read.allowed.origins).toContain(DEV_ORIGIN)
    expect(write.allowed.origins).toContain(DEV_ORIGIN)
  })

  // Desktop builds only read from R2 — uploads go through the portal
  // on the web origin — so the Tauri origins have no business on the
  // write rule.
  it('adds the Tauri origins to the read rule only', () => {
    const [read, write] = buildCorsRules({ site: SITE, includeTauri: true })
    for (const origin of TAURI_ORIGINS) {
      expect(read.allowed.origins).toContain(origin)
      expect(write.allowed.origins).not.toContain(origin)
    }
  })

  it('defaults to the site origin alone', () => {
    const [read, write] = buildCorsRules({ site: SITE })
    expect(read.allowed.origins).toEqual([SITE])
    expect(write.allowed.origins).toEqual([SITE])
  })
})

describe('toDashboardJson', () => {
  it('re-encodes the policy in the form the dashboard editor takes', () => {
    const json = toDashboardJson(buildCorsRules({ site: SITE }))
    expect(json[0]).toEqual({
      AllowedOrigins: [SITE],
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['Content-Length', 'Content-Range'],
      MaxAgeSeconds: 3600,
    })
  })

  it('round-trips every rule', () => {
    const rules = buildCorsRules({ site: SITE, includeLocalhost: true })
    expect(toDashboardJson(rules)).toHaveLength(rules.length)
  })
})

describe('matchZone', () => {
  // An account can hold both example.org and eu.example.org; picking
  // the wrong one puts the domain on a zone that never sees traffic.
  it('prefers the most specific zone', () => {
    const zones = [{ id: 'a', name: 'example.org' }, { id: 'b', name: 'eu.example.org' }]
    expect(matchZone(zones, 'assets.eu.example.org')?.id).toBe('b')
  })

  it('matches the apex itself', () => {
    expect(matchZone([{ id: 'a', name: 'example.org' }], 'example.org')?.id).toBe('a')
  })

  it('does not match a zone that is merely a suffix string', () => {
    expect(matchZone([{ id: 'a', name: 'example.org' }], 'notexample.org')).toBeNull()
  })

  it('ignores scheme and path', () => {
    expect(matchZone([{ id: 'a', name: 'example.org' }], 'https://a.example.org/x')?.id).toBe('a')
  })

  it('returns null when nothing matches', () => {
    expect(matchZone([{ id: 'a', name: 'other.org' }], 'a.example.org')).toBeNull()
  })
})

function stubR2(routes: Record<string, unknown>, seen: string[] = []): R2ConfigApi {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const u = new URL(url)
    const path = u.pathname.replace(/^\/client\/v4/, '') + u.search
    seen.push(`${method} ${path}`)
    const key = `${method} ${path}`
    if (!(key in routes)) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: 'no stub' }] }), {
        status: 404,
        statusText: 'Not Found',
      })
    }
    return new Response(JSON.stringify({ success: true, result: routes[key] }), { status: 200 })
  }) as unknown as typeof fetch
  return new R2ConfigApi('acct', { apiToken: 't', fetchImpl })
}

describe('ensureR2CustomDomain', () => {
  it('resolves the zone and attaches the domain', async () => {
    const seen: string[] = []
    const api = stubR2(
      {
        'GET /accounts/acct/r2/buckets/terraviz-assets/domains/custom': [],
        'GET /zones?per_page=200': [{ id: 'z1', name: 'example.org' }],
        'POST /accounts/acct/r2/buckets/terraviz-assets/domains/custom': {},
      },
      seen,
    )
    const res = await ensureR2CustomDomain(api, 'terraviz-assets', 'assets.example.org')
    expect(res).toEqual({ domain: 'assets.example.org', created: true, zoneId: 'z1' })
  })

  it('adopts a domain that is already attached', async () => {
    const seen: string[] = []
    const api = stubR2(
      {
        'GET /accounts/acct/r2/buckets/terraviz-assets/domains/custom': [
          { domain: 'assets.example.org' },
        ],
      },
      seen,
    )
    const res = await ensureR2CustomDomain(api, 'terraviz-assets', 'https://assets.example.org/')
    expect(res.created).toBe(false)
    expect(seen.some(s => s.startsWith('POST'))).toBe(false)
  })

  it('explains that the domain must be on Cloudflare DNS first', async () => {
    const api = stubR2({
      'GET /accounts/acct/r2/buckets/terraviz-assets/domains/custom': [],
      'GET /zones?per_page=200': [{ id: 'z1', name: 'unrelated.org' }],
    })
    await expect(
      ensureR2CustomDomain(api, 'terraviz-assets', 'assets.example.org'),
    ).rejects.toThrow(/on Cloudflare DNS/)
  })
})
