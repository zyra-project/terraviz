// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Federation response signatures (metadata Phase 5, step 1).
 *
 * A federation response is signed by the node that produced it with
 * its Ed25519 node key — the private half in `NODE_ID_PRIVATE_KEY_PEM`
 * (base64 PKCS8 DER, written by `scripts/gen-node-key.ts`), the public
 * half advertised as `ed25519:<base64>` in `node_identity.public_key`
 * and `/.well-known/terraviz.json`. A subscriber pins that key at
 * subscription time and refuses anything it cannot verify — most
 * importantly a tombstone, which is the one feed row that deletes
 * something on the receiving side.
 *
 * Three choices carry the correctness, and each is a rule a second
 * implementation must follow byte for byte:
 *
 * - **The signed body is RFC 8785 canonical JSON** (`canonicalJson`).
 *   The producer sends exactly the canonical text; the verifier
 *   verifies the received bytes before parsing, then requires those
 *   bytes to equal the canonical form. Duplicate members and changed
 *   whitespace cannot inherit another body's signature. A value with no single canonical form
 *   (a non-finite number, a lone surrogate, `undefined` in an array, a
 *   `Date`) is refused rather than coerced, because a coercion one side
 *   applies and the other does not is a signature that never verifies.
 *
 * - **The signature covers a domain-separated statement**, not the
 *   body alone: a version tag, the signer's key id (its `node_id`), the
 *   signing time, the request target (path + query) the response
 *   answers, and the SHA-256 of the canonical body. The target is what
 *   stops a validly signed page for one cursor being replayed as the
 *   answer to another; the time is what lets a verifier refuse an old
 *   page; the tag means a signature made here can never be presented as
 *   one over some other Ed25519 statement this key makes later.
 *
 * - **The header is detached and unquoted**:
 *   `Terraviz-Signature: v=1, keyid=<node_id>, created=<unix-s>,
 *   sig=<base64url>`. Every value has a restricted alphabet, so there is
 *   no quoting or escaping to get wrong, and a duplicate or unknown
 *   parameter is a malformed header rather than something resolved by
 *   which one the parser saw last.
 *
 * Pure: WebCrypto only, no env, no D1, no fetch — so the same functions
 * run in Pages Functions, in the subscriber, and in the conformance
 * harness.
 */

import { ed25519 } from '@noble/curves/ed25519.js'

export const SIGNATURE_HEADER = 'Terraviz-Signature'
export const SIGNATURE_VERSION = '1'

/** Prefix of the signed statement. Changing it is a protocol version
 *  change; every existing signature stops verifying. */
const SIGNATURE_DOMAIN = 'terraviz-federation-signature-v1'

const WIRE_KEY_PREFIX = 'ed25519:'
const ED25519 = 'Ed25519'

/** A node id is a ULID today; the alphabet is wider so a future id
 *  scheme does not need a signature change, and narrow enough that no
 *  value can carry a separator into the signed statement. */
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
/** Path + query, printable ASCII without spaces. Non-ASCII in a URL is
 *  percent-encoded on the wire, so this refuses nothing a peer sends. */
const TARGET_RE = /^\/[\x21-\x7e]{0,2047}$/
const SIG_RE = /^[A-Za-z0-9_-]{86}$/ // 64 bytes, base64url, unpadded
const CREATED_RE = /^(0|[1-9][0-9]{0,11})$/

const MAX_DEPTH = 64

/** How old a signature may be before a verifier refuses it. A feed page
 *  is signed when served; five minutes covers an edge cache and a slow
 *  pull without making a captured page replayable for long. */
export const DEFAULT_MAX_AGE_SECONDS = 300
/** How far in the future `created` may sit, for clock skew between
 *  peers. */
export const DEFAULT_MAX_SKEW_SECONDS = 60

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalJsonError'
  }
}

/**
 * RFC 8785 (JCS) serialization. Object keys sort by UTF-16 code unit,
 * which is what `Array.prototype.sort` does with no comparator; numbers
 * and strings serialize as ECMAScript `JSON.stringify` does, which is
 * the form JCS specifies. Object members whose value is `undefined` are
 * dropped (as `JSON.stringify` drops them, so a parsed copy agrees);
 * everything without exactly one JSON form throws.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = []
  writeCanonical(value, out, 0)
  return out.join('')
}

function writeCanonical(v: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError('value nests too deeply')
  if (v === null) {
    out.push('null')
    return
  }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? 'true' : 'false')
      return
    case 'number':
      if (!Number.isFinite(v)) throw new CanonicalJsonError('non-finite number')
      out.push(JSON.stringify(v)) // -0 serializes as 0, as JCS requires
      return
    case 'string':
      writeString(v, out)
      return
    case 'object': {
      if (Array.isArray(v)) {
        out.push('[')
        for (let i = 0; i < v.length; i++) {
          if (i > 0) out.push(',')
          if (v[i] === undefined) throw new CanonicalJsonError('undefined array element')
          writeCanonical(v[i], out, depth + 1)
        }
        out.push(']')
        return
      }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError('not a plain object')
      }
      const obj = v as Record<string, unknown>
      const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
      out.push('{')
      keys.forEach((k, i) => {
        if (i > 0) out.push(',')
        writeString(k, out)
        out.push(':')
        writeCanonical(obj[k], out, depth + 1)
      })
      out.push('}')
      return
    }
    default:
      throw new CanonicalJsonError(`unsupported type: ${typeof v}`)
  }
}

function writeString(s: string, out: string[]): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalJsonError('lone surrogate')
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CanonicalJsonError('lone surrogate')
    }
  }
  out.push(JSON.stringify(s))
}

// --- encoding --------------------------------------------------------

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4)
  return b64ToBytes((s + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/'))
}

// --- keys ------------------------------------------------------------

/**
 * Import the node's signing key from `NODE_ID_PRIVATE_KEY_PEM`: base64
 * PKCS8 DER as `gen-node-key` writes it. PEM armour and whitespace are
 * tolerated, since the variable's name invites pasting a `.pem` file.
 * Non-extractable: nothing here needs the key back out.
 */
export async function importNodeSigningKey(secret: string): Promise<CryptoKey> {
  const b64 = secret.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '')
  if (b64.length === 0) throw new Error('empty node signing key')
  let der: Uint8Array
  try {
    der = b64ToBytes(b64)
  } catch {
    throw new Error('node signing key is not base64')
  }
  return crypto.subtle.importKey('pkcs8', der as BufferSource, { name: ED25519 }, false, ['sign'])
}

/** Import an `ed25519:<standard-base64>` public key (32 raw bytes), the
 *  format `node_identity.public_key` and the well-known doc carry. */
export function normalizeNodePublicKey(input: string): string {
  const wire = input.trim()
  if (!wire.startsWith(WIRE_KEY_PREFIX)) throw new Error('public key is not ed25519:<base64>')
  let raw: Uint8Array
  try {
    raw = b64ToBytes(wire.slice(WIRE_KEY_PREFIX.length))
  } catch {
    throw new Error('public key is not base64')
  }
  if (raw.length !== 32) throw new Error('public key is not 32 bytes')
  const point = ed25519.Point.fromBytes(raw, false)
  if (point.isSmallOrder()) throw new Error('public key has small order')
  return WIRE_KEY_PREFIX + bytesToB64(raw)
}

export async function importNodePublicKey(wire: string): Promise<CryptoKey> {
  const raw = b64ToBytes(normalizeNodePublicKey(wire).slice(WIRE_KEY_PREFIX.length))
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: ED25519 }, true, ['verify'])
}

/** Whether a signing key and a public key are one pair. A node whose
 *  secret and advertised key disagree signs everything unverifiably, so
 *  the feed checks this and refuses to serve rather than hand every
 *  peer a page it must reject. */
export async function signingKeyMatches(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<boolean> {
  const probe = new TextEncoder().encode(`${SIGNATURE_DOMAIN}\nkey-pair-check`)
  const sig = await crypto.subtle.sign(ED25519, privateKey, probe as BufferSource)
  return crypto.subtle.verify(ED25519, publicKey, sig as BufferSource, probe as BufferSource)
}

// --- the signed statement ---------------------------------------------

export interface SignatureParams {
  /** The signer's `node_id`. */
  keyId: string
  /** Signing time, whole Unix seconds. */
  created: number
  /** Path + query of the request this response answers. */
  target: string
}

async function signingInput(canonicalBody: string, p: SignatureParams): Promise<Uint8Array> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalBody) as BufferSource),
  )
  return new TextEncoder().encode(
    `${SIGNATURE_DOMAIN}\n` +
      `keyid=${p.keyId}\n` +
      `created=${p.created}\n` +
      `target=${p.target}\n` +
      `digest=sha-256:${bytesToB64Url(digest)}`,
  )
}

function checkParams(p: SignatureParams): void {
  if (!KEY_ID_RE.test(p.keyId)) throw new Error('invalid key id')
  if (!Number.isSafeInteger(p.created) || p.created < 0) throw new Error('invalid created time')
  if (!TARGET_RE.test(p.target)) throw new Error('invalid request target')
}

export interface SignedBody {
  /** The canonical JSON text; send exactly this as the response body. */
  text: string
  /** The `Terraviz-Signature` header value. */
  header: string
}

/** Sign a response body. Throws `CanonicalJsonError` for a body with no
 *  canonical form, so a bug in a route surfaces at the producer rather
 *  than as a signature every peer rejects. */
export async function signFederationBody(
  body: unknown,
  privateKey: CryptoKey,
  params: SignatureParams,
): Promise<SignedBody> {
  checkParams(params)
  const text = canonicalJson(body)
  const input = await signingInput(text, params)
  const sig = new Uint8Array(await crypto.subtle.sign(ED25519, privateKey, input as BufferSource))
  return {
    text,
    header:
      `v=${SIGNATURE_VERSION}, keyid=${params.keyId}, ` +
      `created=${params.created}, sig=${bytesToB64Url(sig)}`,
  }
}

export interface ParsedSignatureHeader {
  keyId: string
  created: number
  sig: Uint8Array
}

/** Strict parse: exactly `v`, `keyid`, `created` and `sig`, once each,
 *  each matching its alphabet. Anything else is `null`. */
export function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  if (header.length > 1024) return null
  const fields = new Map<string, string>()
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) return null
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (fields.has(k)) return null
    fields.set(k, v)
  }
  if (fields.size !== 4) return null
  const v = fields.get('v')
  const keyId = fields.get('keyid')
  const created = fields.get('created')
  const sig = fields.get('sig')
  if (v !== SIGNATURE_VERSION) return null
  if (keyId === undefined || !KEY_ID_RE.test(keyId)) return null
  if (created === undefined || !CREATED_RE.test(created)) return null
  if (sig === undefined || !SIG_RE.test(sig)) return null
  return { keyId, created: Number(created), sig: b64UrlToBytes(sig) }
}

export type SignatureFailure =
  | 'missing-header'
  | 'malformed-header'
  | 'key-mismatch'
  | 'stale'
  | 'future'
  | 'malformed-body'
  | 'bad-signature'

export interface VerifyOptions {
  /** The pinned public key of the peer being read. */
  publicKey: CryptoKey
  /** The peer's `node_id`, as pinned with the key. */
  expectedKeyId: string
  /** Path + query of the request that was sent. */
  expectedTarget: string
  /** Current time, Unix seconds. Defaults to the clock. */
  now?: number
  maxAgeSeconds?: number
  maxSkewSeconds?: number
}

export type VerifyResult =
  | { ok: true; body: unknown; created: number }
  | { ok: false; reason: SignatureFailure }

/**
 * Verify a signed response and return the parsed body only if it
 * verifies. The body returned is the value whose canonical form was
 * verified, so a caller that uses it is using exactly what was signed.
 *
 * The target is never read from the header; the verifier supplies the
 * one it asked for, so a page signed for another request fails as
 * `bad-signature`. Body size is the caller's to bound before this is
 * reached.
 */
export async function verifyFederationBody(
  text: string,
  header: string | null,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  if (header === null || header === '') return { ok: false, reason: 'missing-header' }
  const parsed = parseSignatureHeader(header)
  if (!parsed) return { ok: false, reason: 'malformed-header' }
  if (parsed.keyId !== opts.expectedKeyId) return { ok: false, reason: 'key-mismatch' }

  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  const maxSkew = opts.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS
  if (parsed.created > now + maxSkew) return { ok: false, reason: 'future' }
  if (parsed.created < now - maxAge) return { ok: false, reason: 'stale' }

  const params = { keyId: parsed.keyId, created: parsed.created, target: opts.expectedTarget }
  try {
    checkParams(params)
  } catch {
    return { ok: false, reason: 'bad-signature' }
  }
  const input = await signingInput(text, params)
  const valid = await crypto.subtle.verify(
    ED25519,
    opts.publicKey,
    parsed.sig as BufferSource,
    input as BufferSource,
  )
  if (!valid) return { ok: false, reason: 'bad-signature' }
  try {
    const body: unknown = JSON.parse(text)
    if (text !== canonicalJson(body)) return { ok: false, reason: 'malformed-body' }
    return { ok: true, body, created: parsed.created }
  } catch {
    return { ok: false, reason: 'malformed-body' }
  }
}
