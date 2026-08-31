// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'

import { gotoApp, isSameOrigin } from './browser'

describe('isSameOrigin', () => {
  const base = 'https://terraviz.zyra-project.org'

  it('is true for same-origin URLs (any path/query)', () => {
    expect(isSameOrigin('https://terraviz.zyra-project.org/', base)).toBe(true)
    expect(isSameOrigin('https://terraviz.zyra-project.org/publish/datasets', base)).toBe(true)
    expect(isSameOrigin('https://terraviz.zyra-project.org/api/v1/publish/me?x=1', base)).toBe(true)
  })

  it('is false for third-party origins (so the token never leaks)', () => {
    expect(isSameOrigin('https://tiles.openfreemap.org/planet', base)).toBe(false)
    expect(isSameOrigin('https://gibs.earthdata.nasa.gov/x.png', base)).toBe(false)
    // A look-alike host must not match (exact origin, not prefix).
    expect(isSameOrigin('https://terraviz.zyra-project.org.evil.com/', base)).toBe(false)
  })

  it('distinguishes scheme and port', () => {
    expect(isSameOrigin('http://terraviz.zyra-project.org/', base)).toBe(false)
    expect(isSameOrigin('https://terraviz.zyra-project.org:8443/', base)).toBe(false)
  })

  it('is false for a malformed URL rather than throwing', () => {
    expect(isSameOrigin('not a url', base)).toBe(false)
  })
})

describe('gotoApp', () => {
  it('uses a 60s ceiling and waits only for domcontentloaded', async () => {
    const goto = vi.fn().mockResolvedValue(null)
    await gotoApp({ goto } as unknown as Page, '/?catalog=true')
    expect(goto).toHaveBeenCalledTimes(1)
    expect(goto).toHaveBeenCalledWith('/?catalog=true', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
  })

  it('retries once when the first navigation times out (the catalog flake)', async () => {
    const goto = vi
      .fn()
      .mockRejectedValueOnce(new Error('page.goto: Timeout 60000ms exceeded.'))
      .mockResolvedValueOnce(null)
    await gotoApp({ goto } as unknown as Page, '/?catalog=true')
    expect(goto).toHaveBeenCalledTimes(2)
  })

  it('does not retry — and rethrows — a non-timeout navigation error', async () => {
    const goto = vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'))
    await expect(
      gotoApp({ goto } as unknown as Page, '/?catalog=true'),
    ).rejects.toThrow('ERR_CONNECTION_REFUSED')
    expect(goto).toHaveBeenCalledTimes(1)
  })
})
