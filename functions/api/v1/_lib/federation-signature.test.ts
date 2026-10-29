// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
// @vitest-environment node

/**
 * Federation signature primitives. Keys are real Ed25519 pairs — one
 * from RFC 8032's first test vector (so the PKCS8 import path is pinned
 * to a published answer), one made the way `scripts/gen-node-key.ts`
 * makes the node key (so a provisioned node's secret and advertised key
 * work here) — and every tamper case flips one input and expects the
 * named failure.
 */

import { generateKeyPairSync } from 'node:crypto'
import { ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import {
  CanonicalJsonError,
  canonicalJson,
  importNodePublicKey,
  importNodeSigningKey,
  parseSignatureHeader,
  signFederationBody,
  signingKeyMatches,
  verifyFederationBody,
  type SignatureParams,
} from './federation-signature'

// RFC 8032 §7.1, TEST 1.
const RFC_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const RFC_PUBLIC_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
const RFC_EMPTY_SIG_HEX =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
/** The fixed DER prefix of an Ed25519 PKCS8 private key, before the
 *  32-byte seed. */
const PKCS8_PREFIX_HEX = '302e020100300506032b657004220420'

const hex = (s: string) => Buffer.from(s, 'hex')
const RFC_PRIVATE_B64 = Buffer.concat([hex(PKCS8_PREFIX_HEX), hex(RFC_SEED_HEX)]).toString('base64')
const RFC_PUBLIC_WIRE = `ed25519:${hex(RFC_PUBLIC_HEX).toString('base64')}`

const KEY_ID = '01J0000000000000000000NODE'
const TARGET = '/api/v1/federation/feed?since=abc'
const NOW = 1_790_000_000
const PARAMS: SignatureParams = { keyId: KEY_ID, created: NOW, target: TARGET }

function genNodeKeyPair(): { privateB64: string; publicWire: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  return {
    privateB64: pkcs8.toString('base64'),
    publicWire: `ed25519:${spki.subarray(spki.length - 32).toString('base64')}`,
  }
}

async function rfcKeys() {
  return {
    priv: await importNodeSigningKey(RFC_PRIVATE_B64),
    pub: await importNodePublicKey(RFC_PUBLIC_WIRE),
  }
}

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code unit at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    )
    // U+20AC sorts after U+00E9, and a supplementary-plane key (a
    // surrogate pair, 0xD83D...) sorts before U+FB33 by code unit even
    // though its code point is higher — the case code-point sorting
    // gets wrong.
    expect(canonicalJson({ '\u20ac': 1, '\u00e9': 2, '\ufb33': 3, '\ud83d\ude00': 4 })).toBe(
      '{"\u00e9":2,"\u20ac":1,"\ud83d\ude00":4,"\ufb33":3}',
    )
  })

  it('serializes numbers the ECMAScript way', () => {
    expect(canonicalJson([1e21, 1e-7, -0, 0.1, 100, 1.5e300, 333333333.3333333])).toBe(
      '[1e+21,1e-7,0,0.1,100,1.5e+300,333333333.3333333]',
    )
  })

  it('escapes only what JSON must', () => {
    expect(canonicalJson('\u0000\u001f"\\/\u00e9\n')).toBe('"\\u0000\\u001f\\"\\\\/\u00e9\\n"')
  })

  it('drops undefined members, as JSON.stringify does', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
  })

  it.each([
    ['NaN', NaN],
    ['Infinity', [Infinity]],
    ['an undefined array element', [1, undefined]],
    ['a lone high surrogate', 'a\ud800'],
    ['a lone low surrogate', '\udc00b'],
    ['a lone surrogate in a key', { '\ud800': 1 }],
    ['a Date', { t: new Date(0) }],
    ['a Map', new Map()],
    ['a bigint', BigInt(1)],
    ['a function', () => 1],
  ])('refuses %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError)
  })

  it('refuses a value nested past the depth limit', () => {
    let deep: unknown = 1
    for (let i = 0; i < 100; i++) deep = [deep]
    expect(() => canonicalJson(deep)).toThrow(CanonicalJsonError)
  })
})

describe('keys', () => {
  it('matches the published UTF-8 feed vector from an independent Node crypto signer', async () => {
    const text = '{"cursor":"opaque","datasets":[{"colorScale":{"units":"kg m-3","vmax":2e-7,"vmin":0},"id":"sample","originNode":"NODE000","probingInfo":{"nested":[true,null,{"label":"Oc\u00e9an"}]},"title":"A\u00e9rosol"}],"generated_at":"2026-09-22T14:13:20.000Z","has_more":false,"node_id":"NODE000","schema_version":1}'
    const params = { keyId: 'NODE000', created: 1790086400, target: '/api/v1/federation/feed?limit=25' }
    const signed = await signFederationBody(JSON.parse(text), await importNodeSigningKey(RFC_PRIVATE_B64), params)
    expect(signed.text).toBe(text)
    expect(signed.header).toBe('v=1, keyid=NODE000, created=1790086400, sig=FcqWiT3nDEmUhyHN0p2w_kvsWa8uuX9Wtuw5rbC6P_WxSqkjV8hckjOv4YtV1SIQJ7bxNeyp9je96oWMlaDbAQ')
    expect(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('base64url')).toBe('qBJOVgfc8lKGhbuCyVFWyrYLjjwohaDJWbIT31jfOpM')
  })

  it('refuses every small-order Ed25519 public key', async () => {
    for (const point of ED25519_TORSION_SUBGROUP) {
      await expect(importNodePublicKey(`ed25519:${hex(point).toString('base64')}`)).rejects.toThrow()
    }
  })

  it('imports a PKCS8 seed to the RFC 8032 key', async () => {
    const { priv, pub } = await rfcKeys()
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', priv, new Uint8Array(0)))
    expect(Buffer.from(sig).toString('hex')).toBe(RFC_EMPTY_SIG_HEX)
    expect(await signingKeyMatches(priv, pub)).toBe(true)
  })

  it('accepts the key material gen-node-key writes', async () => {
    const { privateB64, publicWire } = genNodeKeyPair()
    const priv = await importNodeSigningKey(privateB64)
    const pub = await importNodePublicKey(publicWire)
    expect(await signingKeyMatches(priv, pub)).toBe(true)
  })

  it('tolerates PEM armour and line breaks', async () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\n' +
      RFC_PRIVATE_B64.replace(/(.{20})/g, '$1\n') +
      '\n-----END PRIVATE KEY-----\n'
    const priv = await importNodeSigningKey(pem)
    expect(await signingKeyMatches(priv, (await rfcKeys()).pub)).toBe(true)
  })

  it('reports a secret that is not the advertised key', async () => {
    const { priv } = await rfcKeys()
    const other = await importNodePublicKey(genNodeKeyPair().publicWire)
    expect(await signingKeyMatches(priv, other)).toBe(false)
  })

  it.each([
    ['no prefix', hex(RFC_PUBLIC_HEX).toString('base64')],
    ['another algorithm', `rsa:${hex(RFC_PUBLIC_HEX).toString('base64')}`],
    ['31 bytes', `ed25519:${hex(RFC_PUBLIC_HEX).subarray(1).toString('base64')}`],
    ['not base64', 'ed25519:!!!'],
  ])('refuses a public key with %s', async (_label, wire) => {
    await expect(importNodePublicKey(wire)).rejects.toThrow()
  })

  it('refuses an empty or non-base64 secret', async () => {
    await expect(importNodeSigningKey('')).rejects.toThrow()
    await expect(importNodeSigningKey('not base64 at all!')).rejects.toThrow()
  })
})

describe('sign and verify', () => {
  const body = { schema_version: 1, datasets: [{ id: 'A', title: 'Sea ice' }], tombstones: [] }

  it('produces canonical text and a header in the documented form', async () => {
    const { priv } = await rfcKeys()
    const signed = await signFederationBody(body, priv, PARAMS)
    expect(signed.text).toBe(canonicalJson(body))
    expect(signed.header).toMatch(
      /^v=1, keyid=01J0000000000000000000NODE, created=1790000000, sig=[A-Za-z0-9_-]{86}$/,
    )
  })

  it('matches the pinned known answer', async () => {
    // A second implementation reproduces this from the RFC 8032 key,
    // the body, the key id, the time and the target alone.
    const { priv } = await rfcKeys()
    const signed = await signFederationBody(body, priv, PARAMS)
    expect(signed.header).toBe(KNOWN_ANSWER_HEADER)
  })

  it('verifies its own signature and hands back the body', async () => {
    const { priv, pub } = await rfcKeys()
    const signed = await signFederationBody(body, priv, PARAMS)
    const result = await verifyFederationBody(signed.text, signed.header, {
      publicKey: pub,
      expectedKeyId: KEY_ID,
      expectedTarget: TARGET,
      now: NOW + 10,
    })
    expect(result).toEqual({ ok: true, body, created: NOW })
  })

  it('rejects reformatting of a signed page', async () => {
    const { priv, pub } = await rfcKeys()
    const signed = await signFederationBody(body, priv, PARAMS)
    const reformatted = JSON.stringify(JSON.parse(signed.text), null, 2)
    const result = await verifyFederationBody(reformatted, signed.header, {
      publicKey: pub,
      expectedKeyId: KEY_ID,
      expectedTarget: TARGET,
      now: NOW,
    })
    expect(result).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('refuses to sign a body with no canonical form or a bad parameter', async () => {
    const { priv } = await rfcKeys()
    await expect(signFederationBody({ n: NaN }, priv, PARAMS)).rejects.toThrow(CanonicalJsonError)
    await expect(
      signFederationBody(body, priv, { ...PARAMS, keyId: 'a\nb' }),
    ).rejects.toThrow()
    await expect(signFederationBody(body, priv, { ...PARAMS, target: 'no-slash' })).rejects.toThrow()
    await expect(signFederationBody(body, priv, { ...PARAMS, created: 1.5 })).rejects.toThrow()
  })

  describe('failures', () => {
    async function verifyWith(
      mutate: (s: { text: string; header: string | null }) => { text: string; header: string | null },
      opts: Partial<Parameters<typeof verifyFederationBody>[2]> = {},
    ) {
      const { priv, pub } = await rfcKeys()
      const signed = await signFederationBody(body, priv, PARAMS)
      const m = mutate({ ...signed })
      return verifyFederationBody(m.text, m.header, {
        publicKey: pub,
        expectedKeyId: KEY_ID,
        expectedTarget: TARGET,
        now: NOW,
        ...opts,
      })
    }

    it('a missing header', async () => {
      expect(await verifyWith(s => ({ ...s, header: null }))).toEqual({
        ok: false,
        reason: 'missing-header',
      })
    })

    it('an altered body', async () => {
      const r = await verifyWith(s => ({ ...s, text: s.text.replace('Sea ice', 'Sea ic3') }))
      expect(r).toEqual({ ok: false, reason: 'bad-signature' })
    })

    it('an injected tombstone', async () => {
      const r = await verifyWith(s => ({ ...s, text: s.text.replace('"tombstones":[]', '"tombstones":[{"id":"A"}]') }))
      expect(r).toEqual({ ok: false, reason: 'bad-signature' })
    })

    it('a body that is not JSON', async () => {
      expect(await verifyWith(s => ({ ...s, text: '{' }))).toEqual({
        ok: false,
        reason: 'bad-signature',
      })
    })

    it('duplicate keys injected before the original members', async () => {
      expect(await verifyWith(s => ({
        ...s,
        text: '{"datasets":[{"id":"EVIL"}],"tombstones":["X"],' + s.text.slice(1),
      }))).toEqual({ ok: false, reason: 'bad-signature' })
    })

    it('a page signed for another request', async () => {
      const r = await verifyWith(s => s, { expectedTarget: '/api/v1/federation/feed?since=xyz' })
      expect(r).toEqual({ ok: false, reason: 'bad-signature' })
    })

    it('another node', async () => {
      const r = await verifyWith(s => s, { expectedKeyId: '01J0000000000000000000OTHR' })
      expect(r).toEqual({ ok: false, reason: 'key-mismatch' })
    })

    it('the right key id under another key', async () => {
      const other = await importNodePublicKey(genNodeKeyPair().publicWire)
      const r = await verifyWith(s => s, { publicKey: other })
      expect(r).toEqual({ ok: false, reason: 'bad-signature' })
    })

    it('a signature older than the window', async () => {
      expect(await verifyWith(s => s, { now: NOW + 301 })).toEqual({ ok: false, reason: 'stale' })
      expect((await verifyWith(s => s, { now: NOW + 300 })).ok).toBe(true)
    })

    it('a signature from the future beyond the skew', async () => {
      expect(await verifyWith(s => s, { now: NOW - 61 })).toEqual({ ok: false, reason: 'future' })
      expect((await verifyWith(s => s, { now: NOW - 60 })).ok).toBe(true)
    })

    it('a time rewritten in the header', async () => {
      const r = await verifyWith(s => ({
        ...s,
        header: s.header!.replace(`created=${NOW}`, `created=${NOW + 5}`),
      }))
      expect(r).toEqual({ ok: false, reason: 'bad-signature' })
    })

    it('a flipped signature byte', async () => {
      const r = await verifyWith(s => ({
        ...s,
        header: s.header!.replace(/sig=(.)/, (_m, c: string) => `sig=${c === 'A' ? 'B' : 'A'}`),
      }))
      expect(r).toEqual({ ok: false, reason: 'bad-signature' })
    })
  })
})

describe('parseSignatureHeader', () => {
  const sig = 'A'.repeat(86)
  const good = `v=1, keyid=${KEY_ID}, created=${NOW}, sig=${sig}`

  it('reads a well-formed header in any parameter order', () => {
    expect(parseSignatureHeader(good)?.created).toBe(NOW)
    expect(parseSignatureHeader(`sig=${sig},created=${NOW},keyid=${KEY_ID},v=1`)?.keyId).toBe(KEY_ID)
  })

  it.each([
    ['an unknown version', good.replace('v=1', 'v=2')],
    ['a duplicate parameter', `${good}, v=1`],
    ['an unknown parameter', `${good}, alg=ed25519`],
    ['a missing parameter', `v=1, keyid=${KEY_ID}, sig=${sig}`],
    ['a quoted key id', good.replace(`keyid=${KEY_ID}`, `keyid="${KEY_ID}"`)],
    ['a fractional time', good.replace(`created=${NOW}`, `created=${NOW}.5`)],
    ['a negative time', good.replace(`created=${NOW}`, 'created=-1')],
    ['a leading-zero time', good.replace(`created=${NOW}`, `created=0${NOW}`)],
    ['a short signature', good.replace(sig, sig.slice(1))],
    ['standard base64 in the signature', good.replace(sig, `${sig.slice(1)}+`)],
    ['an empty header', ''],
    ['an oversized header', `${good}, ${'x'.repeat(2000)}`],
  ])('refuses %s', (_label, header) => {
    expect(parseSignatureHeader(header)).toBeNull()
  })
})

/** The RFC 8032 TEST 1 key signing the `sign and verify` body with
 *  `PARAMS`. Regenerate only with a protocol version change. */
const KNOWN_ANSWER_HEADER =
  'v=1, keyid=01J0000000000000000000NODE, created=1790000000, ' +
  'sig=ofDK3pp1dI8XX54WJWQlbYnniIpY1nL4RR07JjvV_4lTviVTpQXUuC7UODrE3J9dSoZv0RTBIcQ0zPIfMDmtCA'
