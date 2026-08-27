// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * D1 reader / writer for the `publishers` table.
 *
 * Phase 1a uses one entry point — `getOrCreatePublisher` — invoked
 * by the publisher-API middleware. The first time a verified Access
 * identity hits a publisher endpoint we insert a `publishers` row;
 * subsequent requests look it up by email and return the existing
 * row.
 *
 * Role taxonomy (canonical privilege source of truth is `role`;
 * `is_admin` is a synced legacy mirror of `role === 'admin'`). The
 * capabilities each role holds live in the shared matrix
 * `src/types/publisher-roles.ts`; this is the prose summary. See
 * `docs/PUBLISHER_ROLES_PLAN.md`.
 *
 *   - `admin`       — full administrator (any content + operator
 *                     resources + user management).
 *   - `editor`      — publish/edit ANY content + the hero; no user or
 *                     operator settings.
 *   - `author`      — create + publish/edit its OWN content.
 *   - `contributor` — create + edit its OWN drafts, but cannot
 *                     self-publish (an editor/admin approves).
 *   - `reviewer`    — read-only (catalog, queues, insights).
 *   - `service`     — machine credential; admin-equivalent for content
 *                     + operator work, but NOT user management.
 *
 * Status / role assignment:
 *
 * | Origin                                              | role       | is_admin | status   |
 * |-----------------------------------------------------|------------|----------|----------|
 * | DEV_BYPASS_ACCESS=true                              | `admin`    | 1        | `active` |
 * | Access service token                                | `service`  | 0        | `active` |
 * | First user on a deploy with no active admin (bootstrap) | `admin` | 1     | `active` |
 * | Access user, email domain in TRUSTED_PUBLISHER_DOMAINS | `reviewer`| 0     | `active` |
 * | Access user, untrusted domain                       | `reviewer` | 0        | `pending`|
 *
 * Service tokens are pre-vouched by whoever configured them in the
 * Cloudflare dashboard, so auto-`active` is safe. Trusted-domain users
 * are vouched by the operator's choice to list their domain, so they
 * skip the approval queue (`active`) — but start read-only (`reviewer`),
 * NOT admin: auto-admin for a whole domain predates the role model and
 * would silently make every colleague an admin. Untrusted-domain logins
 * default to `reviewer` + `pending` so a stranger discovering the
 * publisher API can author nothing until an admin approves (and
 * optionally promotes) them in the portal's Users tab.
 *
 * The one exception is the **bootstrap**: the first human on a deploy
 * with no active admin is provisioned `admin`/`active` (see
 * {@link getOrCreatePublisher}) so there is always an operator who can
 * approve/promote everyone else. It excludes service tokens (a machine
 * credential must never self-elevate) and, because the last-active-admin
 * guardrail on the Users tab keeps the admin count from ever reaching
 * zero through normal operations, cannot re-fire as an escalation path.
 *
 * The `role` column has no SQL CHECK constraint (see
 * `migrations/catalog/0005_publishers_audit.sql`) so the role enum is
 * additive at the runtime layer without a schema migration. The
 * `0023_publisher_roles_two_tier.sql` migration backfilled
 * `staff`/`community` → `admin`/`publisher`; `0039_publisher_roles_five.sql`
 * renamed `publisher`/`readonly` → `author`/`reviewer`.
 */

import type { AccessIdentity } from './access-auth'
import { newUlid } from './ulid'
import { roleCan, ASSIGNABLE_ROLES as ROLES_ASSIGNABLE, type Role } from '../../../../src/types/publisher-roles'

/**
 * Roles an admin may assign to a publisher through the Users tab.
 * Re-exported from the shared role matrix (`src/types/publisher-roles.ts`)
 * so there is one source of truth. `service` is intentionally excluded —
 * it is reserved for machine tokens and provisioned automatically,
 * never hand-assigned.
 */
export const ASSIGNABLE_ROLES = ROLES_ASSIGNABLE
export type AssignableRole = Role

/** Valid `status` values on the publishers table. */
export const PUBLISHER_STATUSES = ['pending', 'active', 'suspended'] as const
export type PublisherStatus = (typeof PUBLISHER_STATUSES)[number]

/**
 * Parse `TRUSTED_PUBLISHER_DOMAINS` (comma-separated) into a
 * lowercase Set. Empty / undefined → empty Set (no domains
 * trusted).
 */
export function parseTrustedDomains(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 0),
  )
}

/**
 * Extract the lowercase email domain (everything after the last
 * `@`). Returns `null` if the email is missing an `@` — defensive
 * since `AccessIdentity.email` is required, but a sentinel beats
 * a thrown error in the auth path.
 */
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return null
  return email.slice(at + 1).toLowerCase()
}

export interface PublisherRow {
  id: string
  email: string
  display_name: string
  affiliation: string | null
  org_id: string | null
  role: string
  is_admin: number
  status: string
  created_at: string
}

export interface ProvisionOptions {
  /**
   * `true` when the request bypassed Access via `DEV_BYPASS_ACCESS=true`.
   * The middleware passes this through so the JIT row reflects the
   * dev-bypass privilege rather than the regular pending-community
   * default.
   */
  devBypass?: boolean
  /**
   * Lowercase email-domain set parsed from
   * `TRUSTED_PUBLISHER_DOMAINS` by the middleware. A user-login
   * identity whose email domain matches is auto-promoted to
   * staff/admin/active on JIT provisioning. Empty Set / omitted
   * means no auto-promotion — the default for multi-org deploys.
   */
  trustedDomains?: Set<string>
}

export function provisioningDefaults(
  identity: AccessIdentity,
  opts: ProvisionOptions,
): { role: string; is_admin: number; status: string } {
  if (opts.devBypass) return { role: 'admin', is_admin: 1, status: 'active' }
  if (identity.type === 'service') return { role: 'service', is_admin: 0, status: 'active' }
  // Trusted-domain users skip the approval queue (`active`) but start
  // read-only (`reviewer`), not admin — the operator promotes them from
  // the Users tab as needed. (The first-ever human is bootstrapped to
  // admin separately in getOrCreatePublisher, so a fresh deploy still
  // gets an operator.)
  if (opts.trustedDomains && opts.trustedDomains.size > 0) {
    const domain = emailDomain(identity.email)
    if (domain && opts.trustedDomains.has(domain)) {
      return { role: 'reviewer', is_admin: 0, status: 'active' }
    }
  }
  // Untrusted-domain logins default to read-only `reviewer` + `pending`,
  // so a stranger who discovers the publisher API can do nothing until
  // an admin approves them and (if desired) promotes them to an
  // authoring role (decision D4 in docs/PUBLISHER_ROLES_PLAN.md).
  return { role: 'reviewer', is_admin: 0, status: 'pending' }
}

/**
 * Look up a publisher by email; insert a fresh row if missing using
 * the role/status defaults above. Returns the row regardless of
 * whether it was newly minted — the middleware uses it to decide
 * whether to short-circuit on `status='suspended'`.
 */
export async function getOrCreatePublisher(
  db: D1Database,
  identity: AccessIdentity,
  options: ProvisionOptions = {},
): Promise<PublisherRow> {
  const existing = await db
    .prepare('SELECT * FROM publishers WHERE email = ? LIMIT 1')
    .bind(identity.email)
    .first<PublisherRow>()
  if (existing) return existing

  let { role, is_admin, status } = provisioningDefaults(identity, options)

  // First-run bootstrap: if the deploy has no active admin yet, the
  // first human to sign in becomes one, so there is always an operator
  // who can approve/promote everyone else. Service tokens are excluded
  // (a machine credential must never self-elevate). Gated on "no active
  // admin" rather than "empty table" so a service-token-first deploy
  // still bootstraps its first human; the last-active-admin guardrail on
  // the Users tab keeps this count from dropping back to zero through
  // normal operations, so this cannot re-fire as an escalation path.
  if (identity.type === 'user' && is_admin === 0) {
    const admins = await db
      .prepare(`SELECT COUNT(*) AS n FROM publishers WHERE role = 'admin' AND status = 'active'`)
      .first<{ n: number }>()
    if ((admins?.n ?? 0) === 0) {
      role = 'admin'
      is_admin = 1
      status = 'active'
    }
  }

  const row: PublisherRow = {
    id: newUlid(),
    email: identity.email,
    // Best-effort display name; the publisher portal will let users
    // override later. Splitting on the local part of the email gives
    // a sane default for both `alice@example.com` and service tokens.
    display_name: identity.email.split('@')[0] || identity.email,
    affiliation: null,
    org_id: null,
    role,
    is_admin,
    status,
    created_at: new Date().toISOString(),
  }
  // Race-safe insert: two concurrent first-hits for the same email
  // both pass the SELECT above, then one INSERT trips the UNIQUE
  // constraint on `publishers.email`. `ON CONFLICT(email) DO NOTHING`
  // turns the loser into a no-op rather than a 500; we then re-read
  // to pick up whichever row won.
  await db
    .prepare(
      `INSERT INTO publishers
         (id, email, display_name, affiliation, org_id, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO NOTHING`,
    )
    .bind(
      row.id,
      row.email,
      row.display_name,
      row.affiliation,
      row.org_id,
      row.role,
      row.is_admin,
      row.status,
      row.created_at,
    )
    .run()
  const persisted = await db
    .prepare('SELECT * FROM publishers WHERE email = ? LIMIT 1')
    .bind(identity.email)
    .first<PublisherRow>()
  return persisted ?? row
}

/**
 * Privileged callers can mutate operator-scoped resources (feeds, node
 * profile / identity, media config, featured list, hero, workflows,
 * analytics backfill). Now a thin alias over the capability matrix:
 * `operator.manage` is held by exactly `admin` + `service`, so this is
 * behavior-identical to the old `role ∈ {admin, service}` check while
 * the individual call sites are migrated to their specific capability
 * (`hero.manage`, `content.publish.any`, …) in later phases.
 *
 * `role` is the canonical source of truth; the legacy `is_admin`
 * column is kept synced (`is_admin = 1` iff `role = 'admin'`) so it is
 * not consulted here.
 *
 * Design: `docs/PUBLISHER_ROLES_PLAN.md`.
 */
export function isPrivileged(publisher: PublisherRow): boolean {
  return roleCan(publisher.role, 'operator.manage')
}

/**
 * Admin gate for user management. `users.manage` is held by `admin`
 * only (not `service`), so this preserves the old strict
 * `role === 'admin'` semantics: machine credentials cannot
 * approve/suspend/promote other publishers. The Users tab and its
 * endpoints (`/api/v1/publish/publishers`) gate on this.
 */
export function isAdmin(publisher: PublisherRow): boolean {
  return roleCan(publisher.role, 'users.manage')
}
