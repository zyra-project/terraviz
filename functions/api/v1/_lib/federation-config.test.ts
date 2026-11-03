// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { federationState, loadSigningKey, parseAbuseContact, resetFeedSigningKeyCache } from './federation-config'

describe('parseAbuseContact', () => {
  it.each([
    ['abuse@noaa.example', 'abuse@noaa.example'],
    ['  abuse@noaa.example\n', 'abuse@noaa.example'],
    ['first.last+tag@sub.node-1.example.org', 'first.last+tag@sub.node-1.example.org'],
  ])('accepts %j', (raw, expected) => {
    expect(parseAbuseContact(raw)).toBe(expected)
  })

  it.each([
    undefined,
    '',
    '   ',
    'abuse',
    'abuse@localhost',
    '@noaa.example',
    'abuse@',
    'abuse@@noaa.example',
    'a b@noaa.example',
    'mailto:abuse@noaa.example',
    'Abuse <abuse@noaa.example>',
    'abuse@noaa.example, ops@noaa.example',
    'abuse@noaa.example;x',
    '"abuse"@noaa.example',
    'abuse@[127.0.0.1]',
    'abuse@-noaa.example',
    'abuse@noaa-.example',
    'abuse@noaa..example',
    'abuse@noaa.example.',
    'abuse\u0000@noaa.example',
    `${'a'.repeat(250)}@x.io`,
  ])('refuses %j', raw => {
    expect(parseAbuseContact(raw)).toBeNull()
  })
})

describe('federationState', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', 'true '])('is off when FEDERATION_ENABLED is %j', flag => {
    expect(federationState({ FEDERATION_ENABLED: flag, FEDERATION_ABUSE_CONTACT: 'abuse@noaa.example' }))
      .toEqual({ state: 'off' })
  })

  it('needs an abuse contact to go live', () => {
    expect(federationState({ FEDERATION_ENABLED: 'true' })).toEqual({ state: 'no_abuse_contact' })
    expect(federationState({ FEDERATION_ENABLED: 'true', FEDERATION_ABUSE_CONTACT: 'nope' }))
      .toEqual({ state: 'no_abuse_contact' })
  })

  it('is live with the switch and a usable address', () => {
    expect(federationState({ FEDERATION_ENABLED: 'true', FEDERATION_ABUSE_CONTACT: ' abuse@noaa.example ' }))
      .toEqual({ state: 'live', abuseContact: 'abuse@noaa.example' })
  })
})

describe('loadSigningKey', () => {
  function pair() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
    return {
      secret: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
      wire: `ed25519:${spki.subarray(spki.length - 32).toString('base64')}`,
    }
  }
  afterEach(() => {
    resetFeedSigningKeyCache()
    vi.restoreAllMocks()
  })

  it('returns the key when the secret pairs with the advertised public key', async () => {
    const a = pair()
    expect(await loadSigningKey(a.secret, a.wire)).not.toBeNull()
  })

  // A key that does not pair turns the feed and discovery off. Without
  // a log line the operator sees a 503 and nothing that says why.
  it('says why when the secret does not pair, once per key pair', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = pair()
    const b = pair()
    expect(await loadSigningKey(a.secret, b.wire)).toBeNull()
    expect(await loadSigningKey(a.secret, b.wire)).toBeNull()
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toMatch(/not the pair/)
  })

  it('says why when the secret cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await loadSigningKey('not base64!', pair().wire)).toBeNull()
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toMatch(/signing key unavailable/)
  })
})
