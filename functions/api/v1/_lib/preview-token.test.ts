/**
 * Tests for the HMAC preview-token issuer/verifier.
 *
 * Coverage:
 *   - Round-trip with the same secret returns the original claims.
 *   - Wrong secret → null.
 *   - Tampered payload → null.
 *   - Expired token → null.
 *   - Mismatched kind / type checks.
 *   - Default vs explicit TTL.
 */

import { describe, expect, it } from 'vitest'
import {
  issuePreviewToken,
  resolveSigningSecret,
  verifyPreviewToken,
} from './preview-token'

const SECRET = 'super-secret-test-key'
const OTHER = 'different-secret'

describe('preview-token', () => {
  it('round-trips claims with the same secret', async () => {
    const token = await issuePreviewToken(SECRET, {
      kind: 'dataset',
      id: 'DS001',
      publisher_id: 'PUB001',
    })
    const claims = await verifyPreviewToken(SECRET, token)
    expect(claims?.kind).toBe('dataset')
    expect(claims?.id).toBe('DS001')
    expect(claims?.publisher_id).toBe('PUB001')
    expect(typeof claims?.exp).toBe('number')
  })

  it('returns null when verified with a different secret', async () => {
    const token = await issuePreviewToken(SECRET, {
      kind: 'dataset',
      id: 'DS001',
      publisher_id: 'PUB001',
    })
    expect(await verifyPreviewToken(OTHER, token)).toBeNull()
  })

  it('returns null when the payload is tampered with', async () => {
    const token = await issuePreviewToken(SECRET, {
      kind: 'dataset',
      id: 'DS001',
      publisher_id: 'PUB001',
    })
    const [, sig] = token.split('.')
    // Replace payload with one bound to a different id; signature
    // belongs to the original payload, so verify must reject.
    const fakePayload = btoa(JSON.stringify({ kind: 'dataset', id: 'DS999', publisher_id: 'PUB001', exp: 9999999999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const tampered = `${fakePayload}.${sig}`
    expect(await verifyPreviewToken(SECRET, tampered)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await issuePreviewToken(
      SECRET,
      { kind: 'dataset', id: 'DS001', publisher_id: 'PUB001' },
      { ttlSeconds: 60, now: now - 120 },
    )
    expect(await verifyPreviewToken(SECRET, token)).toBeNull()
  })

  it('honors explicit TTL', async () => {
    const now = 1_700_000_000
    const token = await issuePreviewToken(
      SECRET,
      { kind: 'tour', id: 'TR001', publisher_id: 'PUB001' },
      { ttlSeconds: 7, now },
    )
    const claims = await verifyPreviewToken(SECRET, token, { now })
    expect(claims?.exp).toBe(now + 7)
  })

  it('rejects a malformed token', async () => {
    expect(await verifyPreviewToken(SECRET, 'not-a-token')).toBeNull()
    expect(await verifyPreviewToken(SECRET, 'a.b.c')).toBeNull()
    expect(await verifyPreviewToken(SECRET, '')).toBeNull()
  })

  it('throws when PREVIEW_SIGNING_KEY is missing in production', () => {
    expect(() => resolveSigningSecret({})).toThrow(/PREVIEW_SIGNING_KEY/)
    expect(() => resolveSigningSecret({ PREVIEW_SIGNING_KEY: '   ' })).toThrow(
      /PREVIEW_SIGNING_KEY/,
    )
  })

  it('honors a real PREVIEW_SIGNING_KEY over the dev fallback', () => {
    expect(resolveSigningSecret({ PREVIEW_SIGNING_KEY: 'real' })).toBe('real')
    expect(
      resolveSigningSecret({ PREVIEW_SIGNING_KEY: 'real', DEV_BYPASS_ACCESS: 'true' }),
    ).toBe('real')
  })

  it('falls back to a stable dev secret only under both opt-in flags', () => {
    expect(
      resolveSigningSecret({
        DEV_BYPASS_ACCESS: 'true',
        ALLOW_DEV_PREVIEW_FALLBACK: 'true',
      }),
    ).toBe('dev-preview-secret-only-for-localhost')
  })

  it('refuses the dev fallback when only one of the two flags is set', () => {
    // Either flag alone fails closed — the doubled gate exists so a
    // production misconfig that forgets to remove DEV_BYPASS_ACCESS
    // can't silently accept forged tokens via the constant fallback.
    expect(() => resolveSigningSecret({ DEV_BYPASS_ACCESS: 'true' })).toThrow(
      /PREVIEW_SIGNING_KEY/,
    )
    expect(() =>
      resolveSigningSecret({ ALLOW_DEV_PREVIEW_FALLBACK: 'true' }),
    ).toThrow(/PREVIEW_SIGNING_KEY/)
  })
})
