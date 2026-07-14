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
 * `is_admin` is a synced legacy mirror of `role === 'admin'`):
 *
 *   - `admin`     — full administrator (mutates any row + the
 *                   operator-scoped resources, manages users).
 *   - `publisher` — the secondary authoring role; can read the whole
 *                   node catalog but may only mutate its own rows, and
 *                   cannot manage users or operator resources. (Reads
 *                   are open to every publisher; the owner scope lives
 *                   on the write path — see `dataset-mutations.ts`.)
 *   - `readonly`  — reviewer (unprivileged today; reviewer semantics
 *                   land later).
 *   - `service`   — machine credential / service token.
 *
 * Status / role assignment:
 *
 * | Origin                                              | role        | is_admin | status   |
 * |-----------------------------------------------------|-------------|----------|----------|
 * | DEV_BYPASS_ACCESS=true                              | `admin`     | 1        | `active` |
 * | Access service token                                | `service`   | 0        | `active` |
 * | Access user, email domain in TRUSTED_PUBLISHER_DOMAINS | `admin`  | 1        | `active` |
 * | Access user, untrusted domain                       | `publisher` | 0        | `pending`|
 *
 * Service tokens are pre-vouched by whoever configured them in the
 * Cloudflare dashboard, so auto-`active` is safe. Trusted-domain
 * users are vouched by the operator's choice to list their domain
 * — appropriate for single-org deploys where the operator IS the
 * admin. Untrusted-domain user logins default to `publisher` /
 * `pending` so a stranger discovering the publisher API cannot start
 * authoring rows until an admin approves them in the portal's Users
 * tab.
 *
 * The `role` column has no SQL CHECK constraint (see
 * `migrations/catalog/0005_publishers_audit.sql`) so the role enum is
 * additive at the runtime layer without a schema migration. The
 * `0023_publisher_roles_two_tier.sql` migration backfilled the old
 * `staff`/`community` rows to `admin`/`publisher`.
 */

import type { AccessIdentity } from './access-auth'
import { newUlid } from './ulid'

/**
 * Roles an admin may assign to a publisher through the Users tab.
 * `service` is intentionally excluded — it is reserved for machine
 * tokens and provisioned automatically, never hand-assigned.
 */
export const ASSIGNABLE_ROLES = ['admin', 'publisher', 'readonly'] as const
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

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
  // Trusted-domain users are auto-promoted to admin/active. This is
  // the supported path for single-org deploys where the operator IS
  // the admin — pending-by-default would lock them out of their own
  // deploy.
  if (opts.trustedDomains && opts.trustedDomains.size > 0) {
    const domain = emailDomain(identity.email)
    if (domain && opts.trustedDomains.has(domain)) {
      return { role: 'admin', is_admin: 1, status: 'active' }
    }
  }
  return { role: 'publisher', is_admin: 0, status: 'pending' }
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

  const { role, is_admin, status } = provisioningDefaults(identity, options)
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
 * Privileged callers see all rows and can mutate operator-scoped
 * resources (featured-list, peer config, hard delete). The role
 * table:
 *   - `admin` and `service` are privileged.
 *   - `publisher` and `readonly` are unprivileged.
 *
 * `role` is the canonical source of truth; the legacy `is_admin`
 * column is kept synced (`is_admin = 1` iff `role = 'admin'`) so it is
 * not consulted here. Read-side scoping in `dataset-mutations.ts`
 * consults this; the featured-datasets routes consult it for
 * write-side gating.
 */
export function isPrivileged(publisher: PublisherRow): boolean {
  return publisher.role === 'admin' || publisher.role === 'service'
}

/**
 * Admin gate for user management. Strictly `role === 'admin'` —
 * unlike `isPrivileged`, this excludes `service` tokens, so machine
 * credentials cannot approve/suspend/promote other publishers. The
 * Users tab and its endpoints (`/api/v1/publish/publishers`) gate on
 * this.
 */
export function isAdmin(publisher: PublisherRow): boolean {
  return publisher.role === 'admin'
}
