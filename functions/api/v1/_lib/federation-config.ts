// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Whether this node federates, decided in one place so the feed route
 * and `/.well-known/terraviz.json` cannot disagree about it (metadata
 * Phase 5, step 3).
 *
 * Two settings, both required:
 *
 *   - `FEDERATION_ENABLED` exactly `'true'`, the operator's switch.
 *   - `FEDERATION_ABUSE_CONTACT`, an email address. The federation
 *     protocol makes `abuse_contact` required — "deployments without
 *     one do not federate" (`CATALOG_FEDERATION_PROTOCOL.md`,
 *     `CATALOG_BACKEND_PLAN.md` §Abuse, moderation, and takedowns) —
 *     so a switched-on node with no usable address serves no feed
 *     rather than one nobody can report.
 *
 * The address is checked, not repaired: it is published verbatim in
 * the discovery document, so anything that is not plainly one mailbox
 * (a display name, a list, a `mailto:` URL, whitespace) reads as
 * unset. The switch/contact check is pure; `loadSigningKey` caches a
 * WebCrypto key-pair check keyed by both the secret and public key.
 */

import { importNodePublicKey, importNodeSigningKey, signingKeyMatches } from './federation-signature'

let keyCache: { secret: string; publicKey: string; key: CryptoKey | null } | null = null

export function resetFeedSigningKeyCache(): void {
  keyCache = null
}

export async function loadSigningKey(secret: string | undefined, publicKey: string): Promise<CryptoKey | null> {
  if (!secret) return null
  if (keyCache && keyCache.secret === secret && keyCache.publicKey === publicKey) return keyCache.key
  let key: CryptoKey | null = null
  // Logged once per key pair per isolate, since the result is cached:
  // without a line here, a node whose feed and discovery go dark because
  // the key does not pair says nothing about why.
  try {
    const privateKey = await importNodeSigningKey(secret)
    const advertisedKey = await importNodePublicKey(publicKey)
    key = await signingKeyMatches(privateKey, advertisedKey) ? privateKey : null
    if (!key) console.error('[federation] NODE_ID_PRIVATE_KEY_PEM is not the pair of node_identity.public_key')
  } catch (err) {
    console.error('[federation] signing key unavailable:', err instanceof Error ? err.message : 'unknown error')
    key = null
  }
  keyCache = { secret, publicKey, key }
  return key
}

/** RFC 5321's limit on a forward path, the most a mailbox can be. */
const MAX_EMAIL_LENGTH = 254

// One mailbox: a local part with no whitespace, control characters,
// quotes, brackets, separators or `@`, then a host of at least two
// dot-separated LDH labels. Deliberately narrower than RFC 5322; quoted
// local parts and address literals are refused, since a peer has to be
// able to mail it.
// eslint-disable-next-line no-control-regex
const EMAIL = /^[^\s\x00-\x1f\x7f@<>()[\]",;:\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/** The configured abuse address, or `null` when unset or not one mailbox. */
export function parseAbuseContact(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) return null
  return EMAIL.test(value) ? value : null
}

export interface FederationSettings {
  FEDERATION_ENABLED?: string
  FEDERATION_ABUSE_CONTACT?: string
}

export type FederationState =
  | { state: 'off' }
  | { state: 'no_abuse_contact' }
  | { state: 'live'; abuseContact: string }

/**
 * Whether the feed should serve. `off` is the default for any value of
 * the switch but `'true'`; `no_abuse_contact` is a switched-on node
 * missing the address it must publish first.
 */
export function federationState(env: FederationSettings): FederationState {
  if (env.FEDERATION_ENABLED !== 'true') return { state: 'off' }
  const abuseContact = parseAbuseContact(env.FEDERATION_ABUSE_CONTACT)
  return abuseContact ? { state: 'live', abuseContact } : { state: 'no_abuse_contact' }
}
