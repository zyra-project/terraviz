/**
 * Tests for the Cloudflare Access JWT verifier.
 *
 * We mint our own RSA keypair, build a fake JWKS endpoint backed by
 * a stub `fetch`, and sign tokens with the matching private key.
 * That exercises the real signature path (`crypto.subtle.verify`)
 * end-to-end without needing a live Cloudflare Access tenant.
 *
 * Coverage:
 *   - Healthy user JWT → identity { type: 'user' }
 *   - Service token (`type: 'app'`) → identity { type: 'service' };
 *     synthesises an email when the claim is absent.
 *   - Wrong audience / wrong issuer / expired → null.
 *   - Bad signature / unknown kid / malformed token → null.
 *   - Algo other than RS256 → null (defense against alg-confusion).
 *   - Unconfigured env (missing ACCESS_TEAM_DOMAIN / ACCESS_AUD) → null.
 *   - JWKS is cached in KV after the first fetch.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { verifyAccessJwt } from './access-auth'
import { makeKV } from './test-helpers'

const TEAM = 'team.cloudflareaccess.test'
const AUD = 'AUD-PHASE-1A'
const KID = 'test-kid-1'

interface KeyMaterial {
  privateKey: CryptoKey
  publicJwk: JsonWebKey & { kid: string; alg: string; use: string }
}

let key: KeyMaterial

function base64urlBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlString(s: string): string {
  return base64urlBytes(new TextEncoder().encode(s))
}

async function generateKeyMaterial(): Promise<KeyMaterial> {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey
  return {
    privateKey,
    publicJwk: { ...jwk, kid: KID, alg: 'RS256', use: 'sig' },
  }
}

async function signJwt(
  claims: Record<string, unknown>,
  options: {
    kid?: string
    alg?: string
    privateKey?: CryptoKey
  } = {},
): Promise<string> {
  const header = { alg: options.alg ?? 'RS256', kid: options.kid ?? KID, typ: 'JWT' }
  const headerB64 = base64urlString(JSON.stringify(header))
  const payloadB64 = base64urlString(JSON.stringify(claims))
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      options.privateKey ?? key.privateKey,
      signingInput,
    ),
  )
  return `${headerB64}.${payloadB64}.${base64urlBytes(sigBytes)}`
}

function makeFetchStub(jwks: { keys: JsonWebKey[] }): typeof fetch {
  return vi.fn(async (input: unknown) => {
    expect(String(input)).toBe(`https://${TEAM}/cdn-cgi/access/certs`)
    return new Response(JSON.stringify(jwks), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

beforeAll(async () => {
  key = await generateKeyMaterial()
}, 30_000)

describe('verifyAccessJwt', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function makeEnv(extra: Record<string, unknown> = {}) {
    return {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      CATALOG_KV: makeKV(),
      ...extra,
    }
  }

  it('returns null when ACCESS_TEAM_DOMAIN or ACCESS_AUD is missing', async () => {
    const result = await verifyAccessJwt('whatever', { ACCESS_AUD: AUD })
    expect(result).toBeNull()
    const result2 = await verifyAccessJwt('whatever', { ACCESS_TEAM_DOMAIN: TEAM })
    expect(result2).toBeNull()
  })

  it('returns an identity for a valid user JWT and caches the JWKS', async () => {
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      iss: `https://${TEAM}`,
      aud: AUD,
      sub: 'user-123',
      email: 'alice@example.com',
      iat: now,
      exp: now + 600,
    })

    const id = await verifyAccessJwt(token, env, { fetchImpl: fetchStub })
    expect(id).toEqual({ email: 'alice@example.com', sub: 'user-123', type: 'user' })
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(env.CATALOG_KV._store.size).toBe(1)

    // Second call hits KV; fetch must not be called again.
    const id2 = await verifyAccessJwt(token, env, { fetchImpl: fetchStub })
    expect(id2).not.toBeNull()
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('classifies type=app tokens as service identities and synthesises an email', async () => {
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      iss: `https://${TEAM}`,
      aud: [AUD, 'unrelated-aud'],
      sub: 'service-token-abc',
      type: 'app',
      iat: now,
      exp: now + 600,
    })

    const id = await verifyAccessJwt(token, env, { fetchImpl: fetchStub })
    expect(id).toEqual({
      email: 'service-token-abc@service.local',
      sub: 'service-token-abc',
      type: 'service',
    })
  })

  it('falls back to common_name when a service-token JWT carries an empty sub (1d/Q)', async () => {
    // Real Cloudflare service-token JWTs (observed in production
    // against the publisher API) emit `sub: ""` and put the token's
    // identifier in `common_name` (the Client ID like
    // `843feb...d30ef0f.access`). The original middleware required
    // a non-empty sub and rejected every real service-token call.
    // The fallback here uses common_name as the durable identifier
    // when sub is empty.
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      iss: `https://${TEAM}`,
      aud: AUD,
      sub: '',
      type: 'app',
      common_name: '843feb721faf3071b4b43e890d30ef0f.access',
      iat: now,
      exp: now + 600,
    })

    const id = await verifyAccessJwt(token, env, { fetchImpl: fetchStub })
    expect(id).toEqual({
      email: '843feb721faf3071b4b43e890d30ef0f.access@service.local',
      sub: '843feb721faf3071b4b43e890d30ef0f.access',
      type: 'service',
    })
  })

  it('still rejects user-type JWTs with empty sub (no common_name fallback)', async () => {
    // The fallback only kicks in for service tokens. A user-login
    // JWT with an empty sub is malformed and should be rejected
    // even if it carries some other identifier.
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      iss: `https://${TEAM}`,
      aud: AUD,
      sub: '',
      email: 'alice@example.com',
      common_name: 'should-not-be-used',
      iat: now,
      exp: now + 600,
    })

    const id = await verifyAccessJwt(token, env, { fetchImpl: fetchStub })
    expect(id).toBeNull()
  })

  it('rejects an expired JWT', async () => {
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      iss: `https://${TEAM}`,
      aud: AUD,
      sub: 'user-123',
      email: 'alice@example.com',
      iat: now - 7200,
      exp: now - 60,
    })
    const id = await verifyAccessJwt(token, env, { fetchImpl: fetchStub, now })
    expect(id).toBeNull()
  })

  it('rejects a JWT with the wrong audience', async () => {
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      iss: `https://${TEAM}`,
      aud: 'some-other-aud',
      sub: 'user-123',
      email: 'alice@example.com',
      exp: now + 600,
    })
    expect(await verifyAccessJwt(token, env, { fetchImpl: fetchStub })).toBeNull()
  })

  it('rejects a JWT with the wrong issuer', async () => {
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      iss: `https://attacker.example`,
      aud: AUD,
      sub: 'user-123',
      email: 'alice@example.com',
      exp: now + 600,
    })
    expect(await verifyAccessJwt(token, env, { fetchImpl: fetchStub })).toBeNull()
  })

  it('rejects a JWT signed by a different key', async () => {
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    const stranger = await generateKeyMaterial()
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      {
        iss: `https://${TEAM}`,
        aud: AUD,
        sub: 'user-123',
        email: 'alice@example.com',
        exp: now + 600,
      },
      { privateKey: stranger.privateKey },
    )
    expect(await verifyAccessJwt(token, env, { fetchImpl: fetchStub })).toBeNull()
  })

  it('rejects a JWT whose kid is not in the JWKS', async () => {
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(
      {
        iss: `https://${TEAM}`,
        aud: AUD,
        sub: 'user-123',
        email: 'alice@example.com',
        exp: now + 600,
      },
      { kid: 'nonexistent-kid' },
    )
    expect(await verifyAccessJwt(token, env, { fetchImpl: fetchStub })).toBeNull()
  })

  it('rejects a non-RS256 algorithm header', async () => {
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    const now = Math.floor(Date.now() / 1000)
    // Forge a token whose header claims HS256 even though we're
    // signing with RSA — `verifyAccessJwt` should refuse before it
    // even imports a key.
    const headerB64 = base64urlString(JSON.stringify({ alg: 'HS256', kid: KID, typ: 'JWT' }))
    const payloadB64 = base64urlString(
      JSON.stringify({
        iss: `https://${TEAM}`,
        aud: AUD,
        sub: 'user-123',
        email: 'alice@example.com',
        exp: now + 600,
      }),
    )
    const token = `${headerB64}.${payloadB64}.AAAA`
    expect(await verifyAccessJwt(token, env, { fetchImpl: fetchStub })).toBeNull()
  })

  it('returns null on a malformed token', async () => {
    const env = makeEnv()
    const fetchStub = makeFetchStub({ keys: [key.publicJwk] })
    expect(await verifyAccessJwt('not-a-jwt', env, { fetchImpl: fetchStub })).toBeNull()
    expect(await verifyAccessJwt('a.b', env, { fetchImpl: fetchStub })).toBeNull()
    expect(
      await verifyAccessJwt('!!!.@@@.###', env, { fetchImpl: fetchStub }),
    ).toBeNull()
  })

  it('returns null when the JWKS endpoint errors', async () => {
    const env = makeEnv()
    const fetchStub = vi.fn(async () => new Response('boom', { status: 500 }))
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      iss: `https://${TEAM}`,
      aud: AUD,
      sub: 'user-123',
      email: 'alice@example.com',
      exp: now + 600,
    })
    expect(await verifyAccessJwt(token, env, { fetchImpl: fetchStub })).toBeNull()
  })
})
