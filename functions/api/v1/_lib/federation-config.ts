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
 * unset. Pure: no I/O.
 */

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
