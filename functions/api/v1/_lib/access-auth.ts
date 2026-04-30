/**
 * Cloudflare Access JWT verification.
 *
 * Every request to `/api/v1/publish/**` carries either a browser
 * cookie (`Cf-Access-Jwt-Assertion` set by Cloudflare's edge after a
 * successful Access challenge) or a service-token assertion (the
 * same header, minted by the `cf-access-client-id` /
 * `cf-access-client-secret` exchange). Both produce a JWT signed by
 * the team's per-account JWKS.
 *
 * This module verifies the JWT locally — no per-request round-trip
 * to Cloudflare — by:
 *   1. Fetching the team's JWKS once and caching it in KV with a
 *      one-hour TTL. Key rotation is rare (Cloudflare advertises ~6
 *      months); a one-hour stale window during a rotation produces
 *      a brief 401 burst rather than a silent acceptance of an
 *      already-revoked key.
 *   2. Importing the matching JWK and calling
 *      `crypto.subtle.verify` with `RSASSA-PKCS1-v1_5` + SHA-256.
 *      Cloudflare Access uses RS256 exclusively for cookie + service
 *      token JWTs.
 *   3. Validating `aud` (must include the configured Application
 *      AUD), `iss` (must equal `https://<team>.cloudflareaccess.com`),
 *      and `exp` (must be in the future).
 *
 * Service tokens are distinguished from user logins by the `type`
 * claim Cloudflare emits — `"app"` for service tokens. Users always
 * carry an `email` claim; service tokens may not, so the verifier
 * synthesises `<sub>@service.local` for the publisher-store JIT row.
 *
 * The verifier returns a small `AccessIdentity` rather than raw
 * claims so callers don't have to re-validate the JWT shape; if it
 * returns a value, the assertion was valid.
 */

import { CatalogEnv } from './env'

export interface AccessIdentity {
  email: string
  sub: string
  /** `"service"` for service tokens; `"user"` for everything else. */
  type: 'user' | 'service'
}

interface JwkPublic {
  kid: string
  kty: string
  e: string
  n: string
  alg?: string
  use?: string
}

interface Jwks {
  keys: JwkPublic[]
}

interface VerifyOptions {
  fetchImpl?: typeof fetch
  /** Override clock for tests. Unix seconds. */
  now?: number
}

const JWKS_TTL_SECONDS = 3600
const JWKS_KV_PREFIX = 'access:jwks:'

function jwksKey(teamDomain: string): string {
  return `${JWKS_KV_PREFIX}${teamDomain}`
}

function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4)
  const b64 = (s + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

async function fetchJwks(
  env: CatalogEnv,
  fetchImpl: typeof fetch,
): Promise<Jwks | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN
  if (!teamDomain) return null
  const cacheKey = jwksKey(teamDomain)
  if (env.CATALOG_KV) {
    const cached = (await env.CATALOG_KV.get(cacheKey, 'json')) as Jwks | null
    if (cached) return cached
  }
  const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!res.ok) return null
  const jwks = (await res.json()) as Jwks
  if (env.CATALOG_KV) {
    // Best-effort: a KV write failure shouldn't fail the request.
    try {
      await env.CATALOG_KV.put(cacheKey, JSON.stringify(jwks), {
        expirationTtl: JWKS_TTL_SECONDS,
      })
    } catch {
      // swallow — operator alerts via Workers Logs.
    }
  }
  return jwks
}

async function verifySignature(
  headerB64: string,
  payloadB64: string,
  signatureB64: string,
  jwk: JwkPublic,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk as unknown as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const sig = base64urlDecode(signatureB64)
  // TS 5.7+ distinguishes ArrayBuffer from ArrayBufferLike; the
  // workers-types `crypto.subtle.verify` signature wants a strict
  // BufferSource. Casting the Uint8Array (whose internal buffer is
  // ArrayBufferLike) is safe — runtime accepts both.
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig as BufferSource, data as BufferSource)
}

interface JwtClaims {
  aud?: string | string[]
  iss?: string
  exp?: number
  iat?: number
  email?: string
  sub?: string
  type?: string
  // Service-token tokens carry common_name; users carry country, etc.
  common_name?: string
}

/**
 * Verify a Cloudflare Access JWT and return the identity it
 * authenticates, or `null` if the token is missing, expired, has a
 * bad signature, or fails the audience / issuer checks.
 *
 * Returning `null` rather than throwing keeps the middleware's
 * control flow tight — a single `if (!identity) return 401` instead
 * of try/catch for every failure mode.
 */
export async function verifyAccessJwt(
  token: string,
  env: CatalogEnv,
  options: VerifyOptions = {},
): Promise<AccessIdentity | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Math.floor(Date.now() / 1000)

  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, signatureB64] = parts

  let header: { kid?: string; alg?: string }
  let claims: JwtClaims
  try {
    header = JSON.parse(decodeUtf8(base64urlDecode(headerB64)))
    claims = JSON.parse(decodeUtf8(base64urlDecode(payloadB64)))
  } catch {
    return null
  }
  if (header.alg !== 'RS256') return null
  if (!header.kid) return null

  const jwks = await fetchJwks(env, fetchImpl)
  if (!jwks) return null
  const jwk = jwks.keys.find(k => k.kid === header.kid)
  if (!jwk) return null

  const ok = await verifySignature(headerB64, payloadB64, signatureB64, jwk)
  if (!ok) return null

  if (typeof claims.exp !== 'number' || claims.exp <= now) return null
  const expectedIss = `https://${env.ACCESS_TEAM_DOMAIN}`
  if (claims.iss !== expectedIss) return null
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
  if (!aud.includes(env.ACCESS_AUD)) return null

  const isService = claims.type === 'app'
  // Cloudflare service-token JWTs emit `sub` as an empty string and
  // carry the token's identifier in `common_name` (the Client ID
  // such as `843feb...d30ef0f.access`). User-login JWTs are the
  // opposite: `sub` is populated, `common_name` is absent. Pick
  // whichever durable identifier the JWT actually carries before
  // checking presence so a real service-token request doesn't get
  // rejected for an empty sub. Surfaced by the first production
  // service-token call against the publisher API in 1d.
  const subject =
    claims.sub && claims.sub.length > 0
      ? claims.sub
      : isService && typeof claims.common_name === 'string' && claims.common_name.length > 0
        ? claims.common_name
        : null
  if (!subject) return null

  // Service tokens may not carry an email; synthesize one keyed on
  // the resolved subject so the publishers row has a stable unique
  // identifier.
  const email = claims.email ?? (isService ? `${subject}@service.local` : null)
  if (!email) return null

  return { email, sub: subject, type: isService ? 'service' : 'user' }
}
