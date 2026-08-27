// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `applyEnvOverrides` — the seam where an operator's shell drives
 * `npm run setup`.
 *
 * These tests pin the whitespace handling specifically. The values
 * that flow through here are pasted out of the Cloudflare dashboard
 * and end up in the node's state file and from there in its Pages
 * bindings, where a trailing newline on `ACCESS_AUD` is no longer
 * visible and turns every publisher request into a 401.
 */

import { describe, expect, it } from 'vitest'

import { applyEnvOverrides, hydrateState } from './state'

const BASE = hydrateState(null)

describe('applyEnvOverrides', () => {
  it('applies overrides that are set', () => {
    const next = applyEnvOverrides(BASE, {
      CLOUDFLARE_ACCOUNT_ID: 'abc123',
      ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      ACCESS_AUD: 'aud-tag',
    })
    expect(next.accountId).toBe('abc123')
    expect(next.accessTeamDomain).toBe('example.cloudflareaccess.com')
    expect(next.accessAud).toBe('aud-tag')
  })

  it('trims whitespace off every override', () => {
    const next = applyEnvOverrides(BASE, {
      CLOUDFLARE_ACCOUNT_ID: '  abc123\n',
      CLOUDFLARE_PAGES_PROJECT_NAME: 'my-node\r\n',
      TERRAVIZ_HOSTNAME: ' node.example.com ',
      ACCESS_TEAM_DOMAIN: '\texample.cloudflareaccess.com\n',
      ACCESS_AUD: 'aud-tag\n',
      GITHUB_OWNER: ' owner\n',
      GITHUB_REPO: 'repo ',
    })
    expect(next.accountId).toBe('abc123')
    expect(next.pagesProject).toBe('my-node')
    expect(next.hostname).toBe('node.example.com')
    expect(next.accessTeamDomain).toBe('example.cloudflareaccess.com')
    expect(next.accessAud).toBe('aud-tag')
    expect(next.githubOwner).toBe('owner')
    expect(next.githubRepo).toBe('repo')
  })

  it('treats a whitespace-only override as unset', () => {
    const seeded = applyEnvOverrides(BASE, { ACCESS_AUD: 'real-aud' })
    const next = applyEnvOverrides(seeded, { ACCESS_AUD: '   ' })
    expect(next.accessAud).toBe('real-aud')
  })

  it('leaves the caller env object untouched', () => {
    const env = { ACCESS_AUD: ' aud-tag\n' }
    applyEnvOverrides(BASE, env)
    expect(env.ACCESS_AUD).toBe(' aud-tag\n')
  })

  it('trims a renamed resource name before the rename comparison', () => {
    // A padded name must not read as a rename against the same
    // name unpadded — that would drop an already-resolved id and
    // send the next run off to re-resolve it.
    const resolved = { ...BASE, d1: { name: 'sphere-feedback', id: 'd1-id' } }
    const next = applyEnvOverrides(resolved, { TERRAVIZ_D1_NAME: 'sphere-feedback\n' })
    expect(next.d1).toEqual({ name: 'sphere-feedback', id: 'd1-id' })
  })
})
