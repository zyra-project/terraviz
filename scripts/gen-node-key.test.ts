/**
 * Tests for the node-key generator helpers.
 *
 * The script's IO surface (writing `.dev.vars`, updating local D1)
 * runs only when the file is invoked as a CLI, so the tests cover
 * the pure helpers — keypair generation invariants and dotenv
 * upsert semantics — without needing to mock fs or sqlite.
 */

import { describe, expect, it } from 'vitest'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { generateNodeKey, upsertDevVar } from './gen-node-key'

describe('generateNodeKey', () => {
  it('produces a 32-byte raw public key wrapped as ed25519:<b64>', () => {
    const { publicB64, publicWire } = generateNodeKey()
    expect(publicWire.startsWith('ed25519:')).toBe(true)
    expect(publicWire.slice('ed25519:'.length)).toBe(publicB64)
    const raw = Buffer.from(publicB64, 'base64')
    expect(raw.length).toBe(32)
  })

  it('produces a private key that can sign + the public key verifies', () => {
    const { privateB64, publicB64 } = generateNodeKey()
    // Reconstruct the SPKI from the raw 32-byte public so we can
    // hand it to `crypto.createPublicKey` without re-deriving.
    const spkiPrefix = Buffer.from(
      '302a300506032b6570032100',
      'hex',
    )
    const spkiDer = Buffer.concat([spkiPrefix, Buffer.from(publicB64, 'base64')])
    const pubKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' })
    const privKey = createPrivateKey({
      key: Buffer.from(privateB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    const message = Buffer.from('terraviz federation handshake test')
    const sig = sign(null, message, privKey)
    expect(verify(null, message, pubKey, sig)).toBe(true)
  })
})

describe('upsertDevVar', () => {
  it('appends a key when missing', () => {
    const after = upsertDevVar('FOO=1\n', 'BAR', '2')
    expect(after).toBe('FOO=1\nBAR=2\n')
  })

  it('replaces an existing key without disturbing the surrounding lines', () => {
    const before = 'FOO=1\nNODE_ID_PRIVATE_KEY_PEM=stale\nBAR=2\n'
    const after = upsertDevVar(before, 'NODE_ID_PRIVATE_KEY_PEM', 'fresh')
    expect(after).toBe('FOO=1\nNODE_ID_PRIVATE_KEY_PEM=fresh\nBAR=2\n')
  })

  it('trims trailing blanks before appending so re-runs do not grow the file', () => {
    const before = 'FOO=1\n\n\n'
    const once = upsertDevVar(before, 'BAR', '2')
    expect(once).toBe('FOO=1\nBAR=2\n')
    const twice = upsertDevVar(once, 'BAR', '3')
    expect(twice).toBe('FOO=1\nBAR=3\n')
  })

  it('writes a single trailing newline on a previously empty file', () => {
    expect(upsertDevVar('', 'KEY', 'value')).toBe('KEY=value\n')
  })
})
