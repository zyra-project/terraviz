/**
 * D1 reader / writer for the `publishers` table.
 *
 * Phase 1a uses one entry point — `getOrCreatePublisher` — invoked
 * by the publisher-API middleware. The first time a verified Access
 * identity hits a publisher endpoint we insert a `publishers` row;
 * subsequent requests look it up by email and return the existing
 * row.
 *
 * Status / role assignment:
 *
 * | Origin                  | role        | is_admin | status   |
 * |-------------------------|-------------|----------|----------|
 * | DEV_BYPASS_ACCESS=true  | `staff`     | 1        | `active` |
 * | Access service token    | `service`   | 0        | `active` |
 * | Access user (cookie)    | `community` | 0        | `pending`|
 *
 * Service tokens are pre-vouched by whoever configured them in the
 * Cloudflare dashboard, so auto-`active` is safe. User logins
 * default to `pending` so a stranger discovering the publisher API
 * cannot start authoring rows; the publisher portal (Phase 3) ships
 * the approval UI. Until then, the only practical path for local
 * development is `DEV_BYPASS_ACCESS=true`, which mints a staff +
 * admin row keyed off `DEV_PUBLISHER_EMAIL`.
 *
 * The `role` column has no SQL CHECK constraint (see
 * `migrations/catalog/0005_publishers_audit.sql`) so adding
 * `service` does not require a migration. The publishing tools doc
 * documents the role enum; the runtime permits the additive value.
 */

import type { AccessIdentity } from './access-auth'
import { newUlid } from './ulid'

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
}

function provisioningDefaults(
  identity: AccessIdentity,
  opts: ProvisionOptions,
): { role: string; is_admin: number; status: string } {
  if (opts.devBypass) return { role: 'staff', is_admin: 1, status: 'active' }
  if (identity.type === 'service') return { role: 'service', is_admin: 0, status: 'active' }
  return { role: 'community', is_admin: 0, status: 'pending' }
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
  await db
    .prepare(
      `INSERT INTO publishers
         (id, email, display_name, affiliation, org_id, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  return row
}

