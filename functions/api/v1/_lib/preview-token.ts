/**
 * Short-lived signed preview tokens for unpublished datasets and
 * tours.
 *
 * Shape: `<payload-b64url>.<sig-b64url>` where `payload` is the
 * JSON `{ kind, id, publisher_id, exp }` and `sig` is HMAC-SHA-256
 * over `payload-b64url` keyed by the deployment's
 * `PREVIEW_SIGNING_KEY` env var (or a deterministic dev fallback
 * — see below). 15-minute default TTL; the issuer can pass a
 * shorter window for shareable links that expire on a single
 * playback.
 *
 * The dev fallback is `dev-preview-secret-only-for-localhost` —
 * stable so re-runs of the test suite don't break links the
 * contributor's already opened, but obviously useless for
 * production. The middleware expects ops to set the real value via
 * `npx wrangler pages secret put PREVIEW_SIGNING_KEY` on first
 * deploy. The secret is independent of the federation
 * `NODE_ID_PRIVATE_KEY_PEM` so a key compromise on one side does
 * not invalidate the other.
 */

const DEFAULT_TTL_SECONDS = 15 * 60
const DEV_FALLBACK_KEY = 'dev-preview-secret-only-for-localhost'

export interface PreviewClaims {
  /** `dataset` or `tour`. The consumer endpoints don't share state. */
  kind: 'dataset' | 'tour'
  /** Bound subject id (dataset or tour ULID). */
  id: string
  /** Issuing publisher's ULID for audit tracking on the consumer side. */
  publisher_id: string
  /** Unix seconds of expiration. */
  exp: number
}

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4)
  const b64 = (s + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export interface IssueOptions {
  ttlSeconds?: number
  /** Override clock for tests. Unix seconds. */
  now?: number
}

export async function issuePreviewToken(
  secret: string,
  claims: Omit<PreviewClaims, 'exp'>,
  options: IssueOptions = {},
): Promise<string> {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const payload: PreviewClaims = { ...claims, exp: now + ttl }
  const payloadB64 = bytesToB64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await importHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
  return `${payloadB64}.${bytesToB64Url(new Uint8Array(sig))}`
}

export interface VerifyOptions {
  now?: number
}

export async function verifyPreviewToken(
  secret: string,
  token: string,
  options: VerifyOptions = {},
): Promise<PreviewClaims | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, sigB64] = parts

  const key = await importHmacKey(secret)
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64)),
  )
  const got = b64UrlToBytes(sigB64)
  if (!timingSafeEqual(expected, got)) return null

  let claims: PreviewClaims
  try {
    claims = JSON.parse(new TextDecoder().decode(b64UrlToBytes(payloadB64)))
  } catch {
    return null
  }
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null
  if (claims.kind !== 'dataset' && claims.kind !== 'tour') return null
  if (typeof claims.id !== 'string' || typeof claims.publisher_id !== 'string') return null
  return claims
}

/**
 * Resolve the signing secret from env. Fails closed by default and
 * gates the deterministic dev fallback behind two independent
 * opt-ins.
 *
 * Why two: the anonymous preview consumer
 * (`/api/v1/datasets/{id}/preview/{token}`) lives *outside* the
 * publish middleware that refuses `DEV_BYPASS_ACCESS=true` on a
 * non-loopback hostname. So a misconfigured production deploy with
 * `DEV_BYPASS_ACCESS=true` left on but `PREVIEW_SIGNING_KEY` unset
 * could still verify forged tokens against the constant fallback
 * — hence requiring `ALLOW_DEV_PREVIEW_FALLBACK=true` as a second
 * explicit acknowledgment that the operator really intends the dev
 * secret. Both env vars must be set together; either alone fails
 * closed.
 */
export function resolveSigningSecret(env: {
  PREVIEW_SIGNING_KEY?: string
  DEV_BYPASS_ACCESS?: string
  ALLOW_DEV_PREVIEW_FALLBACK?: string
}): string {
  const explicit = env.PREVIEW_SIGNING_KEY?.trim()
  if (explicit) return explicit
  if (
    env.DEV_BYPASS_ACCESS === 'true' &&
    env.ALLOW_DEV_PREVIEW_FALLBACK === 'true'
  ) {
    return DEV_FALLBACK_KEY
  }
  throw new Error(
    'PREVIEW_SIGNING_KEY is not configured. Set it via ' +
      '`npx wrangler pages secret put PREVIEW_SIGNING_KEY` in production, ' +
      'or set both DEV_BYPASS_ACCESS=true and ' +
      'ALLOW_DEV_PREVIEW_FALLBACK=true to use the deterministic dev fallback.',
  )
}
