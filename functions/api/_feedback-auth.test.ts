// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// @vitest-environment node
// Workers keeps every header a test sets; happy-dom's Request may not.

/**
 * Tests for the feedback admin routes' identity check. Tokens are
 * signed with a keypair minted here and the team's JWKS is put in
 * the KV cache, so the real signature path runs with no network.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { authenticateFeedbackAdmin, feedbackAccessVerdict, type FeedbackAdminEnv } from './_feedback-auth'
import { makeKV } from './v1/_lib/test-helpers'
import * as feedbackAdmin from './feedback-admin'
import * as feedbackDashboard from './feedback-dashboard'
import * as feedbackExport from './feedback-export'
import * as generalDashboard from './general-feedback-dashboard'
import * as generalExport from './general-feedback-export'
import * as generalScreenshot from './general-feedback-screenshot'

const TEAM = 'team.cloudflareaccess.test'
const PUBLISHER_AUD = 'aud-publisher'
const FEEDBACK_AUD = 'aud-feedback'
const OTHER_AUD = 'aud-some-other-app'
const KID = 'kid-1'

let privateKey: CryptoKey
let otherKey: CryptoKey
let publicJwk: JsonWebKey

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)))

async function rsaPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
}

beforeAll(async () => {
  const pair = await rsaPair()
  privateKey = pair.privateKey
  publicJwk = { ...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey), kid: KID, alg: 'RS256' } as JsonWebKey
  otherKey = (await rsaPair()).privateKey
}, 30_000)

async function token(claims: Record<string, unknown> = {}, key: CryptoKey = privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = b64urlJson({ alg: 'RS256', kid: KID, typ: 'JWT' })
  const payload = b64urlJson({
    iss: `https://${TEAM}`,
    aud: [FEEDBACK_AUD],
    sub: 'user-1',
    email: 'staff@example.org',
    exp: now + 600,
    ...claims,
  })
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`
}

/** An env whose KV already holds the team's JWKS. */
function env(extra: Partial<FeedbackAdminEnv> = {}): FeedbackAdminEnv {
  const kv = makeKV()
  kv._store.set(`access:jwks:${TEAM}`, JSON.stringify({ keys: [publicJwk] }))
  return { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: PUBLISHER_AUD, CATALOG_KV: kv, ...extra }
}

function req(headers: Record<string, string> = {}, path = '/api/feedback-export'): Request {
  return new Request(`https://node.example.org${path}`, { headers })
}
const access = (jwt: string) => ({ 'Cf-Access-Jwt-Assertion': jwt })
const noFetch = (() => {
  throw new Error('JWKS should come from KV')
}) as unknown as typeof fetch

describe('feedbackAccessVerdict', () => {
  const verdict = (headers: Record<string, string>, e: FeedbackAdminEnv) =>
    feedbackAccessVerdict(req(headers), e, { fetchImpl: noFetch })

  // The hole this module closes: the routes used to accept the
  // header's presence, so a client on a path no Access application
  // covers could send any value.
  it('refuses a forged header on a node with a team domain', async () => {
    expect(await verdict(access('x'), env())).toBe('refused')
    expect(await verdict({ 'Cf-Access-Authenticated-User-Email': 'staff@example.org' }, env())).toBe('absent')
    expect(await verdict(access(await token({}, otherKey)), env())).toBe('refused')
  })

  it('refuses a token that is expired or from another team', async () => {
    const past = Math.floor(Date.now() / 1000) - 10
    expect(await verdict(access(await token({ exp: past })), env())).toBe('refused')
    expect(await verdict(access(await token({ iss: 'https://other.cloudflareaccess.com' })), env())).toBe('refused')
  })

  it('accepts the feedback or publisher audience once ACCESS_FEEDBACK_AUD is set, and nothing else', async () => {
    const strict = env({ ACCESS_FEEDBACK_AUD: ` ${FEEDBACK_AUD}\n` })
    expect(await verdict(access(await token({ aud: FEEDBACK_AUD })), strict)).toBe('verified')
    expect(await verdict(access(await token({ aud: [OTHER_AUD, PUBLISHER_AUD] })), strict)).toBe('verified')
    expect(await verdict(access(await token({ aud: [OTHER_AUD] })), strict)).toBe('refused')
    expect(await verdict(access(await token({ aud: [] })), strict)).toBe('refused')
  })

  // Transitional: a node running §6.4's application with no variable
  // naming its AUD keeps working.
  it('accepts any audience from the team while ACCESS_FEEDBACK_AUD is unset', async () => {
    expect(await verdict(access(await token({ aud: [OTHER_AUD] })), env())).toBe('team-only')
    expect(await verdict(access(await token({ aud: PUBLISHER_AUD })), env())).toBe('verified')
    expect(await verdict(access(await token({ aud: [OTHER_AUD] })), env({ ACCESS_AUD: undefined }))).toBe('team-only')
  })

  it("keeps today's presence check on a node with no team domain", async () => {
    const bare = { CATALOG_KV: makeKV() }
    expect(await verdict(access('x'), bare)).toBe('unverified')
    expect(await verdict({ 'Cf-Access-Authenticated-User-Email': 'staff@example.org' }, bare)).toBe('unverified')
    expect(await verdict({}, bare)).toBe('absent')
    expect(await verdict(access('x'), { ACCESS_FEEDBACK_AUD: FEEDBACK_AUD })).toBe('misconfigured')
  })
})

describe('authenticateFeedbackAdmin', () => {
  const auth = (headers: Record<string, string>, e: FeedbackAdminEnv) => {
    const warn = vi.fn()
    return authenticateFeedbackAdmin(req(headers), e, { fetchImpl: noFetch, warn }).then(ok => ({ ok, warn }))
  }

  it('lets a verified token in silently', async () => {
    const { ok, warn } = await auth(access(await token()), env({ ACCESS_FEEDBACK_AUD: FEEDBACK_AUD }))
    expect(ok).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('lets the transitional cases in with a warning', async () => {
    const teamOnly = await auth(access(await token({ aud: OTHER_AUD })), env())
    expect(teamOnly.ok).toBe(true)
    expect(teamOnly.warn).toHaveBeenCalledWith(expect.stringContaining('ACCESS_FEEDBACK_AUD'))
    const unverified = await auth(access('x'), {})
    expect(unverified.ok).toBe(true)
    expect(unverified.warn).toHaveBeenCalledWith(expect.stringContaining('ACCESS_TEAM_DOMAIN is unset'))
  })

  it('falls through to the bearer when the header is refused or absent', async () => {
    const e = env({ FEEDBACK_ADMIN_TOKEN: 'secret\n' })
    expect((await auth(access('x'), e)).ok).toBe(false)
    expect((await auth({ ...access('x'), Authorization: 'Bearer secret' }, e)).ok).toBe(true)
    expect((await auth({ Authorization: 'bearer  secret ' }, e)).ok).toBe(true)
    expect((await auth({ Authorization: 'Bearer wrong' }, e)).ok).toBe(false)
    expect((await auth({ Authorization: 'Bearer ' }, env({ FEEDBACK_ADMIN_TOKEN: '  ' }))).ok).toBe(false)
  })

  it('warns about, and refuses, a feedback AUD it has no team domain to check', async () => {
    const { ok, warn } = await auth(access('x'), { ACCESS_FEEDBACK_AUD: FEEDBACK_AUD })
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Set ACCESS_TEAM_DOMAIN'))
  })
})

// Each route must ask the shared check. Without a FEEDBACK_DB a
// request that gets past auth answers 503, so 401 and 503 tell the
// two apart without a database.
describe('the six feedback admin routes', () => {
  const routes: Array<[string, { onRequestGet: unknown }, string]> = [
    ['feedback-admin', feedbackAdmin, '/api/feedback-admin?action=general-export'],
    ['feedback-dashboard', feedbackDashboard, '/api/feedback-dashboard'],
    ['feedback-export', feedbackExport, '/api/feedback-export'],
    ['general-feedback-dashboard', generalDashboard, '/api/general-feedback-dashboard'],
    ['general-feedback-export', generalExport, '/api/general-feedback-export'],
    ['general-feedback-screenshot', generalScreenshot, '/api/general-feedback-screenshot?id=1'],
  ]
  const call = async (mod: { onRequestGet: unknown }, request: Request, e: FeedbackAdminEnv) => {
    const handler = mod.onRequestGet as (ctx: { request: Request; env: FeedbackAdminEnv }) => Promise<Response>
    return (await handler({ request, env: e })).status
  }

  for (const [name, mod, path] of routes) {
    it(`${name}: 401 for a forged header, past auth for a verified token`, async () => {
      const strict = env({ ACCESS_FEEDBACK_AUD: FEEDBACK_AUD })
      expect(await call(mod, req(access('x'), path), strict)).toBe(401)
      expect(await call(mod, req(access(await token({ aud: OTHER_AUD })), path), strict)).toBe(401)
      expect(await call(mod, req(access(await token()), path), strict)).toBe(503)
    })
  }
})
