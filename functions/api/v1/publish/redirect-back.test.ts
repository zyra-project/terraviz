// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { onRequestGet, isSafeRedirectTarget } from './redirect-back'

describe('isSafeRedirectTarget', () => {
  it.each<[string | null, boolean]>([
    ['/publish', true],
    ['/publish/', true],
    ['/publish/me', true],
    ['/publish/datasets/abc-123', true],
    // Query string and hash on a /publish path stay safe — they're
    // legitimate state the portal's sign-in URL builder can include.
    ['/publish?utm=foo', true],
    ['/publish/me?next=1#section', true],
    ['/publish/datasets?status=draft', true],
    [null, false],
    ['', false],
    ['/', false], // root path is not /publish-prefixed
    ['/api/v1/publish/me', false], // not under /publish
    ['/other-path', false],
    ['publish/me', false], // not absolute
    ['https://evil.example/publish', false], // absolute URL
    ['//evil.example/publish', false], // protocol-relative
    ['/publish\nLocation: https://evil.example', false], // CRLF injection
    ['/publish\x00.html', false], // control char
  ])('isSafeRedirectTarget(%j) → %j', (input, expected) => {
    expect(isSafeRedirectTarget(input)).toBe(expected)
  })

  it('rejects targets longer than 1024 chars', () => {
    const long = '/publish/' + 'a'.repeat(1024)
    expect(isSafeRedirectTarget(long)).toBe(false)
  })
})

function makeContext(url: string): Parameters<PagesFunction>[0] {
  return {
    request: new Request(url),
    env: {},
    params: {},
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/redirect-back',
  } as unknown as Parameters<PagesFunction>[0]
}

describe('GET /api/v1/publish/redirect-back', () => {
  it('302s to the target on a safe input', async () => {
    const ctx = makeContext('https://example.org/api/v1/publish/redirect-back?to=/publish/me')
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/publish/me')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it.each<[string, string]>([
    ['no `to` param', 'https://example.org/api/v1/publish/redirect-back'],
    ['empty `to` param', 'https://example.org/api/v1/publish/redirect-back?to='],
    ['absolute URL', 'https://example.org/api/v1/publish/redirect-back?to=https://evil.example/'],
    [
      'protocol-relative URL',
      'https://example.org/api/v1/publish/redirect-back?to=//evil.example/',
    ],
    [
      'path outside /publish',
      'https://example.org/api/v1/publish/redirect-back?to=/api/v1/publish/me',
    ],
  ])('400s on %s', async (_label, url) => {
    const res = await onRequestGet(makeContext(url))
    expect(res.status).toBe(400)
    const body = JSON.parse(await res.text()) as { error: string }
    expect(body.error).toBe('invalid_redirect_target')
  })

  it('URL-decodes the target before validating', async () => {
    // `%2F` should NOT bypass the /publish prefix check.
    const ctx = makeContext(
      'https://example.org/api/v1/publish/redirect-back?to=%2Fpublish%2Fme',
    )
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/publish/me')
  })
})
